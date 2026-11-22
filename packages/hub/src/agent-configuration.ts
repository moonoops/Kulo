import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { defaultExternalAgentRolePrompt, defaultExternalAgentWhenToUse } from "./prompts.js";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import { AUTO_SCAN_EXTERNAL_AGENT_KINDS, EXTERNAL_AGENT_KINDS, LEGACY_ROLE_ALIASES, externalClientConnectionId, externalClientDisplayName, isBlockedCustomAcpExecutableName, isValidCustomAcpAgentRef, redactSensitiveText, validateCustomAcpArgs, type AgentConfigurationDraft, type AgentConfigurationWorkspace, type AgentDispatchPolicy, type EnvNodeDescriptor, type ExternalAgentBinding, type ExternalAgentCatalogItem, type ExternalAgentDetection, type ExternalAgentKind, type ExternalAgentModelInfo, type ExternalAgentQuickConnectRequest, type ExternalAgentQuickConnectResult, type ExternalAgentRequest, type ExternalAgentResponse, type ExternalAgentScanCandidate, type ExternalAgentScanResult, type ExternalClientConnection, type KuloSettingsView, type RolePreset } from "@kulo/protocol";
import { assertAgentDefaultScopes, normalizeAgentDispatchPolicy } from "./agent-routing.js";

export interface AgentConfigurationCommit {
  fingerprint: string;
  clientId: string;
  draftId: string;
  draftRevision: number;
  expectedRevision: number;
  role: RolePreset;
  models?: ExternalAgentModelInfo[];
}
export interface AgentConfigurationClientCommit {
  fingerprint: string;
  clientId: string;
  expectedRevision: number;
  client: ExternalClientConnection;
}
export interface AgentConfigurationSaveResult { agentId: string; enabled: boolean; settings: KuloSettingsView }
export interface AgentConfigurationRemovalCommit { fingerprint: string; clientId: string; agentId: string; expectedRevision: number }
type ReceiptResult = AgentConfigurationSaveResult | ExternalAgentQuickConnectResult | { agentId: string; removed: true; settings: KuloSettingsView } | AgentConfigurationDraft;
interface ConfigurationState {
  drafts: Record<string, AgentConfigurationDraft>;
  commits: Record<string, AgentConfigurationCommit>;
  clientCommits?: Record<string, AgentConfigurationClientCommit>;
  removals: Record<string, AgentConfigurationRemovalCommit>;
  receipts: Record<string, { fingerprint: string; state: "pending" | "complete" | "uncertain"; result?: ReceiptResult }>;
}
export const AgentConfigurationDoc = defineDoc<ConfigurationState & JsonObject>({
  kind: "kulo.agent-configuration", version: 1, scope: "session",
  initial: () => ({ drafts: {}, commits: {}, clientCommits: {}, removals: {}, receipts: {} }) as ConfigurationState & JsonObject,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 32,
});

export class AgentConfigurationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "AgentConfigurationError"; }
}
export interface AgentConfigurationOptions {
  harness: Harness;
  settings: () => KuloSettingsView;
  envs: () => EnvNodeDescriptor[];
  projects?: () => Promise<NonNullable<AgentConfigurationWorkspace["projects"]>>;
  request: (envId: string, request: ExternalAgentRequest) => Promise<ExternalAgentResponse>;
  saveRole: (input: { role: RolePreset; models?: ExternalAgentModelInfo[]; expectedRevision: number; commandId: string; operationKey: string; fingerprint: string; commit: AgentConfigurationCommit }) => Promise<KuloSettingsView>;
  saveClient?: (input: { client: ExternalClientConnection; expectedRevision: number; commandId: string; operationKey: string; fingerprint: string; commit: AgentConfigurationClientCommit }) => Promise<KuloSettingsView>;
  removeRole?: (input: { agentId: string; expectedRevision: number; commandId: string; operationKey: string; fingerprint: string; commit: AgentConfigurationRemovalCommit }) => Promise<KuloSettingsView>;
  verifyRoundtrip?: (draft: AgentConfigurationDraft, nonce: string) => Promise<{ sessionId?: string; version?: string }>;
  assertContext?: (clientId: string) => Promise<unknown>;
  redact?: (text: string) => string;
  onChanged?: () => void | Promise<void>;
}
export type AgentConfigurationPatch = Partial<Pick<AgentConfigurationDraft, "label" | "whenToUse" | "prompt" | "modelId" | "thinkingLevel" | "readOnly" | "allowSubagents">> & { kind?: ExternalAgentKind; envId?: string; executable?: string; acpArgs?: string[]; agentRef?: string; cdpUrl?: string; experimental?: boolean; dispatchPolicy?: Partial<AgentDispatchPolicy> };
type Guard = () => Promise<unknown>;

