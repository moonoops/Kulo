import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ExtensionOperationRequest } from "@kulo/protocol";
import { ExtensionsDoc, KuloExtensions, createExtensionsExtension } from "../packages/hub/src/extensions.js";
import { ExtensionPackageError, type ExtensionPackageInfo } from "../packages/hub/src/extension-packages.js";
import { analyzeExtensionSource } from "../packages/hub/src/extension-sources.js";
import { createExtensionSetupExtension } from "../packages/hub/src/tools-extensions.js";
import * as webContent from "../packages/hub/src/web-content.js";

const context = BACKGROUND_CONTEXT;
const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const info: ExtensionPackageInfo = { id: "billion-context", packageName: "acp-kernel", version: "0.0.101", adapterVersion: "0.1.0", sourceUrl: "https://github.com/ranxianglei/acp-kernel",
  directory: "/synthetic/extensions/packages/billion-context", digest: "d".repeat(64), kernelDigest: "e".repeat(64), installedAt: 1 };

async function fixture(options: { installed?: boolean; holdInstall?: Promise<void>; holdEnable?: Promise<void>; failInstall?: boolean; failEnable?: boolean; failRemove?: boolean } = {}) {
  let installed = Boolean(options.installed), enabled = false, service!: KuloExtensions;
  const registry = createRegistry(), extension = createExtensionsExtension(() => service); registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
  await harness.root(context);
  closing.push(() => harness.close(context));
  const packages = { inspect: vi.fn(async () => installed ? { ...info } : null),
    install: vi.fn(async () => { await options.holdInstall; if (options.failInstall) throw new Error("npm raw output with token=synthetic-private-value"); installed = true; return { ...info }; }),
    remove: vi.fn(async () => { if (enabled) throw new Error("removed before stop"); if (options.failRemove) throw new Error("disk failure"); installed = false; }) };
  const compaction = { enable: vi.fn(async () => { await options.holdEnable; if (options.failEnable) throw new Error("model key=synthetic-private-value"); enabled = true; }), stop: vi.fn(async () => { enabled = false; }) };
  const onChange = vi.fn();
  service = new KuloExtensions({ harness, operationTask: extension.operationTask, stateDir: "/synthetic", packages, compaction, onChange });
  await service.initialize();
  let count = 0;
  const request = async (operation: ExtensionOperationRequest["operation"], overrides: Partial<ExtensionOperationRequest> = {}) => {
    const item = (await service.snapshot()).items[0]!;
    return service.request({ id: item.id, operation, expectedRevision: item.revision, commandId: `operation-${++count}`, clientId: "browser-a", ...overrides });
  };
  const settle = async () => {
    const state = await service.snapshot();
    await Promise.all(state.jobs.flatMap((job) => job.taskId === undefined ? [] : [harness.waitForTask(job.taskId as TaskId, context)]));
    return service.snapshot();
  };
  return { service, harness, packages, compaction, onChange, request, settle, installed: () => installed, enabled: () => enabled };
}

