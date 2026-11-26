import { Readable } from "node:stream";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import {
  diagramDisplayName,
  validateAndNormalizeDiagramSvg,
  wrapInlineDiagramDocument,
  type ChatAttachment,
  type DiagramMotionMode,
} from "@kulo/protocol";
import { ChatAttachmentGrantsDoc } from "./chat-attachment-deliveries.js";
import { KuloStateDoc, isOrchestratorConversation, type KuloDurableState } from "./state.js";
import { UiCardError, type KuloUiCards, type UiCardSource, type UiDiagramPublicationInput } from "./ui-cards.js";
import type { KuloUploadStore } from "./uploads.js";

export interface DiagramPublisherOptions {
  cards: () => KuloUiCards;
  uploads: KuloUploadStore;
  redact: (text: string) => string;
}

export interface PublishedDiagramResult {
  status: "published";
  assetId: string;
  title: string;
  width: number;
  height: number;
  motion: DiagramMotionMode;
  autoFixed?: string[];
  warnings?: string[];
}

function assertMainChatTopic(state: KuloDurableState | undefined, conversationId: number, api: ToolExecutionApi): string {
  if (!isOrchestratorConversation(api.conversationId, state)) {
    throw new UiCardError("content_scope_denied", "内联图示工具仅可在主对话中使用。", 403);
  }
  const topicId = state?.conversationToTopic?.[String(conversationId)] ?? "root";
  const topic = state?.topics?.[topicId];
  if (!topic || topic.deletedAt !== undefined || Number(topic.conversationId) !== conversationId) {
    throw new UiCardError("content_scope_denied", "当前对话已删除或不可用。", 403);
  }
  return topicId;
}

export function createDiagramPublisher(options: DiagramPublisherOptions) {
  return async (
    raw: UiDiagramPublicationInput,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<PublishedDiagramResult> => {
    const conversationId = Number(api.conversationId);
    const initialState = await api.snapshot(KuloStateDoc, context);
    const topicId = assertMainChatTopic(initialState, conversationId, api);

    const title = options.redact(typeof raw.title === "string" ? raw.title : "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
    const fallbackText = options.redact(typeof raw.fallbackText === "string" ? raw.fallbackText : "").trim();
    const caption = raw.caption !== undefined ? options.redact(String(raw.caption)).trim() : undefined;
    const rawSvg = options.redact(typeof raw.svg === "string" ? raw.svg : "");
    const motion: DiagramMotionMode = raw.motion ?? "none";

    if (!title || Array.from(title).length > 120) {
      throw new UiCardError("invalid_diagram_input", "图示标题长度需为 1–120 字符。", 400);
    }
    if (!fallbackText || fallbackText.length > 4000) {
      throw new UiCardError("invalid_diagram_input", "fallback_text 必填且不超过 4000 字符。", 400);
    }
    if (caption && caption.length > 200) {
      throw new UiCardError("invalid_diagram_input", "图注 caption 不超过 200 字符。", 400);
    }
    if (!["none", "reveal", "step"].includes(motion)) {
      throw new UiCardError("invalid_diagram_input", "motion 仅支持 none、reveal 或 step。", 400);
    }

    const checked = validateAndNormalizeDiagramSvg(rawSvg, {
      title,
      description: caption || fallbackText,
      motion,
      allowGeometryWarnings: Boolean(raw.allowGeometryWarnings),
    });
    if (!checked.ok || !checked.svg || !checked.width || !checked.height) {
      const details = checked.errors.map((e) => `[${e.level}:${e.code}] ${e.message}`).join("\n");
      throw new UiCardError("invalid_diagram_svg", `图示校验未通过，请修正后重试：\n${details}`, 400);
    }

    const html = wrapInlineDiagramDocument({ title, svg: checked.svg, motion });
    const bytes = Buffer.from(html, "utf8");
    const source: UiCardSource = {
      conversationId,
      callId: `diagram:${api.callId}`,
      toolCallId: api.callId,
      topicId,
    };

    const asset: ChatAttachment = await options.cards().publishDiagram(
      { title, svg: checked.svg, fallbackText, ...(caption ? { caption } : {}), motion },
      source,
      async () => options.uploads.saveUploadStream({
        name: diagramDisplayName(title),
        mimeType: "text/html",
        stream: Readable.from([bytes]),
        ownerId: `agent:${conversationId}`,
        signal: context.abortSignal,
        idempotencyKey: `diagram:${conversationId}:${api.callId}`,
        presentation: "diagram",
        diagramMotion: motion,
        width: checked.width,
        height: checked.height,
      }),
      async (tx, saved) => {
        // Re-verify topic liveness inside the durable commit to prevent TOCTOU orphan writes.
        const currentState = await tx.doc(KuloStateDoc);
        assertMainChatTopic(currentState, conversationId, api);
        const scope = `conversation:${conversationId}`;
        const grants = await tx.doc(ChatAttachmentGrantsDoc);
        const existingScopes = grants.byAsset[saved.id] ?? [];
        if (!existingScopes.includes(scope)) {
          grants.byAsset[saved.id] = [...existingScopes, scope];
        }
        options.uploads.bindAttachments([saved], scope, `agent:${conversationId}`);
      },
    );

    const warnings = checked.warnings.map((w) => w.message);
    const svgLabelCount = (checked.svg.match(/<text\b/gi) ?? []).length;
    if (svgLabelCount >= 4 && fallbackText.length < 40 && !fallbackText.includes("\n")) {
      warnings.push(
        "fallback_text is very brief for a multi-label diagram; also include key labels, relationships, or values inline in your prose reply so plain-text readers are not left with a dangling diagram reference.",
      );
    }

    return {
      status: "published",
      assetId: asset.id,
      title,
      width: asset.width ?? checked.width,
      height: asset.height ?? checked.height,
      motion,
      ...(checked.autoFixed.length ? { autoFixed: checked.autoFixed } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  };
}
