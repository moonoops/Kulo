import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseService, computerUseConfiguration } from "../packages/env/src/computer-use.js";
import { AgentCliError, type AgentCliInvocation, type AgentCliRunner } from "../packages/env/src/agent-cli.js";

const roots: string[] = [];
const services: ComputerUseService[] = [];
const browserSnapshot = { success: true, data: { snapshot: '- textbox "Name" [ref=e1]', refs: { e1: { role: "textbox", name: "Name" } } } };
const desktopSnapshot = { ok: true, data: { app: "TextEdit", snapshot_id: "s123", complete: true, tree: { role: "window", children: [{ role: "textbox", ref_id: "@s123:e1" }] } } };

function fixture(options: { platform?: NodeJS.Platform; browserEnabled?: boolean; desktopEnabled?: boolean; runner?: AgentCliRunner } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-computer-use-"));
  roots.push(rootDir);
  const runner = vi.fn<AgentCliRunner>(options.runner ?? (async (request) => {
    if (request.tool === "agent-browser") {
      if (request.args.includes("doctor")) return { success: true, checks: [{ id: "chrome.binary", status: "pass" }], summary: { pass: 1 } };
      if (request.args.includes("snapshot")) return structuredClone(browserSnapshot);
      if (request.args.includes("batch")) return [{ index: 0, success: true, result: { value: "input should be omitted" } }];
      return { success: true, data: {} };
    }
    if (request.args.includes("snapshot")) return structuredClone(desktopSnapshot);
    return { ok: true, data: { accessibility: { state: "granted" } } };
  }));
  const service = new ComputerUseService({ rootDir, platform: "darwin", browserEnabled: true, desktopEnabled: true, ...options, runner });
  services.push(service);
  return { service, runner, rootDir };
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.close().catch(() => {});
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Env computer-use configuration and status", () => {
  it("allocates its short browser socket directory only for an actual browser invocation", async () => {
    const f = fixture();
    const namespace = createHash("sha256").update(f.service.rootDir).digest("hex").slice(0,12);
    const socketDirectory = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `mab-${namespace}`);
    roots.push(socketDirectory);
    expect(fs.existsSync(socketDirectory)).toBe(false);
    expect(await f.service.request({ tool: "desktop", action: "status" })).toMatchObject({ ok: true });
    expect(fs.existsSync(socketDirectory)).toBe(false);
    expect(await f.service.request({ tool: "browser", action: "status" })).toMatchObject({ ok: true });
    expect(fs.statSync(socketDirectory).isDirectory()).toBe(true);
    expect(f.runner.mock.calls.at(-1)![0].env?.AGENT_BROWSER_SOCKET_DIR).toBe(socketDirectory);
  });

  it("routes private Mac applications through their connection grants and rejects selector aliases", async () => {
    const f = fixture();
    for (const app of ["Messages", "messages", "信息", "消息", "com.apple.MobileSMS", "com.apple.iChat", "Mail", "邮件", "com.apple.mail"]) {
      expect(await f.service.request({ tool: "desktop", action: "snapshot", app, sessionId: "private-app" })).toMatchObject({ ok: false, error: { code: "APPLICATION_CONNECTION_REQUIRED" } });
    }
    expect(await f.service.request({ tool: "desktop", action: "snapshot", app: "Me\u200Essages", sessionId: "bidi-app" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(f.runner).not.toHaveBeenCalled();
    expect(await f.service.request({ tool: "desktop", action: "snapshot", app: "TextEdit", sessionId: "ordinary-app" })).toMatchObject({ ok: true });
    const windows = fixture({ platform: "win32" });
    expect(await windows.service.request({ tool: "desktop", action: "snapshot", app: "Mail", sessionId: "windows-mail" })).toMatchObject({ ok: true });
  });

  it("enables browser and desktop by default and respects explicit tool names", () => {
    expect(computerUseConfiguration(undefined)).toEqual({ browserEnabled: true, desktopEnabled: true });
    expect(computerUseConfiguration("")).toEqual({ browserEnabled: false, desktopEnabled: false });
    expect(computerUseConfiguration("browser")).toEqual({ browserEnabled: true, desktopEnabled: false });
    expect(computerUseConfiguration("desktop")).toEqual({ browserEnabled: false, desktopEnabled: true });
    expect(computerUseConfiguration(" browser, desktop ")).toEqual({ browserEnabled: true, desktopEnabled: true });
    expect(() => computerUseConfiguration("all")).toThrow("KULO_COMPUTER_USE");
    const { service, runner } = fixture({ browserEnabled: false, desktopEnabled: false });
    expect(service.capabilities()).toEqual([]);
    return expect(service.request({ tool: "browser", action: "status" }).then((result) => { expect(runner).not.toHaveBeenCalled(); return result; })).resolves.toMatchObject({ ok: false, error: { code: "CAPABILITY_DISABLED" } });
  });

  it("refuses Android regardless of architecture or configured names", async () => {
    const { service, runner } = fixture({ platform: "android" });
    expect(service.capabilities()).toEqual([]);
    expect(await service.request({ tool: "desktop", action: "status" })).toMatchObject({ platform: "android", ok: false, error: { code: "PLATFORM_NOT_SUPPORTED" } });
    expect(runner).not.toHaveBeenCalled();
  });

  it("uses passive diagnostics without asking for OS permissions or launching Chrome", async () => {
    const { service, runner } = fixture();
    expect(await service.request({ tool: "browser", action: "status" })).toMatchObject({ ok: true, data: { installed: true, diagnosticsPassed: true, executionVerified: false } });
    expect(await service.request({ tool: "desktop", action: "status" })).toMatchObject({ ok: true, data: { status: { accessibility: { state: "granted" } } } });
    expect(runner.mock.calls[0]![0].args).toEqual(expect.arrayContaining(["doctor", "--quick", "--offline", "--json"]));
    expect(runner.mock.calls[1]![0].args).toEqual(["status"]);
  });

  it("distinguishes an installed tool from a ready browser and preserves desktop permission failures", async () => {
    const { service } = fixture({ runner: async (request) => request.tool === "agent-browser"
      ? { success: false, checks: [{ id: "chrome.binary", status: "fail", message: "Install system Chromium" }], summary: { fail: 1 } }
      : { ok: false, error: { code: "PERM_DENIED", message: "No D-Bus session bus is reachable" } } });
    expect(await service.request({ tool: "browser", action: "status" })).toMatchObject({ ok: true, data: { installed: true, diagnosticsPassed: false, executionVerified: false } });
    expect(await service.request({ tool: "desktop", action: "status" })).toMatchObject({ ok: false, error: { code: "PERM_DENIED", message: "No D-Bus session bus is reachable" } });
  });
});

describe("managed browser sessions", () => {
  it("requires its own session and a fresh snapshot for every action", async () => {
    const { service, runner } = fixture();
    expect(await service.request({ tool: "browser", action: "snapshot", sessionId: "one" })).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    await service.request({ tool: "browser", action: "open", sessionId: "one", url: "https://example.com" });
    expect(await service.request({ tool: "browser", action: "click", sessionId: "one", ref: "e1" })).toMatchObject({ ok: false, error: { code: "REF_NOT_AUTHORIZED" } });
    await service.request({ tool: "browser", action: "snapshot", sessionId: "one" });
    expect(await service.request({ tool: "browser", action: "click", sessionId: "one", ref: "@e1" })).toMatchObject({ ok: true });
    expect(await service.request({ tool: "browser", action: "click", sessionId: "one", ref: "e1" })).toMatchObject({ ok: false, error: { code: "REF_NOT_AUTHORIZED" } });
    expect(runner.mock.calls.map(([call]) => call.args).every((args) => !args.includes("--auto-connect") && !args.includes("--cdp") && !args.includes("eval"))).toBe(true);
  });

  it("sends literal text through batch stdin and omits echoed input", async () => {
    const { service, runner } = fixture();
    await service.request({ tool: "browser", action: "open", sessionId: "one", url: "https://example.com" });
    await service.request({ tool: "browser", action: "snapshot", sessionId: "one" });
    const text = "--json $(do-not-execute)\nprivate text";
    const result = await service.request({ tool: "browser", action: "fill", sessionId: "one", ref: "e1", text });
    const call = runner.mock.calls.at(-1)![0];
    expect(call.args).toEqual(expect.arrayContaining(["batch", "--omit-command"]));
    expect(call.args.join(" ")).not.toContain(text);
    expect(JSON.parse(call.input!)).toEqual([["fill", "@e1", "--", text]]);
    expect(result).toMatchObject({ ok: true, data: { actionAccepted: true, observationRequired: true } });
    expect(JSON.stringify(result)).not.toContain("input should be omitted");
  });

  it("caps browser instances and releases a slot after closing its browser", async () => {
    const { service } = fixture();
    for (const sessionId of ["one", "two"]) await service.request({ tool: "browser", action: "open", sessionId, url: "https://example.com" });
    expect(await service.request({ tool: "browser", action: "open", sessionId: "three", url: "https://example.com" })).toMatchObject({ ok: false, error: { code: "SESSION_LIMIT" } });
    await service.request({ tool: "browser", action: "close", sessionId: "one" });
    expect(await service.request({ tool: "browser", action: "open", sessionId: "three", url: "https://example.com" })).toMatchObject({ ok: true });
  });

  it("makes browser cleanup idempotent without launching unknown sessions", async () => {
    const { service, runner } = fixture();
    expect(await service.request({ tool: "browser", action: "close", sessionId: "never-opened" })).toMatchObject({ ok: true, data: { closed: true } });
    await service.request({ tool: "browser", action: "open", sessionId: "one", url: "https://example.com" });
    await service.request({ tool: "browser", action: "close", sessionId: "one" });
    expect(await service.request({ tool: "browser", action: "close", sessionId: "one" })).toMatchObject({ ok: true, data: { closed: true } });
    expect(runner.mock.calls.filter(([request]) => request.args.includes("close"))).toHaveLength(1);
  });

  it("does not inherit a user's CDP target, profile, init scripts or cloud credentials", async () => {
    vi.stubEnv("AGENT_BROWSER_CDP", "wss://private-target?token=secret");
    vi.stubEnv("AGENT_BROWSER_PROFILE", "/private-profile");
    vi.stubEnv("AGENT_BROWSER_INIT_SCRIPTS", "/private-script");
    vi.stubEnv("AI_GATEWAY_API_KEY", "private-key");
    const { service, runner, rootDir } = fixture();
    await service.request({ tool: "browser", action: "status" });
    const invocation = runner.mock.calls[0]![0];
    expect(invocation.env).not.toHaveProperty("AGENT_BROWSER_CDP");
    expect(invocation.env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
    expect(invocation.env).not.toHaveProperty("AGENT_BROWSER_INIT_SCRIPTS");
    expect(invocation.env).not.toHaveProperty("AI_GATEWAY_API_KEY");
    expect(JSON.parse(fs.readFileSync(path.join(rootDir, "browser.json"), "utf8"))).toMatchObject({ autoConnect: false, headed: false, noWebmcp: true, allowFileAccess: false, idleTimeout: "5m", maxOutput: 48_000 });
  });

  it.skipIf(process.platform === "win32")("keeps maximum session ids within Unix socket path limits", async () => {
    const { service, runner } = fixture();
    await service.request({ tool: "browser", action: "status" });
    const environment = runner.mock.calls[0]![0].env!;
    expect(environment.AGENT_BROWSER_NAMESPACE).toBeUndefined();
    expect(Buffer.byteLength(path.join(environment.AGENT_BROWSER_SOCKET_DIR!, "s".repeat(64) + ".sock")) + 8).toBeLessThanOrEqual(103);
  });
});

describe("desktop semantic operations", () => {
  it("keeps noninteractive feedback in snapshots for post-action verification", async () => {
    const { service } = fixture({ runner: async (request) => ({ ok: true, data: { tree: { role: "window", children: [
      { role: "button", name: "Save", ref_id: "@s123:e1" },
      ...request.args.includes("-i") ? [] : [{ role: "text", name: "Saved successfully" }],
    ] } } }) });
    const result = await service.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "TextEdit" });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain("Saved successfully");
  });

  it("binds refs to the exact app and session and does not enable physical input", async () => {
    const { service, runner } = fixture();
    await service.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "TextEdit" });
    for (const input of [{ sessionId: "two", app: "TextEdit" }, { sessionId: "one", app: "Finder" }]) {
      expect(await service.request({ tool: "desktop", action: "click", ...input, ref: "@s123:e1" })).toMatchObject({ ok: false, error: { code: "REF_NOT_AUTHORIZED" } });
    }
    expect(await service.request({ tool: "desktop", action: "set-value", sessionId: "one", app: "TextEdit", ref: "@s123:e1", text: "private text" })).toMatchObject({ ok: true });
    const invocation = runner.mock.calls.at(-1)![0];
    expect(invocation.args).toEqual(["--session", "one", "set-value", "@s123:e1", "--stdin"]);
    expect(invocation.input).toBe("private text");
    expect(invocation.args).not.toContain("--headed");
    expect(await service.request({ tool: "desktop", action: "click", sessionId: "one", app: "TextEdit", ref: "@s123:e1" })).toMatchObject({ ok: false, error: { code: "REF_NOT_AUTHORIZED" } });
  });

  it("closes the namespace without closing the target app", async () => {
    const { service, runner, rootDir } = fixture();
    await service.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "TextEdit" });
    const directory = path.join(rootDir, "desktop", "sessions", "one");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "private-refmap.json"), "{}");
    expect(await service.request({ tool: "desktop", action: "close", sessionId: "one" })).toMatchObject({ ok: true });
    expect(fs.existsSync(directory)).toBe(false);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("enforces the desktop native UTF-8 byte limit before invoking the tool", async () => {
    const { service, runner } = fixture();
    await service.request({ tool: "desktop", action: "snapshot", sessionId: "one", app: "TextEdit" });
    expect(await service.request({ tool: "desktop", action: "type", sessionId: "one", app: "TextEdit", ref: "@s123:e1", text: "文".repeat(4000) })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(runner).toHaveBeenCalledOnce();
  });
});

