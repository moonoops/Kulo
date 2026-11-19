import {
  type Api, type AssistantMessage, type Context, type Model, type Models,
  type ModelsApiStreamOptions, type ModelsSimpleStreamOptions, type StreamOptions,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ModelNativeTools, WebSource } from "@kulo/protocol";
import { sanitizeSearchSources } from "./search-sources.js";
import { normalizeWebSourceUrl, sanitizeSearchSuggestions, webSourceId } from "./web-content.js";
import {
  assertNativeBlocksMatch, assertNativeContentSize, MAX_NATIVE_CONTENT_BYTES, nativeContentHash, prepareNativeReplay,
  type NativeContentEnvelope,
  type NativeReplay,
} from "./model-native-replay.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, limit: number): string | undefined => typeof value === "string" ? value.trim().slice(0, limit) || undefined : undefined;
const GOOGLE_APIS = new Set(["google-generative-ai", "google-vertex"]);
const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

export interface NativeSearchMessage extends AssistantMessage {
  kuloSearchSources?: WebSource[];
  kuloSearchSuggestions?: string[];
  kuloNativeContent?: NativeContentEnvelope;
}

export interface NativeToolsModelsOptions {
  getNativeTools: (provider: string, modelId: string) => ModelNativeTools | undefined;
  fetch?: typeof fetch;
}

export function supportsNativeWebSearch(api: string, model?: Pick<Model<Api>, "baseUrl" | "provider">): boolean {
  if (RESPONSES_APIS.has(api) || GOOGLE_APIS.has(api) || api === "anthropic-messages") return true;
  if (api === "openai-completions" && model && openRouter(model)) return true;
  return false;
}

function openRouter(model: Pick<Model<Api>, "baseUrl">): boolean {
  try { const host = new URL(model.baseUrl).hostname; return host === "openrouter.ai" || host.endsWith(".openrouter.ai"); }
  catch { return false; }
}

function xaiModel(model: Pick<Model<Api>, "baseUrl" | "provider">): boolean {
  if (model.provider === "xai") return true;
  try { const host = new URL(model.baseUrl).hostname; return host === "api.x.ai" || host.endsWith(".x.ai"); }
  catch { return false; }
}

function withoutExternalSearch(tools: unknown[]): unknown[] {
  return tools.flatMap((value) => {
    const tool = object(value);
    if (!tool) return [value];
    if ((tool.type === "function" && (tool.name === "web_search" || object(tool.function)?.name === "web_search")) ||
      (tool.name === "web_search" && !tool.type)) return [];
    if (Array.isArray(tool.functionDeclarations)) {
      const declarations = tool.functionDeclarations.filter((declaration) => object(declaration)?.name !== "web_search");
      return declarations.length ? [{ ...tool, functionDeclarations: declarations }] : [];
    }
    return [value];
  });
}

/** Merge into the provider request after Durable has assembled its dispatch and file tools. */
export function addNativeWebSearch(payload: unknown, model: Model<Api>): unknown {
  const body = object(payload);
  if (!body) throw new Error("模型原生工具请求格式无效。");
  if (GOOGLE_APIS.has(model.api)) {
    const config = { ...object(body.config) };
    const tools = withoutExternalSearch(array(config.tools));
    if (tools.some((value) => array(object(value)?.functionDeclarations).length > 0)) {
      throw new Error("当前 Google generateContent 接口不支持将联网搜索与智能体函数工具同时使用，请关闭此模型的原生联网搜索。");
    }
    config.tools = tools.some((value) => object(value)?.googleSearch !== undefined) ? tools : [...tools, { googleSearch: {} }];
    const toolConfig = object(config.toolConfig);
    if (toolConfig) {
      // A function-only forced choice prevents Google's hosted search tool from running.
      const { functionCallingConfig: _functionCallingConfig, ...remaining } = toolConfig;
      if (Object.keys(remaining).length) config.toolConfig = remaining; else delete config.toolConfig;
    }
    return { ...body, config };
  }
  if (openRouter(model) && (model.api === "openai-completions" || model.api === "anthropic-messages")) {
    const tools = withoutExternalSearch(array(body.tools));
    const plugins = array(body.plugins);
    const hasWebPlugin = plugins.some((plugin) => object(plugin)?.id === "web");
    return {
      ...body,
      ...(Array.isArray(body.tools) ? (tools.length ? { tools } : (() => { const copy = { ...body }; delete copy.tools; return copy; })()) : {}),
      plugins: hasWebPlugin ? plugins : [...plugins, { id: "web" }],
    };
  }
  if (model.api === "anthropic-messages") {
    const tools = withoutExternalSearch(array(body.tools));
    const present = tools.some((value) => typeof object(value)?.type === "string" && String(object(value)?.type).startsWith("web_search_"));
    return { ...body, tools: present ? tools : [...tools, { type: "web_search_20250305", name: "web_search", max_uses: 3 }] };
  }
  if (RESPONSES_APIS.has(model.api)) {
    const tools = withoutExternalSearch(array(body.tools));
    if (xaiModel(model)) {
      const hasWeb = tools.some((value) => object(value)?.type === "web_search");
      const hasX = tools.some((value) => object(value)?.type === "x_search");
      return {
        ...body,
        tools: [
          ...tools,
          ...(hasWeb ? [] : [{ type: "web_search" }]),
          ...(hasX ? [] : [{ type: "x_search" }]),
        ],
      };
    }
    const nativeType = openRouter(model) ? "openrouter:web_search" : "web_search";
    const present = tools.some((value) => [nativeType, "web_search_preview", "web_search_2025_08_26"].includes(String(object(value)?.type)));
    return { ...body, tools: present ? tools : [...tools, { type: nativeType }],
      include: [...new Set([...array(body.include), "web_search_call.action.sources"])] };
  }
  throw new Error("当前模型接口不支持配置联网搜索，请关闭原生工具或更换模型接口。");
}

