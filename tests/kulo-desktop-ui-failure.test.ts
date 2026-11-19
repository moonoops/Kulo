import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureDesktopUiFailureHandler, type DesktopUiFailureContents } from "../packages/desktop/src/ui-failure.js";

type ConsoleDetails = { level: string; sourceId: string; frame: { origin: string } };
type NavigationDetails = { isMainFrame: boolean; isSameDocument: boolean };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function handlerFixture() {
  const origin = "http://127.0.0.1:7799";
  let booting = false, quitting = false, destroyed = false, rendererOrigin: string | undefined = origin;
  let consoleListener!: (details: ConsoleDetails) => void, navigationListener!: (details: NavigationDetails) => void;
  const checks: { world: number; scripts: { code: string }[]; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const contents = {
    mainFrame: { origin },
    isDestroyed: () => destroyed,
    on(event: string, listener: unknown) {
      if (event === "console-message") consoleListener = listener as typeof consoleListener;
      else if (event === "did-start-navigation") navigationListener = listener as typeof navigationListener;
      else throw new Error("Unexpected monitor event: " + event);
    },
    executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]) {
      return new Promise<unknown>((resolve, reject) => { checks.push({ world, scripts, resolve, reject }); });
    },
  } satisfies DesktopUiFailureContents;
  const failStartup = vi.fn(), recover = vi.fn(async (_message: string) => {}), checkFailed = vi.fn();
  configureDesktopUiFailureHandler({ contents, rendererOrigin: () => rendererOrigin,
    isBooting: () => booting, isQuitting: () => quitting, failStartup, recover, checkFailed });
  return { origin, contents, checks, failStartup, recover, checkFailed,
    emit(overrides: Partial<ConsoleDetails> = {}) { consoleListener({ level: "error", sourceId: origin + "/assets/app.js", frame: contents.mainFrame, ...overrides }); },
    native(details: ConsoleDetails) { consoleListener(details); },
    navigate(details: NavigationDetails) { navigationListener(details); },
    booting(value: boolean) { booting = value; }, quitting(value: boolean) { quitting = value; },
    destroyed(value: boolean) { destroyed = value; }, originValue(value: string | undefined) { rendererOrigin = value; } };
}

