import {
  AGENT_TASK_KINDS, EXTERNAL_AGENT_KINDS, LEGACY_ROLE_ALIASES, redactSensitiveText,
  type AgentAssignment, type AgentDispatchIntent, type AgentDispatchPolicy, type AgentRoutingTarget, type AgentTaskKind,
  type EnvNodeDescriptor, type ExternalAgentKind, type RolePreset,
} from "@kulo/protocol";

type Roles = Readonly<Record<string, RolePreset>>;
export class AgentRoutingError extends Error {
  readonly humanError: string;
  constructor(readonly code: string, message: string, readonly status: 400 | 409 = 409) {
    super(message); this.name = "AgentRoutingError"; this.humanError = message;
  }
}
function fail(code: string, message: string, status: 400 | 409 = 409): never { throw new AgentRoutingError(code, message, status); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const canonical = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
const display = (role: RolePreset) => `${role.label} (${role.id})`;
const ownRole = (roles: Roles, id: string): RolePreset | undefined => Object.hasOwn(roles, id) ? roles[id] : undefined;
const STABLE_KINDS: readonly ExternalAgentKind[] = ["codex", "claude-code", "antigravity", "dsh"];
function validName(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 200 &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value) && !/\p{Cs}/u.test(value);
}

export function normalizeAgentDispatchPolicy(value: unknown): AgentDispatchPolicy | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some(key => !["defaultFor", "projectIds"].includes(key)) || !Array.isArray(value.defaultFor) ||
      value.defaultFor.some(kind => typeof kind !== "string" || !(AGENT_TASK_KINDS as readonly string[]).includes(kind))) {
    fail("invalid_agent_dispatch_policy", "智能体的默认承接范围无效，请选择已支持的任务类型。", 400);
  }
  const requestedKinds = value.defaultFor;
  const defaultFor = AGENT_TASK_KINDS.filter(kind => requestedKinds.includes(kind));
  let projectIds: string[] | undefined;
  if (value.projectIds !== undefined) {
    if (!Array.isArray(value.projectIds) || value.projectIds.some(id => typeof id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) || ["constructor", "prototype", "__proto__"].includes(id) || redactSensitiveText(id) !== id)) {
      fail("invalid_agent_dispatch_policy", "智能体的项目范围只能包含有效的公开项目编号。", 400);
    }
    if (value.projectIds.length) projectIds = [...new Set(value.projectIds as string[])].sort();
  }
  return defaultFor.length ? { defaultFor, ...(projectIds ? { projectIds } : {}) } : undefined;
}

/** Disabled defaults still reserve their scope; an unavailable default must not silently change assignees. */
export function assertAgentDefaultScopes(roles: Roles): void {
  const entries = Object.values(roles).map(role => ({ role, policy: normalizeAgentDispatchPolicy(role.dispatchPolicy) })).filter(entry => entry.policy !== undefined);
  for (const { role } of entries) if (role.external && !STABLE_KINDS.includes(role.external.kind)) {
    fail("agent_default_kind_unsupported", `${display(role)} 的 ${role.external.kind} 接入尚未正式支持默认派发，请保留用户点名使用。`, 400);
  }
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i]!; const b = entries[j]!;
    if ((a.role.external?.envId ?? "") !== (b.role.external?.envId ?? "")) continue;
    const types = a.policy!.defaultFor.filter(kind => b.policy!.defaultFor.includes(kind));
    if (!types.length || Boolean(a.policy!.projectIds) !== Boolean(b.policy!.projectIds)) continue;
    if (a.policy!.projectIds && !a.policy!.projectIds.some(id => b.policy!.projectIds!.includes(id))) continue;
    fail("agent_default_scope_conflict", `${display(a.role)} 与 ${display(b.role)} 的默认承接范围重叠（${types.join("、")}），请保留一个或调整项目范围。`);
  }
}

