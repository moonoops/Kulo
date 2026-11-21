import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import type {
  HomeAssistantAnnounceConfig,
  HomeAssistantAttributeValue,
  HomeAssistantEntityView,
  HomeAssistantMigrationAdvice,
  HomeAssistantSentinelConfig,
  HomeAssistantSnapshot,
  RawConnectorEvent,
} from "@kulo/protocol";
import type { AssistantLedger } from "../assistant-ledger.js";
import type { LocalConnectionVault } from "../connection-vault.js";
import { buildAugmentedHostPath, findHostExecutable } from "../host-path.js";
import {
  assertSafeHaServiceCall,
  assertSafeHaServiceCallDeep,
  isBlockedPhysicalEntity,
  sanitizeServiceData,
  validateHaAutomationDraft,
  type ValidatedAutomationDraft,
} from "./ha-automation.js";
import { HaLanAudioRelay, selectPhysicalLanIpv4 } from "./ha-lan-audio.js";
import {
  DEFAULT_HA_SENTINEL_CONFIG,
  HomeAssistantSentinel,
  normalizeHaSentinelConfig,
} from "./ha-sentinel.js";

export {
  assertSafeHaServiceCall,
  assertSafeHaServiceCallDeep,
  isBlockedPhysicalEntity,
  sanitizeServiceData,
  validateHaAutomationDraft,
};

const HA_VAULT_KEY = "kulo-home-assistant-token";
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;
const STALE_AFTER_MS = 60_000;
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".kulo-homeassistant");
const XIAOMI_HOME_TARBALL_URL = "https://github.com/XiaoMi/ha_xiaomi_home/archive/refs/heads/main.tar.gz";
const MAX_ANNOUNCE_CHARS = 160;
const ANNOUNCE_PER_MIN_CAP = 2;
const ANNOUNCE_SITUATION_COOLDOWN_MS = 5 * 60_000;

export const DEFAULT_HA_ANNOUNCE_CONFIG: HomeAssistantAnnounceConfig = {
  enabled: true,
  useKuloVoiceTts: true,
  onlyWhenHome: true,
  overrideQuietForCritical: true,
  quietHours: { start: "23:00", end: "08:00" },
  minUrgency: "high",
};

export function normalizeHaAnnounceConfig(raw?: Partial<HomeAssistantAnnounceConfig>): HomeAssistantAnnounceConfig {
  const hhmm = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const quietHours =
    raw?.quietHours && hhmm.test(raw.quietHours.start) && hhmm.test(raw.quietHours.end)
      ? { start: raw.quietHours.start, end: raw.quietHours.end }
      : raw?.quietHours === undefined
        ? DEFAULT_HA_ANNOUNCE_CONFIG.quietHours
        : undefined;
  return {
    enabled: raw?.enabled !== false,
    ...(typeof raw?.defaultSpeakerEntityId === "string" && raw.defaultSpeakerEntityId.includes(".")
      ? { defaultSpeakerEntityId: raw.defaultSpeakerEntityId.trim() }
      : {}),
    useKuloVoiceTts: raw?.useKuloVoiceTts !== false,
    onlyWhenHome: raw?.onlyWhenHome !== false,
    overrideQuietForCritical: raw?.overrideQuietForCritical !== false,
    ...(quietHours ? { quietHours } : {}),
    minUrgency: raw?.minUrgency === "normal" ? "normal" : "high",
  };
}

const ACTIONABLE_DOMAINS = new Set<string>([
  "light",
  "switch",
  "climate",
  "cover",
  "fan",
  "vacuum",
  "media_player",
  "scene",
  "script",
  "humidifier",
  "water_heater",
  "lock",
  "alarm_control_panel",
]);

const READONLY_CONTEXT_DOMAINS = new Set<string>([
  "person",
  "zone",
  "camera",
  "automation",
]);

const EVENT_ALLOWED_CLASSES = new Set<string>(["button", "doorbell", "motion"]);

const SPEAKER_TEXT_PATTERN = /(?:play_text|execute_text_directive|intelligent_speaker|xiaoai|小爱.*播报|播放文本|语音播报)/i;

const CURATED_SENSOR_CLASSES = new Set<string>([
  "temperature",
  "humidity",
  "illuminance",
  "pm25",
  "pm10",
  "co2",
  "aqi",
  "power",
  "energy",
  "battery",
  "door",
  "window",
  "garage_door",
  "motion",
  "occupancy",
  "presence",
  "moisture",
  "smoke",
  "gas",
  "problem",
  "safety",
  "opening",
]);

const NOISE_ENTITY_PATTERNS = [
  /_(?:rssi|signal_strength|linkquality|lqi|firmware|sw_version|hw_version|ip_address|mac_address|ssid|bssid|uptime|restart|reboot|identify)$/i,
  /_(?:indicator_light|led_indicator|buzzer|beep|child_lock_status|motor_reverse|fault_code|diagnostic|last_seen|action|click|event)$/i,
  /^sensor\..*_(?:action|button|click|gesture|battery_voltage|chip_temperature|wifi_signal)$/i,
];

const ATTRIBUTE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  climate: ["hvac_modes", "current_temperature", "temperature", "min_temp", "max_temp", "fan_mode", "fan_modes"],
  light: ["brightness", "color_temp_kelvin", "supported_color_modes"],
  cover: ["current_position", "current_tilt_position"],
  fan: ["percentage", "preset_mode", "preset_modes"],
  media_player: ["volume_level", "is_volume_muted", "source", "supported_features"],
  event: ["event_type", "event_types"],
  scene: ["entity_id"],
  person: ["source", "gps_accuracy"],
  automation: ["id", "last_triggered", "mode"],
  text: ["min", "max", "mode"],
};

export interface HomeAssistantPersistedConfig {
  enabled: boolean;
  baseUrl?: string;
  sentinel?: HomeAssistantSentinelConfig;
  announce?: HomeAssistantAnnounceConfig;
}

export interface HomeAssistantServiceHost {
  vault?: LocalConnectionVault;
  ledger?: AssistantLedger;
  stateDir?: string;
  lanAudioRelay?: HaLanAudioRelay;
  persistedConfig(): Promise<HomeAssistantPersistedConfig>;
  saveConfig(next: HomeAssistantPersistedConfig): Promise<void>;
  redact(text: string): string;
  onAlertEvent?: (event: RawConnectorEvent) => void;
  onSituationResolved?: (situationKey: string) => void;
  synthesizeTts?: (text: string) => Promise<{ bytes: Buffer; mimeType: "audio/mpeg" | "audio/wav" } | undefined>;
  lanHttpEndpoint?: () => { lanReachable: boolean; port: number } | undefined;
  completeVisionJson?: (input: {
    systemPrompt: string;
    userText: string;
    imageBase64: string;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
    signal?: AbortSignal;
  }) => Promise<string>;
  commandRunner?: (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** Injectable DNS resolver for testing DNS rebinding guards. */
  dnsLookup?: (hostname: string) => Promise<{ address: string; family: number }>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  sentinelOptions?: { warmupMs?: number; sweepIntervalMs?: number; offlineAggregateWindowMs?: number };
}

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((segment) => Number(segment));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale / CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("::ffff:")) return isPrivateIpv4(lower.slice(7));
  return false;
}

export function isPrivateIpAddress(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, "");
  const version = net.isIP(clean);
  if (version === 4) return isPrivateIpv4(clean);
  if (version === 6) return isPrivateIpv6(clean);
  return false;
}

/**
 * Strictly enforces LAN/loopback/Tailscale-only destinations for Home Assistant so credentials
 * and physical home controls can never be exfiltrated to public internet hosts.
 */
export function validateLanHaUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw Object.assign(new Error("Home Assistant 地址格式无效，示例：http://127.0.0.1:8123"), { code: "ha_invalid_url", status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw Object.assign(new Error("Home Assistant 地址必须使用 http 或 https 协议"), { code: "ha_invalid_protocol", status: 400 });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error("Home Assistant 地址不能包含内嵌凭据或查询参数"), { code: "ha_invalid_url", status: 400 });
  }
  const host = parsed.hostname.toLowerCase();
  const ipVersion = net.isIP(host.replace(/^\[|\]$/g, ""));
  const allowed =
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".ts.net") ||
    (ipVersion === 4 && isPrivateIpv4(host)) ||
    (ipVersion === 6 && isPrivateIpv6(host));

  if (!allowed) {
    throw Object.assign(
      new Error("出于家庭安全限制，Home Assistant 仅允许连接本机、局域网（RFC1918 / .local）或 Tailscale 私有地址。"),
      { code: "ha_non_lan_url_blocked", status: 400 },
    );
  }
  return parsed;
}

