import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Api, AssistantMessage, Context, ImageContent, Message, Model, Models, TextContent } from "@earendil-works/pi-ai";

export const MEMORY_LLM_BRIDGE_OWNER = "kulo-memory-llm-bridge-v1";
export const MEMORY_LLM_BRIDGE_FILENAME = "memory-llm-bridge.json";
export const MEMORY_LLM_BRIDGE_PATH = "/api/internal/memory-llm/call";

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["maxItems", "minLength", "maxLength"]);
const SCHEMA_MAP_KEYS = new Set(["$defs", "definitions", "properties", "patternProperties"]);

export interface MemoryLlmBridgeErrorBody {
  code:
    | "bridge_unauthorized"
    | "invalid_request"
    | "model_not_found"
    | "auth"
    | "content_policy"
    | "output_too_long"
    | "rate_limit"
    | "upstream_error";
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export class MemoryLlmBridgeError extends Error {
  constructor(
    readonly status: number,
    readonly body: MemoryLlmBridgeErrorBody,
  ) {
    super(body.message);
    this.name = "MemoryLlmBridgeError";
  }
}

export interface MemoryLlmBridgeResponse {
  text: string;
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    thoughtsTokens: number;
    totalTokens: number;
  };
  provider: string;
  model: string;
}

interface NormalizedBridgeMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<TextContent | ImageContent>;
}

interface NormalizedBridgeRequest {
  providerId: string;
  modelId: string;
  messages: NormalizedBridgeMessage[];
  responseSchema?: { name: string; schema: Record<string, unknown>; strict: boolean };
  maxCompletionTokens?: number;
  temperature?: number;
  scope?: string;
}

function stripUnsupportedAnthropicKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedAnthropicKeywords);
  if (!node || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === "minItems" && value !== 0 && value !== 1) continue;
    if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
        mapped[subKey] = stripUnsupportedAnthropicKeywords(subVal);
      }
      result[key] = mapped;
    } else {
      result[key] = stripUnsupportedAnthropicKeywords(value);
    }
  }
  return result;
}

function parseDataUrlImage(url: string): ImageContent | undefined {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url.trim());
  if (!match) return undefined;
  return { type: "image", mimeType: match[1]!, data: match[2]! };
}

function normalizeMessageContent(raw: unknown): string | Array<TextContent | ImageContent> {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return String(raw ?? "");
  const parts: Array<TextContent | ImageContent> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      parts.push({ type: "text", text: String(item ?? "") });
      continue;
    }
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const imageUrl = part.image_url;
      const url = typeof imageUrl === "string"
        ? imageUrl
        : imageUrl && typeof imageUrl === "object" && typeof (imageUrl as Record<string, unknown>).url === "string"
          ? String((imageUrl as Record<string, unknown>).url)
          : "";
      const parsed = parseDataUrlImage(url);
      if (parsed) parts.push(parsed);
    } else if (part.type === "image" && typeof part.mimeType === "string" && typeof part.data === "string") {
      parts.push({ type: "image", mimeType: part.mimeType, data: part.data });
    }
  }
  return parts.length ? parts : "";
}

