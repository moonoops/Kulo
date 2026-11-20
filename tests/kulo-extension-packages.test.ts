import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, type ChildProcess, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BILLION_CONTEXT_KERNEL_VERSION, discoverExtensionPackages, extensionInstallEnvironment,
  inspectAvailableBillionContextPackage, inspectBillionContextPackage, inspectBundledBillionContextPackage,
  installBillionContextPackage, loadAvailableBillionContextPackage, loadBillionContextPackage,
  loadBundledBillionContextPackage, removeBillionContextPackage, resolveExtensionNpmCommand,
  summarizeExtensionInstallFailure, terminateExtensionInstaller,
} from "../packages/hub/src/extension-packages.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(options: { version?: string; fail?: boolean; failStderr?: string; hang?: boolean; realKernel?: boolean } = {}) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-extension-packages-")));
  roots.push(stateDir);
  const log = path.join(stateDir, "install.json");
  const npm = path.join(stateDir, "npm.cjs");
  // The command stub supplies a package locally; discovery, build, evaluation and activation are the real official API.
  fs.writeFileSync(npm, `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);if(!args.includes('--ignore-scripts'))process.exit(17);
fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args,secret:process.env.KULO_EXTENSION_TEST_SECRET,home:process.env.HOME,userconfig:process.env.NPM_CONFIG_USERCONFIG,globalconfig:process.env.NPM_CONFIG_GLOBALCONFIG}));
${options.failStderr ? `process.stderr.write(${JSON.stringify(options.failStderr)});` : ""}
${options.fail ? "process.exit(19);" : ""}
${options.hang ? "setInterval(()=>{},1000);return;" : ""}
const dir=path.join(process.cwd(),'node_modules/acp-kernel');fs.mkdirSync(path.join(dir,'dist'),{recursive:true});
${options.realKernel ? `fs.cpSync(${JSON.stringify(fs.realpathSync(path.resolve("node_modules/acp-kernel")))},dir,{recursive:true});` : `
fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'acp-kernel',version:${JSON.stringify(options.version ?? BILLION_CONTEXT_KERNEL_VERSION)},type:'module'}));
fs.writeFileSync(path.join(dir,'LICENSE'),'Fixture license');
fs.writeFileSync(path.join(dir,'dist/index.js'),'export function createCore(){return {fixture:true}};export function createInitialState(){return {}};export function defaultConfig(){return {}};export function collectBlockContent(){return []};');
`}
fs.writeFileSync('package-lock.json',JSON.stringify({packages:{'node_modules/acp-kernel':{integrity:'sha512-zKqi1mW+oTcpSY79lKkQXdz9AXFrmRj7JL6Mfpuo6JXM0WqRebXHBkQUZz9VGGi1SsOOjK0D9NghZ1/mIakdAA=='}}}));
`);
  return { stateDir, log, npmCommand: [process.execPath, npm] };
}

