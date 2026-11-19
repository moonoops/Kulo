import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { resolveResponseContext } from "../packages/hub/src/response-context.js";
import { loadSearchEvidencePrefix, SearchEvidenceHistory } from "../packages/hub/src/search-history.js";

const entry = (id: number, kind: string, extra: Record<string, unknown> = {}): EntryRecord => ({ id, conversationId: 1, kind, ...extra }) as unknown as EntryRecord;
const input = (id: number, kind = "moco.user") => entry(id, kind, { data: { text: "Private input", attachments: [] } });
const assistant = (id: number, calls: Array<{ id: string; name: string }> = [], stopReason = calls.length ? "toolUse" : "stop") => entry(id, "pi.assistant", {
  model: [{ role: "assistant", stopReason, content: [{ type: "thinking", thinking: "Private thought" }, { type: "text", text: "Private answer" }, ...calls.map((call) => ({ type: "toolCall", ...call, arguments: { private: "Private argument" } }))] }],
});
const publication = (id: number, partId: string, source?: { conversationId: number; callId: string }) => entry(id, "moco.content_publication", {
  data: { parts: [{ partId, type: "file", assetId: "asset-html", caption: "现代精美独立 HTML 页面" }], fallbackText: "现代精美独立 HTML 页面", ...(source ? { source } : {}) },
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const legacyPartId = (callId: string) => `asset_${hash([1, `asset:${hash([1, callId])}`]).slice(0, 32)}`;

describe("response ownership", () => {
  it("assigns a dispatch tool result to the same reply and rejects results from before a new input", () => {
    const result = (id: number, toolCallId: string) => entry(id, "pi.tool-result", { model: [{ role: "toolResult", toolCallId, toolName: "moco_dispatch", content: [] }] });
    const ids = resolveResponseContext([input(1), assistant(2, [{ id: "dispatch", name: "moco_dispatch" }]), result(3, "dispatch"), result(4, "unknown"), assistant(5), input(6), result(7, "dispatch"), assistant(8)]).responseIds;
    expect(ids.get(3)).toBe(ids.get(5));
    expect(ids.get(3)).toBe(1);
    expect(ids.has(4)).toBe(false);
    expect(ids.has(7)).toBe(false);
    expect(ids.get(8)).toBe(6);
  });

  it("connects a legacy HTML publication and its final reply through the actual publishing tool call", () => {
    const ids = resolveResponseContext([input(1), assistant(2, [{ id: "publish-html", name: "moco_publish_asset" }]), publication(3, legacyPartId("publish-html")), assistant(5)]);
    expect([...ids.responseIds]).toEqual([[2, 1], [3, 1], [5, 1]]);
    expect(ids.currentResponseId).toBeUndefined();
  });

  it("accepts explicit same-conversation provenance only for an observed tool call", () => {
    const ids = resolveResponseContext([input(1), assistant(2, [{ id: "card", name: "moco_ui_show" }]),
      publication(3, "card:ui", { conversationId: 1, callId: "card" }),
      publication(4, "unmatched", { conversationId: 1, callId: "missing" }),
      publication(5, "foreign", { conversationId: 9, callId: "card" }), assistant(6)]).responseIds;
    expect(ids.get(3)).toBe(1);
    expect(ids.has(4)).toBe(false);
    expect(ids.has(5)).toBe(false);
  });

  it("leaves standalone publications independent even between a tool call and its answer", () => {
    const ids = resolveResponseContext([input(1), assistant(2, [{ id: "publish", name: "moco_publish_asset" }]),
      publication(3, "media-notice:done"), publication(4, legacyPartId("unrelated")), assistant(5)]).responseIds;
    expect(ids.has(3)).toBe(false);
    expect(ids.has(4)).toBe(false);
    expect(ids.get(5)).toBe(1);
  });

  it.each(["moco.user", "pi.user", "moco.worker_relay", "moco.worker_watchdog", "moco.voice.delegation"])("starts a new response at a placed %s input and forgets earlier calls", (kind) => {
    const ids = resolveResponseContext([input(1), assistant(2, [{ id: "publish", name: "moco_publish_asset" }]), input(3, kind),
      publication(4, legacyPartId("publish")), assistant(5)]).responseIds;
    expect(ids.has(4)).toBe(false);
    expect(ids.get(2)).toBe(1);
    expect(ids.get(5)).toBe(3);
  });

  it("does not give hidden recovery turns ownership", () => {
    const ids = resolveResponseContext([input(1), input(2, "moco.worker_recovery"), assistant(3), input(4), assistant(5)]).responseIds;
    expect(ids.has(3)).toBe(false);
    expect(ids.get(5)).toBe(4);
  });

  it.each(["stop", "length", "error", "aborted"])("starts an unprompted continuation after a terminal %s response with a fresh assistant anchor", (reason) => {
    const ids = resolveResponseContext([input(1), assistant(2, [], reason), assistant(3, [{ id: "publish", name: "moco_publish_asset" }]), publication(4, legacyPartId("publish")), assistant(5)]).responseIds;
    expect([...ids]).toEqual([[2, 1], [3, 3], [4, 3], [5, 3]]);
  });

  it("uses the same current ownership for pending streaming text", () => {
    expect(resolveResponseContext([input(1), assistant(2, [{ id: "publish", name: "moco_publish_asset" }]), publication(3, legacyPartId("publish"))]).currentResponseId).toBe(1);
    expect(resolveResponseContext([input(1), assistant(2, [{ id: "publish", name: "moco_publish_asset" }]), input(4)]).currentResponseId).toBe(4);
  });
});

describe("response context across history windows", () => {
  it("keeps tool identity and the input anchor after a live window trims them without retaining private content", () => {
    const history = new SearchEvidenceHistory();
    history.projectionEntries([input(1), assistant(2, [{ id: "publish", name: "moco_publish_asset" }])]);
    const window = [publication(3, legacyPartId("publish")), assistant(4)];
    const projection = history.projectionEntries(window);
    expect(JSON.stringify(projection.slice(0, 2))).not.toMatch(/Private (?:input|answer|thought|argument)/);
    expect(resolveResponseContext(projection).responseIds.get(3)).toBe(1);
    expect(history.project(window, (entries) => entries.map((value) => ({ id: Number(value.id), role: "assistant", text: "" })))).toHaveLength(2);
  });

  it("retains the first assistant anchor for a continuation with no placed input", () => {
    const history = new SearchEvidenceHistory();
    history.projectionEntries([assistant(2, [{ id: "publish", name: "moco_publish_asset" }])]);
    expect(resolveResponseContext(history.projectionEntries([publication(3, legacyPartId("publish"))])).responseIds.get(3)).toBe(2);
  });

  it("keeps the new continuation anchor after both the old final answer and new tool call leave the visible window", () => {
    const history = new SearchEvidenceHistory();
    history.projectionEntries([input(1), assistant(2), assistant(3, [{ id: "publish", name: "moco_publish_asset" }])]);
    expect(resolveResponseContext(history.projectionEntries([publication(4, legacyPartId("publish")), assistant(5)])).responseIds.get(5)).toBe(3);
  });

  it.each(["moco.worker_watchdog", "moco.voice.delegation", "moco.worker_recovery"])("remembers a trimmed %s boundary", (kind) => {
    const history = new SearchEvidenceHistory();
    history.projectionEntries([input(1), input(2, kind)]);
    const projected = resolveResponseContext(history.projectionEntries([assistant(3)]));
    if (kind === "moco.worker_recovery") expect(projected.responseIds.has(3)).toBe(false);
    else expect(projected.responseIds.get(3)).toBe(2);
  });

  it("restores relay response ownership while keeping the surrounding user turn available for citation evidence", async () => {
    const entries = vi.fn().mockResolvedValue({ items: [assistant(12, [{ id: "publish", name: "moco_publish_asset" }]), input(10, "moco.worker_relay"), input(1)], next: "older" });
    const prefix = await loadSearchEvidencePrefix({ entries } as unknown as Pick<Conversation, "entries">, publication(13, legacyPartId("publish")), BACKGROUND_CONTEXT);
    expect(prefix.map((value) => Number(value.id))).toEqual([1, 10, 12]);
    const restored = new SearchEvidenceHistory(); restored.remember(prefix);
    expect(resolveResponseContext(restored.projectionEntries([publication(13, legacyPartId("publish")), assistant(14)])).responseIds.get(14)).toBe(10);
    expect(entries).toHaveBeenCalledTimes(1);
  });
});
