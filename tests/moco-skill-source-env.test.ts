import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileError, type BinaryReader, type DirReader, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import type { EnvManager } from "@moco/env";
import type { ProjectRecord } from "@moco/protocol";
import type { MocoProjects } from "../packages/hub/src/projects.js";
import { stageProjectSkillSource } from "../packages/hub/src/skill-source-env.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(platform: "darwin" | "win32" = "darwin") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-skill-env-"));
  directories.push(directory);
  const paths = platform === "win32" ? path.win32 : path.posix;
  const root = platform === "win32" ? "C:\\Projects\\demo" : "/remote-projects/demo";
  const scratchRoot = platform === "win32" ? "C:\\Moco\\scratch" : "/remote-moco/scratch";
  const project: ProjectRecord = { id: "project-a", name: "示例", deviceId: "remote-node", workspaceDir: root, directoryId: "remote-directory", revision: 4, grantRevision: 6, notes: "", platform, scratchRoot, createdAt: 1, updatedAt: 1 };
  interface Entry { kind: string; bytes: Uint8Array; size: number; mtimeMs: number }
  const entries = new Map<string, Entry>();
  const links = new Map<string, string>();
  const reads: Array<{ file: string; offset: number; length: number }> = [];
  const opens: Array<{ file: string; noFollow?: boolean }> = [];
  const fileCloses: string[] = [];
  const directoryCloses: string[] = [];
  let online = true;
  let onRead: (() => void) | undefined;
  let cleanupPending = false;
  const absolute = (value: string) => paths.resolve(root, value);
  const canonical = (value: string) => {
    const resolved = absolute(value);
    for (const [from, to] of links) if (resolved === from || resolved.startsWith(`${from}${paths.sep}`)) return `${to}${resolved.slice(from.length)}`;
    return resolved;
  };
  const addDirectory = (relative: string) => {
    const target = absolute(relative);
    const parents: string[] = [];
    for (let item = target; item !== paths.dirname(item); item = paths.dirname(item)) {
      parents.push(item);
      if (item === root) break;
    }
    for (const item of parents) if (!entries.has(item)) entries.set(item, { kind: "directory", bytes: new Uint8Array(), size: 0, mtimeMs: 10 });
    return target;
  };
  const addFile = (relative: string, bytes: Uint8Array | string = "resource") => {
    const target = absolute(relative);
    addDirectory(paths.relative(root, paths.dirname(target)));
    const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    entries.set(target, { kind: "file", bytes: data, size: data.length, mtimeMs: 10 });
    return target;
  };
  addDirectory(".");
  addFile("skills/demo/SKILL.md", "---\nname: remote-demo\ndescription: remote bytes\n---\nUse remote data.");
  addFile("skills/demo/references/details.md", "remote reference");
  const info = (target: string): FileInfo => {
    const entry = entries.get(absolute(target));
    if (!entry) throw new FileError("not_found", "remote entry missing", target);
    return { name: paths.basename(target), path: absolute(target), kind: entry.kind as FileInfo["kind"], size: entry.size, mtimeMs: entry.mtimeMs };
  };
  const env = {
    id: "remote-node", cwd: root,
    absolutePath: async (value: string) => ({ ok: true as const, value: absolute(value) }),
    joinPath: async (parts: string[]) => ({ ok: true as const, value: paths.join(...parts) }),
    canonicalPath: async (value: string) => ({ ok: true as const, value: canonical(value) }),
    fileInfo: async (value: string) => { try { return { ok: true as const, value: info(value) }; } catch (error) { return { ok: false as const, error: error as FileError }; } },
    openBinaryReader: async (value: string, options?: { noFollow?: boolean }) => {
      opens.push({ file: value, noFollow: options?.noFollow });
      const reader: Pick<BinaryReader, "info" | "read" | "close"> = {
        info: async () => ({ ok: true, value: info(value) }),
        read: async (offset, length) => {
          reads.push({ file: value, offset, length });
          const chunk = entries.get(value)!.bytes.subarray(offset, offset + length);
          onRead?.();
          return { ok: true, value: chunk };
        },
        close: async () => { fileCloses.push(value); },
      };
      return { ok: true as const, value: reader as BinaryReader };
    },
    openDirReader: async (value: string) => {
      const children = [...entries.keys()].filter((item) => item !== value && paths.dirname(item) === value).sort().map((target) => info(target));
      let offset = 0;
      const reader: DirReader = {
        next: async (max) => {
          const page = children.slice(offset, offset + max);
          offset += page.length;
          return { ok: true, value: { entries: page, done: offset >= children.length } };
        },
        close: async () => { directoryCloses.push(value); },
      };
      return { ok: true as const, value: reader };
    },
  } as unknown as ExecutionEnv;
  const manager = {
    getEnvDescriptor: vi.fn(() => ({ id: "remote-node", name: "Remote", online, platform, rootDir: "/remote-moco", capabilities: ["worker-isolation"] })),
    createWorkerExecutionEnv: vi.fn(() => env),
    releaseWorkerExecutionEnv: vi.fn(async () => ({ cleanupPending })),
  };
  const projects = {
    ensureAuthorized: vi.fn(async () => ({ ...project })),
    get: vi.fn(async () => ({ ...project })),
  };
  const options = { stateDir: directory, projects: projects as unknown as MocoProjects, envManager: manager as unknown as EnvManager };
  const stage = (source = "project://project-a/skills/demo") => stageProjectSkillSource(options, source);
  const stagedDirectories = () => fs.existsSync(path.join(directory, "skill-source-staging")) ? fs.readdirSync(path.join(directory, "skill-source-staging")) : [];
  return { directory, root, scratchRoot, project, paths, entries, links, reads, opens, fileCloses, directoryCloses, manager, projects, options, env, addFile, addDirectory, stage, stagedDirectories,
    setOnline: (value: boolean) => { online = value; },
    onRead: (callback: () => void) => { onRead = callback; },
    setCleanupPending: () => { cleanupPending = true; },
  };
}

