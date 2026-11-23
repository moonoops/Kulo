import { describe, expect, it } from "vitest";
import type { PendingSubmissionBackup } from "./chat-submissions";
import { resolveFailedChatRetryEnvelope } from "./use-target-device-selection";

function makeBackup(overrides: Partial<PendingSubmissionBackup> = {}): PendingSubmissionBackup {
  return {
    localMessageId: -1,
    createdAt: 100,
    localSequence: 7,
    outboxScope: "hub-1::principal-1",
    topicId: "root",
    draftKey: "topic:root",
    rawUserText: "帮我看一下日志",
    draftAttachments: [],
    state: "failed",
    errorCode: "target_device_unavailable",
    error: "目标设备尚未连接。",
    envelope: {
      type: "chat.send",
      topicId: "root",
      content: "帮我看一下日志",
      requestId: "web:old-1",
      whenBusy: "steer",
      targetDeviceId: "device-offline",
    },
    ...overrides,
  };
}

describe("resolveFailedChatRetryEnvelope", () => {
  it("builds a replacement chat.send envelope when retrying a failed message after switching back to Auto", () => {
    const next = resolveFailedChatRetryEnvelope({
      backup: makeBackup(),
      activeTopicId: "root",
      isProjectTopic: false,
      selectedTargetDeviceId: "",
      persistedTargetDeviceId: "",
      createRequestId: () => "web:fresh-auto",
    });
    expect(next).toEqual({
      type: "chat.send",
      topicId: "root",
      content: "帮我看一下日志",
      requestId: "web:fresh-auto",
      whenBusy: "steer",
    });
    expect("targetDeviceId" in (next ?? {})).toBe(false);
  });

  it("builds a replacement chat.send envelope with the newly selected online device", () => {
    const next = resolveFailedChatRetryEnvelope({
      backup: makeBackup(),
      activeTopicId: "root",
      isProjectTopic: false,
      selectedTargetDeviceId: "local",
      persistedTargetDeviceId: "local",
      createRequestId: () => "web:fresh-local",
    });
    expect(next).toEqual({
      type: "chat.send",
      topicId: "root",
      content: "帮我看一下日志",
      requestId: "web:fresh-local",
      whenBusy: "steer",
      targetDeviceId: "local",
    });
  });

  it("returns null to preserve original requestId when target device did not change", () => {
    expect(
      resolveFailedChatRetryEnvelope({
        backup: makeBackup(),
        activeTopicId: "root",
        isProjectTopic: false,
        selectedTargetDeviceId: "device-offline",
        persistedTargetDeviceId: "device-offline",
      }),
    ).toBeNull();
  });

  it("never replaces unconfirmed_disconnect submissions, project topics, or ticket.steer commands", () => {
    expect(
      resolveFailedChatRetryEnvelope({
        backup: makeBackup({ state: "unconfirmed_disconnect" }),
        activeTopicId: "root",
        isProjectTopic: false,
        selectedTargetDeviceId: "",
        persistedTargetDeviceId: "",
      }),
    ).toBeNull();
    expect(
      resolveFailedChatRetryEnvelope({
        backup: makeBackup(),
        activeTopicId: "root",
        isProjectTopic: true,
        selectedTargetDeviceId: "",
        persistedTargetDeviceId: "",
      }),
    ).toBeNull();
    expect(
      resolveFailedChatRetryEnvelope({
        backup: makeBackup({
          envelope: {
            type: "ticket.steer",
            ticketId: "T-1",
            text: "继续",
            commandId: "steer:1",
          },
        }),
        activeTopicId: "root",
        isProjectTopic: false,
        selectedTargetDeviceId: "",
        persistedTargetDeviceId: "",
      }),
    ).toBeNull();
  });
});
