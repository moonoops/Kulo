import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryManager, createReleaseManifest, readReleaseIdentity, readReleaseManifest, redactDiagnosticText, releaseIdentity, validateReleaseManifest, verifyRelease, writeReleaseManifest } from "../packages/recovery/src/index.js";
import { runRecoveryCli } from "../packages/recovery/src/bin.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true }))); });

function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-recovery-")));
  directories.push(directory);
  const dataDir = path.join(directory, "data");
  return { directory, dataDir, manager: new RecoveryManager(dataDir, { shellVersion: "test-shell", isProcessAlive: () => false }) };
}

async function payload(directory: string, version: string, text = version, options: { dataVersion?: number; minDataVersion?: number; maxDataVersion?: number; baseReleaseId?: string; shellVersion?: string; kind?: "custom" | "official"; sourceArchive?: string } = {}) {
  const root = path.join(directory, "payload-" + version);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "web", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "runtime.js"), "export const version = " + JSON.stringify(text) + ";\n");
  fs.writeFileSync(path.join(root, "web", "dist", "index.html"), "<main>" + text + "</main>");
  if (options.sourceArchive !== undefined) fs.writeFileSync(path.join(root, "kulo-source.json.gz"), options.sourceArchive);
  const { sourceArchive: _archive, ...manifestOptions } = options;
  const manifest = await createReleaseManifest(root, { version, kind: options.kind ?? "custom", shellVersion: options.shellVersion ?? "test-shell", checks: ["fixture:runtime-and-web"], ...manifestOptions });
  writeReleaseManifest(root, manifest);
  return { root, manifest };
}

async function start(manager: RecoveryManager) {
  const launch = await manager.prepareLaunch();
  await manager.markReady(launch.attemptId);
  await manager.markStopped(launch.attemptId);
  return launch;
}

