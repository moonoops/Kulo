import { describe, expect, it, vi } from "vitest";
import type { CapabilitiesWorkspaceSnapshot } from "@moco/protocol";
import { CapabilitiesWorkspaceLoader } from "./use-capabilities-workspace";

function snapshot(revision: number): CapabilitiesWorkspaceSnapshot {
  return { revision, capabilities: [], connections: [], skills: [], skillRevision: revision, jobs: [], inputs: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const options = { enabled: true, active: false, connected: true, clientId: "tab-a", updateVersion: 0, assistantBusy: false };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("capability workspace loading", () => {
  it("preloads before navigation and reuses that pending request when the page opens", async () => {
    const first = deferred<CapabilitiesWorkspaceSnapshot>();
    const load = vi.fn().mockReturnValue(first.promise);
    const loader = new CapabilitiesWorkspaceLoader(load);
    loader.update(options);
    expect(load).toHaveBeenCalledOnce();
    expect(load.mock.calls[0]?.[0]).toBe("tab-a");
    loader.update({ ...options, active: true });
    expect(load).toHaveBeenCalledOnce();
    expect((load.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(false);
    first.resolve(snapshot(1));
    await settle();
    expect(loader.getState()).toMatchObject({ snapshot: snapshot(1), loading: false, error: null });
    loader.dispose();
  });

  it("immediately retains the last result through page reentry and a failed background refresh", async () => {
    const next = deferred<CapabilitiesWorkspaceSnapshot>();
    const load = vi.fn().mockResolvedValueOnce(snapshot(1)).mockReturnValueOnce(next.promise);
    const loader = new CapabilitiesWorkspaceLoader(load);
    loader.update({ ...options, active: true });
    await settle();
    loader.update(options);
    loader.update({ ...options, active: true });
    expect(load).toHaveBeenCalledTimes(2);
    expect(loader.getState()).toMatchObject({ snapshot: snapshot(1), loading: true });
    next.reject(new Error("暂时无法连接"));
    await settle();
    expect(loader.getState()).toMatchObject({ snapshot: snapshot(1), loading: false, error: "暂时无法连接" });
    loader.dispose();
  });

  it("does not abort work when leaving the page and accepts the finished result in the background", async () => {
    const pending = deferred<CapabilitiesWorkspaceSnapshot>();
    const load = vi.fn().mockReturnValue(pending.promise);
    const loader = new CapabilitiesWorkspaceLoader(load);
    loader.update({ ...options, active: true });
    loader.update(options);
    expect((load.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(false);
    pending.resolve(snapshot(1));
    await settle();
    expect(loader.getState().snapshot).toEqual(snapshot(1));
    loader.dispose();
  });

  it("supersedes a stale preload after a capability update and ignores its late response", async () => {
    const first = deferred<CapabilitiesWorkspaceSnapshot>();
    const second = deferred<CapabilitiesWorkspaceSnapshot>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const loader = new CapabilitiesWorkspaceLoader(load);
    loader.update(options);
    loader.update({ ...options, updateVersion: 1 });
    expect((load.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    second.resolve(snapshot(2));
    await settle();
    first.resolve(snapshot(1));
    await settle();
    expect(loader.getState().snapshot).toEqual(snapshot(2));
    loader.dispose();
  });

  it("clears client-bound state and never accepts an obsolete client's result or error", async () => {
    const old = deferred<CapabilitiesWorkspaceSnapshot>();
    const replacement = deferred<CapabilitiesWorkspaceSnapshot>();
    const load = vi.fn().mockResolvedValueOnce(snapshot(1)).mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const loader = new CapabilitiesWorkspaceLoader(load);
    loader.update(options);
    await settle();
    void loader.refresh();
    loader.update({ ...options, clientId: "tab-b" });
    expect(loader.getState()).toEqual({ clientId: "tab-b", snapshot: null, loading: true, error: null });
    expect((load.mock.calls[1]?.[1] as AbortSignal).aborted).toBe(true);
    old.reject(new Error("旧窗口错误"));
    await settle();
    expect(loader.getState().error).toBeNull();
    replacement.resolve(snapshot(3));
    await settle();
    expect(loader.getState()).toMatchObject({ clientId: "tab-b", snapshot: snapshot(3), error: null });
    loader.dispose();
  });

  it("retains data while disconnected and refreshes on reconnect", async () => {
    const pending = deferred<CapabilitiesWorkspaceSnapshot>();
    const load = vi.fn().mockResolvedValueOnce(snapshot(1)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(snapshot(3));
    const loader = new CapabilitiesWorkspaceLoader(load);
    loader.update(options);
    await settle();
    void loader.refresh();
    loader.update({ ...options, connected: false });
    expect(loader.getState()).toMatchObject({ snapshot: snapshot(1), loading: false });
    expect((load.mock.calls[1]?.[1] as AbortSignal).aborted).toBe(true);
    pending.resolve(snapshot(2));
    await settle();
    expect(loader.getState().snapshot).toEqual(snapshot(1));
    loader.update(options);
    await settle();
    expect(loader.getState().snapshot).toEqual(snapshot(3));
    loader.dispose();
  });

  it("refreshes after the assistant finishes, without restarting requests at the start of a turn", async () => {
    const load = vi.fn().mockResolvedValue(snapshot(1));
    const loader = new CapabilitiesWorkspaceLoader(load);
    loader.update(options);
    await settle();
    loader.update({ ...options, assistantBusy: true });
    expect(load).toHaveBeenCalledOnce();
    loader.update(options);
    expect(load).toHaveBeenCalledTimes(2);
    await settle();
    loader.dispose();
  });

  it("stops disabled preloads and can restart after an effect cleanup", async () => {
    const load = vi.fn().mockResolvedValue(snapshot(1));
    const loader = new CapabilitiesWorkspaceLoader(load);
    loader.update({ ...options, enabled: false });
    await loader.refresh();
    expect(load).not.toHaveBeenCalled();
    loader.update(options);
    await settle();
    loader.dispose();
    loader.update(options);
    expect(load).toHaveBeenCalledTimes(2);
    expect(loader.getState().snapshot).toEqual(snapshot(1));
    await settle();
    loader.dispose();
  });
});
