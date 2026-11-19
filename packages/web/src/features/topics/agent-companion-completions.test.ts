import { describe, expect, it } from "vitest";
import type { LiveStreamState, TicketCardView } from "@kulo/protocol";
import { CompanionCompletionTracker, type CompanionCompletionSnapshot } from "./agent-companion-completions";
import type { AgentTerminalEntry } from "./agent-terminal-state";

const live = (patch: Partial<LiveStreamState> = {}): LiveStreamState => ({ busy: false, activeTools: [], queuedCount: 0, ...patch });
const ticket = (patch: Partial<TicketCardView> = {}): TicketCardView => ({ id: "task", title: "检查项目", role: "developer", roleLabel: "开发", status: "running", envId: "local", workspaceDir: "/tmp", originTopicId: "root", createdAt: 1, updatedAt: 1, ...patch });
const entry = (patch: Partial<AgentTerminalEntry> = {}): AgentTerminalEntry => ({ id: "root:3", text: "执行完成", tone: "done", outcome: "completed", eventId: "root:3:completed", eventAt: 10, ...patch });
const snapshot = (patch: Partial<CompanionCompletionSnapshot> = {}): CompanionCompletionSnapshot => ({ scope: "root", connected: true, live: live(), tickets: [], entries: [], ...patch });

