import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  HTML_DIAGRAM_BROWSER_CSP,
  HTML_DIAGRAM_CSP,
  type ChatAttachment,
} from "@kulo/protocol";
import { createMediaHttpHandler } from "../packages/hub/src/media-http.js";
import { inspectAssetContent } from "../packages/hub/src/asset-inspection.js";
import { KuloUploadStore } from "../packages/hub/src/uploads.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

const SAMPLE_SVG = `<svg viewBox="0 0 640 260">
  <defs>
    <marker id="arrow" viewBox="0 0 8 6" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="var(--d-muted)"/>
    </marker>
  </defs>
  <line x1="200" y1="120" x2="400" y2="120" stroke="var(--d-muted)" stroke-width="1.25" marker-end="url(#arrow)"/>
  <rect x="40" y="92" width="160" height="56" rx="6" fill="var(--d-accent-tint)" stroke="var(--d-accent)" stroke-width="1.5"/>
  <text x="120" y="124" text-anchor="middle" font-size="13" fill="var(--d-ink)">订单创建</text>
  <rect x="400" y="92" width="160" height="56" rx="6" fill="var(--d-paper)" stroke="var(--d-ink)" stroke-width="1"/>
  <text x="480" y="124" text-anchor="middle" font-size="13" fill="var(--d-ink)">支付确认</text>
</svg>`;

