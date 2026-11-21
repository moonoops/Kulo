import type { HomeAssistantEntityView } from "@kulo/protocol";

const MAX_SERVICE_DATA_BYTES = 8 * 1024;
const MAX_JSON_DEPTH = 4;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const JINJA_TEMPLATE_RE = /\{\{|\{%|\{#/;
const DOMAIN_RE = /^[a-z0-9_]{1,40}$/;
const SERVICE_RE = /^[a-z0-9_]{1,64}$/;
const ENTITY_ID_RE = /^[a-z0-9_]{1,40}\.[a-z0-9_]{1,120}$/;

export const BLOCKED_PHYSICAL_DOMAINS = new Set<string>([
  "lock",
  "alarm_control_panel",
  "siren",
  "valve",
  "hassio",
  "shell_command",
  "rest_command",
  "command_line",
]);

export const BLOCKED_SERVICES = new Set<string>([
  "homeassistant.stop",
  "homeassistant.restart",
  "homeassistant.reload_all",
  "lock.unlock",
  "lock.open",
  "alarm_control_panel.alarm_disarm",
  "alarm_control_panel.alarm_arm_away",
  "siren.turn_off",
  "valve.open_valve",
  "valve.close_valve",
  "automation.turn_off",
]);

export const GARAGE_GATE_PATTERN = /(?:garage|gate|door_lock|smart_lock|deadbolt|security_alarm|车库|门锁|大门)/i;

export function isBlockedPhysicalEntity(entityId: string, deviceClass?: string): boolean {
  const normalized = entityId.trim().toLowerCase();
  const domain = normalized.split(".")[0] ?? "";
  if (BLOCKED_PHYSICAL_DOMAINS.has(domain)) return true;
  if (domain === "cover") {
    const dc = (deviceClass ?? "").toLowerCase();
    if (dc === "garage" || dc === "gate" || GARAGE_GATE_PATTERN.test(normalized)) return true;
  }
  return false;
}

function checkPlainDepth(value: unknown, depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    throw Object.assign(new Error("Home Assistant 服务参数嵌套层级过深。"), { code: "ha_invalid_service_data", status: 400 });
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw Object.assign(new Error("Home Assistant 服务参数包含非法数值。"), { code: "ha_invalid_service_data", status: 400 });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) {
      throw Object.assign(new Error("Home Assistant 服务参数数组长度超出限制。"), { code: "ha_invalid_service_data", status: 400 });
    }
    for (const item of value) checkPlainDepth(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 48) {
      throw Object.assign(new Error("Home Assistant 服务参数字段数量超出限制。"), { code: "ha_invalid_service_data", status: 400 });
    }
    for (const [k, v] of entries) {
      if (FORBIDDEN_KEYS.has(k) || /[\x00-\x1f\x7f]/.test(k)) {
        throw Object.assign(new Error(`Home Assistant 服务参数包含非法键名「${k}」。`), { code: "ha_invalid_service_data", status: 400 });
      }
      checkPlainDepth(v, depth + 1);
    }
    return;
  }
  throw Object.assign(new Error("Home Assistant 服务参数包含不支持的值类型。"), { code: "ha_invalid_service_data", status: 400 });
}

export function sanitizeServiceData(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  let parsed = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw Object.assign(new Error("service_data 必须是合法的 JSON 对象。"), { code: "ha_invalid_service_data", status: 400 });
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("service_data 必须为键值对象。"), { code: "ha_invalid_service_data", status: 400 });
  }
  checkPlainDepth(parsed, 0);
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERVICE_DATA_BYTES) {
    throw Object.assign(new Error("service_data 体积超过 8KB 上限。"), { code: "ha_invalid_service_data", status: 400 });
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function normalizeStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .flatMap((item) => item.split(",").map((s) => s.trim()))
      .filter(Boolean);
  }
  return [];
}

export interface ExtractedHaTargets {
  entityIds: string[];
  areaIds: string[];
  deviceIds: string[];
  labelIds: string[];
  floorIds: string[];
}