/**
 * DNS rebinding guard: verifies resolved IP addresses for `.local`/`.lan`/`.ts.net`/`localhost`
 * still belong to loopback, RFC1918, or Tailscale private ranges before opening any TCP socket.
 */
export async function resolveAndVerifyLanHost(
  hostname: string,
  customLookup?: (host: string) => Promise<{ address: string; family: number }>,
): Promise<{ address: string; family: number }> {
  const clean = hostname.replace(/^\[|\]$/g, "");
  const literalVersion = net.isIP(clean);
  if (literalVersion === 4 || literalVersion === 6) {
    if (!isPrivateIpAddress(clean)) {
      throw Object.assign(
        new Error("出于家庭安全限制，Home Assistant 目标 IP 不属于私有局域网范围。"),
        { code: "ha_dns_rebinding_blocked", status: 403 },
      );
    }
    return { address: clean, family: literalVersion };
  }
  const resolved = customLookup
    ? await customLookup(clean)
    : await dns.promises.lookup(clean, { verbatim: true });
  if (!isPrivateIpAddress(resolved.address)) {
    throw Object.assign(
      new Error(`DNS 安全拦截：域名「${clean}」解析到了公网地址，已阻止向其发送 Home Assistant 令牌。`),
      { code: "ha_dns_rebinding_blocked", status: 403 },
    );
  }
  return resolved;
}

export interface RawHaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
}

export interface HaRegistryMetadata {
  areas: Map<string, string>; // area_id -> area_name
  devices: Map<string, { areaId?: string; name?: string }>; // device_id -> info
  entities: Map<string, { areaId?: string; deviceId?: string; labels?: string[]; disabledBy?: string | null }>;
}

