import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { KULO_VERSION, type ExternalAgentKind, type ExternalAgentModelInfo, type ExternalAgentQuotaProbeResult } from "@kulo/protocol";
import { ExternalAgentRpc, type ExternalAgentPipeFactory, type RpcValue } from "./external-agent-rpc.js";
import { preserveWindowsCoreEnv, resolveCrossPlatformSpawn } from "./platform-process.js";
import {
  isGrokNotSignedInText,
  isGrokShellRouteUnavailableText,
  isGrokTeamManagedOutput,
  parseGrokBillingPayload,
  sanitizeQuotaError,
} from "./external-agent-quota.js";

export interface AcpFlavorSpec {
  readonly kind: ExternalAgentKind;
  readonly binary: string;
  readonly acpArgs: readonly string[];
  /** Controlled launch args used when `ctx.readOnly === true`. */
  readonly readOnlyArgs?: readonly string[];
  readonly probeArgs?: readonly string[];
  readonly versionArgs?: readonly string[];
  readonly macAppPaths?: (home: string) => readonly string[];
  readonly extraToolDirs?: (home: string) => readonly string[];
  readonly approvedEnvKeys?: readonly string[];
  /** Relative subdirectories under `$HOME` where this client may read its own public skills/rules via ACP `fs/read_text_file`. */
  readonly readableSkillSubdirs?: readonly string[];
  readonly initializeMeta?: Record<string, unknown>;
  readonly cancelMeta?: Record<string, unknown>;
  readonly initializeTimeoutMs?: number;
  readonly modelAdvertisementGraceMs?: number;
  /** Prefer models returned by `initialize` during probe and skip `session/new` when non-empty. */
  readonly probeInitializeOnly?: boolean;
  /** Prefer `session/set_model` (with `_meta.reasoningEffort`) over `session/set_config_option`. */
  readonly preferSetSessionModel?: boolean;
  /** Handle xAI `x.ai/session/prompt_complete` extension notifications as prompt finality fallback. */
  readonly xaiPromptCompletionFallback?: boolean;
  /** Treat `session/load` replay going idle as ready for agents whose `session/load` may not reply. */
  readonly sessionLoadReplayIdleReadiness?: boolean;
  /** Side-effect-free native auth probe (never launches browser login or workspace MCP servers). */
  readonly detectAuth?: (executable: string, pathEnv: string) => Promise<boolean | null>;
}

const CANONICAL_EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function sortEffortTokens(efforts: readonly string[]): string[] {
  const deduped: string[] = [];
  for (const raw of efforts) {
    const token = raw.trim();
    if (token && !deduped.includes(token)) deduped.push(token);
  }
  const rank = (token: string) => CANONICAL_EFFORT_RANK.indexOf(token.toLowerCase() as typeof CANONICAL_EFFORT_RANK[number]);
  if (deduped.length > 1 && deduped.every((token) => rank(token) >= 0)) {
    return [...deduped].sort((left, right) => rank(left) - rank(right));
  }
  return deduped;
}

function asRecord(value: unknown): RpcValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RpcValue) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Grok CLI `grok models` always exits with code 0; only output text reports login state.
 */
export function parseGrokModelsOutput(output: string): {
  authenticated: boolean | null;
  models: ExternalAgentModelInfo[];
} {
  const authenticated = /you are logged in/i.test(output)
    ? true
    : /not authenticated|not logged in/i.test(output)
      ? false
      : null;

  const seen = new Set<string>();
  const models: ExternalAgentModelInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[*-]\s+(\S+)(.*)$/);
    const id = match?.[1]?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = id
      .split(/[-_]/g)
      .map((part) => (part.toLowerCase() === "grok" ? "Grok" : part))
      .join(" ");
    models.push({
      id,
      name,
      ...(/\(default\)/i.test(match?.[2] ?? "") ? { isDefault: true } : {}),
    });
  }
  return { authenticated, models };
}

function runQuickProbeCommand(executable: string, args: readonly string[], pathEnv: string, timeoutMs = 10_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const spec = resolveCrossPlatformSpawn(executable, args);
    const env = preserveWindowsCoreEnv({ HOME: os.homedir(), PATH: pathEnv, ...(process.env.XAI_API_KEY ? { XAI_API_KEY: process.env.XAI_API_KEY } : {}) });
    const child = spawn(spec.command, spec.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    let output = "";
    let settled = false;
    const finish = (value: { code: number | null; output: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 64_000) {
        try { child.kill(); } catch { /* ignore */ }
        finish({ code: null, output });
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error("Probe command timed out"));
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish({ code, output }));
  });
}

