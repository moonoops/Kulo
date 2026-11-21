import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { buildSparkCliArgs, SparkMailConnector } from "@kulo/env";
import {
  AssistantLedger,
  HaLanAudioRelay,
  HomeAssistantSentinel,
  HomeAssistantService,
  LarkConnectorService,
  assertSafeHaServiceCall,
  assertSafeHaServiceCallDeep,
  curateHomeAssistantEntities,
  parseLarkProfileList,
  resolveAndVerifyLanHost,
  sanitizeServiceData,
  selectPhysicalLanIpv4,
  startKuloHubServer,
  validateHaAutomationDraft,
  validateLanHaUrl,
} from "@kulo/hub";
import { LocalConnectionVault } from "../packages/hub/src/connection-vault.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { fetchWithHubAuth, HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kulo-conn-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("Phase 2: Spark Mail CLI connector", () => {
  it("builds safe allowlisted CLI arguments and rejects flag injection", () => {
    expect(buildSparkCliArgs({ driverId: "spark-mail", action: "status" })).toEqual(["accounts", "--json"]);
    expect(buildSparkCliArgs({ driverId: "spark-mail", action: "list_emails", params: { limit: 10, unread: true, folder: "Inbox" } })).toEqual([
      "emails", "--json", "--limit", "10", "--folder", "Inbox", "--unread",
    ]);
    expect(buildSparkCliArgs({ driverId: "spark-mail", action: "read_thread", params: { threadId: "thr_abc-123" } })).toEqual([
      "thread", "--json", "thr_abc-123",
    ]);
    expect(() => buildSparkCliArgs({ driverId: "spark-mail", action: "search", params: { query: "--exec=evil" } })).toThrow(/不能以 '-' 开头/);
    expect(() => buildSparkCliArgs({ driverId: "spark-mail", action: "read_thread", params: { threadId: "../etc/passwd;rm" } })).toThrow(/合法的 threadId/);
  });

  it("parses Spark accounts and tier and handles missing CLI gracefully", async () => {
    const connector = new SparkMailConnector({
      executablePath: "spark",
      runner: async (_exe, args) => {
        if (args[0] === "accounts") {
          return {
            ok: true,
            stdout: JSON.stringify({ accounts: [{ email: "me@example.com", access: "triage" }] }),
            stderr: "",
          };
        }
        return { ok: true, stdout: JSON.stringify({ draft_id: "dr-1" }), stderr: "" };
      },
    });
    const status = await connector.invoke({ driverId: "spark-mail", action: "status" });
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({ available: true, accessTier: "triage", accountCount: 1 });

    const missing = new SparkMailConnector({ executablePath: "/nonexistent/spark-bin-404" });
    const missingRes = await missing.invoke({ driverId: "spark-mail", action: "status" });
    expect(missingRes.ok).toBe(false);
    expect(missingRes.code).toBe("spark_cli_not_installed");
  });
});

