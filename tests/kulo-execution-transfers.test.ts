import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { MediaJobSource } from "@kulo/protocol";
import { createMediaExporter, type MediaExportOptions } from "../packages/hub/src/tools-media-export.js";
import { ExecutionFileError } from "../packages/hub/src/execution-files.js";
import { KuloSkills } from "../packages/hub/src/skills.js";
import { materializeSkill, type SkillToolsOptions } from "../packages/hub/src/tools-skills.js";
import { KuloUploadStore } from "../packages/hub/src/uploads.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-transfers-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "remote-project");
  const scratch = path.join(directory, "remote-scratch");
  fs.mkdirSync(workspace); fs.mkdirSync(scratch);
  const env = new NodeExecutionEnv({ cwd: workspace });
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const uploads = new KuloUploadStore(path.join(directory, "hub-uploads"));
  const bytes = Buffer.alloc(700_000, "x");
  const asset = uploads.saveUpload({ name: "generated.txt", mimeType: "text/plain", bytes, ownerId: "agent:12" });
  const source: MediaJobSource = { conversationId: 12, topicId: "root", ticketId: "ticket-one", projectId: "project-one", envId: "remote", runEpoch: 1, readOnly: false };
  let active = true;
  const assertActive = vi.fn(async () => { if (!active) throw new ExecutionFileError(403, "execution_revoked", "执行资格已撤销。"); });
  const validateInput = vi.fn(async (id: string, scope: MediaJobSource) => {
    if (!uploads.canReadUpload(id, `agent:${scope.conversationId}`, () => false)) throw new ExecutionFileError(403, "asset_denied", "无权读取资源。");
  });
  const options: MediaExportOptions = { scope: async () => source, assertActive, validateInput, uploads: () => uploads, harness: () => harness };
  const exporter = createMediaExporter(options);
  const api = { env, conversationId: 12, callId: "export-one" } as unknown as ToolExecutionApi;
  const skills = new KuloSkills({ harness, stateDir: path.join(directory, "hub-private") });
  await skills.initialize();
  const skillOptions: SkillToolsOptions = { get: () => skills, audience: () => "worker", executionScope: async () => ({ scratchDir: scratch, assertActive }) };
  function skillSource(dependency = "node") {
    const sourceDir = path.join(directory, "test-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), `---\nname: test-skill\ndescription: Test task workflow.\nmetadata:\n  kulo-dependencies: ${dependency}\n---\nUse the bundled script.\n`);
    fs.mkdirSync(path.join(sourceDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "scripts", "run.mjs"), "throw new Error('script must not run during preparation');\n", { mode: 0o755 });
    return sourceDir;
  }
  return { directory, workspace, scratch, env, harness, uploads, bytes, asset, source, options, exporter, api, assertActive, validateInput,
    revoke: () => { active = false; }, skills, skillOptions, skillSource };
}

