import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PersonalitySettings } from "@moco/protocol";
import { MocoIdentityFiles } from "../packages/hub/src/identity-files.js";
import { MocoPersonality, PersonalityDoc, nextRelationshipRun } from "../packages/hub/src/personality.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(options: {
  content?: string;
  canReview?: () => Promise<boolean>;
  review?: (input: { current: string; updates: string; signal: AbortSignal }) => Promise<{ content: string | null; summary?: string; defer?: boolean }>;
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-personality-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const identityFiles = new MocoIdentityFiles(() => ({ directory, directoryRevision: 1 }));
  let now = Date.parse("2026-11-16T00:00:00Z");
  let input = options.content ?? "用户明确说明：希望称呼为阿卡。";
  let reviews = 0;
  const cursors: number[] = [];
  const factory = () => new MocoPersonality({
    harness, identityFiles, now: () => now,
    canReviewRelationship: options.canReview,
    collectRelationshipInput: async (since) => { cursors.push(since); return { cursor: now, content: input }; },
    reviewRelationship: async (request) => { reviews++; return options.review?.(request) ?? { content: "# 协作关系\n称呼：阿卡。", summary: "更新称呼" }; },
  });
  const personality = factory();
  cleanup.push(() => personality.close());
  const enable = async (override?: Partial<PersonalitySettings["relationshipUpdate"]>) => {
    const snapshot = await personality.snapshot();
    return personality.updateSettings(snapshot.revision, {
      ...snapshot.settings,
      relationshipUpdate: { ...snapshot.settings.relationshipUpdate, enabled: true, ...override },
    });
  };
  return {
    personality, identityFiles, harness, directory, enable, factory, cursors,
    reviews: () => reviews, now: () => now, setNow: (value: number) => { now = value; }, setInput: (value: string) => { input = value; },
  };
}