describe("native desktop UI failure monitoring", () => {
  it("cancels startup or recovers a ready document only after a true blank result", async () => {
    const startup = handlerFixture();
    startup.booting(true);
    startup.emit();
    expect(startup.failStartup).not.toHaveBeenCalled();
    startup.checks[0]!.resolve(true);
    await settle();
    expect(startup.failStartup).toHaveBeenCalledWith(expect.objectContaining({ message: "界面脚本错误后未能继续显示。" }));
    expect(startup.recover).not.toHaveBeenCalled();
    const ready = handlerFixture();
    ready.emit();
    ready.checks[0]!.resolve(true);
    await settle();
    expect(ready.recover).toHaveBeenCalledWith("界面脚本错误后未能继续显示。");
    expect(ready.failStartup).not.toHaveBeenCalled();
  });

  it("ignores other levels, child frames, foreign scripts and untrusted origins", () => {
    const f = handlerFixture();
    for (const level of ["verbose", "info", "warning", "3"]) f.emit({ level });
    f.emit({ frame: { origin: f.origin } });
    for (const sourceId of ["https://example.com/app.js", "http://127.0.0.1:7800/app.js", "http://localhost:7799/app.js", "file:///tmp/app.js", "", "/assets/app.js", "http://user:password@127.0.0.1:7799/app.js"]) f.emit({ sourceId });
    for (const origin of [undefined, "https://example.com", "http://localhost:7799", "http://127.0.0.1:7799/path", "http://user:password@127.0.0.1:7799"]) {
      f.originValue(origin);
      f.contents.mainFrame.origin = origin ?? "null";
      f.emit({ sourceId: (origin ?? "") + "/assets/app.js" });
    }
    expect(f.checks).toHaveLength(0);
    expect(f.recover).not.toHaveBeenCalled();
  });

  it("keeps rendered UI running, coalesces in-flight checks and reports once per document", async () => {
    const f = handlerFixture();
    f.emit(); f.emit();
    expect(f.checks).toHaveLength(1);
    f.checks[0]!.resolve(false);
    await settle();
    expect(f.recover).not.toHaveBeenCalled();
    f.emit();
    f.checks[1]!.resolve("true");
    await settle();
    expect(f.recover).not.toHaveBeenCalled();
    f.emit();
    f.checks[2]!.resolve(true);
    await settle();
    f.emit();
    expect(f.checks).toHaveLength(3);
    expect(f.recover).toHaveBeenCalledTimes(1);
  });

  it("discards old-document results without clearing a new document's pending check", async () => {
    const f = handlerFixture();
    f.emit();
    f.navigate({ isMainFrame: true, isSameDocument: false });
    f.emit();
    expect(f.checks).toHaveLength(2);
    f.checks[0]!.resolve(true);
    await settle();
    f.emit();
    expect(f.checks).toHaveLength(2);
    expect(f.recover).not.toHaveBeenCalled();
    f.checks[1]!.resolve(true);
    await settle();
    expect(f.recover).toHaveBeenCalledTimes(1);
    f.navigate({ isMainFrame: true, isSameDocument: false });
    f.emit();
    expect(f.checks).toHaveLength(3);
    f.checks[2]!.resolve(false);
    await settle();
  });

  it("preserves checks across child-frame and same-document navigation", async () => {
    const f = handlerFixture();
    f.emit();
    f.navigate({ isMainFrame: false, isSameDocument: false });
    f.navigate({ isMainFrame: true, isSameDocument: true });
    f.checks[0]!.resolve(true);
    await settle();
    expect(f.recover).toHaveBeenCalledTimes(1);
  });

  it("discards checks after shutdown, destruction, origin changes or frame replacement", async () => {
    for (const invalidate of [
      (f: ReturnType<typeof handlerFixture>) => f.quitting(true),
      (f: ReturnType<typeof handlerFixture>) => f.destroyed(true),
      (f: ReturnType<typeof handlerFixture>) => f.originValue("http://127.0.0.1:7800"),
      (f: ReturnType<typeof handlerFixture>) => { f.contents.mainFrame = { origin: f.origin }; },
      (f: ReturnType<typeof handlerFixture>) => { f.contents.mainFrame.origin = "http://127.0.0.1:7800"; },
    ]) {
      const f = handlerFixture();
      f.emit(); invalidate(f);
      f.checks[0]!.resolve(true);
      await settle();
      expect(f.recover).not.toHaveBeenCalled();
      expect(f.failStartup).not.toHaveBeenCalled();
    }
    const closed = handlerFixture(); closed.destroyed(true); closed.emit();
    const quitting = handlerFixture(); quitting.quitting(true); quitting.emit();
    expect(closed.checks).toHaveLength(0);
    expect(quitting.checks).toHaveLength(0);
  });

  it("logs only current check failures and permits a later event to try again", async () => {
    const f = handlerFixture();
    f.emit();
    f.checks[0]!.reject(new Error("private fixture diagnostic"));
    await settle();
    expect(f.checkFailed).toHaveBeenCalledExactlyOnceWith();
    expect(f.recover).not.toHaveBeenCalled();
    f.emit();
    f.navigate({ isMainFrame: true, isSameDocument: false });
    f.checks[1]!.reject(new Error("stale private fixture diagnostic"));
    await settle();
    expect(f.checkFailed).toHaveBeenCalledTimes(1);
    f.emit(); f.checks[2]!.resolve(true);
    await settle();
    expect(f.recover).toHaveBeenCalledTimes(1);
  });

  it("uses only a bounded fixed DOM query in world 999 without reading error content", async () => {
    const f = handlerFixture();
    const details = { level: "error", frame: f.contents.mainFrame, sourceId: f.origin + "/assets/app.js?secret=fixture-private" };
    Object.defineProperty(details, "message", { get() { throw new Error("Error text must remain unread"); } });
    Object.defineProperty(details, "stack", { get() { throw new Error("Stacks must remain unread"); } });
    f.native(details);
    const check = f.checks[0]!;
    expect(check.world).toBe(999);
    expect(check.scripts).toHaveLength(1);
    expect(check.scripts[0]!.code.length).toBeLessThan(512);
    expect(check.scripts[0]!.code).toContain("document.getElementById(\"root\")");
    expect(check.scripts[0]!.code).toContain("document.location.origin");
    expect(check.scripts[0]!.code).not.toContain("fixture-private");
    expect(check.scripts[0]!.code).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|fetch\(|\.message|\.stack/);
    check.resolve(false);
    await settle();
  });
});

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const nativeIt = process.platform === "darwin" ? it : it.skip;