export const EXTERNAL_AGENT_CATALOG: readonly ExternalAgentCatalogItem[] = [
  { kind: "codex", label: "Codex", status: "supported", guide: "references/codex.md", instructions: "连接所选设备的 Codex App Server（自动探测 PATH 与 ChatGPT.app 内置 codex-cli）；登录在原客户端完成。" },
  { kind: "claude-code", label: "Claude Code", status: "supported", guide: "references/claude-code.md", instructions: "通过原生 SDK/CLI 会话连接已安装的 Claude Code。" },
  { kind: "antigravity", label: "Antigravity", status: "supported", guide: "references/antigravity.md", instructions: "连接 Antigravity CLI 的 agy acp 标准输入输出服务。" },
  { kind: "grok", label: "Grok Build", status: "supported", guide: "references/grok.md", instructions: "连接 Grok Build CLI 的 grok agent stdio 原生 ACP 服务；登录在原客户端执行 grok login 完成。" },
  { kind: "cursor", label: "Cursor Agent", status: "supported", guide: "references/cursor.md", instructions: "连接 Cursor Agent CLI 的 cursor-agent acp 标准输入输出服务。" },
  { kind: "opencode", label: "OpenCode", status: "supported", guide: "references/opencode.md", instructions: "连接 OpenCode CLI 的 opencode acp 标准输入输出服务。" },
  { kind: "gemini-cli", label: "Gemini CLI", status: "supported", guide: "references/gemini-cli.md", instructions: "连接 Gemini CLI 的 gemini --acp 标准输入输出服务。" },
  { kind: "kiro", label: "Kiro CLI", status: "supported", guide: "references/kiro.md", instructions: "连接 Kiro CLI V3 引擎的 kiro-cli acp --agent-engine=v3 --auth-method=cli 服务。" },
  { kind: "copilot", label: "GitHub Copilot", status: "supported", guide: "references/copilot.md", instructions: "连接 GitHub Copilot CLI 的 copilot --acp 标准输入输出服务。" },
  { kind: "dsh", label: "DeepSeek Harness", status: "supported", guide: "references/dsh.md", instructions: "连接 dsh --profile acp；协议初始化不代表模型凭据可用。" },
  { kind: "acp", label: "自定义 ACP", status: "supported", guide: "references/acp.md", instructions: "仅在设置界面手动配置本地已安装的 ACP 兼容可执行文件与参数；不通过对话工具接收任意启动命令。" },
  { kind: "grok-bot", label: "Grok Bot", status: "experimental", guide: "references/grok-bot.md", instructions: "实验性本地客户端桥接；需要明确选择 Bot，不自动开启调试或重启客户端。" },
  { kind: "dots", label: "ChatGPT Dots", status: "reserved", guide: "references/dots.md", instructions: "预留接入指导；尚无已验证的本地客户端控制驱动。" },
  { kind: "muse", label: "Meta Muse", status: "reserved", guide: "references/muse.md", instructions: "预留个人 Muse 接入指导，与 Muse Code 分开；尚无已验证的本地客户端控制驱动。" },
];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function stable(value: unknown): unknown { return Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value; }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
function fail(status: number, code: string, message: string): never { throw new AgentConfigurationError(status, code, message); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(value) || ["constructor", "prototype", "__proto__"].includes(value)) return fail(400, "invalid_agent_configuration_id", "智能体配置标识无效。");
  return value;
}
function kind(value: unknown): ExternalAgentKind {
  if (!(EXTERNAL_AGENT_KINDS as readonly unknown[]).includes(value)) return fail(400, "unknown_external_agent", "请选择接入指南中的客户端类型。");
  return value as ExternalAgentKind;
}
function publicText(value: unknown, label: string, limit: number, multiline = false): string {
  if (typeof value !== "string" || value.length > limit || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) return fail(400, "invalid_agent_configuration", `${label}无效。`);
  return value.trim();
}
function nativeThinkingLevel(value: unknown): string | undefined {
  const level = publicText(value, "客户端思考深度", 64);
  if (!level || level === "auto") return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(level)) fail(400, "invalid_agent_thinking_level", "请选择客户端支持的公开思考深度标识。");
  return level;
}
function revision(draft: AgentConfigurationDraft | undefined, expected: number): asserts draft is AgentConfigurationDraft {
  if (!Number.isSafeInteger(expected) || expected < 1) fail(400, "invalid_agent_configuration_revision", "智能体草稿版本无效。");
  if (!draft || draft.revision !== expected) fail(409, "agent_configuration_conflict", "智能体草稿已更新，请读取最新草稿后继续。");
}
const RESERVED_EXTERNAL_ROLE_IDS = new Set([
  "coder",
  "checker",
  "scout",
  "writer",
  "architect",
  "designer",
  ...Object.keys(LEGACY_ROLE_ALIASES),
]);

function suggestExternalRoleId(
  clientKind: ExternalAgentKind,
  envId: string,
  existingRoles: Readonly<Record<string, RolePreset>>,
  agentRef?: string,
): string {
  const seed = clientKind === "cursor"
    ? "cursor-agent"
    : clientKind === "acp" && agentRef?.trim()
      ? agentRef.trim()
      : clientKind;
  const base = seed.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "") || "agent";
  const canUse = (candidate: string) =>
    /^[a-z][a-z0-9_-]{0,39}$/.test(candidate) &&
    !RESERVED_EXTERNAL_ROLE_IDS.has(candidate) &&
    !Object.hasOwn(existingRoles, candidate);
  if (canUse(base)) return base;
  const envSlug = envId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16);
  if (envSlug) {
    const withEnv = `${base.slice(0, Math.max(1, 39 - envSlug.length))}-${envSlug}`;
    if (canUse(withEnv)) return withEnv;
  }
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, Math.max(1, 40 - suffix.length))}${suffix}`;
    if (canUse(candidate)) return candidate;
  }
  return `external-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function catalog(clientKind: ExternalAgentKind): ExternalAgentCatalogItem { return EXTERNAL_AGENT_CATALOG.find((entry) => entry.kind === clientKind)!; }
function assertAvailable(clientKind: ExternalAgentKind, experimental?: boolean): void {
  const item = catalog(clientKind);
  if (item.status === "reserved") fail(409, "agent_adapter_reserved", `${item.label} 尚无已验证的本地接入驱动，请先阅读接入指南。`);
  if (item.status === "experimental" && !experimental) fail(409, "agent_experimental_opt_in", "Grok Bot 使用实验性客户端桥接，请先说明限制并由用户明确选择试用。");
}

