import { createHash } from "node:crypto";
import {
  KULO_VERSION,
  type ExternalAgentModelInfo,
  type ExternalAgentQuotaProbeResult,
  type ExternalAgentServiceTierInfo,
} from "@kulo/protocol";
import { parseCodexRateLimitsSnapshot, sanitizeQuotaError } from "./external-agent-quota.js";
import { ExternalAgentRpc, type ExternalAgentPipeFactory, type RpcValue } from "./external-agent-rpc.js";
import {
  approvedAgentEnv,
  createExternalPipeFactory,
  externalRuntimePaths,
  type ExternalDriver,
  type ExternalDriverContext,
} from "./external-agent-drivers.js";
import { prependKuloInstructions, resolveSafeExternalImages } from "./external-agent-validation.js";

const CODEX_MCP_STARTUP_GRACE_MS = 10_000;
const CODEX_MAX_INLINE_IMAGES = 4;
const CODEX_MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
const CODEX_MAX_IMAGE_TOTAL_BYTES = 40 * 1024 * 1024;

function obj(v: unknown): RpcValue {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as RpcValue) : {};
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function requestsWritePermissions(permissions: unknown): boolean {
  const root = obj(permissions);
  const fsPerm = obj(root.fileSystem ?? root.filesystem ?? root.fs);
  if (Array.isArray(fsPerm.write) && fsPerm.write.length > 0) return true;
  if (Array.isArray(root.writableRoots) && root.writableRoots.length > 0) return true;
  if (root.write === true || fsPerm.write === true) return true;
  // Treat any unspecified filesystem/sandbox escalation keys conservatively in read-only mode.
  return Object.keys(fsPerm).some((key) => /write|modify|delete|create/i.test(key));
}

function buildCodexThreadConfig(
  servers: ExternalDriverContext["servers"],
  includeStartupGrace: boolean,
): Record<string, unknown> | undefined {
  if (!servers.length) return undefined;
  const config: Record<string, unknown> = {};
  for (const server of servers) {
    // Codex splits config keys on '.'; keep a stable, dot-free server name so user MCPs survive
    // and cross-epoch thread/resume preserves tool prefixes and prompt cache.
    const safeName = server.name.replace(/[^A-Za-z0-9_-]/g, "_") || "kulo-task";
    config[`mcp_servers.${safeName}`] = {
      enabled: true,
      url: server.url,
      http_headers: Object.fromEntries((server.headers ?? []).map((item) => [item.name, item.value])),
    };
  }
  if (includeStartupGrace) {
    config.mcp_optional_startup_grace_ms = CODEX_MCP_STARTUP_GRACE_MS;
  }
  return config;
}

function isCodexConfigCompatibilityError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    code === -32600 ||
    code === -32602 ||
    /failed to load configuration|mcp_optional_startup_grace_ms|invalid params/i.test(msg)
  );
}

