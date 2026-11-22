import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { decodeConversationTopicId } from "../conversation-query.js";
import { ProjectError } from "../projects.js";
import type { HubHttpRouteContext } from "./context.js";

/**
 * Handles conversation query/history, `/api/topics*`, `/api/usage`,
 * `/api/scheduled-tasks*`, and `/api/tickets*` business REST routes.
 */
export async function handleWorkspaceRoutes(ctx: HubHttpRouteContext): Promise<boolean> {
  const { hub, req, res, parsedUrl, pathname, readJsonBody, readJsonObject, sendJson, conversationQueryContext } = ctx;

  if (pathname === "/api/conversations/search" && req.method === "GET") {
    res.setHeader("cache-control", "no-store");
    sendJson(
      res,
      200,
      await conversationQueryContext(req, res, (context) =>
        hub.searchConversations(
          {
            query: parsedUrl.searchParams.get("q") ?? "",
            ...(parsedUrl.searchParams.has("topicId") ? { topicId: parsedUrl.searchParams.get("topicId")! } : {}),
            ...(parsedUrl.searchParams.has("cursor") ? { cursor: parsedUrl.searchParams.get("cursor")! } : {}),
            ...(parsedUrl.searchParams.has("limit") ? { limit: Number(parsedUrl.searchParams.get("limit")) } : {}),
          },
          context,
        ),
      ),
    );
    return true;
  }
  const messageWindowRoute = /^\/api\/topics\/([^/]+)\/messages\/([^/]+)$/.exec(pathname);
  if (messageWindowRoute && req.method === "GET") {
    res.setHeader("cache-control", "no-store");
    const topicId = decodeConversationTopicId(messageWindowRoute[1]!);
    sendJson(
      res,
      200,
      await conversationQueryContext(req, res, (context) =>
        hub.getTopicMessageWindow(topicId, Number(messageWindowRoute[2]), context),
      ),
    );
    return true;
  }
  const conversationFilesRoute = /^\/api\/topics\/([^/]+)\/files$/.exec(pathname);
  if (conversationFilesRoute && req.method === "GET") {
    res.setHeader("cache-control", "no-store");
    const topicId = decodeConversationTopicId(conversationFilesRoute[1]!);
    sendJson(
      res,
      200,
      await conversationQueryContext(req, res, (context) =>
        hub.listTopicFiles(
          topicId,
          {
            ...(parsedUrl.searchParams.has("cursor") ? { cursor: parsedUrl.searchParams.get("cursor")! } : {}),
            ...(parsedUrl.searchParams.has("limit") ? { limit: Number(parsedUrl.searchParams.get("limit")) } : {}),
          },
          context,
        ),
      ),
    );
    return true;
  }
  const historyRoute = /^\/api\/topics\/([^/]+)\/messages$/.exec(pathname);
  if (historyRoute && req.method === "GET") {
    sendJson(
      res,
      200,
      await hub.getTopicHistory(decodeURIComponent(historyRoute[1]!), Number(parsedUrl.searchParams.get("before"))),
    );
    return true;
  }

  // Topics API
  if (req.method === "GET" && pathname === "/api/topics") {
    sendJson(res, 200, { items: await hub.listTopics() });
    return true;
  }
  if (req.method === "POST" && pathname === "/api/topics") {
    const body = (await readJsonObject(req)) as { title?: string; projectId?: string | null };
    if (body.title !== undefined && typeof body.title !== "string") {
      throw new ProjectError(400, "invalid_topic", "会话名称无效。");
    }
    if (body.projectId !== undefined && body.projectId !== null && typeof body.projectId !== "string") {
      throw new ProjectError(400, "invalid_project", "项目无效。");
    }
    const topic = await hub.createTopic(body.title, undefined, body.projectId);
    sendJson(res, 200, topic);
    return true;
  }
  if (req.method === "POST" && pathname.startsWith("/api/topics/") && pathname.endsWith("/retry")) {
    const topicId = decodeURIComponent(pathname.slice("/api/topics/".length, -"/retry".length));
    const out = await hub.retryTurn(topicId, `retry:${Date.now()}`);
    sendJson(res, 200, out);
    return true;
  }
  if (req.method === "POST" && pathname.startsWith("/api/topics/") && pathname.endsWith("/compact")) {
    const topicId = decodeURIComponent(pathname.slice("/api/topics/".length, -"/compact".length));
    const out = await hub.compactTopic(topicId);
    sendJson(res, out.compacted ? 202 : 200, out);
    return true;
  }
  if (req.method === "PATCH" && pathname.startsWith("/api/topics/")) {
    const id = decodeURIComponent(pathname.slice("/api/topics/".length));
    const body = (await readJsonBody(req)) as {
      title?: string;
      pinned?: boolean;
      archived?: boolean;
    };
    const updated = await hub.patchTopic(id, body);
    sendJson(res, 200, updated);
    return true;
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/topics/")) {
    const id = decodeURIComponent(pathname.slice("/api/topics/".length));
    const body = (await readJsonObject(req)) as { stopTasks?: boolean };
    if (body.stopTasks !== undefined && typeof body.stopTasks !== "boolean") {
      throw new ProjectError(400, "invalid_project", "删除参数无效。");
    }
    const result = await hub.deleteTopic(id, undefined, { stopTasks: body.stopTasks });
    sendJson(res, 200, result);
    return true;
  }

  // Usage Stats API
  if (req.method === "GET" && pathname === "/api/usage") {
    const rawRange = parsedUrl.searchParams.get("range");
    const range = rawRange === "7" || rawRange === "30" ? rawRange : "today";
    sendJson(res, 200, await hub.computeUsageStats(range));
    return true;
  }

  if (req.method === "GET" && pathname === "/api/scheduled-tasks") {
    sendJson(res, 200, { tasks: await hub.listScheduledTasks() });
    return true;
  }
  const scheduleRoute = /^\/api\/scheduled-tasks\/([^/]+)(\/stop)?$/.exec(pathname);
  if (scheduleRoute) {
    const id = decodeURIComponent(scheduleRoute[1]!);
    if (req.method === "POST" && scheduleRoute[2]) {
      sendJson(res, 200, { task: await hub.stopScheduledTask(id) });
      return true;
    }
    if (req.method === "DELETE" && !scheduleRoute[2]) {
      await hub.deleteScheduledTask(id);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  const deliverableRoute = /^\/api\/tickets\/([^/]+)\/deliverables(?:\/([^/]+))?$/.exec(pathname);
  if (req.method === "GET" && deliverableRoute) {
    const ticketId = decodeURIComponent(deliverableRoute[1]!);
    res.setHeader("cache-control", "no-store");
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    try {
      if (!deliverableRoute[2]) {
        sendJson(res, 200, await hub.listTicketDeliverables(ticketId, context));
      } else {
        const { file, bytes } = await hub.readTicketDeliverable(
          ticketId,
          decodeURIComponent(deliverableRoute[2]),
          context,
        );
        res.writeHead(200, {
          "content-type": file.mimeType,
          "content-length": bytes.byteLength,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        });
        res.end(bytes);
      }
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
    return true;
  }

  // Ticket Computer Handoff Settlement API
  if (req.method === "POST" && pathname.startsWith("/api/tickets/") && pathname.endsWith("/computer-handoff")) {
    const ticketId = decodeURIComponent(pathname.slice("/api/tickets/".length, -"/computer-handoff".length));
    const body = await readJsonObject(req);
    const action = body.action === "done" || body.action === "cancel" ? body.action : undefined;
    if (!action) {
      sendJson(res, 400, { error: "无效的人工接管操作。" });
      return true;
    }
    const manual = typeof body.note === "string" ? body.note.slice(0, 1000) : undefined;
    sendJson(res, 200, await hub.resolveComputerHandoff(ticketId, action, manual));
    return true;
  }

  // Ticket Retry API
  if (req.method === "POST" && pathname.startsWith("/api/tickets/") && pathname.endsWith("/retry")) {
    const ticketId = decodeURIComponent(pathname.slice("/api/tickets/".length, -"/retry".length));
    const card = await hub.retryTicket(ticketId);
    sendJson(res, 200, { ticket: card });
    return true;
  }

  return false;
}
