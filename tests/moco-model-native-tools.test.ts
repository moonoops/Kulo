import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, type Api, type AssistantMessage, type Model, type Models, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addNativeWebSearch, supportsNativeWebSearch, withNativeToolsModels, type NativeSearchMessage } from "../packages/hub/src/model-native-tools";
import { toProviderModelItem } from "../packages/hub/src/providers";
import { applySettingsBlockUpdate, MocoSettingsDoc } from "../packages/hub/src/settings";
import { MAX_NATIVE_CONTENT_BYTES, nativeContentHash } from "../packages/hub/src/model-native-replay";
import { createCredentialRedactionExtension, redactCredentialData, scrubStoredConversationSecrets, wrapRedactedStorage } from "../packages/hub/src/credential-redaction";
import { redactSensitiveText } from "@moco/protocol";

const sourceUrl = "https://example.com/primary";
const selected = (api: Api = "openai-responses"): Model<Api> => ({
  id: "native-model", name: "Native", api, provider: "native-provider", baseUrl: "https://models.example.com/v1",
  reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

type RawBlock = Record<string, unknown>;
function claudeSse(blocks: RawBlock[], id: string, stop = "end_turn"): Response {
  const events: unknown[] = [{ type: "message_start", message: { id, type: "message", role: "assistant", model: "native-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } }];
  blocks.forEach((block, index) => {
    const initial = { ...block };
    if (block.type === "text") { initial.text = ""; delete initial.citations; }
    if (block.type === "thinking") { initial.thinking = ""; initial.signature = ""; }
    if (block.type === "tool_use" || block.type === "server_tool_use") initial.input = {};
    events.push({ type: "content_block_start", index, content_block: initial });
    if (block.type === "text") {
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      for (const citation of (block.citations ?? []) as unknown[]) events.push({ type: "content_block_delta", index, delta: { type: "citations_delta", citation } });
    }
    if (block.type === "thinking") {
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      const signature = String(block.signature);
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: signature.slice(0, 3) } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: signature.slice(3) } });
    }
    if (block.type === "tool_use" || block.type === "server_tool_use") events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 8 } }, { type: "message_stop" });
  return new Response(events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function searchedClaudeBlocks(suffix: string): RawBlock[] {
  return [
    { type: "server_tool_use", id: `search-${suffix}`, name: "web_search", input: { query: "current facts" } },
    { type: "web_search_tool_result", tool_use_id: `search-${suffix}`, content: [{ type: "web_search_result", url: sourceUrl, title: "Primary", encrypted_content: `opaque-source-${suffix}` }] },
    { type: "text", text: "Identical answer.", citations: [{ type: "web_search_result_location", url: sourceUrl, title: "Primary", cited_text: "Supported facts", encrypted_index: `opaque-index-${suffix}` }] },
  ];
}

function claudeModels(respond: (request: Record<string, unknown>, index: number) => Response) {
  const model = selected("anthropic-messages");
  const target = createModels();
  target.setProvider(createProvider({ id: model.provider, models: [model], api: anthropicMessagesApi(), auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "synthetic-anthropic-key" } }) } } }));
  const requests: Record<string, unknown>[] = [];
  let enabled = true;
  const models = withNativeToolsModels(target, { getNativeTools: () => ({ webSearch: enabled }), fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);
    expect(JSON.stringify(request)).not.toContain("moco-native");
    return respond(request, requests.length - 1);
  } });
  return { model, models, requests, disable: () => { enabled = false; } };
}