const electronFixture = String.raw`
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { configureDesktopUiFailureHandler } = require('./ui-failure.cjs');
const root = __dirname;
const profile = path.join(root, 'profile'), session = path.join(profile, 'chromium');
fs.mkdirSync(session, { recursive: true, mode: 0o700 });
app.setName('Kulo UI Failure Regression');
app.setPath('userData', profile);
app.setPath('sessionData', session);
let window, server;
const watchdog = setTimeout(() => { process.stdout.write('KULO_UI_TEST:' + JSON.stringify({ ok: false, error: 'Native fixture timed out' }) + '\n'); app.exit(1); }, 15000);
async function main() {
  const scripts = {
    '/nonfatal.js': 'console.error("nonfatal fixture-private diagnostic");',
    '/child.js': 'throw new Error("child fixture-private diagnostic");',
    '/fatal.js': 'document.getElementById("root").replaceChildren(); throw new Error("fatal fixture-private diagnostic");',
    '/startup.js': 'document.getElementById("root").replaceChildren(); throw new Error("startup fixture-private diagnostic");',
  };
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (scripts[pathname]) { response.setHeader('Content-Type', 'application/javascript'); response.end(scripts[pathname]); return; }
    response.setHeader('Content-Type', 'text/html');
    if (pathname === '/child.html') response.end('<html><body><script src="/child.js"></script></body></html>');
    else if (pathname === '/startup.html') response.end('<html><body><div id="root"><main>initial</main></div><script src="/startup.js"></script></body></html>');
    else response.end('<html><body><div id="root"><main>ready</main></div></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  await app.whenReady();
  app.dock?.hide();
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const contents = window.webContents, events = new EventEmitter();
  let booting = true, recovered = 0, startupFailed = 0, checks = 0, checkFailures = 0;
  const worlds = [], reasons = [];
  const monitoredContents = {
    get mainFrame() { return contents.mainFrame; },
    isDestroyed: () => contents.isDestroyed(),
    on: (name, listener) => contents.on(name, listener),
    executeJavaScriptInIsolatedWorld(world, code) {
      checks++; worlds.push(world);
      return contents.executeJavaScriptInIsolatedWorld(world, code).then(value => { events.emit('checked', value); return value; });
    },
  };
  configureDesktopUiFailureHandler({ contents: monitoredContents, rendererOrigin: () => origin,
    isBooting: () => booting, isQuitting: () => false,
    failStartup(error) { startupFailed++; reasons.push(error.message); events.emit('startup-failure'); },
    async recover(message) { recovered++; reasons.push(message); events.emit('recovered'); },
    checkFailed() { checkFailures++; },
  });
  const nativeConsole = (suffix) => new Promise(resolve => {
    const listener = (details) => {
      if (!details.sourceId.endsWith(suffix)) return;
      contents.off('console-message', listener);
      resolve({ level: details.level, mainFrame: details.frame === contents.mainFrame, origin: details.frame.origin, sourceId: details.sourceId });
    };
    contents.on('console-message', listener);
  });
  const appendScript = (name) => contents.executeJavaScript('(function(){const script=document.createElement("script");script.src=' + JSON.stringify(name) + ';document.head.append(script);})()');
  await contents.loadURL(origin + '/');
  assert.equal(await contents.executeJavaScript('document.getElementById("root").childElementCount'), 1);
  booting = false;
  const nonfatalCheck = once(events, 'checked');
  const nonfatalEvent = nativeConsole('/nonfatal.js');
  await appendScript('/nonfatal.js');
  assert.equal((await nonfatalCheck)[0], false);
  const nonfatalDetails = await nonfatalEvent;
  assert.equal(nonfatalDetails.mainFrame, true); assert.equal(nonfatalDetails.origin, origin);
  await new Promise(setImmediate);
  assert.equal(recovered, 0);
  const beforeChild = checks, childEvent = nativeConsole('/child.js');
  await contents.executeJavaScript('(function(){const frame=document.createElement("iframe");frame.src="/child.html";document.body.append(frame);})()');
  const childDetails = await childEvent;
  assert.equal(childDetails.mainFrame, false);
  await new Promise(setImmediate);
  assert.equal(checks, beforeChild); assert.equal(recovered, 0);
  const recoveredEvent = once(events, 'recovered'), fatalEvent = nativeConsole('/fatal.js');
  await appendScript('/fatal.js');
  await recoveredEvent;
  const fatalDetails = await fatalEvent;
  assert.equal(fatalDetails.level, 'error'); assert.equal(fatalDetails.mainFrame, true);
  assert.equal(fatalDetails.sourceId, origin + '/fatal.js'); assert.equal(fatalDetails.origin, origin);
  assert.equal(recovered, 1); assert.equal(startupFailed, 0);
  assert.equal(await contents.executeJavaScript('document.getElementById("root").childElementCount'), 0);
  booting = true;
  const startupEvent = once(events, 'startup-failure');
  await contents.loadURL(origin + '/startup.html');
  await startupEvent;
  assert.equal(startupFailed, 1); assert.equal(recovered, 1); assert.equal(checkFailures, 0);
  assert.ok(worlds.every(world => world === 999));
  assert.ok(reasons.every(message => message === '界面脚本错误后未能继续显示。'));
  assert.equal(fs.realpathSync(app.getPath('userData')), fs.realpathSync(profile));
  assert.equal(fs.realpathSync(app.getPath('sessionData')), fs.realpathSync(session));
  assert.equal(window.isVisible(), false);
  return { ok: true, recovered, startupFailed, checks, isolated: true, hidden: true, sameOriginMainFrame: fatalDetails.mainFrame, childIgnored: childDetails.mainFrame === false };
}
main().then(async result => {
  clearTimeout(watchdog);
  if (window && !window.isDestroyed()) window.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  process.stdout.write('KULO_UI_TEST:' + JSON.stringify(result) + '\n');
  app.exit(0);
}, error => {
  clearTimeout(watchdog);
  if (window && !window.isDestroyed()) window.destroy();
  server?.closeAllConnections(); server?.close();
  process.stdout.write('KULO_UI_TEST:' + JSON.stringify({ ok: false, error: error.message }) + '\n');
  app.exit(1);
});
`;

