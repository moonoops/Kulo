import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FileError, type BinaryReader, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import { listTaskDeliverables, MAX_TASK_DELIVERABLE_BYTES, readTaskDeliverable, reportFileReferences, TaskDeliverableError, type TaskDeliverableOptions } from "../packages/hub/src/task-deliverables.js";

function fixture(report = "已保存 index.html") {
  const workspace = "/remote/workspace";
  const scratch = "/remote/scratch";
  const target = `${workspace}/index.html`;
  const bytes = Buffer.from("<!DOCTYPE html><title>真实执行节点文件</title>");
  const entries = new Map<string, FileInfo>([
    [workspace, { path: workspace, name: "workspace", kind: "directory", size: 0, mtimeMs: 1 }],
    [scratch, { path: scratch, name: "scratch", kind: "directory", size: 0, mtimeMs: 1 }],
    [target, { path: target, name: "index.html", kind: "file", size: bytes.length, mtimeMs: 1 }],
  ]);
  let active = true;
  const assertAuthorized = vi.fn(async () => { if (!active) throw new TaskDeliverableError(403, "revoked", "授权已撤销"); });
  const closes = vi.fn(async () => {});
  const read = vi.fn(async (offset: number, length: number) => ({ ok: true as const, value: bytes.subarray(offset, offset + length) }));
  const info = (value: string) => {
    const found = entries.get(value);
    return found ? { ok: true as const, value: { ...found } } : { ok: false as const, error: new FileError("not_found", "执行节点没有该文件") };
  };
  const env = {
    id: "remote-node", cwd: workspace,
    absolutePath: vi.fn(async (value: string) => ({ ok: true as const, value: path.posix.resolve(workspace, value) })),
    canonicalPath: vi.fn(async (value: string) => {
      const resolved = path.posix.resolve(workspace, value);
      return entries.has(resolved) ? { ok: true as const, value: resolved } : { ok: false as const, error: new FileError("not_found", "执行节点没有该文件") };
    }),
    joinPath: vi.fn(async (parts: string[]) => ({ ok: true as const, value: path.posix.join(...parts) })),
    fileInfo: vi.fn(async (value: string) => info(value)),
    openBinaryReader: vi.fn(async (value: string) => ({ ok: true as const, value: {
      info: async () => info(value), read, close: closes,
    } as BinaryReader })),
  } as unknown as ExecutionEnv;
  const options: TaskDeliverableOptions = { env, ticket: {
    id: "T-0004", workspaceDir: workspace, scratchDir: scratch,
    latestReport: { state: "ready", summary: report, at: 1 },
  }, protectedPaths: [], assertAuthorized, context: BACKGROUND_CONTEXT };
  return { env, options, entries, bytes, target, workspace, scratch, read, closes, revoke: () => { active = false; } };
}

describe("task deliverable references", () => {
  it("preserves explicit paths and spaces without turning web links into file references", () => {
    expect(reportFileReferences({ state: "ready", summary: "index.html", deliverable: "`/remote/workspace/中文 页面.html`、[报告](reports/final.pdf)。参考 https://example.test/private.json", at: 1 }))
      .toEqual(["/remote/workspace/中文 页面.html", "reports/final.pdf", "index.html"]);
  });

  it("does not invent files for ordinary textual results", () => {
    expect(reportFileReferences({ state: "ready", summary: "已完成分析，见下方结论。", at: 1 })).toEqual([]);
  });
});