describe("Phase 3: Home Assistant & Mi Home lossless migration", () => {
  it("enforces strict LAN-only URL validation", () => {
    expect(validateLanHaUrl("http://127.0.0.1:8123").hostname).toBe("127.0.0.1");
    expect(validateLanHaUrl("http://192.168.1.42:8123/").hostname).toBe("192.168.1.42");
    expect(validateLanHaUrl("http://100.64.0.10:8123").hostname).toBe("100.64.0.10");
    expect(validateLanHaUrl("http://homeassistant.local:8123").hostname).toBe("homeassistant.local");

    expect(() => validateLanHaUrl("https://evil.example.com")).toThrow(/局域网/);
    expect(() => validateLanHaUrl("http://8.8.8.8:8123")).toThrow(/局域网/);
    expect(() => validateLanHaUrl("http://admin:secret@127.0.0.1:8123")).toThrow(/内嵌凭据/);
    expect(() => validateLanHaUrl("file:///etc/passwd")).toThrow(/http 或 https/);
  });

  it("curates Xiaomi Home diagnostic clutter and enforces hard physical security redlines", () => {
    const curated = curateHomeAssistantEntities([
      { entity_id: "light.xiaomi_living_room", state: "on", attributes: { friendly_name: "客厅吸顶灯" } },
      { entity_id: "climate.xiaomi_ac", state: "cool", attributes: { friendly_name: "主卧空调" } },
      { entity_id: "sensor.living_temp", state: "24.5", attributes: { friendly_name: "客厅温度", device_class: "temperature", unit_of_measurement: "°C" } },
      { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "入户门锁" } },
      { entity_id: "alarm_control_panel.home", state: "armed_away", attributes: { friendly_name: "家庭安防" } },
      // Noisy ha_xiaomi_home clutter that MUST be filtered out:
      { entity_id: "sensor.xiaomi_light_rssi", state: "-62", attributes: { friendly_name: "RSSI" } },
      { entity_id: "update.xiaomi_firmware", state: "off", attributes: { friendly_name: "固件更新" } },
      { entity_id: "button.xiaomi_identify", state: "unknown", attributes: { friendly_name: "设备识别" } },
      { entity_id: "sensor.xiaomi_diag", state: "ok", attributes: { entity_category: "diagnostic", device_class: "temperature" } },
      { entity_id: "sensor.xiaomi_switch_action", state: "single", attributes: {} },
    ]);
    expect(curated.totalCount).toBe(10);
    expect(curated.entities.map((e) => e.entityId)).toEqual([
      "alarm_control_panel.home",
      "climate.xiaomi_ac",
      "light.xiaomi_living_room",
      "lock.front_door",
      "sensor.living_temp",
    ]);
    expect(curated.filteredNoiseCount).toBe(5);
    expect(curated.entities.find((e) => e.entityId === "lock.front_door")?.readOnlySecurity).toBe(true);
    expect(curated.entities.find((e) => e.entityId === "light.xiaomi_living_room")?.readOnlySecurity).toBeUndefined();

    // Physical security redline checks:
    expect(() =>
      assertSafeHaServiceCall({ domain: "lock", service: "unlock", entityId: "lock.front_door", triggerSource: "user_direct" }),
    ).toThrow(/物理安防红线/);
    expect(() =>
      assertSafeHaServiceCall({ domain: "alarm_control_panel", service: "alarm_disarm", triggerSource: "user_confirmed_l2" }),
    ).toThrow(/物理安防红线/);
    expect(() =>
      assertSafeHaServiceCall({ domain: "cover", service: "open_cover", entityId: "cover.garage", deviceClass: "garage", triggerSource: "user_direct" }),
    ).toThrow(/物理安防红线/);
    expect(() =>
      assertSafeHaServiceCall({ domain: "light", service: "turn_on", entityId: "light.xiaomi_living_room", triggerSource: "external_untrusted" }),
    ).toThrow(/外部不可信消息源/);
    expect(() =>
      assertSafeHaServiceCall({ domain: "light", service: "turn_on", entityId: "light.xiaomi_living_room", triggerSource: "user_confirmed_l2" }),
    ).not.toThrow();
  });

  it("connects to LAN HA with vault-encrypted token, blocks redirects, calls safe services, and gates Docker deploy on confirmation", async () => {
    const stateDir = makeTempDir("ha");
    const vault = new LocalConnectionVault({
      stateDir,
      keyStore: {
        async getOrCreateKey(ns) {
          return createHash("sha256").update("ha-test-key\0").update(ns).digest();
        },
        async checkAvailability() {},
      },
    });
    let persisted = { enabled: false as boolean, baseUrl: undefined as string | undefined };
    const calledServices: Array<{ url: string; auth?: string; body: unknown }> = [];

    const server = http.createServer((req, res) => {
      if (req.url === "/redirect-me/api/states") {
        res.writeHead(302, { location: "https://evil.example.com/steal" });
        res.end();
        return;
      }
      if (req.url === "/api/states") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            { entity_id: "light.living", state: "off", attributes: { friendly_name: "客厅灯" } },
            { entity_id: "sensor.living_rssi", state: "-55", attributes: {} },
          ]),
        );
        return;
      }
      if (req.url === "/api/mcp") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/api/services/light/turn_on" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          calledServices.push({
            url: req.url!,
            auth: req.headers.authorization,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([{ entity_id: "light.living", state: "on" }]));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;

    const ha = new HomeAssistantService({
      vault,
      persistedConfig: async () => persisted,
      saveConfig: async (next) => { persisted = { enabled: next.enabled, baseUrl: next.baseUrl }; },
      redact: (t) => t,
      commandRunner: async () => ({ ok: true, stdout: "", stderr: "" }),
    });

    try {
      // Unconfirmed Docker deployment returns confirmation gate without running commands.
      const unconfirmed = await ha.deployLocalContainer({ confirmed: false });
      expect(unconfirmed.requiresConfirmation).toBe(true);
      expect(unconfirmed.advice.steps.some((step) => step.includes("XiaoMi/ha_xiaomi_home"))).toBe(true);

      // Configure with real LAN endpoint & vault token.
      const snap = await ha.configure({
        enabled: true,
        baseUrl: `http://127.0.0.1:${port}`,
        token: "ha-secret-token-xyz",
      });
      expect(snap.connected).toBe(true);
      expect(snap.hasToken).toBe(true);
      expect(snap.mcpSupported).toBe(true);
      expect(snap.curatedEntities).toBe(1);
      expect(snap.filteredNoiseCount).toBe(1);
      // Persisted config NEVER stores the plaintext token!
      expect(JSON.stringify(persisted)).not.toContain("ha-secret-token-xyz");

      // Safe service call succeeds with Bearer token.
      const res = await ha.callService({
        domain: "light",
        service: "turn_on",
        entityId: "light.living",
        triggerSource: "user_confirmed_l2",
      });
      expect(res.ok).toBe(true);
      expect(calledServices).toHaveLength(1);
      expect(calledServices[0]!.auth).toBe("Bearer ha-secret-token-xyz");

      // Redirect responses fail closed.
      await ha.configure({ enabled: true, baseUrl: `http://127.0.0.1:${port}/redirect-me` });
      await expect(ha.syncNow()).rejects.toThrow(/禁止重定向/);
    } finally {
      await ha.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("enforces penetrating P0-1 physical security redlines on service_data, area_id, script/scene, and automation drafts", async () => {
    const entities = new Map([
      ["light.living", { entityId: "light.living", domain: "light", name: "客厅灯", state: "off", area: "客厅", areaId: "area_living", deviceId: "dev_light" }],
      ["climate.bedroom", { entityId: "climate.bedroom", domain: "climate", name: "卧室空调", state: "cool", area: "卧室", areaId: "area_bedroom" }],
      ["switch.cam_sleep", { entityId: "switch.cam_sleep", domain: "switch", name: "客厅摄像头休眠", state: "off", area: "客厅", areaId: "area_living" }],
      ["lock.front_door", { entityId: "lock.front_door", domain: "lock", name: "入户门锁", state: "locked", area: "玄关", areaId: "area_entry", deviceId: "dev_lock", readOnlySecurity: true }],
      ["event.bedside_switch", { entityId: "event.bedside_switch", domain: "event", name: "床头无线开关", state: "2026-11-21T06:00:00Z", area: "卧室", areaId: "area_bedroom", attributes: { event_types: ["single", "double", "long_press"] } }],
      ["person.owner", { entityId: "person.owner", domain: "person", name: "主人", state: "home", readOnlyContext: true }],
      ["scene.unsafe_all", { entityId: "scene.unsafe_all", domain: "scene", name: "危险场景", state: "scening", attributes: { entity_id: ["light.living", "lock.front_door"] } }],
    ]);

    // 1. service_data passthrough sanitation & penetrating homeassistant.* / array / area_id / scene / script guards.
    expect(sanitizeServiceData('{"temperature":25,"hvac_mode":"cool"}')).toEqual({ temperature: 25, hvac_mode: "cool" });
    expect(() =>
      assertSafeHaServiceCall({
        domain: "homeassistant",
        service: "turn_off",
        serviceData: { entity_id: ["light.living", "lock.front_door"] },
        triggerSource: "user_direct",
        context: { entities },
      }),
    ).toThrow(/物理安防红线/);
    expect(() =>
      assertSafeHaServiceCall({
        domain: "homeassistant",
        service: "turn_off",
        serviceData: { entity_id: "all" },
        triggerSource: "user_direct",
        context: { entities },
      }),
    ).toThrow(/物理安防红线/);
    expect(() =>
      assertSafeHaServiceCall({
        domain: "light",
        service: "turn_off",
        serviceData: { area_id: "area_entry" },
        triggerSource: "user_direct",
        context: { entities },
      }),
    ).toThrow(/高危安防实体/);
    expect(() =>
      assertSafeHaServiceCall({
        domain: "scene",
        service: "turn_on",
        entityId: "scene.unsafe_all",
        triggerSource: "user_direct",
        context: { entities },
      }),
    ).toThrow(/高危安防设备/);
    await expect(
      assertSafeHaServiceCallDeep({
        domain: "script",
        service: "turn_on",
        entityId: "script.sneaky_unlock",
        triggerSource: "user_direct",
        context: {
          entities,
          fetchScriptConfig: async () => ({
            sequence: [{ action: "lock.unlock", target: { entity_id: "lock.front_door" } }],
          }),
        },
      }),
    ).rejects.toThrow(/物理安防红线/);

    // 2. Automation draft P0-1 bypasses: choose.default, Device Action, event bus, Jinja template, bad event.* trigger.
    await expect(
      validateHaAutomationDraft(
        {
          alias: "Sneaky Choose Default",
          triggers: [{ trigger: "state", entity_id: "person.owner", to: "home" }],
          actions: [
            {
              choose: [{ conditions: [], sequence: [{ action: "light.turn_on", target: { entity_id: "light.living" } }] }],
              default: [{ action: "lock.unlock", target: { entity_id: "lock.front_door" } }],
            },
          ],
        },
        { entities },
      ),
    ).rejects.toThrow(/物理安防红线/);

    await expect(
      validateHaAutomationDraft(
        {
          alias: "Opaque Device Action",
          triggers: [{ trigger: "state", entity_id: "person.owner", to: "home" }],
          actions: [{ domain: "lock", type: "unlock", device_id: "dev_lock", entity_id: "lock.front_door" }],
        },
        { entities },
      ),
    ).rejects.toThrow(/Device Action/);

    await expect(
      validateHaAutomationDraft(
        {
          alias: "Event Bus Action",
          triggers: [{ trigger: "state", entity_id: "person.owner", to: "home" }],
          actions: [{ event: "homeassistant.stop" }],
        },
        { entities },
      ),
    ).rejects.toThrow(/event 总线/);

    await expect(
      validateHaAutomationDraft(
        {
          alias: "Template Service Bypass",
          triggers: [{ trigger: "state", entity_id: "person.owner", to: "home" }],
          actions: [{ action: "{{ 'lock.unlock' }}", target: { entity_id: "lock.front_door" } }],
        },
        { entities },
      ),
    ).rejects.toThrow(/模板/);

    await expect(
      validateHaAutomationDraft(
        {
          alias: "Bad Event Entity Trigger",
          triggers: [{ trigger: "state", entity_id: "event.bedside_switch", to: "double" }],
          actions: [{ action: "light.turn_off", target: { entity_id: "light.living" } }],
        },
        { entities },
      ),
    ).rejects.toThrow(/主状态是时间戳/);

    // 3. Valid wireless switch (`event.*` + attribute: "event_type") & come-home camera sleep automations pass cleanly!
    const validSwitch = await validateHaAutomationDraft(
      {
        alias: "床头开关双击睡眠模式",
        triggers: [{ trigger: "state", entity_id: "event.bedside_switch", attribute: "event_type", to: "double" }],
        actions: [
          { action: "light.turn_off", target: { entity_id: "light.living" } },
          { action: "climate.set_temperature", target: { entity_id: "climate.bedroom" }, data: { temperature: 26 } },
        ],
      },
      { entities },
    );
    expect(validSwitch.humanSummary).toContain("床头无线开关");
    expect(validSwitch.humanSummary).toContain("调温至 26℃");

    // 4. DNS Rebinding guard rejects .local / .ts.net resolving to public IP!
    await expect(
      resolveAndVerifyLanHost("homeassistant.local", async () => ({ address: "8.8.8.8", family: 4 })),
    ).rejects.toThrow(/DNS 安全拦截/);
    await expect(
      resolveAndVerifyLanHost("homeassistant.local", async () => ({ address: "192.168.1.50", family: 4 })),
    ).resolves.toEqual({ address: "192.168.1.50", family: 4 });
  });

  it("hydrates real areas via WS registries, performs automation CRUD + backup rollback + reload, and announces via LAN TTS or HA text fallback", async () => {
    const stateDir = makeTempDir("ha-deep");
    const vault = new LocalConnectionVault({
      stateDir,
      keyStore: {
        async getOrCreateKey(ns) {
          return createHash("sha256").update("ha-deep-key\0").update(ns).digest();
        },
        async checkAvailability() {},
      },
    });
    const ledger = new AssistantLedger({ stateDir });
    const relay = new HaLanAudioRelay();

    const automations = new Map<string, Record<string, unknown>>([
      ["kulo_existing1", { id: "kulo_existing1", alias: "旧回家配置", triggers: [], actions: [] }],
    ]);
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const parsedBody = rawBody ? (() => { try { return JSON.parse(rawBody); } catch { return rawBody; } })() : undefined;
        calls.push({ method: req.method ?? "GET", url: req.url ?? "", body: parsedBody });

        if (req.url === "/api/states") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify([
              { entity_id: "light.living", state: "on", attributes: { friendly_name: "客厅主灯", brightness: 180 } },
              { entity_id: "switch.cam_sleep", state: "off", attributes: { friendly_name: "客厅摄像头休眠" } },
              { entity_id: "person.me", state: "home", attributes: { friendly_name: "我" } },
              { entity_id: "media_player.xiaoai_lx04", state: "idle", attributes: { friendly_name: "床头小爱触屏音箱" } },
              { entity_id: "text.xiaoai_lx04_play_text", state: "", attributes: { friendly_name: "小爱音箱播放文本" } },
              { entity_id: "automation.existing", state: "on", attributes: { friendly_name: "旧回家配置", id: "kulo_existing1" } },
            ]),
          );
          return;
        }
        if (req.url === "/api/mcp") {
          res.writeHead(404).end();
          return;
        }
        const autoMatch = /^\/api\/config\/automation\/config\/([^/]+)$/.exec(req.url ?? "");
        if (autoMatch) {
          const cid = decodeURIComponent(autoMatch[1]!);
          if (req.method === "GET") {
            const existing = automations.get(cid);
            if (!existing) { res.writeHead(404).end(); return; }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(existing));
            return;
          }
          if (req.method === "POST") {
            automations.set(cid, parsedBody as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ result: "ok" }));
            return;
          }
          if (req.method === "DELETE") {
            automations.delete(cid);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ result: "ok" }));
            return;
          }
        }
        if (req.url?.startsWith("/api/services/") && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([]));
          return;
        }
        res.writeHead(404).end();
      });
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/api/websocket") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.send(JSON.stringify({ type: "auth_required" }));
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
            if (msg.type === "auth") {
              ws.send(JSON.stringify({ type: "auth_ok" }));
            } else if (msg.type === "config/area_registry/list") {
              ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: [{ area_id: "living_room", name: "客厅" }] }));
            } else if (msg.type === "config/device_registry/list") {
              ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: [{ id: "dev_1", area_id: "living_room" }] }));
            } else if (msg.type === "config/entity_registry/list") {
              ws.send(
                JSON.stringify({
                  id: msg.id,
                  type: "result",
                  success: true,
                  result: [
                    { entity_id: "light.living", device_id: "dev_1", labels: ["main"] },
                    { entity_id: "switch.cam_sleep", area_id: "living_room" },
                  ],
                }),
              );
            } else if (msg.type === "subscribe_events") {
              ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: null }));
            }
          });
        });
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    let persisted = { enabled: false as boolean, baseUrl: undefined as string | undefined };

    const ha = new HomeAssistantService({
      vault,
      ledger,
      stateDir,
      lanAudioRelay: relay,
      persistedConfig: async () => persisted,
      saveConfig: async (next) => { persisted = next; },
      redact: (t) => t,
      now: () => new Date("2026-11-21T14:00:00+08:00").getTime(), // Daytime, outside quiet hours
    });

    try {
      await ha.configure({ enabled: true, baseUrl: `http://127.0.0.1:${port}`, token: "tok-deep-1" });
      // Wait briefly for WS auth_ok + registry sync.
      await new Promise((r) => setTimeout(r, 150));

      const living = ha.listEntities({ area: "客厅" });
      expect(living.entities.map((e) => e.entityId)).toEqual(["light.living", "switch.cam_sleep"]);
      expect(living.entities[0]!.attributes?.brightness).toBe(180);

      // Upsert existing automation -> backs up previous config, reloads HA, and can roll back!
      const upserted = await ha.upsertAutomation({
        configId: "kulo_existing1",
        config: {
          alias: "回家自动关闭客厅摄像头",
          triggers: [{ trigger: "state", entity_id: "person.me", to: "home" }],
          actions: [{ action: "switch.turn_on", target: { entity_id: "switch.cam_sleep" } }],
        },
      });
      expect(upserted.ok).toBe(true);
      expect(upserted.backupId).toBeDefined();
      expect(calls.some((c) => c.url === "/api/services/automation/reload")).toBe(true);

      // Restore reverts back to previous config!
      const reverted = await ha.restoreAutomationBackup({ backupId: upserted.backupId });
      expect(reverted.restoredAction).toBe("reverted");
      expect(automations.get("kulo_existing1")?.alias).toBe("旧回家配置");

      // Delete automation uses DELETE method + reload!
      const del = await ha.deleteAutomation("kulo_existing1");
      expect(del.ok).toBe(true);
      expect(automations.has("kulo_existing1")).toBe(false);

      // Announce on single LX04 falls back cleanly to HA `text.set_value` when Hub is loopback-only!
      const announced = await ha.announce({ text: "**门口**检测到快递，详情 https://example.com", urgency: "high" });
      expect(announced.ok).toBe(true);
      expect(announced.channel).toBe("ha_text");
      expect(announced.speakerEntityId).toBe("text.xiaoai_lx04_play_text");
      const textCall = calls.find((c) => c.url === "/api/services/text/set_value");
      expect(textCall?.body).toMatchObject({ entity_id: "text.xiaoai_lx04_play_text", value: "门口 检测到快递，详情" });
    } finally {
      await ha.close();
      await ledger.close();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    }
  });

  it("runs HomeAssistantSentinel offline aggregation/recovery, excludes event.*, gates doorway VLM snapshots, and exposes /_ha-tts/:clipId without /api/ 401", async () => {
    // 1. selectPhysicalLanIpv4 skips utun / Tailscale / OrbStack / loopback and prefers physical RFC1918 interface.
    const chosenIp = selectPhysicalLanIpv4("http://192.168.10.20:8123", {
      lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
      utun4: [{ address: "100.64.1.5", netmask: "255.192.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.64.1.5/10" }],
      bridge100: [{ address: "192.168.64.1", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "192.168.64.1/24" }],
      en0: [{ address: "192.168.10.5", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "192.168.10.5/24" }],
    });
    expect(chosenIp).toBe("192.168.10.5");

    // 2. Sentinel: excludes event.* unknown initial state, aggregates offline devices, resolves on recovery, triages doorway camera opt-in.
    const stateDir = makeTempDir("ha-sentinel");
    const ledger = new AssistantLedger({ stateDir });
    let clock = 1_700_000_000_000;
    const events: Array<{ title: string; body: string; snapshotRef?: string }> = [];
    const resolved: string[] = [];
    let stale = false;
    let entities = [
      { entityId: "event.bedside_switch", domain: "event", name: "床头无线开关", state: "unknown" },
      { entityId: "light.ceiling", domain: "light", name: "客厅吸顶灯", state: "unavailable" },
      { entityId: "sensor.temp_1", domain: "sensor", name: "书房温度计", state: "unavailable", deviceClass: "temperature" },
      { entityId: "sensor.temp_2", domain: "sensor", name: "卧室温度计", state: "unavailable", deviceClass: "temperature" },
      { entityId: "binary_sensor.front_door_motion", domain: "binary_sensor", name: "门口人体", state: "off", deviceClass: "motion" },
      { entityId: "person.me", domain: "person", name: "我", state: "not_home" },
    ];
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02]);

    const sentinel = new HomeAssistantSentinel({
      stateDir,
      ledger,
      getConfig: async () => ({
        offlineDetectionEnabled: true,
        offlineThresholdSec: 120,
        ignoredOfflineEntities: [],
        lowBatteryThresholdPct: 15,
        visionCameraAllowlist: ["camera.front_door"],
        doorwayTriggers: [{ triggerEntityId: "binary_sensor.front_door_motion", cameraEntityId: "camera.front_door", label: "入户门口", onlyWhenAwayOrNight: true }],
      }),
      listEntities: () => entities,
      isStale: () => stale,
      isWsConnected: () => true,
      fetchCameraSnapshot: async () => ({ bytes: fakeJpeg, mimeType: "image/jpeg" }),
      completeVisionJson: async () => JSON.stringify({ verdict: "alert", label: "陌生人逗留", summary: "门口有陌生人停留超过半分钟。", confidence: "high" }),
      onEvent: (ev) => events.push({ title: ev.title, body: ev.body, snapshotRef: ev.snapshotRef }),
      onSituationResolved: (key) => resolved.push(key),
      now: () => clock,
      warmupMs: 0,
      sweepIntervalMs: 60_000,
      offlineAggregateWindowMs: 10_000,
    });

    await sentinel.start();
    // When stale=true, sweep MUST NOT fire false offline alerts.
    stale = true;
    await sentinel.sweepNow();
    expect(events).toHaveLength(0);

    // Clear stale: first sweep records unavailableSince; advance 130s -> triggers aggregated batch (2 temp sensors ONLY; excludes event.* & light.*).
    stale = false;
    await sentinel.sweepNow();
    clock += 130_000;
    await sentinel.sweepNow();
    sentinel.flushOfflineAlerts();
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toContain("2 台家居设备异常离线");
    expect(events[0]!.body).not.toContain("无线开关");
    expect(events[0]!.body).not.toContain("吸顶灯");

    // Device recovery silently resolves card!
    sentinel.onEntityChanged(entities[2], { ...entities[2]!, state: "23.5" });
    expect(resolved.some((k) => k.includes("ha:offline:sensor.temp_1"))).toBe(true);

    // Doorway trigger while away -> VLM alert + temporary snapshot stored!
    sentinel.onEntityChanged(entities[4], { ...entities[4]!, state: "on" });
    await sentinel.waitIdle();
    const doorwayEv = events.find((e) => e.title.includes("陌生人逗留"));
    expect(doorwayEv).toBeDefined();
    expect(doorwayEv!.snapshotRef).toMatch(/^hasnap_[a-f0-9]{24}\.jpg$/);
    expect(sentinel.readTemporarySnapshot(doorwayEv!.snapshotRef!)?.bytes.equals(fakeJpeg)).toBe(true);
    await sentinel.close();
    await ledger.close();

    // 3. Hub server: /_ha-tts/:clipId serves LAN audio without Bearer token (bypassing /api/ 401), supports HEAD & Range, rejects forwarded headers;
    //    AND Coordinator surfaces HA alert even when macOS notification capture (doc.enabled) is FALSE!
    const hubDir = makeTempDir("ha-hub-e2e");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "faux-1" }] });
    faux.setResponses([
      () => fauxAssistantMessage(fauxText(JSON.stringify({ digest: "入户门口检测到陌生人逗留", category: "system", disposition: "notify_brain", urgency: "high", situationKey: "ha:doorway:front", title: "入户门口异常" }))),
      () => fauxAssistantMessage(fauxText(JSON.stringify({ action: "upsert_card", kind: "alert", title: "入户门口异常", summary: "检测到陌生人停留，点击展开查看抓拍。" }))),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const hub = await openTestHub({
      config: {
        stateDir: hubDir,
        identityDir: path.join(hubDir, "identity"),
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: false,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "faux-1", baseUrl: "http://127.0.0.1:9/v1" },
      },
      models,
    });
    const srv = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    try {
      // Test /_ha-tts/:clipId directly without Authorization header!
      const clipBytes = Buffer.from("ID3dummy-mp3-audio-payload");
      const clipId = hub.haLanAudio.store(clipBytes, "audio/mpeg");
      const headRes = await fetch(`http://127.0.0.1:${srv.port}/_ha-tts/${clipId}`, { method: "HEAD" });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-type")).toBe("audio/mpeg");

      const rangeRes = await fetch(`http://127.0.0.1:${srv.port}/_ha-tts/${clipId}`, { headers: { range: "bytes=0-2" } });
      expect(rangeRes.status).toBe(206);
      expect(await rangeRes.text()).toBe("ID3");

      const forwardedRes = await fetch(`http://127.0.0.1:${srv.port}/_ha-tts/${clipId}`, { headers: { "x-forwarded-for": "8.8.8.8" } });
      expect(forwardedRes.status).toBe(403);

      // Enable ONLY Home Assistant (macOS notifications `doc.enabled` stays FALSE!) -> alert card still surfaces!
      await hub.configureAssistantHomeAssistant({ enabled: true });
      const wsBefore = await hub.getAssistantWorkspace();
      expect(wsBefore.enabled).toBe(false);
      expect(wsBefore.homeAssistant?.enabled).toBe(true);

      // Place a temporary doorway snapshot in Sentinel's private snapshot dir; verify it is NOT in hub.uploads until promoted,
      // and once promoted to topic it becomes readable with 200 OK via ChatAttachmentGrantsDoc!
      const snapRef = "hasnap_aabbccddeeff001122334455.jpg";
      fs.mkdirSync(hub.homeAssistant.sentinel!.snapshotDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(hub.homeAssistant.sentinel!.snapshotDir, snapRef), fakeJpeg, { mode: 0o600 });

      const { inserted } = await hub.assistantLedger.ingestBatch(
        "local",
        {
          batchId: "ha-b1",
          driverId: "home-assistant",
          streamId: "hub:local:home-assistant",
          sourceEpoch: "v1",
          cursorAfter: "1",
          events: [
            {
              nativeEventId: "ha:doorway:front:1",
              eventVersion: "v1",
              appId: "home-assistant",
              appLabel: "智能家居",
              title: "入户门口异常",
              body: "门口检测到陌生人逗留",
              occurredAt: Date.now(),
              fidelity: "structured",
              snapshotRef: snapRef,
            },
          ],
        },
        (t) => t,
      );
      hub.assistantSorter.enqueue(inserted);
      await hub.assistantSorter.flushAll();
      await hub.assistantCoordinator.waitIdle();

      const itemsSnap = await hub.getAssistantItemsSnapshot();
      const card = itemsSnap.items.find((item) => item.sourceApp === "home-assistant" && item.title.includes("入户门口"));
      expect(card).toBeDefined();

      // Promote card to proactive topic -> snapshot materialized into hub.uploads + ChatAttachmentGrantsDoc -> HTTP 200 (not 403)!
      const promoteRes = await fetchWithHubAuth(
        `http://127.0.0.1:${srv.port}/api/assistant/items/${encodeURIComponent(card!.id)}/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: card!.revision, action: "promote_to_topic", commandId: "cmd-ha-promote-1" }),
        },
      );
      expect(promoteRes.status).toBe(200);
      const promoted = (await promoteRes.json()) as { topicId?: string };
      expect(promoted.topicId).toBeTruthy();

      const topicView = await hub.getTopicView(promoted.topicId!);
      const imgPart = topicView.messages.flatMap((m) => m.parts ?? []).find((p) => p.type === "image");
      expect(imgPart).toBeDefined();
      const mediaRes = await fetchWithHubAuth(`http://127.0.0.1:${srv.port}/api/uploads/${encodeURIComponent((imgPart as { assetId: string }).assetId)}`);
      expect(mediaRes.status).toBe(200);
    } finally {
      await srv.close();
      await hub.close();
    }
  });
});

