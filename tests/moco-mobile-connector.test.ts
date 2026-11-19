import { execFile, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSystemTailscale } from "../packages/hub/src/mobile-connector.js";

vi.mock("node:child_process", async () => ({
  ...await vi.importActual<typeof import("node:child_process")>("node:child_process"),
  execFile: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

function result(stdout: string, error: Error | null = null) {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(error, stdout, "");
    return {} as ChildProcess;
  }) as typeof execFile);
}

describe("read-only system Tailscale discovery", () => {
  it("advertises only verified tailnet addresses of a Running node", async () => {
    result(JSON.stringify({ BackendState: "Running", TailscaleIPs: ["100.90.0.8", "fd7a:115c:a1e0::8", "192.168.0.8", "100.250.0.8", "100.90.999.8"] }));
    expect(await discoverSystemTailscale()).toEqual({ known: true, origins: ["https://100.90.0.8", "https://[fd7a:115c:a1e0::8]"] });
    expect(vi.mocked(execFile).mock.calls.every((call) => JSON.stringify(call[1]) === '["status","--json"]')).toBe(true);
  });
  it.each(["Stopped", "NeedsLogin", "NeedsMachineAuth"])("distinguishes confirmed %s from a failed status query", async (BackendState) => {
    result(JSON.stringify({ BackendState, TailscaleIPs: ["100.90.0.8"] }));
    expect(await discoverSystemTailscale()).toEqual({ known: true, origins: [] });
  });
  it("does not clear existing candidates merely because local status failed", async () => {
    result("", new Error("Local query unavailable"));
    expect(await discoverSystemTailscale()).toEqual({ known: false, origins: [] });
  });
  it("keeps malformed or incomplete status unknown", async () => {
    result('{"BackendState":"Running"}');
    expect(await discoverSystemTailscale()).toEqual({ known: false, origins: [] });
  });
});