class NativeSearchCapture {
  readonly #sources = new Map<string, WebSource>();
  readonly #results = new Map<string, WebSource>();
  readonly blocks = new Map<number, ObjectValue>();
  readonly #inputs = new Map<number, string>();
  #rawBytes = 0;
  #rawOverflow = false;
  suggestion?: string;
  failure?: string;

  begin(): void { this.blocks.clear(); this.#inputs.clear(); this.#rawBytes = 0; this.#rawOverflow = false; }
  sources(): WebSource[] { return sanitizeSearchSources([...this.#sources.values()]); }
  rawBlocks(): ObjectValue[] {
    if (this.#rawOverflow) throw new Error("模型原生搜索历史超过保存上限，无法完整重放，请新建对话重试。");
    return structuredClone([...this.blocks].sort(([left], [right]) => left - right).map(([, block]) => block));
  }

  #reserve(bytes: number): boolean {
    this.#rawBytes += bytes;
    if (this.#rawBytes > MAX_NATIVE_CONTENT_BYTES) {
      this.#rawOverflow = true;
      this.failure = "模型原生搜索历史超过保存上限，无法完整重放，请新建对话重试。";
      return false;
    }
    return true;
  }

  #append(block: ObjectValue | undefined, key: string, value: unknown): void {
    if (!block || typeof value !== "string" || !this.#reserve(Buffer.byteLength(value, "utf8"))) return;
    block[key] = `${typeof block[key] === "string" ? block[key] : ""}${value}`;
  }

  #add(urlValue: unknown, titleValue?: unknown, snippetValue?: unknown, cited = true): void {
    const url = normalizeWebSourceUrl(urlValue);
    if (!url) return;
    const prior = this.#sources.get(url) ?? this.#results.get(url);
    const title = text(titleValue, 300) ?? prior?.title ?? new URL(url).hostname;
    const snippet = text(snippetValue, 2_000) ?? prior?.snippet;
    const source = { id: webSourceId(url), title, url, ...(snippet ? { snippet } : {}), fetchedAt: Date.now() };
    const target = cited ? this.#sources : this.#results;
    if (target.size < 40 || target.has(url)) target.set(url, source);
  }

  observe(value: unknown): void {
    const event = object(value);
    if (!event) return;
    const index = typeof event.index === "number" ? event.index : undefined;
    if (event.type === "content_block_start" && index !== undefined && object(event.content_block) && this.#reserve(Buffer.byteLength(JSON.stringify(event.content_block), "utf8"))) {
      this.blocks.set(index, structuredClone(event.content_block as ObjectValue));
    }
    if (event.type === "content_block_delta" && index !== undefined) {
      const delta = object(event.delta);
      const block = this.blocks.get(index);
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const prior = this.#inputs.get(index) ?? "";
        if (this.#reserve(Buffer.byteLength(delta.partial_json, "utf8"))) this.#inputs.set(index, prior + delta.partial_json);
      }
      if (delta?.type === "text_delta") this.#append(block, "text", delta.text);
      if (delta?.type === "thinking_delta") this.#append(block, "thinking", delta.thinking);
      if (delta?.type === "signature_delta") this.#append(block, "signature", delta.signature);
      if (block && delta?.type === "citations_delta" && delta.citation && this.#reserve(Buffer.byteLength(JSON.stringify(delta.citation), "utf8"))) block.citations = [...array(block.citations), structuredClone(delta.citation)];
    }
    if (event.type === "content_block_stop" && index !== undefined && this.#inputs.has(index)) {
      const block = this.blocks.get(index);
      if (block) {
        try { block.input = JSON.parse(this.#inputs.get(index)!); }
        catch { this.failure = "原生搜索返回了无效工具参数。"; }
      }
    }
    this.#visit(event, 0);
  }

  #visit(value: unknown, depth: number): void {
    if (depth > 9) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) this.#visit(item, depth + 1); return; }
    const item = object(value);
    if (!item) return;
    if (Array.isArray(item.citations)) {
      for (const entry of item.citations.slice(0, 60)) {
        if (typeof entry === "string") this.#add(entry, undefined, undefined, true);
      }
    }
    if (["url_citation", "web_search_result_location"].includes(String(item.type))) {
      const citation = object(item.url_citation) ?? item;
      this.#add(citation.url, citation.title, citation.cited_text);
    }
    if (item.type === "web_search_result") this.#add(item.url, item.title, item.snippet, false);
    if (item.type === "web_search_call") {
      if (item.status === "failed") this.failure = "模型原生搜索调用失败，请重试。";
      for (const result of array(object(item.action)?.sources)) { const source = object(result); this.#add(source?.url, source?.title, source?.snippet, false); }
    }
    if (item.type === "web_search_tool_result_error") {
      const code = typeof item.error_code === "string" && /^[a-z_]{1,80}$/.test(item.error_code) ? `（${item.error_code}）` : "";
      this.failure = `模型原生搜索未完成${code}。`;
    }
    const grounding = object(item.groundingMetadata ?? item.grounding_metadata);
    if (grounding) {
      const chunks = array(grounding.groundingChunks ?? grounding.grounding_chunks);
      const supports = array(grounding.groundingSupports ?? grounding.grounding_supports);
      chunks.forEach((value, index) => {
        const web = object(object(value)?.web);
        const supported = supports.filter((support) => array(object(support)?.groundingChunkIndices ?? object(support)?.grounding_chunk_indices).includes(index));
        this.#add(web?.uri ?? web?.url, web?.title, supported.map((support) => text(object(object(support)?.segment)?.text, 2_000)).filter(Boolean).join("\n"), supported.length > 0);
      });
      const entry = object(grounding.searchEntryPoint ?? grounding.search_entry_point);
      const html = text(entry?.renderedContent ?? entry?.rendered_content, 24_001);
      if (html) this.suggestion = sanitizeSearchSuggestions(html) || undefined;
    }
    for (const key of ["response", "item", "output", "content", "annotations", "annotation", "delta", "citation", "content_block", "candidates", "message"]) {
      if (item[key] !== undefined) this.#visit(item[key], depth + 1);
    }
  }
}

function failureMessage(model: Model<Api>, error: unknown): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: "error", errorMessage: error instanceof Error ? error.message : "模型原生工具请求失败。", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function mergeAssistant(previous: AssistantMessage | undefined, current: AssistantMessage): AssistantMessage {
  if (!previous) return current;
  const usage = { ...current.usage, cost: { ...current.usage.cost } };
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += previous.usage[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += previous.usage.cost[key];
  return { ...current, content: [...previous.content, ...current.content], usage, timestamp: previous.timestamp };
}

function nativePartial(message: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.map((block) => {
    if (block.type !== "thinking") return { ...block };
    const { thinkingSignature: _signature, redacted: _redacted, ...visible } = block;
    return visible;
  }) };
}

function nativeStream(
  models: Models, method: "stream" | "streamSimple", model: Model<Api>, context: Context,
  options: ModelsSimpleStreamOptions | ModelsApiStreamOptions<Api> | undefined, config: NativeToolsModelsOptions, webSearch: boolean,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const capture = new NativeSearchCapture();
  void (async () => {
    let previous: AssistantMessage | undefined;
    let continuation: unknown[] | undefined;
    let messages: unknown[] | undefined;
    let nativeBlocks: ObjectValue[] = [];
    let replay: NativeReplay | undefined;
    try {
      replay = model.api === "anthropic-messages" ? prepareNativeReplay(context, model) : undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        options?.signal?.throwIfAborted();
        capture.begin();
        const request: StreamOptions = {
          ...options,
          ...(config.fetch && !GOOGLE_APIS.has(model.api) && !options?.fetch ? { fetch: config.fetch } : {}),
          ...(model.api === "openai-codex-responses" && !options?.transport ? { transport: "sse" as const } : {}),
          ...(model.api === "anthropic-messages" ? { disableContinuation: true } : {}),
          onPayload: async (value, chosen) => {
            const changed = await options?.onPayload?.(value, chosen);
            const input = object(changed ?? value);
            if (!input) throw new Error("模型原生工具请求格式无效。");
            const restored = replay?.restore(input) ?? input;
            const payload = webSearch ? addNativeWebSearch(restored, chosen) : restored;
            const body = object(payload)!;
            if (chosen.api === "anthropic-messages") {
              if (continuation) return { ...body, messages: continuation };
              messages = array(body.messages);
            }
            return payload;
          },
          onProviderStreamEvent: async (value, chosen) => {
            await options?.onProviderStreamEvent?.(value, chosen);
            capture.observe(value);
          },
        };
        const upstream = method === "streamSimple"
          ? models.streamSimple(model, replay?.context ?? context, request as ModelsSimpleStreamOptions)
          : models.stream(model, replay?.context ?? context, request as ModelsApiStreamOptions<Api>);
        let result: AssistantMessage | undefined;
        for await (const event of upstream) {
          if (event.type === "done" || event.type === "error") result = event.type === "done" ? event.message : event.error;
          else {
            const partial = previous ? mergeAssistant(previous, event.partial) : event.partial;
            // Incomplete signatures have no validated envelope yet and are unnecessary for live text display.
            stream.push(model.api === "anthropic-messages" ? { ...event, partial: nativePartial(partial) } : previous ? { ...event, partial } : event);
          }
        }
        result ??= await upstream.result();
        options?.signal?.throwIfAborted();
        if (model.api === "anthropic-messages") {
          nativeBlocks = [...nativeBlocks, ...capture.rawBlocks()];
          assertNativeContentSize(nativeBlocks);
        }
        if (model.api === "anthropic-messages" && result.rawStopReason === "pause_turn" && !capture.failure) {
          const blocks = [...capture.blocks].sort(([left], [right]) => left - right).map(([, value]) => value);
          if (!blocks.length || !messages || attempt === 2) throw new Error("模型原生搜索尚未完成，请重试。");
          continuation = [...(continuation ?? messages), { role: "assistant", content: blocks }];
          previous = mergeAssistant(previous, result);
          continue;
        }
        const complete = mergeAssistant(previous, result) as NativeSearchMessage;
        if (capture.failure && !["error", "aborted"].includes(complete.stopReason)) {
          complete.stopReason = "error"; complete.errorMessage = capture.failure;
        }
        if (!["error", "aborted", "length", "pending", "deferred"].includes(complete.stopReason)) {
          const sources = capture.sources();
          if (sources.length) {
            complete.kuloSearchSources = sources;
            if (capture.suggestion) complete.kuloSearchSuggestions = [capture.suggestion];
          }
          if (model.api === "anthropic-messages" && nativeBlocks.some((block) => block.type === "server_tool_use" || block.type === "web_search_tool_result" || array(block.citations).length > 0)) {
            assertNativeBlocksMatch(nativeBlocks, complete, model);
            complete.kuloNativeContent = {
              version: 1, provider: model.provider, api: "anthropic-messages", model: model.id,
              ...(complete.responseId ? { responseId: complete.responseId } : {}),
              contentHash: nativeContentHash(complete.content), blocks: nativeBlocks,
            };
          }
        }
        if (complete.stopReason === "error" || complete.stopReason === "aborted") stream.push({ type: "error", reason: complete.stopReason, error: complete });
        else stream.push({ type: "done", reason: complete.stopReason as "stop" | "length" | "toolUse" | "deferred", message: complete });
        stream.end(complete);
        return;
      }
    } catch (error) {
      const message = failureMessage(model, error);
      if (options?.signal?.aborted) message.stopReason = "aborted";
      stream.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
      stream.end(message);
    } finally {
      replay?.release();
    }
  })();
  return stream;
}

/** Keep native tools scoped to the model selected for this generation, including workers. */
export function withNativeToolsModels(models: Models, config: NativeToolsModelsOptions): Models {
  return new Proxy(models, {
    get(target, property) {
      if (["stream", "streamSimple", "complete", "completeSimple"].includes(String(property))) {
        return (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions | ModelsApiStreamOptions<Api>) => {
          // Saved settings can outlive an API change or a legacy plan migration.
          // Keep the agent's search function when this API cannot combine its tools.
          const compatible = supportsNativeWebSearch(model.api, model) &&
            (!GOOGLE_APIS.has(model.api) || !context.tools?.some((tool) => tool.name !== "web_search"));
          const webSearch = compatible && Boolean(config.getNativeTools(model.provider, model.id)?.webSearch);
          const hasNativeHistory = model.api === "anthropic-messages" && context.messages.some((message) => message.role === "assistant" && message.provider === model.provider && message.api === model.api && message.model === model.id && (message as NativeSearchMessage).kuloNativeContent !== undefined);
          if (!webSearch && !hasNativeHistory) {
            const member = target[property as "stream"] as (...args: unknown[]) => unknown;
            return member.call(target, model, context, options);
          }
          const method = property === "streamSimple" || property === "completeSimple" ? "streamSimple" : "stream";
          const result = nativeStream(target, method, model, context, options, config, webSearch);
          return property === "complete" || property === "completeSimple" ? result.result() : result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
