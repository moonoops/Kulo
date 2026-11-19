import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isComputerUseRequest, isDesktopSystemPermissions } from "@kulo/protocol";
import { ComputerUseService } from "../packages/env/src/computer-use.js";
import type { AgentCliRunner } from "../packages/env/src/agent-cli.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(runner: AgentCliRunner, options: { platform?: NodeJS.Platform; desktopEnabled?: boolean } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-system-permissions-"));
  cleanup.push(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const run = vi.fn(runner);
  const service = new ComputerUseService({ rootDir, platform: "darwin", desktopEnabled: true, runner: run, ...options });
  cleanup.push(() => service.close());
  return { service, run };
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

  it("opens the native guide only on an explicit request and rechecks instead of assuming a grant", async () => {
    const f = fixture(async (call) => ({ ok: true, data: call.args.includes("--guide") ? { guide: "started" } : states }));
    expect(await f.service.request({ tool: "desktop", action: "permission-guide" })).toMatchObject({ ok: true, data: { ...snapshot, guide: "started" } });
    expect(f.run.mock.calls.map(([call]) => call.args)).toEqual([["permissions", "--guide"], ["permissions"]]);
    expect(f.run.mock.calls.some(([call]) => call.args.includes("--request"))).toBe(false);
  });

  it("keeps future native states unknown and rejects missing permission fields", async () => {
    const future = fixture(async () => ({ ok: true, data: { ...states, accessibility: { state: "future-native-state" } } }));
    expect(await future.service.request({ tool: "desktop", action: "permissions" })).toMatchObject({ ok: true, data: { permissions: [{ kind: "accessibility", state: "unknown" }, { kind: "screen", state: "granted" }] } });
    const malformed = fixture(async () => ({ ok: true, data: { accessibility: { state: "granted" } } }));
    expect(await malformed.service.request({ tool: "desktop", action: "permissions" })).toMatchObject({ ok: false, error: { code: "CLI_INVALID_OUTPUT" } });
  });

  it("does not retry an unconfirmed guide or escalate to a system permission request", async () => {
    const f = fixture(async () => ({ ok: true, data: { guide: "unconfirmed" } }));
    expect(await f.service.request({ tool: "desktop", action: "permission-guide" })).toMatchObject({ ok: false, error: { code: "CLI_INVALID_OUTPUT" } });
    expect(f.run).toHaveBeenCalledOnce();
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