export function extractHaTargets(entityId?: string, data?: Record<string, unknown>, targetObj?: Record<string, unknown>): ExtractedHaTargets {
  const entityIds = new Set<string>();
  const areaIds = new Set<string>();
  const deviceIds = new Set<string>();
  const labelIds = new Set<string>();
  const floorIds = new Set<string>();

  for (const id of normalizeStringList(entityId)) entityIds.add(id);
  for (const bag of [data, targetObj]) {
    if (!bag) continue;
    for (const id of normalizeStringList(bag.entity_id)) entityIds.add(id);
    for (const id of normalizeStringList(bag.area_id)) areaIds.add(id);
    for (const id of normalizeStringList(bag.device_id)) deviceIds.add(id);
    for (const id of normalizeStringList(bag.label_id)) labelIds.add(id);
    for (const id of normalizeStringList(bag.floor_id)) floorIds.add(id);
  }
  return {
    entityIds: [...entityIds],
    areaIds: [...areaIds],
    deviceIds: [...deviceIds],
    labelIds: [...labelIds],
    floorIds: [...floorIds],
  };
}

export interface HaSecurityLookupContext {
  entities: ReadonlyMap<string, HomeAssistantEntityView>;
  stale?: boolean;
  /** Optional async resolver for script.* configs to recursively inspect indirect service calls. */
  fetchScriptConfig?: (scriptSlug: string) => Promise<Record<string, unknown> | undefined>;
}