describe("Claude native content replay", () => {
  it("preserves signed opaque fields through credential hooks, storage scrubbing and a SQLite restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-native-secret-replay-"));
    const known = "synthetic-anthropic-key";
    const redact = (value: string) => redactSensitiveText(value, [known]);
    const options = { isKnownSecret: (value: string) => value.includes(known) };
    const cipher = "sk-opaque_search_cipher_value_0123456789";
    const index = "Bearer opaque_citation_index_0123456789";
    const signature = "Bearer opaque_thinking_signature_0123456789";
    const redactedThinking = "sk-opaque_redacted_thinking_0123456789";
    expect(redact(cipher)).not.toBe(cipher); expect(redact(signature)).not.toBe(signature);
    const blocks = searchedClaudeBlocks("safe");
    ((blocks[1]!.content as Array<Record<string, unknown>>)[0]!).encrypted_content = cipher;
    ((blocks[2]!.citations as Array<Record<string, unknown>>)[0]!).encrypted_index = index;
    blocks.unshift({ type: "thinking", thinking: "A signed plan", signature }, { type: "redacted_thinking", data: redactedThinking });
    const f = claudeModels((_request, count) => count === 0 ? claudeSse(blocks, "msg-signed-safe") : claudeSse([{ type: "text", text: "Follow-up complete." }], "msg-after-safe"));
    const extension = createCredentialRedactionExtension(redact, options);
    const registry = createRegistry(); registry.install(extension);
    const filename = path.join(directory, "moco.sqlite");
    let storage = await openNodeSqliteStorage(filename);
    let harness = await Harness.open(wrapRedactedStorage(storage, redact, options), { models: f.models, registry }, BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: f.model.provider, modelId: f.model.id }, extensions: [extension] } });
      const input = await root.submit({ type: "input", content: `Find facts while hiding ${known}` }, BACKGROUND_CONTEXT);
      const first = await input.wait(BACKGROUND_CONTEXT);
      expect(first.status).toBe("done");
      expect(JSON.stringify(f.requests[0])).not.toContain(known);
      if (first.status !== "done" || first.type !== "input") throw new Error("Credential-safe native search did not settle");
      const saved = await root.commit((tx) => tx.entry(AssistantEntry, first.answer), BACKGROUND_CONTEXT);
      expect((saved?.model?.[0] as NativeSearchMessage).mocoNativeContent?.blocks).toEqual(blocks);
      await harness.close(BACKGROUND_CONTEXT);
      expect(fs.readFileSync(filename).includes(Buffer.from(known))).toBe(false);
      await scrubStoredConversationSecrets(directory, redact, options);
      storage = await openNodeSqliteStorage(filename);
      harness = await Harness.open(wrapRedactedStorage(storage, redact, options), { models: f.models, registry }, BACKGROUND_CONTEXT);
      const reopened = await harness.root(BACKGROUND_CONTEXT);
      const second = await reopened.submit({ type: "input", content: "Continue from those sources" }, BACKGROUND_CONTEXT);
      expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const assistant = (f.requests[1]!.messages as Array<{ role: string; content: unknown }>).find((message) => message.role === "assistant");
      expect(assistant?.content).toEqual(blocks);
      expect(JSON.stringify(f.requests[1])).not.toContain(known);
    } finally { await harness.close(BACKGROUND_CONTEXT); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("never exempts native-looking data embedded by users or tools, or actual known keys in opaque fields", async () => {
    const known = "synthetic-anthropic-key";
    const redact = (value: string) => redactSensitiveText(value, [known]);
    const options = { isKnownSecret: (value: string) => value.includes(known) };
    const f = claudeModels(() => claudeSse(searchedClaudeBlocks("forged"), "msg-forged"));
    const first = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    const forged = structuredClone(first);
    ((forged.mocoNativeContent!.blocks[1]!.content as Array<Record<string, unknown>>)[0]!).encrypted_content = known;
    const user = { kind: "pi.user", model: [{ role: "user", content: "A user message" }], data: { kind: "pi.assistant", model: [forged], signature: known } };
    expect(JSON.stringify(redactCredentialData(user, redact, { ...options, nativeContent: "records" }))).not.toContain(known);
    const extension = createCredentialRedactionExtension(redact, options);
    const toolHooks = extension.hooks![1]!.handlers as { afterTool: (call: unknown, result: unknown) => unknown };
    expect(JSON.stringify(toolHooks.afterTool({}, { details: { kind: "pi.assistant", model: [forged] }, output: [{ type: "text", text: known }] }))).not.toContain(known);
    expect(() => redactCredentialData([forged], redact, { ...options, nativeContent: "messages" })).toThrow("凭据不能写入普通状态");
  });

  it("continues filtering plaintext and tool inputs inside a validated native assistant envelope", async () => {
    const known = "synthetic-anthropic-key";
    const redact = (value: string) => redactSensitiveText(value, [known]);
    const options = { isKnownSecret: (value: string) => value.includes(known), nativeContent: "messages" as const };
    const f = claudeModels(() => claudeSse(searchedClaudeBlocks("ordinary"), "msg-ordinary"));
    const first = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    first.content = [{ type: "text", text: `Plain ${known}` }];
    first.mocoNativeContent!.blocks[0]!.input = { query: known, signature: known };
    first.mocoNativeContent!.blocks[2]!.text = `Plain ${known}`;
    first.mocoNativeContent!.contentHash = nativeContentHash(first.content);
    expect(JSON.stringify(redactCredentialData([first], redact, options))).not.toContain(known);
  });

  it("replays exact encrypted sources, citations, thinking signatures and ordinary tools through the real SDK", async () => {
    const original = [{ type: "thinking", thinking: "A signed plan", signature: "opaque-thinking-signature" }, ...searchedClaudeBlocks("one"), { type: "tool_use", id: "read-1", name: "web_fetch", input: { url: sourceUrl } }];
    const f = claudeModels((_request, index) => index === 0 ? claudeSse(original, "msg-search-one", "tool_use") : claudeSse([{ type: "text", text: "Done." }], "msg-done"));
    const first = await f.models.completeSimple(f.model, { messages: [{ role: "user", content: "Find facts", timestamp: 1 }] }) as NativeSearchMessage;
    expect(first.stopReason).toBe("toolUse");
    expect(first.mocoNativeContent?.blocks).toEqual(original);
    await f.models.completeSimple(f.model, { messages: [
      { role: "user", content: "Find facts", timestamp: 1 }, first,
      { role: "toolResult", toolCallId: "read-1", toolName: "web_fetch", content: [{ type: "text", text: "Page body." }], isError: false, timestamp: 2 },
    ] });
    const assistant = (f.requests[1]!.messages as Array<{ role: string; content: unknown }>).find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual(original);
    expect(JSON.stringify(f.requests[1])).toContain("read-1");
    expect(JSON.stringify(f.requests[1])).toContain("tool_result");
  });

  it("keeps native history replayable after the model's search switch is turned off", async () => {
    const original = searchedClaudeBlocks("off");
    const f = claudeModels((_request, index) => index === 0 ? claudeSse(original, "msg-search-off") : claudeSse([{ type: "text", text: "Follow-up." }], "msg-follow-up"));
    const first = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    f.disable();
    await f.models.completeSimple(f.model, { messages: [first, { role: "user", content: "Use those facts", timestamp: 1 }] });
    expect((f.requests[1]!.tools as unknown[] | undefined) ?? []).not.toContainEqual(expect.objectContaining({ name: "web_search" }));
    expect((f.requests[1]!.messages as Array<{ role: string; content: unknown }>).find((message) => message.role === "assistant")?.content).toEqual(original);
  });

  it("does not replay signed search content to a different model or provider", async () => {
    const f = claudeModels(() => claudeSse(searchedClaudeBlocks("bound"), "msg-search-bound"));
    const first = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    const other = { ...f.model, id: "other-model", provider: "other-provider" };
    const target = createModels();
    target.setProvider(createProvider({ id: other.provider, models: [other], api: anthropicMessagesApi(), auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "synthetic-other-key" } }) } } }));
    let request: Record<string, unknown> | undefined;
    const models = withNativeToolsModels(target, { getNativeTools: () => ({ webSearch: true }), fetch: async (_url, init) => { request = JSON.parse(String(init?.body)); return claudeSse([{ type: "text", text: "Other answer." }], "msg-other"); } });
    await models.completeSimple(other, { messages: [first, { role: "user", content: "Continue", timestamp: 1 }] });
    expect(JSON.stringify(request)).not.toContain("opaque-source-bound");
    expect(JSON.stringify(request)).not.toContain("opaque-index-bound");
  });

  it("fails closed when a stored assistant or caller payload transform changes signed history", async () => {
    const f = claudeModels(() => claudeSse(searchedClaudeBlocks("tamper"), "msg-search-tamper"));
    const first = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    const changed = { ...first, content: [{ type: "text" as const, text: "Edited answer." }] };
    const result = await f.models.completeSimple(f.model, { messages: [changed] });
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("无法完整重放");
    expect(f.requests).toHaveLength(1);
    const transformed = await f.models.completeSimple(f.model, { messages: [first] }, { onPayload: (value) => {
      const body = value as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
      for (const message of body.messages) for (const block of message.content) if (block.text === "Identical answer.") block.text = "Edited by a hook.";
      return value;
    } });
    expect(transformed.stopReason).toBe("error"); expect(transformed.errorMessage).toContain("无法完整重放");
    expect(f.requests).toHaveLength(1);
  });

  it("preserves large opaque fields without truncation and fails explicitly above the storage limit", async () => {
    const blocks = searchedClaudeBlocks("large");
    const large = "opaque-" + "x".repeat(70_000);
    ((blocks[1]!.content as Array<Record<string, unknown>>)[0]!).encrypted_content = large;
    const f = claudeModels(() => claudeSse(blocks, "msg-large"));
    const result = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    expect(((result.mocoNativeContent?.blocks[1]?.content as Array<Record<string, unknown>>)[0]!).encrypted_content).toBe(large);
    ((blocks[1]!.content as Array<Record<string, unknown>>)[0]!).encrypted_content = "x".repeat(MAX_NATIVE_CONTENT_BYTES + 1);
    const overflow = await f.models.completeSimple(f.model, { messages: [] });
    expect(overflow.stopReason).toBe("error"); expect(overflow.errorMessage).toContain("超过保存上限");
  });

  it("replays two identical searched answers correctly after restart and through a custom-tool round", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-native-replay-"));
    const f = claudeModels((_request, index) => index < 2 ? claudeSse(searchedClaudeBlocks(String(index)), `msg-search-${index}`) :
      index === 2 ? claudeSse([{ type: "tool_use", id: "read-after-restart", name: "web_fetch", input: { url: sourceUrl } }], "msg-read", "tool_use") : claudeSse([{ type: "text", text: "Read complete." }], "msg-final"));
    const registry = createRegistry();
    const extension = defineExtension({ name: "native-replay-test", tools: [defineTool({ name: "web_fetch", description: "Read a page", replay: "safe", parameters: obj({ url: str() }), execute: async () => ({ output: [{ type: "text", text: "Page body." }] }) })] });
    registry.install(extension);
    let harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "state.sqlite")), { models: f.models, registry }, BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: f.model.provider, modelId: f.model.id }, extensions: [extension] } });
      for (const content of ["Find facts first", "Find facts again"]) {
        const input = await root.submit({ type: "input", content }, BACKGROUND_CONTEXT);
        expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      }
      await harness.close(BACKGROUND_CONTEXT);
      harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "state.sqlite")), { models: f.models, registry }, BACKGROUND_CONTEXT);
      const reopened = await harness.root(BACKGROUND_CONTEXT);
      const input = await reopened.submit({ type: "input", content: "Read that page" }, BACKGROUND_CONTEXT);
      expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      expect(f.requests).toHaveLength(4);
      for (const index of [2, 3]) {
        const assistants = (f.requests[index]!.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === "assistant");
        expect(assistants[0]?.content).toEqual(searchedClaudeBlocks("0"));
        expect(assistants[1]?.content).toEqual(searchedClaudeBlocks("1"));
      }
      expect(JSON.stringify(f.requests[3])).toContain("read-after-restart");
      expect(JSON.stringify(f.requests[3])).toContain("tool_result");
    } finally { await harness.close(BACKGROUND_CONTEXT); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
const answer = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant", api: "openai-responses", provider: "native-provider", model: "native-model",
  content: [{ type: "text", text: "Current facts." }], stopReason: "stop", timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  ...overrides,
});
function fixture(events: unknown[], result = answer(), api: Api = "openai-responses") {
  const model = selected(api);
  const payloads: unknown[] = [];
  const streamSimple = vi.fn((_model, _context, options?: ModelsSimpleStreamOptions) => {
    const stream = new AssistantMessageEventStream();
    void (async () => {
      payloads.push(await options?.onPayload?.({ tools: [{ type: "function", name: "web_search" }, { type: "function", name: "moco_dispatch" }] }, model));
      for (const event of events) await options?.onProviderStreamEvent?.(event, model);
      if (result.stopReason === "error" || result.stopReason === "aborted") stream.push({ type: "error", reason: result.stopReason, error: result });
      else stream.push({ type: "done", reason: result.stopReason as "stop", message: result });
      stream.end(result);
    })();
    return stream;
  });
  const target = { streamSimple, stream: streamSimple, completeSimple: vi.fn(async () => result), complete: vi.fn(async () => result) } as unknown as Models;
  return { model, payloads, target, models: withNativeToolsModels(target, { getNativeTools: () => ({ webSearch: true }) }) };
}

