import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { FileError, type BinaryReader, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import { publishExecutionAsset, type ExecutionAssetOptions } from "../packages/hub/src/content-assets";
import { MocoUploadStore } from "../packages/hub/src/uploads";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(bytes = Buffer.from("remote result")) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-content-assets-"));
  directories.push(directory);
  const root = path.join(directory, "workspace");
  fs.mkdirSync(root);
  const target = path.join(root, "report.txt");
  fs.writeFileSync(target, "Hub same-path data must never be imported");
  const uploads = new MocoUploadStore(path.join(directory, "uploads"));
  const kinds = new Map<string, FileInfo["kind"]>([[root, "directory"], [target, "file"]]);
  const links = new Map<string, string>();
  const canonicalErrors = new Map<string, FileError>();
  const metadataReads: string[] = [];
  const reads: Array<{ offset: number; length: number }> = [];
  const closes: Context[] = [];
  const opens: Array<{ target: string; noFollow?: boolean }> = [];
  let failRead = -1;
  let onRead: (() => void) | undefined;
  let mtimeMs = 10;
  const absolute = (value: string) => path.posix.resolve(root, value);
  const canonical = (value: string) => {
    let resolved = absolute(value);
    for (const [from, to] of links) if (resolved === from || resolved.startsWith(`${from}/`)) resolved = `${to}${resolved.slice(from.length)}`;
    return resolved;
  };
  const info = (value: string): FileInfo => ({ name: path.posix.basename(value), path: value, kind: kinds.get(value) ?? "file", size: bytes.length, mtimeMs });
  const reader = {
    info: async () => ({ ok: true as const, value: info(target) }),
    read: async (offset: number, length: number) => {
      reads.push({ offset, length });
      if (reads.length === failRead) return { ok: false as const, error: new FileError("unknown", "execution node read failed") };
      const value = bytes.subarray(offset, offset + length);
      onRead?.();
      return { ok: true as const, value };
    },
    close: async (context: Context) => { closes.push(context); },
  } as BinaryReader;
  const env = {
    id: "remote-node:asset-test", cwd: root,
    absolutePath: async (value: string) => ({ ok: true as const, value: absolute(value) }),
    joinPath: async (parts: string[]) => ({ ok: true as const, value: path.posix.join(...parts) }),
    canonicalPath: async (value: string) => {
      const error = canonicalErrors.get(absolute(value));
      return error ? { ok: false as const, error } : { ok: true as const, value: canonical(value) };
    },
    fileInfo: async (value: string) => { metadataReads.push(value); return { ok: true as const, value: info(value) }; },
    openBinaryReader: async (value: string, options?: { noFollow?: boolean }) => {
      opens.push({ target: value, noFollow: options?.noFollow });
      return { ok: true as const, value: reader };
    },
  } as unknown as ExecutionEnv;
  const api = { env, conversationId: 12, callId: "publish-1" } as Pick<ToolExecutionApi, "env" | "conversationId" | "callId">;
  const options: ExecutionAssetOptions = { allowedRoot: root, protectedPaths: [], trustedSandbox: true, ownerId: "local", scopeId: "conversation:12" };
  const publish = (value = "report.txt", context = BACKGROUND_CONTEXT) => publishExecutionAsset({ path: value }, api, context, uploads, options);
  return { directory, root, target, uploads, env, api, options, kinds, links, canonicalErrors, metadataReads, reads, opens, closes, publish,
    failAtRead: (index: number) => { failRead = index; },
    onRead: (hook: () => void) => { onRead = hook; },
    mutate: () => { mtimeMs += 1; },
  };
}

