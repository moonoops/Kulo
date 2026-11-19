import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { KuloSkills, KuloSkillsDoc } from "../packages/hub/src/skills.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-skills-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const onChanges: number[] = [];
  const stateDir = path.join(directory, "state");
  const skills = new KuloSkills({ harness, stateDir, onChanged: () => { onChanges.push(1); } });
  await skills.initialize();
  function source(name = "sample", contents = "# Sample\nOriginal instructions.") {
    const root = path.join(directory, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\ndescription: >-\n  A focused workflow\n  for a real task.\nmetadata:\n  kulo-audiences: worker\n  kulo-dependencies: node\n---\n${contents}\n`);
    return root;
  }
  return { skills, harness, directory, stateDir, source, onChanges };
}

describe("Kulo managed skills", () => {
  it("loads built-ins by audience and keeps configuration instructions available", async () => {
    const f = await fixture();
    expect((await f.skills.snapshot()).skills).toHaveLength(12);
    expect((await f.skills.catalog("settings")).map((skill) => skill.id)).toEqual(["capability-setup"]);
    expect((await f.skills.catalog("worker")).map((skill) => skill.id)).toEqual(["image-generation", "video-generation"]);
    await expect(f.skills.read("capability-setup", "SKILL.md", "chat")).rejects.toMatchObject({ status: 403 });
    expect(await f.skills.read("capability-setup", "SKILL.md", "settings")).toContain("kulo_capability_configure");
    await expect(f.skills.manage({ action: "disable", id: "capability-setup", commandId: "disable-setup" })).rejects.toMatchObject({ code: "required_skill" });
    await expect(f.skills.manage({ action: "remove", id: "image-generation", commandId: "remove-builtin" })).rejects.toMatchObject({ code: "builtin_skill_managed" });
    await f.skills.manage({ action: "disable", id: "image-generation", commandId: "disable-image" });
    expect((await f.skills.catalog("chat")).map((skill) => skill.id)).toEqual(["genui-cards", "video-generation"]);
    await expect(f.skills.read("image-generation")).rejects.toMatchObject({ status: 403 });
    await f.skills.initialize();
    expect((await f.skills.snapshot()).skills.find((skill) => skill.id === "image-generation")?.enabled).toBe(false);
  });

  it("imports a bounded snapshot and deduplicates commands without following the source", async () => {
    const f = await fixture();
    const source = f.source();
    fs.mkdirSync(path.join(source, "references"));
    fs.writeFileSync(path.join(source, "references", "guide.md"), "Version one reference.");
    fs.mkdirSync(path.join(source, "scripts"));
    fs.writeFileSync(path.join(source, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const revision = (await f.skills.snapshot()).revision;
    const request = { action: "import" as const, source, commandId: "import-one", expectedRevision: revision };
    const imported = await f.skills.manage(request);
    const skill = imported.skills.find((entry) => entry.source === "local")!;
    expect(skill.description).toBe("A focused workflow for a real task.");
    expect(skill.dependencies).toEqual(["node"]);
    expect(skill.audiences).toEqual(["worker"]);
    expect((await f.skills.resources(skill.id, "worker")).find((file) => file.path === "scripts/run.sh")?.executable).toBe(true);
    fs.writeFileSync(path.join(source, "references", "guide.md"), "Changed outside the managed snapshot.");
    expect(await f.skills.read(skill.id, "references/guide.md", "worker")).toBe("Version one reference.");
    expect((await f.skills.manage(request)).revision).toBe(imported.revision);
    expect(f.onChanges).toHaveLength(1);
    await expect(f.skills.manage({ ...request, audiences: ["chat"] })).rejects.toMatchObject({ code: "skill_command_conflict" });
    await expect(f.skills.read(skill.id, "SKILL.md", "settings")).rejects.toMatchObject({ status: 403 });
    const secondManager = new KuloSkills({ harness: f.harness, stateDir: f.stateDir });
    expect(await secondManager.read(skill.id, "references/guide.md", "worker", skill.version)).toBe("Version one reference.");
  });

  it("keeps existing versions on failed updates and can roll back successful updates", async () => {
    const f = await fixture();
    const source = f.source();
    const imported = await f.skills.manage({ action: "import", source, commandId: "import-update" });
    const first = imported.skills.find((entry) => entry.source === "local")!;
    const original = fs.readFileSync(path.join(source, "SKILL.md"), "utf8");
    fs.writeFileSync(path.join(source, "SKILL.md"), original.replace("Original instructions.", "Updated instructions."));
    const changed = await f.skills.manage({ action: "update", id: first.id, commandId: "update-one", expectedRevision: imported.revision });
    const second = changed.skills.find((entry) => entry.id === first.id)!;
    expect(second.version).not.toBe(first.version);
    expect(await f.skills.read(first.id, "SKILL.md", "worker")).toContain("Updated instructions.");
    expect(await f.skills.read(first.id, "SKILL.md", "worker", first.version)).toContain("Original instructions.");
    fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: invalid\n---\nMissing description.");
    await expect(f.skills.manage({ action: "update", id: first.id, commandId: "update-invalid" })).rejects.toMatchObject({ code: "invalid_skill" });
    expect((await f.skills.snapshot()).revision).toBe(changed.revision);
    expect(await f.skills.read(first.id, "SKILL.md", "worker")).toContain("Updated instructions.");
    const rolledBack = await f.skills.manage({ action: "rollback", id: first.id, commandId: "rollback-one" });
    expect(rolledBack.skills.find((entry) => entry.id === first.id)?.version).toBe(first.version);
    await f.skills.manage({ action: "remove", id: first.id, commandId: "remove-one" });
    expect((await f.skills.snapshot()).skills.find((entry) => entry.id === first.id)).toBeUndefined();
    await expect(f.skills.read(first.id, "SKILL.md", "worker", first.version)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects source symlinks, hidden credentials, traversal and changed snapshots", async () => {
    const f = await fixture();
    const source = f.source();
    const outside = path.join(f.directory, "outside.txt");
    fs.writeFileSync(outside, "outside-content");
    fs.symlinkSync(outside, path.join(source, "linked.md"));
    await expect(f.skills.manage({ action: "import", source, commandId: "symlink-import" })).rejects.toMatchObject({ code: "invalid_skill" });
    fs.unlinkSync(path.join(source, "linked.md"));
    fs.writeFileSync(path.join(source, ".env"), "PRIVATE=test-only-placeholder");
    await expect(f.skills.manage({ action: "import", source, commandId: "hidden-import" })).rejects.toMatchObject({ code: "invalid_skill" });
    fs.unlinkSync(path.join(source, ".env"));
    const result = await f.skills.manage({ action: "import", source, commandId: "safe-import" });
    const skill = result.skills.find((entry) => entry.source === "local")!;
    await expect(f.skills.read(skill.id, "../outside.txt", "worker")).rejects.toMatchObject({ status: 400 });
    await expect(f.skills.read(skill.id, "references\\outside.txt", "worker")).rejects.toMatchObject({ status: 400 });
    const managedFile = path.join(f.stateDir, "skills", "packages", skill.id, skill.version, "SKILL.md");
    const originalSize = fs.statSync(managedFile).size;
    fs.chmodSync(managedFile, 0o600);
    fs.writeFileSync(managedFile, Buffer.alloc(originalSize, "Z"));
    await expect(f.skills.read(skill.id, "SKILL.md", "worker")).rejects.toMatchObject({ code: "skill_resource_changed" });
    expect((await f.skills.snapshot()).skills).toHaveLength(13);
  });

  it("enforces package limits and revision checks for simultaneous management", async () => {
    const f = await fixture();
    const source = f.source();
    fs.writeFileSync(path.join(source, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(f.skills.manage({ action: "import", source, commandId: "oversized" })).rejects.toMatchObject({ status: 413 });
    fs.unlinkSync(path.join(source, "large.bin"));
    const revision = (await f.skills.snapshot()).revision;
    const results = await Promise.allSettled([
      f.skills.manage({ action: "disable", id: "image-generation", expectedRevision: revision, commandId: "competing-one" }),
      f.skills.manage({ action: "disable", id: "video-generation", expectedRevision: revision, commandId: "competing-two" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "skill_revision_conflict" } });
    await expect(f.skills.manage({ action: "import", source: "https://name:password@example.com/repo", commandId: "url-secret" })).rejects.toMatchObject({ status: 400 });
    await expect(f.skills.manage({ action: "import", source: "git:file:///tmp/anything", commandId: "file-protocol" })).rejects.toMatchObject({ status: 400 });
  });

  it("repairs the required setup skill when opening legacy or damaged metadata", async () => {
    const f = await fixture();
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(KuloSkillsDoc);
      state.skills["capability-setup"]!.record.enabled = false;
      state.skills["capability-setup"]!.record.audiences = ["chat"];
    }, BACKGROUND_CONTEXT);
    await f.skills.initialize();
    expect((await f.skills.catalog("settings")).map((entry) => entry.id)).toEqual(["capability-setup"]);
  });

  it("keeps explicit-only skills out of automatic selection without denying explicit reads", async () => {
    const f = await fixture();
    const source = f.source("manual");
    const filename = path.join(source, "SKILL.md");
    fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace("metadata:", "disable-model-invocation: true\nmetadata:"));
    const imported = await f.skills.manage({ action: "import", source, commandId: "import-manual" });
    const manual = imported.skills.find((entry) => entry.name === "manual")!;
    expect((await f.skills.catalog("worker")).some((entry) => entry.id === manual.id)).toBe(false);
    expect(await f.skills.read(manual.id, "SKILL.md", "worker")).toContain("Original instructions.");
  });

  it("restores imported versions and management receipts after reopening durable storage", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-skills-reopen-"));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const database = path.join(directory, "state.sqlite");
    const stateDir = path.join(directory, "private");
    const source = path.join(directory, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: restart-example\ndescription: Persistent imported skill.\n---\nA stable workflow.");
    const open = async () => {
      const harness = await Harness.open(await openNodeSqliteStorage(database), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
      let closed = false;
      const close = async () => { if (!closed) { closed = true; await harness.close(BACKGROUND_CONTEXT); } };
      cleanup.push(close);
      const skills = new KuloSkills({ harness, stateDir });
      await skills.initialize();
      return { skills, close };
    };
    const first = await open();
    const request = { action: "import" as const, source, commandId: "persistent-import" };
    const imported = await first.skills.manage(request);
    const record = imported.skills.find((entry) => entry.source === "local")!;
    await first.close();
    const second = await open();
    expect(await second.skills.read(record.id, "SKILL.md", "worker", record.version)).toContain("A stable workflow.");
    expect((await second.skills.manage(request)).revision).toBe(imported.revision);
  });

  it("resolves project sources again on update and disposes successful and failed imports", async () => {
    const f = await fixture();
    const seen: string[] = [];
    let disposed = 0;
    let content = "---\nname: project-skill\ndescription: Project skill.\n---\nVersion one.";
    const skills = new KuloSkills({ harness: f.harness, stateDir: f.stateDir, resolveLocalSource: async (source) => {
      seen.push(source);
      const staged = fs.mkdtempSync(path.join(f.directory, "staged-"));
      fs.writeFileSync(path.join(staged, "SKILL.md"), content);
      return { directory: staged, dispose: async () => { disposed++; fs.rmSync(staged, { recursive: true, force: true }); } };
    } });
    const source = "project://project-example/skills/project-skill";
    const imported = await skills.manage({ action: "import", source, commandId: "project-import" });
    const record = imported.skills.find((entry) => entry.name === "project-skill")!;
    expect(record.sourceUrl).toBe(source);
    expect(disposed).toBe(1);
    content = content.replace("Version one.", "Version two.");
    await skills.manage({ action: "update", id: record.id, commandId: "project-update" });
    expect(await skills.read(record.id, "SKILL.md", "worker")).toContain("Version two.");
    expect(seen).toEqual([source, source]);
    expect(disposed).toBe(2);
    content = "invalid metadata";
    await expect(skills.manage({ action: "update", id: record.id, commandId: "project-invalid" })).rejects.toMatchObject({ code: "invalid_skill" });
    expect(disposed).toBe(3);
    await expect(skills.manage({ action: "import", source: "project://project-example/../outside", commandId: "project-traversal" })).rejects.toMatchObject({ code: "invalid_skill" });
    expect(seen).toHaveLength(3);
  });
});
