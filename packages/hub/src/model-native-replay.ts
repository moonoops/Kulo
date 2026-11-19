import { createHash, randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
export const MAX_NATIVE_CONTENT_BYTES = 2 * 1024 * 1024;
const REPLAY_ERROR = "模型原生搜索历史已变更，无法完整重放，请新建对话重试。";

export interface NativeContentEnvelope {
  version: 1;
  provider: string;
  api: "anthropic-messages";
  model: string;
  responseId?: string;
  contentHash: string;
  blocks: ObjectValue[];
}

export type NativeContentMessage = AssistantMessage & { kuloNativeContent?: NativeContentEnvelope };
export interface NativeOpaqueField { owner: Record<string, unknown>; field: string; path: Array<string | number> }
interface ReplayAnchor { end: string; envelope: NativeContentEnvelope; visible: unknown[] }
const activeReplayAnchors = new Map<string, ReplayAnchor>();

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    const record = object(item);
    return record ? Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])])) : item;
  };
  return JSON.stringify(normalize(value));
}

export function nativeContentHash(content: AssistantMessage["content"]): string {
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

export function assertNativeContentSize(value: unknown): void {
  if (Array.isArray(value) && value.length > 1000 || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_NATIVE_CONTENT_BYTES) throw new Error("模型原生搜索历史超过保存上限，无法完整重放，请新建对话重试。");
}

/** Validate the envelope before treating provider signatures as opaque rather than ordinary prose. */
export function nativeContentEnvelope(value: unknown): NativeContentEnvelope | undefined {
  const envelope = object(value);
  if (!envelope || envelope.version !== 1 || envelope.api !== "anthropic-messages" ||
    Object.keys(envelope).some((key) => !["version", "provider", "api", "model", "responseId", "contentHash", "blocks"].includes(key)) ||
    typeof envelope.provider !== "string" || !envelope.provider || envelope.provider.length > 200 ||
    typeof envelope.model !== "string" || !envelope.model || envelope.model.length > 500 ||
    typeof envelope.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(envelope.contentHash) ||
    (envelope.responseId !== undefined && (typeof envelope.responseId !== "string" || envelope.responseId.length > 500)) ||
    !Array.isArray(envelope.blocks) || !envelope.blocks.length || envelope.blocks.length > 1000 ||
    envelope.blocks.some((block) => !object(block) || typeof object(block)?.type !== "string")) return undefined;
  assertNativeContentSize(envelope);
  return envelope as unknown as NativeContentEnvelope;
}

function visibleWireContent(content: AssistantMessage["content"], model: Model<Api>): unknown[] {
  return content.flatMap((block): unknown[] => {
    if (block.type === "text") return block.text.trim() ? [["text", sanitizeSurrogates(block.text)]] : [];
    if (block.type === "toolCall") return [["tool_use", block.id, block.name.toLowerCase(), block.arguments ?? {}]];
    if (block.redacted) return [["redacted_thinking", block.thinkingSignature]];
    if (!block.thinking.trim() && !block.thinkingSignature?.trim()) return [];
    if (block.thinkingSignature?.trim() || object(model.compat)?.allowEmptySignature === true) return [["thinking", sanitizeSurrogates(block.thinking), block.thinkingSignature ?? ""]];
    return [["text", sanitizeSurrogates(block.thinking)]];
  });
}

function wireContent(content: unknown[]): unknown[] {
  return content.flatMap((value): unknown[] => {
    const block = object(value);
    if (!block) return [];
    if (block.type === "text") return typeof block.text === "string" && block.text.trim() ? [["text", block.text]] : [];
    if (block.type === "tool_use") return [["tool_use", block.id, String(block.name).toLowerCase(), block.input ?? {}]];
    if (block.type === "thinking") return [["thinking", block.thinking, block.signature]];
    if (block.type === "redacted_thinking") return [["redacted_thinking", block.data]];
    return [["unknown", block.type]];
  });
}

export function assertNativeBlocksMatch(blocks: ObjectValue[], message: AssistantMessage, model: Model<Api>): void {
  const visible = blocks.filter((block) => ["text", "tool_use", "thinking", "redacted_thinking"].includes(String(block.type)));
  if (stableJson(wireContent(visible)) !== stableJson(visibleWireContent(message.content, model))) throw new Error(REPLAY_ERROR);
}

const GOOGLE_THOUGHT_SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;

function isGoogleThoughtSignature(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NATIVE_CONTENT_BYTES &&
    value.length % 4 === 0 && GOOGLE_THOUGHT_SIGNATURE.test(value);
}

function isOpaqueProviderSignature(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NATIVE_CONTENT_BYTES &&
    !/^\s*[\[{]/.test(value);
}

/** Only provider-owned signed fields inside a bound assistant envelope or typed signature slot may bypass prose heuristics. */
export function nativeAssistantOpaqueFields(value: unknown): NativeOpaqueField[] {
  const message = object(value);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  if (message.api === "google-vertex" || message.api === "google-generative-ai") {
    const fields: NativeOpaqueField[] = [];
    for (const [index, item] of message.content.entries()) {
      const block = object(item);
      if (block?.type === "thinking" && isGoogleThoughtSignature(block.thinkingSignature)) {
        fields.push({ owner: block, field: "thinkingSignature", path: ["content", index, "thinkingSignature"] });
      }
      if (block?.type === "text" && isGoogleThoughtSignature(block.textSignature)) {
        fields.push({ owner: block, field: "textSignature", path: ["content", index, "textSignature"] });
      }
      if (block?.type === "toolCall" && isGoogleThoughtSignature(block.thoughtSignature)) {
        fields.push({ owner: block, field: "thoughtSignature", path: ["content", index, "thoughtSignature"] });
      }
    }
    return fields;
  }
  if ((message.api === "anthropic-messages" || message.api === "bedrock-converse-stream") && message.kuloNativeContent === undefined) {
    const fields: NativeOpaqueField[] = [];
    for (const [index, item] of message.content.entries()) {
      const block = object(item);
      if (block?.type === "thinking" && isOpaqueProviderSignature(block.thinkingSignature)) {
        fields.push({ owner: block, field: "thinkingSignature", path: ["content", index, "thinkingSignature"] });
      }
    }
    return fields;
  }
  if (message.api !== "anthropic-messages") return [];
  const envelope = nativeContentEnvelope(message.kuloNativeContent);
  if (!envelope || envelope.provider !== message.provider || envelope.api !== message.api || envelope.model !== message.model ||
    envelope.responseId !== message.responseId || envelope.contentHash !== nativeContentHash(message.content as AssistantMessage["content"])) return [];
  assertNativeBlocksMatch(envelope.blocks, message as unknown as AssistantMessage, { compat: { allowEmptySignature: true } } as Model<Api>);
  const fields: NativeOpaqueField[] = [];
  const signatures = new Set<string>();
  const add = (owner: ObjectValue | undefined, field: string, path: Array<string | number>) => {
    if (owner && typeof owner[field] === "string" && owner[field]) fields.push({ owner, field, path: [...path, field] });
  };
  for (const [index, block] of envelope.blocks.entries()) {
    const blockPath = ["kuloNativeContent", "blocks", index];
    if (block.type === "thinking") { add(block, "signature", blockPath); if (typeof block.signature === "string") signatures.add(block.signature); }
    if (block.type === "redacted_thinking") { add(block, "data", blockPath); if (typeof block.data === "string") signatures.add(block.data); }
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) for (const [resultIndex, item] of block.content.entries()) {
      const result = object(item);
      if (result?.type === "web_search_result") add(result, "encrypted_content", [...blockPath, "content", resultIndex]);
    }
    if (block.type === "text" && Array.isArray(block.citations)) for (const [citationIndex, item] of block.citations.entries()) {
      const citation = object(item);
      if (citation?.type === "web_search_result_location") add(citation, "encrypted_index", [...blockPath, "citations", citationIndex]);
    }
  }
  for (const [index, item] of message.content.entries()) {
    const block = object(item);
    if (block?.type === "thinking" && typeof block.thinkingSignature === "string" && signatures.has(block.thinkingSignature)) add(block, "thinkingSignature", ["content", index]);
  }
  return fields;
}

/** Request markers and typed model signature slots authorize only provider-signed payloads from history. */
export function nativeWireOpaqueFields(value: unknown): NativeOpaqueField[] {
  const payload = object(value);
  const fields: NativeOpaqueField[] = [];
  if (Array.isArray(payload?.contents)) {
    for (const [contentIndex, item] of payload.contents.entries()) {
      const content = object(item);
      if (content?.role !== "model" || !Array.isArray(content.parts)) continue;
      for (const [partIndex, candidate] of content.parts.entries()) {
        const part = object(candidate);
        if (part && isGoogleThoughtSignature(part.thoughtSignature)) {
          fields.push({ owner: part, field: "thoughtSignature", path: ["contents", contentIndex, "parts", partIndex, "thoughtSignature"] });
        }
      }
    }
  }
  if (!Array.isArray(payload?.messages)) return fields;
  for (const [messageIndex, item] of payload.messages.entries()) {
    const message = object(item);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content;
    for (let index = 0; index < blocks.length; index++) {
      const marker = object(blocks[index]);
      const anchor = marker?.type === "text" && typeof marker.text === "string" ? activeReplayAnchors.get(marker.text) : undefined;
      if (!anchor) {
        if (marker?.type === "thinking" && isOpaqueProviderSignature(marker.signature)) {
          fields.push({ owner: marker, field: "signature", path: ["messages", messageIndex, "content", index, "signature"] });
        }
        if (marker?.type === "redacted_thinking" && isOpaqueProviderSignature(marker.data)) {
          fields.push({ owner: marker, field: "data", path: ["messages", messageIndex, "content", index, "data"] });
        }
        continue;
      }
      const end = blocks.findIndex((candidate, after) => after > index && object(candidate)?.type === "text" && object(candidate)?.text === anchor.end);
      if (end < 0 || stableJson(wireContent(blocks.slice(index + 1, end))) !== stableJson(anchor.visible)) throw new Error(REPLAY_ERROR);
      for (let blockIndex = index + 1; blockIndex < end; blockIndex++) {
        const block = object(blocks[blockIndex]);
        if (block?.type === "thinking" && typeof block.signature === "string" && block.signature) fields.push({ owner: block, field: "signature", path: ["messages", messageIndex, "content", blockIndex, "signature"] });
        if (block?.type === "redacted_thinking" && typeof block.data === "string" && block.data) fields.push({ owner: block, field: "data", path: ["messages", messageIndex, "content", blockIndex, "data"] });
      }
      index = end;
    }
  }
  return fields;
}

export interface NativeReplay {
  context: Context;
  restore: (payload: Record<string, unknown>) => Record<string, unknown>;
  active: boolean;
  release: () => void;
}

/** Unique transport-only markers survive Pi conversion and are consumed before provider dispatch. */
export function prepareNativeReplay(context: Context, model: Model<Api>): NativeReplay {
  if (model.api !== "anthropic-messages") return { context, restore: (payload) => payload, active: false, release: () => {} };
  const anchors = new Map<string, ReplayAnchor>();
  const markerPrefix = `kulo-native-replay:${randomUUID()}:`;
  const messages = context.messages.map((message) => {
    if (message.role !== "assistant" || message.provider !== model.provider || message.api !== model.api || message.model !== model.id) return message;
    const stored = (message as NativeContentMessage).kuloNativeContent;
    if (stored === undefined) return message;
    const envelope = nativeContentEnvelope(stored);
    if (!envelope || envelope.provider !== message.provider || envelope.api !== message.api || envelope.model !== message.model ||
      envelope.responseId !== message.responseId || envelope.contentHash !== nativeContentHash(message.content)) throw new Error(REPLAY_ERROR);
    const start = `${markerPrefix}${anchors.size}:start`;
    const end = `${markerPrefix}${anchors.size}:end`;
    anchors.set(start, { end, envelope, visible: structuredClone(visibleWireContent(message.content, model)) });
    return { ...message, content: [{ type: "text" as const, text: start }, ...structuredClone(message.content), { type: "text" as const, text: end }] };
  });
  if (!anchors.size) return { context, restore: (payload) => payload, active: false, release: () => {} };
  for (const [marker, anchor] of anchors) activeReplayAnchors.set(marker, anchor);
  return {
    context: { ...context, messages }, active: true,
    release: () => { for (const marker of anchors.keys()) activeReplayAnchors.delete(marker); },
    restore: (payload) => {
      if (!Array.isArray(payload.messages)) throw new Error(REPLAY_ERROR);
      const restored = payload.messages.map((value) => {
        const message = object(value);
        if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return value;
        const blocks = message.content;
        const content: unknown[] = [];
        for (let index = 0; index < blocks.length; index++) {
          const block = object(blocks[index]);
          const anchor = block?.type === "text" && typeof block.text === "string" ? anchors.get(block.text) : undefined;
          if (!anchor) { content.push(blocks[index]); continue; }
          const end = blocks.findIndex((candidate, after) => after > index && object(candidate)?.type === "text" && object(candidate)?.text === anchor.end);
          if (end < 0 || stableJson(wireContent(blocks.slice(index + 1, end))) !== stableJson(anchor.visible)) throw new Error(REPLAY_ERROR);
          content.push(...structuredClone(anchor.envelope.blocks));
          index = end;
        }
        return { ...message, content };
      });
      if (JSON.stringify(restored).includes(markerPrefix)) throw new Error(REPLAY_ERROR);
      return { ...payload, messages: restored };
    },
  };
}
