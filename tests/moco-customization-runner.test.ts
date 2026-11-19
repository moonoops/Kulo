import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { build as bundle, transform } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkerSandboxProfile, createMacSandboxCleanupCommand, defaultProtectedPaths } from "@moco/env";
import { createReleaseManifest, writeReleaseManifest } from "@moco/recovery";
import { cleanupLocalCustomizationExecutions, createLocalCustomizationRunner, customizationCommand, customizationEnvironment } from "../packages/hub/src/customization-source.js";

const roots: string[] = [], ownedPids = new Set<number>();
const WEB_CHECKS = ["typecheck", "build", "build:web", "runtime:base-reused", "test", "candidate-test-plan:web-v1", "frontend-regression", "host-native:not-rerun"];
let recoveryBundle: Promise<string> | undefined;
const WEB_TEST_ARGS = ["packages/web", "tests/moco-heroui-guard.test.ts", "tests/moco-typography.test.ts", "tests/moco-form-layout.test.ts",
  "tests/moco-input-appearance.test.ts", "tests/moco-tab-layout.test.ts", "tests/moco-control-appearance.test.ts", "tests/moco-popover-layout.test.ts",
  "tests/moco-focus-appearance.test.ts", "tests/moco-navigation-motion.test.ts", "--maxWorkers=4"];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const pid of ownedPids) { try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
  ownedPids.clear();
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } }
async function waitFile(file: string, limit = 10_000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { if (fs.existsSync(file)) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("fixture did not start");
}
type ControlTamper = "npmrc-symlink" | "npmrc-hardlink" | "home-link" | "tmp-link" | "wrapper-symlink" | "wrapper-hardlink" | "toolchain-link";
async function fixture(options: { inheritedPipes?: boolean; holdParent?: boolean; daemon?: boolean; timeoutMs?: number; defaultProbe?: boolean; shim?: boolean; basePayload?: boolean; tamper?: ControlTamper; bundledPnpm?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-customization-runner-"))); roots.push(root);
  const dataDir = path.join(root, "data"), trustedRoot = path.join(root, "trusted"), workRoot = path.join(dataDir, "staging/customization/job");
  const sourceRoot = path.join(workRoot, "source"), outputRoot = path.join(workRoot, "payload");
  await fsp.mkdir(path.join(dataDir, "hub"), { recursive: true }); await fsp.mkdir(trustedRoot);
  await fsp.mkdir(path.join(sourceRoot, "packages/desktop/scripts"), { recursive: true });
  const secret = path.join(dataDir, "hub/credentials.json"), stable = path.join(trustedRoot, "stable");
  await fsp.writeFile(secret, "fixture-private-value"); await fsp.writeFile(stable, "unchanged");
  const sentinel = path.join(trustedRoot, "controller-sentinel"), externalControls = path.join(trustedRoot, "external-controls"), alias = path.join(workRoot, "controller-alias");
  await fsp.writeFile(sentinel, "outside-controller-sentinel"); await fsp.mkdir(externalControls);
  for (const file of ["gitconfig", "npmrc", "pnpm"]) await fsp.writeFile(path.join(externalControls, file), "outside-" + file);
  if (options.tamper?.endsWith("hardlink")) await fsp.link(sentinel, alias);
  const basePayloadRoot = path.join(dataDir, "versions/base");
  await fsp.mkdir(path.join(basePayloadRoot, "dist"), { recursive: true }); await fsp.mkdir(path.join(basePayloadRoot, "web/dist"), { recursive: true });
  await fsp.writeFile(path.join(basePayloadRoot, "broker"), "fixture-broker");
  await fsp.mkdir(path.join(dataDir, "versions/other-private")); await fsp.writeFile(path.join(dataDir, "versions/other-private/private"), "not-the-base");
  const daemonFile = path.join(workRoot, "daemon.pid");
  let pnpm = path.join(trustedRoot, "pnpm-fixture");
  const script = [
    "#!/usr/bin/env node",
    "const fs=require('node:fs'),cp=require('node:child_process'),os=require('node:os');",
    "fs.writeFileSync('os-info.json',JSON.stringify({type:!!os.type(),release:!!os.release(),version:!!os.version(),hostname:!!os.hostname()}));",
    "const command=process.argv[2];",
    "fs.writeFileSync('chosen-toolchain',process.argv[1]);",
    "fs.appendFileSync('phases.log',command+'\\n');",
    "fs.appendFileSync('resource-limits.jsonl',JSON.stringify({command,args:process.argv.slice(3),workspaceConcurrency:process.env.npm_config_workspace_concurrency})+'\\n');",
    "let blockedRead=false,blockedWrite=false,blockedRuntime=false,blockedBaseRead=false;",
    "try{fs.readFileSync(" + JSON.stringify(secret) + ")}catch{blockedRead=true}",
    "try{fs.writeFileSync(" + JSON.stringify(secret) + ",'wrong')}catch{blockedWrite=true}",
    "try{fs.writeFileSync(" + JSON.stringify(stable) + ",'wrong')}catch{blockedRuntime=true}",
    "try{fs.readFileSync(" + JSON.stringify(path.join(basePayloadRoot, "broker")) + ")}catch{blockedBaseRead=true}",
    "fs.writeFileSync('isolation.json',JSON.stringify({blockedRead,blockedWrite,blockedRuntime,blockedBaseRead,inheritedSecret:!!process.env.MOCO_CUSTOMIZATION_FIXTURE_SECRET}));",
    options.tamper ? [
      "if(command==='install'){",
      options.tamper.startsWith("npmrc-") ? "fs.unlinkSync(process.env.npm_config_userconfig);" +
        (options.tamper.endsWith("hardlink") ? "fs.renameSync(" + JSON.stringify(alias) + ",process.env.npm_config_userconfig);" : "fs.symlinkSync(" + JSON.stringify(sentinel) + ",process.env.npm_config_userconfig);") : "",
      options.tamper === "home-link" ? "fs.rmSync(process.env.HOME,{recursive:true});fs.symlinkSync(" + JSON.stringify(externalControls) + ",process.env.HOME);" : "",
      options.tamper === "tmp-link" ? "fs.rmSync(process.env.TMPDIR,{recursive:true});fs.symlinkSync(" + JSON.stringify(externalControls) + ",process.env.TMPDIR);" : "",
      options.tamper.startsWith("wrapper-") ? "fs.unlinkSync(" + JSON.stringify(path.join(workRoot, ".toolchain/pnpm")) + ");" +
        (options.tamper.endsWith("hardlink") ? "fs.renameSync(" + JSON.stringify(alias) + "," + JSON.stringify(path.join(workRoot, ".toolchain/pnpm")) + ");" : "fs.symlinkSync(" + JSON.stringify(sentinel) + "," + JSON.stringify(path.join(workRoot, ".toolchain/pnpm")) + ");") + "process.exit(31);" : "",
      options.tamper === "toolchain-link" ? "fs.rmSync(" + JSON.stringify(path.join(workRoot, ".toolchain")) + ",{recursive:true});fs.symlinkSync(" + JSON.stringify(externalControls) + "," + JSON.stringify(path.join(workRoot, ".toolchain")) + ");process.exit(31);" : "",
      "}",
    ].join("\n") : "",
    options.daemon ? [
      "if(command==='install'){",
      "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:" + (options.inheritedPipes ? "'inherit'" : "'ignore'") + "});",
      "child.unref();fs.writeFileSync(" + JSON.stringify(daemonFile) + ",String(child.pid));",
      options.holdParent ? "setInterval(()=>{},1000);" : "process.exit(0);",
      "}",
    ].join("\n") : "",
  ].join("\n");
  await fsp.writeFile(pnpm, script, { mode: 0o700 });
  if (options.shim) {
    const packageRoot = path.join(root, "toolchain/node_modules/pnpm"), shimRoot = path.join(root, "toolchain/bin/fallback");
    await fsp.mkdir(path.join(packageRoot, "bin"), { recursive: true }); await fsp.mkdir(shimRoot, { recursive: true });
    await fsp.writeFile(path.join(packageRoot, "package.json"), '{"name":"pnpm"}');
    await fsp.writeFile(path.join(packageRoot, "bin/pnpm.cjs"), script);
    pnpm = path.join(shimRoot, "pnpm");
    await fsp.writeFile(pnpm, '#!/bin/sh\nSCRIPT_DIR="$(dirname "$0")"\nexec "${SCRIPT_DIR}/missing-node" "${SCRIPT_DIR}/../../node_modules/pnpm/bin/pnpm.cjs" "$@"\n', { mode: 0o700 });
  }
  await fsp.writeFile(path.join(sourceRoot, "package.json"), '{"name":"moco-monorepo","type":"module"}');
  const runtime = [
    "import http from 'node:http';const s=http.createServer((req,res)=>{",
    "if(req.url==='/api/settings'){res.setHeader('Content-Type','application/json');res.end('{\"blocks\":{}}')}",
    "else if(req.url==='/app.js'){res.end('window.fixture=true')}",
    "else{res.setHeader('Content-Type','text/html');res.end('<div id=\"root\"></div><script src=\"/app.js\"></script>')}});",
    "s.listen(0,'127.0.0.1',()=>process.send({type:'ready',url:'http://127.0.0.1:'+s.address().port,token:'a'.repeat(64)}));",
    "process.on('message',m=>{if(m.type==='shutdown')s.close(()=>process.exit(0))});",
  ].join("\n");
  await fsp.writeFile(path.join(basePayloadRoot, "package.json"), '{"type":"module"}');
  await fsp.writeFile(path.join(basePayloadRoot, "dist/runtime.js"), runtime);
  await fsp.writeFile(path.join(basePayloadRoot, "web/dist/index.html"), '<div id="root">old</div><script src="/app.js"></script>');
  await fsp.writeFile(path.join(basePayloadRoot, "web/dist/app.js"), "window.old=true;");
  const baseManifest = await createReleaseManifest(basePayloadRoot, { version: "0.1.0", kind: "official" }); writeReleaseManifest(basePayloadRoot, baseManifest);
  await fsp.mkdir(path.join(sourceRoot, "packages/web/dist"), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, "packages/web/dist/index.html"), '<div id="root">new</div><script src="/app.js"></script>');
  await fsp.writeFile(path.join(sourceRoot, "packages/web/dist/app.js"), "window.new=true;");
  await fsp.writeFile(path.join(sourceRoot, "packages/desktop/scripts/package.mjs"), "throw new Error('candidate packager must never run');");
  const probePath = path.join(trustedRoot, "probe.mjs");
  const recovery = path.join(trustedRoot, "node_modules/@moco/recovery"); await fsp.mkdir(recovery, { recursive: true });
  await fsp.writeFile(path.join(recovery, "package.json"), '{"name":"@moco/recovery","type":"module","exports":"./index.js"}');
  recoveryBundle ??= bundle({ entryPoints: ["packages/recovery/src/index.ts"], bundle: true, write: false, platform: "node", format: "esm", target: "node22" }).then((result) => result.outputFiles[0]!.text);
  await fsp.writeFile(path.join(recovery, "index.js"), await recoveryBundle);
  const compiled = await transform(await fsp.readFile("packages/hub/src/customization-probe.ts", "utf8"), { loader: "ts", format: "esm", target: "node22" });
  await fsp.writeFile(probePath, compiled.code);
  await fsp.writeFile(path.join(trustedRoot, "package.json"), '{"private":true}');
  let bundledPnpmEntry: string | undefined;
  {
    const hub = path.join(trustedRoot, "node_modules/@moco/hub"); await fsp.mkdir(path.join(hub, "dist"), { recursive: true });
    await fsp.writeFile(path.join(hub, "package.json"), '{"name":"@moco/hub","main":"dist/index.js"}');
    await fsp.writeFile(path.join(hub, "dist/index.js"), "");
    await fsp.writeFile(path.join(hub, "dist/customization-probe.js"), compiled.code);
    const packager = await transform(await fsp.readFile("packages/hub/src/customization-payload.ts", "utf8"), { loader: "ts", format: "esm", target: "node22" });
    await fsp.writeFile(path.join(hub, "dist/customization-payload-impl.js"), packager.code);
    await fsp.writeFile(path.join(hub, "dist/customization-payload.js"), [
      "import fs from 'node:fs/promises';import path from 'node:path';import {prepareWebCustomizationPayload as prepare} from './customization-payload-impl.js';",
      "export async function prepareWebCustomizationPayload(output,options){await prepare(output,options);let blockedBaseWrite=false,blockedSiblingRead=false,blockedDataRead=false;",
      "try{await fs.writeFile(path.join(options.basePayloadRoot,'broker'),'wrong')}catch{blockedBaseWrite=true}",
      "try{await fs.readFile(path.join(options.basePayloadRoot,'../other-private/private'))}catch{blockedSiblingRead=true}",
      "try{await fs.readFile(" + JSON.stringify(secret) + ")}catch{blockedDataRead=true}",
      "await fs.writeFile(path.join(options.workRoot,'base-isolation.json'),JSON.stringify({base:options.basePayloadRoot,blockedBaseWrite,blockedSiblingRead,blockedDataRead}));}",
    ].join("\n"));
    if (options.bundledPnpm) {
      const packageRoot = path.join(hub, "node_modules/pnpm"); await fsp.mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await fsp.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "pnpm", version: "11.25.0", exports: { ".": "./package.json" }, bin: { pnpm: "bin/pnpm.cjs" } }));
      bundledPnpmEntry = path.join(packageRoot, "bin/pnpm.cjs"); await fsp.writeFile(bundledPnpmEntry, script);
    }
  }
  const runner = createLocalCustomizationRunner({ nodePath: process.execPath, dataDir, trustedRoot, ...(options.bundledPnpm ? {} : { pnpmPath: pnpm }),
    ...(options.defaultProbe ? {} : { probePath }), timeoutMs: options.timeoutMs ?? 10_000 });
  return { root, dataDir, trustedRoot, workRoot, sourceRoot, outputRoot, basePayloadRoot, baseReleaseId: baseManifest.id, secret, stable, sentinel, externalControls, daemonFile, runner, bundledPnpmEntry, hostPnpm: pnpm };
}

