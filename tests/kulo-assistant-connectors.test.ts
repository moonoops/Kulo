import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { buildSparkCliArgs, SparkMailConnector } from "@kulo/env";
import {
  HomeAssistantService,
  LarkConnectorService,
  assertSafeHaServiceCall,
  curateHomeAssistantEntities,
  parseLarkProfileList,
  startKuloHubServer,
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
