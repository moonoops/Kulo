import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RecoveryManager, createReleaseManifest, validateReleaseManifest, writeReleaseManifest } from "../packages/recovery/src/index.js";
import { KuloCustomizationService } from "../packages/hub/src/customization.js";
import { probeCustomizationPayload } from "../packages/hub/src/customization-probe.js";
import { customizationSourceIdentity, createCustomizationSourceArchive, prepareCustomizationSource, type CustomizationRunner } from "../packages/hub/src/customization-source.js";
import { customizationSignatureData, fetchSignedCustomizationUpdate, mergeCustomizationChanges, readSignedCustomizationUpdate } from "../packages/hub/src/customization-updates.js";
import { createCustomizationToolsExtension } from "../packages/hub/src/tools-customization.js";

const roots: string[] = [], servers: http.Server[] = [];
const caller = { id: "conversation:1", canModify: true };
const WEB_CHECKS = ["typecheck", "build", "build:web", "runtime:base-reused", "test", "candidate-test-plan:web-v1", "frontend-regression", "host-native:not-rerun"];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});
function directory() { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-customization-flow-"))); roots.push(root); return root; }
function git(root: string, args: string[]) {
  return execFileSync("/usr/bin/git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function sourceFixture(root: string) {
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "packages/web/src"), { recursive: true });
  fs.mkdirSync(path.join(source, "packages/hub/src"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "kulo-monorepo", private: true }));
  fs.writeFileSync(path.join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  fs.writeFileSync(path.join(source, "packages/web/src/custom.ts"), "export const value = 'original';\n");
  fs.writeFileSync(path.join(source, "packages/hub/src/settings.ts"), "const doc = defineDoc({ kind: 'kulo.fixture', version: 1, initial: () => ({}) });\n");
  git(source, ["init"]); git(source, ["add", "."]); git(source, ["commit", "-m", "fixture baseline"]);
  return { directory: source, commit: git(source, ["rev-parse", "HEAD"]), version: "0.1.0" };
}
const runtime = (label: string) => [
  "import http from 'node:http';",
  "const html='<div id=\"root\"></div><script type=\"module\" src=\"/app.js\"></script>';",
  "const server=http.createServer((req,res)=>{",
  "if(req.url==='/api/settings'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({blocks:{fixture:{}},label:" + JSON.stringify(label) + "}));}",
  "else if(req.url==='/app.js'){res.setHeader('Content-Type','application/javascript');res.end('document.getElementById(\"root\").textContent=\"ready\"');}",
  "else{res.setHeader('Content-Type','text/html');res.end(html);}});",
  "server.listen(0,'127.0.0.1',()=>process.send({type:'ready',url:'http://127.0.0.1:'+server.address().port,token:'a'.repeat(64)}));",
  "process.on('message',m=>{if(m.type==='shutdown')server.close(()=>process.exit(0));});",
].join("\n");
async function payload(root: string, label: string) {
  await fsp.mkdir(path.join(root, "dist"), { recursive: true }); await fsp.mkdir(path.join(root, "web/dist"), { recursive: true });
  await fsp.mkdir(path.join(root, "bin"), { recursive: true });
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", name: "kulo-payload" }));
  await fsp.writeFile(path.join(root, "dist/runtime.js"), runtime(label));
  await fsp.writeFile(path.join(root, "web/dist/index.html"), '<div id="root"></div><script type="module" src="/app.js"></script>');
  await fsp.writeFile(path.join(root, "web/dist/app.js"), "document.getElementById('root').textContent=" + JSON.stringify(label));
  await fsp.writeFile(path.join(root, "bin/health"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
}
function runner(): CustomizationRunner {
  return {
    build: vi.fn(async ({ sourceRoot, outputRoot }) => {
      await payload(outputRoot, await fsp.readFile(path.join(sourceRoot, "packages/web/src/custom.ts"), "utf8"));
      return { checks: [...WEB_CHECKS] };
    }),
    probe: vi.fn(async ({ workRoot, payloadRoot, runtimeEntry, webDir }) => {
      const dataDir = path.join(workRoot, "probe"); await fsp.mkdir(dataDir, { recursive: true });
      await probeCustomizationPayload({ payloadRoot, runtimeEntry, webDir, dataDir, timeoutMs: 10_000 });
      return { checks: ["isolated-runtime-start", "http-ui-assets", "settings-contract"] };
    }),
  };
}
async function fixture(options: { dirty?: boolean } = {}) {
  const root = directory(), dataDir = path.join(root, "data"), baseline = path.join(root, "baseline");
  const source = sourceFixture(root);
  if (options.dirty) await fsp.writeFile(path.join(source.directory, "packages/web/src/dirty.ts"), "export const kept = true;\n");
  const sourceIdentity = await customizationSourceIdentity(source.directory);
  await payload(baseline, "original");
  const recovery = new RecoveryManager(dataDir, { shellVersion: "0.1.0" });
  const manifest = await createReleaseManifest(baseline, { kind: "official", version: "0.1.0", shellVersion: "0.1.0", sourceCommit: source.commit, sourceTreeHash: sourceIdentity.treeHash });
  await writeReleaseManifest(baseline, manifest);
  await recovery.initializeBaseline(baseline, manifest);
  const buildRunner = runner();
  const keys = generateKeyPairSync("ed25519");
  const trustedUpdateKeys = { fixture: keys.publicKey.export({ format: "pem", type: "spki" }).toString() };
  const updateInboxRoot = path.join(root, "updates"); await fsp.mkdir(updateInboxRoot);
  const service = new KuloCustomizationService({ dataDir, source, recovery, runner: buildRunner, shellVersion: "0.1.0", trustedUpdateKeys, updateInboxRoot });
  return { root, dataDir, source, recovery, buildRunner, service, keys, trustedUpdateKeys, updateInboxRoot };
}
async function signedUpdate(f: Awaited<ReturnType<typeof fixture>>, name: string, options: { sourceCommit?: string; label?: string; sourceArchive?: boolean; dataVersion?: number } = {}) {
  const root = path.join(f.updateInboxRoot, name), output = path.join(root, "payload");
  await payload(output, options.label ?? "official");
  const source = options.sourceArchive ? await createCustomizationSourceArchive(f.source.directory, path.join(output, "kulo-source.json.gz"), { version: "0.2.0" }) : undefined;
  if (source) await fsp.writeFile(path.join(output, "kulo-source.json"), JSON.stringify(source));
  const manifest = await createReleaseManifest(output, { kind: "official", version: "0.2.0", sourceCommit: options.sourceCommit,
    sourceTreeHash: source?.treeHash, shellVersion: "0.1.0", ...(options.dataVersion ? { dataVersion: options.dataVersion, minDataVersion: 2, maxDataVersion: options.dataVersion } : {}) });
  const envelope = { formatVersion: 1, keyId: "fixture", manifest, signature: sign(null, customizationSignatureData(manifest), f.keys.privateKey).toString("base64") };
  await fsp.writeFile(path.join(root, "kulo-update.json"), JSON.stringify(envelope));
  return { root, output, manifest, envelope };
}

describe("managed self-customization and official update flow", () => {
  it("runs the compact lazy tool entry through prepare, read, CAS write, real probe and pending activation", async () => {
    const f = await fixture(), service = vi.fn(async () => f.service);
    const extension = createCustomizationToolsExtension({ service, caller: async () => caller });
    expect(extension.tools?.map((tool) => tool.name)).toEqual(["kulo_customization", "kulo_official_update"]);
    expect(service).not.toHaveBeenCalled();
    const tool = extension.tools!.find((entry) => entry.name === "kulo_customization")!;
    const invoke = async (args: Record<string, unknown>, callId = "tool-request") => {
      const result = await tool.execute(args as never, { callId, conversationId: 1 } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
      return JSON.parse((result.output![0] as { text: string }).text);
    };
    expect(await invoke({ action: "status" })).toMatchObject({ hasPendingUpdate: false, officialUpdatesAvailable: false });
    expect(f.buildRunner.build).not.toHaveBeenCalled();
    const session = await invoke({ action: "prepare", request: JSON.stringify({ summary: "one managed feature" }) });
    const read = await invoke({ action: "read", request: JSON.stringify({ session_id: session.id, path: "packages/web/src/custom.ts" }) });
    await invoke({ action: "write", request: JSON.stringify({ session_id: session.id, path: read.path, content: "export const value = 'from-tool';\n", expected_revision: read.revision }) });
    expect(await invoke({ action: "validate", request: JSON.stringify({ session_id: session.id }) })).toMatchObject({ status: "pending" });
    expect((await f.recovery.inspect()).pending?.manifest.customizationRevision).toBeTruthy();
    service.mockClear();
    for (const request of [{ action: "unknown" }, { action: "prepare", request: "[]" },
      { action: "prepare", request: JSON.stringify({ summary: "bad", caller: { canModify: true } }) },
      { action: "write", request: JSON.stringify({ session_id: session.id, path: "x", content: "x", expected_revision: 1, workspace: "/etc" }) },
      { action: "status", request: " ".repeat(2 * 1024 * 1024 + 1) }]) {
      await expect(invoke(request)).rejects.toMatchObject({ code: "invalid_customization_request" });
    }
    expect(service).not.toHaveBeenCalled();
    await f.service.close();
  });
  it("preserves dirty source and new files, validates a real payload, and only schedules the next launch", async () => {
    const f = await fixture({ dirty: true });
    await fsp.writeFile(path.join(f.source.directory, "packages/web/src/dirty.ts"), "export const kept = true;\n");
    await fsp.mkdir(path.join(f.source.directory, "integrations/local/.venv"), { recursive: true });
    await fsp.writeFile(path.join(f.source.directory, "integrations/local/.venv/large"), "excluded");
    await fsp.writeFile(path.join(f.source.directory, ".env"), "fixture-not-for-candidates");
    const initial = await f.service.prepare({ summary: "change one feature", commandId: "first" }, caller);
    expect(await f.service.read(initial.id, "packages/web/src/dirty.ts", caller)).toMatchObject({ content: "export const kept = true;\n" });
    const changed = await f.service.write(initial.id, "packages/web/src/custom.ts", "export const value = 'custom';\n", initial.revision, caller);
    await f.service.write(initial.id, "packages/web/src/new-feature.ts", "export const feature = true;\n", changed.revision, caller);
    const result = await f.service.validateAndStage(initial.id, caller);
    expect(result).toMatchObject({ status: "pending", result: "准备完成，下次打开时生效。" });
    const state = await f.recovery.inspect();
    expect(state.current?.manifest.kind).toBe("official"); expect(state.pending?.manifest.kind).toBe("custom");
    expect(state.pending?.manifest.checks).toEqual(expect.arrayContaining([...WEB_CHECKS, "validation-base:" + state.baseline!.id]));
    expect(f.buildRunner.build).toHaveBeenCalledOnce(); expect(f.buildRunner.probe).toHaveBeenCalledOnce();
    expect(vi.mocked(f.buildRunner.build).mock.calls[0]![0].basePayloadRoot).toBe(state.baseline!.root);
    expect(vi.mocked(f.buildRunner.build).mock.calls[0]![0].baseReleaseId).toBe(state.baseline!.id);
    const revision = JSON.parse(await fsp.readFile(path.join(f.dataDir, "customizations/revisions", state.pending!.manifest.customizationRevision! + ".json"), "utf8"));
    expect(revision.changes.map((entry: { path: string }) => entry.path)).toEqual(["packages/web/src/custom.ts", "packages/web/src/new-feature.ts"]);
    expect(fs.existsSync(path.join(f.dataDir, "staging/customization", initial.id))).toBe(false);
    expect(await fsp.readFile(path.join(f.source.directory, "packages/web/src/custom.ts"), "utf8")).toContain("original");
    expect(fs.existsSync(path.join(f.dataDir, "hub/kulo.sqlite"))).toBe(false);
    await f.service.close();
  });

  it("derives pending, active and quarantined state across a restart without writing status or exposing another caller's session", async () => {
    const f = await fixture(), baseline = (await f.recovery.inspect()).baseline!;
    const session = await f.service.prepare({ summary: "owner-specific status", commandId: "application-state" }, caller);
    const read = await f.service.read(session.id, "packages/web/src/custom.ts", caller);
    await f.service.write(session.id, read.path, "export const value='application-state';\n", read.revision, caller);
    const staged = await f.service.validateAndStage(session.id, caller);
    expect(await f.service.status(caller)).toMatchObject({ currentReleaseId: baseline.id, pendingReleaseId: staged.releaseId,
      session: { id: session.id, status: "pending", applicationState: "pending" } });
    const sessionFile = path.join(f.dataDir, "customizations/sessions", session.id + ".json"), persisted = await fsp.readFile(sessionFile, "utf8");
    await f.service.close();
    const recovery = new RecoveryManager(f.dataDir, { shellVersion: "0.1.0" });
    const restarted = new KuloCustomizationService({ dataDir: f.dataDir, recovery });
    const launch = await recovery.prepareLaunch(); await recovery.markReady(launch.attemptId);
    const snapshot = async () => Promise.all((await fsp.readdir(f.dataDir, { recursive: true })).sort().map(async (relative) => {
      const filename = path.join(f.dataDir, relative), stat = await fsp.lstat(filename);
      return { relative, mtimeMs: stat.mtimeMs, size: stat.size,
        content: stat.isFile() ? createHash("sha256").update(await fsp.readFile(filename)).digest("hex") : null };
    }));
    const before = await snapshot();
    expect(await restarted.status(caller)).toMatchObject({ currentVersion: baseline.manifest.version, currentReleaseId: staged.releaseId,
      pendingReleaseId: null, session: { id: session.id, status: "pending", applicationState: "active" } });
    const other = await restarted.status({ id: "conversation:another-owner", canModify: false });
    expect(Object.hasOwn(other, "session")).toBe(false); expect(JSON.stringify(other)).not.toContain(session.id);
    expect(await snapshot()).toEqual(before);
    await recovery.markFailed(launch.attemptId, new Error("profile-specific late startup failure"));
    expect(await restarted.status(caller)).toMatchObject({ currentReleaseId: baseline.id, pendingReleaseId: null,
      session: { id: session.id, releaseId: staged.releaseId, status: "pending", applicationState: "failed" } });
    expect(await fsp.readFile(sessionFile, "utf8")).toBe(persisted);
    await restarted.close();
  });

  it("reports the exact current and pending identities and marks a superseded session inactive", async () => {
    const f = await fixture(), session = await f.service.prepare({ summary: "before next release", commandId: "superseded-state" }, caller);
    const read = await f.service.read(session.id, "packages/web/src/custom.ts", caller);
    await f.service.write(session.id, read.path, "export const value='before-next-release';\n", read.revision, caller);
    const staged = await f.service.validateAndStage(session.id, caller);
    const first = await f.recovery.prepareLaunch(); await f.recovery.markReady(first.attemptId); await f.recovery.markStopped(first.attemptId);
    const update = await signedUpdate(f, "superseding-release");
    const next = await f.recovery.stageRelease(update.output, update.manifest, { schedule: true, expectedBaseId: staged.releaseId });
    expect(await f.service.status(caller)).toMatchObject({ currentReleaseId: staged.releaseId, pendingReleaseId: next.id,
      session: { id: session.id, applicationState: "active" } });
    const second = await f.recovery.prepareLaunch(); await f.recovery.markReady(second.attemptId); await f.recovery.markStopped(second.attemptId);
    expect(await f.service.status(caller)).toMatchObject({ currentVersion: "0.2.0", currentReleaseId: next.id, pendingReleaseId: null,
      session: { id: session.id, releaseId: staged.releaseId, applicationState: "inactive" } });
    await f.service.close();
  });

  it("accepts only Web source, public content and local tests while protecting callers, revisions and the validation plan", async () => {
    const f = await fixture();
    await expect(f.service.prepare({ summary: "no authorization", commandId: "bad" }, { id: "worker:1", canModify: false })).rejects.toMatchObject({ code: "customization_forbidden" });
    const session = await f.service.prepare({ summary: "change", commandId: "authorized" }, caller);
    await expect(f.service.read(session.id, "packages/web/src/custom.ts", { id: "conversation:2", canModify: true })).rejects.toMatchObject({ code: "customization_session_missing" });
    for (const file of ["../outside", "/etc/passwd", "packages/web/src/../../secret"]) {
      await expect(f.service.write(session.id, file, "invalid", session.revision, caller)).rejects.toBeInstanceOf(Error);
    }
    for (const file of ["packages/hub/src/settings.ts", "packages/env/src/isolation.ts", "packages/protocol/src/kulo.ts", "packages/recovery/src/index.ts",
      "packages/hub/src/customization-source.ts", "packages/hub/native/macos-worker-cleanup.c", "packages/desktop/scripts/package.mjs",
      "tests/kulo-heroui-guard.test.ts", "tests/helpers/typography.ts", "vitest.config.ts", "packages/web/vite.config.ts", "packages/web/package.json"]) {
      await expect(f.service.write(session.id, file, "invalid", session.revision, caller)).rejects.toMatchObject({ code: "customization_path_protected" });
    }
    await expect(f.service.write(session.id, "packages/web/src/custom.ts", "new", session.revision + 1, caller)).rejects.toMatchObject({ code: "customization_revision_conflict" });
    let revision = session.revision;
    for (const [file, content] of [["packages/web/src/view.tsx", "export const View=()=>null;"], ["packages/web/public/banner.json", '{"title":"fixture"}'],
      ["packages/web/test/view.test.tsx", "import {it,expect} from 'vitest';it('fixture',()=>expect(true).toBe(true));"]]) {
      const changed = await f.service.write(session.id, file!, content!, revision, caller); revision = changed.revision;
      expect(await f.service.read(session.id, file!, caller)).toMatchObject({ content });
    }
    expect(f.buildRunner.build).not.toHaveBeenCalled();
    await f.service.cancel(session.id, caller); await f.service.close();
  });

  it("rejects a protected backend or test-plan mutation made by candidate code during validation", async () => {
    for (const protectedFile of ["packages/hub/src/settings.ts", "tests/kulo-heroui-guard.test.ts"]) {
      const f = await fixture(), originalBuild = f.buildRunner.build;
      f.buildRunner.build = async (request) => {
        const target = path.join(request.sourceRoot, protectedFile); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, "tampered by candidate");
        return originalBuild(request);
      };
      const session = await f.service.prepare({ summary: "frontend only", commandId: "frontend-only" }, caller);
      await f.service.write(session.id, "packages/web/src/custom.ts", "export const value='frontend';\n", session.revision, caller);
      await expect(f.service.validateAndStage(session.id, caller)).rejects.toMatchObject({ code: "customization_path_protected" });
      expect((await f.recovery.inspect()).pending).toBeNull(); expect(f.buildRunner.probe).not.toHaveBeenCalled(); await f.service.close();
    }
  });

  it("reports a committed pending release when cancellation races the atomic stage commit", async () => {
    const f = await fixture();
    const session = await f.service.prepare({ summary: "commit race", commandId: "commit-race" }, caller);
    await f.service.write(session.id, "packages/web/src/custom.ts", "export const value='race';\n", session.revision, caller);
    let entered!: () => void, proceed!: () => void;
    const atStage = new Promise<void>((resolve) => { entered = resolve; });
    const commit = new Promise<void>((resolve) => { proceed = resolve; });
    const original = f.recovery.stageRelease.bind(f.recovery);
    vi.spyOn(f.recovery, "stageRelease").mockImplementation(async (...args) => { entered(); await commit; return original(...args); });
    const validating = f.service.validateAndStage(session.id, caller);
    await Promise.race([atStage, validating.then(() => { throw new Error("expected stage entry before completion"); })]);
    const cancellation = expect(f.service.cancel(session.id, caller)).rejects.toMatchObject({ code: "customization_already_staged" });
    proceed();
    expect(await validating).toMatchObject({ status: "pending" }); await cancellation;
    expect((await f.service.status(caller)).session?.status).toBe("pending");
    expect((await f.recovery.inspect()).pending).toBeTruthy();
    await f.service.close();
  });

  it("refuses a signed update that changes the data writer format before starting its runtime", async () => {
    const f = await fixture(); await signedUpdate(f, "new-data-format", { dataVersion: 3 });
    await expect(f.service.installOfficial("new-data-format", caller)).rejects.toMatchObject({ code: "customization_data_migration_unsupported" });
    expect(f.buildRunner.probe).not.toHaveBeenCalled(); expect((await f.recovery.inspect()).pending).toBeNull();
    await f.service.close();
  });

  it("keeps a protected release's source revision even when it is outside the visible history roles", async () => {
    const f = await fixture(), session = await f.service.prepare({ summary: "retention", commandId: "retention" }, caller);
    const revision = "a".repeat(64), filename = path.join(f.dataDir, "customizations/revisions", revision + ".json");
    await fsp.mkdir(path.dirname(filename), { recursive: true }); await fsp.writeFile(filename, "{}");
    await fsp.utimes(filename, new Date(0), new Date(0));
    const original = f.recovery.inspect.bind(f.recovery);
    vi.spyOn(f.recovery, "inspect").mockImplementation(async () => {
      const state = await original(), id = "release_" + "b".repeat(24);
      return { ...state, protectedReleaseIds: [...state.protectedReleaseIds, id], releases: [...state.releases,
        { ...state.baseline!, id, manifest: { ...state.baseline!.manifest, id, customizationRevision: revision } }] };
    });
    await f.service.cancel(session.id, caller);
    expect(fs.existsSync(filename)).toBe(true); await f.service.close();
  });

  it("detects dirty source identity mismatches and excludes nested checkout secrets and virtual environments", async () => {
    const f = await fixture(), identity = await customizationSourceIdentity(f.source.directory);
    await fsp.writeFile(path.join(f.source.directory, "packages/web/src/custom.ts"), "changed after packaging");
    const mismatch = new KuloCustomizationService({ dataDir: f.dataDir, source: { ...f.source, treeHash: identity.treeHash }, recovery: f.recovery, runner: f.buildRunner });
    await expect(mismatch.prepare({ summary: "identity", commandId: "mismatch" }, caller)).rejects.toMatchObject({ code: "source_version_changed" });
    await mismatch.close(); await f.service.close();
  });

  it("rejects a changed artifact after the host probe instead of trusting a candidate receipt", async () => {
    const f = await fixture(), regularProbe = f.buildRunner.probe;
    f.buildRunner.probe = async (request) => {
      const result = await regularProbe(request);
      await fsp.appendFile(path.join(request.payloadRoot, request.runtimeEntry), "\n// changed after validation");
      return result;
    };
    const session = await f.service.prepare({ summary: "tamper probe", commandId: "tamper" }, caller);
    await f.service.write(session.id, "packages/web/src/custom.ts", "export const value = 'changed';\n", session.revision, caller);
    await expect(f.service.validateAndStage(session.id, caller)).rejects.toBeInstanceOf(Error);
    expect((await f.recovery.inspect()).pending).toBeNull();
    await f.service.close();
  });

  it("rejects a valid replacement manifest at the base path before granting it to the builder", async () => {
    const f = await fixture(), session = await f.service.prepare({ summary: "base identity", commandId: "base-identity" }, caller);
    await f.service.write(session.id, "packages/web/src/custom.ts", "export const value='changed';\n", session.revision, caller);
    const baseline = (await f.recovery.inspect()).baseline!;
    await fsp.appendFile(path.join(baseline.root, "web/dist/app.js"), ";window.replaced=true;");
    await writeReleaseManifest(baseline.root, await createReleaseManifest(baseline.root, { kind: "official", version: "9.0.0", shellVersion: "0.1.0" }));
    await expect(f.service.validateAndStage(session.id, caller)).rejects.toMatchObject({ code: "customization_base_changed" });
    expect(f.buildRunner.build).not.toHaveBeenCalled(); expect((await f.recovery.inspect()).pending).toBeNull();
    await f.service.close();
  });

  it("keeps a bounded redacted runtime startup reason for external rescue diagnostics", async () => {
    const root = directory(), candidate = path.join(root, "candidate"), dataDir = path.join(root, "probe");
    await payload(candidate, "broken"); await fsp.mkdir(dataDir);
    const detail = "EACCES opening isolated runtime directory; Authorization: Bearer fixture-private-token; api_key=fixture-private-key; " + "x".repeat(5000);
    await fsp.writeFile(path.join(candidate, "dist/runtime.js"), "process.send({type:'error',message:" + JSON.stringify(detail) + "});setInterval(()=>{},1000);");
    const error = await probeCustomizationPayload({ payloadRoot: candidate, runtimeEntry: "dist/runtime.js", webDir: "web/dist", dataDir, timeoutMs: 5000 }).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error); const message = (error as Error).message;
    expect(message).toContain("EACCES opening isolated runtime directory"); expect(message.length).toBeLessThan(2100);
    expect(message).not.toContain("fixture-private-token"); expect(message).not.toContain("fixture-private-key");
  });

  it("installs a signed prebuilt update without local build and keeps user data untouched", async () => {
    const f = await fixture(); await signedUpdate(f, "official");
    await fsp.mkdir(path.join(f.dataDir, "hub"), { recursive: true });
    await fsp.writeFile(path.join(f.dataDir, "hub/user-preference.json"), '{"value":"keep"}');
    const result = await f.service.installOfficial("official", caller);
    expect(result).toMatchObject({ status: "pending" });
    expect(f.buildRunner.build).not.toHaveBeenCalled(); expect(f.buildRunner.probe).toHaveBeenCalledOnce();
    expect(await fsp.readFile(path.join(f.dataDir, "hub/user-preference.json"), "utf8")).toBe('{"value":"keep"}');
    expect((await f.recovery.inspect()).current?.manifest.version).toBe("0.1.0");
    await f.service.close();
  });

  it("refuses forged signatures before starting candidate code", async () => {
    const f = await fixture(), update = await signedUpdate(f, "forged");
    update.envelope.signature = Buffer.alloc(64, 1).toString("base64");
    await fsp.writeFile(path.join(update.root, "kulo-update.json"), JSON.stringify(update.envelope));
    await expect(f.service.installOfficial("forged", caller)).rejects.toMatchObject({ code: "update_signature_invalid" });
    expect(f.buildRunner.probe).not.toHaveBeenCalled(); expect((await f.recovery.inspect()).pending).toBeNull();
    await f.service.close();
  });

  it("preserves custom changes during a new official source merge", async () => {
    const f = await fixture();
    const session = await f.service.prepare({ summary: "custom feature", commandId: "custom-before-update" }, caller);
    await f.service.write(session.id, "packages/web/src/custom.ts", "export const value = 'mine';\n", session.revision, caller);
    await f.service.validateAndStage(session.id, caller);
    const launch = await f.recovery.prepareLaunch(); await f.recovery.markReady(launch.attemptId); await f.recovery.markStopped(launch.attemptId);
    await fsp.writeFile(path.join(f.source.directory, "packages/web/src/official.ts"), "export const official = true;\n");
    git(f.source.directory, ["add", "."]); git(f.source.directory, ["commit", "-m", "official addition"]);
    const newCommit = git(f.source.directory, ["rev-parse", "HEAD"]);
    await signedUpdate(f, "next", { sourceCommit: newCommit });
    const result = await f.service.installOfficial("next", caller);
    expect(result).toMatchObject({ status: "pending" });
    const pending = (await f.recovery.inspect()).pending!;
    expect(pending.manifest.version).toBe("0.2.0"); expect(pending.manifest.customizationRevision).toBeTruthy();
    expect(await fsp.readFile(path.join(pending.root, "web/dist/app.js"), "utf8")).toContain("mine");
    await f.service.close();
  });

  it("flattens cumulative custom revisions to their original official baseline", async () => {
    const f = await fixture();
    const first = await f.service.prepare({ summary: "first", commandId: "first-revision" }, caller);
    await f.service.write(first.id, "packages/web/src/custom.ts", "export const value = 'first';\n", first.revision, caller);
    await f.service.validateAndStage(first.id, caller);
    const firstRelease = (await f.recovery.inspect()).pending!;
    const second = await f.service.prepare({ summary: "second", commandId: "second-revision" }, caller);
    expect((await f.service.read(second.id, "packages/web/src/custom.ts", caller)).content).toContain("first");
    await f.service.write(second.id, "packages/web/src/second.ts", "export const second = true;\n", second.revision, caller);
    await f.service.validateAndStage(second.id, caller);
    const state = await f.recovery.inspect();
    expect(state.pending!.manifest.baseReleaseId).toBe(state.baseline!.id);
    expect(state.pending!.manifest.baseReleaseId).not.toBe(firstRelease.id);
    await f.service.close();
  });

  it("defers an actual three-way source conflict without dropping the user's active custom version", async () => {
    const f = await fixture();
    const session = await f.service.prepare({ summary: "mine", commandId: "conflicting-revision" }, caller);
    await f.service.write(session.id, "packages/web/src/custom.ts", "export const value = 'mine';\n", session.revision, caller);
    await f.service.validateAndStage(session.id, caller);
    const launch = await f.recovery.prepareLaunch(); await f.recovery.markReady(launch.attemptId); await f.recovery.markStopped(launch.attemptId);
    await fsp.writeFile(path.join(f.source.directory, "packages/web/src/custom.ts"), "export const value = 'official-changed';\n");
    git(f.source.directory, ["add", "."]); git(f.source.directory, ["commit", "-m", "conflicting official"]);
    await signedUpdate(f, "conflict", { sourceCommit: git(f.source.directory, ["rev-parse", "HEAD"]) });
    expect(await f.service.installOfficial("conflict", caller)).toMatchObject({ status: "deferred", reason: "source-conflict", conflicts: ["packages/web/src/custom.ts"] });
    expect((await f.recovery.inspect()).current!.id).toBe(launch.releaseId);
    expect((await f.recovery.inspect()).pending).toBeNull();
    expect(f.buildRunner.build).toHaveBeenCalledOnce();
    await f.service.close();
  });

  it("uses a source archive only on request and takes the new signed official archive when replaying a custom revision", async () => {
    const f = await fixture();
    const archivePath = path.join(f.root, "kulo-source.json.gz");
    const oldSource = await createCustomizationSourceArchive(f.source.directory, archivePath, { version: "0.1.0" });
    const archived = new KuloCustomizationService({ dataDir: f.dataDir, recovery: f.recovery, runner: f.buildRunner, shellVersion: "0.1.0",
      source: { archivePath, archiveHash: oldSource.archiveHash, treeHash: oldSource.treeHash, commit: oldSource.commit, version: oldSource.version },
      updateInboxRoot: f.updateInboxRoot, trustedUpdateKeys: f.trustedUpdateKeys });
    expect(fs.existsSync(path.join(f.dataDir, "staging/customization"))).toBe(false);
    const session = await archived.prepare({ summary: "archived source", commandId: "archive-first" }, caller);
    await archived.write(session.id, "packages/web/src/custom.ts", "export const value = 'archive-custom';\n", session.revision, caller);
    await archived.validateAndStage(session.id, caller);
    const launch = await f.recovery.prepareLaunch(); await f.recovery.markReady(launch.attemptId); await f.recovery.markStopped(launch.attemptId);
    await fsp.writeFile(path.join(f.source.directory, "packages/web/src/new-official.ts"), "export const official = 'new';\n");
    git(f.source.directory, ["add", "."]); git(f.source.directory, ["commit", "-m", "new archived official"]);
    const update = await signedUpdate(f, "archived-next", { sourceCommit: git(f.source.directory, ["rev-parse", "HEAD"]), sourceArchive: true });
    expect(await archived.installOfficial("archived-next", caller)).toMatchObject({ status: "pending" });
    const pending = (await f.recovery.inspect()).pending!;
    expect(pending.manifest.baseReleaseId).toBe(update.manifest.id);
    expect(await fsp.readFile(path.join(pending.root, "web/dist/app.js"), "utf8")).toContain("archive-custom");
    await archived.close(); await f.service.close();
  });
});

describe("bounded source archives", () => {
  it("excludes the generated connector binary from source identity, archives and checkout workspaces", async () => {
    const f = await fixture(), native = path.join(f.source.directory, "packages/hub/native");
    await fsp.mkdir(native, { recursive: true }); await fsp.writeFile(path.join(native, "kulo-vault-keychain.c"), "/* retained source */");
    const before = await customizationSourceIdentity(f.source.directory), binary = path.join(native, "kulo-connector-darwin-arm64");
    const descriptor = await fsp.open(binary, "w"); await descriptor.truncate(17 * 1024 * 1024); await descriptor.close();
    expect(await customizationSourceIdentity(f.source.directory)).toEqual(before);
    const archive = path.join(f.root, "native-source.gz"), metadata = await createCustomizationSourceArchive(f.source.directory, archive, { version: "0.1.0" });
    const raw = JSON.parse(gunzipSync(await fsp.readFile(archive)).toString("utf8"));
    expect(raw.files.some((file: { path: string }) => file.path.includes("kulo-connector-"))).toBe(false);
    expect(raw.files.some((file: { path: string }) => file.path.endsWith("kulo-vault-keychain.c"))).toBe(true);
    const work = path.join(f.root, "native-work"); await fsp.mkdir(work);
    await prepareCustomizationSource({ version: metadata.version, archivePath: archive, archiveHash: metadata.archiveHash, treeHash: metadata.treeHash }, path.join(work, "unpacked"), work);
    expect(fs.existsSync(path.join(work, "unpacked/packages/hub/native/kulo-connector-darwin-arm64"))).toBe(false);
    git(f.source.directory, ["add", "."]); git(f.source.directory, ["commit", "-m", "fixture generated binary"]);
    await prepareCustomizationSource(f.source, path.join(work, "checkout"), work, undefined, git(f.source.directory, ["rev-parse", "HEAD"]));
    expect(fs.existsSync(path.join(work, "checkout/packages/hub/native/kulo-connector-darwin-arm64"))).toBe(false);
    raw.files[0].path = "packages/hub/native/kulo-connector-darwin-arm64";
    const forged = gzipSync(JSON.stringify(raw)); await fsp.writeFile(archive, forged);
    await expect(prepareCustomizationSource({ version: metadata.version, archivePath: archive, archiveHash: createHash("sha256").update(forged).digest("hex") },
      path.join(work, "rejected"), work)).rejects.toMatchObject({ code: "customization_source_invalid" });
    await f.service.close();
  });

  it("excludes nested secrets and virtual environments and rejects a forged traversal before writing outside staging", async () => {
    const f = await fixture();
    await fsp.mkdir(path.join(f.source.directory, "integrations/example/.venv"), { recursive: true });
    await fsp.writeFile(path.join(f.source.directory, "integrations/example/.venv/private"), "excluded");
    await fsp.writeFile(path.join(f.source.directory, "integrations/example/.env"), "excluded");
    const archive = path.join(f.root, "source.gz"), metadata = await createCustomizationSourceArchive(f.source.directory, archive, { version: "0.1.0" });
    const work = path.join(f.root, "unpack"), target = path.join(work, "source"); await fsp.mkdir(work);
    const snapshot = await prepareCustomizationSource({ version: metadata.version, archivePath: archive, archiveHash: metadata.archiveHash, treeHash: metadata.treeHash, commit: metadata.commit }, target, work);
    expect(snapshot.sourceTreeHash).toBe(metadata.treeHash);
    expect(fs.existsSync(path.join(target, "integrations/example/.venv"))).toBe(false);
    expect(fs.existsSync(path.join(target, "integrations/example/.env"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
    const raw = JSON.parse(gunzipSync(await fsp.readFile(archive)).toString("utf8"));
    raw.files[0].path = "../outside";
    const forged = gzipSync(JSON.stringify(raw)); await fsp.writeFile(archive, forged);
    await expect(prepareCustomizationSource({ version: metadata.version, archivePath: archive, archiveHash: createHash("sha256").update(forged).digest("hex") },
      path.join(work, "rejected"), work)).rejects.toMatchObject({ code: "customization_source_invalid" });
    expect(fs.existsSync(path.join(work, "outside"))).toBe(false);
    await f.service.close();
  });

  it("excludes local-only internal docs and AGENTS.md from source identity and archives", async () => {
    const f = await fixture();
    const before = await customizationSourceIdentity(f.source.directory);
    await fsp.mkdir(path.join(f.source.directory, "docs"), { recursive: true });
    await fsp.writeFile(path.join(f.source.directory, "docs/internal-plan.md"), "# Internal only\n");
    await fsp.writeFile(path.join(f.source.directory, "AGENTS.md"), "# Local agent rules\n");
    expect(await customizationSourceIdentity(f.source.directory)).toEqual(before);
    const archive = path.join(f.root, "clean-source.gz");
    await createCustomizationSourceArchive(f.source.directory, archive, { version: "0.1.0" });
    const raw = JSON.parse(gunzipSync(await fsp.readFile(archive)).toString("utf8"));
    expect(raw.files.some((file: { path: string }) => file.path === "AGENTS.md" || file.path.startsWith("docs/"))).toBe(false);
    await f.service.close();
  });
});

describe("trusted official feed transport", () => {
  it("accepts a valid signed descriptor above 2 MiB before enforcing the payload byte budget", async () => {
    const f = await fixture(), update = await signedUpdate(f, "large-manifest");
    const additions = Array.from({ length: 7000 }, (_, index) => ({ path: "assets/" + "x".repeat(160) + "/" + String(index).padStart(5, "0") + ".js",
      kind: "file" as const, size: 1, sha256: createHash("sha256").update("x").digest("hex"), executable: false }));
    const files = [...update.manifest.files, ...additions].sort((a, b) => a.path.localeCompare(b.path, "en"));
    const { id: _id, ...original } = update.manifest;
    const body = { ...original, files, artifactHash: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
    const manifest = validateReleaseManifest({ ...body, id: "release_" + createHash("sha256").update(customizationSignatureData(body)).digest("hex").slice(0, 24) });
    const descriptor = JSON.stringify({ formatVersion: 1, keyId: "fixture", manifest,
      signature: sign(null, customizationSignatureData(manifest), f.keys.privateKey).toString("base64") });
    expect(Buffer.byteLength(descriptor)).toBeGreaterThan(2 * 1024 * 1024);
    const request = vi.fn(async () => new Response(descriptor));
    await expect(fetchSignedCustomizationUpdate({ feedUrl: "http://127.0.0.1/latest.json", inboxRoot: path.join(f.root, "large-downloaded"),
      trustedKeys: f.trustedUpdateKeys, fetch: request, allowLocalFeed: true, maxBytes: 0 })).rejects.toMatchObject({ code: "update_download_limit" });
    expect(request).toHaveBeenCalledOnce(); await f.service.close();
  });

  it("accepts local signed descriptors above 2 MiB and rejects local or streamed descriptors above 32 MiB", async () => {
    const f = await fixture(), update = await signedUpdate(f, "descriptor-bounds"), filename = path.join(update.root, "kulo-update.json");
    await fsp.writeFile(filename, " ".repeat(2 * 1024 * 1024) + JSON.stringify(update.envelope));
    expect((await readSignedCustomizationUpdate({ inboxRoot: f.updateInboxRoot, packageName: "descriptor-bounds", trustedKeys: f.trustedUpdateKeys })).envelope.manifest.id).toBe(update.manifest.id);
    const file = await fsp.open(filename, "w"); await file.truncate(32 * 1024 * 1024 + 1); await file.close();
    await expect(readSignedCustomizationUpdate({ inboxRoot: f.updateInboxRoot, packageName: "descriptor-bounds", trustedKeys: f.trustedUpdateKeys })).rejects.toMatchObject({ code: "update_manifest_limit" });
    let chunks = 0, cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({ pull(controller) {
      if (chunks++ < 100) controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); else controller.close();
    }, cancel() { cancelled = true; } });
    await expect(fetchSignedCustomizationUpdate({ feedUrl: "http://127.0.0.1/latest.json", inboxRoot: path.join(f.root, "oversized-downloaded"), trustedKeys: f.trustedUpdateKeys,
      fetch: async () => new Response(oversized), allowLocalFeed: true })).rejects.toMatchObject({ code: "update_manifest_limit" });
    expect(chunks).toBeLessThanOrEqual(35); expect(cancelled).toBe(true); expect(fs.existsSync(path.join(f.root, "oversized-downloaded"))).toBe(false);
    await f.service.close();
  });

  it("keeps a delayed feed inside the heavy-operation lock and aborts it when the Hub closes", async () => {
    const f = await fixture();
    let started!: () => void, closed = false;
    const atRequest = new Promise<void>((resolve) => { started = resolve; });
    const server = http.createServer((_req, res) => { res.once("close", () => { closed = true; }); res.flushHeaders(); started(); });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const service = new KuloCustomizationService({ dataDir: f.dataDir, source: f.source, recovery: f.recovery, runner: f.buildRunner,
      updateInboxRoot: f.updateInboxRoot, trustedUpdateKeys: f.trustedUpdateKeys, allowLocalFeed: true, fetch,
      updateFeedUrl: "http://127.0.0.1:" + (server.address() as { port: number }).port + "/latest.json" });
    expect(await service.status(caller)).toMatchObject({ officialUpdatesAvailable: true });
    const downloading = expect(service.installOfficial(undefined, caller)).rejects.toBeInstanceOf(Error);
    await atRequest;
    await expect(service.prepare({ summary: "must wait", commandId: "overlap" }, caller)).rejects.toMatchObject({ code: "customization_busy" });
    await service.close(); await downloading;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(true); expect(await fsp.readdir(f.updateInboxRoot)).toEqual([]);
    expect(f.buildRunner.probe).not.toHaveBeenCalled(); await f.service.close();
  });

  it("cleans owned downloads after each update or failure and reclaims crash leftovers without deleting local packages", async () => {
    const f = await fixture(), inboxRoot = path.join(f.root, "managed-downloads");
    let update = await signedUpdate(f, "version-zero", { label: "zero" });
    const server = http.createServer(async (req, res) => {
      if (req.url === "/latest.json") { res.end(JSON.stringify(update.envelope)); return; }
      const prefix = "/payloads/" + update.manifest.id + "/";
      if (!req.url?.startsWith(prefix)) { res.statusCode = 404; res.end(); return; }
      res.end(await fsp.readFile(path.join(update.output, decodeURIComponent(req.url.slice(prefix.length)))));
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const service = new KuloCustomizationService({ dataDir: f.dataDir, recovery: f.recovery, runner: f.buildRunner,
      updateInboxRoot: inboxRoot, trustedUpdateKeys: f.trustedUpdateKeys, allowLocalFeed: true, fetch,
      updateFeedUrl: "http://127.0.0.1:" + (server.address() as { port: number }).port + "/latest.json" });
    const unknown = "update-release_" + "d".repeat(24), owned = ".download-11111111-1111-1111-1111-111111111111";
    for (const name of [unknown, owned]) { await fsp.mkdir(path.join(inboxRoot, name), { recursive: true }); await fsp.writeFile(path.join(inboxRoot, name, "payload-bytes"), Buffer.alloc(64 * 1024)); }
    await fsp.writeFile(path.join(inboxRoot, owned, ".kulo-owned-download.json"), JSON.stringify({ formatVersion: 1,
      ownerId: createHash("sha256").update(path.resolve(f.dataDir)).digest("hex"), ownerPid: 2147483647, createdAt: 0 }));
    for (let index = 0; index < 3; index++) {
      update = await signedUpdate(f, "version-" + index, { label: "version-" + index });
      expect(await service.installOfficial(undefined, caller)).toMatchObject({ status: "pending" });
      expect(await fsp.readdir(inboxRoot)).toEqual([unknown]);
    }
    update = await signedUpdate(f, "version-failed", { label: "failed" });
    vi.mocked(f.buildRunner.probe).mockRejectedValueOnce(new Error("fixture probe failed"));
    await expect(service.installOfficial(undefined, caller)).rejects.toThrow("fixture probe failed");
    expect(await fsp.readdir(inboxRoot)).toEqual([unknown]);
    expect((await f.recovery.inspect()).pending?.manifest.artifactHash).not.toBe(update.manifest.artifactHash);
    await service.close(); await f.service.close();
  });

  it("streams a signed feed with two bounded transfers, preserving executable helper bits", async () => {
    const f = await fixture(), update = await signedUpdate(f, "feed");
    let active = 0, maximum = 0;
    const server = http.createServer(async (req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      if (req.url === "/latest.json") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(update.envelope)); return; }
      const prefix = "/payloads/" + update.manifest.id + "/";
      if (!req.url?.startsWith(prefix)) { res.statusCode = 404; res.end(); return; }
      active++; maximum = Math.max(maximum, active);
      const file = decodeURIComponent(req.url.slice(prefix.length));
      const bytes = await fsp.readFile(path.join(update.output, file));
      setTimeout(() => { active--; res.end(bytes); }, 5);
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/latest.json";
    const inboxRoot = path.join(f.root, "downloaded");
    const packageName = await fetchSignedCustomizationUpdate({ feedUrl: url, inboxRoot, trustedKeys: f.trustedUpdateKeys, fetch, allowLocalFeed: true });
    expect(maximum).toBeLessThanOrEqual(2);
    expect((await fsp.stat(path.join(inboxRoot, packageName, "payload/bin/health"))).mode & 0o100).toBe(0o100);
    execFileSync(path.join(inboxRoot, packageName, "payload/bin/health"));
    const downloaded = new KuloCustomizationService({ dataDir: f.dataDir, recovery: f.recovery, runner: f.buildRunner, updateInboxRoot: inboxRoot, trustedUpdateKeys: f.trustedUpdateKeys });
    expect(await downloaded.installOfficial(packageName, caller)).toMatchObject({ status: "pending" });
    expect(f.buildRunner.build).not.toHaveBeenCalled(); await downloaded.close(); await f.service.close();
  });

  it("aborts every in-flight stream before removing a failed download directory", async () => {
    const f = await fixture(), update = await signedUpdate(f, "broken-feed");
    let active = 0;
    const server = http.createServer(async (req, res) => {
      if (req.url === "/latest.json") { res.end(JSON.stringify(update.envelope)); return; }
      const prefix = "/payloads/" + update.manifest.id + "/", relative = decodeURIComponent((req.url ?? "").slice(prefix.length));
      const entry = update.manifest.files.find((file) => file.path === relative);
      if (!entry) { res.statusCode = 404; res.end(); return; }
      active++; let closed = false;
      const finish = () => { if (!closed) { closed = true; active--; } };
      res.once("close", finish);
      if (relative === "bin/health") { res.end(Buffer.alloc(entry.size, 1)); return; }
      const timer = setTimeout(() => { res.end("late data"); }, 5_000);
      res.on("close", () => clearTimeout(timer)); res.flushHeaders();
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/latest.json", inboxRoot = path.join(f.root, "failed-download");
    await expect(fetchSignedCustomizationUpdate({ feedUrl: url, inboxRoot, trustedKeys: f.trustedUpdateKeys, fetch, allowLocalFeed: true }))
      .rejects.toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(active).toBe(0); expect(await fsp.readdir(inboxRoot)).toEqual([]);
    await f.service.close();
  });
});
