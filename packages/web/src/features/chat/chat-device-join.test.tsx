import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDeviceChatInvitation, formatDeviceInstallerInstructions, type DeviceInterconnectionView } from "@kulo/protocol";
import { KuloComposer } from "../../kulo-composer";
import { KuloApiError } from "../../kulo-api";
import { deviceApi } from "../settings/device-api";
import { deviceJoinFeedback, previewChatDeviceJoin, requiresNewSwitchPreview, type ComposerDeviceJoin } from "./use-chat-device-join";
import { legacyInvitationCode, migrateOutboxInvitation } from "./device-invitation-outbox";
import { replyPreview } from "./reply-reference";
import { createMemoryOutboxStorage, ReliableOutbox, type ReliableOutboxRecord } from "./reliable-outbox";

const invitation = { hubUrl: "https://studio.example.test", hubId: "studio", hubName: "工作室", inviteToken: "test-only-invitation-for-the-chat-fixture" };
const input = formatDeviceChatInvitation(invitation);
const legacy = formatDeviceInstallerInstructions(invitation).agentInstructions;
const local: DeviceInterconnectionView = {
  role: "joined", hubId: "home", hubName: "家里的 Kulo", hubUrls: ["https://home.example.test"],
  currentDeviceId: "laptop", canSwitchRole: true, currentDeviceKnown: true, enabled: true, devices: [],
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function composer(phase: ComposerDeviceJoin["phase"]) {
  return renderToStaticMarkup(<KuloComposer draftText={legacy} onDraftTextChange={vi.fn()} attachments={[]} connected={false}
    canQueueMessages={false} busy onAbort={vi.fn()} onConfigure={vi.fn()} allowAttachments={false}
    onEnqueueFiles={vi.fn()} onRemoveAttachment={vi.fn()} onSubmit={vi.fn()}
    deviceJoin={{ preview: previewChatDeviceJoin(invitation, local).text, phase, submit: vi.fn(), confirmStop: vi.fn(), cancel: vi.fn(),
      message: phase === "conflict" ? "本机有未完成的任务。" : undefined }} />);
}

describe("a native invitation in the main composer", () => {
  it("shows both hosts before replacing a connection, including when the invitation claims the current hubId", () => {
    const preview = previewChatDeviceJoin({ ...invitation, hubId: local.hubId }, local);
    expect(preview).toMatchObject({ kind: "switch" });
    expect(preview.text).toContain("从 家里的 Kulo 切换到 工作室（studio.example.test）");
    expect(previewChatDeviceJoin(invitation, { ...local, role: "hub" }).kind).toBe("join");
    const same = previewChatDeviceJoin({ ...invitation, hubName: "不可信名称" }, { ...local, hubName: "已知工作室", hubUrls: [invitation.hubUrl] });
    expect(same.kind).toBe("same");
    expect(same.text).toContain("已连接到 已知工作室");
    expect(same.text).not.toContain("不可信名称");
    expect(previewChatDeviceJoin(invitation, { ...local, hubUrls: [invitation.hubUrl], hubError: "offline" })).toMatchObject({ kind: "reconnect" });
    expect(previewChatDeviceJoin(invitation, { ...local, role: "hub", hubUrls: [invitation.hubUrl] })).toMatchObject({ kind: "self" });
    expect(previewChatDeviceJoin(invitation, { ...local, role: "hub", currentDeviceKnown: false, hubUrls: [invitation.hubUrl] })).toMatchObject({ kind: "join" });
  });

  it("accepts an immediate first join but shows an unseen replacement before allowing it", () => {
    expect(requiresNewSwitchPreview(invitation, { ...local, role: "hub" })).toBe(false);
    expect(requiresNewSwitchPreview(invitation, local)).toBe(true);
    expect(requiresNewSwitchPreview(invitation, local, local)).toBe(false);
    expect(requiresNewSwitchPreview(invitation, local, { ...local, hubId: "changed-since-preview" })).toBe(true);
    expect(requiresNewSwitchPreview(invitation, { ...local, hubUrls: [invitation.hubUrl] })).toBe(false);
  });

  it("keeps a standalone legacy paste out of the rendered draft and enables joining without a model or queue", () => {
    const html = composer("preview");
    expect(html).toContain("工作室（studio.example.test）");
    expect(html).toContain('data-composer-action="join"');
    expect(html.match(/<button[^>]*aria-label="接入主 Kulo"[^>]*>/u)?.[0]).not.toContain("disabled");
    expect(html).not.toContain(invitation.inviteToken);
    expect(html).not.toContain("curl -fsSL");
    expect(html).not.toContain("连接模型");
    expect(html).not.toContain("停止任务并接入");
  });

  it("requires the separate stop-tasks action for a conflict and disables repeat submission", () => {
    const html = composer("conflict");
    expect(html).toContain("停止任务并接入");
    expect(html).toContain(">取消<");
    expect(html.match(/<button[^>]*aria-label="接入主 Kulo"[^>]*>/u)?.[0]).toContain("disabled");
    expect(composer("joining")).toContain('aria-label="正在接入"');
  });

  it("distinguishes expired invitations, unreachable hosts, unconfirmed receipts and other errors", () => {
    expect(deviceJoinFeedback(new KuloApiError(403, "expired", "device_invitation_invalid"))).toMatchObject({ phase: "blocked" });
    expect(deviceJoinFeedback(new KuloApiError(503, "offline", "device_host_unreachable"))).toMatchObject({ phase: "retry" });
    expect(deviceJoinFeedback(new KuloApiError(409, "unfinished", "local_tasks_running"))).toMatchObject({ phase: "conflict" });
    expect(deviceJoinFeedback(new KuloApiError(404, "receipt", "role_transition_unconfirmed"))).toMatchObject({ phase: "retry", unconfirmed: true });
    expect(deviceJoinFeedback(new KuloApiError(429, "配额已满"))).toMatchObject({ phase: "retry", message: "配额已满" });
    expect(deviceJoinFeedback(new Error("接入失败 " + invitation.inviteToken), invitation.inviteToken).message).not.toContain(invitation.inviteToken);
  });

  it("polls the same local transition after a lost acknowledgement without resubmitting the invitation", async () => {
    const id = "fixture-operation";
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("listener restarted"))
      .mockResolvedValueOnce(Response.json({ id, targetRole: "joined", status: "ready" }));
    vi.stubGlobal("fetch", fetch);
    await deviceApi.join(input, false, undefined, undefined, id);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/devices/join", `/api/devices/role-transition?id=${id}`]);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Kulo-Transition-Id": id });
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
  });
});

