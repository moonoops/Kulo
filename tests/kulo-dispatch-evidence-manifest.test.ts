import { describe, expect, it } from "vitest";
import { AssistantEntry, type ConversationId, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import {
  MAX_EVIDENCE_PATHS,
  collectCoordinatorEvidencePaths,
  formatEvidenceManifest,
} from "../packages/hub/src/dispatch-evidence-manifest.js";

function assistant(id: number, calls: Array<{ name: string; arguments: Record<string, unknown> }>, text = ""): EntryRecord {
  return {
    id: id as EntryId,
    conversationId: 1 as ConversationId,
    kind: AssistantEntry.kind,
    model: [{
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...calls.map((call, index) => ({ type: "toolCall", id: `call-${id}-${index}`, name: call.name, arguments: call.arguments })),
      ],
    }],
    createdAt: id * 1000,
  } as unknown as EntryRecord;
}

function user(id: number): EntryRecord {
  return { id: id as EntryId, conversationId: 1 as ConversationId, kind: "pi.user", model: [{ role: "user", content: "check /app/data" }], createdAt: id } as unknown as EntryRecord;
}

describe("coordinator evidence manifest", () => {
  it("collects unique absolute read/edit paths from assistant tool calls only", () => {
    const paths = collectCoordinatorEvidencePaths([
      user(1),
      assistant(2, [{ name: "read", arguments: { path: "/app/data/a.csv" } }, { name: "bash", arguments: { command: "cat /app/secret" } }]),
      assistant(3, [{ name: "read", arguments: { path: "/app/data/a.csv" } }, { name: "edit", arguments: { path: "/app/output/note.md" } }]),
      assistant(4, [{ name: "read", arguments: { path: "relative/file.txt" } }, { name: "write", arguments: { path: "/app/output/new.md" } }]),
      assistant(5, [{ name: "read", arguments: { path: "C:\\work\\data\\sheet.xlsx" } }]),
    ]);
    expect(paths).toEqual(["/app/data/a.csv", "/app/output/note.md", "C:\\work\\data\\sheet.xlsx"]);
  });

  it("drops Kulo private state, control characters and anything changed by redaction", () => {
    const paths = collectCoordinatorEvidencePaths([
      assistant(2, [
        { name: "read", arguments: { path: "/app/.kulo-env/token" } },
        { name: "read", arguments: { path: "/app/.kulo-state/kulo-state.sqlite" } },
        { name: "read", arguments: { path: "/app/data/\u0007bell" } },
        { name: "read", arguments: { path: "/app/keys/sk-live-SECRET.txt" } },
        { name: "read", arguments: { path: "/app/data/ok.txt" } },
      ]),
    ], { redact: (text) => text.replace(/sk-live-[A-Z]+/g, "[REDACTED]") });
    expect(paths).toEqual(["/app/data/ok.txt"]);
  });

  it(`caps the manifest at ${MAX_EVIDENCE_PATHS} paths and formats one bounded line`, () => {
    const calls = Array.from({ length: 60 }, (_, index) => ({ name: "read", arguments: { path: `/app/data/file-${index}.txt` } }));
    const paths = collectCoordinatorEvidencePaths([assistant(2, calls)]);
    expect(paths).toHaveLength(MAX_EVIDENCE_PATHS);
    const line = formatEvidenceManifest(paths);
    expect(line.startsWith("Coordinator already inspected")).toBe(true);
    expect(line).toContain("/app/data/file-0.txt");
    expect(line.length).toBeLessThanOrEqual(2_010);
    expect(formatEvidenceManifest([])).toBe("");
  });
});
