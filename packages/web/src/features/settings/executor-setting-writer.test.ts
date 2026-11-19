import { describe, expect, it, vi } from "vitest";
import type { ExecutorSlotsConfig, MocoSettingsView } from "@moco/protocol";
import { MocoApiError } from "../../moco-api";
import { ExecutorSettingConflict, ExecutorSettingWriter, executorSettingValue } from "./executor-setting-writer";

const initialValue: ExecutorSlotsConfig = { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false,
  watchdogMinutes: 5, completedTaskDisplayHours: 3, autoArchiveEnabled: true, autoArchiveDays: 7 };
const settings = (revision = 1, value: ExecutorSlotsConfig = initialValue) => ({ blocks: { executor: { revision, value } }, globalRevision: revision } as MocoSettingsView);

describe("runtime single-setting persistence", () => {
  it("serializes rapid independent changes against the latest saved revision", async () => {
    const requests: Array<{ revision: number; value: ExecutorSlotsConfig }> = [];
    const save = vi.fn(async (revision: number, value: ExecutorSlotsConfig) => {
      requests.push({ revision, value });
      return { settings: settings(revision + 1, value) };
    });
    const writer = new ExecutorSettingWriter(settings(), save);
    await Promise.all([writer.commit("paused", true), writer.commit("autoArchiveEnabled", false)]);
    expect(requests.map((request) => request.revision)).toEqual([1, 2]);
    expect(requests[1]!.value).toEqual({ ...initialValue, paused: true, autoArchiveEnabled: false });
    expect(writer.snapshot.blocks.executor.revision).toBe(3);
  });

  it("preserves an external change to an unrelated field without submitting another local draft", async () => {
    const save = vi.fn(async (revision: number, value: ExecutorSlotsConfig) => ({ settings: settings(revision + 1, value) }));
    const writer = new ExecutorSettingWriter(settings(), save);
    const editedWorkerBaseline = writer.snapshot.blocks.executor.value.maxConcurrentWorkers;
    writer.accept(settings(2, { ...initialValue, autoArchiveDays: 30 }));
    await writer.commit("maxConcurrentWorkers", 6, editedWorkerBaseline);
    expect(save).toHaveBeenCalledWith(2, { ...initialValue, autoArchiveDays: 30, maxConcurrentWorkers: 6 });
  });

  it("rejects a stale field draft before writing and requires an explicit reload", async () => {
    const save = vi.fn(async (revision: number, value: ExecutorSlotsConfig) => ({ settings: settings(revision + 1, value) }));
    const writer = new ExecutorSettingWriter(settings(), save);
    writer.accept(settings(2, { ...initialValue, maxConcurrentWorkers: 8 }));
    await expect(writer.commit("maxConcurrentWorkers", 6, 3)).rejects.toBeInstanceOf(ExecutorSettingConflict);
    await expect(writer.commit("paused", true)).rejects.toBeInstanceOf(ExecutorSettingConflict);
    expect(save).not.toHaveBeenCalled();
    writer.reload(writer.snapshot);
    await writer.commit("maxConcurrentWorkers", 6, 8);
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps server-confirmed state after a failure and lets another independent change proceed", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(async (revision: number, value: ExecutorSlotsConfig) => ({ settings: settings(revision + 1, value) }));
    const writer = new ExecutorSettingWriter(settings(), save);
    const first = writer.commit("paused", true);
    const second = writer.commit("autoArchiveEnabled", false);
    await expect(first).rejects.toThrow("offline");
    await second;
    expect(writer.snapshot.blocks.executor.value.paused).toBe(false);
    expect(writer.snapshot.blocks.executor.value.autoArchiveEnabled).toBe(false);
    expect(save.mock.calls[1]).toEqual([1, { ...initialValue, autoArchiveEnabled: false }]);
  });

  it("blocks queued writes after a 409 until the latest block is explicitly loaded", async () => {
    const save = vi.fn().mockRejectedValueOnce(new MocoApiError(409, "changed")).mockImplementation(async (revision: number, value: ExecutorSlotsConfig) => ({ settings: settings(revision + 1, value) }));
    const writer = new ExecutorSettingWriter(settings(), save);
    const first = writer.commit("paused", true);
    const second = writer.commit("autoArchiveEnabled", false);
    await expect(first).rejects.toBeInstanceOf(MocoApiError);
    await expect(second).rejects.toBeInstanceOf(ExecutorSettingConflict);
    expect(save).toHaveBeenCalledOnce();
    writer.reload(settings(3, { ...initialValue, watchdogMinutes: 10 }));
    await writer.commit("paused", true);
    expect(save.mock.calls[1]).toEqual([3, { ...initialValue, watchdogMinutes: 10, paused: true }]);
  });

  it("does not downgrade a newer external snapshot when an older request finishes", async () => {
    let finish!: (result: { settings: MocoSettingsView }) => void;
    const save = vi.fn(() => new Promise<{ settings: MocoSettingsView }>((resolve) => { finish = resolve; }));
    const writer = new ExecutorSettingWriter(settings(), save);
    const pending = writer.commit("paused", true);
    await Promise.resolve();
    writer.accept(settings(3, { ...initialValue, paused: true, watchdogMinutes: 12 }));
    finish({ settings: settings(2, { ...initialValue, paused: true }) });
    await pending;
    expect(writer.snapshot.blocks.executor.revision).toBe(3);
    expect(writer.snapshot.blocks.executor.value.watchdogMinutes).toBe(12);
  });

  it("keeps executor revision separate from changes to another settings block", async () => {
    const save = vi.fn(async (revision: number, value: ExecutorSlotsConfig) => ({ settings: { ...settings(revision + 1, value), globalRevision: 9 } }));
    const writer = new ExecutorSettingWriter(settings(), save);
    writer.accept({ ...settings(), globalRevision: 8 });
    expect(writer.snapshot.globalRevision).toBe(8);
    await writer.commit("completedTaskDisplayHours", 6);
    expect(save).toHaveBeenCalledWith(1, { ...initialValue, completedTaskDisplayHours: 6 });
    expect(writer.snapshot.globalRevision).toBe(9);
  });

  it("reports a newer external change to the submitted field instead of treating an older response as success", async () => {
    let finish!: (result: { settings: MocoSettingsView }) => void;
    const save = vi.fn(() => new Promise<{ settings: MocoSettingsView }>((resolve) => { finish = resolve; }));
    const writer = new ExecutorSettingWriter(settings(), save);
    const pending = writer.commit("maxConcurrentWorkers", 6, 3);
    await Promise.resolve();
    writer.accept(settings(3, { ...initialValue, maxConcurrentWorkers: 8 }));
    finish({ settings: settings(2, { ...initialValue, maxConcurrentWorkers: 6 }) });
    await expect(pending).rejects.toBeInstanceOf(ExecutorSettingConflict);
    expect(writer.snapshot.blocks.executor.value.maxConcurrentWorkers).toBe(8);
    expect(writer.blocked).toBe(true);
  });

  it("does not resubmit a duplicate blur/Enter commit and retains legacy defaults", async () => {
    const save = vi.fn(async (revision: number, value: ExecutorSlotsConfig) => ({ settings: settings(revision + 1, value) }));
    const writer = new ExecutorSettingWriter(settings(), save);
    await Promise.all([writer.commit("maxConcurrentWorkers", 6, 3), writer.commit("maxConcurrentWorkers", 6, 3)]);
    expect(save).toHaveBeenCalledOnce();
    const legacy = { maxConcurrentWorkers: 3, paused: false } as ExecutorSlotsConfig;
    expect(executorSettingValue(legacy, "maxSubagentsPerTicket")).toBe(4);
    expect(executorSettingValue(legacy, "watchdogMinutes")).toBe(5);
    expect(executorSettingValue(legacy, "completedTaskDisplayHours")).toBe(3);
    expect(executorSettingValue(legacy, "autoArchiveEnabled")).toBe(true);
    expect(executorSettingValue(legacy, "autoArchiveDays")).toBe(7);
    expect(executorSettingValue({ ...initialValue, completedTaskDisplayHours: null }, "completedTaskDisplayHours")).toBeNull();
  });
});