describe("managed other extensions", () => {
  it("starts disabled and installs without enabling, with the actual package version", async () => {
    const f = await fixture();
    expect((await f.service.snapshot()).items[0]).toMatchObject({ name: "Billion Context 上下文压缩", enabled: false, status: "not_installed", availableVersion: "0.0.101" });
    await f.request("install");
    const state = await f.settle();
    expect(state.items[0]).toMatchObject({ installedVersion: info.version, adapterVersion: info.adapterVersion, status: "stopped", enabled: false });
    expect(state.jobs[0]).toMatchObject({ operation: "install", status: "completed", clientId: "browser-a" });
    expect(f.packages.install).toHaveBeenCalledOnce(); expect(f.compaction.enable).not.toHaveBeenCalled(); expect(f.onChange).toHaveBeenCalled();
  });
  it("starts only an installed extension and stops before deleting its owned package", async () => {
    const f = await fixture();
    await expect(f.request("enable")).rejects.toMatchObject({ code: "extension_not_installed" });
    expect((await f.service.snapshot()).jobs).toEqual([]);
    await f.request("install"); await f.settle();
    await f.request("enable");
    expect((await f.settle()).items[0]).toMatchObject({ enabled: true, status: "running" });
    expect(f.enabled()).toBe(true);
    await expect(f.request("install")).rejects.toMatchObject({ code: "extension_running" });
    await f.request("stop");
    expect((await f.settle()).items[0]).toMatchObject({ enabled: false, status: "stopped", installedVersion: info.version });
    await f.request("enable"); await f.settle();
    await f.request("remove");
    const removed = await f.settle();
    expect(removed.items[0]).toMatchObject({ enabled: false, status: "not_installed" });
    expect(removed.items[0]?.installedVersion).toBeUndefined();
    expect(f.packages.remove).toHaveBeenCalledOnce(); expect(f.installed()).toBe(false); expect(f.enabled()).toBe(false);
  });
  it("deduplicates a command but rejects changed intent and stale state", async () => {
    let release!: () => void;
    const f = await fixture({ holdInstall: new Promise<void>((resolve) => { release = resolve; }) });
    const original: ExtensionOperationRequest = { id: "billion-context", operation: "install", expectedRevision: (await f.service.snapshot()).items[0]!.revision, commandId: "same-command", clientId: "browser-a" };
    try {
      await f.service.request(original); await f.service.request(original);
      expect((await f.service.snapshot()).jobs).toHaveLength(1);
      await expect(f.service.request({ ...original, clientId: "browser-b" })).rejects.toMatchObject({ code: "extension_command_conflict" });
      await expect(f.service.request({ ...original, commandId: "stale" })).rejects.toMatchObject({ code: "extension_revision_conflict" });
      await expect(f.request("stop")).rejects.toMatchObject({ code: "extension_busy" });
    } finally { release(); }
    await f.settle(); expect(f.packages.install).toHaveBeenCalledOnce();
  });
  it("preserves the source of truth on failures without persisting installer output", async () => {
    const f = await fixture({ failInstall: true });
    await f.request("install");
    const state = await f.settle();
    expect(state.jobs[0]?.status).toBe("failed"); expect(state.items[0]).toMatchObject({ enabled: false, status: "error" });
    expect(state.items[0]?.installedVersion).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("synthetic-private-value"); expect(JSON.stringify(state)).not.toContain("npm raw output");
    const task = await f.harness.waitForTask(state.jobs[0]!.taskId as TaskId, context);
    expect(task.state.outcome.status).toBe("failed");
  });
  it("reports a failed start without claiming the extension is running", async () => {
    const f = await fixture({ installed: true, failEnable: true });
    await f.request("enable"); const state = await f.settle();
    expect(state.items[0]).toMatchObject({ enabled: false, status: "error", installedVersion: info.version });
    expect(state.jobs[0]?.status).toBe("failed"); expect(JSON.stringify(state)).not.toContain("synthetic-private-value");
  });
  it("keeps a completed stop visible when removal fails afterwards", async () => {
    const f = await fixture({ installed: true, failRemove: true });
    await f.request("enable"); await f.settle();
    await f.request("remove");
    const state = await f.settle();
    expect(state.jobs.at(-1)?.status).toBe("failed");
    expect(state.items[0]).toMatchObject({ enabled: false, status: "error", installedVersion: info.version });
    expect(f.enabled()).toBe(false); expect(f.installed()).toBe(true);
  });
  it("does not overwrite a newer record when a job settles", async () => {
    let release!: () => void;
    const f = await fixture({ holdInstall: new Promise<void>((resolve) => { release = resolve; }) });
    await f.request("install"); await vi.waitFor(() => expect(f.packages.install).toHaveBeenCalledOnce());
    await f.harness.commit(async (tx) => { const item = (await tx.doc(ExtensionsDoc)).items["billion-context"]!; item.revision++; item.status = "stopped"; item.error = "newer state"; }, context);
    release(); await f.settle();
    expect((await f.service.snapshot()).items[0]).toMatchObject({ status: "stopped", error: "newer state" });
  });
  it("reconciles an interrupted installation from its actual package instead of reinstalling", async () => {
    const f = await fixture({ installed: true });
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(ExtensionsDoc), item = state.items["billion-context"]!;
      item.revision++; item.status = "installing";
      state.jobs["interrupted"] = { fingerprint: "synthetic", expectedRevision: item.revision,
        view: { id: "interrupted", extensionId: item.id, clientId: "browser-a", operation: "install", status: "running", stage: "安装", createdAt: 1, updatedAt: 1 } };
    }, context);
    await f.service.initialize(); await f.service.execute("interrupted");
    expect((await f.service.snapshot()).jobs[0]?.status).toBe("completed"); expect(f.packages.install).not.toHaveBeenCalled();
    expect((await f.service.snapshot()).items[0]).toMatchObject({ enabled: false, status: "stopped", installedVersion: info.version });
  });
  it("establishes a stop fence for a pending removal before normal recovery", async () => {
    const f = await fixture({ installed: true });
    await f.harness.commit(async (tx) => {
      const state = await tx.doc(ExtensionsDoc), item = state.items["billion-context"]!;
      item.enabled = true; item.status = "removing"; item.revision++;
      state.jobs.pending = { fingerprint: "synthetic", expectedRevision: item.revision,
        view: { id: "pending", extensionId: item.id, clientId: "browser-a", operation: "remove", status: "running", stage: "删除", createdAt: 1, updatedAt: 1 } };
    }, context);
    const revision = (await f.service.snapshot()).items[0]!.revision;
    await f.service.initialize();
    expect(f.compaction.stop).toHaveBeenCalledOnce(); expect(f.compaction.enable).not.toHaveBeenCalled();
    expect((await f.service.snapshot()).items[0]!.revision).toBe(revision);
    await f.service.execute("pending"); expect((await f.service.snapshot()).items[0]?.status).toBe("not_installed");
  });
  it("keeps user history untouched when deleting and rejects unsupported or malformed requests", async () => {
    const f = await fixture({ installed: true });
    const conversation = await f.harness.root(context);
    await conversation.submit({ type: "write", entry: { kind: "test.user-history", data: { text: "keep my history" } } }, context);
    const before = await conversation.entries({}, 100, undefined, context);
    await f.request("remove"); await f.settle();
    expect((await conversation.entries({}, 100, undefined, context)).items).toEqual(before.items);
    await expect(f.request("install", { id: "unknown" })).rejects.toMatchObject({ code: "extension_not_supported" });
    await expect(f.service.request({ id: "billion-context", operation: "install", expectedRevision: 1, commandId: "bad", secret: "synthetic-private-value" } as never)).rejects.toMatchObject({ code: "invalid_extension_request" });
  });
  it("does not automatically restart a stored enabled extension until initialization", async () => {
    const f = await fixture({ installed: true });
    await f.harness.commit(async (tx) => { const item = (await tx.doc(ExtensionsDoc)).items["billion-context"]!; item.enabled = true; item.status = "running"; }, context);
    expect(f.compaction.enable).not.toHaveBeenCalled();
    await f.service.initialize(); expect(f.compaction.enable).toHaveBeenCalledOnce();
  });
  it("surfaces a damaged managed package as an actionable error", async () => {
    const f = await fixture({ installed: true });
    f.packages.inspect.mockRejectedValueOnce(new ExtensionPackageError("extension_integrity_mismatch", "扩展安装内容已改变，请重新安装。"));
    await f.service.initialize();
    expect((await f.service.snapshot()).items[0]).toMatchObject({ enabled: false, status: "error", error: "扩展安装内容已改变，请重新安装。" });
  });
  it("removes a stale installed version when the disabled package no longer exists", async () => {
    const f = await fixture({ installed: true });
    f.packages.inspect.mockResolvedValueOnce(null);
    await f.service.initialize();
    expect((await f.service.snapshot()).items[0]).toMatchObject({ enabled: false, status: "not_installed" });
    expect((await f.service.snapshot()).items[0]?.installedVersion).toBeUndefined();
  });
  it("resumes a real interrupted Durable job after reopening without repeating an installed effect", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-extension-resume-"));
    closing.push(async () => { fs.rmSync(directory, { recursive: true, force: true }); });
    let installed = false;
    const install = vi.fn(async (signal: AbortSignal) => {
      installed = true;
      return new Promise<ExtensionPackageInfo>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
    });
    const start = async () => {
      let service!: KuloExtensions;
      const registry = createRegistry(), extension = createExtensionsExtension(() => service); registry.install(extension);
      const harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "state.sqlite")), { models: createModels(), registry }, context);
      await harness.root(context); closing.push(() => harness.close(context));
      service = new KuloExtensions({ harness, operationTask: extension.operationTask, stateDir: "/synthetic",
        compaction: { enable: vi.fn(), stop: vi.fn() }, packages: { inspect: async () => installed ? { ...info } : null, install, remove: async () => {} } });
      await service.initialize(); return { service, harness };
    };
    const first = await start();
    await first.service.request({ id: "billion-context", operation: "install", expectedRevision: 1, commandId: "resume-install" });
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    first.service.close(); await first.harness.close(context);
    const next = await start(), before = await next.service.snapshot();
    expect(before.jobs[0]?.status).toBe("running");
    await next.harness.waitForTask(before.jobs[0]!.taskId as TaskId, context);
    expect((await next.service.snapshot()).jobs[0]?.status).toBe("completed");
    expect((await next.service.snapshot()).items[0]).toMatchObject({ enabled: false, status: "stopped", installedVersion: info.version });
    expect(install).toHaveBeenCalledOnce();
  });
  it("returns a cancelled start to native operation after the start callback settles", async () => {
    let release!: () => void;
    const f = await fixture({ installed: true, holdEnable: new Promise<void>((resolve) => { release = resolve; }) });
    await f.request("enable"); await vi.waitFor(() => expect(f.compaction.enable).toHaveBeenCalledOnce());
    const job = (await f.service.snapshot()).jobs[0]!;
    const aborted = f.harness.abortTask(job.taskId as TaskId, context);
    await vi.waitFor(async () => expect((await f.harness.getTask(job.taskId as TaskId, context))?.abortRequested).toBe(true));
    release(); await aborted;
    await f.harness.waitForTask(job.taskId as TaskId, context);
    expect(f.enabled()).toBe(false);
    expect((await f.service.snapshot()).jobs[0]?.status).toBe("cancelled");
    expect((await f.service.snapshot()).items[0]?.enabled).toBe(false);
  });
  it("recognizes a bundled pre-installed package by default, respects user removal across restarts, and heals prior install errors", async () => {
    let managedInstalled = false;
    let service!: KuloExtensions;
    const registry = createRegistry(), extension = createExtensionsExtension(() => service); registry.install(extension);
    const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
    await harness.root(context);
    closing.push(() => harness.close(context));
    const packages = {
      inspect: vi.fn(async (opts?: { includeBundled?: boolean }) => managedInstalled || opts?.includeBundled !== false ? { ...info, bundled: !managedInstalled } : null),
      install: vi.fn(async () => { managedInstalled = true; return { ...info }; }),
      remove: vi.fn(async () => { managedInstalled = false; }),
    };
    const compaction = { enable: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    service = new KuloExtensions({ harness, operationTask: extension.operationTask, stateDir: "/synthetic", packages, compaction });
    // Simulate a legacy hub that previously failed online npm installation.
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ExtensionsDoc);
      doc.items["billion-context"]!.status = "error";
      doc.items["billion-context"]!.error = "上下文压缩依赖安装失败（退出码 1）。";
    }, context);
    await service.initialize();
    const healed = (await service.snapshot()).items[0]!;
    expect(healed).toMatchObject({ status: "stopped", enabled: false, installedVersion: info.version });
    expect(healed.error).toBeUndefined();
    // Explicit removal persists across subsequent restarts.
    await service.request({ id: "billion-context", operation: "remove", expectedRevision: healed.revision, commandId: "remove-bundled" });
    const removing = (await service.snapshot()).jobs[0]!;
    await harness.waitForTask(removing.taskId as TaskId, context);
    expect((await service.snapshot()).items[0]).toMatchObject({ status: "not_installed", enabled: false });
    await service.initialize();
    expect((await service.snapshot()).items[0]).toMatchObject({ status: "not_installed", enabled: false });
    // Reinstalling clears the removal marker and returns to stopped.
    const removedItem = (await service.snapshot()).items[0]!;
    await service.request({ id: "billion-context", operation: "install", expectedRevision: removedItem.revision, commandId: "reinstall-bundled" });
    const reinstalling = (await service.snapshot()).jobs.at(-1)!;
    await harness.waitForTask(reinstalling.taskId as TaskId, context);
    expect((await service.snapshot()).items[0]).toMatchObject({ status: "stopped", enabled: false, installedVersion: info.version });
    expect(packages.install).toHaveBeenCalledOnce();
  });
});

