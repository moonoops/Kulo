import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isComputerUseRequest, isDesktopSystemPermissions } from "@kulo/protocol";
import { ComputerUseService, macosDesktopPermissionSettingsUrl } from "../packages/env/src/computer-use.js";
import type { AgentCliRunner } from "../packages/env/src/agent-cli.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(
  runner: AgentCliRunner,
  options: { platform?: NodeJS.Platform; desktopEnabled?: boolean; openSystemSettings?: (url: string, signal?: AbortSignal) => Promise<void> } = {},
) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-system-permissions-"));
  cleanup.push(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const run = vi.fn(runner);
  const openSystemSettings = vi.fn(options.openSystemSettings ?? (async () => {}));
  const service = new ComputerUseService({ rootDir, platform: "darwin", desktopEnabled: true, runner: run, ...options, openSystemSettings });
  cleanup.push(() => service.close());
  return { service, run, openSystemSettings };
}

const states = { accessibility: { state: "denied" }, screen_recording: { state: "granted" } };
const snapshot = { platform: "darwin", permissions: [{ kind: "accessibility", state: "denied" }, { kind: "screen", state: "granted" }] };

describe("system permission protocol", () => {
  it("permits only the two management desktop operations without a session or arbitrary flags", () => {
    for (const action of ["permissions", "permission-guide"]) {
      expect(isComputerUseRequest({ tool: "desktop", action })).toBe(true);
      expect(isComputerUseRequest({ tool: "browser", action })).toBe(false);
      expect(isComputerUseRequest({ tool: "desktop", action, sessionId: "task-session" })).toBe(false);
      expect(isComputerUseRequest({ tool: "desktop", action, request: true })).toBe(false);
    }
    expect(isComputerUseRequest({ tool: "desktop", action: "permission-guide", kind: "accessibility" })).toBe(true);
    expect(isComputerUseRequest({ tool: "desktop", action: "permission-guide", kind: "screen" })).toBe(true);
    expect(isComputerUseRequest({ tool: "desktop", action: "permission-guide", kind: "microphone" })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "permissions", kind: "accessibility" })).toBe(false);
    expect(isComputerUseRequest({ tool: "desktop", action: "permissions --request" })).toBe(false);
  });

  it("requires both distinct desktop permission states and rejects malformed receipts", () => {
    expect(isDesktopSystemPermissions(snapshot)).toBe(true);
    expect(isDesktopSystemPermissions({ ...snapshot, guide: "started" })).toBe(true);
    expect(isDesktopSystemPermissions({ ...snapshot, guide: "granted" })).toBe(false);
    expect(isDesktopSystemPermissions({ ...snapshot, permissions: [snapshot.permissions[0], snapshot.permissions[0]] })).toBe(false);
    expect(isDesktopSystemPermissions({ ...snapshot, permissions: [{ kind: "microphone", state: "granted" }, snapshot.permissions[1]] })).toBe(false);
    expect(isDesktopSystemPermissions({ ...snapshot, permissions: [{ kind: "accessibility", state: true }, snapshot.permissions[1]] })).toBe(false);
    expect(isDesktopSystemPermissions({ ...snapshot, native: states })).toBe(false);
  });
});