export class KuloAgentConfiguration {
  readonly #options: AgentConfigurationOptions;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(options: AgentConfigurationOptions) { this.#options = options; }
  async #serial<T>(work: () => Promise<T>): Promise<T> { const next = this.#queue.then(work, work); this.#queue = next.then(() => undefined, () => undefined); return next; }
  async #guard(clientId: string, guard?: Guard) { await this.#options.assertContext?.(clientId); await guard?.(); }
  async #state() { return this.#options.harness.snapshot(AgentConfigurationDoc, BACKGROUND_CONTEXT); }
  async #draft(clientId: string) { return (await this.#state())?.drafts[clientId]; }
  #public(value: unknown) { const text = JSON.stringify(value); if (redactSensitiveText(this.#options.redact?.(text) ?? text) !== text) fail(400, "agent_configuration_contains_secret", "配置包含受保护内容；请在原客户端完成登录，不要在对话中提供秘密。"); }
  async #store(draft: AgentConfigurationDraft, guard?: Guard) {
    this.#public(draft); await this.#guard(draft.clientId, guard);
    await this.#options.harness.commit(async (tx) => {
      const state = await tx.doc(AgentConfigurationDoc);
      if (Object.keys(state.drafts).length >= 128 && !state.drafts[draft.clientId]) fail(409, "agent_configuration_limit", "智能体配置草稿数量已达上限。");
      const previous = state.drafts[draft.clientId];
      if (previous ? previous.id !== draft.id || previous.revision !== draft.revision - 1 : draft.revision !== 1) fail(409, "agent_configuration_conflict", "智能体草稿已更新，请读取最新草稿后继续。");
      state.drafts[draft.clientId] = clone(draft);
    }, BACKGROUND_CONTEXT);
    await this.#options.onChanged?.(); return clone(draft);
  }
  #device(envId: string) {
    const env = this.#options.envs().find((entry) => entry.id === envId && entry.executionKind !== "native-device");
    if (!env) fail(400, "agent_device_not_found", "请选择已连接的电脑执行设备。");
    if (!env.online) fail(409, "agent_device_offline", "智能体所在设备离线，请连接后继续。");
    return env;
  }
  async #validateDispatchPolicy(draft: AgentConfigurationDraft, guard?: Guard) {
    const policy = normalizeAgentDispatchPolicy(draft.dispatchPolicy);
    if (policy?.projectIds?.length) {
      const projects = await this.#options.projects?.() ?? [];
      await this.#guard(draft.clientId, guard);
      for (const id of policy.projectIds) {
        const project = projects.find((item) => item.id === id);
        if (!project) fail(400, "agent_default_project_not_found", "默认承接的项目不存在，请从当前项目列表重新选择。");
        if (project.envId !== draft.binding.envId) fail(400, "agent_default_project_device_mismatch", "默认承接的项目必须位于智能体绑定的设备上。");
      }
    }
    const id = draft.agentId ?? draft.id;
    const candidate: RolePreset = { id, label: draft.label, whenToUse: draft.whenToUse, prompt: draft.prompt, external: draft.binding, ...(policy ? { dispatchPolicy: policy } : {}) };
    assertAgentDefaultScopes({ ...this.#options.settings().blocks.roles.value, [id]: candidate });
    return policy;
  }
  async workspace(clientId: string, guard?: Guard): Promise<AgentConfigurationWorkspace> {
    identifier(clientId); await this.#guard(clientId, guard);
    const draft = await this.#draft(clientId);
    const projects = (await this.#options.projects?.() ?? []).map(({ id, name, envId }) => ({ id, name, envId }));
    await this.#guard(clientId, guard);
    return clone({ catalog: [...EXTERNAL_AGENT_CATALOG], devices: this.#options.envs().filter((env) => env.executionKind !== "native-device").map(({ id, name, online }) => ({ id, name, online })), projects, agents: Object.values(this.#options.settings().blocks.roles.value).filter((role) => role.external).map((role) => ({ id: role.id, label: role.label, enabled: role.enabled !== false, binding: role.external!, ...(role.dispatchPolicy ? { dispatchPolicy: role.dispatchPolicy } : {}) })), ...(draft ? { draft } : {}) });
  }
  async scan(options: { clientId?: string; envId?: string; kinds?: ExternalAgentKind[] } = {}, guard?: Guard): Promise<ExternalAgentScanResult> {
    const clientId = options.clientId !== undefined ? identifier(options.clientId) : undefined;
    const envId = options.envId !== undefined ? identifier(options.envId) : undefined;
    if (clientId) await this.#guard(clientId, guard); else await guard?.();
    const allDevices = this.#options.envs().filter((env) => env.executionKind !== "native-device");
    if (envId && !allDevices.some((env) => env.id === envId)) fail(400, "agent_device_not_found", "请选择已连接的电脑执行设备。");
    const scopedDevices = envId ? allDevices.filter((env) => env.id === envId) : allDevices;
    const targetKinds = options.kinds?.length
      ? [...new Set(options.kinds.map((entry) => kind(entry)))]
      : [...AUTO_SCAN_EXTERNAL_AGENT_KINDS];
    const settingsView = this.#options.settings();
    const connectedMap = new Map<string, { clientId: string; verified: boolean }>();
    for (const client of Object.values(settingsView.externalClients ?? {})) {
      const baseKey = `${client.kind}:${client.envId}`;
      const prev = connectedMap.get(baseKey);
      connectedMap.set(baseKey, { clientId: client.id, verified: Boolean(prev?.verified || client.verifiedAt) });
    }
    for (const role of Object.values(settingsView.blocks.roles.value)) {
      if (!role.external) continue;
      const baseKey = `${role.external.kind}:${role.external.envId}`;
      const cid = role.externalClientId?.trim() || externalClientConnectionId(role.external);
      const prev = connectedMap.get(baseKey);
      connectedMap.set(baseKey, { clientId: prev?.clientId ?? cid, verified: Boolean(prev?.verified || role.external.verifiedAt) });
    }
    const onlineDevices = scopedDevices.filter((env) => env.online);
    const redactMessage = (value: string) => redactSensitiveText(this.#options.redact?.(value) ?? value).slice(0, 400);
    const checks: Array<{ deviceIndex: number; kindIndex: number; promise: Promise<ExternalAgentScanCandidate> }> = [];
    for (const [deviceIndex, device] of onlineDevices.entries()) {
      for (const [kindIndex, clientKind] of targetKinds.entries()) {
        const item = catalog(clientKind);
        const existing = connectedMap.get(`${clientKind}:${device.id}`);
        const promise = (async (): Promise<ExternalAgentScanCandidate> => {
          try {
            const response = await this.#options.request(device.id, { operation: "detect", kind: clientKind });
            if (response.type !== "detection" || response.detection.kind !== clientKind) {
              return {
                kind: clientKind, label: item.label, status: item.status, envId: device.id, envName: device.name, online: true,
                installed: false, alreadyConnected: Boolean(existing), ...(existing ? { connectedClientId: existing.clientId, connectedVerified: existing.verified } : {}),
                error: "执行设备返回的客户端检测结果无效。",
              };
            }
            const detection = clone(response.detection);
            this.#public(detection);
            return {
              kind: clientKind, label: item.label, status: item.status, envId: device.id, envName: device.name, online: true,
              installed: Boolean(detection.installed),
              ...(detection.desktopAppInstalled ? { desktopAppInstalled: true } : {}),
              authenticated: detection.authenticated,
              alreadyConnected: Boolean(existing),
              ...(existing ? { connectedClientId: existing.clientId, connectedVerified: existing.verified } : {}),
              ...(detection.executable ? { executable: detection.executable } : {}),
              ...(detection.version ? { version: detection.version } : {}),
              ...(detection.error ? { error: redactMessage(detection.error) } : {}),
            };
          } catch (cause) {
            return {
              kind: clientKind, label: item.label, status: item.status, envId: device.id, envName: device.name, online: true,
              installed: false, alreadyConnected: Boolean(existing), ...(existing ? { connectedClientId: existing.clientId, connectedVerified: existing.verified } : {}),
              error: redactMessage(cause instanceof Error ? cause.message : "检测客户端失败。"),
            };
          }
        })();
        checks.push({ deviceIndex, kindIndex, promise });
      }
    }
    const resolved = await Promise.all(checks.map(async (entry) => ({ ...entry, candidate: await entry.promise })));
    if (clientId) await this.#guard(clientId, guard); else await guard?.();
    const rank = (candidate: ExternalAgentScanCandidate) =>
      candidate.installed ? (candidate.alreadyConnected && candidate.connectedVerified ? 1 : 0) : 2;
    resolved.sort((left, right) =>
      rank(left.candidate) - rank(right.candidate) || left.deviceIndex - right.deviceIndex || left.kindIndex - right.kindIndex,
    );
    return clone({
      scannedAt: Date.now(),
      devices: scopedDevices.map(({ id, name, online }) => ({ id, name, online })),
      candidates: resolved.map((entry) => entry.candidate),
    });
  }
  async quickConnect(input: ExternalAgentQuickConnectRequest & { clientId: string }, guard?: Guard, options?: { allowCustomAcpCommand?: boolean }): Promise<ExternalAgentQuickConnectResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "invalid_agent_configuration", "智能体连接参数无效。");
    const allowed = ["clientId", "kind", "envId", "commandId", "runTest", "executable", "acpArgs", "agentRef", "cdpUrl", "experimental", "label", "whenToUse", "prompt", "modelId", "thinkingLevel", "allowSubagents", "dispatchPolicy"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) fail(400, "invalid_agent_configuration_field", "智能体配置不接收凭据、环境变量或任意启动命令。");
    this.#public(input);
    const clientId = identifier(input.clientId);
    const commandId = identifier(input.commandId);
    const clientKind = kind(input.kind);
    const envId = identifier(input.envId);
    if (input.runTest !== undefined && typeof input.runTest !== "boolean") fail(400, "invalid_agent_configuration", "测试参数无效。");
    if (input.experimental !== undefined && typeof input.experimental !== "boolean") fail(400, "invalid_agent_configuration", "实验接入选择无效。");
    if (input.allowSubagents !== undefined && typeof input.allowSubagents !== "boolean") fail(400, "invalid_agent_configuration", "智能体开关无效。");
    assertAvailable(clientKind, input.experimental);
    if (clientKind === "grok-bot" && input.runTest === true) {
      fail(409, "agent_roundtrip_unsupported", "Grok Bot 当前仅支持实验性协议检测，尚未提供稳定的真实收发校验，配置保存后保持停用。");
    }
    if (clientKind === "acp" && options?.allowCustomAcpCommand !== true) {
      fail(403, "custom_acp_ui_only", "自定义 ACP 客户端只能在设置界面直接配置，不支持通过对话工具传入任意启动命令。");
    }
    if (clientKind !== "acp" && input.acpArgs !== undefined) {
      fail(400, "invalid_agent_configuration_field", "仅自定义 ACP 客户端支持配置启动参数。");
    }
    const label = input.label !== undefined ? publicText(input.label, "label", 120) : "";
    const whenToUse = input.whenToUse !== undefined ? publicText(input.whenToUse, "whenToUse", 2000, true) : "";
    const prompt = input.prompt !== undefined ? publicText(input.prompt, "prompt", 16_000, true) : "";
    const modelId = input.modelId !== undefined ? publicText(input.modelId, "modelId", 512) : "";
    const thinkingLevel = input.thinkingLevel !== undefined ? nativeThinkingLevel(input.thinkingLevel) : undefined;
    const executable = input.executable !== undefined ? publicText(input.executable, "executable", 2048) : "";
    if (executable && !path.posix.isAbsolute(executable) && !path.win32.isAbsolute(executable)) {
      fail(400, "invalid_agent_executable", "客户端路径必须为设备上的绝对路径。");
    }
    const agentRef = input.agentRef !== undefined ? publicText(input.agentRef, "agentRef", 240) : "";
    let acpArgs: string[] | undefined;
    if (clientKind === "acp") {
      if (!executable) fail(400, "invalid_agent_executable", "自定义 ACP 客户端必须指定设备上的绝对可执行文件路径。");
      if (isBlockedCustomAcpExecutableName(executable)) {
        fail(400, "invalid_agent_executable", "自定义 ACP 客户端路径不能是通用 Shell、脚本解释器或包拉取执行器。");
      }
      if (!isValidCustomAcpAgentRef(agentRef)) {
        fail(400, "invalid_agent_configuration", "自定义 ACP 客户端必须提供有效标识（以字母或数字开头，最多 64 字符）。");
      }
      if (input.acpArgs !== undefined) {
        const validated = validateCustomAcpArgs(input.acpArgs);
        if (!validated.ok) fail(400, "invalid_agent_configuration", validated.error);
        if (validated.value.length > 0) acpArgs = validated.value;
      }
    }
    let cdpUrl = "";
    if (input.cdpUrl !== undefined) {
      const rawUrl = publicText(input.cdpUrl, "本机调试地址", 2048);
      if (rawUrl) {
        let parsed: URL;
        try { parsed = new URL(rawUrl); } catch { return fail(400, "invalid_agent_debug_endpoint", "请输入已存在的本机调试地址。"); }
        if (clientKind !== "grok-bot" || parsed.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
          fail(400, "invalid_agent_debug_endpoint", "实验调试只允许无凭据的本机 HTTP loopback 根地址（127.0.0.1 或 [::1]）。");
        }
        cdpUrl = parsed.href;
      }
    }
    if (input.dispatchPolicy !== undefined && (!input.dispatchPolicy || typeof input.dispatchPolicy !== "object" || Array.isArray(input.dispatchPolicy))) {
      fail(400, "invalid_agent_dispatch_policy", "默认承接设置无效。");
    }
    return this.#serial(async () => {
      await this.#guard(clientId, guard);
      const key = `quickConnect:${hash([clientId, commandId])}`;
      const fingerprint = hash(input);
      const previous = await this.#receipt<ExternalAgentQuickConnectResult>(key, fingerprint);
      if (previous) return previous;
      const state = await this.#state();
      const committed = state?.clientCommits?.[key];
      if (committed && committed.fingerprint !== fingerprint) fail(409, "agent_configuration_command_conflict", "此操作标识已用于另一份客户端连接配置。");
      const device = this.#device(envId);
      const item = catalog(clientKind);
      let commit: AgentConfigurationClientCommit;
      let verificationLevel: "protocol" | "roundtrip";
      if (committed) {
        commit = committed;
        verificationLevel = commit.client.verifiedAt ? "roundtrip" : "protocol";
      } else {
        const binding: ExternalAgentBinding = {
          kind: clientKind,
          envId,
          ...(executable ? { executable } : {}),
          ...(acpArgs?.length ? { acpArgs } : {}),
          ...(agentRef ? { agentRef } : {}),
          ...(cdpUrl ? { cdpUrl } : {}),
          ...(input.experimental !== undefined ? { experimental: input.experimental } : {}),
        };
        const probeResponse = await this.#options.request(envId, { operation: "probe", binding: clone(binding), ...(modelId ? { modelId } : {}) });
        await this.#guard(clientId, guard);
        if (probeResponse.type !== "detection" || probeResponse.detection.kind !== clientKind) {
          fail(502, "agent_probe_invalid", "执行设备返回的客户端检测结果无效。");
        }
        const detection = clone(probeResponse.detection);
        this.#public(detection);
        if (!detection.installed) fail(409, "agent_not_installed", detection.error || `未在 ${device.name} 上检测到 ${item.label}。`);
        if (detection.error) fail(409, "agent_probe_failed", detection.error);
        if (detection.authenticated === false) fail(409, "agent_not_authenticated", `${item.label} 尚未在 ${device.name} 完成登录，请先在原客户端登录后重试。`);
        if (detection.version) binding.version = detection.version;
        binding.capabilities = detection.capabilities;

        const language = this.#options.settings().blocks?.presentation?.value?.language;
        const resolvedLabel = label || (clientKind === "acp" && agentRef ? agentRef : item.label);
        const resolvedWhenToUse = whenToUse || defaultExternalAgentWhenToUse(clientKind, language);
        const resolvedPrompt = prompt || defaultExternalAgentRolePrompt(language);
        const shouldVerify = input.runTest !== false && item.status === "supported";
        verificationLevel = "protocol";
        if (shouldVerify) {
          if (!this.#options.verifyRoundtrip) fail(409, "agent_roundtrip_unavailable", "当前执行设备尚不支持受控收发测试。");
          const tempDraft: AgentConfigurationDraft = {
            id: `agent-quick-${commandId}`,
            revision: 1,
            clientId,
            settingsRevision: this.#options.settings().blocks.roles.revision,
            binding: clone(binding),
            label: resolvedLabel,
            whenToUse: resolvedWhenToUse,
            prompt: resolvedPrompt,
            ...(modelId ? { modelId } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            readOnly: false,
            allowSubagents: input.allowSubagents ?? false,
            detection,
            verification: { at: Date.now(), level: "protocol", version: detection.version },
            updatedAt: Date.now(),
          };
          const nonce = `KULO_AGENT_VERIFY_${hash(["quick", clientId, clientKind, envId, commandId]).slice(0, 24)}`;
          await this.#remember(key, fingerprint, "pending");
          let evidence: { sessionId?: string; version?: string };
          try {
            evidence = await this.#options.verifyRoundtrip(clone(tempDraft), nonce);
            await this.#guard(clientId, guard);
          } catch (cause) {
            await this.#remember(key, fingerprint, "uncertain");
            throw cause;
          }
          binding.verifiedAt = Date.now();
          if (evidence.version) binding.version = evidence.version;
          verificationLevel = "roundtrip";
        }
        const rolesBlock = this.#options.settings().blocks.roles;
        const externalClientId = externalClientConnectionId(binding);
        const verifiedReady = verificationLevel === "roundtrip" && item.status === "supported";
        if (!verifiedReady) delete binding.verifiedAt;
        const now = Date.now();
        const client: ExternalClientConnection = {
          id: externalClientId,
          kind: binding.kind,
          envId: binding.envId,
          ...(binding.kind === "acp" && resolvedLabel ? { label: resolvedLabel } : {}),
          ...(binding.executable ? { executable: binding.executable } : {}),
          ...(binding.kind === "acp" && binding.acpArgs?.length ? { acpArgs: [...binding.acpArgs] } : {}),
          ...(binding.agentRef ? { agentRef: binding.agentRef } : {}),
          ...(binding.cdpUrl ? { cdpUrl: binding.cdpUrl } : {}),
          ...(binding.experimental !== undefined ? { experimental: binding.experimental } : {}),
          ...(binding.version ? { version: binding.version } : {}),
          ...(binding.verifiedAt !== undefined ? { verifiedAt: binding.verifiedAt } : {}),
          ...(binding.capabilities ? { capabilities: clone(binding.capabilities) } : {}),
          models: clone(detection.models ?? []),
          updatedAt: now,
        };
        commit = {
          fingerprint,
          clientId,
          expectedRevision: rolesBlock.revision,
          client: clone(client),
        };
      }
      await this.#guard(clientId, guard);
      if (!this.#options.saveClient) fail(500, "agent_client_save_unavailable", "当前运行时不支持单独保存外部客户端连接。");
      const settings = await this.#options.saveClient({
        client: clone(commit.client),
        expectedRevision: commit.expectedRevision,
        commandId,
        operationKey: key,
        fingerprint,
        commit,
      });
      const enabled = Boolean(commit.client.verifiedAt && item.status === "supported");
      const result: ExternalAgentQuickConnectResult = {
        clientId: commit.client.id,
        kind: clientKind,
        envId,
        label: externalClientDisplayName(commit.client),
        enabled,
        verificationLevel,
        ...(commit.client.version ? { version: commit.client.version } : {}),
        modelsCount: commit.client.models.length,
        settings,
      };
      this.#public(result);
      await this.#remember(key, fingerprint, "complete", result);
      await this.#options.onChanged?.();
      return clone(result);
    });
  }
  async prepare(input: { clientId: string; kind: ExternalAgentKind; envId: string; agentId?: string; commandId?: string }, guard?: Guard, options?: { allowCustomAcpCommand?: boolean }) {
    const clientId = identifier(input.clientId); const clientKind = kind(input.kind); const envId = identifier(input.envId);
    if (input.commandId) identifier(input.commandId);
    if (clientKind === "acp" && !input.agentId && options?.allowCustomAcpCommand !== true) {
      fail(403, "custom_acp_ui_only", "自定义 ACP 客户端只能在设置界面直接配置，不支持通过对话工具新建。");
    }
    return this.#serial(async () => {
      await this.#guard(clientId, guard);
      const current = await this.#draft(clientId);
      if (current) {
        if (current.binding.kind === clientKind && current.binding.envId === envId && current.agentId === input.agentId) return clone(current);
        fail(409, "agent_draft_exists", "已有智能体草稿，请继续、修改或取消当前草稿。");
      }
      const roles = this.#options.settings().blocks.roles;
      const existing = input.agentId ? roles.value[identifier(input.agentId)] : undefined;
      if (input.agentId && !existing?.external) fail(400, "external_agent_not_found", "请选择已配置的外部智能体。");
      if (clientKind === "acp" && existing?.external && existing.external.kind !== "acp" && options?.allowCustomAcpCommand !== true) {
        fail(403, "custom_acp_ui_only", "自定义 ACP 客户端只能在设置界面直接配置，不支持通过对话工具切换类型。");
      }
      const device = this.#options.envs().find((env) => env.id === envId && env.executionKind !== "native-device");
      if (!device) fail(400, "agent_device_not_found", "请选择已连接的电脑执行设备。");
      const item = catalog(clientKind);
      const language = this.#options.settings().blocks?.presentation?.value?.language;
      const draft: AgentConfigurationDraft = { id: `agent-draft-${randomUUID()}`, revision: 1, clientId, settingsRevision: roles.revision, ...(existing ? { agentId: existing.id } : {}), binding: existing?.external ? { ...clone(existing.external), kind: clientKind, envId } : { kind: clientKind, envId }, label: existing?.label ?? item.label, whenToUse: existing?.whenToUse ?? defaultExternalAgentWhenToUse(clientKind, language), prompt: existing?.prompt ?? defaultExternalAgentRolePrompt(language), ...(existing?.modelId ? { modelId: existing.modelId } : {}), readOnly: existing?.readOnly ?? false, allowSubagents: existing?.allowSubagents ?? false, updatedAt: Date.now() };
      const thinkingLevel = existing?.thinkingLevel === undefined ? undefined : nativeThinkingLevel(existing.thinkingLevel);
      if (thinkingLevel) draft.thinkingLevel = thinkingLevel;
      if (existing?.dispatchPolicy) draft.dispatchPolicy = clone(existing.dispatchPolicy);
      if (existing?.external?.verifiedAt && item.status === "supported" && existing.external.kind === clientKind && existing.external.envId === envId) draft.verification = { at: existing.external.verifiedAt, level: "roundtrip", version: existing.external.version };
      else delete draft.binding.verifiedAt;
      return this.#store(draft, guard);
    });
  }
  async updateDraft(input: { clientId: string; expectedRevision: number; patch: AgentConfigurationPatch }, guard?: Guard, options?: { allowCustomAcpCommand?: boolean }) {
    const clientId = identifier(input.clientId);
    if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)) fail(400, "invalid_agent_configuration", "智能体草稿变更无效。");
    const allowed = ["label", "whenToUse", "prompt", "modelId", "thinkingLevel", "readOnly", "allowSubagents", "kind", "envId", "executable", "acpArgs", "agentRef", "cdpUrl", "experimental", "dispatchPolicy"];
    if (Object.keys(input.patch).some((key) => !allowed.includes(key))) fail(400, "invalid_agent_configuration_field", "智能体配置不接收凭据、环境变量或任意启动命令。");
    this.#public(input.patch);
    return this.#serial(async () => {
      await this.#guard(clientId, guard);
      const current = await this.#draft(clientId); revision(current, input.expectedRevision);
      const draft = clone(current); const patch = input.patch;
      if (options?.allowCustomAcpCommand !== true) {
        if (patch.kind === "acp" || patch.acpArgs !== undefined) {
          fail(403, "custom_acp_ui_only", "自定义 ACP 客户端启动命令只能在设置界面直接配置。");
        }
        if (current.binding.kind === "acp" && (patch.executable !== undefined || patch.agentRef !== undefined || patch.kind !== undefined)) {
          fail(403, "custom_acp_ui_only", "自定义 ACP 客户端的启动路径与标识只能在设置界面修改。");
        }
      }
      for (const key of ["label", "whenToUse", "prompt", "modelId"] as const) if (patch[key] !== undefined) draft[key] = publicText(patch[key], key, key === "prompt" ? 16_000 : key === "whenToUse" ? 2000 : key === "modelId" ? 512 : 120, key === "prompt" || key === "whenToUse");
      if (draft.modelId === "") delete draft.modelId;
      if (patch.thinkingLevel !== undefined) {
        const level = nativeThinkingLevel(patch.thinkingLevel);
        if (level) draft.thinkingLevel = level; else delete draft.thinkingLevel;
      }
      for (const key of ["readOnly", "allowSubagents"] as const) if (patch[key] !== undefined) { if (typeof patch[key] !== "boolean") fail(400, "invalid_agent_configuration", "智能体开关无效。"); draft[key] = patch[key]; }
      if (patch.kind !== undefined) draft.binding.kind = kind(patch.kind);
      if (patch.envId !== undefined) { draft.binding.envId = identifier(patch.envId); if (!this.#options.envs().some((env) => env.id === draft.binding.envId && env.executionKind !== "native-device")) fail(400, "agent_device_not_found", "请选择已连接的电脑执行设备。"); }
      for (const key of ["executable", "agentRef"] as const) if (patch[key] !== undefined) {
        const value = publicText(patch[key], key, key === "executable" ? 2048 : 240);
        if (key === "executable" && value && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)) fail(400, "invalid_agent_executable", "客户端路径必须为设备上的绝对路径。");
        if (key === "executable" && value && draft.binding.kind === "acp" && isBlockedCustomAcpExecutableName(value)) fail(400, "invalid_agent_executable", "自定义 ACP 客户端路径不能是通用 Shell、脚本解释器或包拉取执行器。");
        if (key === "agentRef" && draft.binding.kind === "acp" && value && !isValidCustomAcpAgentRef(value)) fail(400, "invalid_agent_configuration", "自定义 ACP 客户端标识格式无效。");
        if (value) draft.binding[key] = value; else delete draft.binding[key];
      }
      if (patch.acpArgs !== undefined) {
        if (draft.binding.kind !== "acp") fail(400, "invalid_agent_configuration_field", "仅自定义 ACP 客户端支持配置启动参数。");
        const validated = validateCustomAcpArgs(patch.acpArgs);
        if (!validated.ok) fail(400, "invalid_agent_configuration", validated.error);
        if (validated.value.length > 0) draft.binding.acpArgs = validated.value; else delete draft.binding.acpArgs;
      }
      if (draft.binding.kind !== "acp") delete draft.binding.acpArgs;
      if (patch.cdpUrl !== undefined) {
        const value = publicText(patch.cdpUrl, "本机调试地址", 2048);
        if (value) {
          let url: URL; try { url = new URL(value); } catch { return fail(400, "invalid_agent_debug_endpoint", "请输入已存在的本机调试地址。"); }
          if (draft.binding.kind !== "grok-bot" || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail(400, "invalid_agent_debug_endpoint", "实验调试只允许无凭据的本机 HTTP loopback 根地址（127.0.0.1 或 [::1]）。");
          draft.binding.cdpUrl = url.href;
        } else delete draft.binding.cdpUrl;
      }
      if (patch.experimental !== undefined) { if (typeof patch.experimental !== "boolean") fail(400, "invalid_agent_configuration", "实验接入选择无效。"); draft.binding.experimental = patch.experimental; }
      if (patch.dispatchPolicy !== undefined) {
        if (!patch.dispatchPolicy || typeof patch.dispatchPolicy !== "object" || Array.isArray(patch.dispatchPolicy)) fail(400, "invalid_agent_dispatch_policy", "默认承接设置无效。");
        draft.dispatchPolicy = { defaultFor: [], ...draft.dispatchPolicy, ...patch.dispatchPolicy };
      }
      const policy = await this.#validateDispatchPolicy(draft, guard);
      if (policy) draft.dispatchPolicy = policy; else delete draft.dispatchPolicy;
      const launchChanged = JSON.stringify(current.binding) !== JSON.stringify(draft.binding) || current.modelId !== draft.modelId || current.thinkingLevel !== draft.thinkingLevel;
      if (launchChanged) { delete draft.detection; delete draft.verification; delete draft.binding.verifiedAt; delete draft.binding.capabilities; delete draft.binding.version; }
      draft.revision += 1; draft.updatedAt = Date.now(); return this.#store(draft, guard);
    });
  }
  async #inspect(clientId: string, expectedRevision: number, operation: "detect" | "probe", guard?: Guard) {
    identifier(clientId);
    return this.#serial(async () => {
      await this.#guard(clientId, guard); const current = await this.#draft(clientId); revision(current, expectedRevision);
      assertAvailable(current.binding.kind, current.binding.experimental); this.#device(current.binding.envId);
      const response = await this.#options.request(current.binding.envId, operation === "detect" ? { operation, kind: current.binding.kind, executable: current.binding.executable } : { operation, binding: clone(current.binding), modelId: current.modelId });
      await this.#guard(clientId, guard);
      if (response.type !== "detection" || response.detection.kind !== current.binding.kind) fail(502, "agent_probe_invalid", "执行设备返回的客户端检测结果无效。");
      const detection = clone(response.detection); this.#public(detection);
      const draft: AgentConfigurationDraft = { ...current, detection, binding: { ...current.binding, ...(detection.version ? { version: detection.version } : {}), capabilities: detection.capabilities }, revision: current.revision + 1, updatedAt: Date.now() };
      // A fresh install check can retain prior task evidence for metadata-only edits.
      const retainRoundtrip = current.verification?.level === "roundtrip" && detection.installed && !detection.error && detection.authenticated !== false && detection.version === current.verification.version && (!current.binding.executable || detection.executable === current.binding.executable);
      if (!retainRoundtrip) {
        delete draft.verification; delete draft.binding.verifiedAt;
        if (operation === "probe" && detection.installed && !detection.error && detection.authenticated !== false) draft.verification = { at: Date.now(), level: "protocol", version: detection.version };
      }
      return this.#store(draft, guard);
    });
  }
  detect(clientId: string, expectedRevision: number, guard?: Guard) { return this.#inspect(clientId, expectedRevision, "detect", guard); }
  probe(clientId: string, expectedRevision: number, guard?: Guard) { return this.#inspect(clientId, expectedRevision, "probe", guard); }
  async authenticate(clientId: string, guard?: Guard) {
    identifier(clientId); await this.#guard(clientId, guard); const draft = await this.#draft(clientId);
    if (!draft) fail(404, "agent_draft_not_found", "请先准备智能体配置草稿。");
    return { status: "native-handoff", kind: draft.binding.kind, envId: draft.binding.envId, instructions: await this.readGuide(draft.binding.kind), note: "按客户端指南在所选设备完成认证后重新检查；此操作没有修改认证状态。" };
  }
  async #receipt<T extends ReceiptResult>(key: string, fingerprint: string): Promise<T | undefined> {
    const previous = (await this.#state())?.receipts[key];
    if (previous && previous.fingerprint !== fingerprint) fail(409, "agent_configuration_command_conflict", "此操作标识已用于另一项智能体配置。");
    if (previous && previous.state !== "complete") fail(409, "agent_test_unconfirmed", "上次测试的接收状态待确认，请检查原会话；不会自动重发测试。");
    return previous?.result ? clone(previous.result) as T : undefined;
  }
  async #remember(key: string, fingerprint: string, state: "pending" | "complete" | "uncertain", result?: ReceiptResult) {
    await this.#options.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentConfigurationDoc); doc.receipts[key] = { fingerprint, state, ...(result ? { result: clone(result) } : {}) };
      while (Object.keys(doc.receipts).length > 512) { const oldest = Object.keys(doc.receipts).find((entry) => doc.receipts[entry]?.state === "complete"); if (!oldest) break; delete doc.receipts[oldest]; }
      if (state === "complete") { delete doc.commits[key]; if (doc.removals) delete doc.removals[key]; }
    }, BACKGROUND_CONTEXT);
  }
  async verify(input: { clientId: string; expectedRevision: number; commandId: string; runTest: true }, guard?: Guard) {
    const clientId = identifier(input.clientId); identifier(input.commandId);
    if (input.runTest !== true) fail(400, "agent_test_consent_required", "真实收发测试需要用户明确同意；只检查协议请使用 probe。");
    return this.#serial(async () => {
      await this.#guard(clientId, guard); const key = `verify:${hash([clientId, input.commandId])}`; const fingerprint = hash(input);
      const previous = await this.#receipt<AgentConfigurationDraft>(key, fingerprint); if (previous) return previous;
      const current = await this.#draft(clientId); revision(current, input.expectedRevision); assertAvailable(current.binding.kind, current.binding.experimental); this.#device(current.binding.envId);
      if (current.binding.kind === "grok-bot") fail(409, "agent_roundtrip_unsupported", "Grok Bot 当前仅支持实验性协议检测，尚未提供稳定的真实收发校验，配置保存后保持停用。");
      if (!current.detection?.installed || !current.verification) fail(409, "agent_protocol_not_verified", "请先检测客户端并检查协议连接。");
      if (!this.#options.verifyRoundtrip) fail(409, "agent_roundtrip_unavailable", "当前执行设备尚不支持受控收发测试。");
      const nonce = `KULO_AGENT_VERIFY_${hash([current.id, current.revision, input.commandId]).slice(0, 24)}`;
      await this.#remember(key, fingerprint, "pending");
      let evidence: { sessionId?: string; version?: string };
      try { evidence = await this.#options.verifyRoundtrip(clone(current), nonce); await this.#guard(clientId, guard); }
      catch (cause) { await this.#remember(key, fingerprint, "uncertain"); throw cause; }
      const draft = await this.#store({ ...current, binding: { ...current.binding, verifiedAt: Date.now() }, verification: { at: Date.now(), level: "roundtrip", version: evidence.version ?? current.detection.version, ...(evidence.sessionId ? { sessionId: evidence.sessionId } : {}) }, revision: current.revision + 1, updatedAt: Date.now() }, guard);
      await this.#remember(key, fingerprint, "complete", draft); return draft;
    });
  }
  async save(input: { clientId: string; expectedRevision: number; commandId: string }, guard?: Guard): Promise<AgentConfigurationSaveResult> {
    const clientId = identifier(input.clientId); identifier(input.commandId);
    return this.#serial(async () => {
      await this.#guard(clientId, guard); const key = `save:${hash([clientId, input.commandId])}`; const fingerprint = hash(input);
      const previous = await this.#receipt<AgentConfigurationSaveResult>(key, fingerprint); if (previous) return previous;
      const committed = (await this.#state())?.commits[key];
      if (committed && committed.fingerprint !== fingerprint) fail(409, "agent_configuration_command_conflict", "此操作标识已用于另一份智能体配置。");
      const current = await this.#draft(clientId);
      let policy = current?.dispatchPolicy;
      const thinkingLevel = current?.thinkingLevel === undefined ? undefined : nativeThinkingLevel(current.thinkingLevel);
      if (!committed) {
        revision(current, input.expectedRevision); assertAvailable(current.binding.kind, current.binding.experimental);
        if (!current.label || !current.whenToUse || !current.prompt) fail(400, "agent_configuration_incomplete", "请补充智能体名称、适用任务和执行提示词。");
        if (!current.detection?.installed || !current.verification || current.detection.error) fail(409, "agent_connection_not_verified", "请先完成客户端检测和协议检查，再保存连接。");
        if (this.#options.settings().blocks.roles.revision !== current.settingsRevision) fail(409, "agent_settings_changed", "智能体设置已被其他操作修改，请重新读取后配置。");
        policy = await this.#validateDispatchPolicy(current, guard);
      }
      const externalClientId = externalClientConnectionId(current!.binding);
      const role: RolePreset = committed?.role ?? { id: current!.agentId ?? suggestExternalRoleId(current!.binding.kind, current!.binding.envId, this.#options.settings().blocks.roles.value, current!.binding.agentRef), label: current!.label, whenToUse: current!.whenToUse, prompt: current!.prompt, readOnly: current!.readOnly, allowSubagents: current!.allowSubagents, ...(current!.modelId ? { modelId: current!.modelId } : {}), ...(thinkingLevel ? { thinkingLevel } : {}), ...(policy ? { dispatchPolicy: clone(policy) } : {}), enabled: current!.verification?.level === "roundtrip" && catalog(current!.binding.kind).status === "supported", externalClientId, external: clone(current!.binding) };
      if (!role.enabled && role.external) delete role.external.verifiedAt;
      const detectedModels = committed?.models ?? current!.detection?.models;
      const commit: AgentConfigurationCommit = committed ?? { fingerprint, clientId, draftId: current!.id, draftRevision: current!.revision, expectedRevision: current!.settingsRevision, role: clone(role), ...(detectedModels ? { models: clone(detectedModels) } : {}) };
      await this.#guard(clientId, guard);
      const settings = await this.#options.saveRole({ role, ...(commit.models ? { models: clone(commit.models) } : {}), expectedRevision: commit.expectedRevision, commandId: input.commandId, operationKey: key, fingerprint, commit });
      const result = { agentId: role.id, enabled: role.enabled !== false, settings };
      this.#public(result); await this.#remember(key, fingerprint, "complete", result);
      await this.#options.harness.commit(async (tx) => { const doc = await tx.doc(AgentConfigurationDoc); if (doc.drafts[clientId]?.id === commit.draftId && doc.drafts[clientId]?.revision === commit.draftRevision) delete doc.drafts[clientId]; }, BACKGROUND_CONTEXT);
      await this.#options.onChanged?.(); return clone(result);
    });
  }
  async remove(input: { clientId: string; agentId: string; expectedRevision: number; commandId: string }, guard?: Guard) {
    const clientId = identifier(input.clientId); const agentId = identifier(input.agentId); identifier(input.commandId);
    return this.#serial(async () => {
      await this.#guard(clientId, guard); const key = `remove:${hash([clientId, input.commandId])}`; const fingerprint = hash(input);
      const previous = await this.#receipt<{ agentId: string; removed: true; settings: KuloSettingsView }>(key, fingerprint); if (previous) return previous;
      const committed = (await this.#state())?.removals?.[key];
      if (committed && committed.fingerprint !== fingerprint) fail(409, "agent_configuration_command_conflict", "此操作标识已用于另一项智能体变更。");
      const roles = this.#options.settings().blocks.roles;
      if (!committed && roles.revision !== input.expectedRevision) fail(409, "agent_settings_changed", "智能体设置已更新，请读取最新配置。");
      if (!committed && !roles.value[agentId]?.external) fail(404, "external_agent_not_found", "外部智能体不存在。");
      if (!this.#options.removeRole) fail(409, "agent_remove_unavailable", "当前无法移除此连接。");
      const commit: AgentConfigurationRemovalCommit = committed ?? { fingerprint, clientId, agentId, expectedRevision: input.expectedRevision };
      const settings = await this.#options.removeRole({ agentId, expectedRevision: commit.expectedRevision, commandId: input.commandId, operationKey: key, fingerprint, commit });
      const result = { agentId, removed: true as const, settings }; this.#public(result); await this.#remember(key, fingerprint, "complete", result); await this.#options.onChanged?.(); return clone(result);
    });
  }
  async discard(clientId: string, expectedRevision: number, guard?: Guard) {
    identifier(clientId); await this.#serial(async () => { await this.#guard(clientId, guard); const current = await this.#draft(clientId); revision(current, expectedRevision); await this.#options.harness.commit(async (tx) => { delete (await tx.doc(AgentConfigurationDoc)).drafts[clientId]; }, BACKGROUND_CONTEXT); await this.#options.onChanged?.(); });
  }
  async readGuide(clientKind?: ExternalAgentKind): Promise<string> {
    if (clientKind !== undefined) kind(clientKind);
    const adjacent = fileURLToPath(new URL("./skills/agent-configuration/", import.meta.url));
    const directory = existsSync(adjacent) ? adjacent : fileURLToPath(new URL("../skills/agent-configuration/", import.meta.url));
    const resource = clientKind ? catalog(clientKind).guide : "SKILL.md";
    return fs.readFile(path.join(directory, resource), "utf8");
  }
}