function contentAsPlainText(content: string | Array<TextContent | ImageContent>): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function validateRequest(raw: unknown): NormalizedBridgeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MemoryLlmBridgeError(400, { code: "invalid_request", message: "请求体格式无效。", retryable: false });
  }
  const obj = raw as Record<string, unknown>;
  const allowedKeys = new Set(["providerId", "modelId", "messages", "responseSchema", "maxCompletionTokens", "temperature", "scope"]);
  if (Object.keys(obj).some((key) => !allowedKeys.has(key))) {
    throw new MemoryLlmBridgeError(400, { code: "invalid_request", message: "请求包含不支持的字段。", retryable: false });
  }
  const providerId = typeof obj.providerId === "string" ? obj.providerId.trim() : "";
  const modelId = typeof obj.modelId === "string" ? obj.modelId.trim() : "";
  if (!providerId || providerId.length > 160 || /[\x00-\x1f\x7f]/.test(providerId) ||
    !modelId || modelId.length > 240 || /[\x00-\x1f\x7f]/.test(modelId)) {
    throw new MemoryLlmBridgeError(400, { code: "invalid_request", message: "模型标识无效。", retryable: false });
  }
  if (!Array.isArray(obj.messages) || obj.messages.length === 0 || obj.messages.length > 200) {
    throw new MemoryLlmBridgeError(400, { code: "invalid_request", message: "消息列表无效。", retryable: false });
  }
  const messages: NormalizedBridgeMessage[] = obj.messages.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MemoryLlmBridgeError(400, { code: "invalid_request", message: "消息条目无效。", retryable: false });
    }
    const item = entry as Record<string, unknown>;
    const rawRole = typeof item.role === "string" ? item.role : "user";
    const role: NormalizedBridgeMessage["role"] = rawRole === "system" || rawRole === "developer"
      ? "system"
      : rawRole === "assistant"
        ? "assistant"
        : "user";
    return { role, content: normalizeMessageContent(item.content) };
  });

  let responseSchema: NormalizedBridgeRequest["responseSchema"];
  if (obj.responseSchema !== undefined && obj.responseSchema !== null) {
    if (typeof obj.responseSchema !== "object" || Array.isArray(obj.responseSchema)) {
      throw new MemoryLlmBridgeError(400, { code: "invalid_request", message: "responseSchema 无效。", retryable: false });
    }
    const rs = obj.responseSchema as Record<string, unknown>;
    if (!rs.schema || typeof rs.schema !== "object" || Array.isArray(rs.schema)) {
      throw new MemoryLlmBridgeError(400, { code: "invalid_request", message: "responseSchema.schema 无效。", retryable: false });
    }
    const rawName = typeof rs.name === "string" && rs.name.trim() ? rs.name.trim() : "response";
    const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "response";
    responseSchema = {
      name: safeName,
      schema: rs.schema as Record<string, unknown>,
      strict: Boolean(rs.strict),
    };
  }

  let maxCompletionTokens: number | undefined;
  if (obj.maxCompletionTokens !== undefined && obj.maxCompletionTokens !== null) {
    if (typeof obj.maxCompletionTokens !== "number" || !Number.isFinite(obj.maxCompletionTokens) || obj.maxCompletionTokens < 1 || obj.maxCompletionTokens > 131_072) {
      throw new MemoryLlmBridgeError(400, { code: "invalid_request", message: "maxCompletionTokens 无效。", retryable: false });
    }
    maxCompletionTokens = Math.trunc(obj.maxCompletionTokens);
  }

  let temperature: number | undefined;
  if (obj.temperature !== undefined && obj.temperature !== null) {
    if (typeof obj.temperature !== "number" || !Number.isFinite(obj.temperature) || obj.temperature < 0 || obj.temperature > 2) {
      throw new MemoryLlmBridgeError(400, { code: "invalid_request", message: "temperature 无效。", retryable: false });
    }
    temperature = obj.temperature;
  }

  const scope = typeof obj.scope === "string" ? obj.scope.slice(0, 64) : undefined;
  return { providerId, modelId, messages, responseSchema, maxCompletionTokens, temperature, scope };
}

function buildContext(
  model: Model<Api>,
  messages: NormalizedBridgeMessage[],
  schemaPromptSuffix?: string,
): Context {
  const systemParts: string[] = [];
  const conversation: Message[] = [];
  const now = Date.now();

  for (const item of messages) {
    if (item.role === "system") {
      const text = contentAsPlainText(item.content).trim();
      if (text) systemParts.push(text);
    } else if (item.role === "assistant") {
      const text = contentAsPlainText(item.content);
      const assistant: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: now,
      };
      conversation.push(assistant);
    } else {
      conversation.push({
        role: "user",
        content: item.content,
        timestamp: now,
      });
    }
  }

  if (schemaPromptSuffix) {
    systemParts.push(schemaPromptSuffix);
  }
  if (!conversation.length) {
    conversation.push({ role: "user", content: "Respond according to the instructions.", timestamp: now });
  }

  const systemPrompt = systemParts.join("\n\n").trim();
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: conversation,
  };
}

function supportsNativeSchema(api: Api): boolean {
  return api === "google-vertex"
    || api === "google-generative-ai"
    || api === "openai-completions"
    || api === "openai-responses"
    || api === "openai-codex-responses"
    || api === "azure-openai-responses"
    || api === "anthropic-messages";
}

