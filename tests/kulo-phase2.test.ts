import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  KuloHub,
  executeHindsightTool,
  normalizeOpenAIBaseUrl,
  startKuloHubServer,
} from "@kulo/hub";
import { describeKuloError, type HindsightMemoryConfig } from "@kulo/protocol";
import { HUB_TEST_ADMIN_TOKEN, fetchWithHubAuth as fetch } from "./helpers/hub-auth";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kulo-p2-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function isOrchestratorContext(ctx: TranscriptContext): boolean {
  if (ctx.tools?.some((t) => t.name === "kulo_dispatch")) return true;
  return ctx.messages.some(
    (m) =>
      m.role === "system" &&
      "toolsAdded" in m &&
      Array.isArray(m.toolsAdded) &&
      m.toolsAdded.some((t) => t.name === "kulo_dispatch"),
  );
}

async function waitForCondition(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("Kulo Phase 2 + GUI Integration Suite", () => {
  it("1. normalizes bare OpenAI/NewAPI gateway origins automatically", () => {
    expect(normalizeOpenAIBaseUrl("https://api.example.com")).toBe("https://api.example.com/v1");
    expect(normalizeOpenAIBaseUrl("https://api.example.com/")).toBe("https://api.example.com/v1");
    expect(normalizeOpenAIBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(normalizeOpenAIBaseUrl("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("2. manages identity document CAS save, backup rollback, Root-only prompt injection, and blocks Worker identity reads", async () => {
    const stateDir = makeTempDir("identity");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let rootSystemTextCaptured = "";
    let workerSystemTextCaptured = "";
    let workerIdentityReadBlocked = false;
    let workerTurn = 0;

    faux.setResponses(
      Array.from({ length: 12 }, () => (ctx) => {
        const serializedCtx = JSON.stringify(ctx);
        if (isOrchestratorContext(ctx)) {
          rootSystemTextCaptured = serializedCtx;
          const userCombined = ctx.messages
            .filter((m) => m.role === "user")
            .map((m) => JSON.stringify(m.content))
            .join("\n");
          if (userCombined.includes("[KULO_WORKER_RELAY]")) {
            return fauxAssistantMessage([fauxText("已验证后台隔离边界。")]);
          }
          if (ctx.messages.some((m) => m.role === "toolResult")) {
            return fauxAssistantMessage([fauxText("已移交后台工程师检查。")]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_dispatch", {
                command_id: "cmd-identity-check",
                title: "测试身份文档隐私隔离",
                goal: "验证 Worker 不可读取私有身份目录",
                scope: "仅当前隔离目录",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        workerSystemTextCaptured = serializedCtx;
        workerTurn++;
        if (workerTurn === 1) {
          return fauxAssistantMessage(
            [
              fauxToolCall("read", {
                path: path.join(stateDir, "identity", "identity-agreement.md"),
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (serializedCtx.includes("Blocked access to Kulo's private identity directory")) {
          workerIdentityReadBlocked = true;
        }
        return fauxAssistantMessage(
          [
            fauxToolCall("kulo_report", {
              state: "ready",
              summary: "隔离校验完成",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN, stateDir, model: { baseUrl: "http://localhost/v1", apiMode: "openai-completions", defaultModel: "gpt-4o", thinkingLevel: "medium" } },
      models,
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      // 1) Read template before initialization
      const initialRead = await hub.identityFiles.read("identity-agreement.md");
      expect(initialRead.exists).toBe(false);
      expect(initialRead.version.sha256).toBeNull();

      // 2) Save v1 with Dual-Sign confirmation
      const v1 = await hub.identityFiles.save({
        file: "identity-agreement.md",
        expected: initialRead.version,
        content: "# Identity Agreement\nSECRET_NICKNAME=KakaBoss\n",
        summary: "初始化个人称呼",
        dualSignConfirmed: true,
      });
      expect(v1.unchanged).toBe(false);
      expect(v1.backupId).toBeTruthy();

      // 3) Stale CAS must fail with 409
      await expect(
        hub.identityFiles.save({
          file: "identity-agreement.md",
          expected: initialRead.version,
          content: "stale overwrite",
          summary: "冲突测试",
          dualSignConfirmed: true,
        }),
      ).rejects.toMatchObject({ status: 409 });

      // 4) Save v2 and rollback to v1
      const v2 = await hub.identityFiles.save({
        file: "identity-agreement.md",
        expected: v1.version,
        content: "# Identity Agreement\nSECRET_NICKNAME=ChangedName\n",
        summary: "第二次更新",
        dualSignConfirmed: true,
      });
      expect(v2.backupId).toBeTruthy();

      await hub.identityFiles.rollback({
        file: "identity-agreement.md",
        expected: v2.version,
        backupId: v2.backupId!,
        summary: "回滚至 KakaBoss",
        dualSignConfirmed: true,
      });
      const afterRollback = await hub.identityFiles.read("identity-agreement.md");
      expect(afterRollback.content).toContain("SECRET_NICKNAME=KakaBoss");

      // 5) Trigger Root + Worker turn and verify identity document is injected ONLY into Root and blocked in Worker!
      await hub.sendUserMessage("开始隔离检查");
      await waitForCondition(async () => {
        const snap = await hub.getBoardSnapshot();
        return snap.tickets[0]?.status === "ready";
      });

      expect(rootSystemTextCaptured).toContain("SECRET_NICKNAME=KakaBoss");
      expect(workerSystemTextCaptured).not.toContain("SECRET_NICKNAME=KakaBoss");
      expect(workerIdentityReadBlocked).toBe(true);

      // 6) Verify Server serves built @kulo/web GUI & Settings CAS + Rollback
      const indexRes = await fetch(server.url);
      expect(indexRes.status).toBe(200);
      const html = await indexRes.text();
      expect(html).toContain('<div id="root"></div>');

      const getSettingsRes = await fetch(`${server.url}/api/settings`);
      const initialSettings = (await getSettingsRes.json()) as {
        globalRevision: number;
        blocks: { presentation: { revision: number; value: { agentName: string } } };
      };
      expect(initialSettings.blocks.presentation.value.agentName).toBe("Kulo");

      const updateRes = await fetch(`${server.url}/api/settings/presentation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: initialSettings.blocks.presentation.revision,
          value: { agentName: "墨 (Kulo)", workbenchName: "咔咔的工作台" },
        }),
      });
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as {
        settings: { globalRevision: number; blocks: { presentation: { value: { agentName: string } } } };
      };
      expect(updated.settings.blocks.presentation.value.agentName).toBe("墨 (Kulo)");

      const rbRes = await fetch(`${server.url}/api/settings/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toRevision: updated.settings.globalRevision,
          expectedGlobalRevision: updated.settings.globalRevision,
        }),
      });
      expect(rbRes.status).toBe(200);
      const rolledBack = (await rbRes.json()) as {
        settings: { blocks: { presentation: { value: { agentName: string } } } };
      };
      expect(rolledBack.settings.blocks.presentation.value.agentName).toBe("Kulo");
    } finally {
      await server.close();
      await hub.close();
    }
  });

  it("3. enforces Hindsight dual-bank (kulo-core / kulo-shared) role isolation, secret guard, and live probe", async () => {
    const retainedByBank: Record<string, Array<Record<string, unknown>>> = {
      "kulo-core": [],
      "kulo-shared": [],
    };

    const mockHindsight = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const role = req.headers.authorization === "Bearer hs-router-test-token-00000000000001"
        ? "router"
        : req.headers.authorization === "Bearer hs-worker-test-token-00000000000001"
          ? "worker"
          : null;
      if (!role) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "Unauthorized" }));
        return;
      }

      if (url.pathname === "/v1/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ api_version: "0.8.6" }));
        return;
      }

      if (url.pathname === "/v1/kulo/access" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          policyVersion: 1,
          role,
          banks: {
            private: { id: "kulo-core", read: role === "router", write: role === "router" },
            shared: { id: "kulo-shared", read: true, write: role === "worker" },
          },
        }));
        return;
      }

      const bankMatch = /^\/v1\/default\/banks\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (bankMatch) {
        const bank = decodeURIComponent(bankMatch[1]!);
        const sub = bankMatch[2]!;

        if ((role === "worker" && bank !== "kulo-shared") ||
            (role === "router" && bank === "kulo-shared" && req.method !== "GET" && sub !== "memories/recall")) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ detail: "Forbidden" }));
          return;
        }

        if (req.method === "GET" && sub.startsWith("documents")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ items: [], total: 0 }));
          return;
        }

        if (req.method === "POST" && sub === "memories") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(Buffer.from(c));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            items: Array<Record<string, unknown>>;
            operation_id: string;
          };
          retainedByBank[bank] ??= [];
          retainedByBank[bank]!.push(...body.items);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ success: true, async: true, operation_id: body.operation_id }));
          return;
        }

        if (req.method === "POST" && sub === "memories/recall") {
          const items = retainedByBank[bank] ?? [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              results: items.map((it, idx) => ({
                id: `mem-${idx}`,
                text: it.content,
                tags: it.tags,
              })),
            }),
          );
          return;
        }
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not Found" }));
    });

    await new Promise<void>((resolve) => mockHindsight.listen(0, "127.0.0.1", () => resolve()));
    const port = (mockHindsight.address() as { port: number }).port;

    const memConfig: HindsightMemoryConfig = {
      enabled: true,
      endpoint: `http://127.0.0.1:${port}`,
      endpoints: [],
      caCertPem: "",
      routerApiKey: "hs-router-test-token-00000000000001",
      workerApiKey: "hs-worker-test-token-00000000000001",
      routerApiKeyEnv: "KULO_HINDSIGHT_ROUTER_API_KEY",
      workerApiKeyEnv: "KULO_HINDSIGHT_WORKER_API_KEY",
      authFile: "",
      autoAttachTopLevelRouters: true,
      banks: {
        private: "kulo-core",
        shared: "kulo-shared",
      },
    };

    try {
      const stateDir = makeTempDir("hindsight");
      const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
      const models = createModels();
      models.setProvider(faux.provider);

      const hub = await openTestHub({
        config: { authToken: HUB_TEST_ADMIN_TOKEN, stateDir, memory: memConfig },
        models,
      });

      try {
        // 1) Probe health check
        const probe = await hub.probeMemory();
        expect(probe.healthy).toBe(true);
        expect(probe.version).toBe("0.8.6");
        expect(probe.privateBankOk).toBe(true);
        expect(probe.sharedBankOk).toBe(true);
        expect(probe.isolationVerified).toBe(true);
        expect(probe.workerPrivateDenied).toBe(true);
        expect(probe.routerSharedWriteDenied).toBe(true);

        // 2) Router writes to `private` (kulo-core) -> ALLOWED
        const routerPrivWrite = await executeHindsightTool({
          toolName: "hindsight_ingest_document",
          args: { title: "User Preference", content: "Prefers concise Chinese summaries." },
          bank: "private",
          config: memConfig,
          caller: { role: "router", conversationId: "root" },
        });
        expect(routerPrivWrite.isError).toBeUndefined();
        expect(retainedByBank["kulo-core"]).toHaveLength(1);

        // 3) Router attempts to write to `shared` (kulo-shared) -> STRICTLY FORBIDDEN
        const routerSharedWrite = await executeHindsightTool({
          toolName: "hindsight_ingest_document",
          args: { title: "Leak Attempt", content: "Should never enter shared bank" },
          bank: "shared",
          config: memConfig,
          caller: { role: "router", conversationId: "root" },
        });
        expect(routerSharedWrite.isError).toBe(true);
        expect(routerSharedWrite.text).toContain("FORBIDDEN");
        expect(retainedByBank["kulo-shared"]).toHaveLength(0);

        // 4) Worker attempts to read `private` (kulo-core) -> STRICTLY FORBIDDEN
        const workerPrivRead = await executeHindsightTool({
          toolName: "hindsight_recall",
          args: { query: "User Preference" },
          bank: "private",
          config: memConfig,
          caller: {
            role: "worker",
            conversationId: "conv-2",
            ticketId: "T-0001",
            workerRole: "engineer",
          },
        });
        expect(workerPrivRead.isError).toBe(true);
        expect(workerPrivRead.text).toContain("FORBIDDEN");

        // 5) Worker writes & recalls `shared` (kulo-shared) -> ALLOWED & stamped with ticket:T-0001
        const workerSharedWrite = await executeHindsightTool({
          toolName: "hindsight_ingest_document",
          args: { title: "Repo Architecture", content: "Uses Pi Durable SQLite WAL storage." },
          bank: "shared",
          config: memConfig,
          caller: {
            role: "worker",
            conversationId: "conv-2",
            ticketId: "T-0001",
            workerRole: "engineer",
          },
        });
        expect(workerSharedWrite.isError).toBeUndefined();
        expect(retainedByBank["kulo-shared"]).toHaveLength(1);
        expect(retainedByBank["kulo-shared"]![0]!.tags).toContain("ticket:T-0001");
        expect(retainedByBank["kulo-shared"]![0]!.tags).toContain("application:kulo");

        // 6) Router reads `shared` (kulo-shared) -> ALLOWED
        const routerSharedRead = await executeHindsightTool({
          toolName: "hindsight_recall",
          args: { query: "SQLite WAL" },
          bank: "shared",
          config: memConfig,
          caller: { role: "router", conversationId: "root" },
        });
        expect(routerSharedRead.isError).toBeUndefined();
        expect(routerSharedRead.text).toContain("Uses Pi Durable SQLite WAL storage.");

        // 7) Secret leak guard blocks sk-... API keys
        const unsafeWrite = await executeHindsightTool({
          toolName: "hindsight_ingest_document",
          args: {
            title: "Accidental Secret",
            content: "My token is sk-1234567890abcdefghijklmnop",
          },
          bank: "private",
          config: memConfig,
          caller: { role: "router", conversationId: "root" },
        });
        expect(unsafeWrite.isError).toBe(true);
        expect(unsafeWrite.text).toContain("UNSAFE_CONTENT");
      } finally {
        await hub.close();
      }
    } finally {
      await new Promise<void>((resolve) => mockHindsight.close(() => resolve()));
    }
  });

  it("4. supports multi-topic CRUD, auto-title, originTopicId scoping, dispatch card ordering, and usage stats", async () => {
    const stateDir = makeTempDir("topics");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    faux.setResponses(
      Array.from({ length: 10 }, () => (ctx) => {
        if (isOrchestratorContext(ctx)) {
          const userCombined = ctx.messages
            .filter((m) => m.role === "user")
            .map((m) => JSON.stringify(m.content))
            .join("\n");
          if (userCombined.includes("[KULO_WORKER_RELAY]")) {
            return fauxAssistantMessage([fauxText("新话题下的任务已完成。")]);
          }
          if (ctx.messages.some((m) => m.role === "toolResult")) {
            return fauxAssistantMessage([fauxText("已为你安排工程师推进。")]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_dispatch", {
                command_id: "cmd-topic-task",
                title: "重构动画曲线配置",
                user_summary: "提取弹簧过渡变量",
                goal: "完成配置整理",
                scope: "当前隔离目录",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        return fauxAssistantMessage(
          [
            fauxToolCall("kulo_report", {
              state: "ready",
              summary: "动画曲线配置已整理完毕",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        model: {
          baseUrl: "http://localhost/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "medium",
        },
      },
      models,
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      // 1) Create new draft topic via REST
      const createRes = await fetch(`${server.url}/api/topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as { id: string; title: string; draft?: boolean };
      expect(created.draft).toBe(true);

      // 2) Send message to new topic -> auto-renames topic & dispatches ticket scoped to created.id
      await hub.sendUserMessage("帮我重构动画曲线配置", { topicId: created.id });

      await waitForCondition(async () => {
        const view = await hub.getTopicView(created.id);
        return (
          view.messages.some((m) => m.role === "dispatch") &&
          view.messages.filter((m) => m.role === "assistant" && m.text.trim()).length >= 2 &&
          !view.live.busy
        );
      });

      const topicsAfter = await hub.listTopics();
      const updatedTopic = topicsAfter.find((t) => t.id === created.id)!;
      expect(updatedTopic.title).toBe("帮我重构动画曲线配置");
      expect(updatedTopic.draft).toBeUndefined();

      // 3) Preserve the actual dispatch before Kulo's acknowledgement in display order.
      const topicView = await hub.getTopicView(created.id);
      const firstAssistantIdx = topicView.messages.findIndex(
        (m) => m.role === "assistant" && m.text.includes("已为你安排工程师推进"),
      );
      const dispatchIdx = topicView.messages.findIndex((m) => m.role === "dispatch");
      expect(firstAssistantIdx).toBeGreaterThanOrEqual(0);
      expect(dispatchIdx).toBeGreaterThanOrEqual(0);
      expect(firstAssistantIdx).toBeGreaterThan(dispatchIdx);

      // 4) Verify ticket carries originTopicId
      const board = await hub.getBoardSnapshot();
      expect(board.tickets[0]?.originTopicId).toBe(created.id);

      // 5) Verify Usage API
      const usageRes = await fetch(`${server.url}/api/usage?range=today`);
      expect(usageRes.status).toBe(200);
      const usage = (await usageRes.json()) as { turns: number };
      expect(usage.turns).toBeGreaterThan(0);

      // 6) Patch & Delete non-master topic
      const patchRes = await fetch(`${server.url}/api/topics/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      expect(patchRes.status).toBe(200);

      const delRes = await fetch(`${server.url}/api/topics/${created.id}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);
      const remaining = await hub.listTopics();
      expect(remaining.some((t) => t.id === created.id)).toBe(false);
    } finally {
      await server.close();
      await hub.close();
    }
  });

  it("5. supports file/image upload API, SVG XSS hardening, multimodal ImageContent, and ChatDisplayItem attachments", async () => {
    const stateDir = makeTempDir("uploads");
    const faux = fauxProvider({
      provider: "openai",
      models: [{ id: "gpt-4o", input: ["text", "image"] }],
    });
    const models = createModels();
    models.setProvider(faux.provider);

    const capturedUserContents: unknown[] = [];
    faux.setResponses(
      Array.from({ length: 4 }, () => (ctx) => {
        const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user");
        if (lastUser) {
          capturedUserContents.push(lastUser.content);
        }
        return fauxAssistantMessage([fauxText("已收到图片和附件内容。")]);
      }),
    );

    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        model: {
          baseUrl: "http://localhost/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "medium",
        },
      },
      models,
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const mdContent = "# Kulo Upload Note\nhello attachment!";
      const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

      // 1) Raw binary PNG upload
      const pngUploadRes = await fetch(`${server.url}/api/uploads?name=screenshot.png`, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: pngBytes,
      });
      expect(pngUploadRes.status).toBe(201);
      const { attachment: pngAtt } = (await pngUploadRes.json()) as {
        attachment: { id: string; name: string; mimeType: string; size: number; kind: string; url: string };
      };
      expect(pngAtt.kind).toBe("image");
      expect(pngAtt.mimeType).toBe("image/png");
      expect(pngAtt.size).toBe(pngBytes.byteLength);

      // 2) JSON base64 Markdown upload
      const mdUploadRes = await fetch(`${server.url}/api/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "notes.md",
          mimeType: "text/markdown",
          dataBase64: Buffer.from(mdContent, "utf8").toString("base64"),
        }),
      });
      expect(mdUploadRes.status).toBe(201);
      const { attachment: mdAtt } = (await mdUploadRes.json()) as {
        attachment: { id: string; name: string; mimeType: string; size: number; kind: string; url: string };
      };
      expect(mdAtt.kind).toBe("file");
      expect(mdAtt.mimeType).toBe("text/markdown");

      // 3) SVG must be downgraded to non-vision downloadable file with nosniff
      const svgUploadRes = await fetch(`${server.url}/api/uploads?name=diagram.svg`, {
        method: "POST",
        headers: { "Content-Type": "image/svg+xml" },
        body: Buffer.from(svgContent, "utf8"),
      });
      expect(svgUploadRes.status).toBe(201);
      const { attachment: svgAtt } = (await svgUploadRes.json()) as {
        attachment: { id: string; kind: string; url: string };
      };
      expect(svgAtt.kind).toBe("file");

      const svgGetRes = await fetch(`${server.url}${svgAtt.url}`);
      expect(svgGetRes.status).toBe(200);
      expect(svgGetRes.headers.get("x-content-type-options")).toBe("nosniff");
      expect(svgGetRes.headers.get("content-disposition")).toContain("attachment");

      const pngGetRes = await fetch(`${server.url}${pngAtt.url}`);
      expect(pngGetRes.status).toBe(200);
      expect(pngGetRes.headers.get("x-content-type-options")).toBe("nosniff");
      expect(pngGetRes.headers.get("content-disposition")).toContain("inline");
      expect(Buffer.from(await pngGetRes.arrayBuffer())).toEqual(pngBytes);

      // 4) Send multimodal message with PNG + Markdown file
      await hub.sendUserMessage("请分析截图和文档", {
        topicId: "root",
        attachments: [
          { ...pngAtt, kind: "image" },
          { ...mdAtt, kind: "file" },
        ],
      });

      await waitForCondition(async () => {
        const view = await hub.getTopicView("root");
        return view.messages.some((m) => m.role === "assistant") && !view.live.busy;
      });

      const firstContent = capturedUserContents[0];
      expect(Array.isArray(firstContent)).toBe(true);
      const blocks = firstContent as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
      expect(
        blocks.some(
          (b) => b.type === "image" && b.mimeType === "image/png" && b.data === pngBytes.toString("base64"),
        ),
      ).toBe(true);
      expect(
        blocks.some(
          (b) => b.type === "text" && b.text?.includes('<file_content name="notes.md">'),
        ),
      ).toBe(true);

      const rootView = await hub.getTopicView("root");
      const userItem = rootView.messages.find((m) => m.role === "user")!;
      expect(userItem.text).toBe("请分析截图和文档");
      expect(userItem.text).not.toContain("kulo-attachments");
      expect(userItem.text).not.toContain("file_content");
      expect(userItem.attachments).toHaveLength(2);
      expect(userItem.attachments?.[0]?.id).toBe(pngAtt.id);
      expect(userItem.attachments?.[1]?.id).toBe(mdAtt.id);

      // 5) Image-only message without text derives draft topic title from filename
      const draftTopic = await hub.createTopic();
      await hub.sendUserMessage("", {
        topicId: draftTopic.id,
        attachments: [{ ...pngAtt, kind: "image" }],
      });
      await waitForCondition(async () => {
        const view = await hub.getTopicView(draftTopic.id);
        return view.messages.some((m) => m.role === "assistant") && !view.live.busy;
      });
      const topicList = await hub.listTopics();
      const updated = topicList.find((t) => t.id === draftTopic.id)!;
      expect(updated.title).toBe("screenshot.png");
      const imageOnlyUser = (await hub.getTopicView(draftTopic.id)).messages.find(
        (m) => m.role === "user",
      )!;
      expect(imageOnlyUser.text).toBe("");
      expect(imageOnlyUser.attachments?.[0]?.id).toBe(pngAtt.id);
    } finally {
      await server.close();
      await hub.close();
    }
  });

  it("9. classifies upstream/model errors into friendly Chinese diagnostics and redacts secrets", () => {
    const tos403 = describeKuloError({
      reason: "model_error",
      detail:
        '403: {"message":"This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.","type":"upstream_error","param":"","code":403}',
      modelId: "gemini-4-hydrogen-xhigh",
    });
    expect(tos403.kind).toBe("upstream_disabled");
    expect(tos403.statusCode).toBe(403);
    expect(tos403.title).toBe("上游模型通道当前不可用");
    expect(tos403.hint).toContain("gemini-4-hydrogen-xhigh");
    expect(tos403.hint).toContain("并非图片或附件上传失败");
    expect(tos403.suggestModelSettings).toBe(true);
    expect(tos403.isUserAbort).toBe(false);
    expect(tos403.rawDetail).toContain("upstream_error");

    const authUnavailable503 = describeKuloError({
      reason: "model_error",
      detail:
        '503: {"error":{"message":"auth_unavailable: no auth available (providers=antigravity)","type":"server_error"}}',
      modelId: "gemini-4-hydrogen-xhigh",
    });
    expect(authUnavailable503.kind).toBe("upstream_disabled");
    expect(authUnavailable503.statusCode).toBe(503);

    const authLeak = describeKuloError({
      reason: "model_error",
      detail: "401: Incorrect API key provided: sk-abcdefgh1234567890",
    });
    expect(authLeak.kind).toBe("auth");
    expect(authLeak.statusCode).toBe(401);
    expect(authLeak.rawDetail).toContain("sk-••••");
    expect(authLeak.rawDetail).not.toContain("1234567890");

    const userAbort = describeKuloError({ reason: "aborted" });
    expect(userAbort.isUserAbort).toBe(true);
    expect(userAbort.kind).toBe("user_abort");

    const cutoffAbort = describeKuloError({
      reason: "aborted",
      detail: "restart cutoff",
    });
    expect(cutoffAbort.isUserAbort).toBe(false);
    expect(cutoffAbort.kind).toBe("interrupted");

    const turnLimit = describeKuloError({ reason: "turn_limit" });
    expect(turnLimit.kind).toBe("turn_limit");
    expect(turnLimit.retryable).toBe(true);
  });

  it("10. retries an unanswered failed turn via POST /api/topics/:id/retry without duplicating user input", async () => {
    const stateDir = makeTempDir("turn-retry");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          '403: {"message":"This service has been disabled in this account for violation of Terms of Service.","type":"upstream_error","code":403}',
      }),
      fauxAssistantMessage([fauxText("这张图片是绿色的。")]),
    ]);

    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        enableLocalEnv: false,
        model: {
          baseUrl: "http://localhost/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "medium",
        },
      },
      models,
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      await hub.sendUserMessage("请用一句话说出这张图片是什么颜色？", {
        topicId: "root",
      });

      await waitForCondition(async () => {
        const view = await hub.getTopicView("root");
        return !view.live.busy && Boolean(view.live.runFailure);
      });

      const failedView = await hub.getTopicView("root");
      expect(failedView.live.runFailure?.reason).toBe("model_error");
      expect(typeof failedView.live.runFailure?.taskId).toBe("number");
      expect(failedView.live.runFailure?.detail).toContain("403");
      expect(failedView.messages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(failedView.messages.filter((m) => m.role === "assistant")).toHaveLength(0);

      const retryRes = await fetch(`${server.url}/api/topics/root/retry`, {
        method: "POST",
      });
      expect(retryRes.status).toBe(200);
      const retryJson = (await retryRes.json()) as { retried: boolean };
      expect(retryJson.retried).toBe(true);

      await waitForCondition(async () => {
        const view = await hub.getTopicView("root");
        return !view.live.busy && view.messages.some((m) => m.role === "assistant");
      });

      const recoveredView = await hub.getTopicView("root");
      expect(recoveredView.live.runFailure).toBeUndefined();
      expect(recoveredView.messages.filter((m) => m.role === "user")).toHaveLength(1);
      const assistantMsg = recoveredView.messages.find((m) => m.role === "assistant")!;
      expect(assistantMsg.text).toContain("这张图片是绿色的。");
    } finally {
      await server.close();
      await hub.close();
    }
  });

  it("11. probes OpenAI-compatible gateway /models & completions with credential-leak guard", async () => {
    const stateDir = makeTempDir("model-probe");
    const recordedAuthHeaders: Array<{ url: string; auth?: string }> = [];

    const mockGateway = http.createServer(async (req, res) => {
      recordedAuthHeaders.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
      });

      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "gemini-4-hydrogen-xhigh" },
              { id: "gpt-6-astra" },
            ],
          }),
        );
        return;
      }

      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model?: string;
        };
        if (body.model === "gemini-4-hydrogen-xhigh") {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              message:
                "This service has been disabled in this account for violation of Terms of Service.",
              type: "upstream_error",
              code: 403,
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-probe",
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    const otherHostGateway = http.createServer((req, res) => {
      recordedAuthHeaders.push({
        url: `other:${req.url ?? ""}`,
        auth: req.headers.authorization,
      });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
    });

    await Promise.all([
      new Promise<void>((resolve) => mockGateway.listen(0, "127.0.0.1", () => resolve())),
      new Promise<void>((resolve) =>
        otherHostGateway.listen(0, "127.0.0.1", () => resolve()),
      ),
    ]);

    const mockAddr = mockGateway.address() as { port: number };
    const otherAddr = otherHostGateway.address() as { port: number };
    const savedGatewayUrl = `http://127.0.0.1:${mockAddr.port}/v1`;
    const otherGatewayUrl = `http://127.0.0.1:${otherAddr.port}/v1`;

    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-6-astra" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        enableLocalEnv: false,
        model: {
          baseUrl: savedGatewayUrl,
          apiKey: "sk-saved-secret-key-do-not-leak",
          apiMode: "openai-completions",
          defaultModel: "gemini-4-hydrogen-xhigh",
          thinkingLevel: "medium",
        },
      },
      models,
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      // 1) Disabled model reports friendly Chinese error + still returns discovered availableModels
      const disabledRes = await fetch(`${server.url}/api/model/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-4-hydrogen-xhigh" }),
      });
      expect(disabledRes.status).toBe(200);
      const disabledProbe = (await disabledRes.json()) as {
        ok: boolean;
        title?: string;
        error?: string;
        availableModels: string[];
      };
      expect(disabledProbe.ok).toBe(false);
      expect(disabledProbe.title).toBe("上游模型通道当前不可用");
      expect(disabledProbe.error).toContain("gemini-4-hydrogen-xhigh");
      expect(disabledProbe.availableModels).toEqual([
        "gemini-4-hydrogen-xhigh",
        "gpt-6-astra",
      ]);

      // 2) Healthy model on same configured gateway reuses saved key & succeeds
      const okRes = await fetch(`${server.url}/api/model/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6-astra" }),
      });
      expect(okRes.status).toBe(200);
      const okProbe = (await okRes.json()) as {
        ok: boolean;
        model: string;
        availableModels: string[];
      };
      expect(okProbe.ok).toBe(true);
      expect(okProbe.model).toBe("gpt-6-astra");
      expect(
        recordedAuthHeaders.some(
          (r) =>
            r.url === "/v1/chat/completions" &&
            r.auth === "Bearer sk-saved-secret-key-do-not-leak",
        ),
      ).toBe(true);

      // 3) Probing a different baseUrl without explicit apiKey MUST NOT forward saved apiKey
      const otherRes = await fetch(`${server.url}/api/model/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: otherGatewayUrl,
          model: "gpt-6-astra",
        }),
      });
      expect(otherRes.status).toBe(200);
      const otherProbe = (await otherRes.json()) as {
        ok: boolean;
        title?: string;
        error?: string;
      };
      expect(otherProbe.ok).toBe(false);
      expect(otherProbe.title).toBe("需要重新输入接口密钥");
      const leakedRequests = recordedAuthHeaders.filter(
        (r) => r.url.startsWith("other:") && r.auth !== undefined,
      );
      expect(leakedRequests).toHaveLength(0);
    } finally {
      await server.close();
      await hub.close();
      await Promise.all([
        new Promise<void>((resolve) => mockGateway.close(() => resolve())),
        new Promise<void>((resolve) => otherHostGateway.close(() => resolve())),
      ]);
    }
  });

  it("12. manages PI Providers catalog, 0600 API key storage, OAuth session lifecycle, and split model/worker/concurrency settings", async () => {
    const stateDir = makeTempDir("providers-settings");
    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        enableLocalEnv: false,
        model: { gatewayDisabled: false },
      },
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      // 1) Provider catalog lists gateway and built-in OAuth/API-key providers
      const listRes = await fetch(`${server.url}/api/providers`);
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as {
        providers: Array<{
          id: string;
          builtin: boolean;
          isGateway?: boolean;
          supportsApiKey: boolean;
          supportsOAuth: boolean;
          authenticated: boolean;
        }>;
      };
      const ids = new Set(listData.providers.map((p) => p.id));
      expect(ids.has("kulo-gateway")).toBe(true);
      expect(listData.providers.find((p) => p.id === "openai")?.supportsOAuth).toBe(true);
      expect(listData.providers.find((p) => p.id === "anthropic")?.supportsApiKey).toBe(
        true,
      );

      // 2) Store API Key into 0o600 credentials.json & verify zero secret leaks in API outputs
      const saveKeyRes = await fetch(`${server.url}/api/providers/anthropic/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-ant-super-secret-999" }),
      });
      expect(saveKeyRes.status).toBe(200);
      const saveKeyJson = (await saveKeyRes.json()) as {
        provider: { id: string; authenticated: boolean; authType?: string };
      };
      expect(saveKeyJson.provider.authenticated).toBe(true);
      expect(saveKeyJson.provider.authType).toBe("api_key");

      const credPath = path.join(stateDir, "credentials.json");
      expect(fs.existsSync(credPath)).toBe(false);
      const encryptedCredentials = path.join(stateDir, "connection-vault.json");
      expect(fs.statSync(encryptedCredentials).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(encryptedCredentials, "utf8")).not.toContain("sk-ant-super-secret-999");

      const providersRaw = await (await fetch(`${server.url}/api/providers`)).text();
      const settingsRaw = await (await fetch(`${server.url}/api/settings`)).text();
      expect(providersRaw).not.toContain("sk-ant-super-secret-999");
      expect(settingsRaw).not.toContain("sk-ant-super-secret-999");

      // 3) Logout provider clears credential
      const logoutRes = await fetch(`${server.url}/api/providers/anthropic/auth`, {
        method: "DELETE",
      });
      expect(logoutRes.status).toBe(200);
      const afterLogout = (await (await fetch(`${server.url}/api/providers`)).json()) as {
        providers: Array<{ id: string; authenticated: boolean }>;
      };
      expect(afterLogout.providers.find((p) => p.id === "anthropic")?.authenticated).toBe(
        false,
      );

      // 4) Interactive OAuth session start -> poll -> cancel lifecycle (with Chinese localization)
      const oauthStartRes = await fetch(
        `${server.url}/api/providers/openai/oauth/start`,
        { method: "POST" },
      );
      expect(oauthStartRes.status).toBe(200);
      const startedOAuth = (await oauthStartRes.json()) as {
        session: {
          sessionId: string;
          providerId: string;
          status: string;
          instructions?: string;
          prompt?: { message: string };
        };
      };
      expect(startedOAuth.session.sessionId).toBeTruthy();
      expect(startedOAuth.session.providerId).toBe("openai");
      expect(startedOAuth.session.instructions).toBeUndefined();
      if (startedOAuth.session.prompt) {
        expect(startedOAuth.session.prompt.message).toBe("回调链接");
      }

      const codexOAuthStart = await fetch(
        `${server.url}/api/providers/openai-codex/oauth/start`,
        { method: "POST" },
      );
      expect(codexOAuthStart.status).toBe(200);
      const codexStarted = (await codexOAuthStart.json()) as {
        session: {
          sessionId: string;
          prompt?: { message: string; options?: Array<{ id: string; label: string }> };
        };
      };
      expect(codexStarted.session.prompt?.message).toBe("授权方式");
      expect(codexStarted.session.prompt?.options?.map((o) => o.label)).toEqual([
        "浏览器授权",
        "设备码授权",
      ]);
      await fetch(
        `${server.url}/api/providers/oauth/${encodeURIComponent(codexStarted.session.sessionId)}/cancel`,
        { method: "POST" },
      );

      const pollRes = await fetch(
        `${server.url}/api/providers/oauth/${encodeURIComponent(startedOAuth.session.sessionId)}`,
      );
      expect(pollRes.status).toBe(200);

      const cancelRes = await fetch(
        `${server.url}/api/providers/oauth/${encodeURIComponent(startedOAuth.session.sessionId)}/cancel`,
        { method: "POST" },
      );
      expect(cancelRes.status).toBe(200);
      const cancelled = (await cancelRes.json()) as {
        session: { status: string };
      };
      expect(["cancelled", "failed"]).toContain(cancelled.session.status);

      // 5) Split settings: model (with customProviders & contextWindow/compaction), roles (custom + auto), executor
      const curSettings = (await (await fetch(`${server.url}/api/settings`)).json()) as {
        blocks: {
          model: { revision: number; value: Record<string, unknown> };
          roles: { revision: number; value: Record<string, Record<string, unknown>> };
          executor: { revision: number; value: Record<string, unknown> };
        };
      };

      const modelRes = await fetch(`${server.url}/api/settings/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: curSettings.blocks.model.revision,
          value: {
            ...curSettings.blocks.model.value,
            contextWindow: 160_000,
            compaction: {
              enabled: true,
              reserveTokens: 12_000,
              keepRecentTokens: 20_000,
              backgroundTokens: 40_000,
            },
            customProviders: [
              {
                id: "my-compat",
                name: "My Compat",
                api: "openai-completions",
                baseUrl: "https://compat.example.com/v1",
                models: [{ id: "compat-coder", contextWindow: 200_000 }],
              },
              {
                id: "openai",
                name: "Attempted Overwrite",
                api: "openai-completions",
                baseUrl: "https://evil.example.com/v1",
                models: [],
              },
            ],
          },
        }),
      });
      expect(modelRes.status).toBe(200);

      const postCustomCatalog = (await (
        await fetch(`${server.url}/api/providers`)
      ).json()) as {
        providers: Array<{
          id: string;
          builtin: boolean;
          supportsOAuth: boolean;
          models: Array<{ id: string }>;
        }>;
      };
      const myCompat = postCustomCatalog.providers.find((p) => p.id === "my-compat");
      expect(myCompat).toBeDefined();
      expect(myCompat?.builtin).toBe(false);
      expect(myCompat?.models.some((m) => m.id === "compat-coder")).toBe(true);
      const officialOpenai = postCustomCatalog.providers.find((p) => p.id === "openai");
      expect(officialOpenai?.builtin).toBe(true);
      expect(officialOpenai?.supportsOAuth).toBe(true);

      const rolesRes = await fetch(`${server.url}/api/settings/roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: curSettings.blocks.roles.revision,
          value: {
            ...curSettings.blocks.roles.value,
            reviewer: {
              id: "reviewer",
              label: "审查员",
              whenToUse: "做代码审查时调用",
              prompt: "仔细审核安全与逻辑边界",
              readOnly: true,
              thinkingLevel: "auto",
              enabled: true,
            },
          },
        }),
      });
      expect(rolesRes.status).toBe(200);
      const rolesJson = (await rolesRes.json()) as {
        settings: {
          blocks: {
            roles: {
              value: Record<string, { thinkingLevel?: string; readOnly?: boolean }>;
            };
          };
        };
      };
      expect(rolesJson.settings.blocks.roles.value.reviewer?.thinkingLevel).toBe("auto");
      expect(rolesJson.settings.blocks.roles.value.reviewer?.readOnly).toBe(true);

      const execRes = await fetch(`${server.url}/api/settings/executor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: curSettings.blocks.executor.revision,
          value: {
            maxConcurrentWorkers: 6,
            paused: false,
            watchdogMinutes: 10,
          },
        }),
      });
      expect(execRes.status).toBe(200);
      const execJson = (await execRes.json()) as {
        settings: {
          blocks: {
            executor: {
              value: {
                maxConcurrentWorkers: number;
                maxSubagentsPerTicket: number;
                paused: boolean;
                watchdogMinutes: number;
              };
            };
          };
        };
      };
      expect(execJson.settings.blocks.executor.value).toEqual({
        maxConcurrentWorkers: 6,
        maxSubagentsPerTicket: 4,
        paused: false,
        watchdogMinutes: 10,
        completedTaskDisplayHours: 3,
        autoArchiveEnabled: true,
        autoArchiveDays: 7,
      });
    } finally {
      await server.close();
      await hub.close();
    }
  });

  it("13. supports mainstream preset custom providers, modalities/256K/64K/thinkingLevelMap, and origin-safe discover-models", async () => {
    const mockSeenAuth: Array<string | undefined> = [];
    const mockServer = http.createServer((req, res) => {
      mockSeenAuth.push(req.headers.authorization);
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [{ id: "deepseek-reasoner" }, { id: "my-custom-256k" }],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const mockAddr = mockServer.address();
    const mockUrl =
      mockAddr && typeof mockAddr === "object"
        ? `http://127.0.0.1:${mockAddr.port}`
        : "";

    const evilSeenAuth: Array<string | undefined> = [];
    const evilServer = http.createServer((req, res) => {
      evilSeenAuth.push(req.headers.authorization);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "evil-model" }] }));
    });
    await new Promise<void>((resolve) => evilServer.listen(0, "127.0.0.1", resolve));
    const evilAddr = evilServer.address();
    const evilUrl =
      evilAddr && typeof evilAddr === "object"
        ? `http://127.0.0.1:${evilAddr.port}`
        : "";

    const stateDir = makeTempDir("models-workbench");
    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        enableLocalEnv: false,
        // Keep this catalog fixture independent of the user's .env and selected model.
        model: {
          baseUrl: `${mockUrl}/v1`, apiMode: "openai-completions", apiKey: "",
          defaultProvider: "kulo-gateway", defaultModel: "fixture-gateway-model",
        },
      },
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      // 1) Direct discover-models call against upstream /models endpoint
      const discoverRes = await fetch(`${server.url}/api/providers/discover-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api: "openai-completions",
          baseUrl: `${mockUrl}/v1`,
          apiKey: "sk-discover-test",
        }),
      });
      expect(discoverRes.status).toBe(200);
      const discoverData = (await discoverRes.json()) as {
        ok: boolean;
        models: Array<{
          id: string;
          modalities: string[];
          contextWindow: number;
          maxTokens: number;
        }>;
      };
      expect(discoverData.ok).toBe(true);
      expect(mockSeenAuth).toContain("Bearer sk-discover-test");
      const customDiscovered = discoverData.models.find((m) => m.id === "my-custom-256k");
      expect(customDiscovered).toBeDefined();
      expect(customDiscovered?.contextWindow).toBe(256_000);
      expect(customDiscovered?.maxTokens).toBe(64_000);
      expect(customDiscovered?.modalities).toEqual(["text"]);

      // 2) Persist preset provider + modalities + thinkingLevelMap + Google clamping + mock-compat
      const curSettings = (await (await fetch(`${server.url}/api/settings`)).json()) as {
        blocks: { model: { revision: number; value: Record<string, unknown> } };
      };
      const saveModelRes = await fetch(`${server.url}/api/settings/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: curSettings.blocks.model.revision,
          value: {
            ...curSettings.blocks.model.value,
            customProviders: [
              {
                id: "api-deepseek",
                name: "DeepSeek",
                preset: "deepseek",
                api: "openai-completions",
                baseUrl: "https://api.deepseek.com/v1",
                models: [
                  {
                    id: "deepseek-reasoner",
                    modalities: ["text", "image", "video"],
                    contextWindow: 256_000,
                    maxTokens: 64_000,
                    reasoning: true,
                    thinkingLevelMap: {
                      minimal: null,
                      low: "low",
                      medium: null,
                      high: "high",
                      xhigh: "high",
                      max: null,
                    },
                  },
                ],
              },
              {
                id: "api-gemini-custom",
                name: "Gemini Custom",
                api: "google-generative-ai",
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                models: [
                  {
                    id: "gemini-custom",
                    modalities: ["text", "image"],
                    contextWindow: 256_000,
                    maxTokens: 64_000,
                    reasoning: true,
                    thinkingLevelMap: {
                      xhigh: "xhigh",
                      max: "max",
                    },
                  },
                ],
              },
              {
                id: "mock-compat",
                name: "Mock Compat",
                api: "openai-completions",
                baseUrl: `${mockUrl}/v1`,
                models: [{ id: "my-custom-256k" }],
              },
            ],
          },
        }),
      });
      expect(saveModelRes.status).toBe(200);

      // 3) Catalog serializes preset, modalities, 256K/64K, filtered supportedThinkingLevels & Gemini clamping
      const catalog = (await (await fetch(`${server.url}/api/providers`)).json()) as {
        providers: Array<{
          id: string;
          builtin: boolean;
          preset?: string;
          models: Array<{
            id: string;
            modalities: string[];
            contextWindow: number;
            maxTokens: number;
            supportedThinkingLevels: string[];
            thinkingLevelMap?: Record<string, string | null>;
          }>;
        }>;
      };
      const officialDeepSeek = catalog.providers.find((p) => p.id === "deepseek");
      expect(officialDeepSeek?.builtin).toBe(true);

      const apiDeepSeek = catalog.providers.find((p) => p.id === "api-deepseek");
      expect(apiDeepSeek?.builtin).toBe(false);
      expect(apiDeepSeek?.preset).toBe("deepseek");
      const dsReasoner = apiDeepSeek?.models.find((m) => m.id === "deepseek-reasoner");
      expect(dsReasoner?.modalities).toEqual(["text", "image", "video"]);
      expect(dsReasoner?.contextWindow).toBe(256_000);
      expect(dsReasoner?.maxTokens).toBe(64_000);
      expect(dsReasoner?.supportedThinkingLevels).toContain("low");
      expect(dsReasoner?.supportedThinkingLevels).toContain("high");
      expect(dsReasoner?.supportedThinkingLevels).toContain("xhigh");
      expect(dsReasoner?.supportedThinkingLevels).not.toContain("medium");
      expect(dsReasoner?.supportedThinkingLevels).not.toContain("max");

      const geminiProvider = catalog.providers.find((p) => p.id === "api-gemini-custom");
      const geminiModel = geminiProvider?.models.find((m) => m.id === "gemini-custom");
      expect(geminiModel?.thinkingLevelMap?.xhigh).toBe("high");
      expect(geminiModel?.thinkingLevelMap?.max).toBe("high");

      // 4) Origin-mismatch guard: saved key is NOT forwarded to different origin in discover-models
      const saveKeyRes = await fetch(`${server.url}/api/providers/mock-compat/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-saved-mock-secret" }),
      });
      expect(saveKeyRes.status).toBe(200);

      await fetch(`${server.url}/api/providers/discover-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "mock-compat",
          api: "openai-completions",
          baseUrl: `${evilUrl}/v1`,
        }),
      });
      expect(evilSeenAuth.some((h) => h?.includes("sk-saved-mock-secret"))).toBe(false);

      await fetch(`${server.url}/api/providers/discover-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "mock-compat",
          api: "openai-completions",
        }),
      });
      expect(mockSeenAuth).toContain("Bearer sk-saved-mock-secret");

      // 5) Default gateway has no hardcoded placeholder models and modal-open discover reuses saved gateway key
      const preGateway = catalog.providers.find((p) => p.id === "kulo-gateway");
      expect(preGateway?.models.some((m) => m.id === "deepseek-chat")).toBe(false);
      expect(preGateway?.models.some((m) => m.id === "deepseek-reasoner")).toBe(false);
      expect(preGateway?.models.some((m) => m.id === "gpt-4o-mini")).toBe(false);
      expect(preGateway?.models).toHaveLength(1);
      expect(preGateway?.models.map(model => model.id)).toEqual(["fixture-gateway-model"]);

      const latestSettings = (await (await fetch(`${server.url}/api/settings`)).json()) as {
        blocks: { model: { revision: number; value: Record<string, unknown> } };
      };
      const cfgGatewayRes = await fetch(`${server.url}/api/settings/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: latestSettings.blocks.model.revision,
          value: {
            ...latestSettings.blocks.model.value,
            baseUrl: `${mockUrl}/v1`,
            apiKey: "sk-gateway-saved-live",
          },
        }),
      });
      expect(cfgGatewayRes.status).toBe(200);

      const gwDiscoverRes = await fetch(`${server.url}/api/providers/discover-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "kulo-gateway",
          api: "openai-completions",
          baseUrl: `${mockUrl}/v1`,
        }),
      });
      expect(gwDiscoverRes.status).toBe(200);
      const gwDiscoverJson = (await gwDiscoverRes.json()) as {
        ok: boolean;
        models: Array<{ id: string }>;
      };
      expect(gwDiscoverJson.ok).toBe(true);
      expect(mockSeenAuth).toContain("Bearer sk-gateway-saved-live");
      expect(gwDiscoverJson.models.map((m) => m.id)).toEqual([
        "deepseek-reasoner",
        "my-custom-256k",
      ]);
    } finally {
      await server.close();
      await hub.close();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      await new Promise<void>((resolve) => evilServer.close(() => resolve()));
    }
  });

  it("14. exposes all 9 lazy-oauth subscription providers and all 10 pi-ai CustomProviderApi formats across gateway, customProviders, and discover-models", async () => {
    const requestedUrls: string[] = [];
    const mockServer = http.createServer((req, res) => {
      requestedUrls.push(req.url ?? "");
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [{ id: "mistral-large-latest" }, { id: "devstral-small-2505" }],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const mockAddr = mockServer.address();
    const mockUrl =
      mockAddr && typeof mockAddr === "object"
        ? `http://127.0.0.1:${mockAddr.port}`
        : "";

    const stateDir = makeTempDir("all-apis-oauth");
    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        enableLocalEnv: false,
        model: { gatewayDisabled: false },
      },
    });
    const server = await startKuloHubServer(hub, { port: 0 });

    try {
      // 1) All 9 built-in lazy-oauth providers exist with supportsOAuth=true and unauthenticated by default
      const initialCatalog = (await (await fetch(`${server.url}/api/providers`)).json()) as {
        providers: Array<{
          id: string;
          builtin: boolean;
          supportsOAuth: boolean;
          authenticated: boolean;
        }>;
      };
      const expectedOAuthIds = [
        "openai-codex",
        "openai",
        "anthropic",
        "openrouter",
        "github-copilot",
        "kimi-coding",
        "xai",
        "meta",
        "radius",
      ];
      for (const id of expectedOAuthIds) {
        const entry = initialCatalog.providers.find((p) => p.id === id);
        expect(entry).toBeDefined();
        expect(entry?.builtin).toBe(true);
        expect(entry?.supportsOAuth).toBe(true);
        expect(entry?.authenticated).toBe(false);
      }

      // 2) Configure kulo-gateway with non-OpenAI pi-ai API ("anthropic-messages") & save customProviders with all newly unlocked APIs
      const curSettings = (await (await fetch(`${server.url}/api/settings`)).json()) as {
        blocks: { model: { revision: number; value: Record<string, unknown> } };
      };
      const saveRes = await fetch(`${server.url}/api/settings/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: curSettings.blocks.model.revision,
          value: {
            ...curSettings.blocks.model.value,
            apiMode: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            defaultProvider: "kulo-gateway",
            defaultModel: "claude-sonnet-4-5",
            gatewayModels: [{ id: "claude-sonnet-4-5" }],
            customProviders: [
              {
                id: "api-mistral",
                name: "Mistral",
                preset: "mistral",
                api: "mistral-conversations",
                baseUrl: "https://api.mistral.ai",
                models: [{ id: "mistral-large-latest" }],
              },
              {
                id: "vertex-custom",
                name: "Vertex AI",
                api: "google-vertex",
                baseUrl: "https://us-central1-aiplatform.googleapis.com",
                models: [
                  {
                    id: "gemini-2.5-pro",
                    reasoning: true,
                    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
                  },
                ],
              },
              {
                id: "pi-custom",
                name: "Pi Messages",
                api: "pi-messages",
                baseUrl: "https://api.radius.dev",
                models: [{ id: "pi-default" }],
              },
              {
                id: "bedrock-custom",
                name: "Bedrock",
                api: "bedrock-converse-stream",
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                models: [{ id: "us.anthropic.claude-sonnet-4-5-v1:0" }],
              },
            ],
          },
        }),
      });
      expect(saveRes.status).toBe(200);
      const savedData = (await saveRes.json()) as {
        settings: {
          blocks: {
            model: {
              value: {
                apiMode: string;
                baseUrl: string;
              };
            };
          };
        };
      };
      expect(savedData.settings.blocks.model.value.apiMode).toBe("anthropic-messages");
      expect(savedData.settings.blocks.model.value.baseUrl).toBe("https://api.anthropic.com");

      // 3) Verify gateway + custom providers serialize accurately including Google Vertex thinking clamping
      const updatedCatalog = (await (await fetch(`${server.url}/api/providers`)).json()) as {
        providers: Array<{
          id: string;
          isGateway?: boolean;
          api?: string;
          baseUrl?: string;
          models: Array<{
            id: string;
            api?: string;
            thinkingLevelMap?: Record<string, string | null>;
          }>;
        }>;
      };
      const gw = updatedCatalog.providers.find((p) => p.id === "kulo-gateway");
      expect(gw?.isGateway).toBe(true);
      expect(gw?.api).toBe("anthropic-messages");
      expect(gw?.baseUrl).toBe("https://api.anthropic.com");

      const mistral = updatedCatalog.providers.find((p) => p.id === "api-mistral");
      expect(mistral?.api).toBe("mistral-conversations");
      expect(mistral?.baseUrl).toBe("https://api.mistral.ai");

      const vertex = updatedCatalog.providers.find((p) => p.id === "vertex-custom");
      expect(vertex?.api).toBe("google-vertex");
      const vertexModel = vertex?.models.find((m) => m.id === "gemini-2.5-pro");
      expect(vertexModel?.thinkingLevelMap?.xhigh).toBe("high");
      expect(vertexModel?.thinkingLevelMap?.max).toBe("high");

      expect(updatedCatalog.providers.find((p) => p.id === "pi-custom")?.api).toBe("pi-messages");
      expect(updatedCatalog.providers.find((p) => p.id === "bedrock-custom")?.api).toBe(
        "bedrock-converse-stream",
      );

      // 4) discover-models accepts expanded CustomProviderApi formats (e.g. mistral-conversations -> /v1/models)
      const discoverRes = await fetch(`${server.url}/api/providers/discover-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api: "mistral-conversations",
          baseUrl: mockUrl,
          apiKey: "sk-mistral-test",
        }),
      });
      expect(discoverRes.status).toBe(200);
      const discoverJson = (await discoverRes.json()) as {
        ok: boolean;
        models: Array<{ id: string }>;
      };
      expect(discoverJson.ok).toBe(true);
      expect(requestedUrls).toContain("/v1/models");
      expect(discoverJson.models.some((m) => m.id === "mistral-large-latest")).toBe(true);

      // 5) openai-codex OAuth start -> select prompt -> respond("browser") immediately settles authUrl + manual_code -> cancel
      const codexStartRes = await fetch(`${server.url}/api/providers/openai-codex/oauth/start`, {
        method: "POST",
      });
      expect(codexStartRes.status).toBe(200);
      const codexStartJson = (await codexStartRes.json()) as {
        session: {
          sessionId: string;
          providerId: string;
          status: string;
          prompt?: {
            id: string;
            type: string;
            options?: Array<{ id: string; label: string }>;
          };
        };
      };
      expect(codexStartJson.session.providerId).toBe("openai-codex");
      expect(codexStartJson.session.status).toBe("pending");
      expect(codexStartJson.session.prompt?.type).toBe("select");
      expect(
        codexStartJson.session.prompt?.options?.some((o) => o.id === "browser"),
      ).toBe(true);

      const respondRes = await fetch(
        `${server.url}/api/providers/oauth/${codexStartJson.session.sessionId}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            promptId: codexStartJson.session.prompt?.id,
            value: "browser",
          }),
        },
      );
      expect(respondRes.status).toBe(200);
      const respondJson = (await respondRes.json()) as {
        session: {
          status: string;
          authUrl?: string;
          prompt?: { id: string; type: string };
        };
      };
      expect(respondJson.session.status).toBe("pending");
      expect(respondJson.session.authUrl).toMatch(/^https:\/\/auth\.openai\.com\//);
      expect(respondJson.session.prompt?.type).toBe("manual_code");

      const cancelCodexRes = await fetch(
        `${server.url}/api/providers/oauth/${codexStartJson.session.sessionId}/cancel`,
        { method: "POST" },
      );
      expect(cancelCodexRes.status).toBe(200);
      const cancelCodexJson = (await cancelCodexRes.json()) as {
        session: { status: string };
      };
      expect(cancelCodexJson.session.status).toBe("cancelled");

      // 6) Legacy apiMode alias ("responses") normalizes to "openai-responses" on POST /api/settings/model
      const curForLegacy = (await (await fetch(`${server.url}/api/settings`)).json()) as {
        blocks: { model: { revision: number; value: Record<string, unknown> } };
      };
      const legacyRes = await fetch(`${server.url}/api/settings/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: curForLegacy.blocks.model.revision,
          value: {
            ...curForLegacy.blocks.model.value,
            apiMode: "responses",
          },
        }),
      });
      expect(legacyRes.status).toBe(200);
      const legacyJson = (await legacyRes.json()) as {
        settings: { blocks: { model: { value: { apiMode: string } } } };
      };
      expect(legacyJson.settings.blocks.model.value.apiMode).toBe("openai-responses");
    } finally {
      await server.close();
      await hub.close();
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  it("15. supports 6 default Worker presets, parallel & stateful kulo_subagent collaboration, maxSubagentsPerTicket cap, and checker readOnly scratchDir isolation", async () => {
    const stateDir = makeTempDir("subagents-and-scratch");
    const projectRepoDir = makeTempDir("audited-repo");
    fs.mkdirSync(path.join(projectRepoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRepoDir, "src", "auth.ts"),
      "export const verify = (t: string) => t.length > 0;\n",
      "utf8",
    );

    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let subagentToolsObserved: string[][] = [];
    let archTurn = 0;
    let coderSubTurn = 0;
    let checkerTurn = 0;
    let checkerWorkspaceWriteBlocked = false;
    let checkerSubEscalationBlocked = false;

    const extractToolTexts = (ctx: TranscriptContext): string =>
      ctx.messages
        .filter((m) => m.role === "toolResult")
        .map((m) => JSON.stringify(m.content))
        .join("\n");

    faux.setResponses(
      Array.from({ length: 28 }, () => (ctx) => {
        if (isOrchestratorContext(ctx)) {
          return fauxAssistantMessage([fauxText("后台团队协作与检验均已完成。")]);
        }

        const systemStr = JSON.stringify(
          ctx.messages.filter((m) => m.role === "system"),
        );
        const isSubagent = systemStr.includes("# Subagent Mandate —");
        if (isSubagent) {
          const offered = (ctx.tools ?? []).map((t) => t.name);
          if (offered.length > 0) subagentToolsObserved.push(offered);

          if (systemStr.includes("escalate-coder")) {
            const prevTools = extractToolTexts(ctx);
            if (!prevTools) {
              return fauxAssistantMessage(
                [
                  fauxToolCall("write", {
                    path: "src/auth.ts",
                    content: "// hacked by subagent\n",
                  }),
                ],
                { stopReason: "toolUse" },
              );
            }
            if (prevTools.includes("is read-only for project workspace")) {
              checkerSubEscalationBlocked = true;
            }
            return fauxAssistantMessage([
              fauxText("确认继承了父级只读限制，无法修改业务源码。"),
            ]);
          }

          if (systemStr.includes("api-coder")) {
            coderSubTurn++;
            if (coderSubTurn === 1) {
              return fauxAssistantMessage([
                fauxText("已完成第 1 版模块草稿实现。"),
              ]);
            }
            return fauxAssistantMessage([
              fauxText("已在第 1 版基础上补充了空值边界校验并复测通过。"),
            ]);
          }

          return fauxAssistantMessage([
            fauxText("侦察完毕：核心入口位于 src/auth.ts 第 1 行。"),
          ]);
        }

        // Top-level `architect` ticket
        if (systemStr.includes("(`Architect`, `architect`)")) {
          archTurn++;
          if (archTurn === 1) {
            // Exceed maxSubagentsPerTicket=2 on purpose first
            return fauxAssistantMessage(
              [
                fauxToolCall("kulo_subagent", {
                  tasks: [
                    { name: "s1", role: "scout", goal: "查模块1" },
                    { name: "s2", role: "scout", goal: "查模块2" },
                    { name: "s3", role: "scout", goal: "查模块3" },
                  ],
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (archTurn === 2) {
            expect(extractToolTexts(ctx)).toContain("exceeds maxSubagentsPerTicket (2)");
            // Fan out 2 parallel subagents within limit
            return fauxAssistantMessage(
              [
                fauxToolCall("kulo_subagent", {
                  tasks: [
                    { name: "auth-scout", role: "scout", goal: "定位鉴权入口" },
                    { name: "api-coder", role: "coder", goal: "编写初版实现" },
                  ],
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (archTurn === 3) {
            // Multi-turn stateful follow-up to `api-coder` by name!
            return fauxAssistantMessage(
              [
                fauxToolCall("kulo_subagent", {
                  tasks: [
                    {
                      name: "api-coder",
                      goal: "请根据侦察结果继续补齐空值校验",
                    },
                  ],
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          const combinedToolResults = extractToolTexts(ctx);
          expect(combinedToolResults).toContain("续接队友");
          expect(combinedToolResults).toContain("补充了空值边界校验");
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_report", {
                state: "ready",
                summary: "架构师已完成并行摸底与多轮子智能体协作。",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        // Top-level `checker` ticket
        checkerTurn++;
        const scratchMatch = /Scratch Directory: `([^`]+)`/.exec(systemStr);
        const scratchDir = scratchMatch?.[1]?.trim() ?? "";
        if (checkerTurn === 1) {
          // 1) Try modifying business source code -> MUST BE BLOCKED
          return fauxAssistantMessage(
            [
              fauxToolCall("write", {
                path: "src/auth.ts",
                content: "// unauthorized edit\n",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (checkerTurn === 2) {
          if (extractToolTexts(ctx).includes("is read-only for project workspace")) {
            checkerWorkspaceWriteBlocked = true;
          }
          // 2) Write process checklist & audit report into isolated scratchDir -> MUST SUCCEED
          return fauxAssistantMessage(
            [
              fauxToolCall("write", {
                path: path.join(scratchDir, "checklist.md"),
                content: "- [x] src/auth.ts 长度校验检查完毕\n",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (checkerTurn === 3) {
          // 3) Try privilege escalation by spawning `coder` subagent from readOnly `checker`
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_subagent", {
                tasks: [
                  {
                    name: "escalate-coder",
                    role: "coder",
                    goal: "尝试能否修改业务文件",
                  },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage(
          [
            fauxToolCall("kulo_report", {
              state: "ready",
              summary: "大项目全量检验完成，源码零改动，核查清单已写入草稿箱。",
              deliverable: path.join(scratchDir, "checklist.md"),
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        localEnvRoot: projectRepoDir,
        maxSubagentsPerTicket: 2,
        model: {
          baseUrl: "http://localhost/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "off",
        },
      },
      models,
    });

    try {
      // 1) Verify all 6 built-in Worker presets are present with expected defaults
      const settingsView = hub.getSettingsView();
      const roles = settingsView.blocks.roles.value;
      expect(Object.keys(roles)).toEqual([
        "scout",
        "architect",
        "coder",
        "checker",
        "designer",
        "writer",
      ]);
      expect(roles.scout?.label).toBe("Scout");
      expect(roles.scout?.readOnly).toBe(true);
      expect(roles.scout?.allowSubagents).toBe(false);
      expect(roles.architect?.allowSubagents).toBe(true);
      expect(roles.coder?.label).toBe("Coder");
      expect(roles.coder?.allowSubagents).toBe(true);
      expect(roles.checker?.label).toBe("Checker");
      expect(roles.checker?.readOnly).toBe(true);
      expect(roles.checker?.allowSubagents).toBe(true);
      expect(roles.designer?.label).toBe("Designer");
      expect(roles.writer?.label).toBe("Writer");
      expect(settingsView.blocks.executor.value.maxSubagentsPerTicket).toBe(2);

      // 2) Run `architect` ticket with parallel fan-out + stateful teammate re-turn
      const archCard = await hub.dispatchTicket({
        commandId: "cmd-arch-team",
        title: "跨模块鉴权架构协同",
        goal: "摸底并协调实现",
        scope: "项目范围",
        role: "architect",
        workspaceDir: projectRepoDir,
      });

      await waitForCondition(async () => {
        const d = await hub.inspectTicketDetail(archCard.id);
        return d.ticket.status === "ready";
      });

      // Subagents never expose kulo_subagent or kulo_report (depth = 1)
      for (const toolNames of subagentToolsObserved) {
        expect(toolNames).not.toContain("kulo_subagent");
        expect(toolNames).not.toContain("kulo_report");
      }

      // 3) Run `checker` ticket on projectRepoDir: verify workspaceDir stays untouched & scratchDir has checklist.md
      const checkerCard = await hub.dispatchTicket({
        commandId: "cmd-checker-audit",
        title: "大项目全量复核",
        goal: "独立复核鉴权实现并记录核查清单",
        scope: "只读复核全仓",
        role: "checker",
        workspaceDir: projectRepoDir,
      });

      await waitForCondition(async () => {
        const d = await hub.inspectTicketDetail(checkerCard.id);
        return d.ticket.status === "ready";
      });

      expect(checkerWorkspaceWriteBlocked).toBe(true);
      expect(checkerSubEscalationBlocked).toBe(true);
      expect(
        fs.readFileSync(path.join(projectRepoDir, "src", "auth.ts"), "utf8"),
      ).toBe("export const verify = (t: string) => t.length > 0;\n");

      const checkerDetail = await hub.inspectTicketDetail(checkerCard.id);
      const scratchChecklist = path.join(
        checkerDetail.ticket.scratchDir!,
        "checklist.md",
      );
      expect(fs.existsSync(scratchChecklist)).toBe(true);
      expect(fs.readFileSync(scratchChecklist, "utf8")).toContain(
        "src/auth.ts 长度校验检查完毕",
      );
      // Repo directory itself has zero untracked checklist files!
      expect(fs.existsSync(path.join(projectRepoDir, "checklist.md"))).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it("16. cascades stopTicket to running subagents and preserves custom role deletions across restarts", async () => {
    const stateDir = makeTempDir("subagent-cascade-stop");
    let subagentAborted = false;
    let notifySubagentStarted!: () => void;
    const subagentStarted = new Promise<void>((resolve) => {
      notifySubagentStarted = resolve;
    });

    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    faux.setResponses(
      Array.from({ length: 12 }, () => async (ctx, opts) => {
        if (isOrchestratorContext(ctx)) {
          return fauxAssistantMessage([fauxText("ok")]);
        }
        const sys = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
        if (sys.includes("# Subagent Mandate —")) {
          notifySubagentStarted();
          await new Promise<void>((resolve) => {
            const sig = (opts as { signal?: AbortSignal } | undefined)?.signal;
            if (sig?.aborted) {
              subagentAborted = true;
              resolve();
              return;
            }
            sig?.addEventListener(
              "abort",
              () => {
                subagentAborted = true;
                resolve();
              },
              { once: true },
            );
            setTimeout(resolve, 4000);
          });
          return fauxAssistantMessage([fauxText("done")]);
        }

        return fauxAssistantMessage(
          [
            fauxToolCall("kulo_subagent", {
              tasks: [{ name: "long-scout", role: "scout", goal: "长耗时扫描" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub1 = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        model: {
          baseUrl: "http://localhost/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "off",
        },
      },
      models,
    });

    try {
      const card = await hub1.dispatchTicket({
        commandId: "cmd-stop-cascade",
        title: "测试级联停止子智能体",
        goal: "拉起长耗时子智能体",
        scope: "当前目录",
        role: "architect",
      });

      await subagentStarted;
      const stopped = await hub1.stopTicket(card.id, "手动停止测试");
      expect(stopped.status).toBe("stopped");
      await waitForCondition(() => subagentAborted, 3000);
      expect(subagentAborted).toBe(true);

      // Delete one built-in role (`writer`) and verify it stays deleted after Hub restart
      const view = hub1.getSettingsView();
      const { writer: _removed, ...fiveRoles } = view.blocks.roles.value;
      await hub1.updateSettingsBlock("roles", view.blocks.roles.revision, fiveRoles);
    } finally {
      await hub1.close();
    }

    const hub2 = await openTestHub({
      config: { authToken: HUB_TEST_ADMIN_TOKEN,
        stateDir,
        enableLocalEnv: false,
      },
      models,
    });
    try {
      const afterRestartRoles = hub2.getSettingsView().blocks.roles.value;
      expect(Object.keys(afterRestartRoles)).toEqual([
        "scout",
        "architect",
        "coder",
        "checker",
        "designer",
      ]);
      expect(afterRestartRoles.writer).toBeUndefined();
    } finally {
      await hub2.close();
    }
  });
});