afterEach(() => vi.restoreAllMocks());

describe("model-native search tools", () => {
  it("appends hosted search, replaces only the external search function, and keeps payloads immutable and idempotent", () => {
    const payload = { tools: [{ type: "function", name: "web_search" }, { type: "function", name: "moco_dispatch" }, { type: "function", name: "web_fetch" }], include: ["reasoning.encrypted_content"], tool_choice: "auto" };
    const next = addNativeWebSearch(payload, selected()) as typeof payload;
    expect(next.tools).toEqual([{ type: "function", name: "moco_dispatch" }, { type: "function", name: "web_fetch" }, { type: "web_search" }]);
    expect(next.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
    expect(next.tool_choice).toBe("auto");
    expect(payload.tools[0]!.name).toBe("web_search");
    expect(addNativeWebSearch(next, selected())).toEqual(next);
  });

  it("keeps native tool configuration on the per-model catalog entry", () => {
    expect(toProviderModelItem(selected(), { id: "native-model", nativeTools: { webSearch: true } })).toMatchObject({ nativeTools: { webSearch: true } });
    expect(toProviderModelItem(selected())).not.toHaveProperty("nativeTools");
  });

  it("does not equate arbitrary completions models with hosted search support", () => {
    expect(supportsNativeWebSearch("openai-completions")).toBe(false);
    expect(() => addNativeWebSearch({}, selected("openai-completions"))).toThrow("当前模型接口");
  });

  it.each(["google-generative-ai", "google-vertex"] as const)("rejects unsupported %s hosted search and agent function combinations", (api) => {
    const payload = { config: { tools: [{ functionDeclarations: [{ name: "web_search" }, { name: "moco_dispatch" }] }], toolConfig: { functionCallingConfig: { mode: "ANY" } } } };
    expect(() => addNativeWebSearch(payload, selected(api))).toThrow("不支持将联网搜索与智能体函数工具同时使用");
  });

  it.each(["google-generative-ai", "google-vertex"] as const)("supports standalone %s native search without agent functions", (api) => {
    const next = addNativeWebSearch({ config: { tools: [{ functionDeclarations: [{ name: "web_search" }] }], toolConfig: { functionCallingConfig: { mode: "ANY" } } } }, selected(api));
    expect(next).toEqual({ config: { tools: [{ googleSearch: {} }] } });
    expect(addNativeWebSearch(next, selected(api))).toEqual(next);
  });

  it("uses OpenRouter's hosted-tool identifier only on its Responses path", () => {
    expect(addNativeWebSearch({}, { ...selected(), baseUrl: "https://openrouter.ai/api/v1" })).toMatchObject({ tools: [{ type: "openrouter:web_search" }] });
  });

  it("chains Durable payload and event callbacks and retains only provider citations", async () => {
    const f = fixture([{ type: "response.completed", response: { output: [
      { type: "web_search_call", action: { sources: [{ url: sourceUrl, title: "Found" }, { url: "https://example.com/uncited", title: "Uncited" }] } },
      { type: "message", content: [{ type: "output_text", annotations: [{ type: "url_citation", url: sourceUrl, title: "Primary" }, { type: "url_citation", url: "http://169.254.169.254/latest", title: "Unsafe" }] }] },
    ] } }]);
    const payload = vi.fn((value) => ({ ...value, fromDurable: true }));
    const events = vi.fn();
    const result = await f.models.completeSimple(f.model, { messages: [] }, { onPayload: payload, onProviderStreamEvent: events }) as NativeSearchMessage;
    expect(f.payloads[0]).toMatchObject({ fromDurable: true, tools: [{ name: "moco_dispatch" }, { type: "web_search" }] });
    expect(payload).toHaveBeenCalledOnce(); expect(events).toHaveBeenCalledOnce();
    expect(result.mocoSearchSources).toMatchObject([{ url: sourceUrl, title: "Primary" }]);
    expect(result.mocoSearchSources).toHaveLength(1);
  });

  it("leaves disabled models on their original call path", async () => {
    const f = fixture([]);
    const wrapped = withNativeToolsModels(f.target, { getNativeTools: () => ({ webSearch: false }) });
    await wrapped.completeSimple(f.model, { messages: [] });
    expect(f.target.completeSimple).toHaveBeenCalledOnce();
    expect(f.target.streamSimple).not.toHaveBeenCalled();
  });

  it.each(["openai-completions", "google-generative-ai", "google-vertex"] as const)("keeps third-party search available for incompatible %s settings", async (api) => {
    const f = fixture([], answer({ api }), api);
    const context = { messages: [], tools: [
      { name: "web_search", description: "Search configured MCP services", parameters: obj({}) },
      { name: "web_fetch", description: "Read a page", parameters: obj({}) },
    ] };
    const result = await f.models.completeSimple(f.model, context);
    expect(result.stopReason).toBe("stop");
    expect(f.target.completeSimple).toHaveBeenCalledWith(f.model, context, undefined);
    expect(f.target.streamSimple).not.toHaveBeenCalled();
    expect(context.tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
  });

  it("never turns ordinary markdown links into native citations", async () => {
    const f = fixture([], answer({ content: [{ type: "text", text: `[Unverified](${sourceUrl})` }] }));
    const result = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    expect(result.mocoSearchSources).toBeUndefined();
  });

  it.each(["length", "error", "aborted"] as const)("does not mark a %s response's partial native sources as completed", async (stopReason) => {
    const f = fixture([{ type: "url_citation", url: sourceUrl, title: "Partial" }], answer({ stopReason, errorMessage: "401: SIMULATED authentication error" }));
    const result = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    expect(result.stopReason).toBe(stopReason);
    expect(result.errorMessage).toBe("401: SIMULATED authentication error");
    expect(result.mocoSearchSources).toBeUndefined();
  });

  it("does not inject custom fetch into Google SDK adapters", async () => {
    const f = fixture([], answer({ api: "google-generative-ai" }), "google-generative-ai");
    const http = vi.fn();
    const wrapped = withNativeToolsModels(f.target, { getNativeTools: () => ({ webSearch: true }), fetch: http });
    await wrapped.completeSimple(f.model, { messages: [] });
    expect(vi.mocked(f.target.streamSimple).mock.calls[0]?.[2]?.fetch).toBeUndefined();
  });

  it("preserves provider tool errors instead of accepting already streamed citations", async () => {
    const f = fixture([{ type: "web_search_result_location", url: sourceUrl, title: "Partial" }, { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }]);
    const result = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("max_uses_exceeded");
    expect(result.mocoSearchSources).toBeUndefined();
  });

  it("rejects a failed OpenAI search item even if the response later contains a citation", async () => {
    const f = fixture([{ type: "web_search_call", status: "failed" }, { type: "url_citation", url: sourceUrl, title: "Partial" }]);
    const result = await f.models.completeSimple(f.model, { messages: [] }) as NativeSearchMessage;
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("原生搜索调用失败");
    expect(result.mocoSearchSources).toBeUndefined();
  });

  it("does not accept sources after caller cancellation even if a provider finishes successfully", async () => {
    const f = fixture([{ type: "url_citation", url: sourceUrl, title: "Partial" }]);
    const controller = new AbortController();
    const result = await f.models.completeSimple(f.model, { messages: [] }, { signal: controller.signal, onProviderStreamEvent: () => { controller.abort(); } }) as NativeSearchMessage;
    expect(result.stopReason).toBe("aborted"); expect(result.mocoSearchSources).toBeUndefined();
  });

  it("continues Claude pause_turn with its raw server tool blocks and accumulates usage", async () => {
    const model = selected("anthropic-messages");
    const payloads: unknown[] = [];
    const streamSimple = vi.fn((_model, _context, options?: ModelsSimpleStreamOptions) => {
      const stream = new AssistantMessageEventStream();
      void (async () => {
        payloads.push(await options?.onPayload?.({ messages: [{ role: "user", content: "Find evidence" }], tools: [{ name: "moco_dispatch" }] }, model));
        const first = payloads.length === 1;
        if (first) {
          await options?.onProviderStreamEvent?.({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "server-search", name: "web_search", input: {} } }, model);
          await options?.onProviderStreamEvent?.({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"evidence"}' } }, model);
          await options?.onProviderStreamEvent?.({ type: "content_block_stop", index: 0 }, model);
        }
        await options?.onProviderStreamEvent?.({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, model);
        await options?.onProviderStreamEvent?.({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: first ? "Looking up evidence. " : "Current facts." } }, model);
        if (!first) await options?.onProviderStreamEvent?.({ type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: sourceUrl, title: "Evidence", cited_text: "Supported facts", encrypted_index: "cipher-index" } } }, model);
        await options?.onProviderStreamEvent?.({ type: "content_block_stop", index: 1 }, model);
        const result = answer({ api: model.api, content: [{ type: "text", text: first ? "Looking up evidence. " : "Current facts." }], ...(first ? { rawStopReason: "pause_turn" } : {}) });
        stream.push({ type: "done", reason: "stop", message: result }); stream.end(result);
      })();
      return stream;
    });
    const models = withNativeToolsModels({ streamSimple } as unknown as Models, { getNativeTools: () => ({ webSearch: true }) });
    const result = await models.completeSimple(model, { messages: [] }) as NativeSearchMessage;
    expect(payloads[1]).toMatchObject({ messages: [{ role: "user" }, { role: "assistant", content: [{ type: "server_tool_use", input: { query: "evidence" } }, { type: "text", text: "Looking up evidence. " }] }], tools: [{ name: "moco_dispatch" }, { type: "web_search_20250305" }] });
    expect(result.content).toHaveLength(2);
    expect(result.usage.totalTokens).toBe(4);
    expect(result.mocoSearchSources?.[0]).toMatchObject({ url: sourceUrl, snippet: "Supported facts" });
  });
});