describe("independent recovery manifests", () => {
  it("redacts quoted credential fields and complete authorization values", () => {
    const text = 'Authorization: Bearer never-store-header\n{"apiKey":"never-store-json","password":"never-store-password"}';
    expect(redactDiagnosticText(text)).not.toContain("never-store");
    expect(redactDiagnosticText("sourceTreeHash=" + "a".repeat(64))).toContain("a".repeat(64));
  });
  it("binds payload identity, excludes its own metadata and provides a compact launch identity", async () => {
    const f = fixture();
    const p = await payload(f.directory, "v1");
    expect(p.manifest.files).toHaveLength(2);
    expect(await createReleaseManifest(p.root, { version: "v1", kind: "custom", shellVersion: "test-shell", checks: ["fixture:runtime-and-web"] })).toEqual(p.manifest);
    expect(readReleaseManifest(p.root)).toEqual(p.manifest);
    expect(readReleaseIdentity(p.root)).toEqual(releaseIdentity(p.manifest));
    expect(readReleaseIdentity(p.root)).not.toHaveProperty("files");
    expect(readReleaseIdentity(p.root).entryFiles).toHaveLength(2);
  });

  it("round-trips and stages closed internal relative symlinks without changing the inventory digest", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "baseline");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    const candidate = await payload(f.directory, "linked");
    fs.mkdirSync(path.join(candidate.root, "packages", "tool"), { recursive: true });
    fs.mkdirSync(path.join(candidate.root, "node_modules"));
    fs.writeFileSync(path.join(candidate.root, "packages", "tool", "index.js"), "export const linked = true;\n");
    fs.symlinkSync("../packages/tool", path.join(candidate.root, "node_modules", "tool"), "dir");
    fs.symlinkSync("runtime.js", path.join(candidate.root, "dist", "runtime-link.js"), "file");
    const manifest = await createReleaseManifest(candidate.root, { version: "linked", kind: "custom", shellVersion: "test-shell" });
    expect(manifest.files.filter((entry) => entry.kind === "symlink")).toHaveLength(2);
    writeReleaseManifest(candidate.root, manifest);
    expect(readReleaseManifest(candidate.root)).toEqual(manifest);
    await verifyRelease(candidate.root, manifest);
    expect(await createReleaseManifest(candidate.root, { version: "linked", kind: "custom", shellVersion: "test-shell" })).toEqual(manifest);
    const staged = await f.manager.stageRelease(candidate.root, manifest, { schedule: true });
    expect(fs.readlinkSync(path.join(staged.root, "node_modules", "tool"))).toBe("../packages/tool");
    expect(fs.readlinkSync(path.join(staged.root, "dist", "runtime-link.js"))).toBe("runtime.js");
    expect(fs.readFileSync(path.join(staged.root, "node_modules", "tool", "index.js"), "utf8")).toContain("linked");
    await verifyRelease(staged.root, manifest);
  });

  it("normalizes JSON property order before checking file and symlink inventory digests", async () => {
    const f = fixture();
    const candidate = await payload(f.directory, "ordered");
    fs.symlinkSync("runtime.js", path.join(candidate.root, "dist", "runtime-link.js"), "file");
    const manifest = await createReleaseManifest(candidate.root, { version: "ordered", kind: "custom", shellVersion: "test-shell" });
    const reordered = JSON.parse(JSON.stringify(manifest, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(validateReleaseManifest(reordered)).toEqual(manifest);
    fs.writeFileSync(path.join(candidate.root, "kulo-release.json"), JSON.stringify(reordered));
    expect(readReleaseManifest(candidate.root)).toEqual(manifest);
    await verifyRelease(candidate.root, reordered);
  });

  it("rejects traversal, out-of-tree links, private root files and tampered payloads", async () => {
    const f = fixture();
    const p = await payload(f.directory, "v1");
    const edited = structuredClone(p.manifest);
    edited.files[0]!.path = "../private";
    expect(() => validateReleaseManifest(edited)).toThrow();
    fs.writeFileSync(path.join(p.root, "dist", "runtime.js"), "changed");
    await expect(verifyRelease(p.root, p.manifest)).rejects.toThrow("不一致");
    fs.symlinkSync(f.dataDir, path.join(p.root, "external"));
    fs.mkdirSync(f.dataDir);
    await expect(createReleaseManifest(p.root, { version: "v2", kind: "custom" })).rejects.toThrow("外部");
    fs.unlinkSync(path.join(p.root, "external"));
    fs.writeFileSync(path.join(p.root, ".env"), "DO_NOT_EXPORT=private");
    await expect(createReleaseManifest(p.root, { version: "v2", kind: "custom" })).rejects.toThrow("私有");
  });

  it("protects executable native helpers and records the exact source tree separately", async () => {
    const f = fixture();
    const p = await payload(f.directory, "v1");
    fs.writeFileSync(path.join(p.root, "dist", "helper"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const manifest = await createReleaseManifest(p.root, { version: "native", kind: "custom", shellVersion: "test-shell", sourceTreeHash: "a".repeat(64) });
    expect(manifest.files.find((entry) => entry.path === "dist/helper")?.executable).toBe(true);
    expect(releaseIdentity(manifest).sourceTreeHash).toBe("a".repeat(64));
    await f.manager.initializeBaseline(p.root, p.manifest);
    const stored = await f.manager.stageRelease(p.root, manifest);
    expect(fs.statSync(path.join(stored.root, "dist", "helper")).mode & 0o111).not.toBe(0);
    fs.chmodSync(path.join(p.root, "dist", "helper"), 0o644);
    await expect(verifyRelease(p.root, manifest)).rejects.toThrow("不一致");
    const incompatible = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", nodeMajor: manifest.nodeMajor + 1 });
    await expect(incompatible.schedule(stored.id)).rejects.toThrow("不兼容");
  });
});

describe("transactional low-attention version switching", () => {
  it("keeps a bundle baseline by reference, stages a separate payload and activates only on launch", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "v1");
    await f.manager.initializeBaseline(baseline.root, readReleaseIdentity(baseline.root));
    await start(f.manager);
    const next = await payload(f.directory, "v2", "custom-setting", { baseReleaseId: baseline.manifest.id });
    const staged = await f.manager.stageRelease(next.root, next.manifest, { schedule: true, expectedBaseId: baseline.manifest.id });
    expect(staged.managed).toBe(true);
    expect(staged.root).not.toBe(next.root);
    expect(fs.statSync(path.join(staged.root, "dist", "runtime.js")).mode & 0o222).toBe(0);
    let state = await f.manager.inspect();
    expect(state.current?.root).toBe(baseline.root);
    expect(state.storage.managedBytes).toBe(next.manifest.files.reduce((sum, file) => sum + file.size, 0));
    expect(state.pending?.id).toBe(next.manifest.id);
    const launch = await f.manager.prepareLaunch();
    expect(launch.releaseId).toBe(next.manifest.id);
    await f.manager.markReady(launch.attemptId);
    state = await f.manager.inspect();
    expect(state.current?.id).toBe(next.manifest.id);
    expect(state.pending).toBeNull();
    expect(state.history.map((record) => record.id)).toContain(baseline.manifest.id);
    await f.manager.markStopped(launch.attemptId);
    const restart = await f.manager.prepareLaunch();
    expect(restart.releaseId).toBe(next.manifest.id);
    await f.manager.markReady(restart.attemptId);
    await f.manager.markStopped(restart.attemptId);
  });

  it("isolates a failed candidate and recovers the original version without changing user data", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "v1");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    await start(f.manager);
    fs.mkdirSync(path.join(f.dataDir, "hub"), { recursive: true });
    const database = path.join(f.dataDir, "hub", "kulo.sqlite");
    fs.writeFileSync(database, "user-data-must-survive");
    const bad = await payload(f.directory, "v2");
    await f.manager.stageRelease(bad.root, bad.manifest, { schedule: true });
    const launch = await f.manager.prepareLaunch();
    const fallback = await f.manager.markFailed(launch.attemptId, new Error("api_key=never-show-this"));
    expect(fallback?.id).toBe(baseline.manifest.id);
    expect((await f.manager.inspect()).releases.find((record) => record.id === bad.manifest.id)?.status).toBe("failed");
    await expect(f.manager.schedule(bad.manifest.id)).rejects.toThrow("隔离");
    expect(fs.readFileSync(database, "utf8")).toBe("user-data-must-survive");
    expect(JSON.stringify(await f.manager.exportDiagnostics())).not.toContain("never-show-this");
    expect((await f.manager.prepareLaunch()).releaseId).toBe(baseline.manifest.id);
  });

  it("recovers an interrupted pre-ready launch and refuses a newer data format", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "v1");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    await start(f.manager);
    const next = await payload(f.directory, "v2");
    await f.manager.stageRelease(next.root, next.manifest, { schedule: true });
    await f.manager.prepareLaunch();
    const reopened = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", isProcessAlive: () => false });
    expect((await reopened.prepareLaunch()).releaseId).toBe(baseline.manifest.id);
    const catalog = path.join(f.dataDir, "recovery", "catalog.json");
    expect(fs.existsSync(catalog)).toBe(true);
    fs.mkdirSync(path.join(f.dataDir, "hub"), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, "hub", "state-version.json"), JSON.stringify({ version: 999, preparedAt: 0 }));
    await expect(reopened.rollback(baseline.manifest.id)).rejects.toThrow("不兼容");
    expect(JSON.parse(fs.readFileSync(path.join(f.dataDir, "hub", "state-version.json"), "utf8")).version).toBe(999);
  });

  it("blocks an obsolete candidate from replacing a concurrently queued update", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "v1");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    const next = await payload(f.directory, "v2");
    const old = await payload(f.directory, "v3");
    await f.manager.stageRelease(next.root, next.manifest, { schedule: true, expectedBaseId: baseline.manifest.id });
    await expect(f.manager.stageRelease(old.root, old.manifest, { schedule: true, expectedBaseId: baseline.manifest.id })).rejects.toThrow("已变化");
    expect((await f.manager.inspect()).pending?.id).toBe(next.manifest.id);
  });

  it("keeps a customized current payload when a new bundle baseline is registered", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "v1");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    const custom = await payload(f.directory, "custom");
    await f.manager.stageRelease(custom.root, custom.manifest, { schedule: true });
    await start(f.manager);
    const update = await payload(f.directory, "v2");
    await f.manager.initializeBaseline(update.root, update.manifest);
    expect((await f.manager.inspect()).current?.id).toBe(custom.manifest.id);
    expect((await f.manager.inspect()).pending).toBeNull();
  });

  it("queues a new built-in baseline when the user was using the previous baseline", async () => {
    const f = fixture();
    const a = await payload(f.directory, "v1");
    const b = await payload(f.directory, "v2");
    await f.manager.initializeBaseline(a.root, a.manifest);
    await start(f.manager);
    await f.manager.initializeBaseline(b.root, b.manifest);
    expect((await f.manager.inspect()).pending?.id).toBe(b.manifest.id);
  });
});