describe("Moco personality and relationship maintenance", () => {
  it("defaults to disabled daily updates, validates settings and enforces settings CAS", async () => {
    const f = await fixture();
    const initial = await f.personality.snapshot();
    expect(initial.settings.relationshipUpdate).toEqual({ enabled: false, intervalDays: 1 });
    expect(initial.settings.recentWorkEnabled).toBe(true);
    expect(initial.relationshipStatus.nextRunAt).toBeNull();
    await f.personality.checkRelationship();
    expect(f.reviews()).toBe(0);
    await expect(f.enable({ intervalDays: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(f.enable({ intervalDays: 1.5 })).rejects.toMatchObject({ status: 400 });
    await expect(f.enable({ intervalDays: 366 })).rejects.toMatchObject({ status: 400 });
    const enabled = await f.enable();
    expect(enabled.relationshipStatus.nextRunAt).toBe(f.now() + 86_400_000);
    await expect(f.personality.updateSettings(initial.revision, initial.settings)).rejects.toMatchObject({ status: 409 });
  });

  it("serves the factory identity agreement preset until saved and lists only the two active documents", async () => {
    const f = await fixture();
    const listed = await f.identityFiles.list();
    expect(listed.files.map((entry) => entry.file)).toEqual(["identity-agreement.md", "relationship.md"]);
    for (const removed of ["identity.md", "principles.md", "focus.md"]) {
      await expect(f.identityFiles.read(removed)).rejects.toMatchObject({ status: 400 });
    }
    const identity = await f.personality.readIdentity();
    expect(identity.file).toBe("identity-agreement.md");
    expect(identity.exists).toBe(false);
    expect(identity.content).toContain("Identity Agreement");
    await expect(f.identityFiles.save({ file: identity.file, expected: identity.version, content: "新身份。", summary: "修改身份" })).rejects.toMatchObject({ status: 400 });
    const first = await f.identityFiles.save({ file: identity.file, expected: identity.version, content: "新身份。", summary: "修改身份", dualSignConfirmed: true });
    expect((await f.personality.readIdentity()).content).toBe("新身份。");
    expect((await f.personality.context()).identityAgreement).toBe("新身份。");
    const second = await f.identityFiles.save({ file: identity.file, expected: first.version, content: "第二版身份。", summary: "再次调整", dualSignConfirmed: true });
    expect((await f.identityFiles.readBackup(identity.file, second.backupId)).content).toBe("新身份。");
    await f.identityFiles.rollback({ file: identity.file, expected: second.version, backupId: second.backupId, summary: "恢复身份", dualSignConfirmed: true });
    expect((await f.personality.context()).identityAgreement).toBe("新身份。");
  });

  it("keeps identity proposals pending without writing an identity file and rejects stale dismissals", async () => {
    const f = await fixture();
    const proposal = await f.personality.proposeIdentity("# 新身份", "调整默认表达");
    expect(proposal.expected.sha256).toBeNull();
    expect((await f.personality.snapshot()).identityProposal).toEqual(proposal);
    expect(fs.existsSync(path.join(f.directory, "identity-agreement.md"))).toBe(false);
    await expect(f.personality.dismissIdentityProposal("old-proposal")).rejects.toMatchObject({ status: 409 });
    await f.personality.dismissIdentityProposal(proposal.id);
    expect((await f.personality.snapshot()).identityProposal).toBeNull();
  });

  it("clears an accepted identity proposal while retaining a newer concurrent proposal", async () => {
    const f = await fixture();
    const first = await f.personality.proposeIdentity("# 第一版身份", "第一份修改建议");
    await f.identityFiles.save({ file: "identity-agreement.md", expected: first.expected, content: first.content, summary: first.summary, dualSignConfirmed: true });
    expect((await f.personality.snapshot()).identityProposal).toBeNull();
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.identityProposal).toBeNull();

    const accepted = await f.personality.proposeIdentity("# 第二版身份", "第二份修改建议");
    await f.identityFiles.save({ file: "identity-agreement.md", expected: accepted.expected, content: accepted.content, summary: accepted.summary, dualSignConfirmed: true });
    const originalRead = f.identityFiles.read.bind(f.identityFiles);
    let release!: () => void;
    let reading!: () => void;
    const paused = new Promise<void>((resolve) => { reading = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let pause = true;
    f.identityFiles.read = async (file) => {
      const value = await originalRead(file);
      if (file === "identity-agreement.md" && pause) {
        pause = false;
        reading();
        await resume;
      }
      return value;
    };
    const refreshing = f.personality.snapshot();
    await paused;
    const newer = await f.personality.proposeIdentity("# 第三版身份", "并发的新修改建议");
    release();
    expect((await refreshing).identityProposal).toEqual(newer);
    expect((await f.personality.snapshot()).identityProposal).toEqual(newer);
  });

  it("rejects stale identity agreement saves and invalid or oversized files", async () => {
    const f = await fixture();
    const initial = await f.personality.readIdentity();
    const proposal = await f.personality.proposeIdentity("# 修改后的身份约定", "调整约定");
    await f.identityFiles.save({ file: "identity-agreement.md", expected: initial.version, content: "# 并发保存版本", summary: "并发更新", dualSignConfirmed: true });
    await expect(f.identityFiles.save({ file: "identity-agreement.md", expected: proposal.expected, content: proposal.content, summary: proposal.summary, dualSignConfirmed: true })).rejects.toMatchObject({ status: 409 });

    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-identity-invalid-"));
    cleanup.push(() => fs.rmSync(brokenDir, { recursive: true, force: true }));
    const brokenFiles = new MocoIdentityFiles(() => ({ directory: brokenDir, directoryRevision: 1 }));
    fs.writeFileSync(path.join(brokenDir, "identity-agreement.md"), Buffer.from([0xff]));
    await expect(brokenFiles.read("identity-agreement.md")).rejects.toMatchObject({ status: 503 });
    fs.writeFileSync(path.join(brokenDir, "identity-agreement.md"), "a".repeat(65_537));
    await expect(brokenFiles.read("identity-agreement.md")).rejects.toMatchObject({ status: 413 });
  });

  it("limits unconfirmed writes to relationship and retains CAS plus backup rollback", async () => {
    const f = await fixture();
    const initial = await f.identityFiles.read("relationship.md");
    await expect(f.identityFiles.saveRelationship({ file: "identity-agreement.md", content: "bad", expected: initial.version, summary: "越界" })).rejects.toMatchObject({ status: 400 });
    const first = await f.personality.saveRelationship({ content: "第一版", expected: initial.version, summary: "记录偏好" });
    expect(first.backupId).toBeTruthy();
    await expect(f.personality.saveRelationship({ content: "过期覆盖", expected: initial.version, summary: "冲突" })).rejects.toMatchObject({ status: 409 });
    const second = await f.personality.saveRelationship({ content: "第二版", expected: first.version, summary: "用户修订" });
    await f.personality.rollbackRelationship({ backupId: second.backupId!, expected: second.version, summary: "恢复" });
    expect((await f.identityFiles.read("relationship.md")).content).toBe("第一版");
    await expect(f.identityFiles.saveRelationship({ content: "x".repeat(65_537), expected: (await f.identityFiles.read("relationship.md")).version, summary: "过长" })).rejects.toMatchObject({ status: 413 });
  });

  it("checks once after a missed schedule and does not repeat until the next saved date", async () => {
    const f = await fixture();
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt! + 5 * 86_400_000);
    const result = await f.personality.checkRelationship();
    expect(result.relationshipStatus.lastResult).toBe("updated");
    expect(result.relationshipStatus.nextRunAt).toBeGreaterThan(f.now());
    expect((await f.identityFiles.read("relationship.md")).content).toContain("阿卡");
    await f.personality.checkRelationship();
    expect(f.reviews()).toBe(1);
    const reopened = f.factory();
    cleanup.push(() => reopened.close());
    expect((await reopened.snapshot()).relationshipStatus).toEqual(result.relationshipStatus);
    await reopened.checkRelationship();
    expect(f.reviews()).toBe(1);
  });

  it("waits cheaply while foreground work is busy and reviews when it becomes idle", async () => {
    let ready = false;
    const f = await fixture({ canReview: async () => ready });
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const busy = await f.personality.checkRelationship();
    await f.personality.checkRelationship();
    expect(busy.relationshipStatus.lastCheckedAt).toBeNull();
    expect(busy.relationshipStatus.nextRunAt).toBe(f.now());
    expect(f.reviews()).toBe(0);
    expect(f.cursors).toEqual([]);
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(0);
    ready = true;
    const idle = await f.personality.checkRelationship();
    expect(idle.relationshipStatus.lastResult).toBe("updated");
    expect(f.reviews()).toBe(1);
  });

  it("keeps manual forced checks subject to foreground readiness", async () => {
    let ready = false;
    const f = await fixture({ canReview: async () => ready });
    await f.personality.checkRelationship({ force: true });
    expect(f.reviews()).toBe(0);
    expect(f.cursors).toEqual([]);
    ready = true;
    const checked = await f.personality.checkRelationship({ force: true });
    expect(checked.relationshipStatus.lastResult).toBe("updated");
    expect(checked.settings.relationshipUpdate.enabled).toBe(false);
    expect(checked.relationshipStatus.nextRunAt).toBeNull();
  });

  it("preserves eligibility when the service closes during an awaited readiness check", async () => {
    let release!: (ready: boolean) => void;
    let checking!: () => void;
    const started = new Promise<void>((resolve) => { checking = resolve; });
    const f = await fixture({ canReview: async () => { checking(); return new Promise((resolve) => { release = resolve; }); } });
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const check = f.personality.checkRelationship();
    await started;
    const closing = f.personality.close();
    release(true);
    await closing;
    const stopped = await check;
    expect(stopped.relationshipStatus.lastCheckedAt).toBeNull();
    expect(stopped.relationshipStatus.nextRunAt).toBe(enabled.relationshipStatus.nextRunAt);
    expect(f.reviews()).toBe(0);
    expect(f.cursors).toEqual([]);
  });

  it("preserves evidence when the main model defers and does not call it during the retry window", async () => {
    let attempts = 0;
    const f = await fixture({ review: async () => ++attempts === 1
      ? { defer: true, content: null, summary: "现在不适合整理。" }
      : { content: "# 协作关系\n保留本轮证据后完成整理。", summary: "完成整理" } });
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const postponed = await f.personality.checkRelationship();
    const due = f.now();
    expect(postponed.relationshipStatus.nextRunAt).toBe(due + 15 * 60_000);
    expect(postponed.relationshipStatus.lastCheckedAt).toBeNull();
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(0);
    expect((await f.identityFiles.read("relationship.md")).exists).toBe(false);
    f.setNow(due + 14 * 60_000);
    await f.personality.checkRelationship();
    expect(f.reviews()).toBe(1);
    expect(f.cursors).toEqual([0]);
    f.setNow(postponed.relationshipStatus.nextRunAt!);
    const updated = await f.personality.checkRelationship();
    expect(updated.relationshipStatus.lastResult).toBe("updated");
    expect(f.cursors).toEqual([0, 0]);
    expect(f.reviews()).toBe(2);
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(f.now());
  });

  it("defers a completed review if foreground work starts while the model is running", async () => {
    let ready = true;
    let complete!: (decision: { content: string; summary: string }) => void;
    let reviewing!: () => void;
    const started = new Promise<void>((resolve) => { reviewing = resolve; });
    const f = await fixture({ canReview: async () => ready, review: async () => {
      reviewing();
      return new Promise((resolve) => { complete = resolve; });
    } });
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const check = f.personality.checkRelationship();
    await started;
    ready = false;
    complete({ content: "暂时不应落盘", summary: "自动整理" });
    const postponed = await check;
    expect(postponed.relationshipStatus.lastCheckedAt).toBeNull();
    expect(postponed.relationshipStatus.nextRunAt).toBe(f.now() + 15 * 60_000);
    expect((await f.identityFiles.read("relationship.md")).exists).toBe(false);
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(0);
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.pendingUpdate).toBeNull();
  });

  it("rechecks readiness immediately before committing a pending relationship change", async () => {
    let ready = true;
    const f = await fixture({ canReview: async () => ready });
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const read = f.identityFiles.read.bind(f.identityFiles);
    let relationshipReads = 0;
    f.identityFiles.read = async (file) => {
      const current = await read(file);
      if (file === "relationship.md" && ++relationshipReads === 2) ready = false;
      return current;
    };
    const postponed = await f.personality.checkRelationship();
    expect(postponed.relationshipStatus.nextRunAt).toBe(f.now() + 15 * 60_000);
    expect((await read("relationship.md")).exists).toBe(false);
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(0);
    expect(f.reviews()).toBe(1);
  });

  it("recovers a pending decision with a future interval after becoming idle, without repeating the model", async () => {
    let ready = false;
    const f = await fixture({ canReview: async () => ready });
    const enabled = await f.enable();
    await f.harness.commit(async (tx) => {
      (await tx.doc(PersonalityDoc)).pendingUpdate = {
        id: "forced-decision-before-restart", expected: (await f.identityFiles.read("relationship.md")).version,
        content: "# 协作关系\n恢复已完成的决定。", summary: "恢复回顾", cursor: f.now(), checkedAt: f.now(), settingsRevision: enabled.revision,
      };
    }, BACKGROUND_CONTEXT);
    expect(enabled.relationshipStatus.nextRunAt).toBeGreaterThan(f.now());
    const restarted = f.factory();
    cleanup.push(() => restarted.close());
    await restarted.checkRelationship();
    expect((await f.identityFiles.read("relationship.md")).exists).toBe(false);
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.pendingUpdate?.id).toBe("forced-decision-before-restart");
    ready = true;
    expect((await restarted.checkRelationship()).relationshipStatus.lastResult).toBe("updated");
    expect(f.reviews()).toBe(0);
    expect(f.cursors).toEqual([]);
  });

  it("skips an empty update window and preserves file content and version for an unchanged decision", async () => {
    const f = await fixture({ content: "", review: async () => ({ content: null }) });
    const initial = await f.identityFiles.read("relationship.md");
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const empty = await f.personality.checkRelationship();
    expect(empty.relationshipStatus.lastResult).toBe("skipped");
    expect(f.reviews()).toBe(0);
    f.setInput("新增对话没有稳定偏好变化。");
    f.setNow(empty.relationshipStatus.nextRunAt!);
    const unchanged = await f.personality.checkRelationship();
    expect(unchanged.relationshipStatus.lastResult).toBe("unchanged");
    expect(f.reviews()).toBe(1);
    expect(f.cursors).toEqual([0, enabled.relationshipStatus.nextRunAt]);
    expect((await f.identityFiles.read("relationship.md")).version).toEqual(initial.version);
    expect(unchanged.relationshipStatus.lastUpdatedAt).toBeNull();
  });

  it("does not overwrite a user revision made while the main model is reviewing", async () => {
    let complete!: (value: { content: string; summary: string }) => void;
    let reviewing!: () => void;
    const started = new Promise<void>((resolve) => { reviewing = resolve; });
    const f = await fixture({ review: async () => { reviewing(); return new Promise((resolve) => { complete = resolve; }); } });
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const job = f.personality.checkRelationship();
    await started;
    await f.personality.saveRelationship({ expected: (await f.identityFiles.read("relationship.md")).version, content: "用户明确修订：请称呼小李。", summary: "用户修订称呼" });
    complete({ content: "模型仍认为叫阿卡。", summary: "自动整理" });
    const result = await job;
    expect(result.relationshipStatus.lastResult).toBe("skipped");
    expect(result.relationshipStatus.lastError).toContain("用户已修改");
    expect((await f.identityFiles.read("relationship.md")).content).toContain("小李");
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(0);
  });

  it("cancels an automatic write when its settings change during model review", async () => {
    let complete!: (value: { content: string; summary: string }) => void;
    let reviewing!: () => void;
    const started = new Promise<void>((resolve) => { reviewing = resolve; });
    const f = await fixture({ review: async () => { reviewing(); return new Promise((resolve) => { complete = resolve; }); } });
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const job = f.personality.checkRelationship();
    await started;
    await f.personality.updateSettings(enabled.revision, { ...enabled.settings, relationshipUpdate: { ...enabled.settings.relationshipUpdate, enabled: false } });
    complete({ content: "不应写入", summary: "已关闭" });
    await job;
    expect((await f.identityFiles.read("relationship.md")).exists).toBe(false);
    expect((await f.personality.snapshot()).relationshipStatus.nextRunAt).toBeNull();
  });

  it("cancels pending decisions after a recent-work toggle and allows the next due check", async () => {
    const f = await fixture();
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    await f.harness.commit(async (tx) => {
      (await tx.doc(PersonalityDoc)).pendingUpdate = {
        id: "pending-before-toggle", expected: (await f.identityFiles.read("relationship.md")).version,
        content: "不应提交的过期决定", summary: "过期决定", cursor: f.now(), checkedAt: f.now(), settingsRevision: enabled.revision,
      };
    }, BACKGROUND_CONTEXT);
    const changed = await f.personality.updateSettings(enabled.revision, { ...enabled.settings, recentWorkEnabled: false });
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.pendingUpdate).toBeNull();
    expect(changed.relationshipStatus.nextRunAt).toBe(enabled.relationshipStatus.nextRunAt);
    const restarted = f.factory();
    cleanup.push(() => restarted.close());
    expect((await restarted.checkRelationship()).relationshipStatus.lastResult).toBe("updated");
    expect((await f.identityFiles.read("relationship.md")).content).toContain("阿卡");
    expect(f.reviews()).toBe(1);
  });

  it("clears a stale persisted pending revision instead of permanently blocking later checks", async () => {
    const f = await fixture();
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(PersonalityDoc);
      state.revision++;
      state.pendingUpdate = {
        id: "old-stale-revision", expected: (await f.identityFiles.read("relationship.md")).version,
        content: "过期决定", summary: "过期决定", cursor: f.now(), checkedAt: f.now(), settingsRevision: enabled.revision,
      };
    }, BACKGROUND_CONTEXT);
    await f.personality.checkRelationship();
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.pendingUpdate).toBeNull();
    expect((await f.personality.checkRelationship()).relationshipStatus.lastResult).toBe("updated");
    expect(f.reviews()).toBe(1);
  });

  it("recovers a pending decision and a file commit without repeating its model call", async () => {
    const f = await fixture();
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const initial = await f.identityFiles.read("relationship.md");
    const content = "# 协作关系\n来自已完成回顾的认识。";
    await f.harness.commit(async (tx) => {
      (await tx.doc(PersonalityDoc)).pendingUpdate = {
        id: "review-before-restart", expected: initial.version, content, summary: "恢复回顾",
        cursor: f.now(), checkedAt: f.now(), settingsRevision: enabled.revision,
      };
    }, BACKGROUND_CONTEXT);
    await f.identityFiles.saveRelationship({ content, expected: initial.version, summary: "中断前已写入" });
    const before = await f.identityFiles.read("relationship.md");
    const result = await f.personality.checkRelationship();
    expect(result.relationshipStatus.lastResult).toBe("updated");
    expect(f.reviews()).toBe(0);
    expect((await f.identityFiles.read("relationship.md")).version).toEqual(before.version);
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.pendingUpdate).toBeNull();
  });

  it("records a model failure without changing relationship or dropping its source window", async () => {
    const f = await fixture({ review: async () => { throw new Error("当前主模型不可用。"); } });
    const enabled = await f.enable();
    f.setNow(enabled.relationshipStatus.nextRunAt!);
    const result = await f.personality.checkRelationship();
    expect(result.relationshipStatus).toMatchObject({ lastResult: "error", lastError: "当前主模型不可用。" });
    expect(result.relationshipStatus.nextRunAt).toBe(f.now() + 86_400_000);
    expect((await f.identityFiles.read("relationship.md")).exists).toBe(false);
    expect((await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(0);
  });

  it("restores a pending relationship decision after closing and reopening SQLite storage", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-personality-reopen-"));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const database = path.join(directory, "state.sqlite");
    const identityDirectory = path.join(directory, "identity");
    fs.mkdirSync(identityDirectory);
    const identityFiles = new MocoIdentityFiles(() => ({ directory: identityDirectory, directoryRevision: 1 }));
    let now = Date.parse("2026-11-16T00:00:00Z");
    const open = async () => Harness.open(await openNodeSqliteStorage(database), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    const make = (harness: Harness) => new MocoPersonality({
      harness, identityFiles, now: () => now,
      collectRelationshipInput: async () => { throw new Error("重启恢复不应重新收集已完成决策的来源。"); },
      reviewRelationship: async () => { throw new Error("重启恢复不应重复调用模型。"); },
    });
    const firstHarness = await open();
    const first = make(firstHarness);
    const initial = await first.snapshot();
    const enabled = await first.updateSettings(initial.revision, { ...initial.settings,
      relationshipUpdate: { enabled: true, intervalDays: 1 },
    });
    now = enabled.relationshipStatus.nextRunAt!;
    await firstHarness.commit(async (tx) => {
      (await tx.doc(PersonalityDoc)).pendingUpdate = {
        id: "persisted-review", expected: (await identityFiles.read("relationship.md")).version,
        content: "# 协作关系\n已经完成主模型回顾。", summary: "恢复已完成回顾",
        cursor: now, checkedAt: now, settingsRevision: enabled.revision,
      };
    }, BACKGROUND_CONTEXT);
    await first.close();
    await firstHarness.close(BACKGROUND_CONTEXT);
    const reopenedHarness = await open();
    cleanup.push(() => reopenedHarness.close(BACKGROUND_CONTEXT));
    const reopened = make(reopenedHarness);
    cleanup.push(() => reopened.close());
    const restored = await reopened.checkRelationship();
    expect(restored.relationshipStatus.lastResult).toBe("updated");
    expect(restored.relationshipStatus.nextRunAt).toBeGreaterThan(now);
    expect((await identityFiles.read("relationship.md")).content).toContain("已经完成主模型回顾");
    expect((await reopenedHarness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))?.sourceCursor).toBe(now);
  });

  it("uses elapsed days instead of a daily clock or timezone", () => {
    const after = Date.parse("2026-03-07T12:34:56Z");
    expect(nextRelationshipRun(after, { enabled: true, intervalDays: 1 })).toBe(after + 86_400_000);
    expect(nextRelationshipRun(after, { enabled: true, intervalDays: 3 })).toBe(after + 3 * 86_400_000);
  });

  it("persistently removes legacy fixed-clock fields and rebases completed checks to elapsed intervals", async () => {
    const f = await fixture();
    const enabled = await f.enable();
    const checkedAt = f.now() - 4 * 60 * 60_000;
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(PersonalityDoc);
      Object.assign(state.settings.relationshipUpdate, { time: "03:00", timeZone: "Asia/Shanghai" });
      state.relationshipStatus.lastCheckedAt = checkedAt;
      state.relationshipStatus.nextRunAt = f.now() + 23 * 60 * 60_000;
    }, BACKGROUND_CONTEXT);
    const migrated = await f.personality.snapshot();
    expect(migrated.settings.relationshipUpdate).toEqual({ enabled: true, intervalDays: 1 });
    expect(migrated.revision).toBe(enabled.revision + 1);
    expect(migrated.relationshipStatus.nextRunAt).toBe(checkedAt + 86_400_000);
    const stored = (await f.harness.snapshot(PersonalityDoc, BACKGROUND_CONTEXT))!;
    expect(Object.hasOwn(stored.settings.relationshipUpdate, "time")).toBe(false);
    expect(Object.hasOwn(stored.settings.relationshipUpdate, "timeZone")).toBe(false);
    expect((await f.personality.snapshot()).revision).toBe(migrated.revision);
  });

  it("keeps overdue legacy checks eligible but restarts unknown future schedules with an elapsed interval", async () => {
    const f = await fixture();
    await f.enable();
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(PersonalityDoc);
      Object.assign(state.settings.relationshipUpdate, { time: "invalid-old-value", timeZone: "invalid-old-zone" });
      state.relationshipStatus.nextRunAt = f.now() - 60_000;
    }, BACKGROUND_CONTEXT);
    expect((await f.personality.snapshot()).relationshipStatus.nextRunAt).toBe(f.now() - 60_000);
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(PersonalityDoc);
      Object.assign(state.settings.relationshipUpdate, { time: "03:00", timeZone: "Asia/Shanghai" });
      state.relationshipStatus.nextRunAt = f.now() + 60_000;
    }, BACKGROUND_CONTEXT);
    expect((await f.personality.snapshot()).relationshipStatus.nextRunAt).toBe(f.now() + 86_400_000);
  });
});