describe("Env system permissions", () => {
  it("queries silently and exposes only normalized desktop permission states", async () => {
    const f = fixture(async () => ({ ok: true, data: { ...states, automation: { state: "unknown", private: "do-not-forward" }, launcher: "/private-path" } }));
    const result = await f.service.request({ tool: "desktop", action: "permissions" });
    expect(result).toMatchObject({ ok: true, data: snapshot });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0]![0].args).toEqual(["permissions"]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("opens macOS System Settings directly without launching agent-desktop's overlay guide", async () => {
    const f = fixture(async () => ({ ok: true, data: states }));
    expect(await f.service.request({ tool: "desktop", action: "permission-guide", kind: "accessibility" })).toMatchObject({ ok: true, data: { ...snapshot, guide: "started" } });
    expect(f.openSystemSettings).toHaveBeenCalledOnce();
    expect(f.openSystemSettings.mock.calls[0]![0]).toBe(macosDesktopPermissionSettingsUrl("accessibility"));
    expect(f.run.mock.calls.map(([call]) => call.args)).toEqual([["permissions"], ["permissions"]]);
    expect(f.run.mock.calls.some(([call]) => call.args.includes("--guide") || call.args.includes("--request"))).toBe(false);
  });

  it("skips opening System Settings when the requested desktop permission is already granted", async () => {
    const f = fixture(async () => ({ ok: true, data: states }));
    expect(await f.service.request({ tool: "desktop", action: "permission-guide", kind: "screen" })).toMatchObject({ ok: true, data: { ...snapshot, guide: "not_needed" } });
    expect(f.openSystemSettings).not.toHaveBeenCalled();
    expect(f.run.mock.calls.map(([call]) => call.args)).toEqual([["permissions"]]);
  });

  it("opens the matching Settings pane for legacy guide requests without kind and selects version-appropriate URLs", async () => {
    expect(macosDesktopPermissionSettingsUrl("accessibility", "26.0.0")).toBe("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility");
    expect(macosDesktopPermissionSettingsUrl("screen", "22.0.0")).toBe("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture");
    expect(macosDesktopPermissionSettingsUrl("accessibility", "21.6.0")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    expect(macosDesktopPermissionSettingsUrl("screen", "21.6.0")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");

    const screenPending = { accessibility: { state: "granted" }, screen_recording: { state: "denied" } };
    const f = fixture(async () => ({ ok: true, data: screenPending }));
    expect(await f.service.request({ tool: "desktop", action: "permission-guide" })).toMatchObject({
      ok: true,
      data: { platform: "darwin", permissions: [{ kind: "accessibility", state: "granted" }, { kind: "screen", state: "denied" }], guide: "started" },
    });
    expect(f.openSystemSettings).toHaveBeenCalledWith(macosDesktopPermissionSettingsUrl("screen"), expect.any(AbortSignal));
  });

  it("keeps future native states unknown and rejects missing permission fields", async () => {
    const future = fixture(async () => ({ ok: true, data: { ...states, accessibility: { state: "future-native-state" } } }));
    expect(await future.service.request({ tool: "desktop", action: "permissions" })).toMatchObject({ ok: true, data: { permissions: [{ kind: "accessibility", state: "unknown" }, { kind: "screen", state: "granted" }] } });
    const malformed = fixture(async () => ({ ok: true, data: { accessibility: { state: "granted" } } }));
    expect(await malformed.service.request({ tool: "desktop", action: "permissions" })).toMatchObject({ ok: false, error: { code: "CLI_INVALID_OUTPUT" } });
  });

  it("reports failure without rechecking or escalating when System Settings cannot be opened", async () => {
    const f = fixture(async () => ({ ok: true, data: states }), {
      openSystemSettings: async () => { throw new Error("open failed"); },
    });
    expect(await f.service.request({ tool: "desktop", action: "permission-guide", kind: "accessibility" })).toMatchObject({ ok: false, error: { code: "OPERATION_FAILED" } });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0]![0].args).toEqual(["permissions"]);
  });

  it.each(["linux", "win32"] as const)("returns unsupported on %s without invoking a native permissions command", async (platform) => {
    const f = fixture(async () => { throw new Error("Native permissions must not run"); }, { platform });
    expect(await f.service.request({ tool: "desktop", action: "permissions" })).toMatchObject({ ok: true, data: {
      platform, permissions: [{ kind: "accessibility", state: "unsupported" }, { kind: "screen", state: "unsupported" }],
    } });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("keeps a disabled desktop capability unavailable", async () => {
    const f = fixture(async () => ({ ok: true, data: states }), { desktopEnabled: false });
    expect(await f.service.request({ tool: "desktop", action: "permission-guide" })).toMatchObject({ ok: false, error: { code: "CAPABILITY_DISABLED" } });
    expect(f.run).not.toHaveBeenCalled();
  });
});