describe("Hub inline diagram publication, CSP serving, privacy, and topic-file isolation", () => {
  it("publishes inline diagram in same assistant reply, excludes it from conversation files, indexes fallbackText, and serves pinned CSP", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-inline-diagram-"));
    cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    const requests: TranscriptContext[] = [];
    let callNum = 0;
    const provider = fauxProvider({ provider: "diagram-test", models: [{ id: "test" }] });
    provider.setResponses(Array.from({ length: 10 }, () => (request: TranscriptContext) => {
      requests.push(JSON.parse(JSON.stringify(request)) as TranscriptContext);
      callNum++;
      if (callNum === 1) {
        return fauxAssistantMessage([
          fauxToolCall("kulo_skill_read", { id: "diagram-design" }),
        ], { stopReason: "toolUse" });
      }
      if (callNum === 2) {
        return fauxAssistantMessage([
          fauxText("先说结论：订单从创建直接流向支付确认。"),
          fauxToolCall("kulo_ui_diagram", {
            title: "订单状态流转图",
            svg: SAMPLE_SVG,
            fallback_text: "订单创建 -> 支付确认（两阶段状态机摘要）",
            caption: "主链路状态示意",
            motion: "none",
          }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxText("如图所示，链路保持线性简洁。")]);
    }));

    const models = createModels();
    models.setProvider(provider.provider);
    const hub = await openTestHub({
      models,
      providerId: "diagram-test",
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "diagram-test", defaultModel: "test", thinkingLevel: "off" },
      },
    });
    cleanup.push(() => hub.close());

    const topic = await hub.createTopic("架构讨论");
    const submitted = await hub.sendUserMessage("画一下订单流转", { topicId: topic.id });
    await submitted.wait(BACKGROUND_CONTEXT);

    const messages = (await hub.getTopicView(topic.id)).messages;
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    const diagramMsg = assistantMsgs.find((m) => m.parts?.some((p) => "asset" in p && p.asset?.presentation === "diagram"));
    expect(diagramMsg).toBeDefined();
    expect(diagramMsg!.responseId).toBeDefined();

    // Same responseId links text + inline diagram into one reply
    const sameResponse = assistantMsgs.filter((m) => m.responseId === diagramMsg!.responseId);
    expect(sameResponse.length).toBeGreaterThanOrEqual(2);

    const diagramPart = diagramMsg!.parts!.find((p) => "asset" in p && p.asset?.presentation === "diagram") as {
      type: "file"; assetId: string; asset: ChatAttachment; fallbackText?: string; caption?: string;
    };
    expect(diagramPart.asset.name).toBe("订单状态流转图.html");
    expect(diagramPart.asset.presentation).toBe("diagram");
    expect(diagramPart.asset.diagramMotion).toBe("none");
    expect(diagramPart.asset.width).toBe(640);
    expect(diagramPart.asset.height).toBe(260);
    expect(diagramPart.fallbackText).toBe("订单创建 -> 支付确认（两阶段状态机摘要）");
    expect(diagramPart.caption).toBe("主链路状态示意");

    // Inline diagram MUST NOT pollute the user's "Conversation Files" drawer
    const filesPage = await hub.listTopicFiles(topic.id);
    expect(filesPage.items.some((item) => item.asset.id === diagramPart.assetId)).toBe(false);

    // Yet full-text search still finds the conversation via fallbackText
    const search = await hub.searchConversations({ query: "两阶段状态机摘要", topicId: topic.id });
    expect(search.items.length).toBeGreaterThan(0);

    // Media HTTP preview serves single-DOCTYPE document with pinned HTML_DIAGRAM_CSP & blocks external presentation=diagram upload
    const mediaHandler = createMediaHttpHandler({
      uploads: hub.uploads,
      authenticate: () => "user:owner",
      canReadScope: () => true,
    });
    const server = http.createServer((req, res) => {
      void mediaHandler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")).then((handled) => {
        if (!handled) { res.writeHead(404); res.end(); }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;

    const previewRes = await fetch(`http://127.0.0.1:${port}/api/uploads/${diagramPart.assetId}/preview`);
    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("content-security-policy")).toBe(HTML_DIAGRAM_CSP);
    const previewHtml = await previewRes.text();
    expect(previewHtml.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(previewHtml).toContain("订单创建");

    const viewRes = await fetch(`http://127.0.0.1:${port}/api/uploads/${diagramPart.assetId}/view`);
    expect(viewRes.status).toBe(200);
    expect(viewRes.headers.get("content-security-policy")).toBe(HTML_DIAGRAM_BROWSER_CSP);
    const viewHtml = await viewRes.text();
    expect(viewHtml).toContain('sandbox="allow-scripts"');
    expect(viewHtml).not.toContain("allow-forms");

    // External upload attempt to spoof presentation=diagram must be rejected with 400
    const spoofRes = await fetch(`http://127.0.0.1:${port}/api/uploads?name=evil.html&presentation=diagram`, {
      method: "POST",
      headers: { "content-type": "text/html" },
      body: "<!doctype html><script>alert(1)</script>",
    });
    expect(spoofRes.status).toBe(400);

    // Settings Assistant must NOT receive kulo_ui_diagram tool or diagram-design skill in its prompt
    const beforeSettingsCount = requests.length;
    const settingsCtx = {
      module: "connections" as const,
      hasUnsavedChanges: false,
      appearance: "light" as const,
      clientId: "diagram-settings-check",
    };
    hub.settingsAssistant.updateContext(settingsCtx);
    await hub.settingsAssistant.send("帮我查看一下当前设置", settingsCtx, "diagram-settings-msg");
    await vi.waitFor(async () => {
      const snap = await hub.settingsAssistant.getSnapshot();
      expect(snap.live.busy).toBe(false);
      expect(requests.length).toBeGreaterThan(beforeSettingsCount);
    });
    const settingsReq = requests.at(-1)!;
    const settingsToolNames = (settingsReq.tools ?? []).map((t) => t.name);
    expect(settingsToolNames).not.toContain("kulo_ui_diagram");
    const settingsSkillsSection = settingsReq.messages
      .flatMap((m) => m.role === "system" && m.sections?.kulo_skills ? [m.sections.kulo_skills] : [])
      .join("\n");
    expect(settingsSkillsSection).not.toContain("diagram-design");
  });

  it("redacts secrets from diagram content before writing to disk and rejects malformed SVG without creating an asset", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-diagram-redact-"));
    cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const secret = "sk-ant-api03-SUPERSECRET1234567890ABCDEF";

    let step = 0;
    const provider = fauxProvider({ provider: "diagram-redact-test", models: [{ id: "test" }] });
    provider.setResponses(Array.from({ length: 10 }, () => () => {
      step++;
      if (step === 1) {
        return fauxAssistantMessage([
          fauxToolCall("tool_search", { query: "kulo_ui_diagram", limit: 3 }),
        ], { stopReason: "toolUse" });
      }
      if (step === 2) {
        return fauxAssistantMessage([
          fauxToolCall("kulo_ui_diagram", {
            title: "非法脚本测试",
            svg: `<svg viewBox="0 0 400 200"><script>alert(1)</script></svg>`,
            fallback_text: "bad",
          }),
        ], { stopReason: "toolUse" });
      }
      if (step === 3) {
        return fauxAssistantMessage([
          fauxToolCall("kulo_ui_diagram", {
            title: "脱敏测试图",
            svg: SAMPLE_SVG.replace("订单创建", `Key ${secret}`),
            fallback_text: `包含密钥 ${secret} 的摘要`,
          }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage([fauxText("已修正并输出。")]);
    }));

    const models = createModels();
    models.setProvider(provider.provider);
    const hub = await openTestHub({
      models,
      providerId: "diagram-redact-test",
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "diagram-redact-test", defaultModel: "test", thinkingLevel: "off" },
      },
    });
    cleanup.push(() => hub.close());

    const topic = await hub.createTopic("脱敏检查");
    const submitted = await hub.sendUserMessage("画张图", { topicId: topic.id });
    await submitted.wait(BACKGROUND_CONTEXT);

    const messages = (await hub.getTopicView(topic.id)).messages;
    const diagrams = messages.flatMap((m) => (m.parts ?? []).filter((p) => "asset" in p && p.asset?.presentation === "diagram"));
    // First invalid call must NOT produce an asset; only the second valid call publishes
    expect(diagrams).toHaveLength(1);
    const part = diagrams[0] as { assetId: string; fallbackText?: string };
    expect(part.fallbackText).not.toContain(secret);
    const loaded = hub.uploads.getUpload(part.assetId)!;
    const diskHtml = hub.uploads.readUploadBytes(loaded).toString("utf8");
    expect(diskHtml).not.toContain(secret);
  });

  it("attaches diagramSummary metadata to kulo_inspect_asset at offset=0 without altering text pagination", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-inspect-diagram-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const uploads = new KuloUploadStore(dir);
    const reportHtml = `<!doctype html><html><body><h1>性能报告</h1>${SAMPLE_SVG}<p>正文结尾</p></body></html>`;
    const att = uploads.saveUpload({ name: "report.html", mimeType: "text/html", bytes: Buffer.from(reportHtml, "utf8") });

    const page0 = inspectAssetContent({ assetId: att.id, offset: 0, limit: 40 }, uploads);
    const d0 = page0.details as Record<string, unknown>;
    expect(d0.text).toBe(reportHtml.slice(0, 40));
    expect(d0.nextOffset).toBe(40);
    expect(d0.diagramSummary).toMatchObject({ svgCount: 1, passed: 1 });

    const page1 = inspectAssetContent({ assetId: att.id, offset: 40, limit: 40 }, uploads);
    const d1 = page1.details as Record<string, unknown>;
    expect(d1.text).toBe(reportHtml.slice(40, 80));
    expect(d1.diagramSummary).toBeUndefined();
  });
});