describe("execution-node asset publication", () => {
  it("imports actual execution-node bytes rather than a same-path Hub file, and binds the conversation", async () => {
    const remote = Buffer.from("actual remote bytes");
    const f = fixture(remote);
    const attachment = await f.publish();
    const saved = f.uploads.getUpload(attachment.id)!;
    expect(fs.readFileSync(saved.filePath)).toEqual(remote);
    expect(saved.record.referenceScopes).toEqual(["conversation:12"]);
    expect(saved.record.ownerId).toBe("local");
    expect(attachment.name).toBe("report.txt");
    expect(f.opens).toEqual([{ target: f.target, noFollow: true }]);
    expect(f.closes).toHaveLength(1);
  });

  it("reads bounded positional chunks and closes the node reader", async () => {
    const bytes = Buffer.alloc(700_000, "a");
    const f = fixture(bytes);
    const attachment = await f.publish();
    expect(f.reads).toEqual([{ offset: 0, length: 262_144 }, { offset: 262_144, length: 262_144 }, { offset: 524_288, length: 175_712 }]);
    expect(fs.readFileSync(f.uploads.getUpload(attachment.id)!.filePath)).toEqual(bytes);
    expect(f.closes).toHaveLength(1);
  });

  it("keeps successful import receipts stable across the same tool call", async () => {
    const f = fixture();
    const first = await f.publish();
    const second = await f.publish();
    expect(second.id).toBe(first.id);
    expect(fs.readdirSync(f.uploads.dir).filter((name) => name.endsWith(".meta.json"))).toHaveLength(1);
    expect(f.reads).toHaveLength(1);
    expect(f.closes).toHaveLength(2);
  });

  it("rejects unprotected environments and an unavailable execution node", async () => {
    const f = fixture();
    f.options.trustedSandbox = false;
    await expect(f.publish()).rejects.toMatchObject({ code: "asset_publication_denied", status: 403 });
    f.options.trustedSandbox = true;
    await expect(publishExecutionAsset({ path: "report.txt" }, { ...f.api, env: undefined }, BACKGROUND_CONTEXT, f.uploads, f.options)).rejects.toMatchObject({ code: "asset_publication_denied" });
    expect(f.opens).toHaveLength(0);
  });

  it.each(["../private.txt", ".env", ".config/token", "credentials.json", "auth.json", "secrets.txt", "id_ed25519", "private.key"])("rejects sensitive or traversing input %s", async (value) => {
    const f = fixture();
    await expect(f.publish(value)).rejects.toMatchObject({ code: "asset_publication_denied" });
    expect(f.opens).toHaveLength(0);
  });

  it("rejects directories, final links and parent links even when their target stays in the workspace", async () => {
    const f = fixture();
    f.kinds.set(f.target, "directory");
    await expect(f.publish()).rejects.toMatchObject({ code: "asset_publication_denied" });
    f.kinds.set(f.target, "symlink");
    f.links.set(f.target, path.join(f.root, "other.txt"));
    await expect(f.publish()).rejects.toMatchObject({ code: "asset_publication_denied" });
    const linkedDirectory = path.join(f.root, "linked");
    f.kinds.set(linkedDirectory, "symlink");
    f.links.set(linkedDirectory, f.root);
    await expect(f.publish("linked/report.txt")).rejects.toMatchObject({ code: "asset_publication_denied" });
    expect(f.opens).toHaveLength(0);
  });

  it("rejects paths outside the granted workspace and protected identity/state paths", async () => {
    const f = fixture();
    await expect(f.publish(path.join(f.directory, "private.txt"))).rejects.toMatchObject({ code: "asset_publication_denied" });
    f.options.protectedPaths = [f.target];
    await expect(f.publish()).rejects.toMatchObject({ code: "asset_publication_denied" });
    expect(f.opens).toHaveLength(0);
  });

  it("publishes an allowed workspace asset when the sandbox denies realpath on a protected directory", async () => {
    const f = fixture();
    const identity = path.join(f.directory, "identity");
    f.options.protectedPaths = [identity];
    f.canonicalErrors.set(identity, new FileError("permission_denied", "protected by sandbox", identity));
    const attachment = await f.publish();
    expect(fs.readFileSync(f.uploads.getUpload(attachment.id)!.filePath, "utf8")).toBe("remote result");
    expect(f.opens).toHaveLength(1);
  });

  it("rejects a protected lexical path before reading its metadata even when its realpath is denied", async () => {
    const f = fixture();
    const identity = path.join(f.root, "identity");
    f.options.protectedPaths = [identity];
    f.canonicalErrors.set(identity, new FileError("permission_denied", "protected by sandbox", identity));
    await expect(f.publish("identity/identity-agreement.md")).rejects.toMatchObject({ code: "asset_publication_denied", status: 403 });
    expect(f.metadataReads).toEqual([]);
    expect(f.opens).toHaveLength(0);
  });

  it("propagates unexpected protected-path failures and candidate permission failures", async () => {
    const f = fixture();
    const identity = path.join(f.directory, "identity");
    f.options.protectedPaths = [identity];
    f.canonicalErrors.set(identity, new FileError("unknown", "execution node lost"));
    await expect(f.publish()).rejects.toThrow("execution node lost");
    f.canonicalErrors.delete(identity);
    f.canonicalErrors.set(f.target, new FileError("permission_denied", "candidate denied"));
    await expect(f.publish()).rejects.toThrow("candidate denied");
    expect(f.opens).toHaveLength(0);
  });

  it("rejects a canonical path that escapes the lexical workspace", async () => {
    const f = fixture();
    f.links.set(f.target, path.join(f.directory, "private.txt"));
    await expect(f.publish()).rejects.toMatchObject({ code: "asset_publication_denied" });
    expect(f.opens).toHaveLength(0);
  });

  it("removes partial imports and closes with a cleanup context after cancellation", async () => {
    const f = fixture(Buffer.alloc(700_000, "a"));
    const controller = new AbortController();
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    f.onRead(() => controller.abort());
    await expect(f.publish("report.txt", context)).rejects.toMatchObject({ status: 499 });
    expect(fs.readdirSync(f.uploads.dir)).toEqual([]);
    expect(f.closes).toHaveLength(1);
    expect(f.closes[0]!.abortSignal).toBeUndefined();
  });

  it("does not open a reader if the invocation is already cancelled", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(f.publish("report.txt", withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toMatchObject({ code: "asset_publication_aborted" });
    expect(f.opens).toHaveLength(0);
  });

  it("preserves node read failures without leaving a published asset", async () => {
    const f = fixture(Buffer.alloc(700_000, "a"));
    f.failAtRead(2);
    await expect(f.publish()).rejects.toThrow("execution node read failed");
    expect(fs.readdirSync(f.uploads.dir)).toEqual([]);
    expect(f.closes).toHaveLength(1);
  });

  it("rejects a file modified during streaming and removes its partial import", async () => {
    const f = fixture();
    f.onRead(f.mutate);
    await expect(f.publish()).rejects.toMatchObject({ code: "asset_changed", status: 409 });
    expect(fs.readdirSync(f.uploads.dir)).toEqual([]);
    expect(f.closes).toHaveLength(1);
  });
});