describe("remote project Skill staging", () => {
  it.each(["darwin", "win32"] as const)("stages actual Env bytes through a read-only project execution (%s)", async (platform) => {
    const f = fixture(platform);
    const staged = await f.stage();
    expect(fs.readFileSync(path.join(staged.directory, "references/details.md"), "utf8")).toBe("remote reference");
    expect(f.projects.ensureAuthorized).toHaveBeenCalledWith("project-a", expect.anything());
    expect(f.manager.createWorkerExecutionEnv).toHaveBeenCalledWith("remote-node", f.root, expect.objectContaining({ projectId: "project-a", grantRevision: 6, readOnly: true, scratchDir: expect.stringContaining("skill-import-") }));
    const scratch = f.manager.createWorkerExecutionEnv.mock.calls[0]![2]!.scratchDir!;
    expect(f.paths.dirname(scratch)).toBe(f.scratchRoot);
    expect(f.opens.every((entry) => entry.noFollow)).toBe(true);
    expect(f.manager.releaseWorkerExecutionEnv).toHaveBeenCalledWith("remote-node", f.root, { scratchDir: scratch });
    expect(fs.statSync(staged.directory).mode & 0o077).toBe(0);
    await staged.dispose();
    await staged.dispose();
    expect(f.stagedDirectories()).toEqual([]);
  });

  it("allows explicitly selected standard project Skill roots without importing hidden parent data", async () => {
    const f = fixture();
    f.addFile(".agents/skills/standard/SKILL.md", "---\nname: standard\ndescription: standard\n---\nGuide");
    f.addFile(".agents/private-token", "must not read");
    const staged = await f.stage("project://project-a/.agents/skills/standard");
    expect(fs.readFileSync(path.join(staged.directory, "SKILL.md"), "utf8")).toContain("name: standard");
    expect(f.opens.map((entry) => entry.file)).not.toContain(f.paths.join(f.root, ".agents/private-token"));
    await staged.dispose();
  });

  it.each(["project://project-a/skills/../demo", "project://project-a/skills/%2E%2E/demo", "project://project-a/skills/%252e%252e/demo", "project://project-a/skills/%2fprivate", "project://project-a//private", "project://project-a/.private/demo", "project://project-a/.agents/not-skills/demo", "project://project-a/skills/demo?token=x", "project://project-a/skills/demo#secret", "file:///remote-projects/demo/skills/demo"])("rejects unsafe URI %s before authorizing a project", async (source) => {
    const f = fixture();
    await expect(f.stage(source)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(f.projects.ensureAuthorized).not.toHaveBeenCalled();
    expect(f.manager.createWorkerExecutionEnv).not.toHaveBeenCalled();
  });

  it.each([".env", "credentials.json", "token.json", "private.key"])("rejects sensitive package member %s and removes staged data", async (name) => {
    const f = fixture();
    f.addFile(`skills/demo/${name}`, "synthetic private data");
    await expect(f.stage()).rejects.toMatchObject({ code: "skill_source_denied" });
    expect(f.opens.some((entry) => entry.file.endsWith(name))).toBe(false);
    expect(f.stagedDirectories()).toEqual([]);
    expect(f.manager.releaseWorkerExecutionEnv).toHaveBeenCalledTimes(1);
  });

  it("rejects parent links, package links and special files without following them", async () => {
    for (const relative of ["skills", "skills/demo/references", "skills/demo/references/details.md"]) {
      const f = fixture();
      f.entries.get(f.paths.join(f.root, relative))!.kind = "symlink";
      f.links.set(f.paths.join(f.root, relative), "/private/other");
      await expect(f.stage()).rejects.toMatchObject({ code: "skill_source_denied" });
      expect(f.stagedDirectories()).toEqual([]);
      expect(f.manager.releaseWorkerExecutionEnv).toHaveBeenCalledTimes(1);
    }
    const f = fixture();
    f.entries.get(f.addFile("skills/demo/socket"))!.kind = "socket";
    await expect(f.stage()).rejects.toMatchObject({ code: "skill_source_denied" });
    expect(f.opens.some((entry) => entry.file.endsWith("socket"))).toBe(false);
  });

  it("reads bounded chunks, closes readers, and detects a file changed during a read", async () => {
    const f = fixture();
    f.addFile("skills/demo/assets/large.bin", Buffer.alloc(700_000, 1));
    const staged = await f.stage();
    const reads = f.reads.filter((entry) => entry.file.endsWith("large.bin"));
    expect(reads.map(({ offset, length }) => ({ offset, length }))).toEqual([{ offset: 0, length: 262_144 }, { offset: 262_144, length: 262_144 }, { offset: 524_288, length: 175_712 }]);
    expect(f.fileCloses).toHaveLength(f.opens.length);
    await staged.dispose();
    const changing = fixture();
    changing.onRead(() => { changing.entries.get(changing.paths.join(changing.root, "skills/demo/SKILL.md"))!.mtimeMs++; });
    await expect(changing.stage()).rejects.toMatchObject({ code: "skill_source_changed" });
    expect(changing.fileCloses).toHaveLength(changing.opens.length);
    expect(changing.stagedDirectories()).toEqual([]);
  });

  it("rejects a canonical path swap before opening the file", async () => {
    const f = fixture();
    const file = f.paths.join(f.root, "skills/demo/SKILL.md");
    f.links.set(file, "/private/secret-file");
    await expect(f.stage()).rejects.toMatchObject({ code: "skill_source_changed" });
    expect(f.opens.map((entry) => entry.file)).not.toContain(file);
    expect(f.stagedDirectories()).toEqual([]);
  });

  it("rejects oversized files, packages and excessive file counts", async () => {
    const single = fixture();
    single.entries.get(single.addFile("skills/demo/oversize.bin"))!.size = 4 * 1024 * 1024 + 1;
    await expect(single.stage()).rejects.toMatchObject({ code: "skill_source_too_large" });
    expect(single.stagedDirectories()).toEqual([]);
    const total = fixture();
    for (let index = 0; index < 5; index++) total.addFile(`skills/demo/part-${index}.bin`, Buffer.alloc(4 * 1024 * 1024, index));
    await expect(total.stage()).rejects.toMatchObject({ code: "skill_source_too_large" });
    expect(total.stagedDirectories()).toEqual([]);
    const count = fixture();
    for (let index = 0; index < 512; index++) count.addFile(`skills/demo/part-${index}.txt`, "a");
    await expect(count.stage()).rejects.toMatchObject({ code: "skill_source_too_large" });
    expect(count.stagedDirectories()).toEqual([]);
  });

  it.each(["revision", "grantRevision", "deviceId", "directoryId"] as const)("rejects changed project binding %s and cleans the local stage", async (field) => {
    const f = fixture();
    let changed = false;
    f.onRead(() => {
      if (changed) return;
      changed = true;
      if (field === "revision" || field === "grantRevision") f.project[field]++;
      else f.project[field] = "changed";
    });
    await expect(f.stage()).rejects.toMatchObject({ code: "skill_source_changed" });
    expect(f.stagedDirectories()).toEqual([]);
    expect(f.manager.releaseWorkerExecutionEnv).toHaveBeenCalledTimes(1);
  });

  it("does not create an execution without scratch authorization and refuses unfinished cleanup", async () => {
    const f = fixture();
    f.project.scratchRoot = undefined;
    await expect(f.stage()).rejects.toMatchObject({ code: "skill_source_scratch_unavailable" });
    expect(f.manager.createWorkerExecutionEnv).not.toHaveBeenCalled();
    const cleanup = fixture();
    cleanup.setCleanupPending();
    await expect(cleanup.stage()).rejects.toMatchObject({ code: "skill_source_cleanup_pending" });
    expect(cleanup.stagedDirectories()).toEqual([]);
  });

  it("rechecks authorization after releasing the remote read environment", async () => {
    const f = fixture();
    f.manager.releaseWorkerExecutionEnv.mockImplementation(async () => { f.project.grantRevision++; return { cleanupPending: false }; });
    await expect(f.stage()).rejects.toMatchObject({ code: "skill_source_changed" });
    expect(f.stagedDirectories()).toEqual([]);
  });
});