function injectNativeSchema(
  api: Api,
  payload: unknown,
  schema: { name: string; schema: Record<string, unknown>; strict: boolean },
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const copy = { ...(payload as Record<string, unknown>) };
  if (api === "google-vertex" || api === "google-generative-ai") {
    const config = copy.config && typeof copy.config === "object" && !Array.isArray(copy.config)
      ? { ...(copy.config as Record<string, unknown>) }
      : {};
    config.responseMimeType = "application/json";
    config.responseJsonSchema = schema.schema;
    copy.config = config;
    return copy;
  }
  if (api === "openai-completions") {
    copy.response_format = {
      type: "json_schema",
      json_schema: {
        name: schema.name,
        strict: schema.strict,
        schema: schema.schema,
      },
    };
    return copy;
  }
  if (api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses") {
    const text = copy.text && typeof copy.text === "object" && !Array.isArray(copy.text)
      ? { ...(copy.text as Record<string, unknown>) }
      : {};
    text.format = {
      type: "json_schema",
      name: schema.name,
      strict: schema.strict,
      schema: schema.schema,
    };
    copy.text = text;
    return copy;
  }
  if (api === "anthropic-messages") {
    const outputConfig = copy.output_config && typeof copy.output_config === "object" && !Array.isArray(copy.output_config)
      ? { ...(copy.output_config as Record<string, unknown>) }
      : {};
    outputConfig.format = {
      type: "json_schema",
      schema: stripUnsupportedAnthropicKeywords(schema.schema),
    };
    copy.output_config = outputConfig;
    return copy;
  }
  return copy;
}