describe("task deliverables on the execution node", () => {
  it("lists actual metadata and reads bounded bytes via the Env, including files in scratch", async () => {
    const f = fixture("已保存 index.html 和 result.txt");
    f.entries.set(`${f.scratch}/result.txt`, { path: `${f.scratch}/result.txt`, name: "result.txt", kind: "file", size: f.bytes.length, mtimeMs: 1 });
    const snapshot = await listTaskDeliverables(f.options);
    expect(snapshot.files.map((file) => file.name)).toEqual(["index.html", "result.txt"]);
    expect(snapshot.files[0]).toMatchObject({ mimeType: "text/html", size: f.bytes.length, previewable: true });
    expect(snapshot.files[0]!.url).toMatch(/^\/api\/tickets\/T-0004\/deliverables\/[a-f\d]{32}$/);
    expect(snapshot).not.toHaveProperty("missing");
    const result = await readTaskDeliverable(f.options, snapshot.files[0]!.id);
    expect(Buffer.from(result.bytes)).toEqual(f.bytes);
    expect(f.env.openBinaryReader).toHaveBeenCalledWith(f.target, { noFollow: true }, BACKGROUND_CONTEXT);
    expect(f.read).toHaveBeenCalledWith(0, f.bytes.length, BACKGROUND_CONTEXT);
    expect(f.closes).toHaveBeenCalledTimes(1);
  });

  it("keeps missing references explicit without failing a completed task", async () => {
    const f = fixture("已保存 missing.html 和 index.html");
    const snapshot = await listTaskDeliverables(f.options);
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.missing).toEqual(["missing.html"]);
    f.entries.delete(f.target);
    await expect(readTaskDeliverable(f.options, snapshot.files[0]!.id)).rejects.toMatchObject({ status: 404, code: "task_deliverable_not_found" });
    await expect(readTaskDeliverable(f.options, "../index.html")).rejects.toMatchObject({ status: 404 });
  });

  it.each(["../outside.html", "/outside/report.html", ".private/report.html", "credentials.json"])("denies %s before reading bytes", async (reference) => {
    const f = fixture(`已保存 \`${reference}\``);
    await expect(listTaskDeliverables(f.options)).rejects.toMatchObject({ status: 403 });
    expect(f.env.openBinaryReader).not.toHaveBeenCalled();
  });

  it("rejects symlinks and protected application paths", async () => {
    const f = fixture();
    f.entries.set(f.target, { ...f.entries.get(f.target)!, kind: "symlink" });
    await expect(listTaskDeliverables(f.options)).rejects.toMatchObject({ code: "execution_symlink_denied" });
    f.entries.set(f.target, { ...f.entries.get(f.target)!, kind: "file" });
    f.options.protectedPaths = [f.workspace];
    await expect(listTaskDeliverables(f.options)).rejects.toMatchObject({ status: 403 });
    expect(f.env.openBinaryReader).not.toHaveBeenCalled();
  });

  it("bounds file sizes and refuses files not named in the report", async () => {
    const f = fixture();
    f.entries.set(f.target, { ...f.entries.get(f.target)!, size: MAX_TASK_DELIVERABLE_BYTES + 1 });
    await expect(listTaskDeliverables(f.options)).rejects.toMatchObject({ status: 413 });
    expect(f.env.openBinaryReader).not.toHaveBeenCalled();
    await expect(readTaskDeliverable(f.options, "a".repeat(32))).rejects.toMatchObject({ status: 413 });
  });

  it("stops when authorization or the file changes during a read", async () => {
    const f = fixture();
    const { files } = await listTaskDeliverables(f.options);
    f.read.mockImplementationOnce(async (offset, length) => { f.revoke(); return { ok: true, value: f.bytes.subarray(offset, offset + length) }; });
    await expect(readTaskDeliverable(f.options, files[0]!.id)).rejects.toMatchObject({ status: 403 });
    expect(f.closes).toHaveBeenCalledTimes(1);
    const changed = fixture();
    const initial = await listTaskDeliverables(changed.options);
    changed.read.mockImplementationOnce(async (offset, length) => {
      changed.entries.get(changed.target)!.mtimeMs += 1;
      return { ok: true, value: changed.bytes.subarray(offset, offset + length) };
    });
    await expect(readTaskDeliverable(changed.options, initial.files[0]!.id)).rejects.toMatchObject({ status: 409, code: "task_deliverable_changed" });
    expect(changed.closes).toHaveBeenCalledTimes(1);
  });
});
