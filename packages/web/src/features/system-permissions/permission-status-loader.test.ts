import { describe, expect, it, vi } from "vitest";
import type { DesktopSystemPermissions, SystemPermissionStatus } from "@kulo/protocol";
import { PermissionStatusLoader } from "./permission-status-loader";

const microphone: SystemPermissionStatus = { kind: "microphone", state: "granted" };
const snapshot = (state: "granted" | "denied"): DesktopSystemPermissions => ({ platform: "darwin", permissions: [{ kind: "accessibility", state }, { kind: "screen", state }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("permission status refresh", () => {
  it("discards results from a previous execution device and aborts its request", async () => {
    const first = deferred<DesktopSystemPermissions>();
    const second = deferred<DesktopSystemPermissions>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const loader = new PermissionStatusLoader(vi.fn().mockResolvedValue(microphone), load);
    loader.configure("first", true, null);
    loader.configure("second", true, null);
    expect((load.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    second.resolve(snapshot("granted"));
    await settle();
    first.resolve(snapshot("denied"));
    await settle();
    expect(loader.getSnapshot()).toMatchObject({ desktop: snapshot("granted"), checking: false });
    loader.dispose();
  });

  it("keeps microphone checks independent of a failed or disconnected remote device", async () => {
    const load = vi.fn().mockRejectedValue(new Error("device failed"));
    const mic = vi.fn().mockResolvedValue(microphone);
    const loader = new PermissionStatusLoader(mic, load);
    loader.configure("remote", true, null);
    await settle();
    expect(loader.getSnapshot()).toMatchObject({ microphone, desktop: null, desktopError: "device failed", checking: false });
    loader.configure("remote", false, "设备离线");
    await settle();
    expect(load).toHaveBeenCalledOnce();
    expect(mic).toHaveBeenCalledTimes(2);
    expect(loader.getSnapshot()).toMatchObject({ microphone, desktop: null, desktopError: "设备离线" });
    loader.dispose();
  });

  it("finishes client microphone verification while remote desktop status is still pending", async () => {
    const pending = deferred<DesktopSystemPermissions>();
    const mic = vi.fn().mockResolvedValue(microphone);
    const loader = new PermissionStatusLoader(mic, vi.fn().mockReturnValue(pending.promise));
    loader.configure("remote", true, null);
    await settle();
    expect(loader.getSnapshot()).toMatchObject({ microphone, microphoneChecking: false, desktopChecking: true });
    await loader.refreshMicrophone();
    expect(mic).toHaveBeenCalledTimes(2);
    expect(loader.getSnapshot()).toMatchObject({ microphone, microphoneChecking: false, desktopChecking: true });
    pending.resolve(snapshot("denied"));
    await settle();
    loader.dispose();
  });

  it("refreshes desktop permissions independently without re-querying client microphone", async () => {
    const mic = vi.fn().mockResolvedValue(microphone);
    const load = vi.fn().mockResolvedValueOnce(snapshot("denied")).mockResolvedValueOnce(snapshot("granted"));
    const loader = new PermissionStatusLoader(mic, load);
    loader.configure("remote", true, null);
    await settle();
    expect(mic).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    await loader.refreshDesktop();
    expect(mic).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
    expect(loader.getSnapshot()).toMatchObject({ microphone, desktop: snapshot("granted"), checking: false });
    loader.dispose();
  });

  it("accepts only the newest focus/manual refresh and clears obsolete granted state after a query failure", async () => {
    const stale = deferred<DesktopSystemPermissions>();
    const load = vi.fn().mockResolvedValueOnce(snapshot("granted")).mockReturnValueOnce(stale.promise).mockRejectedValueOnce(new Error("connection lost"));
    const loader = new PermissionStatusLoader(vi.fn().mockResolvedValue(microphone), load);
    loader.configure("remote", true, null);
    await settle();
    const oldRefresh = loader.refresh();
    await loader.refresh();
    stale.resolve(snapshot("granted"));
    await oldRefresh;
    expect(loader.getSnapshot()).toMatchObject({ desktop: null, desktopError: "connection lost", checking: false });
    loader.dispose();
  });

  it("ignores pending work after unmount and supports React effect remounts", async () => {
    const pending = deferred<SystemPermissionStatus>();
    const mic = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(microphone);
    const loader = new PermissionStatusLoader(mic, vi.fn());
    loader.configure("", false, "No device");
    loader.dispose();
    pending.resolve(microphone);
    await settle();
    expect(loader.getSnapshot().microphone).toBeNull();
    loader.configure("", false, "No device");
    await settle();
    expect(loader.getSnapshot()).toMatchObject({ microphone, checking: false });
    loader.dispose();
  });
});