describe("real Electron context-isolated UI failures", () => {
  nativeIt("detects an uncaught same-origin blank page in a hidden private-profile window", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-ui-electron-"));
    temporary.push(root);
    const desktopRequire = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
    const electronDirectory = path.dirname(desktopRequire.resolve("electron/package.json"));
    const executable = path.join(electronDirectory, "dist/Electron.app/Contents/MacOS/Electron");
    await fs.access(executable, fs.constants.X_OK);
    const source = await fs.readFile(new URL("../packages/desktop/src/ui-failure.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } });
    const entry = path.join(root, "main.cjs");
    await Promise.all([
      fs.writeFile(entry, electronFixture), fs.writeFile(path.join(root, "ui-failure.cjs"), compiled.outputText),
      fs.mkdir(path.join(root, "home")), fs.mkdir(path.join(root, "tmp")),
    ]);
    const result = await promisify(execFile)(executable, [entry], { cwd: root, timeout: 20_000, maxBuffer: 256 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), LANG: "en_US.UTF-8" } });
    const line = result.stdout.split("\n").find((value) => value.startsWith("KULO_UI_TEST:"));
    expect(line, result.stderr.slice(-4000)).toBeDefined();
    expect(JSON.parse(line!.slice("KULO_UI_TEST:".length))).toEqual({ ok: true, recovered: 1, startupFailed: 1, checks: 3,
      isolated: true, hidden: true, sameOriginMainFrame: true, childIgnored: true });
  }, 25_000);
});