function pickEntityAttributes(domain: string, attrs: Record<string, unknown>): Record<string, HomeAssistantAttributeValue> | undefined {
  const keys = ATTRIBUTE_ALLOWLIST[domain];
  if (!keys) return undefined;
  const out: Record<string, HomeAssistantAttributeValue> = {};
  for (const key of keys) {
    const val = attrs[key];
    if (typeof val === "string") out[key] = val.slice(0, 120);
    else if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
    else if (typeof val === "boolean") out[key] = val;
    else if (Array.isArray(val)) {
      const strs = val.filter((item): item is string => typeof item === "string").map((s) => s.slice(0, 120)).slice(0, 32);
      if (strs.length > 0) out[key] = strs;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Automatically filters hundreds of noisy diagnostic/config/firmware/button entities commonly
 * produced by Xiaomi Home (`ha_xiaomi_home`) into a clean curated home entity catalog,
 * enriched with real Area / Device / Entity registry topology when available.
 */
export function curateHomeAssistantEntities(
  rawStates: readonly RawHaState[],
  registry?: HaRegistryMetadata,
): {
  entities: HomeAssistantEntityView[];
  totalCount: number;
  filteredNoiseCount: number;
} {
  const entities: HomeAssistantEntityView[] = [];
  for (const row of rawStates) {
    if (!row || typeof row.entity_id !== "string" || !row.entity_id.includes(".")) continue;
    const entityId = row.entity_id.trim();
    const domain = entityId.split(".")[0]!.toLowerCase();
    const attrs = row.attributes ?? {};
    const regEntry = registry?.entities.get(entityId);
    if (regEntry?.disabledBy) continue;

    const entityCategory = typeof attrs.entity_category === "string" ? attrs.entity_category.toLowerCase() : "";
    if (entityCategory === "diagnostic" || entityCategory === "config") continue;
    if (NOISE_ENTITY_PATTERNS.some((pattern) => pattern.test(entityId))) continue;
    if (domain === "update" || domain === "button" || domain === "sun") continue;

    const deviceClass = typeof attrs.device_class === "string" ? attrs.device_class.toLowerCase() : undefined;
    const friendlyName = typeof attrs.friendly_name === "string" && attrs.friendly_name.trim()
      ? attrs.friendly_name.trim().slice(0, 120)
      : entityId;

    if (domain === "sensor" || domain === "binary_sensor") {
      if (!deviceClass || !CURATED_SENSOR_CLASSES.has(deviceClass)) continue;
    } else if (domain === "event") {
      const hasEventTypes = Array.isArray(attrs.event_types) && attrs.event_types.length > 0;
      if (!hasEventTypes && (!deviceClass || !EVENT_ALLOWED_CLASSES.has(deviceClass))) continue;
    } else if (domain === "text") {
      // Only preserve speaker TTS / play-text entities (e.g. Xiaomi Home XiaoAI speaker text input).
      if (!SPEAKER_TEXT_PATTERN.test(entityId) && !SPEAKER_TEXT_PATTERN.test(friendlyName)) continue;
    } else if (!ACTIONABLE_DOMAINS.has(domain) && !READONLY_CONTEXT_DOMAINS.has(domain)) {
      continue;
    }

    const deviceId = regEntry?.deviceId;
    const areaId = regEntry?.areaId ?? (deviceId ? registry?.devices.get(deviceId)?.areaId : undefined);
    const areaFromRegistry = areaId ? registry?.areas.get(areaId) : undefined;
    const area = areaFromRegistry?.trim().slice(0, 80)
      || (typeof attrs.area_name === "string" && attrs.area_name.trim() ? attrs.area_name.trim().slice(0, 80) : undefined);
    const labels = regEntry?.labels && regEntry.labels.length > 0 ? regEntry.labels.slice(0, 8) : undefined;
    const unit = typeof attrs.unit_of_measurement === "string" && attrs.unit_of_measurement.trim() ? attrs.unit_of_measurement.trim().slice(0, 24) : undefined;
    const readOnlySecurity = isBlockedPhysicalEntity(entityId, deviceClass);
    const readOnlyContext = READONLY_CONTEXT_DOMAINS.has(domain) || domain === "event";
    const configId = domain === "automation" && typeof attrs.id === "string" && attrs.id.trim() ? attrs.id.trim().slice(0, 120) : undefined;
    const editable = domain === "automation" ? Boolean(configId) : undefined;
    const pickedAttributes = pickEntityAttributes(domain, attrs);

    entities.push({
      entityId,
      domain,
      name: friendlyName,
      state: String(row.state ?? "unknown").slice(0, 80),
      ...(area ? { area } : {}),
      ...(areaId ? { areaId } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(labels ? { labels } : {}),
      ...(deviceClass ? { deviceClass } : {}),
      ...(unit ? { unit } : {}),
      ...(readOnlySecurity ? { readOnlySecurity: true } : {}),
      ...(readOnlyContext ? { readOnlyContext: true } : {}),
      ...(configId ? { configId } : {}),
      ...(editable !== undefined ? { editable } : {}),
      ...(pickedAttributes ? { attributes: pickedAttributes } : {}),
      ...(typeof row.last_changed === "string" ? { lastChanged: row.last_changed } : {}),
    });
  }

  entities.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
  return {
    entities,
    totalCount: rawStates.length,
    filteredNoiseCount: Math.max(0, rawStates.length - entities.length),
  };
}

function sniffImageMime(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

async function directLanRequestRaw(
  baseUrl: URL,
  reqPath: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    token?: string;
    body?: unknown;
    accept?: string;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
    dnsLookup?: (hostname: string) => Promise<{ address: string; family: number }>;
  } = {},
): Promise<{ status: number; buffer: Buffer }> {
  const resolved = await resolveAndVerifyLanHost(baseUrl.hostname, options.dnsLookup);
  return new Promise((resolve, reject) => {
    const isHttps = baseUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const payload = options.body !== undefined ? Buffer.from(JSON.stringify(options.body), "utf8") : undefined;
    const maxBytes = options.maxBytes ?? MAX_HTTP_BYTES;
    const req = transport.request(
      {
        hostname: baseUrl.hostname,
        port: baseUrl.port ? Number(baseUrl.port) : isHttps ? 443 : 80,
        path: `${baseUrl.pathname.replace(/\/$/, "")}${reqPath}`,
        method: options.method ?? "GET",
        lookup: ((_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
          cb(null, resolved.address, resolved.family);
        }) as http.RequestOptions["lookup"],
        headers: {
          accept: options.accept ?? "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}),
        },
        timeout: options.timeoutMs ?? 10_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(Object.assign(new Error("Home Assistant 接口禁止重定向以防止跨网段跳转。"), { code: "ha_redirect_blocked" }));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy(new Error("ha_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, buffer: Buffer.concat(chunks) }));
      },
    );
    const onAbort = () => req.destroy(new Error("ha_request_aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => req.destroy(new Error("Home Assistant 连接超时")));
    req.on("error", (err) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    req.on("close", () => {
      options.signal?.removeEventListener("abort", onAbort);
    });
    if (payload) req.end(payload);
    else req.end();
  });
}

async function directLanRequest(
  baseUrl: URL,
  reqPath: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    token?: string;
    body?: unknown;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
    dnsLookup?: (hostname: string) => Promise<{ address: string; family: number }>;
  } = {},
): Promise<{ status: number; body: string }> {
  const res = await directLanRequestRaw(baseUrl, reqPath, options);
  return { status: res.status, body: res.buffer.toString("utf8") };
}

function findBinary(name: string): string | undefined {
  return findHostExecutable(name, { extraDirs: [path.join(os.homedir(), ".orbstack/bin")] });
}

function probePort8123(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: 8123, timeout: 600 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function defaultRunCommand(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: {
        PATH: buildAugmentedHostPath({ extraDirs: [path.join(os.homedir(), ".orbstack/bin")] }),
        HOME: os.homedir(),
        TMPDIR: os.tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { if (out.length < 64) out.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { if (err.length < 64) err.push(chunk); });
    child.once("error", (e) => { clearTimeout(timer); resolve({ ok: false, stdout: "", stderr: e.message }); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

function sanitizeAnnounceText(raw: string, redact: (text: string) => string): string {
  const cleaned = redact(raw)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[*_~#>|[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_ANNOUNCE_CHARS);
}

function isWithinQuietHours(nowTs: number, quietHours?: { start: string; end: string }): boolean {
  if (!quietHours) return false;
  const parseMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const start = parseMinutes(quietHours.start);
  const end = parseMinutes(quietHours.end);
  const dt = new Date(nowTs);
  const cur = dt.getHours() * 60 + dt.getMinutes();
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

interface PendingWsRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class HomeAssistantService {
  readonly #host: HomeAssistantServiceHost;
  readonly #sentinel: HomeAssistantSentinel | null;
  readonly #registry: HaRegistryMetadata = {
    areas: new Map(),
    devices: new Map(),
    entities: new Map(),
  };
  #entities = new Map<string, HomeAssistantEntityView>();
  #totalEntities = 0;
  #filteredNoiseCount = 0;
  #mcpSupported = false;
  #ws: WebSocket | null = null;
  #wsConnected = false;
  #wsDisconnectedAt: number | undefined;
  #wsNextId = 1;
  readonly #wsPending = new Map<number, PendingWsRequest>();
  #reconnectTimer: NodeJS.Timeout | null = null;
  #lastSyncAt: number | undefined;
  #lastError: string | undefined;
  readonly #announceTimestamps: number[] = [];
  readonly #announceBySituation = new Map<string, number>();
  #closed = false;

  constructor(host: HomeAssistantServiceHost) {
    this.#host = host;
    this.#sentinel = host.stateDir
      ? new HomeAssistantSentinel({
          stateDir: host.stateDir,
          ledger: host.ledger,
          getConfig: async () => normalizeHaSentinelConfig((await this.#host.persistedConfig()).sentinel),
          listEntities: () => [...this.#entities.values()],
          isStale: () => this.isStale(),
          isWsConnected: () => this.#wsConnected,
          fetchCameraSnapshot: (cameraEntityId, signal) => this.fetchCameraSnapshot(cameraEntityId, signal),
          completeVisionJson: host.completeVisionJson,
          onEvent: (event) => host.onAlertEvent?.(event),
          onSituationResolved: (key) => host.onSituationResolved?.(key),
          now: host.now,
          ...(host.sentinelOptions ?? {}),
        })
      : null;
  }

  get sentinel(): HomeAssistantSentinel | null {
    return this.#sentinel;
  }

  #now(): number {
    return this.#host.now?.() ?? Date.now();
  }

  async #readToken(): Promise<string | undefined> {
    if (!this.#host.vault) return undefined;
    try {
      const secrets = await this.#host.vault.get(HA_VAULT_KEY);
      const token = secrets?.token;
      return typeof token === "string" && token.trim() ? token.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async #writeToken(token: string): Promise<void> {
    if (!this.#host.vault) throw new Error("本地凭据库不可用，无法安全保存 Home Assistant 令牌。");
    await this.#host.vault.set(HA_VAULT_KEY, { token: token.trim() });
  }

  async #deleteToken(): Promise<void> {
    if (!this.#host.vault) return;
    try {
      await this.#host.vault.delete(HA_VAULT_KEY);
    } catch {
      // ignore if already absent
    }
  }

  isStale(): boolean {
    if (this.#lastError) return true;
    if (this.#lastSyncAt === undefined) return true;
    if (!this.#wsConnected && this.#wsDisconnectedAt !== undefined && this.#now() - this.#wsDisconnectedAt >= STALE_AFTER_MS) {
      return true;
    }
    return false;
  }

  #staleReason(): string | undefined {
    if (this.#lastError) return this.#lastError;
    if (this.#lastSyncAt === undefined) return "尚未完成首次同步";
    if (!this.#wsConnected && this.#wsDisconnectedAt !== undefined && this.#now() - this.#wsDisconnectedAt >= STALE_AFTER_MS) {
      return "实时连接已断开超过 60 秒";
    }
    return undefined;
  }

  async start(): Promise<void> {
    const cfg = await this.#host.persistedConfig();
    if (cfg.enabled && cfg.baseUrl) {
      await this.syncNow().catch(() => {});
      this.#connectShadowWs();
      await this.#sentinel?.start();
    }
  }

  async configure(input: {
    enabled?: boolean;
    baseUrl?: string;
    token?: string;
    clearToken?: boolean;
    sentinel?: Partial<HomeAssistantSentinelConfig>;
    announce?: Partial<HomeAssistantAnnounceConfig>;
  }): Promise<HomeAssistantSnapshot> {
    const prev = await this.#host.persistedConfig();
    let nextBaseUrl = prev.baseUrl;
    if (input.baseUrl !== undefined) {
      const trimmed = input.baseUrl.trim();
      if (!trimmed) {
        nextBaseUrl = undefined;
      } else {
        const validated = validateLanHaUrl(trimmed);
        nextBaseUrl = validated.toString().replace(/\/$/, "");
      }
    }
    if (input.clearToken) {
      await this.#deleteToken();
    } else if (typeof input.token === "string" && input.token.trim()) {
      await this.#writeToken(input.token.trim());
    }
    const nextEnabled = typeof input.enabled === "boolean" ? input.enabled : prev.enabled;
    const nextSentinel = input.sentinel
      ? normalizeHaSentinelConfig({ ...normalizeHaSentinelConfig(prev.sentinel), ...input.sentinel })
      : prev.sentinel;
    const nextAnnounce = input.announce
      ? normalizeHaAnnounceConfig({ ...normalizeHaAnnounceConfig(prev.announce), ...input.announce })
      : prev.announce;

    await this.#host.saveConfig({
      enabled: nextEnabled,
      ...(nextBaseUrl ? { baseUrl: nextBaseUrl } : {}),
      ...(nextSentinel ? { sentinel: nextSentinel } : {}),
      ...(nextAnnounce ? { announce: nextAnnounce } : {}),
    });

    const connectionChanged =
      input.enabled !== undefined ||
      input.baseUrl !== undefined ||
      input.token !== undefined ||
      input.clearToken === true;

    if (connectionChanged) {
      this.#disconnectShadowWs();
      this.#lastError = undefined;
      if (nextEnabled && nextBaseUrl) {
        await this.syncNow().catch(() => {});
        this.#connectShadowWs();
        await this.#sentinel?.start();
      } else {
        this.#entities.clear();
        this.#registry.areas.clear();
        this.#registry.devices.clear();
        this.#registry.entities.clear();
        this.#totalEntities = 0;
        this.#filteredNoiseCount = 0;
        this.#lastSyncAt = undefined;
        this.#wsDisconnectedAt = undefined;
      }
    }
    return this.status();
  }

  async #requireConnection(): Promise<{ baseUrl: URL; token: string }> {
    const cfg = await this.#host.persistedConfig();
    if (!cfg.enabled || !cfg.baseUrl) {
      throw new Error("Home Assistant 连接未启用或尚未配置地址。");
    }
    const token = await this.#readToken();
    if (!token) throw new Error("缺少 Home Assistant 访问令牌。");
    return { baseUrl: validateLanHaUrl(cfg.baseUrl), token };
  }

  async syncNow(): Promise<{ entities: HomeAssistantEntityView[]; totalCount: number; filteredNoiseCount: number }> {
    const cfg = await this.#host.persistedConfig();
    if (!cfg.baseUrl) throw new Error("尚未配置 Home Assistant 局域网地址");
    const token = await this.#readToken();
    if (!token) throw new Error("尚未配置 Home Assistant 长期访问令牌（Long-Lived Access Token）");
    const baseUrl = validateLanHaUrl(cfg.baseUrl);
    try {
      const res = await directLanRequest(baseUrl, "/api/states", {
        token,
        timeoutMs: 10_000,
        dnsLookup: this.#host.dnsLookup,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Home Assistant 返回 HTTP ${res.status}，请检查令牌与地址。`);
      }
      const rawStates = JSON.parse(res.body) as RawHaState[];
      if (!Array.isArray(rawStates)) throw new Error("Home Assistant 状态数据格式无效");
      const curated = curateHomeAssistantEntities(rawStates, this.#registry);
      this.#entities = new Map(curated.entities.map((item) => [item.entityId, item]));
      this.#totalEntities = curated.totalCount;
      this.#filteredNoiseCount = curated.filteredNoiseCount;
      this.#lastSyncAt = this.#now();
      this.#lastError = undefined;

      // Probe native HA /api/mcp endpoint non-fatally.
      try {
        const mcpProbe = await directLanRequest(baseUrl, "/api/mcp", {
          method: "GET",
          token,
          timeoutMs: 3_000,
          dnsLookup: this.#host.dnsLookup,
        });
        this.#mcpSupported = mcpProbe.status !== 404;
      } catch {
        this.#mcpSupported = false;
      }
      return curated;
    } catch (error) {
      this.#lastError = this.#host.redact(error instanceof Error ? error.message : "无法连接 Home Assistant");
      throw error;
    }
  }

  listEntities(filter?: { domain?: string; area?: string; query?: string; includeAttributes?: boolean }): {
    entities: HomeAssistantEntityView[];
    totalCount: number;
    filteredNoiseCount: number;
    stale: boolean;
    staleReason?: string;
  } {
    let list = [...this.#entities.values()];
    if (filter?.domain) {
      const dom = filter.domain.trim().toLowerCase();
      list = list.filter((entity) => entity.domain === dom);
    }
    if (filter?.area) {
      const targetArea = filter.area.trim().toLowerCase();
      list = list.filter(
        (entity) =>
          (entity.area?.toLowerCase().includes(targetArea) ?? false) ||
          (entity.areaId?.toLowerCase() === targetArea),
      );
    }
    if (filter?.query) {
      const q = filter.query.trim().toLowerCase();
      list = list.filter(
        (entity) =>
          entity.name.toLowerCase().includes(q) ||
          entity.entityId.toLowerCase().includes(q) ||
          (entity.area?.toLowerCase().includes(q) ?? false),
      );
    }
    const output = filter?.includeAttributes === false
      ? list.map(({ attributes: _attrs, ...rest }) => rest)
      : list;
    const stale = this.isStale();
    const staleReason = stale ? this.#staleReason() : undefined;
    return {
      entities: output,
      totalCount: this.#totalEntities,
      filteredNoiseCount: this.#filteredNoiseCount,
      stale,
      ...(staleReason ? { staleReason } : {}),
    };
  }

  async #fetchScriptConfig(scriptSlug: string): Promise<Record<string, unknown> | undefined> {
    if (!/^[a-z0-9_]{1,120}$/i.test(scriptSlug)) return undefined;
    try {
      const { baseUrl, token } = await this.#requireConnection();
      const res = await directLanRequest(baseUrl, `/api/config/script/config/${encodeURIComponent(scriptSlug)}`, {
        method: "GET",
        token,
        timeoutMs: 6_000,
        dnsLookup: this.#host.dnsLookup,
      });
      if (res.status < 200 || res.status >= 300) return undefined;
      const parsed = JSON.parse(res.body) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  #securityContext() {
    return {
      entities: this.#entities,
      stale: this.#entities.size > 0 ? this.isStale() : false,
      fetchScriptConfig: (slug: string) => this.#fetchScriptConfig(slug),
    };
  }

  async callService(input: {
    domain: string;
    service: string;
    entityId?: string;
    serviceData?: Record<string, unknown>;
    triggerSource: "user_direct" | "user_confirmed_l2" | "external_untrusted";
  }): Promise<{ ok: boolean; states?: unknown }> {
    const cleanData = sanitizeServiceData(input.serviceData);
    const existing = input.entityId ? this.#entities.get(input.entityId) : undefined;
    await assertSafeHaServiceCallDeep({
      domain: input.domain,
      service: input.service,
      entityId: input.entityId,
      deviceClass: existing?.deviceClass,
      serviceData: cleanData,
      triggerSource: input.triggerSource,
      context: this.#securityContext(),
    });
    const { baseUrl, token } = await this.#requireConnection();
    const domain = input.domain.trim().toLowerCase();
    const service = input.service.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,40}$/.test(domain) || !/^[a-z0-9_]{1,64}$/.test(service)) {
      throw new Error("Home Assistant 服务名格式无效。");
    }
    const body: Record<string, unknown> = {
      ...(cleanData ?? {}),
      ...(input.entityId ? { entity_id: input.entityId } : {}),
    };
    const res = await directLanRequest(baseUrl, `/api/services/${domain}/${service}`, {
      method: "POST",
      token,
      body,
      timeoutMs: 10_000,
      dnsLookup: this.#host.dnsLookup,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Home Assistant 执行失败 (HTTP ${res.status})`);
    }
    let states: unknown;
    try { states = JSON.parse(res.body); } catch { states = undefined; }
    void this.syncNow().catch(() => {});
    return { ok: true, states };
  }

  async fetchCameraSnapshot(
    cameraEntityId: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp" }> {
    const normalized = cameraEntityId.trim();
    if (!/^camera\.[a-z0-9_]{1,120}$/i.test(normalized)) {
      throw new Error("无效的摄像头实体 ID。");
    }
    const cfg = await this.#host.persistedConfig();
    const sentinelCfg = normalizeHaSentinelConfig(cfg.sentinel);
    if (!sentinelCfg.visionCameraAllowlist.includes(normalized)) {
      throw Object.assign(
        new Error(`隐私保护：摄像头「${normalized}」未获用户查看授权，禁止抓取画面。`),
        { code: "ha_camera_not_authorized", status: 403 },
      );
    }
    const { baseUrl, token } = await this.#requireConnection();
    const res = await directLanRequestRaw(baseUrl, `/api/camera_proxy/${encodeURIComponent(normalized)}`, {
      method: "GET",
      token,
      accept: "image/jpeg,image/png,image/webp",
      timeoutMs: 8_000,
      maxBytes: 2 * 1024 * 1024,
      signal,
      dnsLookup: this.#host.dnsLookup,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`抓取摄像头快照失败 (HTTP ${res.status})`);
    }
    const mimeType = sniffImageMime(res.buffer);
    if (!mimeType) {
      throw new Error("摄像头返回的数据不是有效的图片格式。");
    }
    return { bytes: res.buffer, mimeType };
  }

  listAutomations(): HomeAssistantEntityView[] {
    return [...this.#entities.values()].filter((e) => e.domain === "automation");
  }

  async getAutomationConfig(configId: string): Promise<Record<string, unknown>> {
    const cleanId = configId.trim();
    if (!cleanId || !/^[a-zA-Z0-9_-]{1,128}$/.test(cleanId)) {
      throw new Error("自动化配置 ID（configId）无效，请使用 attributes.id 而非 automation.* 实体名。");
    }
    const { baseUrl, token } = await this.#requireConnection();
    const res = await directLanRequest(baseUrl, `/api/config/automation/config/${encodeURIComponent(cleanId)}`, {
      method: "GET",
      token,
      timeoutMs: 8_000,
      dnsLookup: this.#host.dnsLookup,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`读取自动化配置失败 (HTTP ${res.status})`);
    }
    return JSON.parse(res.body) as Record<string, unknown>;
  }

  async validateAutomationDraft(rawDraft: Record<string, unknown>): Promise<ValidatedAutomationDraft> {
    return validateHaAutomationDraft(rawDraft, {
      entities: this.#entities,
      stale: this.isStale(),
      fetchScriptConfig: (slug) => this.#fetchScriptConfig(slug),
    });
  }

  async upsertAutomation(input: {
    configId: string;
    config: Record<string, unknown>;
  }): Promise<{ ok: boolean; configId: string; alias: string; backupId?: string }> {
    const cleanId = input.configId.trim();
    if (!cleanId || !/^[a-zA-Z0-9_-]{1,128}$/.test(cleanId)) {
      throw new Error("自动化配置 ID 无效。");
    }
    const validated = await this.validateAutomationDraft(input.config);
    const { baseUrl, token } = await this.#requireConnection();

    // Snapshot previous config before mutating so user can say "撤销刚才的配置".
    let previousConfigJson: string | undefined;
    try {
      const prevRes = await directLanRequest(baseUrl, `/api/config/automation/config/${encodeURIComponent(cleanId)}`, {
        method: "GET",
        token,
        timeoutMs: 5_000,
        dnsLookup: this.#host.dnsLookup,
      });
      if (prevRes.status >= 200 && prevRes.status < 300) {
        previousConfigJson = prevRes.body;
      }
    } catch {
      // new automation
    }

    const payload = { id: cleanId, ...validated.normalized };
    const res = await directLanRequest(baseUrl, `/api/config/automation/config/${encodeURIComponent(cleanId)}`, {
      method: "POST",
      token,
      body: payload,
      timeoutMs: 10_000,
      dnsLookup: this.#host.dnsLookup,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`写入 Home Assistant 自动化失败 (HTTP ${res.status})`);
    }

    let backupId: string | undefined;
    if (this.#host.ledger) {
      const saved = await this.#host.ledger.recordHaAutomationBackup({
        automationId: cleanId,
        alias: validated.alias,
        ...(previousConfigJson !== undefined ? { previousConfigJson } : {}),
        appliedConfigJson: JSON.stringify(payload),
      });
      backupId = saved.id;
    }

    await directLanRequest(baseUrl, "/api/services/automation/reload", {
      method: "POST",
      token,
      body: {},
      timeoutMs: 8_000,
      dnsLookup: this.#host.dnsLookup,
    }).catch(() => {});
    void this.syncNow().catch(() => {});
    return { ok: true, configId: cleanId, alias: validated.alias, ...(backupId ? { backupId } : {}) };
  }

  async deleteAutomation(configId: string): Promise<{ ok: boolean; configId: string; backupId?: string }> {
    const cleanId = configId.trim();
    if (!cleanId || !/^[a-zA-Z0-9_-]{1,128}$/.test(cleanId)) {
      throw new Error("自动化配置 ID 无效。");
    }
    const matched = this.listAutomations().find((a) => a.configId === cleanId);
    if (matched && !matched.editable) {
      throw new Error(`自动化「${matched.name}」为手写 YAML 只读配置，无法通过接口删除。`);
    }
    if (matched && /(?:alarm|security|smoke|gas|leak|门锁|安防|烟雾|燃气|漏水)/i.test(`${matched.name} ${matched.entityId}`)) {
      throw Object.assign(
        new Error(`物理安防红线：禁止删除疑似安防告警类自动化「${matched.name}」。`),
        { code: "ha_physical_security_blocked", status: 403 },
      );
    }

    const { baseUrl, token } = await this.#requireConnection();
    let previousConfigJson: string | undefined;
    try {
      const prevRes = await directLanRequest(baseUrl, `/api/config/automation/config/${encodeURIComponent(cleanId)}`, {
        method: "GET",
        token,
        timeoutMs: 5_000,
        dnsLookup: this.#host.dnsLookup,
      });
      if (prevRes.status >= 200 && prevRes.status < 300) {
        previousConfigJson = prevRes.body;
      }
    } catch {
      // ignore
    }

    const res = await directLanRequest(baseUrl, `/api/config/automation/config/${encodeURIComponent(cleanId)}`, {
      method: "DELETE",
      token,
      timeoutMs: 10_000,
      dnsLookup: this.#host.dnsLookup,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`删除 Home Assistant 自动化失败 (HTTP ${res.status})`);
    }

    let backupId: string | undefined;
    if (this.#host.ledger && previousConfigJson) {
      const saved = await this.#host.ledger.recordHaAutomationBackup({
        automationId: cleanId,
        alias: matched?.name ?? cleanId,
        previousConfigJson,
        appliedConfigJson: JSON.stringify({ deleted: true }),
      });
      backupId = saved.id;
    }

    await directLanRequest(baseUrl, "/api/services/automation/reload", {
      method: "POST",
      token,
      body: {},
      timeoutMs: 8_000,
      dnsLookup: this.#host.dnsLookup,
    }).catch(() => {});
    void this.syncNow().catch(() => {});
    return { ok: true, configId: cleanId, ...(backupId ? { backupId } : {}) };
  }

  async restoreAutomationBackup(options: { backupId?: string; configId?: string } = {}): Promise<{
    ok: boolean;
    restoredAction: "reverted" | "deleted_new";
    configId: string;
    alias: string;
  }> {
    if (!this.#host.ledger) throw new Error("本地备份账本不可用。");
    const backup = await this.#host.ledger.getHaAutomationBackup({
      backupId: options.backupId,
      automationId: options.configId,
    });
    if (!backup) throw new Error("没有可撤销的 Home Assistant 自动化配置记录。");

    const { baseUrl, token } = await this.#requireConnection();
    if (!backup.previousConfigJson) {
      const res = await directLanRequest(baseUrl, `/api/config/automation/config/${encodeURIComponent(backup.automationId)}`, {
        method: "DELETE",
        token,
        timeoutMs: 10_000,
        dnsLookup: this.#host.dnsLookup,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`撤销新建自动化失败 (HTTP ${res.status})`);
      }
      await directLanRequest(baseUrl, "/api/services/automation/reload", { method: "POST", token, body: {}, dnsLookup: this.#host.dnsLookup }).catch(() => {});
      void this.syncNow().catch(() => {});
      return { ok: true, restoredAction: "deleted_new", configId: backup.automationId, alias: backup.alias };
    }

    const previous = JSON.parse(backup.previousConfigJson) as Record<string, unknown>;
    const res = await directLanRequest(baseUrl, `/api/config/automation/config/${encodeURIComponent(backup.automationId)}`, {
      method: "POST",
      token,
      body: previous,
      timeoutMs: 10_000,
      dnsLookup: this.#host.dnsLookup,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`恢复旧自动化配置失败 (HTTP ${res.status})`);
    }
    await directLanRequest(baseUrl, "/api/services/automation/reload", { method: "POST", token, body: {}, dnsLookup: this.#host.dnsLookup }).catch(() => {});
    void this.syncNow().catch(() => {});
    return { ok: true, restoredAction: "reverted", configId: backup.automationId, alias: backup.alias };
  }

  async getHistory(input: { entityIds: string[]; hours?: number }): Promise<{
    since: string;
    series: Array<{ entityId: string; samples: Array<{ state: string; at: string }> }>;
  }> {
    const ids = [...new Set(input.entityIds.map((s) => s.trim()).filter((s) => /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(s)))].slice(0, 5);
    if (ids.length === 0) throw new Error("请提供 1 至 5 个有效的实体 ID。");
    const hours = Math.max(1, Math.min(168, Number.isFinite(input.hours) ? Math.round(input.hours!) : 24));
    const since = new Date(this.#now() - hours * 3_600_000).toISOString();
    const { baseUrl, token } = await this.#requireConnection();
    const q = `/api/history/period/${encodeURIComponent(since)}?filter_entity_id=${encodeURIComponent(ids.join(","))}&minimal_response&no_attributes`;
    const res = await directLanRequest(baseUrl, q, {
      method: "GET",
      token,
      timeoutMs: 12_000,
      maxBytes: 512 * 1024,
      dnsLookup: this.#host.dnsLookup,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`读取历史记录失败 (HTTP ${res.status})`);
    }
    const raw = JSON.parse(res.body) as unknown;
    const series: Array<{ entityId: string; samples: Array<{ state: string; at: string }> }> = [];
    if (Array.isArray(raw)) {
      for (const group of raw) {
        if (!Array.isArray(group) || group.length === 0) continue;
        const first = group[0] as Record<string, unknown>;
        const entityId = typeof first.entity_id === "string" ? first.entity_id : "unknown";
        const samples = group.slice(-40).map((row) => {
          const r = row as Record<string, unknown>;
          return {
            state: String(r.state ?? ""),
            at: String(r.last_changed ?? r.last_updated ?? ""),
          };
        });
        series.push({ entityId, samples });
      }
    }
    return { since, series };
  }

  async getTraces(configId: string): Promise<{ configId: string; traces: unknown[] }> {
    const cleanId = configId.trim();
    if (!cleanId || !/^[a-zA-Z0-9_-]{1,128}$/.test(cleanId)) {
      throw new Error("自动化配置 ID 无效。");
    }
    if (!this.#wsConnected) {
      throw new Error("当前未建立 Home Assistant WebSocket 实时连接，暂无法读取执行轨迹。");
    }
    const list = await this.sendWsCommand("trace/list", { domain: "automation", item_id: cleanId }, 8_000);
    const entries = Array.isArray(list) ? list.slice(0, 5) : [];
    const detailed: unknown[] = [];
    for (const item of entries) {
      const rec = item as Record<string, unknown>;
      const runId = typeof rec.run_id === "string" ? rec.run_id : undefined;
      if (!runId) continue;
      try {
        const detail = await this.sendWsCommand("trace/get", { domain: "automation", item_id: cleanId, run_id: runId }, 6_000);
        detailed.push({
          runId,
          timestamp: rec.timestamp,
          state: rec.state,
          scriptExecution: rec.script_execution,
          error: (detail as Record<string, unknown> | undefined)?.error ?? rec.error,
          trigger: rec.trigger,
        });
      } catch {
        detailed.push({ runId, timestamp: rec.timestamp, state: rec.state, error: rec.error });
      }
    }
    return { configId: cleanId, traces: detailed };
  }

  #listSpeakers(): HomeAssistantEntityView[] {
    return [...this.#entities.values()].filter(
      (e) => e.domain === "media_player" || (e.domain === "text" && (SPEAKER_TEXT_PATTERN.test(e.entityId) || SPEAKER_TEXT_PATTERN.test(e.name))),
    );
  }

  #isSomeoneHome(): boolean {
    const people = [...this.#entities.values()].filter((e) => e.domain === "person");
    if (people.length === 0) return true;
    return people.some((p) => p.state.toLowerCase() === "home");
  }

  /**
   * Smart speaker announcement: auto-selects single speaker, enforces home presence / quiet hours /
   * rate limits, tries Kulo TTS over LAN ephemeral clip URL first when available, and silently falls
   * back to HA native text playback (`text.*` -> `xiaomi_miot` -> `tts.speak`).
   */
  async announce(input: {
    text: string;
    speakerEntityId?: string;
    urgency?: "low" | "normal" | "high";
    critical?: boolean;
    situationId?: string;
    force?: boolean;
  }): Promise<{ ok: boolean; skippedReason?: string; channel?: "kulo_tts_lan" | "ha_text" | "ha_tts"; speakerEntityId?: string }> {
    const cfg = await this.#host.persistedConfig();
    if (!cfg.enabled || !cfg.baseUrl) {
      return { ok: false, skippedReason: "ha_disabled" };
    }
    const announceCfg = normalizeHaAnnounceConfig(cfg.announce);
    if (!input.force && !announceCfg.enabled) {
      return { ok: false, skippedReason: "announce_disabled" };
    }

    const now = this.#now();
    const urgency = input.urgency ?? (input.critical ? "high" : "normal");
    if (!input.force && !input.critical) {
      if (announceCfg.minUrgency === "high" && urgency !== "high") {
        return { ok: false, skippedReason: "below_urgency_threshold" };
      }
      if (announceCfg.onlyWhenHome && !this.#isSomeoneHome()) {
        return { ok: false, skippedReason: "nobody_home" };
      }
      if (isWithinQuietHours(now, announceCfg.quietHours)) {
        return { ok: false, skippedReason: "quiet_hours" };
      }
    } else if (input.critical && !input.force && !announceCfg.overrideQuietForCritical && isWithinQuietHours(now, announceCfg.quietHours)) {
      return { ok: false, skippedReason: "quiet_hours" };
    }

    if (!input.force) {
      if (input.situationId) {
        const last = this.#announceBySituation.get(input.situationId);
        if (last && now - last < ANNOUNCE_SITUATION_COOLDOWN_MS) {
          return { ok: false, skippedReason: "situation_cooldown" };
        }
      }
      while (this.#announceTimestamps.length > 0 && now - this.#announceTimestamps[0]! >= 60_000) {
        this.#announceTimestamps.shift();
      }
      if (this.#announceTimestamps.length >= ANNOUNCE_PER_MIN_CAP) {
        return { ok: false, skippedReason: "rate_limited" };
      }
    }

    const cleanText = sanitizeAnnounceText(input.text, (s) => this.#host.redact(s));
    if (!cleanText) return { ok: false, skippedReason: "empty_text" };

    const speakers = this.#listSpeakers();
    const mediaPlayers = speakers.filter((s) => s.domain === "media_player");
    const textSpeakers = speakers.filter((s) => s.domain === "text");

    const explicitId = input.speakerEntityId?.trim() || announceCfg.defaultSpeakerEntityId;
    const chosenMediaPlayer = explicitId?.startsWith("media_player.")
      ? mediaPlayers.find((s) => s.entityId === explicitId) ?? { entityId: explicitId, domain: "media_player", name: explicitId, state: "idle" }
      : mediaPlayers.length === 1
        ? mediaPlayers[0]
        : mediaPlayers.find((s) => /xiaoai|小爱|speaker|音箱/i.test(`${s.entityId} ${s.name}`));
    const chosenTextSpeaker = explicitId?.startsWith("text.")
      ? textSpeakers.find((s) => s.entityId === explicitId) ?? { entityId: explicitId, domain: "text", name: explicitId, state: "" }
      : textSpeakers.length === 1
        ? textSpeakers[0]
        : textSpeakers.find((s) => chosenMediaPlayer?.deviceId && s.deviceId === chosenMediaPlayer.deviceId) ?? textSpeakers[0];

    if (!chosenMediaPlayer && !chosenTextSpeaker) {
      return { ok: false, skippedReason: "no_speaker_found" };
    }

    const { baseUrl, token } = await this.#requireConnection();

    // Channel A: Kulo custom TTS over ephemeral LAN clip URL (`/_ha-tts/:clipId`), auto-falling back to Channel B.
    const lanEndpoint = this.#host.lanHttpEndpoint?.();
    if (
      announceCfg.useKuloVoiceTts &&
      chosenMediaPlayer &&
      this.#host.synthesizeTts &&
      this.#host.lanAudioRelay &&
      lanEndpoint?.lanReachable &&
      lanEndpoint.port > 0
    ) {
      const lanIp = selectPhysicalLanIpv4(cfg.baseUrl);
      if (lanIp) {
        try {
          const synth = await this.#host.synthesizeTts(cleanText);
          if (synth && synth.bytes.byteLength > 0) {
            const clipId = this.#host.lanAudioRelay.store(synth.bytes, synth.mimeType);
            const mediaUrl = `http://${lanIp}:${lanEndpoint.port}/_ha-tts/${clipId}`;
            const playRes = await directLanRequest(baseUrl, "/api/services/media_player/play_media", {
              method: "POST",
              token,
              body: {
                entity_id: chosenMediaPlayer.entityId,
                media_content_id: mediaUrl,
                media_content_type: "music",
              },
              timeoutMs: 8_000,
              dnsLookup: this.#host.dnsLookup,
            });
            if (playRes.status >= 200 && playRes.status < 300) {
              this.#recordAnnounceSuccess(now, input.situationId);
              return { ok: true, channel: "kulo_tts_lan", speakerEntityId: chosenMediaPlayer.entityId };
            }
          }
        } catch {
          // Silently fall back to HA native speaker text playback.
        }
      }
    }

    // Channel B1: Xiaomi Home (`ha_xiaomi_home`) speaker play-text `text.*` entity (zero inbound Hub ports!).
    if (chosenTextSpeaker) {
      const res = await directLanRequest(baseUrl, "/api/services/text/set_value", {
        method: "POST",
        token,
        body: { entity_id: chosenTextSpeaker.entityId, value: cleanText },
        timeoutMs: 8_000,
        dnsLookup: this.#host.dnsLookup,
      });
      if (res.status >= 200 && res.status < 300) {
        this.#recordAnnounceSuccess(now, input.situationId);
        return { ok: true, channel: "ha_text", speakerEntityId: chosenTextSpeaker.entityId };
      }
    }

    // Channel B2: hass-xiaomi-miot `xiaomi_miot.intelligent_speaker` -> fallback standard HA `tts.speak` / `tts.cloud_say`.
    if (chosenMediaPlayer) {
      const miotRes = await directLanRequest(baseUrl, "/api/services/xiaomi_miot/intelligent_speaker", {
        method: "POST",
        token,
        body: { entity_id: chosenMediaPlayer.entityId, text: cleanText, execute: false },
        timeoutMs: 8_000,
        dnsLookup: this.#host.dnsLookup,
      }).catch(() => ({ status: 404, body: "" }));
      if (miotRes.status >= 200 && miotRes.status < 300) {
        this.#recordAnnounceSuccess(now, input.situationId);
        return { ok: true, channel: "ha_text", speakerEntityId: chosenMediaPlayer.entityId };
      }

      const ttsRes = await directLanRequest(baseUrl, "/api/services/tts/speak", {
        method: "POST",
        token,
        body: { media_player_entity_id: chosenMediaPlayer.entityId, message: cleanText, cache: false },
        timeoutMs: 8_000,
        dnsLookup: this.#host.dnsLookup,
      }).catch(() => ({ status: 404, body: "" }));
      if (ttsRes.status >= 200 && ttsRes.status < 300) {
        this.#recordAnnounceSuccess(now, input.situationId);
        return { ok: true, channel: "ha_tts", speakerEntityId: chosenMediaPlayer.entityId };
      }
    }

    return { ok: false, skippedReason: "speaker_service_failed" };
  }

  #recordAnnounceSuccess(now: number, situationId?: string): void {
    this.#announceTimestamps.push(now);
    if (situationId) this.#announceBySituation.set(situationId, now);
  }

  async adviseMigration(configDir: string = DEFAULT_CONFIG_DIR): Promise<HomeAssistantMigrationAdvice> {
    const orbExe = findBinary("orb");
    const dockerExe = findBinary("docker");
    const run = this.#host.commandRunner ?? defaultRunCommand;
    let containerRunning = false;
    if (dockerExe) {
      const ps = await run(dockerExe, ["ps", "--filter", "name=^/homeassistant$", "--format", "{{.Names}}"]);
      containerRunning = ps.ok && ps.stdout.includes("homeassistant");
    }
    const port8123Reachable = await probePort8123();
    const xiaomiHomeInstalled = fs.existsSync(path.join(configDir, "custom_components", "xiaomi_home", "manifest.json"));
    const steps: string[] = [];
    if (!orbExe && !dockerExe) {
      steps.push("1. 安装轻量容器引擎 OrbStack（macOS 首选：`brew install --cask orbstack`）并启动。");
    } else if (!containerRunning && !port8123Reachable) {
      steps.push("1. 在 Kulo 一键拉起本机 Home Assistant（自动预装小米官方无损集成 `XiaoMi/ha_xiaomi_home`，数据落在 ~/.kulo-homeassistant）。");
    } else {
      steps.push("1. 已检测到本机 Home Assistant 服务就绪（http://127.0.0.1:8123）。");
    }
    steps.push(
      xiaomiHomeInstalled
        ? "2. 已预装小米官方无损集成 `XiaoMi/ha_xiaomi_home`，打开 http://127.0.0.1:8123 建号后在「添加集成」中直接搜索「Xiaomi Home」扫码登录米家（原米家 App 与自动化 100% 保留）。"
        : "2. 在 Home Assistant 安装小米官方无损集成 `XiaoMi/ha_xiaomi_home` 并扫码登录米家账号（原米家 App 与自动化 100% 保留不受影响）。",
    );
    steps.push("3. 在 Home Assistant 个人资料 → 安全页生成长期访问令牌，粘贴到 Kulo 设置弹窗即可完成局域网连接。");

    return {
      dockerAvailable: Boolean(dockerExe),
      orbStackAvailable: Boolean(orbExe),
      containerRunning,
      port8123Reachable,
      xiaomiHomeInstalled,
      configDir,
      steps,
    };
  }

  async #preinstallXiaomiHome(configDir: string): Promise<boolean> {
    const targetDir = path.join(configDir, "custom_components", "xiaomi_home");
    if (fs.existsSync(path.join(targetDir, "manifest.json"))) return true;
    const curlExe = findBinary("curl");
    const tarExe = findBinary("tar");
    if (!curlExe || !tarExe) return false;
    const run = this.#host.commandRunner ?? defaultRunCommand;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-ha-xiaomi-"));
    const tarPath = path.join(tmpDir, "xiaomi_home.tar.gz");
    try {
      const dl = await run(curlExe, ["-fsSL", "--max-time", "30", "--max-filesize", "20971520", "-o", tarPath, XIAOMI_HOME_TARBALL_URL]);
      if (!dl.ok || !fs.existsSync(tarPath)) return false;
      const extractDir = path.join(tmpDir, "extracted");
      fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
      const ext = await run(tarExe, ["-xzf", tarPath, "-C", extractDir]);
      if (!ext.ok) return false;
      const entries = fs.readdirSync(extractDir);
      const top = entries.find((e) => fs.existsSync(path.join(extractDir, e, "custom_components", "xiaomi_home", "manifest.json")));
      if (!top) return false;
      const src = path.join(extractDir, top, "custom_components", "xiaomi_home");
      fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
      fs.cpSync(src, targetDir, { recursive: true });
      return fs.existsSync(path.join(targetDir, "manifest.json"));
    } catch {
      return false;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async deployLocalContainer(input: {
    confirmed: boolean;
    configDir?: string;
    installXiaomiHome?: boolean;
  }): Promise<{
    requiresConfirmation?: boolean;
    advice: HomeAssistantMigrationAdvice;
    started?: boolean;
    xiaomiHomeInstalled?: boolean;
    url?: string;
  }> {
    const configDir = input.configDir ? path.resolve(input.configDir) : DEFAULT_CONFIG_DIR;
    const advice = await this.adviseMigration(configDir);
    if (!input.confirmed) {
      return { requiresConfirmation: true, advice };
    }
    const dockerExe = findBinary("docker");
    if (!dockerExe) {
      throw new Error("未检测到 docker / OrbStack CLI，请先安装并启动 OrbStack（brew install --cask orbstack）。");
    }
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    let xiaomiHomeInstalled = advice.xiaomiHomeInstalled ?? false;
    if (input.installXiaomiHome !== false && !xiaomiHomeInstalled) {
      xiaomiHomeInstalled = await this.#preinstallXiaomiHome(configDir).catch(() => false);
    }

    const run = this.#host.commandRunner ?? defaultRunCommand;
    if (!advice.containerRunning) {
      const startExisting = await run(dockerExe, ["start", "homeassistant"]);
      if (!startExisting.ok) {
        const created = await run(dockerExe, [
          "run",
          "-d",
          "--name",
          "homeassistant",
          "--restart=unless-stopped",
          "-e",
          `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"}`,
          "-v",
          `${configDir}:/config`,
          "-p",
          "127.0.0.1:8123:8123",
          "ghcr.io/home-assistant/home-assistant:stable",
        ]);
        if (!created.ok) {
          throw new Error(`启动 Home Assistant 容器失败：${created.stderr.slice(0, 300)}`);
        }
      }
    }
    return {
      advice: await this.adviseMigration(configDir),
      started: true,
      xiaomiHomeInstalled,
      url: "http://127.0.0.1:8123",
    };
  }

  async status(options: { includeMigration?: boolean } = {}): Promise<HomeAssistantSnapshot> {
    const cfg = await this.#host.persistedConfig();
    const token = await this.#readToken();
    const stale = cfg.enabled && Boolean(cfg.baseUrl) && Boolean(token) ? this.isStale() : false;
    const staleReason = stale ? this.#staleReason() : undefined;
    const automationCount = this.listAutomations().length;
    const speakerCount = this.#listSpeakers().length;
    return {
      enabled: cfg.enabled,
      connected: Boolean(cfg.enabled && cfg.baseUrl && token && !this.#lastError && this.#lastSyncAt !== undefined),
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      hasToken: Boolean(token),
      ...(this.#lastSyncAt !== undefined ? { mcpSupported: this.#mcpSupported } : {}),
      ...(this.#totalEntities > 0 ? { totalEntities: this.#totalEntities } : {}),
      ...(this.#entities.size > 0 ? { curatedEntities: this.#entities.size } : {}),
      ...(this.#filteredNoiseCount > 0 ? { filteredNoiseCount: this.#filteredNoiseCount } : {}),
      ...(this.#registry.areas.size > 0 ? { areaCount: this.#registry.areas.size } : {}),
      ...(automationCount > 0 ? { automationCount } : {}),
      ...(speakerCount > 0 ? { speakerCount } : {}),
      wsConnected: this.#wsConnected,
      ...(stale ? { stale: true, ...(staleReason ? { staleReason } : {}) } : {}),
      ...(this.#lastSyncAt !== undefined ? { lastSyncAt: this.#lastSyncAt } : {}),
      ...(this.#lastError ? { error: this.#lastError } : {}),
      sentinel: normalizeHaSentinelConfig(cfg.sentinel),
      announce: normalizeHaAnnounceConfig(cfg.announce),
      ...(options.includeMigration ? { migration: await this.adviseMigration() } : {}),
    };
  }

  sendWsCommand(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || !this.#wsConnected || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Home Assistant WebSocket 未连接。"));
    }
    const id = this.#wsNextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#wsPending.delete(id);
        reject(new Error(`Home Assistant WS 指令 ${type} 超时`));
      }, timeoutMs);
      timer.unref();
      this.#wsPending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, type, ...payload }));
      } catch (err) {
        clearTimeout(timer);
        this.#wsPending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async #refreshRegistriesAndResync(): Promise<void> {
    try {
      const [areas, devices, entities] = await Promise.all([
        this.sendWsCommand("config/area_registry/list", {}, 8_000).catch(() => null),
        this.sendWsCommand("config/device_registry/list", {}, 8_000).catch(() => null),
        this.sendWsCommand("config/entity_registry/list", {}, 8_000).catch(() => null),
      ]);
      if (Array.isArray(areas)) {
        this.#registry.areas.clear();
        for (const a of areas) {
          const rec = a as Record<string, unknown>;
          if (typeof rec.area_id === "string" && typeof rec.name === "string") {
            this.#registry.areas.set(rec.area_id, rec.name);
          }
        }
      }
      if (Array.isArray(devices)) {
        this.#registry.devices.clear();
        for (const d of devices) {
          const rec = d as Record<string, unknown>;
          if (typeof rec.id === "string") {
            this.#registry.devices.set(rec.id, {
              ...(typeof rec.area_id === "string" ? { areaId: rec.area_id } : {}),
              ...(typeof rec.name_by_user === "string" ? { name: rec.name_by_user } : typeof rec.name === "string" ? { name: rec.name } : {}),
            });
          }
        }
      }
      if (Array.isArray(entities)) {
        this.#registry.entities.clear();
        for (const e of entities) {
          const rec = e as Record<string, unknown>;
          if (typeof rec.entity_id === "string") {
            const labels = Array.isArray(rec.labels)
              ? rec.labels.filter((l): l is string => typeof l === "string").slice(0, 8)
              : undefined;
            this.#registry.entities.set(rec.entity_id, {
              ...(typeof rec.area_id === "string" ? { areaId: rec.area_id } : {}),
              ...(typeof rec.device_id === "string" ? { deviceId: rec.device_id } : {}),
              ...(labels && labels.length > 0 ? { labels } : {}),
              disabledBy: typeof rec.disabled_by === "string" ? rec.disabled_by : null,
            });
          }
        }
      }
      // Full resync after reconnect + registry hydration to remove deleted entities & attach real areas.
      await this.syncNow().catch(() => {});
    } catch {
      // non-fatal
    }
  }

  #connectShadowWs(): void {
    if (this.#closed) return;
    void (async () => {
      const cfg = await this.#host.persistedConfig();
      const token = await this.#readToken();
      if (!cfg.enabled || !cfg.baseUrl || !token || this.#closed) return;
      let baseUrl: URL;
      let resolved: { address: string; family: number };
      try {
        baseUrl = validateLanHaUrl(cfg.baseUrl);
        resolved = await resolveAndVerifyLanHost(baseUrl.hostname, this.#host.dnsLookup);
      } catch {
        return;
      }
      if (this.#closed) return;
      const wsProto = baseUrl.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProto}//${baseUrl.host}${baseUrl.pathname.replace(/\/$/, "")}/api/websocket`;
      this.#disconnectShadowWs();
      const ws = new WebSocket(wsUrl, {
        handshakeTimeout: 8_000,
        maxPayload: MAX_WS_PAYLOAD_BYTES,
        followRedirects: false,
        lookup: ((_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
          cb(null, resolved.address, resolved.family);
        }) as unknown as typeof dns.lookup,
      });
      this.#ws = ws;

      ws.on("message", (raw) => {
        if (this.#ws !== ws) return;
        try {
          const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          if (msg.type === "auth_required") {
            ws.send(JSON.stringify({ type: "auth", access_token: token }));
          } else if (msg.type === "auth_ok") {
            this.#wsConnected = true;
            this.#wsDisconnectedAt = undefined;
            const subId = this.#wsNextId++;
            ws.send(JSON.stringify({ id: subId, type: "subscribe_events", event_type: "state_changed" }));
            void this.#refreshRegistriesAndResync();
          } else if (msg.type === "result" && typeof msg.id === "number") {
            const pending = this.#wsPending.get(msg.id);
            if (pending) {
              this.#wsPending.delete(msg.id);
              clearTimeout(pending.timer);
              if (msg.success === false) {
                const errObj = msg.error as Record<string, unknown> | undefined;
                pending.reject(new Error(typeof errObj?.message === "string" ? errObj.message : "HA WS command failed"));
              } else {
                pending.resolve(msg.result);
              }
            }
          } else if (msg.type === "event") {
            const data = (msg.event as Record<string, unknown> | undefined)?.data as { new_state?: RawHaState } | undefined;
            if (data?.new_state) this.#handleStateChanged(data.new_state);
          }
        } catch {
          // ignore malformed event frame
        }
      });

      ws.on("close", () => {
        if (this.#ws !== ws) return;
        this.#ws = null;
        this.#wsConnected = false;
        this.#wsDisconnectedAt = this.#now();
        this.#rejectAllPendingWs("Home Assistant WebSocket 已断开");
        if (!this.#closed) {
          this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            this.#connectShadowWs();
          }, 15_000);
          this.#reconnectTimer.unref();
        }
      });

      ws.on("error", () => {
        // handled cleanly by close listener
      });
    })();
  }

  #handleStateChanged(nextState: RawHaState): void {
    const curated = curateHomeAssistantEntities([nextState], this.#registry).entities[0];
    if (!curated) return;
    const prev = this.#entities.get(curated.entityId);
    this.#entities.set(curated.entityId, curated);
    this.#lastSyncAt = this.#now();

    if (this.#sentinel) {
      this.#sentinel.onEntityChanged(prev, curated);
      return;
    }

    // Fallback instant safety alerts when service is constructed standalone without stateDir/sentinel.
    if (
      this.#host.onAlertEvent &&
      prev &&
      prev.state !== curated.state &&
      ((curated.deviceClass && ["smoke", "gas", "moisture", "safety", "problem"].includes(curated.deviceClass) && curated.state === "on") ||
        (curated.domain === "alarm_control_panel" && curated.state === "triggered"))
    ) {
      this.#host.onAlertEvent({
        nativeEventId: `ha:${curated.entityId}:${this.#now()}`,
        eventVersion: "v1",
        appId: "home-assistant",
        appLabel: "智能家居",
        threadHint: curated.entityId,
        sender: curated.area || "Home Assistant",
        title: `${curated.name} 告警`,
        body: `设备「${curated.name}」状态变为 ${curated.state}（${curated.entityId}）。`,
        occurredAt: this.#now(),
        fidelity: "structured",
      });
    }
  }

  #rejectAllPendingWs(reason: string): void {
    for (const [id, pending] of this.#wsPending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.#wsPending.delete(id);
    }
  }

  #disconnectShadowWs(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#rejectAllPendingWs("Home Assistant WebSocket 已关闭");
    const ws = this.#ws;
    this.#ws = null;
    this.#wsConnected = false;
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#disconnectShadowWs();
    await this.#sentinel?.close();
  }
}