const BUILTIN_TASK_KINDS: Readonly<Record<string, AgentTaskKind>> = {
  coder: "coding", engineer: "coding", checker: "review", reviewer: "review", "code-reviewer": "review",
  architect: "architecture", designer: "design", "ui-designer": "design", scout: "research", explorer: "research", writer: "writing",
};
const PLATFORM_ALIASES: Readonly<Record<ExternalAgentKind, readonly string[]>> = {
  codex: ["OpenAI Codex", "Codex CLI", "Codex客户端", "Codex"],
  "claude-code": ["Claude Code CLI", "Claude Code", "ClaudeCode", "claude-code", "Claude", "克劳德代码"],
  antigravity: ["Antigravity", "Anti Gravity", "反重力智能体", "反重力", "agy"],
  dsh: ["DeepSeek Harness", "DeepSeekHarness", "DeepSeek-Harness", "DSH"],
  "grok-bot": ["Grok Bot", "GrokBot", "Grok机器人", "Grok 机器人"],
  dots: ["GPT Dots", "GPTDots", "Dots"],
  muse: ["Muse Agent", "Muse"],
};
const INTERNAL_ALIASES = ["内置 Worker", "内置Worker", "内置智能体", "Kulo Worker", "built-in Worker", "builtin worker", "internal worker"];
interface Alias { text: string; kind?: ExternalAgentKind; internal?: boolean; ids: string[]; }
function aliases(roles: Roles): Alias[] {
  const names = new Map<string, Alias>();
  const add = (text: string, data: Partial<Alias>) => {
    if (!validName(text)) fail("invalid_agent_registry_name", "智能体的名称或编号包含无效字符，请先检查智能体配置。", 400);
    text = text.normalize("NFKC");
    const key = canonical(text);
    const previous = names.get(key) ?? { text, ids: [] };
    names.set(key, { ...previous, ...data, ids: [...new Set([...previous.ids, ...(data.ids ?? [])])] });
  };
  for (const role of Object.values(roles)) { add(role.id, { ids: [role.id] }); add(role.label, { ids: [role.id] }); }
  for (const [alias, target] of Object.entries(LEGACY_ROLE_ALIASES)) {
    if (ownRole(roles, target) && !names.has(canonical(alias))) add(alias, { ids: [target] });
  }
  for (const kind of EXTERNAL_AGENT_KINDS) for (const text of PLATFORM_ALIASES[kind]) add(text, { kind });
  for (const text of INTERNAL_ALIASES) add(text, { internal: true });
  return [...names.values()].sort((a, b) => b.text.length - a.text.length);
}
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function unquotedText(text: string, names: readonly { text: string }[]): string {
  const exactName = new Set(names.map(name => canonical(name.text)));
  return text.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)|`[^`\n]*`/g, " ")
    .replace(/<(?:code|pre|blockquote)\b[^>]*>[^]*?<\/(?:code|pre|blockquote)>/gi, " ")
    .replace(/^\s*>[^\n]*(?:\n|$)/gm, "\n")
    .replace(/^\s*(?:引用|示例|例如|原文|example|quote)\s*[:：][^\n]*/gim, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|plugin|app):\/\/[^\s<>()]+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ")
    .replace(/“([^”]*)”|「([^」]*)」|『([^』]*)』|"([^"\n]*)"|(?<![\p{L}\p{N}])'([^'\n]*)'(?![\p{L}\p{N}])/gu, (_full, ...groups: unknown[]) => {
      const content = groups.slice(0, 5).find(group => typeof group === "string") as string;
      // Preserve the boundary of an exact quoted name before a Chinese task clause.
      return exactName.has(canonical(content)) ? ` ${content} ` : " ";
    });
}

const DEVICE_MODEL_PATTERNS: readonly { pattern: RegExp; variants: readonly string[] }[] = [
  { pattern: /(?:^|[^a-z0-9])mac\s*[-_]?\s*mini(?:[^a-z0-9]|$)/i, variants: ["Macmini", "Mac mini", "Mac-mini"] },
  { pattern: /(?:^|[^a-z0-9])mac\s*[-_]?\s*studio(?:[^a-z0-9]|$)/i, variants: ["MacStudio", "Mac Studio", "Mac-Studio"] },
  { pattern: /(?:^|[^a-z0-9])mac\s*[-_]?\s*pro(?:[^a-z0-9]|$)/i, variants: ["MacPro", "Mac Pro", "Mac-Pro"] },
  { pattern: /(?:^|[^a-z0-9])mac\s*[-_]?\s*book\s*[-_]?\s*pro(?:[^a-z0-9]|$)/i, variants: ["MacBookPro", "MacBook Pro", "MacBook-Pro", "MacBook"] },
  { pattern: /(?:^|[^a-z0-9])mac\s*[-_]?\s*book\s*[-_]?\s*air(?:[^a-z0-9]|$)/i, variants: ["MacBookAir", "MacBook Air", "MacBook-Air", "MacBook"] },
  { pattern: /(?:^|[^a-z0-9])mac\s*[-_]?\s*book(?:[^a-z0-9]|$)/i, variants: ["MacBook"] },
  { pattern: /(?:^|[^a-z0-9])imac(?:[^a-z0-9]|$)/i, variants: ["iMac"] },
];

function expandDeviceNameVariants(raw: string): string[] {
  const normalized = raw.normalize("NFKC").trim();
  if (!validName(normalized)) return [];
  const seeds = new Set<string>([normalized]);
  const wrappedLocal = /^Local\s*\(([^()]+)\)$/i.exec(normalized)?.[1]?.trim();
  if (wrappedLocal && validName(wrappedLocal)) seeds.add(wrappedLocal);
  for (const seed of [...seeds]) {
    const stripped = seed.replace(/\.(?:local|lan|home\.arpa)\.?$/i, "").trim();
    if (stripped && stripped !== seed && validName(stripped)) seeds.add(stripped);
  }
  const results = new Set<string>();
  for (const seed of seeds) {
    results.add(seed);
    if (/^[A-Za-z0-9._\-\s]+$/.test(seed)) {
      const spaced = seed.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      if (spaced.length >= 3 && validName(spaced)) {
        results.add(spaced);
        const hyphenated = spaced.replace(/\s+/g, "-");
        if (hyphenated !== spaced && validName(hyphenated)) results.add(hyphenated);
      }
      const compact = seed.replace(/[\s_-]+/g, "");
      if (compact.length >= 3 && validName(compact)) results.add(compact);
    }
    for (const model of DEVICE_MODEL_PATTERNS) {
      if (model.pattern.test(seed)) {
        for (const variant of model.variants) results.add(variant);
      }
    }
  }
  return [...results];
}

function deviceAliases(envs: readonly EnvNodeDescriptor[]): Alias[] {
  const aliases = new Map<string, Alias>();
  const register = (name: string, deviceId: string) => {
    if (!validName(name)) return;
    const key = canonical(name);
    const alias = aliases.get(key) ?? { text: name.normalize("NFKC"), ids: [] };
    if (!alias.ids.includes(deviceId)) alias.ids.push(deviceId);
    aliases.set(key, alias);
  };
  for (const device of envs) {
    const rawNames: string[] = [];
    if (device.name && !(device.id === "local" && canonical(device.name) === "local")) rawNames.push(device.name);
    if (device.info?.hostname) rawNames.push(device.info.hostname);
    if (device.id !== "local") rawNames.push(device.id);
    if (device.id === "local") rawNames.push("主脑", "Hub");
    for (const raw of rawNames) {
      for (const variant of expandDeviceNameVariants(raw)) {
        if (device.id === "local" && canonical(variant) === "local") continue;
        register(variant, device.id);
      }
    }
  }
  return [...aliases.values()].sort((a, b) => b.text.length - a.text.length);
}

/** Match explicit device placement in the original message, including overlapping device names. */
export function namedDispatchDevices(text: string | undefined, envs: readonly EnvNodeDescriptor[]): string[][] {
  if (!text) return [];
  const names = deviceAliases(envs);
  if (!names.length) return [];
  const source = unquotedText(text.normalize("NFKC"), names);
  const targets = namesIn(source, names).filter(({ alias, start, end }) => {
    const clause = source.slice(0, start).split(/[。.!！？?；;，,\n]/).at(-1)!;
    const after = source.slice(end);
    if (alias.ids.length === 0) return false;
    if (/(?:不要|别|不用|无需|不必|不能|不得|禁止|避免|不是|除了|例如|假设|如果|假如)|\b(?:not|never|avoid|without|except|instead\s+of|if|example)\b/i.test(clause)) {
      return false;
    }
    if (/^\s*(?:(?:本机|本地|上|里|中)\s*)?(?:请勿|请不要|不要|别|不用|无需|禁止|避免|do not\b|don't\b|must not\b)/i.test(after)) {
      return false;
    }
    const precededByPreposition =
      /(?:在|到|去|用|通过|让|交给|给|把|将|对|向|从)\s*(?:设备\s*)?$|\b(?:on|using|to|use|in|at|for|from|of)\s+(?:(?:my|your|the)\s+)?$/i.test(clause);
    const precededByAction =
      /(?:检查|查看|看看|看下|看一看|排查|确认|检测|查询|查一下|查下|修改|更改|调整|配置|设置|更新|安装|卸载|删除|删掉|清理|清除|移除|启动|停止|重启|关闭|打开|操作|运行|执行|测试|登录|连接|同步|备份)(?:一下|下|看看)?\s*(?:设备\s*)?$/i.test(clause) ||
      /\b(?:check|inspect|verify|configure|config|update|edit|modify|change|install|uninstall|remove|delete|clean|restart|reboot|start|stop|run|test|access|open|sync)\s+(?:(?:if|whether)\s+)?(?:(?:my|your|the)\s+)?$/i.test(clause);
    const followedByDeviceScope =
      /^\s*(?:本机|本地|电脑|机器|主机|主脑|节点|设备|终端|系统|环境|桌面|目录|文件|端口|服务|配置|设置|上|里|中|的)/.test(after) ||
      /^(?:['’]s\b|\s+(?:local|machine|host|computer|device|config|settings|system|environment|files?|directories?|folders?)\b)/i.test(after);
    return precededByPreposition || precededByAction || followedByDeviceScope;
  });
  return targets.map(({ alias }) => alias.ids);
}
function namesIn(text: string, names: readonly Alias[]): Array<{ alias: Alias; start: number; end: number; at: boolean }> {
  const matches: Array<{ alias: Alias; start: number; end: number; at: boolean }> = [];
  for (const alias of names) {
    const expression = new RegExp(escaped(alias.text).replace(/\s+/g, "\\s+"), "giu");
    for (const match of text.matchAll(expression)) {
      const start = match.index; const end = start + match[0].length;
      if (/[A-Za-z0-9_-]/.test(alias.text[0]!) && /[A-Za-z0-9_-]/.test(text[start - 1] ?? "")) continue;
      if (/[A-Za-z0-9_-]/.test(alias.text.at(-1)!) && /[A-Za-z0-9_-]/.test(text[end] ?? "")) continue;
      if (matches.some(item => start < item.end && end > item.start)) continue;
      matches.push({ alias, start, end, at: text[start - 1] === "@" });
    }
  }
  for (const match of text.matchAll(/(?:让|使用|用|交给|交由|指派给?|委派给?|换成|换用|改成)\s*([\p{L}\p{N}][\p{L}\p{N}_-]{0,63}?(?:\s+Agent|智能体))/giu)) {
    const name = match[1]!; const start = match.index + match[0].indexOf(name); const end = start + name.length;
    if (/^(?:新的|一个|某个|现有|另一个|your|new|an?|the)\s*(?:Agent|智能体)$/i.test(name)) continue;
    if (!matches.some(item => start < item.end && end > item.start)) matches.push({ alias: { text: name, ids: [] }, start, end, at: false });
  }
  for (const match of text.matchAll(/@([\p{L}\p{N}][\p{L}\p{N}_.:-]{0,79})/gu)) {
    const start = match.index + 1; const end = start + match[1]!.length;
    if (!matches.some(item => start < item.end && end > item.start)) matches.push({ alias: { text: match[1]!, ids: [] }, start, end, at: true });
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** This deliberately recognizes explicit assignment syntax, not a task classifier or model-generated intent. */
export function extractAgentDispatchIntent(text: string, roles: Roles, envs: readonly EnvNodeDescriptor[] = []): AgentDispatchIntent | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  const names = aliases(roles); const source = unquotedText(text.normalize("NFKC"), names);
  const targets: AgentRoutingTarget[] = [];
  for (const match of namesIn(source, names)) {
    const prefix = source.slice(0, match.start);
    const sentenceStart = Math.max(...[..."。.!！？?；;\n"].map(mark => prefix.lastIndexOf(mark) + 1));
    const sentenceEnd = source.slice(match.end).search(/[。.!！？?；;\n]/);
    const sentence = source.slice(sentenceStart, sentenceEnd < 0 ? undefined : match.end + sentenceEnd);
    const before = source.slice(sentenceStart, match.start);
    const after = source.slice(match.end, sentenceEnd < 0 ? undefined : match.end + sentenceEnd);
    const clause = before.split(/[,，]|(?:而是|但是|改用|转用|instead)/i).at(-1)!;
    const requestClause = clause.replace(/能不能|可不可以|是否可以|是否能|能否|可否/g, "");
    if (/(?:不要|别|不用|无需|不必|不能|不得|不想|不让|不是|不一定|不打算|未批准|不批准|不同意|请勿|禁止|避免|不(?:再)?(?:使用|用|让|交给|交由|指派|委派|换成|换用|改成))|\b(?:not|never|avoid|without|neither|don't)\b/i.test(requestClause)) continue;
    if (/(?:介绍|讲解|解释|比较|对比|区别|使用方法|如何使用|怎么使用|怎么用|如何用|怎么让|如何让|假设|如果|假如|是否|你觉得|翻译|改写|复述|转述|写道|写着|提到|看到|引用|原话|据说|说过|他说|文档中|示例|例如|配置|连接|安装|接入|讨论(?:一下|是否|如何|怎么|让|用))|\b(?:introduce|explain|compare|comparison|difference|whether|suppose|how|why|when|tutorial|example|translate|quote|mentioned|says)\b/i.test(requestClause)) continue;
    if (/(?:哪个好|哪个更|更好用|有什么区别|会怎样|怎么样)|\b(?:which\s+(?:one\s+)?(?:is|would)|better\s+than)\b/i.test(sentence)) continue;
    if (/^\s*(?:模型|API\b|接口|SDK\b|model\b|的\s*(?:模型|API\b|接口|SDK\b|model\b|教程|介绍|说明|配置))|^\s*(?:了(?:吗|么|没)|用过)/i.test(after)) continue;
    const verbs = [...before.matchAll(/让|叫|请|使用|用|交给|交由|交予|换成|换用|改成|指派(?:给)?|委派(?:给)?|派给|指定(?:给)?|\b(?:use|using|ask|have|let|assign|delegate|send|hand)\b/gi)];
    const verb = verbs.at(-1);
    const between = verb ? before.slice(verb.index + verb[0].length) : "";
    if (verb && /^(?:请|ask|have|let)$/i.test(verb[0])) {
      let directNames = between;
      for (const alias of names) directNames = directNames.replace(new RegExp(escaped(alias.text), "giu"), " ");
      if (directNames.replace(/\b(?:and|or|the|my|your|local)\b|[\s@、,，:：]|以及|和|与|或/gi, "")) continue;
    }
    const direct = !before.replace(/[@\s,，:：]/g, "") && /^(?:\s*[,，:：]?\s*)(?:帮我|请|负责|来|修复|实现|检查|审查|写|做|fix\b|please\b|review\b|implement\b)/i.test(after);
    if (!match.at && !direct && (!verb || between.length > 120 || /(?:介绍|解释|比较|对比)|\b(?:explain|compare)\b/i.test(between))) continue;
    if (!/[A-Za-z0-9_-]/.test(match.alias.text.at(-1)!) && /^[\p{L}]/u.test(after) && !/^(?:在|于|从|到|来|去|帮|负责|写|修|做|检|审|查|设|研|调|实|开|处|排|测|接|协|完|跑|执|和|与|或|以及)/.test(after)) continue;
    const devicePrefix = clause || before.slice(-120);
    const devicePool = deviceAliases(envs);
    const matchedDeviceIds = new Set<string>();
    for (const item of namesIn(devicePrefix, devicePool)) {
      for (const id of item.alias.ids) matchedDeviceIds.add(id);
    }
    const namedEnv = matchedDeviceIds.size === 1 ? [...matchedDeviceIds][0] : undefined;
    let ids = match.alias.ids;
    if (match.alias.internal) ids = ["coder"];
    else if (match.at && ownRole(roles, match.alias.text)) ids = [match.alias.text];
    else if (match.alias.kind) {
      ids = Object.values(roles).filter(role => role.external?.kind === match.alias.kind).map(role => role.id);
      if (namedEnv) ids = ids.filter(id => roles[id]?.external?.envId === namedEnv);
    }
    const target: AgentRoutingTarget = { name: match.alias.text, ...(ids.length === 1 ? { agentId: ids[0] } : {}), ...(match.alias.kind ? { kind: match.alias.kind } : {}), ...(namedEnv ? { envId: namedEnv } : {}) };
    const keyFor = (item: AgentRoutingTarget) => `${item.agentId ? `id:${item.agentId}` : `${item.kind ?? "name"}:${canonical(item.name)}`}:${item.envId ?? ""}`;
    if (!targets.some(item => keyFor(item) === keyFor(target))) {
      if (targets.length >= 16) fail("agent_intent_too_many_targets", "一次最多点名 16 个智能体，请缩小本次任务范围。", 400);
      targets.push(target);
    }
  }
  return targets.length ? { version: 1, targets } : undefined;
}

export interface ResolveAgentDispatchInput {
  roles: Roles;
  intent?: AgentDispatchIntent;
  inheritedAssignment?: AgentAssignment;
  requestedRole?: string;
  taskKind?: AgentTaskKind;
  projectId?: string;
  envId?: string;
  trustedManual?: boolean;
}
export interface ResolvedAgentDispatch {
  role: string;
  taskKind?: AgentTaskKind;
  source: "explicit" | "default" | "orchestrator" | "manual" | "legacy";
  requestedName?: string;
  readOnly: boolean;
}
function requested(roles: Roles, value: string | undefined): RolePreset | undefined {
  if (!value?.trim()) return undefined;
  const id = value.trim(); return ownRole(roles, id) ?? (Object.hasOwn(LEGACY_ROLE_ALIASES, id) ? ownRole(roles, LEGACY_ROLE_ALIASES[id]!) : undefined);
}
function targetCandidates(roles: Roles, target: AgentRoutingTarget, envId?: string): RolePreset[] {
  if (target.agentId) { const role = ownRole(roles, target.agentId); return role ? [role] : []; }
  const scope = target.envId ?? envId;
  const candidates = target.kind ? Object.values(roles).filter(role => role.external?.kind === target.kind) :
    Object.values(roles).filter(role => canonical(role.id) === canonical(target.name) || canonical(role.label) === canonical(target.name));
  return candidates.filter(role => !scope || !role.external || role.external.envId === scope);
}
function result(role: RolePreset, source: ResolvedAgentDispatch["source"], taskKind?: AgentTaskKind, requestedName?: string, readOnlyFloor = false): ResolvedAgentDispatch {
  return { role: role.id, source, ...(taskKind ? { taskKind } : {}), ...(requestedName ? { requestedName } : {}), readOnly: Boolean(role.readOnly || readOnlyFloor) };
}

export function resolveAgentDispatch(input: ResolveAgentDispatchInput): ResolvedAgentDispatch {
  const { roles } = input;
  const requestedPreset = requested(roles, input.requestedRole);
  const requestedKind = requestedPreset && !requestedPreset.external ? BUILTIN_TASK_KINDS[requestedPreset.id] : undefined;
  const finish = (role: RolePreset, source: ResolvedAgentDispatch["source"], taskKind?: AgentTaskKind, name?: string) => result(role, source, taskKind, name, Boolean(requestedPreset?.readOnly));
  if (input.taskKind !== undefined && !(AGENT_TASK_KINDS as readonly string[]).includes(input.taskKind)) fail("invalid_agent_task_kind", "智能体任务类型无效。", 400);
  if (input.intent !== undefined && (input.intent.version !== 1 || !Array.isArray(input.intent.targets) || !input.intent.targets.length || input.intent.targets.length > 16 ||
      input.intent.targets.some(target => !record(target) || !validName(target.name) ||
        target.agentId !== undefined && !validName(target.agentId) || target.envId !== undefined && !validName(target.envId) || target.kind !== undefined && !(EXTERNAL_AGENT_KINDS as readonly unknown[]).includes(target.kind)))) {
    fail("invalid_agent_dispatch_intent", "智能体点名记录无效，请重新指定智能体。", 400);
  }
  if (input.intent) {
    const targets = input.intent.targets;
    let target = targets[0]!;
    let candidates = targetCandidates(roles, target, input.envId);
    if (targets.length > 1) {
      const selected = requested(roles, input.requestedRole);
      const matches = selected ? targets.filter(item => targetCandidates(roles, item, input.envId).some(role => role.id === selected.id)) : [];
      const matched = matches.find(item => targetCandidates(roles, item, input.envId).length === 1) ?? matches[0];
      if (!selected || !matched) fail("agent_selection_required", `你点名了 ${targets.map(item => item.name).join("、")}，请明确本任务交给其中哪一个智能体。`);
      target = matched; candidates = targetCandidates(roles, target, input.envId);
    }
    if (!candidates.length) fail("agent_not_configured", `${target.name}${target.envId ? ` 在设备 ${target.envId} 上` : ""} 尚未配置或已移除，请先连接该智能体；本任务不会改派其他智能体。`);
    if (candidates.length > 1) {
      const clientScopes = new Set(candidates.map(role => role.external ? `${role.externalClientId ?? `${role.external.kind}:${role.external.envId}`}` : `internal:${role.id}`));
      if (clientScopes.size === 1 && requestedPreset && candidates.some(role => role.id === requestedPreset.id)) {
        candidates = [requestedPreset];
      }
    }
    if (candidates.length !== 1) fail("agent_selection_ambiguous", `${target.name} 对应多个已配置智能体（${candidates.map(display).join("、")}），请指定具体名称或设备。`);
    const selected = candidates[0]!;
    if (target.envId && selected.external && selected.external.envId !== target.envId) fail("agent_device_conflict", `${display(selected)} 绑定设备 ${selected.external.envId}，与点名设备 ${target.envId} 不一致。`);
    if (INTERNAL_ALIASES.some(name => canonical(name) === canonical(target.name)) && selected.external) fail("agent_not_configured", "内置 Worker 未配置为内置智能体，请检查开发者角色。");
    return finish(selected, "explicit", input.taskKind ?? requestedKind ?? (!selected.external ? BUILTIN_TASK_KINDS[selected.id] : undefined), target.name);
  }
  if (input.inheritedAssignment && (input.inheritedAssignment.source === "explicit" || input.inheritedAssignment.source === "manual")) {
    const inherited = input.inheritedAssignment;
    const selected = ownRole(roles, inherited.agentId);
    if (!selected) fail("agent_not_configured", `${inherited.requestedName ?? inherited.agentId} 的原任务绑定已移除，请重新指定智能体；不会自动改派。`);
    return finish(selected, inherited.source, input.taskKind ?? inherited.taskKind, inherited.requestedName);
  }
  const selected = requestedPreset;
  if (input.requestedRole?.trim() && !selected) fail("agent_not_configured", `${input.requestedRole.trim()} 未配置，不能创建无角色定义的 Worker。`);
  const taskKind = input.taskKind ?? requestedKind;
  if (input.trustedManual && selected) return finish(selected, "manual", taskKind);
  const defaults = Object.values(roles).map(role => ({ role, policy: normalizeAgentDispatchPolicy(role.dispatchPolicy) })).filter(({ role, policy }) => policy &&
    (!input.envId || !role.external || role.external.envId === input.envId) && (!policy.projectIds || Boolean(input.projectId && policy.projectIds.includes(input.projectId))));
  if (defaults.length && !taskKind) fail("agent_task_kind_required", `默认承接智能体 ${defaults.map(({ role }) => display(role)).join("、")} 需要先明确任务类型，请为本任务分类。`);
  const matching = defaults.filter(({ policy }) => taskKind && policy!.defaultFor.includes(taskKind));
  const priority = matching.some(({ policy }) => policy!.projectIds) ? matching.filter(({ policy }) => policy!.projectIds) : matching;
  if (priority.length > 1) fail("agent_default_ambiguous", `${taskKind} 对应多个同优先级默认智能体（${priority.map(({ role }) => display(role)).join("、")}），请指定智能体或执行设备。`);
  if (priority.length === 1) return finish(priority[0]!.role, "default", taskKind);
  if (selected?.external) return finish(selected, "orchestrator", taskKind);
  if (selected) return finish(selected, "legacy", taskKind);
  const coder = ownRole(roles, "coder") ?? ownRole(roles, "engineer");
  if (!coder || coder.external) fail("agent_not_configured", "内置 Worker 尚未配置，请指定已配置的智能体。");
  return finish(coder, "legacy", taskKind ?? "coding");
}

export function assertAgentDispatchAvailable(role: RolePreset | undefined, options: { envs: readonly EnvNodeDescriptor[]; envId?: string; allowOffline?: boolean }): void {
  if (!role) fail("agent_not_configured", "所选智能体尚未配置，请先连接或选择现有智能体。");
  const name = display(role);
  if (role.enabled === false) fail("agent_disabled", `${name} 已停用，请启用后重试或由用户明确选择其他智能体。`);
  if (!role.external) return;
  const binding = role.external;
  if (!STABLE_KINDS.includes(binding.kind)) fail("agent_not_stable", `${name} 的 ${binding.kind} 接入尚不支持稳定任务派发。`);
  if (!Number.isFinite(binding.verifiedAt) || !binding.verifiedAt || binding.verifiedAt < 0) fail("agent_unverified", `${name} 尚未完成本地任务通信验证，请在智能体设置页继续配置。`);
  if (options.envId && options.envId !== binding.envId) fail("agent_device_conflict", `${name} 绑定设备 ${binding.envId}，不能改派到 ${options.envId}。`);
  const env = options.envs.find(item => item.id === binding.envId);
  if (!env) fail("agent_device_unavailable", `${name} 绑定的设备 ${binding.envId} 尚未接入。`);
  if (env.executionKind === "native-device" || !["darwin", "linux", "win32"].includes(env.platform)) fail("agent_device_invalid", `${name} 绑定的 ${env.name} 不是支持本地智能体的电脑设备。`);
  if (!env.online && !options.allowOffline) fail("agent_device_offline", `${name} 绑定的设备 ${env.name} 当前离线，请恢复设备连接后重试。`);
}