export function assertSafeHaServiceCall(input: {
  domain: string;
  service: string;
  entityId?: string;
  deviceClass?: string;
  serviceData?: Record<string, unknown>;
  target?: Record<string, unknown>;
  triggerSource: "user_direct" | "user_confirmed_l2" | "external_untrusted";
  context?: HaSecurityLookupContext;
}): void {
  if (input.triggerSource === "external_untrusted") {
    throw Object.assign(
      new Error("安全红线：来自外部不可信消息源的事件严禁直接触发智能家居物理动作，仅允许推送只读提醒或待确认卡片。"),
      { code: "ha_untrusted_trigger_blocked", status: 403 },
    );
  }
  const domain = input.domain.trim().toLowerCase();
  const service = input.service.trim().toLowerCase();
  if (JINJA_TEMPLATE_RE.test(domain) || JINJA_TEMPLATE_RE.test(service)) {
    throw Object.assign(
      new Error("物理安防红线：禁止使用动态模板拼接服务名称。"),
      { code: "ha_physical_security_blocked", status: 403 },
    );
  }
  const key = `${domain}.${service}`;
  if (BLOCKED_PHYSICAL_DOMAINS.has(domain) || BLOCKED_SERVICES.has(key)) {
    throw Object.assign(
      new Error(`物理安防红线：禁止 AI 执行高危服务「${key}」（门锁、安防撤防、阀门、系统启停永久锁死只读告警）。`),
      { code: "ha_physical_security_blocked", status: 403 },
    );
  }

  const targets = extractHaTargets(input.entityId, input.serviceData, input.target);
  for (const raw of [...targets.entityIds, ...targets.areaIds, ...targets.deviceIds, ...targets.labelIds, ...targets.floorIds]) {
    if (JINJA_TEMPLATE_RE.test(raw)) {
      throw Object.assign(
        new Error("物理安防红线：目标实体或区域禁止使用动态模板表达式。"),
        { code: "ha_physical_security_blocked", status: 403 },
      );
    }
  }

  // Generic homeassistant.* services must specify explicit concrete entities (never `all` or empty).
  if (domain === "homeassistant") {
    if (targets.entityIds.length === 0 || targets.entityIds.some((id) => id.toLowerCase() === "all")) {
      throw Object.assign(
        new Error(`物理安防红线：通用服务「${key}」必须显式指定具体实体列表，禁止全量或模糊调用。`),
        { code: "ha_physical_security_blocked", status: 403 },
      );
    }
  }

  // Check every explicit entity target.
  for (const id of targets.entityIds) {
    const known = input.context?.entities.get(id);
    const dc = known?.deviceClass ?? (id === input.entityId ? input.deviceClass : undefined);
    if (isBlockedPhysicalEntity(id, dc)) {
      throw Object.assign(
        new Error(`物理安防红线：实体「${id}」属于高危安防设备，永久锁死为只读告警，不允许控制。`),
        { code: "ha_physical_security_blocked", status: 403 },
      );
    }
  }

  // Check area_id / device_id / label_id / floor_id expansion against registry (fail-closed when stale or unknown).
  const hasGroupTarget =
    targets.areaIds.length > 0 ||
    targets.deviceIds.length > 0 ||
    targets.labelIds.length > 0 ||
    targets.floorIds.length > 0;
  if (hasGroupTarget) {
    if (!input.context || input.context.stale) {
      throw Object.assign(
        new Error("物理安防红线：当前设备拓扑未同步或已过期，禁止按区域/设备组批量执行控制。"),
        { code: "ha_physical_security_blocked", status: 403 },
      );
    }
    if (targets.floorIds.length > 0) {
      throw Object.assign(
        new Error("物理安防红线：禁止按楼层全量下发控制，请指定具体房间或实体。"),
        { code: "ha_physical_security_blocked", status: 403 },
      );
    }
    const allEntities = [...input.context.entities.values()];
    for (const areaId of targets.areaIds) {
      const normalizedArea = areaId.trim().toLowerCase();
      if (GARAGE_GATE_PATTERN.test(normalizedArea)) {
        throw Object.assign(
          new Error(`物理安防红线：禁止对高危区域「${areaId}」执行批量控制。`),
          { code: "ha_physical_security_blocked", status: 403 },
        );
      }
      const matched = allEntities.filter(
        (e) => (e.areaId?.toLowerCase() === normalizedArea) || (e.area?.toLowerCase() === normalizedArea),
      );
      if (matched.length === 0) {
        throw Object.assign(
          new Error(`安全校验失败：未在已同步目录中找到区域「${areaId}」对应的设备。`),
          { code: "ha_physical_security_blocked", status: 403 },
        );
      }
      for (const entity of matched) {
        if (isBlockedPhysicalEntity(entity.entityId, entity.deviceClass)) {
          throw Object.assign(
            new Error(`物理安防红线：区域「${areaId}」包含高危安防实体「${entity.entityId}」，请改用具体非安防实体列表。`),
            { code: "ha_physical_security_blocked", status: 403 },
          );
        }
      }
    }
    for (const deviceId of targets.deviceIds) {
      const matched = allEntities.filter((e) => e.deviceId === deviceId);
      if (matched.length === 0) {
        throw Object.assign(
          new Error(`安全校验失败：未在已同步目录中找到设备「${deviceId}」。`),
          { code: "ha_physical_security_blocked", status: 403 },
        );
      }
      for (const entity of matched) {
        if (isBlockedPhysicalEntity(entity.entityId, entity.deviceClass)) {
          throw Object.assign(
            new Error(`物理安防红线：设备「${deviceId}」包含高危安防实体「${entity.entityId}」，不允许控制。`),
            { code: "ha_physical_security_blocked", status: 403 },
          );
        }
      }
    }
    for (const labelId of targets.labelIds) {
      const matched = allEntities.filter((e) => e.labels?.includes(labelId));
      if (matched.length === 0) {
        throw Object.assign(
          new Error(`安全校验失败：未在已同步目录中找到标签「${labelId}」对应的设备。`),
          { code: "ha_physical_security_blocked", status: 403 },
        );
      }
      for (const entity of matched) {
        if (isBlockedPhysicalEntity(entity.entityId, entity.deviceClass)) {
          throw Object.assign(
            new Error(`物理安防红线：标签「${labelId}」包含高危安防实体「${entity.entityId}」，不允许控制。`),
            { code: "ha_physical_security_blocked", status: 403 },
          );
        }
      }
    }
  }

  // Scene penetration: verify scene member entities when known; fail-closed if any member is blocked or unverified.
  if (domain === "scene" && service === "turn_on") {
    for (const sceneEntityId of targets.entityIds) {
      const sceneView = input.context?.entities.get(sceneEntityId);
      const memberIds = sceneView?.attributes?.entity_id;
      if (Array.isArray(memberIds)) {
        for (const memberId of memberIds) {
          const memberView = input.context?.entities.get(memberId);
          if (isBlockedPhysicalEntity(memberId, memberView?.deviceClass)) {
            throw Object.assign(
              new Error(`物理安防红线：场景「${sceneEntityId}」包含高危安防设备「${memberId}」，禁止执行。`),
              { code: "ha_physical_security_blocked", status: 403 },
            );
          }
        }
      }
    }
  }
}

