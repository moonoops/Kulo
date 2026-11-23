import {
  ANDROID_ACTIONS,
  ANDROID_TOOL_CATALOG,
  type AndroidAction,
  type AndroidJsonSchema,
} from "./android.js";

export interface AndroidRequest {
  version: 1;
  hubId: string;
  deviceId: string;
  ticketId: string;
  conversationId: number;
  runEpoch: number;
  operationId: string;
  action: AndroidAction;
  args: Record<string, unknown>;
  deadline: number;
}

export interface AndroidResult {
  version: 1;
  operationId: string;
  ticketId: string;
  runEpoch: number;
  action: AndroidAction;
  status: "running" | "completed" | "failed" | "cancelled" | "unknown";
  data?: unknown;
  error?: { code: string; message: string };
}

export interface AndroidEnvStatus {
  version: 1;
  catalogVersion: 3;
  enabled: boolean;
  paused: boolean;
  revision: number;
  grants: string[];
  capabilities: Array<{ action: AndroidAction; available: boolean; reason?: string }>;
  active?: { ticketId: string; runEpoch: number; operationId: string; action: AndroidAction; state: string };
  resources?: Array<{ ticketId: string; kind: string; id: string; state: string }>;
}

export interface AndroidCancel {
  version: 1;
  controlId: string;
  ticketId: string;
  runEpoch: number;
  reason: string;
}

export interface AndroidControlResult {
  version: 1;
  controlId: string;
  ticketId: string;
  runEpoch: number;
  quiescent: boolean;
  epochQuiescent?: boolean;
  resourcesRetained?: boolean;
  error?: string;
}

export const ANDROID_MAX_RESULT = 1024 * 1024;
export const ANDROID_MAX_REQUEST = 128 * 1024;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const actionSet = new Set<string>(ANDROID_ACTIONS);
const toolByAction = new Map(ANDROID_TOOL_CATALOG.map((tool) => [tool.action, tool]));

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function only(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function id(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && !value.includes("\0");
}

function boundedJson(value: unknown, limit: number): boolean {
  const ancestors = new Set<object>();
  let size = 0, nodes = 0;
  const walk = (item: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 24 || size > limit) return false;
    if (item === null || typeof item === "boolean") { size += 5; return true; }
    if (typeof item === "number") { size += 24; return Number.isFinite(item); }
    if (typeof item === "string") { size += item.length; return size <= limit; }
    if (typeof item !== "object" || !item || ancestors.has(item)) return false;
    if (!Array.isArray(item) && !object(item)) return false;
    ancestors.add(item);
    const valid = Array.isArray(item)
      ? item.length <= 4096 && item.every((entry) => walk(entry, depth + 1))
      : Object.entries(item).every(([key, entry]) => { size += key.length; return walk(entry, depth + 1); });
    ancestors.delete(item);
    return valid;
  };
  try {
    return walk(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= limit;
  } catch { return false; }
}

function matches(schema: AndroidJsonSchema, value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (!schema.type && !schema.anyOf) return boundedJson(value, ANDROID_MAX_REQUEST);
  if (schema.anyOf) return schema.anyOf.some((branch) => matches(branch, value, depth + 1));
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "string": return typeof value === "string" && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? 32_000) && !value.includes("\0");
    case "boolean": return typeof value === "boolean";
    case "integer":
    case "number": return typeof value === "number" && Number.isFinite(value) &&
      (schema.type !== "integer" || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    case "array": return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? 1000) &&
      !!schema.items && value.every((entry) => matches(schema.items!, entry, depth + 1));
    case "object": {
      if (!object(value)) return false;
      const properties = schema.properties ?? {};
      return Object.keys(value).length <= (schema.maxProperties ?? 256) &&
        (schema.required ?? []).every((key) => Object.hasOwn(value, key)) &&
        Object.keys(value).every((key) => Object.hasOwn(properties, key) ? matches(properties[key]!, value[key], depth + 1)
          : typeof schema.additionalProperties === "object" && matches(schema.additionalProperties, value[key], depth + 1));
    }
  }
  return false;
}

export function isAndroidAction(value: unknown): value is AndroidAction {
  return typeof value === "string" && actionSet.has(value);
}

export function isAndroidArgs(action: AndroidAction, value: unknown): value is Record<string, unknown> {
  const tool = toolByAction.get(action);
  return !!tool && boundedJson(value, ANDROID_MAX_REQUEST) && matches(tool.parameters, value);
}

export interface AndroidOperationPolicy {
  permissions: readonly string[];
  mutating: boolean;
  screen: boolean;
  cleanup: boolean;
  localStatus: boolean;
}