export async function detectGrokAuthenticated(
  executable: string,
  pathEnv: string,
  runner: (executable: string, args: readonly string[], pathEnv: string, timeoutMs?: number) => Promise<{ code: number | null; output: string }> = runQuickProbeCommand,
): Promise<boolean | null> {
  if (process.env.XAI_API_KEY?.trim()) return true;
  try {
    const result = await runner(executable, ["models"], pathEnv, 10_000);
    if (result.code !== 0) return null;
    return parseGrokModelsOutput(result.output).authenticated;
  } catch {
    return null;
  }
}

export type GrokQuotaCliRunner = (
  executable: string,
  args: readonly string[],
  pathEnv: string,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

function runGrokQuotaCli(
  executable: string,
  args: readonly string[],
  pathEnv: string,
  timeoutMs = 2_500,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Quota check aborted"));
      return;
    }
    const env: NodeJS.ProcessEnv = preserveWindowsCoreEnv({
      HOME: os.homedir(),
      PATH: pathEnv,
    });
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const spec = resolveCrossPlatformSpawn(executable, args);
    const child = spawn(spec.command, spec.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: { code: number | null; stdout: string; stderr: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error("Quota check aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 64_000) {
        try { child.kill(); } catch { /* ignore */ }
        finish({ code: null, stdout, stderr });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64_000) {
        try { child.kill(); } catch { /* ignore */ }
        finish({ code: null, stdout, stderr });
      }
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error("Grok usage command timed out"));
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish({ code, stdout, stderr }));
  });
}

