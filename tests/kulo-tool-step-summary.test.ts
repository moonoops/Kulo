import { describe, expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { redactSensitiveText } from "@kulo/protocol";
import {
  buildLiveToolActionMeta,
  classifyToolAction,
  extractDisplayMessages,
  extractLiveState,
  extractSafeHostname,
  finalizeToolActionMeta,
} from "../packages/hub/src/index.js";

const entry = (id: number, kind: string, model: unknown) =>
  ({ id, kind, conversationId: 1, model: [model] }) as unknown as EntryRecord;

const toolCallEntry = (
  id: number,
  calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>,
) =>
  entry(id, "pi.assistant", {
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? {},
    })),
    timestamp: 1_000 + id,
  });

const toolResultEntry = (
  id: number,
  callId: string,
  name: string,
  text: string,
  options: { isError?: boolean; details?: unknown } = {},
) =>
  entry(id, "pi.tool-result", {
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text }],
    isError: Boolean(options.isError),
    ...(options.details !== undefined ? { details: options.details } : {}),
    timestamp: 1_000 + id,
  });

describe("tool-step-summary classification and safety", () => {
  it("splits kulo_lark_bridge strictly by sub-action (only list_chats/read_chat/search_messages are read)", () => {
    for (const action of ["list_chats", "read_chat", "search_messages"] as const) {
      const meta = classifyToolAction({
        name: "kulo_lark_bridge",
        args: { action, profile: "enterprise" },
      });
      expect(meta).toEqual({
        category: "read",
        labelKey: `lark_${action}`,
        targetLabel: "enterprise",
        status: "running",
      });
    }

    expect(
      classifyToolAction({
        name: "kulo_lark_bridge",
        args: { action: "propose_reply", chat_id: "oc_123", text: "sensitive reply body" },
      }),
    ).toEqual({
      category: "confirm",
      labelKey: "lark_propose_reply",
      status: "running",
    });

    for (const action of ["configure", "sync_now", "status", "send_message", "unknown_op"]) {
      const meta = classifyToolAction({
        name: "kulo_lark_bridge",
        args: { action },
      });
      expect(meta.category).toBe("write");
    }
  });

  it("splits kulo_browser strictly by read-only observation vs interactive write actions", () => {
    for (const action of ["snapshot", "screenshot", "get-url", "get_url", "get-text", "get_text", "read", "status"]) {
      const meta = classifyToolAction({
        name: "kulo_browser",
        args: { action },
      });
      expect(meta.category, `kulo_browser(${action})`).toBe("read");
      expect(meta.labelKey).toBe("browser_observe");
    }

    for (const action of ["click", "fill", "type", "press", "navigate", "open", "scroll", "back", "forward", "close"]) {
      const meta = classifyToolAction({
        name: "kulo_browser",
        args: { action, url: "https://docs.example.com/login?token=secret-value" },
      });
      expect(meta.category, `kulo_browser(${action})`).toBe("write");
      expect(meta.labelKey).toBe("browser_interact");
      expect(meta.targetLabel).toBe("docs.example.com");
    }

    expect(
      classifyToolAction({
        name: "kulo_browser",
        args: { action: "batch", steps: [{ action: "get-url" }, { action: "snapshot" }] },
      }).category,
    ).toBe("read");

    expect(
      classifyToolAction({
        name: "kulo_browser",
        args: { action: "batch", steps: [{ action: "fill", ref: "@e1", text: "abc" }, { action: "click", ref: "@e2" }] },
      }).category,
    ).toBe("write");
  });

  it("never classifies bash, write, edit, kulo_host_action, or unknown tools as read-only", () => {
    expect(classifyToolAction({ name: "bash", args: { command: "ls -la" } }).category).toBe("write");
    expect(classifyToolAction({ name: "write", args: { path: "/repo/a.ts", content: "x" } })).toMatchObject({
      category: "write",
      labelKey: "write",
      targetLabel: "a.ts",
    });
    expect(classifyToolAction({ name: "edit", args: { file_path: "/repo/b.ts" } })).toMatchObject({
      category: "write",
      labelKey: "edit",
      targetLabel: "b.ts",
    });
    expect(classifyToolAction({ name: "kulo_host_action", args: { action: "run", summary: "Restart service" } })).toMatchObject({
      category: "write",
      labelKey: "kulo_host_action",
      targetLabel: "Restart service",
    });
    // Even read-only host inspection must NEVER be classified as foldable "read".
    expect(classifyToolAction({ name: "kulo_host_action", args: { action: "inspect", scope: "ports" } }).category).toBe("other");
    // Unrecognized tools fail closed.
    expect(classifyToolAction({ name: "mcp_custom_unknown", args: { query: "abc" } }).category).toBe("other");
  });

  it("classifies standard read-only lookup tools as read and keeps memory queries private", () => {
    for (const [name, args] of [
      ["read", { path: "/Users/me/project/README.md" }],
      ["web_search", { query: "Antigravity changelog" }],
      ["web_fetch", { url: "https://user:pass@docs.github.com/en/rest?api_key=abc#top" }],
      ["kulo_history_search", { query: "deployment plan" }],
      ["kulo_history_read", { entry_id: 42 }],
      ["kulo_memory_recall", { query: "top-secret-memory-query" }],
      ["hindsight_recall", { query: "private-note" }],
    ] as const) {
      const meta = classifyToolAction({ name, args });
      expect(meta.category, name).toBe("read");
    }

    expect(classifyToolAction({ name: "read", args: { path: "/Users/me/project/README.md" } }).targetLabel).toBe("README.md");
    expect(classifyToolAction({ name: "web_fetch", args: { url: "https://user:pass@docs.github.com/en/rest?api_key=abc#top" } }).targetLabel).toBe("docs.github.com");
    expect(classifyToolAction({ name: "kulo_memory_recall", args: { query: "top-secret-memory-query" } }).targetLabel).toBeUndefined();
    expect(classifyToolAction({ name: "hindsight_recall", args: { query: "private-note" } }).targetLabel).toBeUndefined();
  });

  it("degrades safely during live streaming when live.tools omits arguments", () => {
    const larkLive = buildLiveToolActionMeta("kulo_lark_bridge");
    expect(larkLive).toEqual({ category: "other", labelKey: "kulo_lark_bridge", status: "running" });
    expect(larkLive.targetLabel).toBeUndefined();

    const browserLive = buildLiveToolActionMeta("kulo_browser");
    expect(browserLive).toEqual({ category: "other", labelKey: "kulo_browser", status: "running" });

    const bashLive = buildLiveToolActionMeta("bash");
    expect(bashLive).toEqual({ category: "write", labelKey: "bash", status: "running" });

    const fetchLive = buildLiveToolActionMeta("web_fetch");
    expect(fetchLive).toEqual({ category: "read", labelKey: "web_fetch", status: "running" });

    const liveState = extractLiveState({
      conversation: { id: 1 },
      entries: [],
      docs: {
        "pi.live": {
          run: { id: 1 },
          tools: [
            { callId: "live-1", name: "kulo_lark_bridge", status: "running" },
            { callId: "live-2", name: "kulo_browser", status: "pending" },
          ],
        },
        "pi.inbox": { items: [] },
      },
    } as unknown as ConversationView);

    expect(liveState.activeTools).toEqual([
      {
        callId: "live-1",
        name: "kulo_lark_bridge",
        actionMeta: { category: "other", labelKey: "kulo_lark_bridge", status: "running" },
      },
      {
        callId: "live-2",
        name: "kulo_browser",
        actionMeta: { category: "other", labelKey: "kulo_browser", status: "running" },
      },
    ]);
  });

  it("redacts secrets and truncates targetLabel and errorBrief before any slice boundary", () => {
    const sentinel = "synthetic-p23-vault-secret-9876543210";
    const redact = (text: string) => redactSensitiveText(text, [sentinel]);

    expect(extractSafeHostname("javascript:alert(1)")).toBeUndefined();
    expect(extractSafeHostname("https://alice:hunter2@api.example.org:8443/v1/keys?token=sk-1234567890abcdef1234567890")).toBe(
      "api.example.org",
    );

    const searchMeta = classifyToolAction({
      name: "web_search",
      args: { query: `${"q".repeat(50)} ${sentinel} tail` },
      redactText: redact,
    });
    expect(searchMeta.targetLabel).toBeDefined();
    expect(searchMeta.targetLabel!.length).toBeLessThanOrEqual(60);
    expect(searchMeta.targetLabel).not.toContain(sentinel);
    expect(searchMeta.targetLabel).not.toContain("synthetic-p23");

    const connMeta = classifyToolAction({
      name: "kulo_connection_use",
      args: { connection_id: "conn-gh", operation: "http", method: "GET", path: "/repos" },
      redactText: redact,
      resolveConnectionLabel: (id) => (id === "conn-gh" ? "GitHub Workspace" : undefined),
    });
    expect(connMeta).toEqual({
      category: "read",
      labelKey: "connection_read",
      targetLabel: "GitHub Workspace",
      status: "running",
    });

    const connWriteMeta = classifyToolAction({
      name: "kulo_connection_use",
      args: { connection_id: "conn-gh", operation: "http", method: "POST", path: "/issues", body: sentinel },
      redactText: redact,
      resolveConnectionLabel: () => "GitHub Workspace",
    });
    expect(connWriteMeta.category).toBe("write");
    expect(JSON.stringify(connWriteMeta)).not.toContain(sentinel);

    const failed = finalizeToolActionMeta(
      classifyToolAction({ name: "bash", args: { command: "deploy" }, redactText: redact }),
      {
        name: "bash",
        isError: true,
        content: [{ type: "text", text: `Error: auth failed with ${"a".repeat(80)}${sentinel}\nsecond line trace` }],
        redactText: redact,
      },
    );
    expect(failed.status).toBe("error");
    expect(failed.errorBrief).toBeDefined();
    expect(failed.errorBrief!.length).toBeLessThanOrEqual(96);
    expect(failed.errorBrief).not.toContain(sentinel);
    expect(failed.errorBrief).not.toContain("second line trace");

    const memFailed = finalizeToolActionMeta(
      classifyToolAction({ name: "kulo_memory_recall", args: { query: "secret" }, redactText: redact }),
      {
        name: "kulo_memory_recall",
        isError: true,
        content: [{ type: "text", text: "TOP SECRET MEMORY FAILURE" }],
        redactText: redact,
      },
    );
    expect(memFailed.status).toBe("error");
    expect(memFailed.errorBrief).toBeUndefined();
  });

  it("preserves 1:1 ChatDisplayItem.id and callId, handles out-of-order results, detects awaiting_confirm, and keeps raw output out of ordinary chat", () => {
    const entries = [
      toolCallEntry(10, [
        { id: "c1", name: "web_search", arguments: { query: "Kulo architecture" } },
        { id: "c2", name: "kulo_lark_bridge", arguments: { action: "read_chat", profile: "work", chat_id: "oc_1" } },
      ]),
      toolCallEntry(11, [
        { id: "c3", name: "kulo_lark_bridge", arguments: { action: "propose_reply", chat_id: "oc_1", text: "ok" } },
      ]),
      toolCallEntry(12, [{ id: "c4", name: "bash", arguments: { command: "pnpm test" } }]),
      // Out-of-order results: c2 finishes before c1; c3 awaits confirmation; c4 stays pending.
      toolResultEntry(13, "c2", "kulo_lark_bridge", "RAW LARK MESSAGE TRANSCRIPT SECRET"),
      toolResultEntry(14, "c3", "kulo_lark_bridge", JSON.stringify({ proposed: true, card: { id: "card-1" } })),
      toolResultEntry(15, "c1", "web_search", "RAW SEARCH OUTPUT BODY"),
    ];

    const ordinary = extractDisplayMessages(entries);
    // Backend must NEVER merge separate AssistantEntry items.
    expect(ordinary.map((item) => item.id)).toEqual([10, 11, 12]);
    expect(ordinary[0]?.toolCalls?.map((tc) => tc.id)).toEqual(["c1", "c2"]);
    expect(ordinary[0]?.toolCalls?.[0]?.actionMeta).toEqual({
      category: "read",
      labelKey: "web_search",
      targetLabel: "Kulo architecture",
      status: "ok",
    });
    expect(ordinary[0]?.toolCalls?.[1]?.actionMeta).toEqual({
      category: "read",
      labelKey: "lark_read_chat",
      targetLabel: "work",
      status: "ok",
    });
    expect(ordinary[1]?.toolCalls?.[0]?.actionMeta).toEqual({
      category: "confirm",
      labelKey: "lark_propose_reply",
      status: "awaiting_confirm",
    });
    expect(ordinary[2]?.toolCalls?.[0]?.actionMeta).toEqual({
      category: "write",
      labelKey: "bash",
      status: "running",
    });
    // Ordinary chat never receives raw tool output.
    expect(ordinary.every((item) => item.toolCalls?.every((tc) => tc.result === undefined))).toBe(true);
    expect(JSON.stringify(ordinary)).not.toContain("RAW LARK MESSAGE TRANSCRIPT SECRET");
    expect(JSON.stringify(ordinary)).not.toContain("RAW SEARCH OUTPUT BODY");
  });
});