describe("companion completion tracker", () => {
  it("baselines restored completions and does not replay older ready work when it becomes latest", () => {
    const older = ticket({ id: "old", status: "ready", completedAt: 5 });
    const newer = ticket({ id: "new", status: "ready", completedAt: 10 });
    const tracker = new CompanionCompletionTracker(snapshot({ tickets: [older, newer], entries: [entry()] }));
    expect(tracker.observe(snapshot({ tickets: [older, newer], entries: [entry()] }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ tickets: [older] }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ tickets: [older, { ...newer, updatedAt: 50, userSummary: "补充说明" }] }))).toEqual({ reset: false });
  });

  it("does not celebrate a late first snapshot of already ready tasks or journal history", () => {
    const tracker = new CompanionCompletionTracker(snapshot({ live: undefined }));
    expect(tracker.observe(snapshot({ tickets: [ticket({ status: "ready", completedAt: 10 })], entries: [entry()] }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ tickets: [ticket({ status: "ready", completedAt: 10 })], entries: [entry()] }))).toEqual({ reset: false });
  });

  it.each(["queued", "running", "pausing", "waiting", "blocked"] as const)("celebrates an observed %s task becoming ready once", (status) => {
    const tracker = new CompanionCompletionTracker(snapshot({ tickets: [ticket({ status })] }));
    const ready = snapshot({ tickets: [ticket({ status: "ready", completedAt: 20 })] });
    expect(tracker.observe(ready)).toEqual({ eventId: "ticket:task:completed:20", reset: false });
    expect(tracker.observe(ready)).toEqual({ reset: false });
  });

  it.each(["ready", "failed", "stopped", "closed"] as const)("does not celebrate a settled %s task becoming ready without a new observed run", (status) => {
    const tracker = new CompanionCompletionTracker(snapshot({ tickets: [ticket({ status, completedAt: 5 })] }));
    expect(tracker.observe(snapshot({ tickets: [ticket({ status: "ready", completedAt: 20 })] }))).toEqual({ reset: false });
  });

  it("uses the newest eligible completion and consumes the other events", () => {
    const tracker = new CompanionCompletionTracker(snapshot({ live: live({ busy: true }), tickets: [ticket({ id: "a" }), ticket({ id: "b" })] }));
    expect(tracker.observe(snapshot({ live: live(), tickets: [ticket({ id: "a", status: "ready", completedAt: 20 }), ticket({ id: "b", status: "ready", completedAt: 30 })], entries: [entry({ eventAt: 25 })] }))).toEqual({ eventId: "ticket:b:completed:30", reset: false });
    expect(tracker.observe(snapshot({ tickets: [ticket({ id: "a", status: "ready", completedAt: 20 })], entries: [entry({ eventAt: 25 })] }))).toEqual({ reset: false });
  });

  it("allows another completion after a new run of the same task", () => {
    const tracker = new CompanionCompletionTracker(snapshot({ tickets: [ticket({ status: "ready", completedAt: 10 })] }));
    expect(tracker.observe(snapshot({ tickets: [ticket()] }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ tickets: [ticket({ status: "ready", completedAt: 20 })] }))).toEqual({ eventId: "ticket:task:completed:20", reset: false });
  });

  it("celebrates successful busy-to-idle live settlement but not repeated idle snapshots", () => {
    const tracker = new CompanionCompletionTracker(snapshot({ live: live({ busy: true }) }));
    const settled = snapshot({ entries: [entry()] });
    expect(tracker.observe(settled)).toEqual({ eventId: "root:3:completed", reset: false });
    expect(tracker.observe(settled)).toEqual({ reset: false });
  });

  it("waits for the matching live state and accepts a later structured journal settlement", () => {
    const tracker = new CompanionCompletionTracker(snapshot({ live: live({ busy: true }) }));
    expect(tracker.observe(snapshot({ live: undefined }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot())).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ entries: [entry()] }))).toEqual({ eventId: "root:3:completed", reset: false });
  });

  it("ignores ticket journal rows and unstructured done rows as live settlements", () => {
    const tracker = new CompanionCompletionTracker(snapshot({ live: live({ busy: true }) }));
    expect(tracker.observe(snapshot({ entries: [entry({ eventId: "ticket:unknown:completed:10" })] }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ entries: [entry({ id: "legacy", outcome: undefined, eventId: undefined })] }))).toEqual({ reset: false });
  });

  it.each(["aborted", "model_error"])("does not celebrate %s or replay a late completion after it", (reason) => {
    const tracker = new CompanionCompletionTracker(snapshot({ live: live({ busy: true }) }));
    expect(tracker.observe(snapshot({ live: live({ runFailure: { reason } }) }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ entries: [entry()] }))).toEqual({ reset: false });
  });

  it.each(["stopped", "failed", "closed"] as const)("cancels a pending live completion when a new %s settlement arrives", (outcome) => {
    const tracker = new CompanionCompletionTracker(snapshot({ live: live({ busy: true }) }));
    expect(tracker.observe(snapshot())).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ entries: [entry({ outcome, eventId: `root:3:${outcome}`, tone: outcome === "failed" ? "error" : "info" })] }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ entries: [entry({ id: "root:4", eventId: "root:4:completed" })] }))).toEqual({ reset: false });
  });

  it("does not let an old failure row cancel the next successful run", () => {
    const failed = entry({ outcome: "failed", eventId: "root:3:failed", tone: "error" });
    const tracker = new CompanionCompletionTracker(snapshot({ entries: [failed] }));
    expect(tracker.observe(snapshot({ live: live({ busy: true }), entries: [failed] }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ entries: [failed] }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ entries: [failed, entry({ id: "root:6", eventId: "root:6:completed", eventAt: 20 })] }))).toEqual({ eventId: "root:6:completed", reset: false });
  });

  it("rebaselines topic changes and late history without replaying the previous topic", () => {
    const tracker = new CompanionCompletionTracker(snapshot({ live: live({ busy: true }), tickets: [ticket()] }));
    expect(tracker.observe(snapshot({ scope: "other", tickets: [ticket({ status: "ready", completedAt: 20 })], entries: [entry()] }))).toEqual({ reset: true });
    expect(tracker.observe(snapshot({ scope: "other", entries: [entry({ id: "other:1", eventId: "other:1:completed" })] }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ entries: [entry()] }))).toEqual({ reset: true });
  });

  it("rebaselines disconnect and reconnect snapshots and ignores work settling offline", () => {
    const tracker = new CompanionCompletionTracker(snapshot({ live: live({ busy: true }), tickets: [ticket()] }));
    expect(tracker.observe(snapshot({ connected: false, live: live({ busy: true }), tickets: [ticket()] }))).toEqual({ reset: true });
    const ready = snapshot({ connected: false, tickets: [ticket({ status: "ready", completedAt: 20 })], entries: [entry()] });
    expect(tracker.observe(ready)).toEqual({ reset: false });
    expect(tracker.observe({ ...ready, connected: true })).toEqual({ reset: true });
    expect(tracker.observe({ ...ready, connected: true })).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ tickets: [ticket()], live: live({ busy: true }) }))).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ tickets: [ticket({ status: "ready", completedAt: 30 })], entries: [entry({ id: "root:7", eventId: "root:7:completed", eventAt: 35 })] }))).toEqual({ eventId: "root:7:completed", reset: false });
  });

  it("does not retain removed ticket status as evidence of current execution", () => {
    const tracker = new CompanionCompletionTracker(snapshot({ tickets: [ticket()] }));
    expect(tracker.observe(snapshot())).toEqual({ reset: false });
    expect(tracker.observe(snapshot({ tickets: [ticket({ status: "ready", completedAt: 20 })] }))).toEqual({ reset: false });
  });
});