export async function probeGrokQuota(options: {
  executable: string;
  cwd: string;
  pathEnv: string;
  pipeFactory: ExternalAgentPipeFactory;
  runtimePaths: string[];
  runner?: GrokQuotaCliRunner;
  hasApiKey?: boolean;
  signal?: AbortSignal;
  cliTimeoutMs?: number;
  stdioTimeoutMs?: number;
  redact?: (value: string) => string;
}): Promise<ExternalAgentQuotaProbeResult> {
  const hasApiKey = options.hasApiKey ?? Boolean(process.env.XAI_API_KEY?.trim());
  const runner = options.runner ?? runGrokQuotaCli;
  if (options.signal?.aborted) {
    return { kind: "grok", status: "unavailable", source: "live", fetchedAt: Date.now(), windows: [], error: "Quota check aborted" };
  }

  let shouldFallbackToStdio = false;
  let stage1Error: string | undefined;
  try {
    const cli = await runner(options.executable, ["usage", "--json"], options.pathEnv, options.cliTimeoutMs ?? 2_500, options.signal);
    const combined = `${cli.stdout}\n${cli.stderr}`.trim();
    if (cli.code === 0) {
      if (isGrokTeamManagedOutput(combined)) {
        return { kind: "grok", status: "ok", source: "live", fetchedAt: Date.now(), planLabel: "Team", windows: [] };
      }
      const trimmedOut = cli.stdout.trim();
      if (trimmedOut) {
        try {
          const parsedJson = JSON.parse(trimmedOut) as unknown;
          const mapped = parseGrokBillingPayload(parsedJson, Date.now());
          if (mapped) return mapped;
        } catch {
          // Fall through to unavailable / stdio check
        }
      }
      stage1Error = "Grok usage output did not contain recognizable quota fields";
    } else if (isGrokNotSignedInText(combined)) {
      return {
        kind: "grok",
        status: hasApiKey ? "api_key_billing" : "unauthenticated",
        source: "live",
        fetchedAt: Date.now(),
        windows: [],
      };
    } else if (isGrokShellRouteUnavailableText(combined)) {
      shouldFallbackToStdio = true;
    } else {
      stage1Error = sanitizeQuotaError(combined || `Grok usage failed (${cli.code ?? "signal"})`, options.redact);
    }
  } catch (error) {
    if (options.signal?.aborted) {
      return { kind: "grok", status: "unavailable", source: "live", fetchedAt: Date.now(), windows: [], error: "Quota check aborted" };
    }
    stage1Error = sanitizeQuotaError(error instanceof Error ? error.message : "Grok usage check failed", options.redact);
  }

  if (!shouldFallbackToStdio) {
    return {
      kind: "grok",
      status: "unavailable",
      source: "live",
      fetchedAt: Date.now(),
      windows: [],
      error: stage1Error ?? "Grok quota is currently unavailable",
    };
  }

  // Stage 2: Stateless ACP stdio fallback via `_x.ai/billing` (no background daemon, no session/new, 0 tokens).
  const timeoutMs = options.stdioTimeoutMs ?? 5_500;
  const startedAt = Date.now();
  const remainingMs = () => Math.max(500, timeoutMs - (Date.now() - startedAt));
  const rpc = new ExternalAgentRpc({
    request: async () => { throw new Error("Quota probe does not accept interactive requests"); },
    notification: () => {},
    failed: () => {},
  });
  const pipe = await options.pipeFactory({
    executable: options.executable,
    args: ["agent", "stdio"],
    cwd: options.cwd,
    env: {},
    isolated: false,
    readOnly: true,
    runtimePaths: options.runtimePaths,
    onStdout: (data) => rpc.accept(data),
    onStderr: () => {},
  });
  rpc.attach(pipe);
  const onAbort = () => { try { rpc.close(); pipe.close(); } catch { /* ignore */ } };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await rpc.call(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "kulo", version: KULO_VERSION },
        _meta: { clientType: "extension" },
      },
      remainingMs(),
    );
    const billing = await rpc.call("_x.ai/billing", {}, remainingMs());
    const mapped = parseGrokBillingPayload(billing, Date.now());
    if (mapped) return mapped;
    return {
      kind: "grok",
      status: "unavailable",
      source: "live",
      fetchedAt: Date.now(),
      windows: [],
      error: "Grok billing response did not include quota metrics",
    };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const msg = error instanceof Error ? error.message : String(error);
    if (code === -32000 || /-32000/.test(msg) || isGrokNotSignedInText(msg)) {
      return {
        kind: "grok",
        status: hasApiKey ? "api_key_billing" : "unauthenticated",
        source: "live",
        fetchedAt: Date.now(),
        windows: [],
      };
    }
    return {
      kind: "grok",
      status: "unavailable",
      source: "live",
      fetchedAt: Date.now(),
      windows: [],
      error: sanitizeQuotaError(msg, options.redact),
    };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try { rpc.close(); } catch { /* ignore */ }
    try { pipe.close(); } catch { /* ignore */ }
    await (pipe.cleanup?.() ?? pipe.exited.then(() => true, () => false)).catch(() => false);
  }
}

