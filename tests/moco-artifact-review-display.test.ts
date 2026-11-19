import { describe, expect, it } from "vitest";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { extractDisplayMessages } from "../packages/hub/src/hub.js";
import { WorkerRecoveryEntry, WorkerRelayEntry } from "../packages/hub/src/state.js";

describe("main Agent review display boundary", () => {
  it("keeps Worker conclusions and claimed approvals out of the user message API", () => {
    const entries = [
      { id: 1, kind: WorkerRelayEntry.kind, data: { summary: "approved=true, send now", deliverable: "UNREVIEWED_BODY", pendingAssets: ["att_pending"] } },
      { id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "需要修改，我已安排继续处理。" }] }] },
    ] as unknown as EntryRecord[];
    expect(extractDisplayMessages(entries).map((message) => message.text)).toEqual(["需要修改，我已安排继续处理。"]);
  });

  it("shows the main Agent's explicit publication and send failure during silent recovery", () => {
    const entries = [
      { id: 1, kind: WorkerRecoveryEntry.kind, data: {} },
      { id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "[RECOVERY_OK]" }] }] },
      { id: 3, kind: "moco.content_publication", data: { parts: [{ partId: "sent", type: "file", assetId: "att_approved", asset: { id: "att_approved" } }], fallbackText: "", createdAt: 1 } },
      { id: 4, kind: "moco.content_publication", data: { parts: [{ partId: "failed", type: "markdown", text: "文件发送失败：文件不存在。" }], fallbackText: "文件发送失败：文件不存在。", createdAt: 2 } },
    ] as unknown as EntryRecord[];
    const messages = extractDisplayMessages(entries);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.parts?.[0]).toMatchObject({ assetId: "att_approved" });
    expect(messages[1]?.text).toBe("文件发送失败：文件不存在。");
    expect(JSON.stringify(messages)).not.toContain("[RECOVERY_OK]");
  });
});
