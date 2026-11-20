import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import type {
  HomeAssistantEntityView,
  HomeAssistantMigrationAdvice,
  HomeAssistantSnapshot,
  RawConnectorEvent,
} from "@kulo/protocol";
import type { LocalConnectionVault } from "../connection-vault.js";

const HA_VAULT_KEY = "kulo-home-assistant-token";
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".kulo-homeassistant");

const BLOCKED_PHYSICAL_DOMAINS = new Set<string>([
  "lock",
  "alarm_control_panel",
  "siren",
  "valve",
  "hassio",
  "shell_command",
  "rest_command",
  "command_line",
]);

const BLOCKED_SERVICES = new Set<string>([
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

const GARAGE_GATE_PATTERN = /(?:garage|gate|door_lock|smart_lock|deadbolt|security_alarm|车库|门锁|大门)/i;

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

export interface HomeAssistantPersistedConfig {
  enabled: boolean;
  baseUrl?: string;
}

export interface HomeAssistantServiceHost {
  vault?: LocalConnectionVault;
  persistedConfig(): Promise<HomeAssistantPersistedConfig>;
  saveConfig(next: HomeAssistantPersistedConfig): Promise<void>;
  redact(text: string): string;
  onAlertEvent?: (event: RawConnectorEvent) => void;
  commandRunner?: (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

function isPrivateIpv4(ip: string): boolean {
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

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("::ffff:")) return isPrivateIpv4(lower.slice(7));
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

export function assertSafeHaServiceCall(input: {
  domain: string;
  service: string;
  entityId?: string;
  deviceClass?: string;
  triggerSource: "user_direct" | "user_confirmed_l2" | "external_untrusted";
}): void {
  if (input.triggerSource === "external_untrusted") {
    throw Object.assign(
      new Error("安全红线：来自外部不可信消息源的事件严禁直接触发智能家居物理动作，仅允许推送只读提醒或待确认卡片。"),
      { code: "ha_untrusted_trigger_blocked", status: 403 },
    );
  }
  const domain = input.domain.trim().toLowerCase();
  const service = input.service.trim().toLowerCase();
  const key = `${domain}.${service}`;
  if (BLOCKED_PHYSICAL_DOMAINS.has(domain) || BLOCKED_SERVICES.has(key)) {
    throw Object.assign(
      new Error(`物理安防红线：禁止 AI 执行高危服务「${key}」（门锁、安防撤防、阀门、系统启停永久锁死只读告警）。`),
      { code: "ha_physical_security_blocked", status: 403 },
    );
  }
  if (input.entityId && isBlockedPhysicalEntity(input.entityId, input.deviceClass)) {
    throw Object.assign(
      new Error(`物理安防红线：实体「${input.entityId}」属于高危安防设备，永久锁死为只读告警，不允许控制。`),
      { code: "ha_physical_security_blocked", status: 403 },
    );
  }
}

export interface RawHaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
}

/**
 * Automatically filters hundreds of noisy diagnostic/config/firmware/button entities commonly
 * produced by Xiaomi Home (`ha_xiaomi_home`) into a clean curated home entity catalog.
 */
export function curateHomeAssistantEntities(rawStates: readonly RawHaState[]): {
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
    const entityCategory = typeof attrs.entity_category === "string" ? attrs.entity_category.toLowerCase() : "";
    if (entityCategory === "diagnostic" || entityCategory === "config") continue;
    if (NOISE_ENTITY_PATTERNS.some((pattern) => pattern.test(entityId))) continue;
    if (domain === "update" || domain === "button" || domain === "event" || domain === "zone" || domain === "person" || domain === "sun") {
      continue;
    }

    const deviceClass = typeof attrs.device_class === "string" ? attrs.device_class.toLowerCase() : undefined;
    if (domain === "sensor" || domain === "binary_sensor") {
      if (!deviceClass || !CURATED_SENSOR_CLASSES.has(deviceClass)) continue;
    } else if (!ACTIONABLE_DOMAINS.has(domain)) {
      continue;
    }

    const friendlyName = typeof attrs.friendly_name === "string" && attrs.friendly_name.trim()
      ? attrs.friendly_name.trim().slice(0, 120)
      : entityId;
    const area = typeof attrs.area_name === "string" && attrs.area_name.trim() ? attrs.area_name.trim().slice(0, 80) : undefined;
    const unit = typeof attrs.unit_of_measurement === "string" && attrs.unit_of_measurement.trim() ? attrs.unit_of_measurement.trim().slice(0, 24) : undefined;
    const readOnlySecurity = isBlockedPhysicalEntity(entityId, deviceClass);

    entities.push({
      entityId,
      domain,
      name: friendlyName,
      state: String(row.state ?? "unknown").slice(0, 80),
      ...(area ? { area } : {}),
      ...(deviceClass ? { deviceClass } : {}),
      ...(unit ? { unit } : {}),
      ...(readOnlySecurity ? { readOnlySecurity: true } : {}),
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

function directLanRequest(
  baseUrl: URL,
  reqPath: string,
  options: {
    method?: "GET" | "POST";
    token?: string;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = baseUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const payload = options.body !== undefined ? Buffer.from(JSON.stringify(options.body), "utf8") : undefined;
    const req = transport.request(
      {
        hostname: baseUrl.hostname,
        port: baseUrl.port ? Number(baseUrl.port) : isHttps ? 443 : 80,
        path: `${baseUrl.pathname.replace(/\/$/, "")}${reqPath}`,
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
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
          if (total > MAX_HTTP_BYTES) {
            req.destroy(new Error("ha_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Home Assistant 连接超时")));
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function findBinary(name: string): string | undefined {
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".orbstack/bin"), ...(process.env.PATH ?? "").split(path.delimiter)];
  for (const dir of dirs.filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
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
        PATH: `/opt/homebrew/bin:/usr/local/bin:${path.join(os.homedir(), ".orbstack/bin")}:/usr/bin:/bin`,
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

export class HomeAssistantService {
  readonly #host: HomeAssistantServiceHost;
  #entities = new Map<string, HomeAssistantEntityView>();
  #totalEntities = 0;
  #filteredNoiseCount = 0;
  #mcpSupported = false;
  #ws: WebSocket | null = null;
  #wsConnected = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #lastSyncAt: number | undefined;
  #lastError: string | undefined;
  #closed = false;

  constructor(host: HomeAssistantServiceHost) {
    this.#host = host;
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

  async start(): Promise<void> {
    const cfg = await this.#host.persistedConfig();
    if (cfg.enabled && cfg.baseUrl) {
      await this.syncNow().catch(() => {});
      this.#connectShadowWs();
    }
  }

  async configure(input: { enabled?: boolean; baseUrl?: string; token?: string; clearToken?: boolean }): Promise<HomeAssistantSnapshot> {
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
    await this.#host.saveConfig({
      enabled: nextEnabled,
      ...(nextBaseUrl ? { baseUrl: nextBaseUrl } : {}),
    });

    this.#disconnectShadowWs();
    this.#lastError = undefined;
    if (nextEnabled && nextBaseUrl) {
      await this.syncNow().catch(() => {});
      this.#connectShadowWs();
    } else {
      this.#entities.clear();
      this.#totalEntities = 0;
      this.#filteredNoiseCount = 0;
    }
    return this.status();
  }

  async syncNow(): Promise<{ entities: HomeAssistantEntityView[]; totalCount: number; filteredNoiseCount: number }> {
    const cfg = await this.#host.persistedConfig();
    if (!cfg.baseUrl) throw new Error("尚未配置 Home Assistant 局域网地址");
    const token = await this.#readToken();
    if (!token) throw new Error("尚未配置 Home Assistant 长期访问令牌（Long-Lived Access Token）");
    const baseUrl = validateLanHaUrl(cfg.baseUrl);
    try {
      const res = await directLanRequest(baseUrl, "/api/states", { token, timeoutMs: 10_000 });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Home Assistant 返回 HTTP ${res.status}，请检查令牌与地址。`);
      }
      const rawStates = JSON.parse(res.body) as RawHaState[];
      if (!Array.isArray(rawStates)) throw new Error("Home Assistant 状态数据格式无效");
      const curated = curateHomeAssistantEntities(rawStates);
      this.#entities = new Map(curated.entities.map((item) => [item.entityId, item]));
      this.#totalEntities = curated.totalCount;
      this.#filteredNoiseCount = curated.filteredNoiseCount;
      this.#lastSyncAt = Date.now();
      this.#lastError = undefined;

      // Probe native HA /api/mcp endpoint non-fatally.
      try {
        const mcpProbe = await directLanRequest(baseUrl, "/api/mcp", { method: "GET", token, timeoutMs: 3_000 });
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

  listEntities(filter?: { domain?: string; query?: string }): {
    entities: HomeAssistantEntityView[];
    totalCount: number;
    filteredNoiseCount: number;
  } {
    let list = [...this.#entities.values()];
    if (filter?.domain) {
      const dom = filter.domain.trim().toLowerCase();
      list = list.filter((entity) => entity.domain === dom);
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
    return {
      entities: list,
      totalCount: this.#totalEntities,
      filteredNoiseCount: this.#filteredNoiseCount,
    };
  }

  async callService(input: {
    domain: string;
    service: string;
    entityId?: string;
    serviceData?: Record<string, unknown>;
    triggerSource: "user_direct" | "user_confirmed_l2" | "external_untrusted";
  }): Promise<{ ok: boolean; states?: unknown }> {
    const existing = input.entityId ? this.#entities.get(input.entityId) : undefined;
    assertSafeHaServiceCall({
      domain: input.domain,
      service: input.service,
      entityId: input.entityId,
      deviceClass: existing?.deviceClass,
      triggerSource: input.triggerSource,
    });
    const cfg = await this.#host.persistedConfig();
    if (!cfg.enabled || !cfg.baseUrl) {
      throw new Error("Home Assistant 连接未启用或尚未配置地址。");
    }
    const token = await this.#readToken();
    if (!token) throw new Error("缺少 Home Assistant 访问令牌。");
    const baseUrl = validateLanHaUrl(cfg.baseUrl);
    const domain = input.domain.trim().toLowerCase();
    const service = input.service.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,40}$/.test(domain) || !/^[a-z0-9_]{1,64}$/.test(service)) {
      throw new Error("Home Assistant 服务名格式无效。");
    }
    const body: Record<string, unknown> = {
      ...(input.serviceData ?? {}),
      ...(input.entityId ? { entity_id: input.entityId } : {}),
    };
    const res = await directLanRequest(baseUrl, `/api/services/${domain}/${service}`, {
      method: "POST",
      token,
      body,
      timeoutMs: 10_000,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Home Assistant 执行失败 (HTTP ${res.status})`);
    }
    let states: unknown;
    try { states = JSON.parse(res.body); } catch { states = undefined; }
    void this.syncNow().catch(() => {});
    return { ok: true, states };
  }

  async adviseMigration(): Promise<HomeAssistantMigrationAdvice> {
    const orbExe = findBinary("orb");
    const dockerExe = findBinary("docker");
    const run = this.#host.commandRunner ?? defaultRunCommand;
    let containerRunning = false;
    if (dockerExe) {
      const ps = await run(dockerExe, ["ps", "--filter", "name=^/homeassistant$", "--format", "{{.Names}}"]);
      containerRunning = ps.ok && ps.stdout.includes("homeassistant");
    }
    const port8123Reachable = await probePort8123();
    const steps: string[] = [];
    if (!orbExe && !dockerExe) {
      steps.push("1. 安装轻量容器引擎 OrbStack（macOS 首选：`brew install --cask orbstack`）并启动。");
    } else if (!containerRunning && !port8123Reachable) {
      steps.push("1. 使用本机 Docker/OrbStack 一键拉起 Home Assistant 官方稳定镜像（端口 8123，数据落在 ~/.kulo-homeassistant）。");
    } else {
      steps.push("1. 已检测到本机 Home Assistant 服务就绪（http://127.0.0.1:8123）。");
    }
    steps.push("2. 在 Home Assistant 安装小米官方无损集成 `XiaoMi/ha_xiaomi_home` 并扫码登录米家账号（原米家 App 与自动化 100% 保留不受影响）。");
    steps.push("3. 在 Home Assistant 个人资料 → 安全页生成长期访问令牌，并（可选）启用内置 Model Context Protocol Server（`/api/mcp`）。");
    steps.push("4. 将局域网地址与令牌填入 Kulo「设置 → 授权凭据 → 米家 / Home Assistant」，Kulo 将自动清洗冗余诊断实体并开启物理安防只读红线。");

    return {
      dockerAvailable: Boolean(dockerExe),
      orbStackAvailable: Boolean(orbExe),
      containerRunning,
      port8123Reachable,
      configDir: DEFAULT_CONFIG_DIR,
      steps,
    };
  }

  async deployLocalContainer(input: { confirmed: boolean; configDir?: string }): Promise<{
    requiresConfirmation?: boolean;
    advice: HomeAssistantMigrationAdvice;
    started?: boolean;
    url?: string;
  }> {
    const advice = await this.adviseMigration();
    if (!input.confirmed) {
      return { requiresConfirmation: true, advice };
    }
    const dockerExe = findBinary("docker");
    if (!dockerExe) {
      throw new Error("未检测到 docker / OrbStack CLI，请先安装并启动 OrbStack（brew install --cask orbstack）。");
    }
    const configDir = input.configDir ? path.resolve(input.configDir) : DEFAULT_CONFIG_DIR;
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
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
      advice: await this.adviseMigration(),
      started: true,
      url: "http://127.0.0.1:8123",
    };
  }

  async status(options: { includeMigration?: boolean } = {}): Promise<HomeAssistantSnapshot> {
    const cfg = await this.#host.persistedConfig();
    const token = await this.#readToken();
    return {
      enabled: cfg.enabled,
      connected: Boolean(cfg.enabled && cfg.baseUrl && token && !this.#lastError && this.#lastSyncAt !== undefined),
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      hasToken: Boolean(token),
      ...(this.#lastSyncAt !== undefined ? { mcpSupported: this.#mcpSupported } : {}),
      ...(this.#totalEntities > 0 ? { totalEntities: this.#totalEntities } : {}),
      ...(this.#entities.size > 0 ? { curatedEntities: this.#entities.size } : {}),
      ...(this.#filteredNoiseCount > 0 ? { filteredNoiseCount: this.#filteredNoiseCount } : {}),
      wsConnected: this.#wsConnected,
      ...(this.#lastSyncAt !== undefined ? { lastSyncAt: this.#lastSyncAt } : {}),
      ...(this.#lastError ? { error: this.#lastError } : {}),
      ...(options.includeMigration ? { migration: await this.adviseMigration() } : {}),
    };
  }

  #connectShadowWs(): void {
    if (this.#closed) return;
    void (async () => {
      const cfg = await this.#host.persistedConfig();
      const token = await this.#readToken();
      if (!cfg.enabled || !cfg.baseUrl || !token || this.#closed) return;
      let baseUrl: URL;
      try {
        baseUrl = validateLanHaUrl(cfg.baseUrl);
      } catch {
        return;
      }
      const wsProto = baseUrl.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProto}//${baseUrl.host}${baseUrl.pathname.replace(/\/$/, "")}/api/websocket`;
      this.#disconnectShadowWs();
      const ws = new WebSocket(wsUrl, { handshakeTimeout: 8_000 });
      this.#ws = ws;

      ws.on("message", (raw) => {
        if (this.#ws !== ws) return;
        try {
          const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          if (msg.type === "auth_required") {
            ws.send(JSON.stringify({ type: "auth", access_token: token }));
          } else if (msg.type === "auth_ok") {
            this.#wsConnected = true;
            ws.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" }));
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
    const curated = curateHomeAssistantEntities([nextState]).entities[0];
    if (!curated) return;
    const prev = this.#entities.get(curated.entityId);
    this.#entities.set(curated.entityId, curated);
    this.#lastSyncAt = Date.now();

    // Surface critical home safety alerts (smoke, gas, water leak, unlocked/alarm) as read-only events.
    if (
      this.#host.onAlertEvent &&
      prev &&
      prev.state !== curated.state &&
      ((curated.deviceClass && ["smoke", "gas", "moisture", "safety", "problem"].includes(curated.deviceClass) && curated.state === "on") ||
        (curated.domain === "alarm_control_panel" && curated.state === "triggered"))
    ) {
      this.#host.onAlertEvent({
        nativeEventId: `ha:${curated.entityId}:${Date.now()}`,
        eventVersion: "v1",
        appId: "home-assistant",
        appLabel: "智能家居",
        threadHint: curated.entityId,
        sender: curated.area || "Home Assistant",
        title: `${curated.name} 告警`,
        body: `设备「${curated.name}」状态变为 ${curated.state}（${curated.entityId}）。`,
        occurredAt: Date.now(),
        fidelity: "structured",
      });
    }
  }

  #disconnectShadowWs(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
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
  }
}