/** Operation-level policy never expands the task's allowed tools, targets, or the phone's local grants. */
export function androidOperationPolicy(action: AndroidAction, args: Record<string, unknown>): AndroidOperationPolicy {
  const tool = toolByAction.get(action);
  if (!tool || !isAndroidArgs(action, args)) throw new Error("Invalid Android operation arguments");
  let operation = typeof args[tool.permissionSelector ?? "operation"] === "string"
    ? String(args[tool.permissionSelector ?? "operation"]) : tool.defaultOperation ?? "";
  if (action === "process_memory" && operation === "open") operation = args.mode === "read_write" ? "open_read_write" : "open_read_only";
  const permissions = new Set(tool.operationPermissions?.[operation] ?? tool.permissions);
  if (tool.booleanPermissions) {
    for (const [flag, extra] of Object.entries(tool.booleanPermissions)) {
      if (args[flag] === true) for (const permission of extra) permissions.add(permission);
    }
  }
  if (action === "sensor" && args.operation !== "list") {
    if ([18, 19].includes(Number(args.sensorType))) permissions.add("sensorsActivity");
    if ([21, 31].includes(Number(args.sensorType))) permissions.add("sensorsBody");
  }
  if (["sensor", "location", "infrared", "bluetooth", "wifi", "cellular", "network_probe", "nfc", "nfc_emulation", "device_shortcut"].includes(action) && typeof args.dataRef === "string") permissions.add("deviceDataRead");
  if (action === "device_shortcut" && args.operation === "create") {
    const targetPermission = { infrared: "infrared", nfc_emulation: "nfcEmulation", device_data: "deviceDataRead" }[String(args.target)];
    if (targetPermission) permissions.add(targetPermission);
  }
  return {
    permissions: [...permissions],
    mutating: tool.mutating && !tool.readOnlyOperations?.includes(operation),
    screen: tool.screen,
    cleanup: Boolean(tool.cleanup || tool.cleanupOperations?.includes(operation)),
    localStatus: Boolean(tool.localStatus || tool.localStatusOperations?.includes(operation)),
  };
}

export function isAndroidRequest(value: unknown): value is AndroidRequest {
  if (!object(value) || !only(value, ["version", "hubId", "deviceId", "ticketId", "conversationId", "runEpoch", "operationId", "action", "args", "deadline"])) return false;
  return value.version === 1 && id(value.hubId) && id(value.deviceId) && id(value.ticketId) &&
    integer(value.conversationId) && integer(value.runEpoch) && id(value.operationId) &&
    integer(value.deadline) && value.deadline > 0 && isAndroidAction(value.action) && isAndroidArgs(value.action, value.args) &&
    boundedJson(value, ANDROID_MAX_REQUEST);
}

function error(value: unknown): value is AndroidResult["error"] {
  return object(value) && only(value, ["code", "message"]) && id(value.code) && text(value.message, 2000);
}

export function isAndroidResult(value: unknown, request: AndroidRequest): value is AndroidResult {
  if (!object(value) || !only(value, ["version", "operationId", "ticketId", "runEpoch", "action", "status", "data", "error"]) || !boundedJson(value, ANDROID_MAX_RESULT)) return false;
  if (value.version !== 1 || value.operationId !== request.operationId || value.ticketId !== request.ticketId || value.runEpoch !== request.runEpoch || value.action !== request.action ||
    !["running", "completed", "failed", "cancelled", "unknown"].includes(String(value.status))) return false;
  if (value.error !== undefined && !error(value.error)) return false;
  if (["running", "completed"].includes(String(value.status)) && value.error !== undefined) return false;
  return value.status !== "failed" || value.error !== undefined;
}

export function isAndroidEnvStatus(value: unknown): value is AndroidEnvStatus {
  if (!object(value) || !only(value, ["version", "catalogVersion", "enabled", "paused", "revision", "grants", "capabilities", "active", "resources"]) || !boundedJson(value, ANDROID_MAX_RESULT)) return false;
  if (value.version !== 1 || value.catalogVersion !== 3 || typeof value.catalogVersion !== "number" || typeof value.enabled !== "boolean" || typeof value.paused !== "boolean" || !integer(value.revision) ||
    !Array.isArray(value.grants) || value.grants.length > 64 || !value.grants.every((grant) => typeof grant === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(grant)) || new Set(value.grants).size !== value.grants.length ||
    !Array.isArray(value.capabilities) || value.capabilities.length > ANDROID_ACTIONS.length) return false;
  const actions = new Set<string>();
  for (const item of value.capabilities) {
    if (!object(item) || !only(item, ["action", "available", "reason"]) || !isAndroidAction(item.action) || typeof item.available !== "boolean" ||
      (item.reason !== undefined && !text(item.reason, 2000)) || actions.has(item.action)) return false;
    actions.add(item.action);
  }
  if (value.resources !== undefined && (!Array.isArray(value.resources) || value.resources.length > 64 || value.resources.some(item =>
    !object(item) || !only(item, ["ticketId", "kind", "id", "state"]) || !id(item.ticketId) || !id(item.id) || !id(item.kind) ||
    !text(item.state, 64) || !item.state.length))) return false;
  const active = value.active;
  return active === undefined || object(active) && only(active, ["ticketId", "runEpoch", "operationId", "action", "state"]) &&
    id(active.ticketId) && integer(active.runEpoch) && id(active.operationId) && isAndroidAction(active.action) && text(active.state, 64) && active.state.length > 0;
}

export function isAndroidCancel(value: unknown): value is AndroidCancel {
  return object(value) && only(value, ["version", "controlId", "ticketId", "runEpoch", "reason"]) &&
    value.version === 1 && id(value.controlId) && id(value.ticketId) && integer(value.runEpoch) && text(value.reason, 2000) && boundedJson(value, ANDROID_MAX_REQUEST);
}

export function isAndroidControlResult(value: unknown): value is AndroidControlResult {
  return object(value) && only(value, ["version", "controlId", "ticketId", "runEpoch", "quiescent", "epochQuiescent", "resourcesRetained", "error"]) &&
    value.version === 1 && id(value.controlId) && id(value.ticketId) && integer(value.runEpoch) && typeof value.quiescent === "boolean" &&
    (value.epochQuiescent === undefined || typeof value.epochQuiescent === "boolean") &&
    (value.resourcesRetained === undefined || typeof value.resourcesRetained === "boolean") &&
    (value.resourcesRetained !== true || value.epochQuiescent === true && value.quiescent === false) &&
    (value.error === undefined || text(value.error, 2000)) && boundedJson(value, ANDROID_MAX_REQUEST);
}
