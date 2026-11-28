import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  SIDE_QUESTION_QUESTION_MAX_CHARS,
  SIDE_QUESTION_QUOTE_MAX_CHARS,
  SIDE_QUESTION_TITLE_MAX_CHARS,
  type SideQuestionCreateRequest,
  type SideQuestionMessageRequest,
} from "@kulo/protocol";
import { SideQuestionError } from "../side-questions.js";
import { assertHttpSameOrigin, type HubHttpRouteContext } from "./context.js";

function parseOptionalBoundedString(
  raw: unknown,
  field: string,
  maxLength: number,
  allowNewlines = true,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new SideQuestionError(400, "invalid_side_question_request", `参数 ${field} 必须为字符串。`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const controlPattern = allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (trimmed.length > maxLength || controlPattern.test(trimmed)) {
    throw new SideQuestionError(400, "invalid_side_question_request", `参数 ${field} 格式无效或超出长度限制。`);
  }
  return trimmed;
}

function parseOptionalPositiveInt(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw new SideQuestionError(400, "invalid_side_question_request", `参数 ${field} 必须为正整数。`);
  }
  return raw;
}

/**
 * Handles Stage 3 P1-1 Phase 1 side-question endpoints:
 * - `POST /api/topics/:topicId/side-questions`
 * - `GET  /api/topics/:topicId/side-questions/active`
 * - `GET  /api/side-questions/:id`
 * - `POST /api/side-questions/:id/messages`
 * - `DELETE /api/side-questions/:id`
 */
export async function handleSideQuestionRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, pathname, readJsonObject, sendJson } = ctx;

  const topicCreateMatch = /^\/api\/topics\/([^/]+)\/side-questions$/.exec(pathname);
  if (topicCreateMatch) {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "仅支持 POST 请求。", code: "side_question_method_not_allowed" });
      return true;
    }
    assertHttpSameOrigin(ctx, {
      code: "side_question_origin_required",
      message: "请在 Kulo 中发起支线提问。",
    });
    const topicId = decodeURIComponent(topicCreateMatch[1]!);
    const body = await readJsonObject(req, 64 * 1024);
    const question = parseOptionalBoundedString(body.question, "question", SIDE_QUESTION_QUESTION_MAX_CHARS, true);
    const quoteSnippet = parseOptionalBoundedString(body.quoteSnippet, "quoteSnippet", SIDE_QUESTION_QUOTE_MAX_CHARS * 4, true);
    const title = parseOptionalBoundedString(body.title, "title", SIDE_QUESTION_TITLE_MAX_CHARS * 2, false);
    const sourceMessageId = parseOptionalPositiveInt(body.sourceMessageId, "sourceMessageId");
    const expectedParentConversationId = parseOptionalPositiveInt(
      body.expectedParentConversationId,
      "expectedParentConversationId",
    );
    const requestId = parseOptionalBoundedString(body.requestId, "requestId", 256, false);

    const request: SideQuestionCreateRequest = {
      ...(question !== undefined ? { question } : {}),
      ...(quoteSnippet !== undefined ? { quoteSnippet } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
      ...(expectedParentConversationId !== undefined ? { expectedParentConversationId } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    };
    const sideQuestion = await hub.sideQuestions.createSideQuestion(topicId, request, BACKGROUND_CONTEXT);
    sendJson(res, 200, { sideQuestion });
    return true;
  }

  const topicActiveMatch = /^\/api\/topics\/([^/]+)\/side-questions\/active$/.exec(pathname);
  if (topicActiveMatch) {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "仅支持 GET 请求。", code: "side_question_method_not_allowed" });
      return true;
    }
    const topicId = decodeURIComponent(topicActiveMatch[1]!);
    const sideQuestion = await hub.sideQuestions.getActiveSideQuestion(topicId, BACKGROUND_CONTEXT);
    sendJson(res, 200, { sideQuestion });
    return true;
  }

  const messageMatch = /^\/api\/side-questions\/([^/]+)\/messages$/.exec(pathname);
  if (messageMatch) {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "仅支持 POST 请求。", code: "side_question_method_not_allowed" });
      return true;
    }
    assertHttpSameOrigin(ctx, {
      code: "side_question_origin_required",
      message: "请在 Kulo 中发送支线消息。",
    });
    const id = decodeURIComponent(messageMatch[1]!);
    const body = await readJsonObject(req, 64 * 1024);
    const rawQuestion = body.question !== undefined ? body.question : body.content;
    const question = parseOptionalBoundedString(rawQuestion, "question", SIDE_QUESTION_QUESTION_MAX_CHARS, true);
    if (!question) {
      throw new SideQuestionError(400, "empty_question", "请输入支线提问内容。");
    }
    const requestId = parseOptionalBoundedString(body.requestId, "requestId", 256, false);
    const request: SideQuestionMessageRequest = {
      question,
      ...(requestId !== undefined ? { requestId } : {}),
    };
    const sideQuestion = await hub.sideQuestions.sendMessage(id, request, BACKGROUND_CONTEXT);
    sendJson(res, 200, { sideQuestion });
    return true;
  }

  const singleMatch = /^\/api\/side-questions\/([^/]+)$/.exec(pathname);
  if (singleMatch) {
    res.setHeader("cache-control", "no-store");
    const id = decodeURIComponent(singleMatch[1]!);
    if (req.method === "GET") {
      const sideQuestion = await hub.sideQuestions.getSideQuestion(id, BACKGROUND_CONTEXT);
      sendJson(res, 200, { sideQuestion });
      return true;
    }
    if (req.method === "DELETE") {
      assertHttpSameOrigin(ctx, {
        code: "side_question_origin_required",
        message: "请在 Kulo 中关闭支线提问。",
      });
      const result = await hub.sideQuestions.closeSideQuestion(id, BACKGROUND_CONTEXT);
      sendJson(res, 200, result);
      return true;
    }
    sendJson(res, 405, { error: "不支持该请求方法。", code: "side_question_method_not_allowed" });
    return true;
  }

  return false;
}