describe("extension source assessment", () => {
  it("recognizes the reviewed Billion Context route without fetching or executing project code", async () => {
    const fetcher = vi.fn();
    const result = await analyzeExtensionSource("https://github.com/ranxianglei/billion-context", { builtinVersion: "0.0.101", fetch: fetcher });
    expect(result).toMatchObject({ installable: true, compatibility: "ready", extensionId: "billion-context", version: "0.0.101" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [{ name: "@demo/plugin", version: "1.0.0", chord: { plugins: ["."] } }, "chord"],
    [{ name: "demo-pi", pi: { extensions: ["index.ts"] } }, "coding-agent"],
    [{ name: "demo-mcp", dependencies: { "@modelcontextprotocol/sdk": "1.0.0" } }, "mcp"],
    [{ name: "demo-lib", version: "2.0.0" }, "library"],
  ])("classifies metadata while preserving the adaptation requirement", async (manifest, route) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/contents/package.json")
      ? new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(JSON.stringify(manifest)).toString("base64") }))
      : new Response(JSON.stringify({ name: "demo", description: "A demo package", license: { spdx_id: "MIT" } })));
    const result = await analyzeExtensionSource("https://github.com/example/demo", { builtinVersion: "0.0.101", fetch: fetcher });
    expect(result).toMatchObject({ route, compatibility: "needs_adapter", installable: false, license: "MIT" }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["https://synthetic:private@github.com/example/demo", "https://github.com/example/demo?token=synthetic-private-value", "file:///tmp/plugin", "http://127.0.0.1/plugin", "npm:--package"])("rejects unsafe source locations before fetching", async (source) => {
    const fetcher = vi.fn();
    await expect(analyzeExtensionSource(source, { builtinVersion: "0.0.101", fetch: fetcher })).rejects.toMatchObject({ code: "invalid_extension_source" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports unavailable or malformed metadata without treating it as compatibility", async () => {
    await expect(analyzeExtensionSource("npm:demo", { builtinVersion: "0.0.101", fetch: vi.fn(async () => new Response("no", { status: 503 })) })).rejects.toMatchObject({ code: "extension_source_unavailable" });
    await expect(analyzeExtensionSource("npm:demo", { builtinVersion: "0.0.101", fetch: vi.fn(async () => new Response("[]")) })).rejects.toMatchObject({ code: "extension_source_invalid" });
  });
  it("uses the fixed service API transport instead of open-web Fake-IP DNS pinning", async () => {
    const pinned = vi.spyOn(webContent, "safeWebRequest").mockRejectedValue(new Error("网页域名使用代理 Fake-IP DNS"));
    const service = vi.spyOn(webContent, "serviceApiFetch").mockResolvedValue(new Response(JSON.stringify({ name: "@earendil-works/chord", version: "1.5.2" })));
    const result = await analyzeExtensionSource("npm:@earendil-works/chord", { builtinVersion: "0.0.101" });
    expect(result).toMatchObject({ name: "@earendil-works/chord", version: "1.5.2", compatibility: "needs_adapter", installable: false });
    expect(pinned).not.toHaveBeenCalled();
    expect(service).toHaveBeenCalledOnce();
    expect(String(service.mock.calls[0]![0])).toBe("https://registry.npmjs.org/%40earendil-works%2Fchord/latest");
    const init = service.mock.calls[0]![1];
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(service.mock.calls[0]![2]).toEqual({ timeoutMs: 20_000, maxResponseBytes: 256_000 });
  });
  it("never follows metadata redirects or fetches arbitrary source hosts", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/internal" } }));
    await expect(analyzeExtensionSource("https://github.com/example/demo/tree/main", { builtinVersion: "0.0.101", fetch: fetcher })).rejects.toMatchObject({ code: "extension_source_unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://api.github.com/repos/example/demo");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "error", credentials: "omit" });
    for (const source of ["https://registry.npmjs.org/demo", "https://api.github.com/repos/example/demo", "https://github.com.evil.example/example/demo", "https://github.com:8443/example/demo"]) {
      await expect(analyzeExtensionSource(source, { builtinVersion: "0.0.101", fetch: fetcher })).rejects.toMatchObject({ code: "invalid_extension_source" });
    }
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("bounds metadata bytes and propagates the caller's cancellation", async () => {
    const oversized = vi.fn(async () => new Response(" ".repeat(256_001)));
    await expect(analyzeExtensionSource("npm:demo", { builtinVersion: "0.0.101", fetch: oversized })).rejects.toMatchObject({ code: "extension_source_unavailable" });
    const controller = new AbortController(); controller.abort();
    const fetcher: typeof fetch = vi.fn(async (_url, init) => { init?.signal?.throwIfAborted(); return new Response("{}"); });
    await expect(analyzeExtensionSource("npm:demo", { builtinVersion: "0.0.101", fetch: fetcher, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("extension settings tools", () => {
  it("requires the capabilities context before reading, assessing or managing", async () => {
    const f = await fixture();
    const workspaceAction = vi.fn();
    const extension = createExtensionSetupExtension(() => ({ extensions: f.service, settingsAssistant: { capabilityContext: async () => { throw new Error("wrong module"); }, workspaceAction } }));
    for (const tool of extension.tools ?? []) {
      await expect(tool.execute({ source: "npm:acp-kernel", id: "billion-context", action: "install", expected_revision: 1 } as never, { callId: "test" } as never, context)).rejects.toThrow("wrong module");
    }
    expect((await f.service.snapshot()).jobs).toEqual([]); expect(workspaceAction).not.toHaveBeenCalled();
  });
  it("offers deletion through one existing confirmation action without executing it", async () => {
    const f = await fixture({ installed: true });
    const workspaceAction = vi.fn(async () => ({ action: { id: "remove" } }));
    const extension = createExtensionSetupExtension(() => ({ extensions: f.service, settingsAssistant: { capabilityContext: async () => ({ clientId: "browser-a" } as never), workspaceAction: workspaceAction as never } }));
    const manage = extension.tools!.find((tool) => tool.name === "kulo_extension_manage")!;
    await manage.execute({ id: "billion-context", action: "remove", expected_revision: 1 } as never, { callId: "remove" } as never, context);
    expect(workspaceAction).toHaveBeenCalledOnce(); expect(workspaceAction.mock.calls[0]?.[4]).toMatchObject({ kind: "extension-remove", id: "billion-context" });
    expect(f.packages.remove).not.toHaveBeenCalled(); expect((await f.service.snapshot()).jobs).toEqual([]);
  });
});