export async function connectCodex(
  ctx: ExternalDriverContext,
  probe = false,
): Promise<{ driver: ExternalDriver; models: ExternalAgentModelInfo[]; authenticated: boolean | null }> {
  const isResumingSession = Boolean(ctx.sessionId);
  const effectiveReadOnly = Boolean(ctx.readOnly || ctx.workspaceMode === "read_only");
  let sessionId = ctx.sessionId;
  let turnId: string | undefined;
  let submitted = false;
  let closed = false;
  let sawMessageDelta = false;
  let cancelRequested = false;
  let pendingInterrupt = false;
  let permissionCancelled = false;
  let sawToolOrOutput = false;

  const flushPendingInterrupt = () => {
    if (pendingInterrupt && sessionId && turnId && !closed) {
      pendingInterrupt = false;
      void rpc.call("turn/interrupt", { threadId: sessionId, turnId }).catch(() => {});
    }
  };

  const rpc = new ExternalAgentRpc({
    request: async (method, params, id) => {
      if (params.threadId && params.threadId !== sessionId) throw new Error("Stale Codex thread");
      if (method === "item/fileChange/requestApproval" && effectiveReadOnly) {
        ctx.event("state", "Denied file change approval in read-only mode");
        return { decision: "decline" };
      }
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        const decisions = Array.isArray(params.availableDecisions)
          ? params.availableDecisions
          : ["accept", "acceptForSession", "decline", "cancel"];
        const choices = decisions.map((decision, index) => ({
          id: String(index),
          label: typeof decision === "string" ? decision : JSON.stringify(decision),
        }));
        const choice = await ctx.permission(
          `codex:${createHash("sha256").update(String(id)).digest("hex")}`,
          text(params.reason) || text(params.command) || "Codex tool approval",
          choices,
        );
        const selected = choices.findIndex((value) => value.id === choice);
        if (selected < 0) {
          permissionCancelled = true;
          throw new Error("Codex approval input was cancelled");
        }
        const picked = decisions[selected];
        if (picked === "decline" || picked === "cancel") permissionCancelled = true;
        return { decision: picked };
      }
      if (method === "item/permissions/requestApproval") {
        if (effectiveReadOnly && requestsWritePermissions(params.permissions)) {
          ctx.event("state", "Denied write permission escalation in read-only mode");
          return { permissions: {}, scope: "turn" };
        }
        const choice = await ctx.permission(
          `codex:${createHash("sha256").update(String(id)).digest("hex")}`,
          text(params.reason) || JSON.stringify(params.permissions),
          [
            { id: "turn", label: "Allow for this turn" },
            { id: "session", label: "Allow for this session" },
            { id: "deny", label: "Reject" },
          ],
        );
        if (choice !== "turn" && choice !== "session") permissionCancelled = true;
        return { permissions: choice === "turn" || choice === "session" ? params.permissions : {}, scope: choice === "session" ? "session" : "turn" };
      }
      if (method === "item/tool/requestUserInput") {
        const questions = (Array.isArray(params.questions) ? params.questions : []).map(obj);
        const answers: Record<string, { answers: string[] }> = {};
        for (const [qIndex, q] of questions.entries()) {
          const qId = text(q.id) || `q${qIndex}`;
          const qTitle = [text(q.header), text(q.question)].filter(Boolean).join(": ") || "Codex requested input";
          const rawOptions = (Array.isArray(q.options) ? q.options : [])
            .map(obj)
            .filter((opt) => typeof opt.label === "string" && opt.label.length > 0);
          const choices = rawOptions.length
            ? rawOptions.map((opt, idx) => ({
                id: String(idx),
                label: text(opt.description) ? `${text(opt.label)} — ${text(opt.description)}` : text(opt.label),
              }))
            : [
                { id: "continue", label: "Proceed with best judgment" },
                { id: "decline", label: "Cancel" },
              ];
          const choice = await ctx.permission(
            `codex:${createHash("sha256").update(`${String(id)}:${qId}`).digest("hex")}`,
            qTitle,
            choices,
          );
          if (rawOptions.length) {
            const idx = Number(choice);
            const selected = Number.isInteger(idx) && idx >= 0 && idx < rawOptions.length ? rawOptions[idx] : undefined;
            if (!selected) permissionCancelled = true;
            answers[qId] = { answers: selected ? [text(selected.label)] : [] };
          } else {
            if (choice !== "continue") permissionCancelled = true;
            answers[qId] = { answers: choice === "continue" ? ["Proceed with best judgment"] : [] };
          }
        }
        return { answers };
      }
      throw new Error("Unsupported Codex request");
    },
    notification: (method, params) => {
      if (params.threadId && params.threadId !== sessionId) return;
      if (method === "item/agentMessage/delta") {
        sawMessageDelta = true;
        const delta = text(params.delta);
        if (delta) sawToolOrOutput = true;
        ctx.event("message", delta);
      }
      if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta" || method === "item/reasoning/summaryPartAdded") {
        ctx.activity?.("Reasoning...");
      }
      if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta" || method === "item/plan/delta" || method === "turn/plan/updated" || method === "turn/diff/updated") {
        ctx.activity?.("Executing...");
      }
      if (method === "item/started" || method === "item/completed") {
        const item = obj(params.item);
        if (item.type === "agentMessage") {
          if (method === "item/completed" && !sawMessageDelta) {
            const fallback =
              text(item.text) ||
              (Array.isArray(item.content)
                ? item.content
                    .map((part) => {
                      const p = obj(part);
                      return p.type === "text" || p.type === "output_text" ? text(p.text) : "";
                    })
                    .join("")
                : "");
            if (fallback) {
              sawToolOrOutput = true;
              ctx.event("message", fallback);
            }
          }
        } else {
          sawToolOrOutput = true;
          ctx.event("tool", text(item.type) || "Tool update");
        }
      }
      if (method === "turn/started") {
        sawMessageDelta = false;
        turnId = text(obj(params.turn).id) || turnId;
        flushPendingInterrupt();
      }
      if (method === "turn/completed") {
        const turn = obj(params.turn);
        const status = text(turn.status);
        const errMsg = text(obj(turn.error).message) || undefined;
        if (status === "completed") ctx.complete("completed", errMsg);
        else if (status === "interrupted") {
          if (cancelRequested || permissionCancelled) ctx.complete("cancelled", errMsg);
          else if (sawToolOrOutput) ctx.complete("uncertain", errMsg || "Codex turn was interrupted mid-execution without a cancel request");
          else ctx.complete("failed", errMsg || "Codex turn was interrupted without a cancel request");
        } else ctx.complete("failed", errMsg);
        driver.close();
      }
      if (method === "account/rateLimits/updated") {
        const parsed = parseCodexRateLimitsSnapshot(params, { source: "passive_run" });
        if (parsed) ctx.quota?.(parsed);
      }
      if (method === "error" && params.willRetry !== true) {
        ctx.event("error", text(obj(params.error).message) || "Codex reported an error");
      }
    },
    failed: (error) => {
      if (!closed && submitted) ctx.complete("uncertain", error.message);
    },
  });

  const pipe = await ctx.pipe({
    executable: ctx.executable,
    args: ["app-server"],
    cwd: ctx.cwd,
    env: {},
    isolated: false,
    readOnly: effectiveReadOnly,
    runtimePaths: externalRuntimePaths(ctx.executable),
    onStdout: (data) => rpc.accept(data),
    onStderr: (data) => ctx.event("error", Buffer.from(data).toString("utf8")),
  });
  rpc.attach(pipe);

  const driver: ExternalDriver = {
    cancel: async () => {
      cancelRequested = true;
      if (!sessionId || !turnId) {
        pendingInterrupt = true;
        return;
      }
      await rpc.call("turn/interrupt", { threadId: sessionId, turnId });
    },
    close: () => {
      closed = true;
      rpc.close();
    },
    cleanup: () => pipe.cleanup?.() ?? pipe.exited.then(() => true, () => false),
  };

  try {
    await rpc.call("initialize", { clientInfo: { name: "kulo", version: KULO_VERSION }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized", {});
    const [modelResult, account] = probe
      ? await Promise.all([rpc.call("model/list", {}), rpc.call("account/read", { refreshToken: false }).catch(() => ({}))])
      : [ctx.modelId || ctx.thinkingLevel || ctx.serviceTier ? await rpc.call("model/list", {}) : {}, {}];
    const catalog = (Array.isArray(modelResult.data) ? modelResult.data : []).map(obj);
    const parseCodexServiceTiers = (value: RpcValue): ExternalAgentServiceTierInfo[] => {
      const seen = new Set<string>();
      const tiers: ExternalAgentServiceTierInfo[] = [];
      const pushTier = (id: string, name?: string, description?: string) => {
        const clean = id.trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        tiers.push({ id: clean, ...(name?.trim() ? { name: name.trim() } : {}), ...(description?.trim() ? { description: description.trim() } : {}) });
      };
      if (Array.isArray(value.serviceTiers)) {
        for (const item of value.serviceTiers) {
          const row = obj(item);
          if (typeof row.id === "string") pushTier(row.id, text(row.name), text(row.description));
        }
      }
      if (Array.isArray(value.additionalSpeedTiers)) {
        for (const item of value.additionalSpeedTiers) {
          if (typeof item === "string") pushTier(item);
        }
      }
      return tiers;
    };
    const models: ExternalAgentModelInfo[] = catalog
      .filter((value) => typeof value.id === "string")
      .map((value) => {
        const efforts = (Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts : [])
          .map((item) => text(obj(item).reasoningEffort))
          .filter(Boolean);
        const serviceTiers = parseCodexServiceTiers(value);
        const defaultServiceTier = text(value.defaultServiceTier).trim() || undefined;
        return {
          id: text(value.model) || text(value.id),
          name: text(value.displayName) || text(value.id),
          ...(efforts.length ? { efforts: [...new Set(efforts)] } : {}),
          ...(serviceTiers.length ? { serviceTiers } : {}),
          ...(defaultServiceTier ? { defaultServiceTier } : {}),
          ...(value.isDefault === true ? { isDefault: true } : {}),
        };
      });
    const authenticated = probe ? Boolean(approvedAgentEnv("codex").OPENAI_API_KEY || obj(account).account) : null;
    if (ctx.modelId && models.length && !models.some((model) => model.id === ctx.modelId)) {
      throw new Error("Selected model is not advertised by Codex");
    }
    if (!probe) {
      const preSelected =
        catalog.find((value) => (value.model ?? value.id) === ctx.modelId) ??
        (!ctx.modelId ? catalog.find((value) => value.isDefault) : undefined);
      if (ctx.serviceTier && preSelected) {
        const advertisedTiers = parseCodexServiceTiers(preSelected);
        if (advertisedTiers.length > 0 && ctx.serviceTier !== "default" && !advertisedTiers.some((tier) => tier.id === ctx.serviceTier)) {
          throw new Error("Selected service tier is not advertised by Codex for this model");
        }
      }
      const startOrResume = (includeStartupGrace: boolean) => {
        const config = buildCodexThreadConfig(ctx.servers, includeStartupGrace);
        return rpc.call(sessionId ? "thread/resume" : "thread/start", {
          ...(sessionId ? { threadId: sessionId } : {}),
          cwd: ctx.cwd,
          ...(ctx.modelId ? { model: ctx.modelId } : {}),
          ...(ctx.serviceTier ? { serviceTier: ctx.serviceTier } : {}),
          ...(config ? { config } : {}),
        });
      };
      let thread: RpcValue;
      try {
        thread = await startOrResume(true);
      } catch (error) {
        if (ctx.servers.length > 0 && isCodexConfigCompatibilityError(error)) {
          thread = await startOrResume(false);
        } else {
          throw error;
        }
      }
      const selected =
        catalog.find((value) => (value.model ?? value.id) === (ctx.modelId ?? thread.model)) ??
        (!ctx.modelId ? catalog.find((value) => value.isDefault) : undefined);
      if (ctx.thinkingLevel) {
        if (
          !selected ||
          !(Array.isArray(selected.supportedReasoningEfforts) ? selected.supportedReasoningEfforts : []).some(
            (value) => obj(value).reasoningEffort === ctx.thinkingLevel,
          )
        ) {
          throw new Error("Selected thinking level is not advertised by Codex for this model");
        }
      }
      if (ctx.serviceTier && selected) {
        const advertisedTiers = parseCodexServiceTiers(selected);
        if (advertisedTiers.length > 0 && ctx.serviceTier !== "default" && !advertisedTiers.some((tier) => tier.id === ctx.serviceTier)) {
          throw new Error("Selected service tier is not advertised by Codex for this model");
        }
      }
      sessionId = text(obj(thread.thread).id);
      if (!sessionId) throw new Error("Codex did not return a native thread ID");
      ctx.session(sessionId);

      const promptText = isResumingSession ? ctx.prompt : prependKuloInstructions(ctx.developerInstructions, ctx.prompt);
      const inlineImages = resolveSafeExternalImages({
        attachments: ctx.attachments,
        expectedInputsDir: ctx.inputsDir,
        overlapsProtected: ctx.overlapsProtected,
        maxCount: CODEX_MAX_INLINE_IMAGES,
        maxFileBytes: CODEX_MAX_IMAGE_FILE_BYTES,
        maxTotalBytes: CODEX_MAX_IMAGE_TOTAL_BYTES,
        readBytes: false,
        onSkip: (reason) => ctx.event("state", reason),
      });
      const input: RpcValue[] = [
        { type: "text", text: promptText, text_elements: [] },
        ...inlineImages.map((img) => ({ type: "localImage", path: img.path })),
      ];

      submitted = true;
      ctx.submitted();
      const turn = await rpc.call("turn/start", {
        threadId: sessionId,
        cwd: ctx.cwd,
        input,
        ...(ctx.modelId ? { model: ctx.modelId } : {}),
        ...(ctx.thinkingLevel ? { effort: ctx.thinkingLevel } : {}),
        ...(ctx.serviceTier ? { serviceTier: ctx.serviceTier } : {}),
        ...(effectiveReadOnly ? { sandboxPolicy: { type: "readOnly" } } : {}),
      });
      turnId = text(obj(turn.turn).id) || turnId;
      flushPendingInterrupt();
    }
    return { driver, models, authenticated };
  } catch (error) {
    driver.close();
    throw error;
  }
}

export async function probeCodexQuota(options: {
  executable: string;
  cwd: string;
  controlRoot: string;
  pipeFactory?: ExternalAgentPipeFactory;
  signal?: AbortSignal;
  timeoutMs?: number;
  redact?: (value: string) => string;
}): Promise<ExternalAgentQuotaProbeResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const startedAt = Date.now();
  const remainingMs = () => Math.max(500, timeoutMs - (Date.now() - startedAt));
  if (options.signal?.aborted) {
    return { kind: "codex", status: "unavailable", source: "live", fetchedAt: Date.now(), windows: [], error: "Quota check aborted" };
  }
  const rpc = new ExternalAgentRpc({
    request: async () => {
      throw new Error("Quota probe does not accept interactive requests");
    },
    notification: () => {},
    failed: () => {},
  });
  const factory = options.pipeFactory ?? createExternalPipeFactory({ controlRoot: options.controlRoot, kind: "codex" });
  const pipe = await factory({
    executable: options.executable,
    args: ["app-server", "-c", "mcp_servers={}"],
    cwd: options.cwd,
    env: {},
    isolated: false,
    readOnly: true,
    runtimePaths: externalRuntimePaths(options.executable),
    onStdout: (data) => rpc.accept(data),
    onStderr: () => {},
  });
  rpc.attach(pipe);
  const onAbort = () => {
    try {
      rpc.close();
      pipe.close();
    } catch {
      /* ignore */
    }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await rpc.call("initialize", { clientInfo: { name: "kulo", version: KULO_VERSION }, capabilities: { experimentalApi: true } }, remainingMs());
    rpc.notify("initialized", {});
    const accountResp = await rpc.call("account/read", { refreshToken: false }, remainingMs()).catch(() => ({} as RpcValue));
    const account = obj(accountResp.account);
    const accountType = text(account.type);
    if (!accountType) {
      return {
        kind: "codex",
        status: approvedAgentEnv("codex").OPENAI_API_KEY ? "api_key_billing" : "unauthenticated",
        source: "live",
        fetchedAt: Date.now(),
        windows: [],
      };
    }
    if (accountType !== "chatgpt") {
      return {
        kind: "codex",
        status: "api_key_billing",
        source: "live",
        fetchedAt: Date.now(),
        windows: [],
      };
    }
    let rateLimitsResp: RpcValue;
    try {
      rateLimitsResp = await rpc.call("account/rateLimits/read", { excludeResetCreditDetails: true }, remainingMs());
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const msg = error instanceof Error ? error.message : String(error);
      if (code === -32602 || /-32602|invalid params/i.test(msg)) {
        rateLimitsResp = await rpc.call("account/rateLimits/read", {}, remainingMs());
      } else {
        throw error;
      }
    }
    const parsed = parseCodexRateLimitsSnapshot(rateLimitsResp, {
      source: "live",
      fetchedAt: Date.now(),
      accountPlanType: account.planType,
    });
    if (!parsed) {
      return {
        kind: "codex",
        status: "unavailable",
        source: "live",
        fetchedAt: Date.now(),
        windows: [],
        error: "Codex returned no quota buckets",
      };
    }
    return parsed;
  } catch (error) {
    return {
      kind: "codex",
      status: "unavailable",
      source: "live",
      fetchedAt: Date.now(),
      windows: [],
      error: sanitizeQuotaError(error instanceof Error ? error.message : "Codex quota query failed", options.redact),
    };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try { rpc.close(); } catch { /* ignore */ }
    try { pipe.close(); } catch { /* ignore */ }
    await (pipe.cleanup?.() ?? pipe.exited.then(() => true, () => false)).catch(() => false);
  }
}