describe.skipIf(process.platform !== "darwin")("real native customization runner isolation", () => {
  it("uses the closed bundled pnpm on demand with only the system PATH", async () => {
    const f = await fixture({ bundledPnpm: true });
    expect(fs.existsSync(path.join(f.sourceRoot, "chosen-toolchain"))).toBe(false);
    vi.stubEnv("PATH", "/usr/bin:/bin");
    expect(await f.runner.build(f)).toEqual({ checks: WEB_CHECKS });
    expect(await fsp.readFile(path.join(f.sourceRoot, "chosen-toolchain"), "utf8")).toBe(f.bundledPnpmEntry);
    expect(await fsp.readFile(path.join(f.outputRoot, "web/dist/app.js"), "utf8")).toBe("window.new=true;");
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });

  it("refuses a bundled pnpm entry outside its package while keeping an explicit host toolchain override first", async () => {
    const f = await fixture({ bundledPnpm: true });
    await fsp.unlink(f.bundledPnpmEntry!); await fsp.symlink(f.hostPnpm, f.bundledPnpmEntry!);
    vi.stubEnv("PATH", "/usr/bin:/bin");
    await expect(f.runner.build(f)).rejects.toMatchObject({ code: "customization_toolchain_unavailable" });
    expect(fs.existsSync(path.join(f.sourceRoot, "chosen-toolchain"))).toBe(false);
    const explicit = createLocalCustomizationRunner({ nodePath: process.execPath, dataDir: f.dataDir, trustedRoot: f.trustedRoot, pnpmPath: f.hostPnpm });
    expect(await explicit.build(f)).toEqual({ checks: WEB_CHECKS });
    expect(await fsp.readFile(path.join(f.sourceRoot, "chosen-toolchain"), "utf8")).toBe(f.hostPnpm);
  });

  it("executes fixed phases and a real IPC/HTTP probe without access to production data or writes to the stable runtime", async () => {
    const f = await fixture({ shim: true }); vi.stubEnv("MOCO_CUSTOMIZATION_FIXTURE_SECRET", "fixture-not-inherited");
    expect(await f.runner.build(f)).toEqual({ checks: WEB_CHECKS });
    expect(await fsp.readFile(path.join(f.sourceRoot, "phases.log"), "utf8")).toBe("install\ntypecheck\n--filter\n--filter\ntest\n");
    const limits = (await fsp.readFile(path.join(f.sourceRoot, "resource-limits.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(limits.every((phase) => phase.workspaceConcurrency === "2")).toBe(true);
    expect(limits.find((phase) => phase.command === "test").args).toEqual(WEB_TEST_ARGS);
    expect(limits.find((phase) => phase.command === "typecheck").args).toEqual([]);
    expect(limits.filter((phase) => phase.command === "--filter").map((phase) => phase.args)).toEqual([["@moco/protocol", "build"], ["@moco/web", "build"]]);
    expect(limits.some((phase) => phase.command === "build")).toBe(false);
    expect(JSON.parse(await fsp.readFile(path.join(f.sourceRoot, "os-info.json"), "utf8"))).toEqual({ type: true, release: true, version: true, hostname: true });
    expect(JSON.parse(await fsp.readFile(path.join(f.sourceRoot, "isolation.json"), "utf8"))).toEqual({ blockedRead: true, blockedWrite: true, blockedRuntime: true, blockedBaseRead: true, inheritedSecret: false });
    expect(await f.runner.probe({ workRoot: f.workRoot, payloadRoot: f.outputRoot, runtimeEntry: "dist/runtime.js", webDir: "web/dist" }))
      .toMatchObject({ checks: ["isolated-runtime-start", "http-ui-assets", "settings-contract"] });
    expect(await fsp.readFile(f.secret, "utf8")).toBe("fixture-private-value");
    expect(await fsp.readFile(f.stable, "utf8")).toBe("unchanged");
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });
  it("resolves its default probe from the stable trusted package while the candidate lives in protected managed versions", async () => {
    const f = await fixture({ defaultProbe: true });
    await f.runner.build(f);
    const managed = path.join(f.dataDir, "versions/managed-custom"); await fsp.mkdir(path.dirname(managed), { recursive: true });
    await fsp.rename(f.outputRoot, managed);
    expect(await f.runner.probe({ workRoot: f.workRoot, payloadRoot: managed, runtimeEntry: "dist/runtime.js", webDir: "web/dist" }))
      .toMatchObject({ checks: ["isolated-runtime-start", "http-ui-assets", "settings-contract"] });
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });

  it("inherits an optional broker from only the read-only base payload without exposing other versions or production data", async () => {
    const f = await fixture({ basePayload: true });
    expect(await f.runner.build(f)).toEqual({ checks: WEB_CHECKS });
    expect(await fsp.readFile(path.join(f.outputRoot, "broker"), "utf8")).toBe("fixture-broker");
    expect(await fsp.readFile(path.join(f.basePayloadRoot!, "broker"), "utf8")).toBe("fixture-broker");
    expect(JSON.parse(await fsp.readFile(path.join(f.workRoot, "base-isolation.json"), "utf8"))).toEqual({
      base: f.basePayloadRoot, blockedBaseWrite: true, blockedSiblingRead: true, blockedDataRead: true,
    });
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });

  it.each<ControlTamper>(["npmrc-symlink", "npmrc-hardlink", "home-link", "tmp-link"])("refuses a candidate's %s before the controller can rewrite external files", async (tamper) => {
    const f = await fixture({ tamper });
    await expect(f.runner.build(f)).rejects.toMatchObject({ code: tamper.includes("npmrc") ? "customization_control_invalid" : "customization_directory_invalid" });
    expect(await fsp.readFile(path.join(f.sourceRoot, "phases.log"), "utf8")).toBe("install\n");
    expect(await fsp.readFile(f.sentinel, "utf8")).toBe("outside-controller-sentinel");
    for (const file of ["gitconfig", "npmrc", "pnpm"]) expect(await fsp.readFile(path.join(f.externalControls, file), "utf8")).toBe("outside-" + file);
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });

  it.each<ControlTamper>(["wrapper-symlink", "wrapper-hardlink", "toolchain-link"])("refuses a poisoned %s on retry without truncating its external target", async (tamper) => {
    const f = await fixture({ tamper });
    await expect(f.runner.build(f)).rejects.toMatchObject({ code: "customization_command_failed" });
    await expect(f.runner.build(f)).rejects.toMatchObject({ code: tamper === "toolchain-link" ? "customization_directory_invalid" : "customization_control_invalid" });
    expect(await fsp.readFile(f.sentinel, "utf8")).toBe("outside-controller-sentinel");
    expect(await fsp.readFile(path.join(f.externalControls, "pnpm"), "utf8")).toBe("outside-pnpm");
    expect(await fsp.readFile(path.join(f.sourceRoot, "phases.log"), "utf8")).toBe("install\n");
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });

  it("rejects a linked workspace root before preparing any controller file", async () => {
    const f = await fixture(), moved = path.join(f.trustedRoot, "moved-workspace");
    await fsp.rename(f.workRoot, moved); await fsp.symlink(moved, f.workRoot);
    await expect(f.runner.build(f)).rejects.toMatchObject({ code: "customization_directory_invalid" });
    expect(fs.existsSync(path.join(moved, ".toolchain"))).toBe(false);
    expect(fs.existsSync(path.join(moved, ".home"))).toBe(false);
  });

  it.each([false, true])("cleans detached descendants after normal parent exit (inherited pipes: %s)", async (inheritedPipes) => {
    const f = await fixture({ daemon: true, inheritedPipes });
    const operation = f.runner.build(f);
    await waitFile(f.daemonFile); const pid = Number(await fsp.readFile(f.daemonFile, "utf8")); ownedPids.add(pid);
    await operation;
    expect(alive(pid)).toBe(false);
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });

  it("cancels a live process tree and waits for its detached descendants", async () => {
    const f = await fixture({ daemon: true, inheritedPipes: true, holdParent: true });
    const controller = new AbortController(), operation = f.runner.build({ ...f, signal: controller.signal });
    const rejection = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await waitFile(f.daemonFile); const pid = Number(await fsp.readFile(f.daemonFile, "utf8")); ownedPids.add(pid);
    controller.abort(); await rejection;
    expect(alive(pid)).toBe(false);
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });

  it("times out a live process tree without leaving a daemon or pretending validation passed", async () => {
    const f = await fixture({ daemon: true, inheritedPipes: false, holdParent: true, timeoutMs: 600 });
    const operation = f.runner.build(f);
    const rejection = expect(operation).rejects.toMatchObject({ code: "customization_timeout" });
    await waitFile(f.daemonFile); const pid = Number(await fsp.readFile(f.daemonFile, "utf8")); ownedPids.add(pid);
    await rejection; expect(alive(pid)).toBe(false);
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });

  it("recovers native sandbox descendants after their outer Hub owner is killed", async () => {
    const f = await fixture(), control = path.join(f.dataDir, "customizations/executions", randomUUID());
    await fsp.mkdir(control, { recursive: true, mode: 0o700 });
    const identity = { marker: "moco.customization." + randomBytes(24).toString("hex"), negative: "moco.unowned." + randomBytes(24).toString("hex") };
    const command = createMacSandboxCleanupCommand(control, identity.marker, identity.negative);
    const profile = buildWorkerSandboxProfile({ writablePaths: [f.workRoot], readOnlyPaths: [path.dirname(process.execPath)],
      protectedPaths: [...defaultProtectedPaths(), f.dataDir], executable: process.execPath, workspaceRoot: f.workRoot, sandboxIdentity: identity });
    const script = path.join(f.trustedRoot, "owner.cjs"), lock = path.join(f.dataDir, "customizations/.mutation-lock");
    const body = "require('node:fs').writeFileSync(" + JSON.stringify(f.daemonFile) + ",String(process.pid));setInterval(()=>{},1000)";
    await fsp.writeFile(script, [
      "const fs=require('node:fs'),cp=require('node:child_process');",
      "fs.mkdirSync(" + JSON.stringify(lock) + ",{mode:448});fs.writeFileSync(" + JSON.stringify(lock + "/") + "+process.pid+'-" + randomUUID() + ".owner','');",
      "fs.writeFileSync(" + JSON.stringify(path.join(control, "owner.json")) + ",JSON.stringify({ownerPid:process.pid,workRoot:" + JSON.stringify(f.workRoot) + ",cleanupCommand:" + JSON.stringify(command) + ",state:'running'}));",
      "cp.spawn('/usr/bin/sandbox-exec'," + JSON.stringify(["-p", profile, process.execPath, "-e", body]) + ",{cwd:" + JSON.stringify(f.workRoot) + ",detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);",
    ].join("\n"));
    const owner = spawn(process.execPath, [script], { stdio: "ignore" }); ownedPids.add(owner.pid!);
    await waitFile(f.daemonFile); const descendant = Number(await fsp.readFile(f.daemonFile, "utf8")); ownedPids.add(descendant);
    const stopped = once(owner, "exit"); owner.kill("SIGKILL"); await stopped;
    expect(alive(descendant)).toBe(true);
    expect(await cleanupLocalCustomizationExecutions(f.dataDir)).toEqual({ recovered: 1, pending: [] });
    expect(alive(descendant)).toBe(false); expect(fs.existsSync(lock)).toBe(false);
    expect(await f.runner.build(f)).toEqual({ checks: WEB_CHECKS });
    expect(await fsp.readdir(path.join(f.dataDir, "customizations/executions"))).toEqual([]);
  });
});

it("passes only explicit tool environment and keeps the system proxy", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-customization-env-"))); roots.push(root);
  const env = customizationEnvironment(root, { PATH: "/usr/bin", OPENAI_API_KEY: "fixture-key", NODE_OPTIONS: "--invalid",
    MOCO_RUNTIME_TOKEN: "fixture-token", HTTPS_PROXY: "http://127.0.0.1:7890", LANG: "en_US.UTF-8" });
  expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.MOCO_RUNTIME_TOKEN).toBeUndefined();
  expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890"); expect(env.HOME).toBe(path.join(root, ".home"));
});

it("keeps redacted fatal reasons and final frames within a 6 KB error even after the capture limit overflows", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-customization-output-"))); roots.push(root);
  const script = "process.stderr.write('FATAL: uv_os_uname denied; Bearer fixture-private-token\\n'+'日志'.repeat(40000)+'\\nlast-stack-frame\\napi_key=fixture-private-key');process.exitCode=1;";
  const result = await customizationCommand(process.execPath, ["-e", script], { cwd: root, workRoot: root }).catch((error: Error) => error);
  expect(result).toMatchObject({ code: "customization_command_failed" });
  const message = (result as Error).message;
  expect(message).toContain("FATAL: uv_os_uname denied"); expect(message).toContain("last-stack-frame");
  expect(message).not.toContain("fixture-private-token"); expect(message).not.toContain("fixture-private-key");
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(6000);
});