describe("offline agent rescue and history quotas", () => {
  it("refuses rollback while the desktop or an orphan backend is alive", async () => {
    const f = fixture();
    const a = await payload(f.directory, "v1");
    const active = new RecoveryManager(f.dataDir, { shellVersion: "test-shell" });
    await active.initializeBaseline(a.root, a.manifest);
    const launch = await active.prepareLaunch();
    await active.markReady(launch.attemptId);
    await expect(active.rollback(a.manifest.id)).rejects.toThrow("仍在运行");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
    try {
      await active.trackProcess(launch.attemptId, child.pid!);
      const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, "recovery", "catalog.json"), "utf8"));
      saved.session.pid = 2_000_000_000;
      fs.writeFileSync(path.join(f.dataDir, "recovery", "catalog.json"), JSON.stringify(saved));
      await expect(active.rollback(a.manifest.id)).rejects.toThrow("仍在运行");
    } finally { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
  });

  it("uses standalone commands without loading Hub and restores a non-default shell version", async () => {
    const f = fixture();
    const a = await payload(f.directory, "v1", "a", { shellVersion: "0.1.0" });
    const b = await payload(f.directory, "v2", "b", { shellVersion: "0.1.0" });
    const manager = new RecoveryManager(f.dataDir, { shellVersion: "0.1.0", isProcessAlive: () => false });
    await manager.initializeBaseline(a.root, a.manifest);
    await start(manager);
    await manager.stageRelease(b.root, b.manifest, { schedule: true });
    await start(manager);
    const command = await runRecoveryCli(["rollback", "--data-dir", f.dataDir, "--release", a.manifest.id, "--json"]);
    expect(command.exitCode).toBe(0);
    expect(JSON.parse(command.output).restored).toBe(a.manifest.id);
    const output = path.join(f.directory, "diagnostic.json");
    expect((await runRecoveryCli(["export", "--data-dir", f.dataDir, "--output", output, "--json"])).exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, "utf8")).inspection.current.id).toBe(a.manifest.id);
    expect((await manager.repairInstructions())).toContain("kulo-rescue");
  });

  it("keeps two history roots and current/pending while deleting only unreferenced managed payloads", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "v0");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    await start(f.manager);
    const staged: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const next = await payload(f.directory, "v" + i);
      staged.push(next.manifest.id);
      await f.manager.stageRelease(next.root, next.manifest, { schedule: true });
      await start(f.manager);
    }
    const state = await f.manager.inspect();
    expect(state.history).toHaveLength(2);
    const planned = await f.manager.gc({ dryRun: true });
    expect(planned.removed.length).toBeGreaterThan(0);
    expect((await f.manager.inspect()).releases).toHaveLength(6);
    const result = await f.manager.gc();
    expect(result.removed).toEqual(planned.removed);
    const after = await f.manager.inspect();
    expect(after.current?.id).toBe(staged.at(-1));
    expect(after.history).toHaveLength(2);
    expect(after.baseline?.root).toBe(baseline.root);
    expect(after.releases).toHaveLength(3);
    expect(after.storage.managedBytes).toBeLessThan(state.storage.managedBytes);
  });

  it("counts an older stable release within two history slots across offline rollbacks and garbage collection", async () => {
    const f = fixture();
    let now = Date.now();
    const manager = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", isProcessAlive: () => false, now: () => now });
    const baseline = await payload(f.directory, "native-v0");
    const stable = await payload(f.directory, "stable-v1");
    await manager.initializeBaseline(baseline.root, baseline.manifest);
    await start(manager);
    await manager.stageRelease(stable.root, stable.manifest, { schedule: true });
    for (let i = 0; i < 2; i++) {
      const launch = await manager.prepareLaunch();
      await manager.markReady(launch.attemptId);
      now += 12 * 60 * 60 * 1000;
      await manager.markStopped(launch.attemptId);
    }
    const recent: string[] = [];
    for (let i = 2; i <= 4; i++) {
      const next = await payload(f.directory, "rapid-v" + i);
      recent.push(next.manifest.id);
      await manager.stageRelease(next.root, next.manifest, { schedule: true });
      await start(manager);
    }
    expect((await manager.inspect()).history.map((record) => record.id)).toEqual([recent[1], stable.manifest.id]);
    for (const id of recent) {
      await manager.rollback(id);
      const state = await manager.inspect();
      expect(state.current?.id).toBe(id);
      expect(state.history).toHaveLength(2);
      expect(state.history.map((record) => record.id)).toContain(stable.manifest.id);
      expect(state.protectedReleaseIds.filter((protectedId) => protectedId !== baseline.manifest.id && protectedId !== id).sort())
        .toEqual(state.history.map((record) => record.id).sort());
    }
    const state = await manager.inspect();
    const obsolete = recent.filter((id) => id !== state.current?.id && !state.history.some((record) => record.id === id));
    expect(obsolete).toHaveLength(1);
    expect((await manager.gc()).removed).toEqual(obsolete);
    const retained = await manager.inspect();
    expect(retained.releases).toHaveLength(4);
    expect(retained.history.map((record) => record.id)).toContain(stable.manifest.id);
    for (const id of obsolete) expect(fs.existsSync(path.join(f.dataDir, "versions", id))).toBe(false);
    const restore = retained.history.find((record) => record.id !== stable.manifest.id)!;
    await manager.rollback(restore.id);
    expect((await start(manager)).releaseId).toBe(restore.id);
    expect((await manager.inspect()).history.map((record) => record.id)).toContain(stable.manifest.id);
  });

  it("enforces budget without modifying the active version or retaining a partial candidate", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "v1");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    const tiny = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", maxStorageBytes: 1 });
    const next = await payload(f.directory, "v2");
    await expect(tiny.stageRelease(next.root, next.manifest, { schedule: true })).rejects.toThrow("空间");
    expect((await tiny.inspect()).current?.id).toBe(baseline.manifest.id);
    expect(fs.readdirSync(path.join(f.dataDir, "versions"))).toEqual([]);
  });

  it("does not write files during a read-only inspection and can read a previous valid catalog", async () => {
    const f = fixture();
    expect((await f.manager.inspect()).initialized).toBe(false);
    expect(fs.existsSync(f.dataDir)).toBe(false);
    const baseline = await payload(f.directory, "v1");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    await start(f.manager);
    fs.writeFileSync(path.join(f.dataDir, "recovery", "catalog.json"), "{broken");
    const state = await f.manager.inspect();
    expect(state.initialized).toBe(true);
    expect(state.warnings).toHaveLength(1);
    await expect(f.manager.rollback(baseline.manifest.id)).rejects.toThrow("索引损坏");
    expect(fs.readFileSync(path.join(f.dataDir, "recovery", "catalog.json"), "utf8")).toBe("{broken");
  });

  it("keeps dry-run GC read-only for a new instance", async () => {
    const f = fixture();
    expect(await f.manager.gc({ dryRun: true })).toEqual({ removed: [], reclaimedBytes: 0 });
    expect(fs.existsSync(f.dataDir)).toBe(false);
  });

  it("collects a failed transaction target while retaining its completed diagnostic record", async () => {
    const f = fixture();
    const a = await payload(f.directory, "v1");
    await f.manager.initializeBaseline(a.root, a.manifest);
    await start(f.manager);
    const b = await payload(f.directory, "v2");
    await f.manager.stageRelease(b.root, b.manifest, { schedule: true });
    const launch = await f.manager.prepareLaunch();
    await f.manager.markFailed(launch.attemptId, new Error("failed-entry"));
    expect((await f.manager.gc()).removed).toContain(b.manifest.id);
    const state = await new RecoveryManager(f.dataDir).inspect();
    expect(state.warnings).toEqual([]);
    expect(state.transaction?.target).toBe(b.manifest.id);
    expect(state.releases.map((entry) => entry.id)).not.toContain(b.manifest.id);
  });

  it("prunes unreferenced external metadata without deleting external packages", async () => {
    const f = fixture();
    const packages: string[] = [];
    for (let i = 0; i < 8; i++) {
      const next = await payload(f.directory, "v" + i);
      packages.push(next.root);
      await f.manager.initializeBaseline(next.root, next.manifest);
    }
    const result = await f.manager.gc();
    expect(result.removed.length).toBeGreaterThan(0);
    expect((await f.manager.inspect()).releases.length).toBeLessThan(8);
    expect(packages.every((root) => fs.existsSync(path.join(root, "dist", "runtime.js")))).toBe(true);
  });

  it("cleans a renamed installation after a failed catalog commit and permits a retry", async () => {
    const f = fixture();
    const a = await payload(f.directory, "v1");
    const b = await payload(f.directory, "v2");
    await f.manager.initializeBaseline(a.root, a.manifest);
    const rename = fs.renameSync;
    let failed = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!failed && String(to) === path.join(f.dataDir, "recovery", "catalog.json")) {
        failed = true;
        throw Object.assign(new Error("disk-full"), { code: "ENOSPC" });
      }
      return rename(from, to);
    });
    await expect(f.manager.stageRelease(b.root, b.manifest, { schedule: true })).rejects.toThrow("disk-full");
    vi.restoreAllMocks();
    expect(fs.existsSync(path.join(f.dataDir, "versions", b.manifest.id))).toBe(false);
    expect((await f.manager.inspect()).pending).toBeNull();
    expect((await f.manager.stageRelease(b.root, b.manifest, { schedule: true })).id).toBe(b.manifest.id);
  });

  it("replays owned deletion intents after a crash between catalog removal and payload deletion", async () => {
    const f = fixture();
    const a = await payload(f.directory, "v1");
    const b = await payload(f.directory, "v2");
    await f.manager.initializeBaseline(a.root, a.manifest);
    await f.manager.stageRelease(b.root, b.manifest);
    const orphan = path.join(f.dataDir, "versions", b.manifest.id);
    const remove = fsp.rm;
    vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      if (String(target) === orphan) throw Object.assign(new Error("interrupted-delete"), { code: "EIO" });
      return remove(target, options);
    });
    await expect(f.manager.gc()).rejects.toThrow("interrupted-delete");
    vi.restoreAllMocks();
    expect(fs.existsSync(orphan)).toBe(true);
    expect((await f.manager.inspect()).releases.map((record) => record.id)).not.toContain(b.manifest.id);
    const reopened = new RecoveryManager(f.dataDir, { shellVersion: "test-shell" });
    await reopened.gc();
    expect(fs.existsSync(orphan)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(f.dataDir, "recovery", "file-intents.json"), "utf8"))).toEqual([]);
  });

  it("cleans unreferenced managed payloads before rejecting a storage budget", async () => {
    const f = fixture();
    const a = await payload(f.directory, "v1");
    const b = await payload(f.directory, "v2");
    const c = await payload(f.directory, "v3");
    await f.manager.initializeBaseline(a.root, a.manifest);
    await f.manager.stageRelease(b.root, b.manifest);
    const budget = c.manifest.files.reduce((sum, file) => sum + file.size, 0);
    const manager = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", maxStorageBytes: budget });
    expect((await manager.stageRelease(c.root, c.manifest, { schedule: true })).id).toBe(c.manifest.id);
    expect((await manager.inspect()).releases.map((record) => record.id)).not.toContain(b.manifest.id);
    expect(fs.existsSync(path.join(f.dataDir, "versions", b.manifest.id))).toBe(false);
  });

  it("replays a failed install cleanup after rename without deleting unknown directories", async () => {
    const f = fixture();
    const a = await payload(f.directory, "v1");
    const b = await payload(f.directory, "v2");
    await f.manager.initializeBaseline(a.root, a.manifest);
    const orphan = path.join(f.dataDir, "versions", b.manifest.id);
    const rename = fs.renameSync;
    const remove = fsp.rm;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(f.dataDir, "recovery", "catalog.json")) throw Object.assign(new Error("interrupted-install"), { code: "ENOSPC" });
      return rename(from, to);
    });
    vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      if (String(target) === orphan) throw Object.assign(new Error("interrupted-cleanup"), { code: "EIO" });
      return remove(target, options);
    });
    await expect(f.manager.stageRelease(b.root, b.manifest, { schedule: true })).rejects.toThrow();
    vi.restoreAllMocks();
    expect(fs.existsSync(orphan)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(f.dataDir, "recovery", "file-intents.json"), "utf8"))).toHaveLength(1);
    const unknown = path.join(f.dataDir, "versions", "user-files");
    fs.mkdirSync(unknown);
    fs.writeFileSync(path.join(unknown, "keep.txt"), "keep");
    const reopened = new RecoveryManager(f.dataDir, { shellVersion: "test-shell" });
    await reopened.gc();
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readFileSync(path.join(unknown, "keep.txt"), "utf8")).toBe("keep");
    expect((await reopened.stageRelease(b.root, b.manifest, { schedule: true })).id).toBe(b.manifest.id);
  });

  it("coordinates native backup maintenance under the same offline mutation lock", async () => {
    const f = fixture();
    const a = await payload(f.directory, "v1");
    const manager = new RecoveryManager(f.dataDir, { shellVersion: "test-shell" });
    await manager.initializeBaseline(a.root, a.manifest);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const maintenance = manager.withOfflineMaintenance(async (records) => {
      expect(records.map((record) => record.id)).toContain(a.manifest.id);
      entered();
      await gate;
    });
    await started;
    const other = new RecoveryManager(f.dataDir, { shellVersion: "test-shell" });
    try { await expect(other.schedule(a.manifest.id)).rejects.toThrow("正在进行"); }
    finally { release(); await maintenance; }
  });

  it("protects the actual official source base across repeated custom revisions and releases it when unused", async () => {
    const f = fixture();
    const native = await payload(f.directory, "native-v1");
    await f.manager.initializeBaseline(native.root, native.manifest);
    await start(f.manager);
    const official = await payload(f.directory, "official-v2", "official-v2", { kind: "official", sourceArchive: "only-v2-source" });
    const storedOfficial = await f.manager.stageRelease(official.root, official.manifest, { schedule: true });
    await start(f.manager);
    const a = await payload(f.directory, "custom-a", "a", { baseReleaseId: official.manifest.id });
    const b = await payload(f.directory, "custom-b", "b", { baseReleaseId: official.manifest.id });
    await f.manager.stageRelease(a.root, a.manifest, { schedule: true });
    await start(f.manager);
    await f.manager.stageRelease(b.root, b.manifest, { schedule: true });
    await start(f.manager);
    expect((await f.manager.inspect()).history.map((record) => record.id)).not.toContain(official.manifest.id);
    expect(await f.manager.protectedReleaseIds()).toContain(official.manifest.id);
    expect((await f.manager.gc()).removed).not.toContain(official.manifest.id);
    expect(fs.readFileSync(path.join(storedOfficial.root, "kulo-source.json.gz"), "utf8")).toBe("only-v2-source");
    const c = await payload(f.directory, "custom-c", "c", { baseReleaseId: official.manifest.id });
    await f.manager.stageRelease(c.root, c.manifest, { schedule: true });
    await start(f.manager);
    expect((await f.manager.gc()).removed).toContain(a.manifest.id);
    expect((await f.manager.inspect()).releases.map((record) => record.id)).toContain(official.manifest.id);

    const newer = await payload(f.directory, "official-v3", "official-v3", { kind: "official", sourceArchive: "v3-source" });
    await f.manager.stageRelease(newer.root, newer.manifest, { schedule: true });
    await start(f.manager);
    const d = await payload(f.directory, "custom-d", "d", { baseReleaseId: newer.manifest.id });
    await f.manager.stageRelease(d.root, d.manifest, { schedule: true });
    await start(f.manager);
    expect((await f.manager.gc()).removed).toContain(official.manifest.id);
    expect(fs.existsSync(storedOfficial.root)).toBe(false);
    expect((await f.manager.inspect()).releases.map((record) => record.id)).toContain(newer.manifest.id);
  });

  it("protects an external source base's metadata even when it is not the current native baseline", async () => {
    const f = fixture();
    const native = await payload(f.directory, "native-v1");
    const source = await payload(f.directory, "source-v2", "v2", { kind: "official", sourceArchive: "external-v2-source" });
    const nextNative = await payload(f.directory, "native-v3");
    await f.manager.initializeBaseline(native.root, native.manifest);
    await start(f.manager);
    await f.manager.initializeBaseline(source.root, source.manifest);
    await f.manager.initializeBaseline(nextNative.root, nextNative.manifest);
    for (const version of ["custom-a", "custom-b"]) {
      const custom = await payload(f.directory, version, version, { baseReleaseId: source.manifest.id });
      await f.manager.stageRelease(custom.root, custom.manifest, { schedule: true });
      await start(f.manager);
    }
    expect((await f.manager.inspect()).history.map((record) => record.id)).not.toContain(source.manifest.id);
    await f.manager.gc();
    expect((await f.manager.inspect()).baseline?.id).toBe(nextNative.manifest.id);
    expect((await f.manager.inspect()).releases.find((record) => record.id === source.manifest.id)?.managed).toBe(false);
    expect(await f.manager.protectedReleaseIds()).toContain(source.manifest.id);
  });

  it("protects a new custom candidate's base while automatically clearing budget", async () => {
    const f = fixture();
    const native = await payload(f.directory, "native-v1");
    const source = await payload(f.directory, "official-v2", "v2", { kind: "official", sourceArchive: "required-v2-source" });
    const unused = await payload(f.directory, "unused");
    const custom = await payload(f.directory, "custom-a", "a", { baseReleaseId: source.manifest.id });
    await f.manager.initializeBaseline(native.root, native.manifest);
    await f.manager.stageRelease(source.root, source.manifest);
    await f.manager.stageRelease(unused.root, unused.manifest);
    const bytes = [...source.manifest.files, ...custom.manifest.files].reduce((total, file) => total + file.size, 0);
    const limited = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", maxStorageBytes: bytes });
    await limited.stageRelease(custom.root, custom.manifest, { schedule: true });
    const state = await limited.inspect();
    expect(state.releases.map((record) => record.id)).toContain(source.manifest.id);
    expect(state.releases.map((record) => record.id)).not.toContain(unused.manifest.id);
  });

  it("reports a missing custom source base without substituting the bundled native version", async () => {
    const f = fixture();
    const native = await payload(f.directory, "native-v1");
    await f.manager.initializeBaseline(native.root, native.manifest);
    const missing = "release_" + "f".repeat(24);
    const invalid = await payload(f.directory, "missing-base", "missing", { baseReleaseId: missing });
    await expect(f.manager.stageRelease(invalid.root, invalid.manifest, { schedule: true })).rejects.toMatchObject({ code: "missing_base_release" });
    const source = await payload(f.directory, "official-v2", "v2", { kind: "official", sourceArchive: "v2-source" });
    await f.manager.stageRelease(source.root, source.manifest);
    for (const version of ["custom-a", "custom-b"]) {
      const custom = await payload(f.directory, version, version, { baseReleaseId: source.manifest.id });
      await f.manager.stageRelease(custom.root, custom.manifest, { schedule: true });
      await start(f.manager);
    }
    const before = await f.manager.inspect();
    const catalogPath = path.join(f.dataDir, "recovery", "catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    delete catalog.releases[source.manifest.id];
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    const state = await f.manager.inspect();
    expect(state.current?.id).toBe(before.current?.id);
    expect(state.warnings.some((warning) => warning.includes(source.manifest.id) && warning.includes("缺失"))).toBe(true);
    await expect(f.manager.gc()).rejects.toMatchObject({ code: "missing_base_release" });
    await expect(f.manager.protectedReleaseIds()).rejects.toMatchObject({ code: "missing_base_release" });
    expect((await f.manager.inspect()).current?.id).not.toBe(native.manifest.id);
  });

  it("rejects a new data write format even when its declared read range includes the current database", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "native-v2");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    fs.mkdirSync(path.join(f.dataDir, "hub"), { recursive: true });
    const marker = path.join(f.dataDir, "hub", "state-version.json");
    const database = path.join(f.dataDir, "hub", "kulo.sqlite");
    const markerText = JSON.stringify({ version: 2, preparedAt: 123 });
    fs.writeFileSync(marker, markerText);
    fs.writeFileSync(database, "preserve-format-2-data");
    const incoming = await payload(f.directory, "official-v3", "v3", { kind: "official", dataVersion: 3, minDataVersion: 2, maxDataVersion: 3 });
    await expect(f.manager.stageRelease(incoming.root, incoming.manifest, { schedule: true })).rejects.toMatchObject({ code: "incompatible_release" });
    expect((await f.manager.inspect()).current?.id).toBe(baseline.manifest.id);
    expect((await f.manager.inspect()).pending).toBeNull();
    expect(fs.readFileSync(marker, "utf8")).toBe(markerText);
    expect(fs.readFileSync(database, "utf8")).toBe("preserve-format-2-data");
  });

  it("blocks legacy staged cross-format payloads through scheduling, CLI rollback and automatic launch", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "native-v2");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    fs.mkdirSync(path.join(f.dataDir, "hub"), { recursive: true });
    const marker = path.join(f.dataDir, "hub", "state-version.json");
    const incoming = await payload(f.directory, "official-v3", "v3", { kind: "official", dataVersion: 3, minDataVersion: 2, maxDataVersion: 3 });
    fs.writeFileSync(marker, JSON.stringify({ version: 3, preparedAt: 0 }));
    const oldHost = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", dataVersion: 3, isProcessAlive: () => false });
    await oldHost.stageRelease(incoming.root, incoming.manifest);
    const markerText = JSON.stringify({ version: 2, preparedAt: 456 });
    fs.writeFileSync(marker, markerText);
    await expect(f.manager.schedule(incoming.manifest.id)).rejects.toMatchObject({ code: "incompatible_release" });
    await expect(f.manager.rollback(incoming.manifest.id)).rejects.toMatchObject({ code: "incompatible_release" });
    const command = await runRecoveryCli(["rollback", "--data-dir", f.dataDir, "--release", incoming.manifest.id, "--json"]);
    expect(command.exitCode).toBe(1);
    expect(JSON.parse(command.output).error.code).toBe("incompatible_release");
    expect((await f.manager.inspect()).warnings.some((warning) => warning.includes(incoming.manifest.id) && warning.includes("写入格式为 3"))).toBe(true);
    const catalogPath = path.join(f.dataDir, "recovery", "catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.pending = incoming.manifest.id;
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    const launch = await f.manager.prepareLaunch();
    expect(launch.releaseId).toBe(baseline.manifest.id);
    expect(launch.recovered).toBe(true);
    await f.manager.markReady(launch.attemptId);
    await f.manager.markStopped(launch.attemptId);
    expect(fs.readFileSync(marker, "utf8")).toBe(markerText);
  });

  it("does not let old code write a newer database even when its read range includes that format", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "native-v2", "v2", { dataVersion: 2, minDataVersion: 2, maxDataVersion: 3 });
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    fs.mkdirSync(path.join(f.dataDir, "hub"), { recursive: true });
    const marker = path.join(f.dataDir, "hub", "state-version.json");
    fs.writeFileSync(marker, JSON.stringify({ version: 3, preparedAt: 0 }));
    await expect(f.manager.prepareLaunch()).rejects.toMatchObject({ code: "incompatible_release" });
    const state = await f.manager.inspect();
    expect(state.warnings.some((warning) => warning.includes("磁盘为 3") && warning.includes("写入格式为 2"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).version).toBe(3);
  });

  it("retries an unchanged sole baseline once after an unknown pre-ready interruption", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "native-v1");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    await f.manager.prepareLaunch();
    const reopened = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", isProcessAlive: () => false });
    const launch = await reopened.prepareLaunch();
    expect(launch.releaseId).toBe(baseline.manifest.id);
    expect((await reopened.inspect()).current?.status).toBe("baseline");
    expect((await reopened.inspect()).current?.startupInterruptions).toBe(1);
    await reopened.markReady(launch.attemptId);
    await reopened.markStopped(launch.attemptId);
    expect((await reopened.inspect()).current?.startupInterruptions).toBe(0);
  });

  it("persists a bounded interruption budget without poisoning the only baseline or its rescue path", async () => {
    const f = fixture();
    const baseline = await payload(f.directory, "native-v1");
    await f.manager.initializeBaseline(baseline.root, baseline.manifest);
    await f.manager.prepareLaunch();
    const second = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", isProcessAlive: () => false });
    await second.prepareLaunch();
    const third = new RecoveryManager(f.dataDir, { shellVersion: "test-shell", isProcessAlive: () => false });
    await expect(third.prepareLaunch()).rejects.toMatchObject({ code: "startup_recovery_exhausted" });
    expect((await third.inspect()).session).toBeNull();
    expect((await third.inspect()).current?.status).toBe("baseline");
    expect((await third.inspect()).current?.startupInterruptions).toBe(2);
    await expect(third.prepareLaunch()).rejects.toMatchObject({ code: "startup_recovery_exhausted" });
    const reset = await runRecoveryCli(["safe-mode", "--data-dir", f.dataDir, "--json"]);
    expect(reset.exitCode).toBe(0);
    expect((await third.inspect()).current?.startupInterruptions).toBe(0);
    const launch = await third.prepareLaunch();
    await third.markReady(launch.attemptId);
    await third.markStopped(launch.attemptId);
  });
});
