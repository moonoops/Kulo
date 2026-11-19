import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ChatDisplayItem } from "@moco/protocol";
import { startSearchMcpFixture } from "../packages/hub/test/search-mcp-fixture.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanup: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_SEARCH_API_KEY", "MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY", "MOCO_HINDSIGHT_ROUTER_API_KEY", "MOCO_HINDSIGHT_WORKER_API_KEY", "MOCO_HINDSIGHT_SHARED_READ_API_KEY"]) vi.stubEnv(key, "");
  const localFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
      throw new Error("This regression test permits local MCP requests only.");
    }
    return localFetch(input, init);
  });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function openHub(stateDir: string) {
  const provider = fauxProvider({ provider: "openai", models: [{ id: "conversation-model" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: { stateDir, identityDir: path.join(stateDir, "identity"),
    authToken: HUB_TEST_ADMIN_TOKEN, envTokens: {}, workerEnvIds: [], enableLocalEnv: false,
    memory: { enabled: false }, model: { defaultProvider: "openai", defaultModel: "conversation-model", apiKey: "" },
  } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await hub.close(); } };
  cleanup.push(close);
  return { hub, provider, close };
}

describe("MCP search in a real Hub conversation", () => {
  it("discovers official tools, reads a full page and persists cited evidence after refresh and restart", async () => {
    const url = "https://example.com/verified-documentation";
    const body = "The complete fixture article describes the verified API behavior and its recovery procedure.";
    const mcp = await startSearchMcpFixture({ tools: [
      { name: "web_search_exa", inputSchema: { type: "object", properties: {
        query: { type: "string" }, objective: { type: "string" }, numResults: { type: "number" },
      }, required: ["query", "objective", "numResults"], additionalProperties: false } },
      { name: "web_fetch_exa", inputSchema: { type: "object", properties: {
        urls: { type: "array", items: { type: "string" } }, maxCharacters: { type: "number" },
      }, required: ["urls", "maxCharacters"], additionalProperties: false } },
    ], onCall: (name, args) => {
      if (name === "web_search_exa") {
        expect(args.query).toBe("verified API behavior");
        expect(typeof args.objective).toBe("string");
        expect(args.numResults).toBeGreaterThan(0);
        return { content: [{ type: "text", text: "Search evidence" }], structuredContent: { results: [{ title: "Verified documentation", url, text: "A brief indexed excerpt." }] } };
      }
      expect(name).toBe("web_fetch_exa");
      expect(args.urls).toEqual([url]);
      expect(args.maxCharacters).toBeGreaterThan(0);
      return { content: [{ type: "text", text: "Full page evidence" }], structuredContent: { results: [{ title: "Verified documentation", url, text: body }] } };
    } });
    cleanup.push(mcp.close);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-mcp-conversation-"));
    cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const f = await openHub(stateDir);
    for (const preset of (await f.hub.search.snapshot()).plans) await f.hub.search.remove(preset.id, preset.revision);
    await f.hub.search.configure({ name: "Local MCP", adapter: "exa", baseUrl: mcp.url });
    const answer = `行为与恢复流程见 [Verified documentation](${url})。`;
    f.provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("web_search", { query: "verified API behavior" })], { stopReason: "toolUse" }),
      (context) => {
        const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "web_search");
        expect(result).toMatchObject({ isError: false });
        expect(JSON.stringify(result)).toContain("A brief indexed excerpt.");
        return fauxAssistantMessage([fauxToolCall("web_fetch", { url })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "web_fetch");
        expect(result).toMatchObject({ isError: false });
        expect(JSON.stringify(result)).toContain(body);
        return fauxAssistantMessage([fauxText(answer)]);
      },
    ]);
    const submission = await f.hub.sendUserMessage("搜索 API 行为，读取正文并提供来源");
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    let final!: ChatDisplayItem;
    await vi.waitFor(async () => {
      const view = await f.hub.getTopicView("root");
      expect(view.live.busy).toBe(false);
      final = view.messages.find((message) => message.text === answer)!;
      expect(final).toMatchObject({ role: "assistant", sources: [{ title: "Verified documentation", url }] });
    }, { timeout: 5000, interval: 20 });
    expect(mcp.calls.map((call) => call.name)).toEqual(["web_search_exa", "web_fetch_exa"]);
    expect(mcp.connections).toBeGreaterThan(0);
    await vi.waitFor(() => expect(mcp.activeSessions).toBe(0));
    const refreshed = await f.hub.getTopicView("root");
    expect(refreshed.messages.find((message) => message.id === final.id)?.sources).toEqual(final.sources);
    await f.close();
    const reopened = await openHub(stateDir);
    const history = await reopened.hub.getTopicView("root");
    expect(history.messages.find((message) => message.id === final.id)).toMatchObject({ text: answer, sources: final.sources });
    expect(mcp.calls).toHaveLength(2);
  });

  it("keeps a successful empty MCP result healthy instead of reporting a connection failure", async () => {
    const mcp = await startSearchMcpFixture({ tools: [{ name: "web_search_exa", inputSchema: { type: "object", properties: {
      query: { type: "string" }, objective: { type: "string" }, numResults: { type: "number" },
    }, required: ["query", "objective", "numResults"], additionalProperties: false } }],
    onCall: () => ({ content: [{ type: "text", text: "No search results" }], structuredContent: { results: [] } }) });
    cleanup.push(mcp.close);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-mcp-empty-"));
    cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const f = await openHub(stateDir);
    for (const preset of (await f.hub.search.snapshot()).plans) await f.hub.search.remove(preset.id, preset.revision);
    const plan = await f.hub.search.configure({ name: "Empty local MCP", adapter: "exa", baseUrl: mcp.url });
    const tested = await f.hub.search.test(plan.id, plan.revision);
    expect(tested.sources).toEqual([]);
    expect((await f.hub.search.snapshot()).plans[0]).toMatchObject({ status: "ready" });
    expect((await f.hub.search.snapshot()).plans[0]).not.toHaveProperty("failure");
    expect((await f.hub.search.search({ query: "no matching fixture" })).sources).toEqual([]);
    expect(mcp.calls).toHaveLength(2);
    await vi.waitFor(() => expect(mcp.activeSessions).toBe(0));
  });
});