export function extractModelsFromAcpModelState(modelState: RpcValue): {
  models: ExternalAgentModelInfo[];
  currentModelId?: string;
} {
  const rawCurrent = asString(modelState.currentModelId).trim();
  const currentModelId = rawCurrent ? rawCurrent.split("?")[0] || undefined : undefined;
  const listed: Array<{ id: string; name: string }> = [];
  const perModelEfforts = new Map<string, string[]>();
  const explicitUnsupportedIds = new Set<string>();

  if (Array.isArray(modelState.availableModels)) {
    for (const rawEntry of modelState.availableModels) {
      const entry = asRecord(rawEntry);
      const rawId = asString(entry.modelId).trim() || asString(entry.id).trim();
      if (!rawId) continue;
      const qIndex = rawId.indexOf("?");
      const baseId = qIndex >= 0 ? rawId.slice(0, qIndex) : rawId;
      if (!baseId) continue;
      if (!listed.some((item) => item.id === baseId)) {
        listed.push({ id: baseId, name: asString(entry.name).trim() || baseId });
      }
      const efforts = perModelEfforts.get(baseId) ?? [];
      if (!perModelEfforts.has(baseId)) perModelEfforts.set(baseId, efforts);

      const meta = asRecord(entry._meta);
      const explicitlyDisabled =
        entry.supportsReasoningEffort === false || meta.supportsReasoningEffort === false;
      if (explicitlyDisabled) {
        explicitUnsupportedIds.add(baseId);
        continue;
      }

      if (qIndex >= 0) {
        const query = new URLSearchParams(rawId.slice(qIndex + 1));
        const effortVal =
          query.get("thinkingLevel") ??
          query.get("thoughtLevel") ??
          query.get("effort") ??
          query.get("reasoningEffort");
        if (effortVal && !efforts.includes(effortVal)) efforts.push(effortVal);
      }

      const explicitEfforts = Array.isArray(entry.efforts)
        ? entry.efforts
        : Array.isArray(entry.supportedEfforts)
          ? entry.supportedEfforts
          : [];
      for (const item of explicitEfforts) {
        if (typeof item === "string" && item.trim() && !efforts.includes(item.trim())) {
          efforts.push(item.trim());
        }
      }

      if (Array.isArray(meta.reasoningEfforts)) {
        for (const rawLevel of meta.reasoningEfforts) {
          if (typeof rawLevel === "string") {
            const token = rawLevel.trim();
            if (token && !efforts.includes(token)) efforts.push(token);
            continue;
          }
          const level = asRecord(rawLevel);
          const token = asString(level.value).trim() || asString(level.id).trim();
          if (token && !efforts.includes(token)) efforts.push(token);
        }
      }
    }
  }

  const anyModelHasEfforts = [...perModelEfforts.entries()].some(
    ([modelId, list]) => !explicitUnsupportedIds.has(modelId) && list.length > 0,
  );

  const models: ExternalAgentModelInfo[] = listed.map((item) => {
    const isExplicitUnsupported = explicitUnsupportedIds.has(item.id);
    const rawEfforts = isExplicitUnsupported ? [] : (perModelEfforts.get(item.id) ?? []);
    const sorted = rawEfforts.length ? sortEffortTokens(rawEfforts) : [];
    const effortCapability =
      sorted.length > 0
        ? ("supported" as const)
        : isExplicitUnsupported || anyModelHasEfforts
          ? ("unsupported" as const)
          : ("unknown" as const);
    return {
      ...item,
      ...(sorted.length ? { efforts: sorted } : {}),
      effortCapability,
      ...(currentModelId && item.id === currentModelId ? { isDefault: true } : {}),
    };
  });
  return { models, currentModelId };
}

export function extractModelsFromAcpInitialize(init: RpcValue): {
  models: ExternalAgentModelInfo[];
  currentModelId?: string;
} {
  const meta = asRecord(init._meta);
  const modelState = asRecord(meta.modelState);
  if (!Array.isArray(modelState.availableModels)) return { models: [] };
  return extractModelsFromAcpModelState(modelState);
}

const SENSITIVE_CREDENTIAL_EXACT_FILENAMES = new Set([
  "config.toml",
  "hosts.yml",
  "hosts.yaml",
  "mcp.json",
  "settings.json",
  "credentials",
  "auth",
  "oauth",
  "token",
  "tokens",
  "secret",
  "secrets",
  "cookies",
  "binarycookies",
]);

const SENSITIVE_CREDENTIAL_FILENAME_PATTERN =
  /^(?:\.env(?:\.[^/]+)?|\.[^/]*credentials[^/]*|(?:auth|credentials?|oauth|tokens?|secrets?)(?:[._-][a-z0-9_-]+)?\.(?:json|ya?ml|toml|txt|ini|conf|enc|dat|bin|key|pem)|.*\.(?:env|pem|key|p12|pfx|sqlite3?|db|cookies)(?:-(?:wal|shm))?)$/i;

/**
 * Checks only the final filename (basename) so public skill paths such as
 * `~/.gemini/config/skills/oauth-setup/SKILL.md` or `skills/state-machine/SKILL.md`
 * are never falsely rejected while credential/config/database files are strictly blocked.
 */
export function isSensitiveCredentialFilename(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (!base) return true;
  if (SENSITIVE_CREDENTIAL_EXACT_FILENAMES.has(base)) return true;
  return SENSITIVE_CREDENTIAL_FILENAME_PATTERN.test(base);
}

export function isAcpAuthRequiredError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/\b(?:authentication required|auth_required|not signed in|not authenticated|not logged in|please sign in|login required)\b/i.test(message)) {
    return true;
  }
  return code === -32000 && (!message.trim() || /auth|sign.?in|log.?in|unauthoriz|credential|token/i.test(message));
}