describe("official Chord extension package foundation", () => {
  it("installs and activates the reviewed wrapper through official discovery/build/evaluation without enabling it", async () => {
    const f = fixture();
    vi.stubEnv("KULO_EXTENSION_TEST_SECRET", "fixture-private-value");
    expect(await inspectBillionContextPackage(f.stateDir)).toBeNull();
    const info = await installBillionContextPackage(f);
    expect(info).toMatchObject({ id: "billion-context", packageName: "acp-kernel", version: BILLION_CONTEXT_KERNEL_VERSION, adapterVersion: "0.1.0" });
    expect(info.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(info.kernelDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await inspectBillionContextPackage(f.stateDir)).toEqual(info);
    expect(await installBillionContextPackage(f)).toEqual(info);
    const command = JSON.parse(fs.readFileSync(f.log, "utf8"));
    expect(command.secret).toBeUndefined();
    expect(command.args).toEqual(expect.arrayContaining(["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"]));
    expect(command.home).not.toBe(process.env.HOME);
    expect(command.userconfig).not.toBe(command.globalconfig);
    const discovered = await discoverExtensionPackages(path.dirname(info.directory));
    expect(discovered.problems).toEqual([]);
    expect(discovered.plugins.map((p) => p.name)).toEqual(["@kulo/billion-context-adapter"]);
    const loaded = await loadBillionContextPackage(f.stateDir);
    expect((loaded.kernel.createCore as () => unknown)()).toEqual({ fixture: true });
    await expect(removeBillionContextPackage(f.stateDir)).rejects.toMatchObject({ code: "extension_running" });
    await loaded.close(); await loaded.close();
    fs.writeFileSync(path.join(f.stateDir, "conversation.sqlite"), "retained history fixture");
    await removeBillionContextPackage(f.stateDir);
    await removeBillionContextPackage(f.stateDir);
    expect(await inspectBillionContextPackage(f.stateDir)).toBeNull();
    expect(fs.readFileSync(path.join(f.stateDir, "conversation.sqlite"), "utf8")).toBe("retained history fixture");
  });

  it("reports failed dependency installation and leaves no installed record", async () => {
    const f = fixture({ fail: true });
    await expect(installBillionContextPackage(f)).rejects.toMatchObject({ code: "extension_install_failed" });
    expect(await inspectBillionContextPackage(f.stateDir)).toBeNull();
    expect(fs.readdirSync(path.join(f.stateDir, "extensions/packages"))).toEqual([]);
  });

  it("loads the real pinned release offline through the official loader and performs a real fold", async () => {
    const f = fixture({ realKernel: true }); const info = await installBillionContextPackage(f);
    const loaded = await loadBillionContextPackage(f.stateDir);
    try {
      const kernel = loaded.kernel as unknown as typeof import("acp-kernel");
      const core = kernel.createCore(); const config = kernel.defaultConfig(32_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
      const messages: import("acp-kernel").CoreMessage[] = [
        { id: "old-user", role: "user", contentType: "text", text: "The selected code is cobalt-47." },
        { id: "old-answer", role: "assistant", contentType: "text", text: "Prior investigation complete. ".repeat(220) },
        { id: "current-user", role: "user", contentType: "text", text: "Continue the task." },
      ];
      const turn = core.processTurn({ state: kernel.createInitialState(), messages, config, tokenCount: 2000, renderTags: "none" });
      const startRef = turn.state.messageRefs.byRaw["old-user"];
      const endRef = turn.state.messageRefs.byRaw["old-answer"];
      expect(startRef).toBeTruthy(); expect(endRef).toBeTruthy();
      const result = core.applyCompression({ state: turn.state, messages, config, ranges: [{ startRef: startRef!, endRef: endRef!, summary: "Selected code is cobalt-47. Prior investigation is complete; retain this exact value when continuing the task." }] });
      expect(result.result.errors).toEqual([]); expect(result.result.blocksCreated).toBe(1);
      expect(info.version).toBe(BILLION_CONTEXT_KERNEL_VERSION);
    } finally { await loaded.close(); }
  });

  it("cancels the owned installer before cleaning its staging files", async () => {
    const f = fixture({ hang: true }); const controller = new AbortController();
    const install = installBillionContextPackage({ ...f, signal: controller.signal });
    const outcome = expect(install).rejects.toMatchObject({ name: "AbortError" });
    for (let attempt = 0; !fs.existsSync(f.log) && attempt < 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.existsSync(f.log)).toBe(true);
    controller.abort();
    await outcome;
    expect(await inspectBillionContextPackage(f.stateDir)).toBeNull();
    expect(fs.readdirSync(path.join(f.stateDir, "extensions/packages"))).toEqual([]);
  });

  it("refuses a package whose actual version differs from the selected release", async () => {
    const f = fixture({ version: "9.9.9" });
    await expect(installBillionContextPackage(f)).rejects.toMatchObject({ code: "extension_version_mismatch" });
    expect(await inspectBillionContextPackage(f.stateDir)).toBeNull();
  });

  it.each(["wrapper", "kernel"] as const)("rejects changed %s before evaluating it", async (target) => {
    const f = fixture(); const info = await installBillionContextPackage(f);
    const sideEffect = path.join(f.stateDir, "tampered-executed");
    const filename = target === "wrapper" ? path.join(info.directory, "worker.ts") : path.join(info.directory, "node_modules/acp-kernel/dist/index.js");
    fs.appendFileSync(filename, `\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sideEffect)},'should never execute');\n`);
    const source = pathToFileURL(path.resolve("packages/hub/src/extension-packages.ts")).href;
    const code = `import {loadBillionContextPackage} from ${JSON.stringify(source)};try{await loadBillionContextPackage(${JSON.stringify(f.stateDir)});process.exitCode=8}catch(e){if(e.code!=='extension_integrity_mismatch')throw e}`;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: path.resolve("."), env: extensionInstallEnvironment(process.env, f.stateDir), stdio: ["ignore", "pipe", "pipe"] });
    expect(fs.existsSync(sideEffect)).toBe(false);
  });

  it.each(["extensions", "packages", "billion-context", "node_modules", "engine"] as const)("rejects a symlink at %s without deleting its target", async (level) => {
    const f = fixture(); const outside = path.join(f.stateDir, "retained"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "owned fixture");
    let target: string;
    if (level === "extensions") target = path.join(f.stateDir, "extensions");
    else if (level === "packages") { fs.mkdirSync(path.join(f.stateDir, "extensions")); target = path.join(f.stateDir, "extensions/packages"); }
    else {
      const info = await installBillionContextPackage(f);
      target = level === "billion-context" ? info.directory : level === "node_modules" ? path.join(info.directory, "node_modules") : path.join(info.directory, "node_modules/acp-kernel");
      fs.rmSync(target, { recursive: true });
    }
    fs.symlinkSync(outside, target, "dir");
    await expect(removeBillionContextPackage(f.stateDir)).rejects.toMatchObject({ code: "extension_directory_unmanaged" });
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("owned fixture");
  });

  it("does not claim or delete a directory with no Kulo ownership record", async () => {
    const f = fixture(); const directory = path.join(f.stateDir, "extensions/packages/billion-context");
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "user-file"), "keep");
    await expect(installBillionContextPackage(f)).rejects.toMatchObject({ code: "extension_directory_unmanaged" });
    await expect(removeBillionContextPackage(f.stateDir)).rejects.toMatchObject({ code: "extension_directory_unmanaged" });
    expect(fs.readFileSync(path.join(directory, "user-file"), "utf8")).toBe("keep");
  });

  it("builds a minimal install environment while retaining the system proxy", () => {
    const env = extensionInstallEnvironment({ PATH: "/fixture/bin", HTTPS_PROXY: "http://127.0.0.1:1080", SECRET_TEST: "fixture", NODE_OPTIONS: "--fixture", NPM_TOKEN: "fixture" }, "/fixture/home");
    expect(env).toMatchObject({ PATH: "/fixture/bin", HTTPS_PROXY: "http://127.0.0.1:1080", HOME: "/fixture/home", NPM_CONFIG_IGNORE_SCRIPTS: "true" });
    expect(env.SECRET_TEST).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.NPM_TOKEN).toBeUndefined();
  });

  it("waits for the Windows process-tree termination command", async () => {
    const killer = new EventEmitter(); const launch = vi.fn(() => killer as ChildProcess) as unknown as typeof spawn;
    let finished = false;
    const stopping = terminateExtensionInstaller(4321, { platform: "win32", systemRoot: "C:\\Windows", launch }).then(() => { finished = true; });
    expect(launch).toHaveBeenCalledWith("C:\\Windows\\System32\\taskkill.exe", ["/PID", "4321", "/T", "/F"], expect.objectContaining({ shell: false, windowsHide: true }));
    await Promise.resolve(); expect(finished).toBe(false);
    killer.emit("close", 0); await stopping; expect(finished).toBe(true);
  });

  it("cleans only abandoned staging directories with its ownership marker", async () => {
    const f = fixture(); const root = path.join(f.stateDir, "extensions/packages"); fs.mkdirSync(root, { recursive: true });
    const abandoned = path.join(root, ".billion-context-dead"), unowned = path.join(root, ".billion-context-user"), active = path.join(root, ".billion-context-active");
    for (const dir of [abandoned, unowned, active]) fs.mkdirSync(dir);
    const marker = { kind: "kulo-extension-install", version: BILLION_CONTEXT_KERNEL_VERSION, ownerPid: 2147483647, installerPid: null };
    fs.writeFileSync(path.join(abandoned, ".kulo-extension-staging.json"), JSON.stringify(marker));
    fs.writeFileSync(path.join(active, ".kulo-extension-staging.json"), JSON.stringify({ ...marker, ownerPid: process.pid }));
    await installBillionContextPackage(f);
    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(unowned)).toBe(true); expect(fs.existsSync(active)).toBe(true);
  });

  it("uses one package identity through an explicitly selected state-directory alias", async () => {
    const f = fixture(); const alias = path.join(f.stateDir, "state-alias"); fs.symlinkSync(f.stateDir, alias, "dir");
    const info = await installBillionContextPackage({ ...f, stateDir: alias });
    expect(info.directory).toBe(path.join(f.stateDir, "extensions/packages/billion-context"));
    const loaded = await loadBillionContextPackage(alias);
    await expect(removeBillionContextPackage(f.stateDir)).rejects.toMatchObject({ code: "extension_running" });
    await loaded.close(); await removeBillionContextPackage(f.stateDir);
  });

  it("discovers and loads the bundled kernel offline without npm or stateDir installation", async () => {
    const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-extension-bundled-")));
    roots.push(stateDir);
    const bundled = await inspectBundledBillionContextPackage();
    expect(bundled).toMatchObject({ id: "billion-context", packageName: "acp-kernel", version: BILLION_CONTEXT_KERNEL_VERSION, bundled: true });
    expect(await inspectAvailableBillionContextPackage(stateDir)).toEqual(bundled);
    expect(await inspectAvailableBillionContextPackage(stateDir, { includeBundled: false })).toBeNull();
    const directBundled = await loadBundledBillionContextPackage();
    expect(directBundled.info.bundled).toBe(true);
    await directBundled.close();
    const loaded = await loadAvailableBillionContextPackage(stateDir);
    try {
      const kernel = loaded.kernel as unknown as typeof import("acp-kernel");
      const core = kernel.createCore();
      const config = kernel.defaultConfig(32_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
      const messages: import("acp-kernel").CoreMessage[] = [
        { id: "m1", role: "user", contentType: "text", text: "Bundled check alpha-19." },
        { id: "m2", role: "assistant", contentType: "text", text: "Completed bundled verification. ".repeat(200) },
        { id: "m3", role: "user", contentType: "text", text: "Next step." },
      ];
      const turn = core.processTurn({ state: kernel.createInitialState(), messages, config, tokenCount: 2000, renderTags: "none" });
      const applied = core.applyCompression({
        state: turn.state, messages, config,
        ranges: [{ startRef: turn.state.messageRefs.byRaw.m1!, endRef: turn.state.messageRefs.byRaw.m2!, summary: "Bundled check alpha-19 verified and completed; retain this exact value when continuing the task." }],
      });
      expect(applied.result.errors).toEqual([]);
      expect(applied.result.blocksCreated).toBe(1);
    } finally { await loaded.close(); }
    // Even with a minimal macOS Finder PATH lacking npm, offline install from bundled kernel succeeds.
    vi.stubEnv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    const installed = await installBillionContextPackage({ stateDir });
    expect(installed).toMatchObject({ id: "billion-context", version: BILLION_CONTEXT_KERNEL_VERSION, adapterVersion: "0.1.0" });
    expect(await inspectBillionContextPackage(stateDir)).toEqual(installed);
    const loadedManaged = await loadBillionContextPackage(stateDir);
    await loadedManaged.close();
    // A corrupted unmanaged directory in stateDir must still fail instead of silently falling back to bundled.
    const badStateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-extension-unmanaged-")));
    roots.push(badStateDir);
    fs.mkdirSync(path.join(badStateDir, "extensions/packages/billion-context"), { recursive: true });
    await expect(inspectAvailableBillionContextPackage(badStateDir)).rejects.toMatchObject({ code: "extension_directory_unmanaged" });
  });

  it("resolves fallback npm paths for GUI launches and summarizes redacted installer stderr", async () => {
    const resolved = await resolveExtensionNpmCommand(
      { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/example" },
      undefined,
      { platform: "darwin", execPath: "/Applications/Kulo Dev.app/Contents/Resources/runtime/node", checkExecutable: async (file) => file === "/opt/homebrew/bin/npm" },
    );
    expect(resolved.command).toEqual(["/opt/homebrew/bin/npm"]);
    expect(resolved.extraPathDirs).toEqual(["/Applications/Kulo Dev.app/Contents/Resources/runtime", "/opt/homebrew/bin"]);
    await expect(resolveExtensionNpmCommand(
      { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      undefined,
      { platform: "darwin", execPath: "/Applications/Kulo Dev.app/Contents/Resources/runtime/node", checkExecutable: async () => false },
    )).rejects.toMatchObject({ code: "extension_install_failed", message: expect.stringContaining("未找到 npm 命令") });

    expect(summarizeExtensionInstallFailure(1, "Error: spawn npm ENOENT")).toContain("未找到 npm 命令");
    expect(summarizeExtensionInstallFailure(1, "npm error code ENOTFOUND\ngetaddrinfo ENOTFOUND registry.npmjs.org")).toContain("无法连接 npm 源");
    expect(summarizeExtensionInstallFailure(1, "npm error code SELF_SIGNED_CERT_IN_CHAIN")).toContain("TLS 证书校验失败");
    expect(summarizeExtensionInstallFailure(1, "npm error code EACCES")).toContain("安装目录权限不足");
    expect(summarizeExtensionInstallFailure(1, "npm error code E404")).toContain("E404");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture({ fail: true, failStderr: "npm error code ENOTFOUND http://user:proxy-secret-value@127.0.0.1:7890 token=synthetic-npm-secret-value\n" });
    await expect(installBillionContextPackage(f)).rejects.toMatchObject({
      code: "extension_install_failed",
      message: expect.stringContaining("无法连接 npm 源"),
    });
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().join("\n");
    expect(logged).not.toContain("synthetic-npm-secret-value");
    expect(logged).not.toContain("proxy-secret-value");
  });
});
