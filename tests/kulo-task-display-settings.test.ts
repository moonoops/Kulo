import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletedTaskDisplayHours } from "@kulo/protocol";
import { resolveHubConfig } from "../packages/hub/src/config";
import { KuloHub } from "../packages/hub/src/hub";
import {
  KuloSettingsDoc,
  applySettingsBlockUpdate,
  hydrateSettingsFromConfig,
  rollbackSettingsToSnapshot,
  toPublicSettingsView,
} from "../packages/hub/src/settings";

const directories: string[] = [];
const hubs: KuloHub[] = [];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function settings() {
  const doc = KuloSettingsDoc.definition.initial();
  hydrateSettingsFromConfig(doc, resolveHubConfig({ enableLocalEnv: false }));
  return doc;
}

describe("completed task display setting", () => {
  it("defaults legacy executor settings to three hours and preserves an explicit forever value", () => {
    const doc = settings();
    delete doc.executor.completedTaskDisplayHours;
    expect(toPublicSettingsView(doc, "/tmp/identity").blocks.executor.value.completedTaskDisplayHours).toBe(3);
    hydrateSettingsFromConfig(doc, resolveHubConfig({ enableLocalEnv: false }));
    expect(doc.executor.completedTaskDisplayHours).toBe(3);
    doc.executor.completedTaskDisplayHours = null;
    hydrateSettingsFromConfig(doc, resolveHubConfig({ enableLocalEnv: false }));
    expect(toPublicSettingsView(doc, "/tmp/identity").blocks.executor.value.completedTaskDisplayHours).toBeNull();
  });

  it.each([1, 3, 6, null] satisfies CompletedTaskDisplayHours[])("accepts %s and keeps it on an older client's runtime save", (value) => {
    const doc = settings();
    applySettingsBlockUpdate(doc, "executor", doc.revisions.executor, { ...doc.executor, completedTaskDisplayHours: value });
    const { completedTaskDisplayHours: _legacyOmission, ...olderClient } = doc.executor;
    applySettingsBlockUpdate(doc, "executor", doc.revisions.executor, { ...olderClient, maxConcurrentWorkers: 4 });
    expect(doc.executor.completedTaskDisplayHours).toBe(value);
    expect(toPublicSettingsView(doc, "/tmp/identity").blocks.executor.value.completedTaskDisplayHours).toBe(value);
  });

  it.each([0, 2, 24, -1, 1.5, "3", true, {}, []])("rejects unsupported external display values without changing settings: %j", (value) => {
    const doc = settings();
    const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "executor", doc.revisions.executor, { ...doc.executor, completedTaskDisplayHours: value }))
      .toThrow("已完成任务显示时长");
    expect(doc).toEqual(before);
  });

  it("uses executor CAS and restores the display preference during history rollback", () => {
    const doc = settings();
    applySettingsBlockUpdate(doc, "executor", doc.revisions.executor, { ...doc.executor, completedTaskDisplayHours: null });
    expect(() => applySettingsBlockUpdate(doc, "executor", 1, { ...doc.executor, completedTaskDisplayHours: 6 }))
      .toThrow("已被其他操作更新");
    expect(doc.executor.completedTaskDisplayHours).toBeNull();
    rollbackSettingsToSnapshot(doc, doc.snapshots[0]!.revision, doc.globalRevision);
    expect(doc.executor.completedTaskDisplayHours).toBe(3);
  });

  it("persists the preference across a real hub restart", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-display-setting-"));
    directories.push(stateDir);
    const config = { stateDir, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false } };
    const hub = await openTestHub({ config });
    hubs.push(hub);
    const executor = hub.getSettingsView().blocks.executor;
    await hub.updateSettingsBlock("executor", executor.revision, { ...executor.value, completedTaskDisplayHours: null });
    await hub.close();
    hubs.splice(hubs.indexOf(hub), 1);
    const reopened = await openTestHub({ config });
    hubs.push(reopened);
    expect(reopened.getSettingsView().blocks.executor.value.completedTaskDisplayHours).toBeNull();
  });
});
