import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { KuloIdentityFiles } from "../packages/hub/src/identity-files.js";
import { applySettingsBlockUpdate, KuloSettingsDoc, rollbackSettingsToSnapshot } from "../packages/hub/src/settings.js";
import { KuloSkills, KuloSkillsDoc, type KuloSkillsOptions } from "../packages/hub/src/skills.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function temporaryDirectory(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-history-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function skillsFixture(retention?: KuloSkillsOptions["retention"]) {
  const directory = temporaryDirectory();
  const stateDir = path.join(directory, "state");
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
  const skills = new KuloSkills({ harness, stateDir, retention });
  await skills.initialize();
  const source = path.join(directory, "source");
  fs.mkdirSync(source);
  const write = (revision: number) => fs.writeFileSync(path.join(source, "SKILL.md"),
    `---\nname: retained-example\ndescription: A retained workflow.\n---\nRevision ${revision}\n`);
  write(0);
  const imported = await skills.manage({ action: "import", source, commandId: "import" });
  const record = imported.skills.find((entry) => entry.source === "local")!;
  const update = async (revision: number) => {
    write(revision);
    await skills.manage({ action: "update", id: record.id, commandId: `update-${revision}` });
    return (await skills.snapshot()).skills.find((entry) => entry.id === record.id)!;
  };
  const versionDirectory = (version: string) => path.join(stateDir, "skills", "packages", record.id, version);
  return { directory, stateDir, source, harness, skills, record, write, update, versionDirectory };
}