describe("media project export", () => {
  it("transfers bounded bytes through the execution Env and verifies completed replays", async () => {
    const f = await fixture();
    const append = vi.spyOn(f.env, "appendFile");
    const first = await f.exporter({ asset_id: f.asset.id, path: "assets/output.txt" }, f.api, BACKGROUND_CONTEXT);
    expect(first.path).toBe(path.join(f.workspace, "assets/output.txt"));
    expect(first.path).not.toContain("hub-uploads");
    expect(fs.readFileSync(first.path)).toEqual(f.bytes);
    expect(append.mock.calls.map((call) => (call[1] as Uint8Array).length)).toEqual([262_144, 262_144, 175_712]);
    const replay = await createMediaExporter(f.options)({ asset_id: f.asset.id, path: "assets/output.txt" }, f.api, BACKGROUND_CONTEXT);
    expect(replay.reused).toBe(true);
    expect(append).toHaveBeenCalledTimes(3);
    fs.writeFileSync(first.path, "edited by the user");
    await expect(f.exporter({ asset_id: f.asset.id, path: "assets/output.txt" }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "media_export_target_changed" });
    expect(fs.readFileSync(first.path, "utf8")).toBe("edited by the user");
  });

  it("rejects changed parameters for a replay and refuses implicit overwrite", async () => {
    const f = await fixture();
    await f.exporter({ asset_id: f.asset.id, path: "one.txt" }, f.api, BACKGROUND_CONTEXT);
    await expect(f.exporter({ asset_id: f.asset.id, path: "two.txt" }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "media_export_command_conflict" });
    fs.writeFileSync(path.join(f.workspace, "existing.txt"), "keep this");
    await expect(f.exporter({ asset_id: f.asset.id, path: "existing.txt" }, { ...f.api, callId: "new-file" } as ToolExecutionApi, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "execution_file_exists" });
    expect(fs.readFileSync(path.join(f.workspace, "existing.txt"), "utf8")).toBe("keep this");
    await f.exporter({ asset_id: f.asset.id, path: "existing.txt", overwrite: true }, { ...f.api, callId: "explicit-replacement" } as ToolExecutionApi, BACKGROUND_CONTEXT);
    expect(fs.readFileSync(path.join(f.workspace, "existing.txt"))).toEqual(f.bytes);
  });

  it("does not overwrite a destination created during transfer", async () => {
    const f = await fixture();
    const flush = f.env.flushFile.bind(f.env);
    vi.spyOn(f.env, "flushFile").mockImplementation(async (...args) => {
      const result = await flush(...args);
      fs.writeFileSync(path.join(f.workspace, "race.txt"), "concurrent content");
      return result;
    });
    await expect(f.exporter({ asset_id: f.asset.id, path: "race.txt" }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "execution_file_exists" });
    expect(fs.readFileSync(path.join(f.workspace, "race.txt"), "utf8")).toBe("concurrent content");
    expect(fs.readdirSync(f.workspace).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("denies traversal, symlink routes, read-only tasks and unrelated resources", async () => {
    const f = await fixture();
    await expect(f.exporter({ asset_id: f.asset.id, path: "../outside.txt" }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "invalid_execution_path" });
    fs.symlinkSync(f.directory, path.join(f.workspace, "linked"));
    await expect(f.exporter({ asset_id: f.asset.id, path: "linked/out.txt" }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "execution_symlink_denied" });
    f.source.readOnly = true;
    await expect(f.exporter({ asset_id: f.asset.id, path: "readonly.txt" }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "media_export_scope_denied" });
    f.source.readOnly = false;
    const privateAsset = f.uploads.saveUpload({ name: "private.txt", mimeType: "text/plain", bytes: Buffer.from("private fixture"), ownerId: "agent:99" });
    await expect(f.exporter({ asset_id: privateAsset.id, path: "private.txt" }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "asset_denied" });
    expect(fs.existsSync(path.join(f.workspace, "private.txt"))).toBe(false);
  });

  it("rechecks execution before publication and never commits revoked work", async () => {
    const f = await fixture();
    const flush = f.env.flushFile.bind(f.env);
    vi.spyOn(f.env, "flushFile").mockImplementation(async (...args) => { const result = await flush(...args); f.revoke(); return result; });
    await expect(f.exporter({ asset_id: f.asset.id, path: "stopped.txt" }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "execution_revoked" });
    expect(fs.existsSync(path.join(f.workspace, "stopped.txt"))).toBe(false);
  });

  it("reconciles a committed file when the durable completion receipt was interrupted", async () => {
    const f = await fixture();
    const commit = f.harness.commit.bind(f.harness);
    let calls = 0;
    const hook = vi.spyOn(f.harness, "commit").mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("simulated interruption after file publication");
      return commit(...args);
    });
    await expect(f.exporter({ asset_id: f.asset.id, path: "receipt.txt" }, f.api, BACKGROUND_CONTEXT)).rejects.toThrow("simulated interruption");
    hook.mockRestore();
    expect(fs.readFileSync(path.join(f.workspace, "receipt.txt"))).toEqual(f.bytes);
    const recovered = await createMediaExporter(f.options)({ asset_id: f.asset.id, path: "receipt.txt" }, f.api, BACKGROUND_CONTEXT);
    expect(recovered.reused).toBe(true);
  });
});

describe("Skill resources on the execution node", () => {
  it("materializes a fixed version into scratch without executing its scripts", async () => {
    const f = await fixture();
    const imported = await f.skills.manage({ action: "import", source: f.skillSource(), commandId: "import-script" });
    const skill = imported.skills.find((entry) => entry.name === "test-skill")!;
    const result = await materializeSkill(f.skillOptions, { id: skill.id, version: skill.version }, f.api, BACKGROUND_CONTEXT);
    expect(result.directory.startsWith(f.scratch)).toBe(true);
    const script = result.files.find((entry) => entry.resource === "scripts/run.mjs")!;
    expect(script.path.startsWith(f.scratch)).toBe(true);
    expect(fs.readFileSync(script.path, "utf8")).toContain("script must not run");
    expect(fs.statSync(script.path).mode & 0o777).toBe(0o500);
    expect((await materializeSkill(f.skillOptions, { id: skill.id, version: skill.version }, f.api, BACKGROUND_CONTEXT)).directory).toBe(result.directory);
    expect(fs.readdirSync(f.workspace)).toEqual([]);
  });

  it("checks dependencies on the target node and preserves old version requirements", async () => {
    const f = await fixture();
    const source = f.skillSource();
    const imported = await f.skills.manage({ action: "import", source, commandId: "import-dependency" });
    const old = imported.skills.find((entry) => entry.name === "test-skill")!;
    f.skillSource("kulo-missing-program-92fe1");
    await f.skills.manage({ action: "update", id: old.id, commandId: "update-dependency" });
    await expect(materializeSkill(f.skillOptions, { id: old.id }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "skill_dependency_missing" });
    expect(fs.existsSync(path.join(f.scratch, "kulo-skills"))).toBe(false);
    expect((await materializeSkill(f.skillOptions, { id: old.id, version: old.version }, f.api, BACKGROUND_CONTEXT)).version).toBe(old.version);
  });

  it("keeps settings agents out of materialization even when an Env is supplied", async () => {
    const f = await fixture();
    await expect(materializeSkill({ ...f.skillOptions, audience: () => "settings" }, { id: "image-generation" }, f.api, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "skill_materialize_scope_denied" });
    await expect(materializeSkill(f.skillOptions, { id: "image-generation" }, { ...f.api, env: undefined } as ToolExecutionApi, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "skill_materialize_scope_denied" });
    expect(fs.readdirSync(f.scratch)).toEqual([]);
  });
});