function classifyProviderError(message: string): MemoryLlmBridgeError {
  const lower = message.toLowerCase();
  if (/(?:\b401\b|\b403\b|unauthorized|invalid[_\s-]*api[_\s-]*key|authentication|permission[_\s-]*denied|api key not valid|unauthenticated)/.test(lower)) {
    return new MemoryLlmBridgeError(403, { code: "auth", message, retryable: false });
  }
  if (/(?:content[_\s-]*filter|content[_\s-]*policy|safety|blocked|refusal|prohibited)/.test(lower)) {
    return new MemoryLlmBridgeError(400, { code: "content_policy", message, retryable: false });
  }
  if (/(?:\b429\b|rate[_\s-]*limit|quota|resource[_\s-]*exhausted|too many requests)/.test(lower)) {
    const retryMatch = /retry[^\d]{0,16}(\d+(?:\.\d+)?)\s*s/i.exec(message);
    const retryAfterSeconds = retryMatch ? Number(retryMatch[1]) : undefined;
    return new MemoryLlmBridgeError(429, {
      code: "rate_limit",
      message,
      retryable: true,
      ...(retryAfterSeconds && Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
    });
  }
  const retryable = /(?:\b5\d\d\b|timeout|timed out|overloaded|temporar|unavailable|econnreset|socket|fetch failed|network)/.test(lower);
  return new MemoryLlmBridgeError(retryable ? 502 : 400, { code: "upstream_error", message, retryable });
}

function looksLikeSchemaRejection(message: string): boolean {
  const lower = message.toLowerCase();
  return !/(?:\b401\b|\b403\b|\b429\b|unauthorized|authentication|rate[_\s-]*limit|quota|content[_\s-]*policy)/.test(lower)
    && /(?:\b400\b|bad request|schema|response_format|responsejsonschema|response_json_schema|output_config|text\.format|structured|additionalproperties|unsupported|invalid argument|invalid_request_error)/.test(lower);
}

function extractTextFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export interface MemoryLlmBridgeOptions {
  stateDir: string;
  models: Models;
  redact?: (value: string) => string;
}

export class MemoryLlmBridge {
  readonly descriptorPath: string;
  readonly #models: Models;
  readonly #redact: (value: string) => string;
  #token = randomBytes(32).toString("hex");
  #published = false;

  constructor(options: MemoryLlmBridgeOptions) {
    this.descriptorPath = path.join(path.resolve(options.stateDir), MEMORY_LLM_BRIDGE_FILENAME);
    this.#models = options.models;
    this.#redact = options.redact ?? ((value) => value);
  }

  get published(): boolean {
    return this.#published;
  }

  publish(port: number): () => void {
    const token = randomBytes(32).toString("hex");
    this.#token = token;
    const url = `http://127.0.0.1:${port}${MEMORY_LLM_BRIDGE_PATH}`;
    const dir = path.dirname(this.descriptorPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const info = fs.lstatSync(this.descriptorPath);
      if (info.isSymbolicLink()) throw new Error("Memory LLM bridge descriptor cannot be a symlink.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const tmp = `${this.descriptorPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ owner: MEMORY_LLM_BRIDGE_OWNER, url, token, pid: process.pid }), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, this.descriptorPath);
    fs.chmodSync(this.descriptorPath, 0o600);
    this.#published = true;

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.#token === token) this.#published = false;
      try {
        const info = fs.lstatSync(this.descriptorPath);
        if (!info.isFile() || info.isSymbolicLink()) return;
        const current = JSON.parse(fs.readFileSync(this.descriptorPath, "utf8")) as { token?: string };
        if (current.token === token) fs.unlinkSync(this.descriptorPath);
      } catch {
        // Already removed or replaced by a newer listener.
      }
    };
  }

  authenticate(req: http.IncomingMessage): boolean {
    if (!this.#published) return false;
    const remote = req.socket.remoteAddress ?? "";
    if (!LOOPBACK_ADDRS.has(remote)) return false;
    if (req.headers["x-kulo-connector"] !== undefined || req.headers["x-moco-connector"] !== undefined) return false;
    const headerToken = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!headerToken || headerToken.length > 512) return false;
    const supplied = Buffer.from(headerToken);
    const expected = Buffer.from(this.#token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async handleCall(rawBody: unknown, signal?: AbortSignal): Promise<MemoryLlmBridgeResponse> {
    const request = validateRequest(rawBody);
    const model = this.#models.getModel(request.providerId, request.modelId);
    if (!model) {
      throw new MemoryLlmBridgeError(404, {
        code: "model_not_found",
        message: `模型 ${request.providerId}/${request.modelId} 未在 Kulo 中配置或不可用。`,
        retryable: false,
      });
    }

    const invoke = async (useNativeSchema: boolean): Promise<AssistantMessage> => {
      const schemaPromptSuffix = request.responseSchema && !useNativeSchema
        ? `You must respond ONLY with valid JSON matching this schema (no markdown code fences or extra text):\n${JSON.stringify(request.responseSchema.schema, null, 2)}`
        : undefined;
      const context = buildContext(model, request.messages, schemaPromptSuffix);
      const maxTokens = request.maxCompletionTokens !== undefined
        ? Math.min(request.maxCompletionTokens, model.maxTokens || request.maxCompletionTokens)
        : undefined;
      return this.#models.completeSimple(model, context, {
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(signal ? { signal } : {}),
        cacheRetention: "none",
        ...(request.responseSchema && useNativeSchema
          ? {
              onPayload: (payload: unknown) => injectNativeSchema(model.api, payload, request.responseSchema!),
            }
          : {}),
      });
    };

    const tryNative = Boolean(request.responseSchema && supportsNativeSchema(model.api));
    let assistant: AssistantMessage;
    try {
      assistant = await invoke(tryNative);
      if (assistant.stopReason === "error" && tryNative && looksLikeSchemaRejection(assistant.errorMessage ?? "")) {
        assistant = await invoke(false);
      }
    } catch (error) {
      const message = this.#redact(error instanceof Error ? error.message : String(error));
      if (tryNative && looksLikeSchemaRejection(message)) {
        try {
          assistant = await invoke(false);
        } catch (fallbackError) {
          throw classifyProviderError(this.#redact(fallbackError instanceof Error ? fallbackError.message : String(fallbackError)));
        }
      } else {
        throw classifyProviderError(message);
      }
    }

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      const message = this.#redact(assistant.errorMessage || `Model call failed (${assistant.stopReason})`);
      throw classifyProviderError(message);
    }

    const text = extractTextFromAssistant(assistant);
    const inputTokens = assistant.usage?.input ?? 0;
    const outputTokens = assistant.usage?.output ?? 0;
    const cachedTokens = assistant.usage?.cacheRead ?? 0;
    const totalTokens = assistant.usage?.totalTokens ?? (inputTokens + outputTokens);

    return {
      text,
      stopReason: assistant.stopReason,
      usage: {
        inputTokens,
        outputTokens,
        cachedTokens,
        thoughtsTokens: 0,
        totalTokens,
      },
      provider: request.providerId,
      model: request.modelId,
    };
  }
}
