import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../kulo-api";
import { authorizeMicrophone, guideDesktopPermissions, noteMicrophoneAccess, readDesktopPermissions, readMicrophonePermission, requestSystemPermissionHelp } from "./system-permissions";

vi.mock("../../kulo-api", () => ({ apiRequest: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); noteMicrophoneAccess(false); });

function browser(state?: PermissionState) {
  const stop = vi.fn();
  const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
  const query = vi.fn().mockResolvedValue({ state });
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia }, ...(state ? { permissions: { query } } : {}) });
  return { stop, getUserMedia, query };
}

describe("system permission client", () => {
  it("silently reads browser permissions without acquiring the microphone", async () => {
    const device = browser("prompt");
    expect(await readMicrophonePermission()).toEqual({ kind: "microphone", state: "not-determined" });
    expect(device.query).toHaveBeenCalledWith({ name: "microphone" });
    expect(device.getUserMedia).not.toHaveBeenCalled();
  });

  it("does not confuse missing browser query support with a denied grant", async () => {
    const device = browser();
    expect(await readMicrophonePermission()).toEqual({ kind: "microphone", state: "unknown" });
    expect(device.getUserMedia).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: device.getUserMedia }, permissions: { query: vi.fn().mockRejectedValue(new TypeError("Unsupported permission descriptor")) } });
    expect((await readMicrophonePermission()).state).toBe("unknown");
  });

  it("surfaces unexpected permission-query failures", async () => {
    browser("prompt");
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() }, permissions: { query: vi.fn().mockRejectedValue(new Error("query failed")) } });
    await expect(readMicrophonePermission()).rejects.toThrow("query failed");
  });

  it("stops every capture track immediately after an explicit grant", async () => {
    const device = browser("prompt");
    const secondStop = vi.fn();
    device.getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: device.stop }, { stop: secondStop }] });
    expect(await authorizeMicrophone()).toEqual({ kind: "microphone", state: "granted" });
    expect(device.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(device.stop).toHaveBeenCalledOnce();
    expect(secondStop).toHaveBeenCalledOnce();
  });

  it("verifies browser-granted access with a short capture and never re-requests an explicit denial", async () => {
    const granted = browser("granted");
    expect((await authorizeMicrophone()).state).toBe("granted");
    expect(granted.getUserMedia).toHaveBeenCalledOnce();
    expect(granted.stop).toHaveBeenCalledOnce();
    const denied = browser("denied");
    await expect(authorizeMicrophone()).rejects.toThrow("浏览器");
    expect(denied.getUserMedia).not.toHaveBeenCalled();
  });

  it("retains real successful access when a browser cannot query microphone permissions", async () => {
    browser();
    expect((await readMicrophonePermission()).state).toBe("unknown");
    await authorizeMicrophone();
    expect((await readMicrophonePermission()).state).toBe("granted");
    browser("denied");
    expect((await readMicrophonePermission()).state).toBe("denied");
  });

  it("keeps browser-granted status recoverable after an OS-level capture rejection", async () => {
    const device = browser("granted");
    device.getUserMedia.mockRejectedValueOnce(new DOMException("Blocked by system", "NotAllowedError"));
    await expect(authorizeMicrophone()).rejects.toThrow("Blocked by system");
    expect((await readMicrophonePermission()).state).toBe("unknown");
    await authorizeMicrophone();
    expect((await readMicrophonePermission()).state).toBe("granted");
  });

  it("uses the desktop bridge for status and explicit microphone recovery", async () => {
    const device = browser("prompt");
    const status = vi.fn().mockResolvedValue({ platform: "darwin", permissions: [{ kind: "microphone", state: "denied" }] });
    const requestMicrophone = vi.fn().mockResolvedValue({ platform: "darwin", permissions: [{ kind: "microphone", state: "denied" }] });
    vi.stubGlobal("window", { kuloDesktop: { systemPermissions: { status, requestMicrophone } } });
    expect((await readMicrophonePermission()).state).toBe("denied");
    expect(requestMicrophone).not.toHaveBeenCalled();
    expect((await authorizeMicrophone()).state).toBe("denied");
    expect(requestMicrophone).toHaveBeenCalledOnce();
    expect(device.query).not.toHaveBeenCalled();
    expect(device.getUserMedia).not.toHaveBeenCalled();
  });

  it("validates remote results and never treats starting a guide as authorization", async () => {
    const snapshot = { platform: "darwin", permissions: [{ kind: "accessibility", state: "denied" }, { kind: "screen", state: "unknown" }] };
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...snapshot, guide: "started" }).mockResolvedValueOnce({ platform: "darwin", permissions: [{ kind: "accessibility", state: "granted" }] });
    const guided = await guideDesktopPermissions("remote/id", "screen");
    expect(apiRequest).toHaveBeenCalledWith("/api/envs/remote%2Fid/system-permissions/guide", { method: "POST", body: { kind: "screen" }, signal: undefined });
    expect(guided.permissions.map((permission) => permission.state)).toEqual(["denied", "unknown"]);
    await expect(readDesktopPermissions("remote/id")).rejects.toThrow("无效");
  });

  it("passes only the requested permission and device to the first-use entry", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    requestSystemPermissionHelp({ kind: "screen", envId: "remote" });
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe("kulo:system-permission-help");
    expect(event.detail).toEqual({ kind: "screen", envId: "remote" });
  });
});