function realSdk() {
  const model = selected();
  const models = createModels();
  models.setProvider(createProvider({ id: model.provider, models: [model], api: openAIResponsesApi(), auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "synthetic-native-test-key" } }) } } }));
  const message = { type: "message", id: "msg-native", role: "assistant", content: [{ type: "output_text", text: "Current facts.", annotations: [{ type: "url_citation", url: sourceUrl, title: "Primary" }] }] };
  const http = vi.fn(async () => new Response([
    { type: "response.created", response: { id: "resp-native" } },
    { type: "response.output_item.added", output_index: 0, item: message },
    { type: "response.output_text.delta", output_index: 0, delta: "Current facts." },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: "resp-native", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  return { model, models: withNativeToolsModels(models, { getNativeTools: () => ({ webSearch: true }), fetch: http }), http };
}

describe("native search through the real Pi runtime", () => {
  it("validates and persists native tool settings independently for each configured model", async () => {
    const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    const patch = (nativeTools: unknown) => ({ customProviders: [{ id: "api-native-settings", name: "Native settings", api: "openai-responses", baseUrl: "https://models.example.com/v1", models: [{ id: "enabled", nativeTools }, { id: "disabled", nativeTools: { webSearch: false } }] }] });
    try {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(MocoSettingsDoc);
        applySettingsBlockUpdate(doc, "model", doc.revisions.model, patch({ webSearch: true }));
      }, BACKGROUND_CONTEXT);
      const state = await harness.snapshot(MocoSettingsDoc, BACKGROUND_CONTEXT);
      expect(state?.model.customProviders?.[0]?.models).toMatchObject([{ id: "enabled", nativeTools: { webSearch: true } }, { id: "disabled", nativeTools: { webSearch: false } }]);
      for (const invalid of [{ webSearch: "yes" }, { executeCode: true }, []]) {
        await expect(harness.commit(async (tx) => {
          const doc = await tx.doc(MocoSettingsDoc);
          applySettingsBlockUpdate(doc, "model", doc.revisions.model, patch(invalid));
        }, BACKGROUND_CONTEXT)).rejects.toThrow("原生工具设置无效");
      }
    } finally { await harness.close(BACKGROUND_CONTEXT); }
  });

  it("observes actual SDK events through the proxy-fetch injection point", async () => {
    const f = realSdk();
    const result = await f.models.completeSimple(f.model, { messages: [{ role: "user", content: "Search recent facts", timestamp: 0 }] }) as NativeSearchMessage;
    expect(result.stopReason).toBe("stop");
    expect(result.mocoSearchSources?.[0]).toMatchObject({ url: sourceUrl, title: "Primary" });
    expect(JSON.parse(String(f.http.mock.calls[0]?.[1]?.body)).tools).toContainEqual({ type: "web_search" });
  });

  it("persists provider citations in the actual Durable assistant entry", async () => {
    const f = realSdk();
    const harness = await Harness.open(new MemoryStorage(), { models: f.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: f.model.provider, modelId: f.model.id } } });
      const input = await root.submit({ type: "input", content: "Search recent facts" }, BACKGROUND_CONTEXT);
      const settled = await input.wait(BACKGROUND_CONTEXT);
      expect(settled.status).toBe("done");
      if (settled.status !== "done" || settled.type !== "input") throw new Error("Durable native search did not settle");
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
      expect((entry?.model?.[0] as NativeSearchMessage).mocoSearchSources).toMatchObject([{ url: sourceUrl, title: "Primary" }]);
    } finally { await harness.close(BACKGROUND_CONTEXT); }
  });

  it("preserves the real SDK's HTTP status, error code and parameter on failed native requests", async () => {
    const model = selected();
    const target = createModels();
    target.setProvider(createProvider({ id: model.provider, models: [model], api: openAIResponsesApi(), auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "synthetic-native-test-key" } }) } } }));
    const models = withNativeToolsModels(target, { getNativeTools: () => ({ webSearch: true }), fetch: async () => new Response(JSON.stringify({ error: { message: "SIMULATED unsupported parameter", type: "invalid_request_error", code: "unsupported_parameter", param: "tools" } }), { status: 400 }) });
    const result = await models.completeSimple(model, { messages: [] }, { maxRetries: 0 });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("400"); expect(result.errorMessage).toContain("unsupported_parameter"); expect(result.errorMessage).toContain("tools");
  });

  it("injects web_search + x_search and captures top-level citations for xAI Grok on openai-responses", async () => {
    const grokModel = { ...selected(), id: "grok-4.20", provider: "xai", baseUrl: "https://api.x.ai/v1", api: "openai-responses" as const };
    const target = createModels();
    target.setProvider(createProvider({ id: "xai", baseUrl: "https://api.x.ai/v1", models: [grokModel], api: openAIResponsesApi(), auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "synthetic-xai-key" } }) } } }));
    const message = { type: "message", id: "msg-grok", role: "assistant", content: [{ type: "output_text", text: "Grok result." }] };
    const http = vi.fn(async () => new Response([
      { type: "response.created", response: { id: "resp-grok" } },
      { type: "response.output_item.added", output_index: 0, item: message },
      { type: "response.output_text.delta", output_index: 0, delta: "Grok result." },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: "resp-grok", status: "completed", output: [message], citations: ["https://x.com/i/status/12345", "https://docs.x.ai/docs/guides/live-search"], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
    const models = withNativeToolsModels(target, { getNativeTools: () => ({ webSearch: true }), fetch: http });
    const result = await models.completeSimple(grokModel, { messages: [{ role: "user", content: "Latest on X", timestamp: 0 }] }) as NativeSearchMessage;
    const sentBody = JSON.parse(String(http.mock.calls[0]?.[1]?.body));
    expect(sentBody.tools).toEqual(expect.arrayContaining([{ type: "web_search" }, { type: "x_search" }]));
    expect(sentBody.include).toBeUndefined();
    expect(result.mocoSearchSources?.map((s) => s.url)).toEqual(["https://x.com/i/status/12345", "https://docs.x.ai/docs/guides/live-search"]);
  });

  it("allows native search only on official preset origins and supported subscriptions", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { MocoProviderManager } = await import("../packages/hub/src/providers");
    const { resolveHubConfig } = await import("../packages/hub/src/config");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-native-search-guard-"));
    try {
      const pm = new MocoProviderManager({ stateDir });
      const base = resolveHubConfig().model;
      pm.syncProviders({
        ...base,
        customProviders: [
          { id: "api-openai", name: "OpenAI", preset: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", models: [{ id: "gpt-5" }] },
          { id: "api-xai", name: "xAI", preset: "xai", api: "openai-responses", baseUrl: "https://api.x.ai/v1", models: [{ id: "grok-4" }] },
          { id: "api-openrouter", name: "OpenRouter", preset: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "openai/gpt-5" }] },
          { id: "api-google", name: "Google", preset: "google", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: [{ id: "gemini-2.5-pro" }] },
          { id: "api-hijacked", name: "Relay", preset: "openai", api: "openai-responses", baseUrl: "https://newapi.example.com/v1", models: [{ id: "gpt-5" }] },
          { id: "custom-newapi", name: "NewAPI", api: "openai-responses", baseUrl: "https://newapi.example.com/v1", models: [{ id: "gpt-5" }] },
        ],
      }, {});
      expect(pm.isOfficialNativeSearchAllowed("api-openai")).toBe(true);
      expect(pm.isOfficialNativeSearchAllowed("api-xai")).toBe(true);
      expect(pm.isOfficialNativeSearchAllowed("api-openrouter")).toBe(true);
      expect(pm.isOfficialNativeSearchAllowed("openai-codex")).toBe(true);
      expect(pm.isOfficialNativeSearchAllowed("xai")).toBe(true);
      expect(pm.isOfficialNativeSearchAllowed("anthropic")).toBe(true);
      expect(pm.isOfficialNativeSearchAllowed("api-google")).toBe(false);
      expect(pm.isOfficialNativeSearchAllowed("api-hijacked")).toBe(false);
      expect(pm.isOfficialNativeSearchAllowed("custom-newapi")).toBe(false);
      expect(pm.isOfficialNativeSearchAllowed("moco-gateway")).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