/**
 * Deep async verification for indirect `script.*` invocations: fetches script config and runs the
 * exact same strict action-node whitelist validator recursively (Fail-Closed if config cannot be verified).
 */
export async function assertSafeHaServiceCallDeep(input: {
  domain: string;
  service: string;
  entityId?: string;
  deviceClass?: string;
  serviceData?: Record<string, unknown>;
  target?: Record<string, unknown>;
  triggerSource: "user_direct" | "user_confirmed_l2" | "external_untrusted";
  context?: HaSecurityLookupContext;
  visitedScripts?: Set<string>;
}): Promise<void> {
  assertSafeHaServiceCall(input);
  const domain = input.domain.trim().toLowerCase();
  const service = input.service.trim().toLowerCase();
  if (domain !== "script") return;

  const visited = input.visitedScripts ?? new Set<string>();
  const targets = extractHaTargets(input.entityId, input.serviceData, input.target);
  const slugs: string[] = [];
  if (service === "turn_on" || service === "toggle") {
    for (const entityId of targets.entityIds) {
      if (entityId.startsWith("script.")) slugs.push(entityId.slice("script.".length));
    }
  } else if (service !== "turn_off" && service !== "reload") {
    slugs.push(service);
  }
  if (slugs.length === 0) return;

  if (!input.context?.fetchScriptConfig) {
    throw Object.assign(
      new Error("物理安防红线：无法验证脚本内部动作安全性，拒绝间接执行 Home Assistant 脚本。"),
      { code: "ha_physical_security_blocked", status: 403 },
    );
  }
  for (const slug of slugs) {
    if (visited.has(slug)) continue;
    visited.add(slug);
    const scriptCfg = await input.context.fetchScriptConfig(slug);
    if (!scriptCfg) {
      throw Object.assign(
        new Error(`物理安防红线：无法读取脚本「script.${slug}」配置以确认安全性，已拒绝执行。`),
        { code: "ha_physical_security_blocked", status: 403 },
      );
    }
    const seq = scriptCfg.sequence ?? scriptCfg.actions ?? scriptCfg.action;
    if (!seq) {
      throw Object.assign(
        new Error(`物理安防红线：脚本「script.${slug}」缺少可审计的动作序列，已拒绝执行。`),
        { code: "ha_physical_security_blocked", status: 403 },
      );
    }
    await validateActionSequence(seq, {
      context: input.context,
      requireKnownEntities: false,
      visitedScripts: visited,
    });
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

async function validateActionNode(
  node: unknown,
  opts: {
    context: HaSecurityLookupContext;
    requireKnownEntities: boolean;
    visitedScripts: Set<string>;
    depth: number;
    summarizedActions?: string[];
  },
): Promise<void> {
  if (opts.depth > 8) {
    throw Object.assign(new Error("自动化动作嵌套层级过深（最多 8 层）。"), { code: "ha_invalid_automation", status: 400 });
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw Object.assign(new Error("自动化动作项格式无效。"), { code: "ha_invalid_automation", status: 400 });
  }
  const obj = node as Record<string, unknown>;

  // Hard reject HA Device Actions (lack explicit service/action string) and arbitrary event-bus firing.
  if (typeof obj.event === "string" || obj.event !== undefined) {
    throw Object.assign(
      new Error("安全红线：自动化禁止通过 event 总线间接触发未知规则。"),
      { code: "ha_physical_security_blocked", status: 403 },
    );
  }
  if (typeof obj.type === "string" && typeof obj.device_id === "string" && !obj.action && !obj.service) {
    throw Object.assign(
      new Error("安全红线：自动化请使用显式服务调用（action/service），不支持不透明的 Device Action。"),
      { code: "ha_physical_security_blocked", status: 403 },
    );
  }

  // Control flow allowlist: choose (BOTH sequence AND default!), if (then/else), repeat (sequence), parallel, sequence.
  if (obj.choose !== undefined) {
    const branches = asArray(obj.choose);
    for (const branch of branches) {
      if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
        throw Object.assign(new Error("choose 分支格式无效。"), { code: "ha_invalid_automation", status: 400 });
      }
      const b = branch as Record<string, unknown>;
      await validateActionSequence(b.sequence, { ...opts, depth: opts.depth + 1 });
    }
    if (obj.default !== undefined) {
      await validateActionSequence(obj.default, { ...opts, depth: opts.depth + 1 });
    }
    return;
  }

  if (obj.if !== undefined) {
    await validateActionSequence(obj.then, { ...opts, depth: opts.depth + 1 });
    if (obj.else !== undefined) {
      await validateActionSequence(obj.else, { ...opts, depth: opts.depth + 1 });
    }
    return;
  }

  if (obj.repeat !== undefined) {
    if (!obj.repeat || typeof obj.repeat !== "object" || Array.isArray(obj.repeat)) {
      throw Object.assign(new Error("repeat 动作格式无效。"), { code: "ha_invalid_automation", status: 400 });
    }
    const rep = obj.repeat as Record<string, unknown>;
    await validateActionSequence(rep.sequence, { ...opts, depth: opts.depth + 1 });
    return;
  }

  if (obj.parallel !== undefined) {
    await validateActionSequence(obj.parallel, { ...opts, depth: opts.depth + 1 });
    return;
  }

  if (obj.sequence !== undefined) {
    await validateActionSequence(obj.sequence, { ...opts, depth: opts.depth + 1 });
    return;
  }

  // Safe non-actuating flow primitives.
  if (
    obj.delay !== undefined ||
    obj.wait_template !== undefined ||
    obj.wait_for_trigger !== undefined ||
    obj.condition !== undefined ||
    obj.stop !== undefined ||
    obj.variables !== undefined
  ) {
    return;
  }

  // Explicit static service call (`action` in modern HA or legacy `service`).
  const rawCall = typeof obj.action === "string" ? obj.action : typeof obj.service === "string" ? obj.service : undefined;
  if (!rawCall) {
    throw Object.assign(
      new Error("自动化包含不支持或不可审计的动作类型，请改用标准服务调用。"),
      { code: "ha_invalid_automation", status: 400 },
    );
  }
  if (JINJA_TEMPLATE_RE.test(rawCall)) {
    throw Object.assign(
      new Error("物理安防红线：自动化服务名禁止包含 Jinja 模板表达式。"),
      { code: "ha_physical_security_blocked", status: 403 },
    );
  }
  const parts = rawCall.trim().toLowerCase().split(".");
  if (parts.length !== 2 || !DOMAIN_RE.test(parts[0]!) || !SERVICE_RE.test(parts[1]!)) {
    throw Object.assign(new Error(`自动化服务名「${rawCall}」格式无效。`), { code: "ha_invalid_automation", status: 400 });
  }
  const [domain, service] = parts as [string, string];
  const targetObj = obj.target && typeof obj.target === "object" && !Array.isArray(obj.target)
    ? (obj.target as Record<string, unknown>)
    : undefined;
  const dataObj = obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
    ? (obj.data as Record<string, unknown>)
    : obj.service_data && typeof obj.service_data === "object" && !Array.isArray(obj.service_data)
      ? (obj.service_data as Record<string, unknown>)
      : undefined;
  const topEntity = typeof obj.entity_id === "string" ? obj.entity_id : undefined;

  if (dataObj) sanitizeServiceData(dataObj);
  if (targetObj) sanitizeServiceData(targetObj);

  await assertSafeHaServiceCallDeep({
    domain,
    service,
    entityId: topEntity,
    serviceData: dataObj,
    target: targetObj,
    triggerSource: "user_confirmed_l2",
    context: opts.context,
    visitedScripts: opts.visitedScripts,
  });

  const targets = extractHaTargets(topEntity, dataObj, targetObj);
  if (opts.requireKnownEntities) {
    for (const entityId of targets.entityIds) {
      if (!ENTITY_ID_RE.test(entityId) || !opts.context.entities.has(entityId)) {
        throw Object.assign(
          new Error(`自动化引用的设备「${entityId}」不在当前已同步的 Home Assistant 目录中，请先核实实体名称。`),
          { code: "ha_unknown_entity", status: 400 },
        );
      }
    }
  }

  if (opts.summarizedActions) {
    const targetNames = targets.entityIds.map((id) => opts.context.entities.get(id)?.name ?? id);
    const label = targetNames.length > 0 ? `${targetNames.join("、")}（${humanServiceLabel(domain, service, dataObj)}）` : humanServiceLabel(domain, service, dataObj);
    opts.summarizedActions.push(label);
  }
}

async function validateActionSequence(
  seq: unknown,
  opts: {
    context: HaSecurityLookupContext;
    requireKnownEntities: boolean;
    visitedScripts: Set<string>;
    depth?: number;
    summarizedActions?: string[];
  },
): Promise<void> {
  const list = asArray(seq);
  if (list.length === 0) {
    throw Object.assign(new Error("自动化动作列表不能为空。"), { code: "ha_invalid_automation", status: 400 });
  }
  if (list.length > 32) {
    throw Object.assign(new Error("单个自动化动作数量超出上限（最多 32 步）。"), { code: "ha_invalid_automation", status: 400 });
  }
  for (const item of list) {
    await validateActionNode(item, { ...opts, depth: opts.depth ?? 0 });
  }
}

function humanServiceLabel(domain: string, service: string, data?: Record<string, unknown>): string {
  if (service === "turn_on") {
    if (typeof data?.brightness_pct === "number") return `打开并调至 ${data.brightness_pct}% 亮度`;
    return "打开";
  }
  if (service === "turn_off") return "关闭";
  if (service === "toggle") return "切换开关";
  if (domain === "climate" && service === "set_temperature" && typeof data?.temperature === "number") {
    return `调温至 ${data.temperature}℃`;
  }
  if (domain === "climate" && service === "set_hvac_mode" && typeof data?.hvac_mode === "string") {
    return `切换为 ${data.hvac_mode} 模式`;
  }
  if (domain === "cover" && service === "set_cover_position" && typeof data?.position === "number") {
    return `开合至 ${data.position}%`;
  }
  if (domain === "cover" && service === "open_cover") return "打开窗帘";
  if (domain === "cover" && service === "close_cover") return "关闭窗帘";
  if (domain === "scene") return "启用场景";
  return `${domain}.${service}`;
}

export interface ValidatedAutomationDraft {
  normalized: Record<string, unknown>;
  alias: string;
  humanSummary: string;
  targetSummary: string;
}

/**
 * Validates and normalizes an AI-proposed Home Assistant automation before creating an L2 card
 * AND again before executing `POST /api/config/automation/config/{configId}`.
 */
export async function validateHaAutomationDraft(
  rawDraft: Record<string, unknown>,
  context: HaSecurityLookupContext,
): Promise<ValidatedAutomationDraft> {
  if (!rawDraft || typeof rawDraft !== "object" || Array.isArray(rawDraft)) {
    throw Object.assign(new Error("自动化配置必须是 JSON 对象。"), { code: "ha_invalid_automation", status: 400 });
  }
  if (context.stale) {
    throw Object.assign(
      new Error("Home Assistant 当前未同步最新设备状态，请等待重连后再配置自动化。"),
      { code: "ha_stale_state", status: 503 },
    );
  }
  const alias = typeof rawDraft.alias === "string" ? rawDraft.alias.trim() : "";
  if (!alias || alias.length > 120) {
    throw Object.assign(new Error("自动化必须提供 1–120 字的中文名称（alias）。"), { code: "ha_invalid_automation", status: 400 });
  }
  const rawMode = typeof rawDraft.mode === "string" ? rawDraft.mode.trim().toLowerCase() : "single";
  if (!["single", "restart", "queued", "parallel"].includes(rawMode)) {
    throw Object.assign(new Error("自动化运行模式 mode 仅支持 single / restart / queued / parallel。"), { code: "ha_invalid_automation", status: 400 });
  }

  const triggers = asArray(rawDraft.triggers ?? rawDraft.trigger);
  if (triggers.length === 0 || triggers.length > 16) {
    throw Object.assign(new Error("自动化必须包含 1–16 个触发条件。"), { code: "ha_invalid_automation", status: 400 });
  }

  const triggerLabels: string[] = [];
  for (const item of triggers) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw Object.assign(new Error("触发条件格式无效。"), { code: "ha_invalid_automation", status: 400 });
    }
    const trig = item as Record<string, unknown>;
    const trigEntities = normalizeStringList(trig.entity_id);
    for (const eid of trigEntities) {
      if (!ENTITY_ID_RE.test(eid) || !context.entities.has(eid)) {
        throw Object.assign(
          new Error(`触发条件引用的设备「${eid}」不在当前 Home Assistant 目录中。`),
          { code: "ha_unknown_entity", status: 400 },
        );
      }
      const view = context.entities.get(eid)!;
      // Modern HA `event.*` entities store an ISO timestamp in main `state`, NOT the button press name!
      if (view.domain === "event" && typeof trig.to === "string" && trig.to.trim() && !trig.attribute) {
        const eventTypes = Array.isArray(view.attributes?.event_types) ? view.attributes!.event_types : [];
        const hint = eventTypes.length > 0 ? `（支持按键类型：${eventTypes.join(" / ")}）` : "";
        throw Object.assign(
          new Error(
            `无线开关/事件实体「${view.name}」的主状态是时间戳，不能写 to: "${trig.to}"；请监听该实体状态变化并匹配 attribute: "event_type"${hint}。`,
          ),
          { code: "ha_invalid_event_trigger", status: 400 },
        );
      }
      if (view.domain === "event" && trig.attribute === "event_type" && typeof trig.to === "string") {
        const eventTypes = Array.isArray(view.attributes?.event_types) ? view.attributes!.event_types : [];
        if (eventTypes.length > 0 && !eventTypes.includes(trig.to)) {
          throw Object.assign(
            new Error(`实体「${view.name}」不支持按键事件「${trig.to}」，仅支持：${eventTypes.join("、")}。`),
            { code: "ha_invalid_event_trigger", status: 400 },
          );
        }
      }
      triggerLabels.push(view.name);
    }
    if (trigEntities.length === 0) {
      const trigKind = String(trig.trigger ?? trig.platform ?? "条件");
      if (trigKind === "time" && typeof trig.at === "string") triggerLabels.push(`每天 ${trig.at}`);
      else triggerLabels.push(trigKind);
    }
  }

  const rawActions = rawDraft.actions ?? rawDraft.action;
  const summarizedActions: string[] = [];
  await validateActionSequence(rawActions, {
    context,
    requireKnownEntities: true,
    visitedScripts: new Set<string>(),
    summarizedActions,
  });

  const conditions = rawDraft.conditions ?? rawDraft.condition;
  const baseDescription = typeof rawDraft.description === "string" ? rawDraft.description.trim().slice(0, 300) : "";
  const description = baseDescription.includes("[Kulo]") ? baseDescription : `${baseDescription ? `${baseDescription} ` : ""}[Kulo]`;

  const normalized: Record<string, unknown> = {
    alias,
    description,
    triggers,
    ...(conditions !== undefined ? { conditions: asArray(conditions) } : { conditions: [] }),
    actions: asArray(rawActions),
    mode: rawMode,
  };

  const triggerText = triggerLabels.length > 0 ? [...new Set(triggerLabels)].slice(0, 3).join("、") : "触发条件满足时";
  const actionText = summarizedActions.length > 0 ? summarizedActions.slice(0, 3).join("；") : "执行家居动作";
  return {
    normalized,
    alias,
    humanSummary: `当 ${triggerText} 触发时 → ${actionText}`,
    targetSummary: alias,
  };
}