describe("bounded configuration and content history", () => {
  it("keeps repeated configuration rollback within the same 40-snapshot limit as saves", async () => {
    const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    cleanups.push(() => harness.close(BACKGROUND_CONTEXT));
    await harness.commit(async (tx) => { await tx.doc(KuloSettingsDoc); }, BACKGROUND_CONTEXT);
    const doc = JSON.parse(JSON.stringify(await harness.snapshot(KuloSettingsDoc, BACKGROUND_CONTEXT))) as import("../packages/hub/src/settings.js").KuloDurableSettings;
    for (let index = 0; index < 45; index++) applySettingsBlockUpdate(doc, "presentation", doc.revisions.presentation,
      { agentName: `Agent ${index}`, workbenchName: "Workbench" });
    expect(doc.snapshots).toHaveLength(40);
    for (let index = 0; index < 55; index++) {
      const target = doc.snapshots.at(-1)!;
      const expected = target.previousState.presentation.agentName;
      rollbackSettingsToSnapshot(doc, target.revision, doc.globalRevision);
      expect(doc.presentation.agentName).toBe(expected);
      expect(doc.snapshots).toHaveLength(40);
      expect(doc.snapshots.at(-1)!.revision).toBe(doc.globalRevision);
    }
    const revision = doc.globalRevision;
    expect(() => rollbackSettingsToSnapshot(doc, doc.snapshots.at(-1)!.revision, revision - 1)).toThrow("变动");
    expect(doc.globalRevision).toBe(revision);
  });

  it("prunes only owned identity backups, protects explicit references and does no pruning on reads or no-op saves", async () => {
    const directory = temporaryDirectory();
    const pinned: string[] = [];
    let pruningEvents = 0;
    const files = new KuloIdentityFiles(() => ({ directory, directoryRevision: 1 }), {
      retention: { maxBackups: 3, protectedBackupIds: () => { pruningEvents++; return pinned; } },
    });
    const initial = await files.read("relationship.md");
    expect(pruningEvents).toBe(0);
    let saved = await files.saveRelationship({ expected: initial.version, content: "Revision 0", summary: "Initial" });
    pinned.push(saved.backupId!);
    for (let revision = 1; revision < 7; revision++) {
      saved = await files.saveRelationship({ expected: saved.version, content: `Revision ${revision}`, summary: "Update" });
    }
    const backupDirectory = path.join(directory, "backups", "identity");
    const backups = fs.readdirSync(backupDirectory).filter((entry) => entry.endsWith(".bak"));
    expect(backups).toHaveLength(3);
    expect(backups).toContain(pinned[0]);
    expect(backups).toContain(saved.backupId);
    expect((await files.readBackup("relationship.md", pinned[0])).previouslyMissing).toBe(true);
    const events = pruningEvents;
    await files.read("relationship.md");
    const unchanged = await files.saveRelationship({ expected: saved.version, content: "Revision 6", summary: "No change" });
    expect(unchanged.unchanged).toBe(true);
    expect(pruningEvents).toBe(events);

    const outside = path.join(directory, "outside.txt");
    fs.writeFileSync(outside, "Keep this file.");
    const link = saved.backupId!.replace(/\.[a-f0-9]{32}\.bak$/, `.${"f".repeat(32)}.bak`);
    fs.symlinkSync(outside, path.join(backupDirectory, link));
    fs.writeFileSync(path.join(backupDirectory, "user-notes.txt"), "Unknown file.");
    const after = await files.saveRelationship({ expected: saved.version, content: "Revision 7", summary: "Update" });
    expect(after.backupId).toBeTruthy();
    expect(fs.lstatSync(path.join(backupDirectory, link)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("Keep this file.");
    expect(fs.readFileSync(path.join(backupDirectory, "user-notes.txt"), "utf8")).toBe("Unknown file.");
  });

  it("bounds identity backup bytes while preserving two recent recovery copies", async () => {
    const directory = temporaryDirectory();
    const files = new KuloIdentityFiles(() => ({ directory, directoryRevision: 1 }), { retention: { maxBytes: 6_000 } });
    let expected = (await files.read("relationship.md")).version;
    for (let revision = 0; revision < 7; revision++) {
      const saved = await files.saveRelationship({ expected, content: `${revision}`.padEnd(2_000, "x"), summary: "Update" });
      expected = saved.version;
    }
    const backupDirectory = path.join(directory, "backups", "identity");
    const entries = fs.readdirSync(backupDirectory);
    expect(entries.filter((entry) => entry.endsWith(".bak"))).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + fs.statSync(path.join(backupDirectory, entry)).size, 0)).toBeLessThanOrEqual(6_000);
  });

  it("retains leased Skill resources during updates and expires them after release", async () => {
    const f = await skillsFixture({ maxVersionsPerSkill: 3 });
    const release = f.skills.retainVersion(f.record.id, f.record.version);
    for (let revision = 1; revision < 7; revision++) await f.update(revision);
    expect(await f.skills.read(f.record.id, "SKILL.md", "worker", f.record.version)).toContain("Revision 0");
    const state = await f.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    expect(Object.keys(state!.skills[f.record.id]!.versions)).toHaveLength(4);
    release();
    release();
    await f.skills.manage({ action: "disable", id: f.record.id, commandId: "release-and-clean" });
    expect(fs.existsSync(f.versionDirectory(f.record.version))).toBe(false);
    const cleaned = await f.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    expect(Object.keys(cleaned!.skills[f.record.id]!.versions)).toHaveLength(3);
    expect(cleaned!.skills[f.record.id]!.order).not.toContain(f.record.version);
    await f.skills.manage({ action: "enable", id: f.record.id, commandId: "enable" });
    await expect(f.skills.read(f.record.id, "SKILL.md", "worker", f.record.version)).rejects.toMatchObject({ code: "skill_version_not_found" });
    const rolledBack = await f.skills.manage({ action: "rollback", id: f.record.id, commandId: "rollback" });
    expect(await f.skills.read(f.record.id, "SKILL.md", "worker")).toContain("Revision 5");
    expect(rolledBack.skills.find((entry) => entry.id === f.record.id)?.enabled).toBe(true);
  });

  it("keeps unknown files and symlinks instead of recursively removing a changed Skill snapshot", async () => {
    const f = await skillsFixture({ maxVersionsPerSkill: 4 });
    fs.writeFileSync(path.join(f.versionDirectory(f.record.version), "user-notes.txt"), "Keep unknown content.");
    const outside = path.join(f.directory, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "Keep outside content.");
    const unknownVersion = "f".repeat(64);
    fs.symlinkSync(outside, f.versionDirectory(unknownVersion));
    for (let revision = 1; revision < 6; revision++) await f.update(revision);
    const state = await f.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    expect(state!.skills[f.record.id]!.versions[f.record.version]).toBeUndefined();
    expect(state!.skills[f.record.id]!.retired?.[f.record.version]).toBeDefined();
    expect(fs.readFileSync(path.join(f.versionDirectory(f.record.version), "user-notes.txt"), "utf8")).toBe("Keep unknown content.");
    expect(fs.lstatSync(f.versionDirectory(unknownVersion)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("Keep outside content.");
  });

  it("releases fixed-version leases after failed resource reads", async () => {
    const f = await skillsFixture({ maxVersionsPerSkill: 3 });
    await expect(f.skills.readBytes(f.record.id, "missing.md", "worker", f.record.version)).rejects.toMatchObject({ code: "skill_resource_not_found" });
    for (let revision = 1; revision < 5; revision++) await f.update(revision);
    expect(fs.existsSync(f.versionDirectory(f.record.version))).toBe(false);
  });

  it("protects persistent Skill references and does not collect history during normal reads or unchanged initialization", async () => {
    const references: Array<{ id: string; version: string }> = [];
    let events = 0;
    const f = await skillsFixture({ maxVersionsPerSkill: 3, protectedVersions: () => { events++; return references; } });
    references.push({ id: f.record.id, version: f.record.version });
    for (let revision = 1; revision < 5; revision++) await f.update(revision);
    events = 0;
    await f.skills.snapshot();
    await f.skills.catalog("worker");
    await f.skills.read(f.record.id, "SKILL.md", "worker");
    await f.skills.initialize();
    expect(events).toBe(0);
    expect(await f.skills.read(f.record.id, "SKILL.md", "worker", f.record.version)).toContain("Revision 0");
  });

  it("rejects a new version when protected Skill content cannot fit and removes the uncommitted candidate", async () => {
    const f = await skillsFixture();
    const state = await f.harness.snapshot(KuloSkillsDoc, BACKGROUND_CONTEXT);
    const usedBytes = Object.values(state!.skills).reduce((sum, skill) => sum +
      Object.values(skill.versions).reduce((size, version) => size +
        Object.values(version.files).reduce((bytes, file) => bytes + file.size, 0), 0), 0);
    const limited = new KuloSkills({ harness: f.harness, stateDir: f.stateDir, retention: { maxTotalBytes: usedBytes + 1 } });
    await limited.initialize();
    const before = await limited.snapshot();
    f.write(1);
    await expect(limited.manage({ action: "update", id: f.record.id, commandId: "too-large" })).rejects.toMatchObject({ code: "skill_history_full" });
    expect(await limited.snapshot()).toEqual(before);
    expect(fs.readdirSync(path.dirname(f.versionDirectory(f.record.version)))).toEqual([f.record.version]);
    expect(await limited.read(f.record.id, "SKILL.md", "worker")).toContain("Revision 0");
  });
});
