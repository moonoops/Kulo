import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { FileError, type BinaryReader, type DirReader, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { detectReactWorkspace } from "../packages/hub/src/skill-runtime.js";

function fixture(windows = false) {
  const paths = windows ? path.win32 : path.posix;
  const root = windows ? "C:\\Remote Projects\\demo" : "/remote-project/demo";
  interface Entry { kind: FileInfo["kind"]; bytes: Uint8Array; size: number; mtimeMs: number }
  const entries = new Map<string, Entry>();
  const links = new Map<string, string>();
  const opens: Array<{ path: string; noFollow?: boolean }> = [];
  const reads: Array<{ path: string; length: number }> = [];
  const closes: Array<{ path: string; aborted: boolean }> = [];
  const listed: string[] = [];
  const inspected: string[] = [];
  const failures = new Map<string, FileError>();
  let onRead: (() => void) | undefined;
  let emptyRead = false;
  const absolute = (value: string) => paths.resolve(root, value);
  const directory = (relative: string) => {
    const target = absolute(relative);
    if (entries.has(target)) return target;
    if (target !== root) directory(paths.relative(root, paths.dirname(target)));
    entries.set(target, { kind: "directory", bytes: new Uint8Array(), size: 0, mtimeMs: 1 });
    return target;
  };
  const file = (relative: string, contents: string | Uint8Array) => {
    const target = absolute(relative);
    directory(paths.relative(root, paths.dirname(target)));
    const bytes = typeof contents === "string" ? Buffer.from(contents) : contents;
    entries.set(target, { kind: "file", bytes, size: bytes.length, mtimeMs: 1 });
    return target;
  };
  const json = (relative: string, contents: unknown) => file(relative, JSON.stringify(contents));
  directory(".");
  const info = (target: string): FileInfo => {
    const resolved = absolute(target);
    if (failures.has(resolved)) throw failures.get(resolved)!;
    const entry = entries.get(resolved);
    if (!entry) throw new FileError("not_found", "fixture path missing", resolved);
    return { path: resolved, name: paths.basename(resolved), kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs };
  };
  const env = {
    id: "remote-project", cwd: root,
    absolutePath: async (value: string) => ({ ok: true, value: absolute(value) }),
    joinPath: async (parts: string[]) => ({ ok: true, value: paths.join(...parts) }),
    canonicalPath: async (target: string) => ({ ok: true, value: links.get(absolute(target)) ?? absolute(target) }),
    fileInfo: async (target: string) => {
      inspected.push(absolute(target));
      try { return { ok: true, value: info(target) }; }
      catch (error) { return { ok: false, error }; }
    },
    openBinaryReader: async (target: string, options?: { noFollow?: boolean }) => {
      opens.push({ path: absolute(target), noFollow: options?.noFollow });
      const reader: BinaryReader = {
        info: async () => ({ ok: true, value: info(target) }),
        read: async (offset, length) => {
          reads.push({ path: absolute(target), length });
          onRead?.();
          return { ok: true, value: emptyRead ? new Uint8Array() : entries.get(absolute(target))!.bytes.subarray(offset, offset + length) };
        },
        close: async (context) => { closes.push({ path: absolute(target), aborted: context.abortSignal?.aborted ?? false }); },
      };
      return { ok: true, value: reader };
    },
    openDirReader: async (target: string) => {
      listed.push(absolute(target));
      const children = [...entries.keys()].filter((entry) => entry !== absolute(target) && paths.dirname(entry) === absolute(target)).sort();
      let offset = 0;
      const reader: DirReader = {
        next: async (count) => {
          const selected = children.slice(offset, offset + count); offset += selected.length;
          return { ok: true, value: { entries: selected.map(info), done: offset === children.length } };
        },
        close: async (context) => { closes.push({ path: absolute(target), aborted: context.abortSignal?.aborted ?? false }); },
      };
      return { ok: true, value: reader };
    },
  } as unknown as ExecutionEnv;
  return { env, root, paths, entries, links, failures, opens, reads, closes, inspected, listed, file, json, directory,
    detect: () => detectReactWorkspace(env, BACKGROUND_CONTEXT), onRead: (callback: () => void) => { onRead = callback; }, emptyRead: () => { emptyRead = true; } };
}

describe("target Env React workspace detection", () => {
  it("uses the real Pi filesystem reader contract for a temporary monorepo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-react-runtime-"));
    const env = new NodeExecutionEnv({ cwd: root });
    try {
      await fs.mkdir(path.join(root, "packages", "web"), { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ private: true }));
      await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
      await fs.writeFile(path.join(root, "packages", "web", "package.json"), JSON.stringify({ dependencies: { react: "^19" } }));
      expect(await detectReactWorkspace(env, BACKGROUND_CONTEXT)).toBe(true);
    } finally { await env.cleanup(BACKGROUND_CONTEXT); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("does not use the Hub workspace when the target Env or manifest is absent", async () => {
    expect(await detectReactWorkspace(undefined, BACKGROUND_CONTEXT)).toBe(false);
    const f = fixture();
    expect(await f.detect()).toBe(false);
    expect(f.opens).toEqual([]);
    expect(f.listed).toEqual([]);
  });

  it.each(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])("detects React in %s", async (field) => {
    const f = fixture(); f.json("package.json", { [field]: { react: "^19.0.0" } });
    expect(await f.detect()).toBe(true);
    expect(f.opens.every((entry) => entry.noFollow)).toBe(true);
    expect(f.opens.map((entry) => entry.path)).toEqual([f.paths.join(f.root, "package.json")]);
  });

  it("reads actual Windows Env manifests with remote path operations", async () => {
    const f = fixture(true);
    f.json("package.json", { private: true });
    f.file("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    f.json("packages/server/package.json", { dependencies: { express: "5" } });
    f.json("packages/web/package.json", { dependencies: { react: "19" } });
    expect(await f.detect()).toBe(true);
    expect(f.opens.some((entry) => entry.path === "C:\\Remote Projects\\demo\\packages\\web\\package.json")).toBe(true);
    expect(f.opens.every((entry) => entry.path.startsWith(f.root))).toBe(true);
  });

  it.each([["apps/*"], { packages: ["apps/*"] }])("supports npm/yarn workspace manifest shape %j", async (workspaces) => {
    const f = fixture(); f.json("package.json", { workspaces });
    f.json("apps/client/package.json", { devDependencies: { react: "19" } });
    expect(await f.detect()).toBe(true);
  });

  it("supports bounded recursive workspace patterns and exclusions", async () => {
    const f = fixture(); f.json("package.json", { workspaces: ["packages/**", "!packages/excluded/**"] });
    f.json("packages/excluded/private/package.json", { dependencies: { react: "19" } });
    f.json("packages/tools/ui/package.json", { peerDependencies: { react: ">=18" } });
    expect(await f.detect()).toBe(true);
    expect(f.opens.some((entry) => entry.path.includes("/excluded/"))).toBe(false);
  });

  it("does not discover unrelated React sources, node_modules, hidden or symlinked directories", async () => {
    const f = fixture(); f.json("package.json", { workspaces: ["packages/*"] });
    f.json("other/react/package.json", { dependencies: { react: "19" } });
    f.json("packages/node_modules/package.json", { dependencies: { react: "19" } });
    f.json("packages/.hidden/package.json", { dependencies: { react: "19" } });
    const linked = f.directory("packages/linked");
    f.entries.get(linked)!.kind = "symlink"; f.links.set(linked, "/private/other");
    expect(await f.detect()).toBe(false);
    expect(f.opens.map((entry) => entry.path)).toEqual([f.paths.join(f.root, "package.json")]);
    expect(f.listed).not.toContain(linked);
  });

  it("refuses declared traversal, absolute and nonportable workspace paths", async () => {
    const f = fixture();
    f.json("package.json", { workspaces: ["../outside", "/outside", "C:/outside", "packages/../../outside", "packages\\*", "packages//web"] });
    expect(await f.detect()).toBe(false);
    expect(f.listed).toEqual([]);
    expect(f.opens.map((entry) => entry.path)).toEqual([f.paths.join(f.root, "package.json")]);
  });

  it("does not read a manifest whose real path escaped its declared directory", async () => {
    const f = fixture(); const manifest = f.json("package.json", { dependencies: { react: "19" } });
    f.links.set(manifest, "/private/package.json");
    expect(await f.detect()).toBe(false);
    expect(f.opens).toEqual([]);
  });

  it("does not treat malformed JSON/YAML or an invalid dependency declaration as React", async () => {
    const f = fixture(); f.file("package.json", '{"dependencies":{"react":"19"}');
    expect(await f.detect()).toBe(false);
    f.json("package.json", { dependencies: { react: {} } });
    f.file("pnpm-workspace.yaml", 'packages: ["packages/*"\n');
    f.json("packages/web/package.json", { dependencies: { react: "19" } });
    expect(await f.detect()).toBe(false);
    expect(f.opens.some((entry) => entry.path.endsWith("/web/package.json"))).toBe(false);
    f.file("package.json", new Uint8Array([0xff, 0xfe]));
    expect(await f.detect()).toBe(false);
  });

  it("limits manifest size and the combined bytes read", async () => {
    const f = fixture(); f.file("package.json", " ".repeat(256 * 1024 + 1));
    expect(await f.detect()).toBe(false); expect(f.opens).toEqual([]);
    f.json("package.json", { workspaces: ["packages/*"] });
    for (let index = 0; index < 7; index++) f.file(`packages/p${index}/package.json`, JSON.stringify({ padding: "x".repeat(200_000), ...(index === 6 ? { dependencies: { react: "19" } } : {}) }));
    expect(await f.detect()).toBe(false);
    expect(f.reads.reduce((sum, entry) => sum + entry.length, 0)).toBeLessThanOrEqual(1024 * 1024);
    expect(f.reads.every((entry) => entry.length <= 32 * 1024)).toBe(true);
  });

  it("caps directory enumeration instead of recursively scanning an entire repository", async () => {
    const f = fixture(); f.json("package.json", { workspaces: ["packages/**"] });
    for (let index = 0; index < 90; index++) f.json(`packages/p${String(index).padStart(3, "0")}/package.json`, { name: "plain" });
    f.json("packages/p999/package.json", { dependencies: { react: "19" } });
    expect(await f.detect()).toBe(false);
    expect(f.listed.length).toBeLessThanOrEqual(65);
    expect(f.opens.length).toBeLessThanOrEqual(65);
  });

  it("surfaces permission failures and changed files", async () => {
    const f = fixture(); const manifest = f.json("package.json", { dependencies: { react: "19" } });
    f.failures.set(manifest, new FileError("permission_denied", "workspace access denied"));
    await expect(f.detect()).rejects.toMatchObject({ code: "permission_denied" });
    f.failures.clear(); f.onRead(() => { f.entries.get(manifest)!.mtimeMs++; });
    await expect(f.detect()).rejects.toMatchObject({ code: "skill_workspace_changed" });
    expect(f.closes).toHaveLength(1);
  });

  it("rejects incomplete reads and always closes readers", async () => {
    const f = fixture(); f.json("package.json", { dependencies: { react: "19" } }); f.emptyRead();
    await expect(f.detect()).rejects.toMatchObject({ code: "skill_workspace_read_failed" });
    expect(f.closes).toHaveLength(1);
  });

  it("propagates cancellation while closing the reader without its aborted signal", async () => {
    const f = fixture(); f.json("package.json", { dependencies: { react: "19" } });
    const abort = new AbortController(); f.onRead(() => abort.abort(new Error("test cancellation")));
    await expect(detectReactWorkspace(f.env, withAbortSignal(abort.signal, BACKGROUND_CONTEXT))).rejects.toThrow("test cancellation");
    expect(f.closes).toEqual([{ path: f.paths.join(f.root, "package.json"), aborted: false }]);
  });
});