describe("computer-use cancellation and bounded responses", () => {
  it("records browser ownership before spawning and reaps it after an Env restart", async () => {
    const original = fixture();
    await original.service.request({ tool: "browser", action: "open", sessionId: "old-run", url: "https://example.com" });
    const journal = path.join(original.rootDir, "browser-sessions.json");
    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).toEqual({ version: 1, sessions: ["old-run"] });
    services.splice(services.indexOf(original.service), 1); // The old Env process disappeared without cleanup.
    const closing = Promise.withResolvers<void>();
    const runner = vi.fn<AgentCliRunner>(async (request) => {
      if (request.args.includes("close")) await closing.promise;
      if (request.args.includes("open")) expect(JSON.parse(fs.readFileSync(journal, "utf8")).sessions).toContain("new-run");
      return { success: true, data: {} };
    });
    const restarted = new ComputerUseService({ rootDir: original.rootDir, browserEnabled: true, runner });
    services.push(restarted);
    const opening = restarted.request({ tool: "browser", action: "open", sessionId: "new-run", url: "https://example.com" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]![0].args).toEqual(expect.arrayContaining(["--session", "old-run", "close"]));
    closing.resolve();
    expect(await opening).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).toEqual({ version: 1, sessions: ["new-run"] });
    expect(runner.mock.calls.flatMap(([request]) => request.args)).not.toContain("--all");
  });

  it("keeps passive status and cleanup retries available after a transient close failure", async () => {
    let closing = 0;
    const { service, rootDir } = fixture({ runner: async (request) => {
      if (request.args.includes("close") && ++closing === 1) throw new AgentCliError("CLI_TIMEOUT", "close timed out");
      if (request.args.includes("doctor")) return { success: true, checks: [], summary: {} };
      return { success: true, data: {} };
    } });
    await service.request({ tool: "browser", action: "open", sessionId: "one", url: "https://example.com" });
    await expect(service.suspend()).rejects.toThrow("could not be closed");
    expect(await service.request({ tool: "browser", action: "status" })).toMatchObject({ ok: true, data: { cleanupPending: true } });
    expect(await service.request({ tool: "browser", action: "close", sessionId: "one" })).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(path.join(rootDir, "browser-sessions.json"), "utf8"))).toEqual({ version: 1, sessions: [] });
    expect(await service.request({ tool: "browser", action: "open", sessionId: "two", url: "https://example.com" })).toMatchObject({ ok: true });
  });

  it("rejects forged, public or symlinked ownership journals", () => {
    const original = fixture();
    const journal = path.join(original.rootDir, "browser-sessions.json");
    fs.writeFileSync(journal, JSON.stringify({ version: 1, sessions: ["../foreign"] }), { mode: 0o600 });
    expect(() => new ComputerUseService({ rootDir: original.rootDir })).toThrow("Invalid managed browser journal");
    fs.unlinkSync(journal);
    fs.symlinkSync(path.join(original.rootDir, "missing-file"), journal);
    expect(() => new ComputerUseService({ rootDir: original.rootDir })).toThrow("regular private file");
    fs.unlinkSync(journal);
    fs.writeFileSync(journal, JSON.stringify({ version: 1, sessions: ["one"] }), { mode: 0o644 });
    if (process.platform !== "win32") expect(() => new ComputerUseService({ rootDir: original.rootDir })).toThrow("must be private");
  });

  it("rechecks authorization after waiting in the session queue", async () => {
    let release!: () => void;
    const started = Promise.withResolvers<void>();
    const { service, runner } = fixture({ runner: async (request) => {
      if (request.args.includes("open")) { started.resolve(); await new Promise<void>((resolve) => { release = resolve; }); }
      return { success: true, data: {} };
    } });
    const first = service.request({ tool: "browser", action: "open", sessionId: "one", url: "https://example.com" });
    await started.promise;
    let active = true;
    const queued = service.request({ tool: "browser", action: "back", sessionId: "one" }, () => active);
    active = false; release();
    await first;
    expect(await queued).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("aborts one in-flight request and does not replay its action", async () => {
    const started = Promise.withResolvers<void>();
    const { service, runner } = fixture({ runner: async (request) => {
      if (request.args.includes("open")) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(new AgentCliError("CLI_ABORTED", "cancelled")), { once: true }));
      }
      return { success: true, data: {} };
    } });
    const controller = new AbortController();
    const pending = service.request({ tool: "browser", action: "open", sessionId: "one", url: "https://example.com" }, () => true, controller.signal);
    await started.promise;
    const queued = service.request({ tool: "browser", action: "back", sessionId: "one" });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "CLI_ABORTED" } });
    expect(await queued).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });
    expect(runner).toHaveBeenCalledOnce();
    await service.suspend();
    expect(runner.mock.calls.at(-1)![0].args).toContain("close");
  });

  it("cancels queued work and cleans only owned browser sessions on disconnect", async () => {
    const { service, runner } = fixture();
    await service.request({ tool: "browser", action: "open", sessionId: "one", url: "https://example.com" });
    const queued = service.request({ tool: "browser", action: "snapshot", sessionId: "one" });
    await service.suspend();
    expect(await queued).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });
    expect(runner.mock.calls.filter(([invocation]) => invocation.args.includes("close"))).toHaveLength(1);
    expect(await service.request({ tool: "browser", action: "open", sessionId: "two", url: "https://example.com" })).toMatchObject({ ok: true });
  });

  it("rejects oversized or malformed native responses", async () => {
    const { service } = fixture({ runner: async () => ({ ok: true, data: "x".repeat(1024 * 1024) }) });
    expect(await service.request({ tool: "desktop", action: "status" })).toMatchObject({ ok: false, error: { code: "CLI_OUTPUT_LIMIT" } });
    const invalid = fixture({ runner: async () => ({ data: { success: true } }) });
    expect(await invalid.service.request({ tool: "desktop", action: "status" })).toMatchObject({ ok: false, error: { code: "CLI_INVALID_OUTPUT" } });
  });

  it("rejects arbitrary commands at the request boundary", async () => {
    const { service, runner } = fixture();
    await expect(service.request({ tool: "browser", action: "eval", sessionId: "one", code: "secret" } as never)).rejects.toThrow("Invalid computer-use request");
    expect(runner).not.toHaveBeenCalled();
  });
});