describe("device invitation privacy in the delivery queue", () => {
  it("redacts chat, task steering, reply snapshots and retry metadata before storing them", async () => {
    const storage = createMemoryOutboxStorage();
    const outbox = new ReliableOutbox({ scope: "old-hub", storage, transmit: async () => ({}), isTransient: () => false });
    try {
      const replyTo = { messageId: 1, role: "user" as const, text: "引用 " + invitation.inviteToken };
      await outbox.enqueue({ type: "chat.send", topicId: "root", content: "解释一下 " + input, replyTo }, { rawUserText: invitation.inviteToken });
      await outbox.enqueue({ type: "ticket.steer", ticketId: "work", text: invitation.inviteToken, replyTo: { ...replyTo, text: input } }, { rawUserText: legacy });
      const records = await storage.list("old-hub");
      expect(records).toHaveLength(2);
      expect(JSON.stringify(records)).not.toContain(invitation.inviteToken);
      expect(records[0]?.metadata?.rawUserText).toBe("[已隐藏]");
      expect(replyPreview({ ...replyTo, text: input })).not.toContain(invitation.inviteToken);
      expect(await storage.list("new-hub")).toEqual([]);
    } finally { outbox.dispose(); }
  });

  it("keeps an old standalone invitation out of automatic replay but preserves discussion and accepted receipts", () => {
    const record: ReliableOutboxRecord = { id: "old", scope: "old-hub", sequence: 5, createdAt: 1, state: "queued", attempt: 1, nextAttemptAt: 0,
      envelope: { type: "chat.send", requestId: "old", topicId: "root", content: legacy }, metadata: { rawUserText: legacy } };
    const migrated = migrateOutboxInvitation(record);
    expect(migrated).toMatchObject({ state: "failed", id: "old", sequence: 5, errorCode: legacyInvitationCode });
    expect(JSON.stringify(migrated)).not.toContain(invitation.inviteToken);
    expect(migrateOutboxInvitation(migrated)).toBe(migrated);
    const discussion = migrateOutboxInvitation({ ...record, envelope: { ...record.envelope, type: "chat.send", topicId: "root", requestId: "old", content: "讨论 " + legacy } });
    expect(discussion.state).toBe("queued");
    expect(JSON.stringify(discussion)).not.toContain(invitation.inviteToken);
    expect(migrateOutboxInvitation({ ...record, state: "accepted", ack: { submissionId: 42 } })).toMatchObject({ state: "accepted", ack: { submissionId: 42 } });
  });
});