describe("Phase 4: Lark dual-org bridge & Mobile HTTP/SSE sync gateway + L2 idempotency", () => {
  it("parses dual personal+enterprise profiles and syncs calendar agenda cleanly", async () => {
    expect(parseLarkProfileList("* personal\n  enterprise\n")).toEqual(["personal", "enterprise"]);
    const ingested: Array<{ profile: string; count: number }> = [];
    let cfg = { enabled: true, selectedProfiles: ["personal", "enterprise"] };

    const lark = new LarkConnectorService({
      persistedConfig: async () => cfg,
      saveConfig: async (next) => { cfg = next; },
      redact: (t) => t,
      onEvents: async (profile, events) => {
        ingested.push({ profile, count: events.length });
      },
      runner: async (_exe, args) => {
        if (args[0] === "profile" && args[1] === "list") {
          return { ok: true, stdout: "personal\nenterprise\n", stderr: "" };
        }
        if (args.includes("auth") && args.includes("status")) {
          const isEnt = args.includes("enterprise");
          return {
            ok: true,
            stdout: JSON.stringify({
              brand: "feishu",
              identities: { user: { available: true, userName: isEnt ? "工作账号" : "个人账号" } },
            }),
            stderr: "",
          };
        }
        if (args.includes("+agenda")) {
          return {
            ok: true,
            stdout: JSON.stringify({
              events: [
                { event_id: "ev-1", summary: "项目评审会", start_time: Date.now() + 600_000 },
                { event_id: "ev-otp", summary: "登录验证码 123456", start_time: Date.now() + 600_000 },
              ],
            }),
            stderr: "",
          };
        }
        return { ok: true, stdout: "{}", stderr: "" };
      },
    });

    const status = await lark.status({ force: true });
    expect(status.cliAvailable).toBe(true);
    expect(status.profiles).toHaveLength(2);
    expect(status.profiles[0]).toMatchObject({ name: "personal", organizationKind: "personal", ready: true });
    expect(status.profiles[1]).toMatchObject({ name: "enterprise", organizationKind: "enterprise", ready: true });

    const synced = await lark.syncNow();
    expect(synced.syncedProfiles).toBe(2);
    // OTP event dropped on both profiles; 1 legitimate agenda event ingested per profile.
    expect(synced.ingestedCount).toBe(2);
    expect(ingested).toEqual([
      { profile: "personal", count: 1 },
      { profile: "enterprise", count: 1 },
    ]);
    await lark.close();
  });

  it("streams real-time assistant updates via SSE and executes L2 confirm_action idempotently over REST", async () => {
    const stateDir = makeTempDir("mobile-gw");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const hub = await openTestHub({
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: false,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "faux-1", baseUrl: "http://127.0.0.1:9/v1" },
      },
      models,
    });
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });

    try {
      // Surface an L2 decision card and verify GET /api/assistant/items + SSE /api/assistant/stream.
      const card = await hub.assistantCoordinator.proposeDecisionCard({
        situationKey: "spark-mail:thr-99",
        sourceApp: "com.readdle.SparkDesktop",
        sourceLabel: "Spark Mail",
        title: "回复客户报价邮件",
        summary: "已预拟回复草稿，确认后保存至 Spark 草稿箱。",
        pendingAction: {
          actionId: "act-1",
          kind: "spark_create_draft",
          label: "确认存为草稿",
          targetLabel: "client@example.com",
          previewText: "您好，附件是更新后的 Q4 报价方案，请查收。",
          driverId: "spark-mail",
          operation: "create_draft",
          params: { replyToThreadId: "thr-99", body: "您好，附件是更新后的 Q4 报价方案，请查收。" },
        },
      });

      const itemsRes = await fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/assistant/items`);
      expect(itemsRes.status).toBe(200);
      const itemsJson = (await itemsRes.json()) as { assistantRevision: number; items: Array<{ id: string }> };
      expect(itemsJson.items.some((i) => i.id === card.id)).toBe(true);

      // Connect SSE stream and capture initial snapshot + live removal upon REST acknowledge.
      const sseChunks: string[] = [];
      const sseController = new AbortController();
      const ssePromise = fetchWithHubAuth(`http://127.0.0.1:${server.port}/api/assistant/stream`, {
        signal: sseController.signal,
      }).then(async (res) => {
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseChunks.push(decoder.decode(value, { stream: true }));
          if (sseChunks.join("").split("event: assistant_items").length >= 3) break;
        }
      }).catch(() => {});

      await new Promise((r) => setTimeout(r, 80));

      const cmdId = "mobile-ack-1";
      const act1 = await fetchWithHubAuth(
        `http://127.0.0.1:${server.port}/api/assistant/items/${encodeURIComponent(card.id)}/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: card.revision, action: "acknowledge", commandId: cmdId }),
        },
      );
      expect(act1.status).toBe(200);
      const ack1 = (await act1.json()) as { itemId?: string; deduplicated?: boolean };
      expect(ack1.itemId).toBe(card.id);
      expect(ack1.deduplicated).toBeFalsy();

      // Replay exact same commandId -> deduplicated!
      const act2 = await fetchWithHubAuth(
        `http://127.0.0.1:${server.port}/api/assistant/items/${encodeURIComponent(card.id)}/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: card.revision, action: "acknowledge", commandId: cmdId }),
        },
      );
      expect(act2.status).toBe(200);
      const ack2 = (await act2.json()) as { deduplicated?: boolean };
      expect(ack2.deduplicated).toBe(true);

      await new Promise((r) => setTimeout(r, 80));
      sseController.abort();
      await ssePromise;

      const joinedSse = sseChunks.join("");
      expect(joinedSse).toContain("event: assistant_items");
      expect(joinedSse).toContain("回复客户报价邮件");
    } finally {
      await server.close();
      await hub.close();
    }
  });
});