export const ACP_FLAVORS: Partial<Record<ExternalAgentKind, AcpFlavorSpec>> = {
  antigravity: {
    kind: "antigravity",
    binary: "agy",
    acpArgs: ["acp", "--process-per-session"],
    approvedEnvKeys: ["GEMINI_API_KEY"],
    macAppPaths: (home) => [
      "/Applications/Gemini.app/Contents/Helpers/agy",
      "/Applications/Antigravity.app/Contents/Resources/app/bin/agy",
      "/Applications/Antigravity.app/Contents/Resources/bin/agy",
      "/Applications/Antigravity.app/Contents/Helpers/agy",
      path.join(home, "Applications", "Gemini.app", "Contents", "Helpers", "agy"),
      path.join(home, "Applications", "Antigravity.app", "Contents", "Resources", "app", "bin", "agy"),
      path.join(home, ".gemini", "antigravity", "bin", "agy"),
      path.join(home, ".gemini", "antigravity-cli", "bin", "agy"),
      path.join(home, "Library", "Application Support", "Antigravity", "bin", "agy"),
    ],
    extraToolDirs: (home) => [
      path.join(home, ".gemini", "antigravity", "bin"),
      path.join(home, ".gemini", "antigravity-cli", "bin"),
      path.join(home, "Library", "Application Support", "Antigravity", "bin"),
    ],
    readableSkillSubdirs: [
      ".gemini/antigravity/builtin/skills",
      ".gemini/antigravity-cli/builtin/skills",
      ".gemini/config/skills",
      ".gemini/skills",
      ".agents/skills",
    ],
  },
  grok: {
    kind: "grok",
    binary: "grok",
    acpArgs: ["agent", "stdio"],
    readOnlyArgs: ["--permission-mode", "default", "agent", "stdio"],
    probeArgs: ["agent", "stdio"],
    approvedEnvKeys: ["XAI_API_KEY"],
    extraToolDirs: (home) => [path.join(home, ".grok", "bin")],
    readableSkillSubdirs: [".grok/skills", ".grok/rules"],
    initializeMeta: { clientType: "extension" },
    cancelMeta: { cancelTrigger: "ctrl_c" },
    initializeTimeoutMs: 25_000,
    probeInitializeOnly: true,
    preferSetSessionModel: true,
    xaiPromptCompletionFallback: true,
    sessionLoadReplayIdleReadiness: true,
    detectAuth: detectGrokAuthenticated,
  },
  cursor: {
    kind: "cursor",
    binary: "cursor-agent",
    acpArgs: ["acp"],
    extraToolDirs: (home) => [path.join(home, ".cursor", "bin")],
    readableSkillSubdirs: [".cursor/rules", ".cursor/skills"],
  },
  opencode: {
    kind: "opencode",
    binary: "opencode",
    acpArgs: ["acp"],
    extraToolDirs: (home) => [path.join(home, ".opencode", "bin")],
    modelAdvertisementGraceMs: 2_500,
    readableSkillSubdirs: [".opencode/skills", ".config/opencode/skills"],
  },
  "gemini-cli": {
    kind: "gemini-cli",
    binary: "gemini",
    acpArgs: ["--acp"],
    approvedEnvKeys: ["GEMINI_API_KEY"],
    readableSkillSubdirs: [".gemini/skills"],
  },
  kiro: {
    kind: "kiro",
    binary: "kiro-cli",
    acpArgs: ["acp", "--agent-engine=v3", "--auth-method=cli"],
    approvedEnvKeys: ["KIRO_API_KEY"],
    extraToolDirs: (home) => [path.join(home, ".kiro", "bin")],
    readableSkillSubdirs: [".kiro/steering", ".kiro/skills"],
  },
  copilot: {
    kind: "copilot",
    binary: "copilot",
    acpArgs: ["--acp"],
  },
  dsh: {
    kind: "dsh",
    binary: "dsh",
    acpArgs: ["--profile", "acp"],
    approvedEnvKeys: ["DEEPSEEK_API_KEY"],
  },
};

export function getAcpFlavor(kind: ExternalAgentKind): AcpFlavorSpec | undefined {
  return ACP_FLAVORS[kind];
}

export function acpReadableSkillSubdirs(kind: ExternalAgentKind): readonly string[] {
  return ACP_FLAVORS[kind]?.readableSkillSubdirs ?? [];
}
