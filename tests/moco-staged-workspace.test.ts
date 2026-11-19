import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  ExternalAgentService,
  ProjectDirectoryRegistry,
  StagedWorkspaceConflictError,
  applyStagedChanges,
  cloneStagedWorkspace,
  computeStagedDiff,
} from "@moco/env";
import { MocoStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";

const context = BACKGROUND_CONTEXT;
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("Staged workspace copy-on-write clone, diff, conflict & merge", () => {
  it("isolates staged edits from sourceDir, computes unified diffs, detects conflicts, and merges atomically", () => {
    const root = makeTempDir("moco-staged-unit-");
    const sourceDir = path.join(root, "project");
    const stagedDir = path.join(root, "scratch", "T-0001", "staged");
    fs.mkdirSync(path.join(sourceDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(sourceDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(sourceDir, "src", "app.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(sourceDir, "src", "obsolete.ts"), "export const old = true;\n");

    const baseline = cloneStagedWorkspace(sourceDir, stagedDir);
    expect(Object.keys(baseline)).not.toContain(".git/HEAD");
    expect(Object.keys(baseline)).not.toContain("node_modules/pkg/index.js");
    expect(fs.readFileSync(path.join(stagedDir, "src", "app.ts"), "utf8")).toBe("export const value = 1;\n");

    // Mutate inside staged clone only
    fs.writeFileSync(path.join(stagedDir, "src", "app.ts"), "export const value = 42;\n");
    fs.writeFileSync(path.join(stagedDir, "src", "added.ts"), "export const added = 'ok';\n");
    fs.unlinkSync(path.join(stagedDir, "src", "obsolete.ts"));

    // Real source directory remains completely untouched
    expect(fs.readFileSync(path.join(sourceDir, "src", "app.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(fs.existsSync(path.join(sourceDir, "src", "added.ts"))).toBe(false);
    expect(fs.existsSync(path.join(sourceDir, "src", "obsolete.ts"))).toBe(true);

    const summary = computeStagedDiff({ sourceDir, stagedDir, baseline });
    expect(summary.hasChanges).toBe(true);
    expect(summary.added).toEqual(["src/added.ts"]);
    expect(summary.modified).toEqual(["src/app.ts"]);
    expect(summary.deleted).toEqual(["src/obsolete.ts"]);
    expect(summary.conflictFiles).toEqual([]);
    expect(summary.unifiedPreview).toContain("-export const value = 1;");
    expect(summary.unifiedPreview).toContain("+export const value = 42;");

    const single = computeStagedDiff({ sourceDir, stagedDir, baseline, filePath: "src/added.ts" });
    expect(single.filteredPath).toBe("src/added.ts");
    expect(single.diff).toContain("+export const added = 'ok';");
    expect(single.diff).not.toContain("export const value = 42;");

    // Simulate concurrent edit on sourceDir -> conflict detected
    fs.writeFileSync(path.join(sourceDir, "src", "app.ts"), "export const value = 999;\n");
    const conflicted = computeStagedDiff({ sourceDir, stagedDir, baseline });
    expect(conflicted.conflictFiles).toEqual(["src/app.ts"]);
    expect(() => applyStagedChanges({ sourceDir, stagedDir, baseline })).toThrow(StagedWorkspaceConflictError);
    expect(fs.readFileSync(path.join(sourceDir, "src", "app.ts"), "utf8")).toBe("export const value = 999;\n");

    // Restore sourceDir baseline (or allowConflicts) and merge cleanly
    fs.writeFileSync(path.join(sourceDir, "src", "app.ts"), "export const value = 1;\n");
    const applied = applyStagedChanges({ sourceDir, stagedDir, baseline });
    expect(applied).toEqual({
      appliedAdded: ["src/added.ts"],
      appliedModified: ["src/app.ts"],
      appliedDeleted: ["src/obsolete.ts"],
      cleanedUp: true,
    });
    expect(fs.existsSync(stagedDir)).toBe(false);
    expect(fs.readFileSync(path.join(sourceDir, "src", "app.ts"), "utf8")).toBe("export const value = 42;\n");
    expect(fs.readFileSync(path.join(sourceDir, "src", "added.ts"), "utf8")).toBe("export const added = 'ok';\n");
    expect(fs.existsSync(path.join(sourceDir, "src", "obsolete.ts"))).toBe(false);
    expect(fs.existsSync(path.join(sourceDir, ".git", "HEAD"))).toBe(true);
  });

  it("rejects symlink escapes created inside a staged workspace while tolerating untouched baseline symlinks", () => {
    const root = makeTempDir("moco-staged-symlink-");
    const sourceDir = path.join(root, "project");
    const stagedDir = path.join(root, "staged");
    const secretFile = path.join(root, "outside-secret.txt");
    const sharedTool = path.join(root, "outside-tool.sh");
    fs.mkdirSync(path.join(sourceDir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "readme.md"), "safe\n");
    fs.writeFileSync(secretFile, "TOP_SECRET\n");
    fs.writeFileSync(sharedTool, "#!/bin/sh\necho ok\n");
    // Pre-existing external symlink in sourceDir must NOT block diff or merge when untouched
    fs.symlinkSync(sharedTool, path.join(sourceDir, "tools", "tool.sh"));

    const baseline = cloneStagedWorkspace(sourceDir, stagedDir);
    fs.writeFileSync(path.join(stagedDir, "readme.md"), "updated safely\n");
    const cleanDiff = computeStagedDiff({ sourceDir, stagedDir, baseline });
    expect(cleanDiff.modified).toEqual(["readme.md"]);
    expect(cleanDiff.added).toEqual([]);

    // Newly created external symlink inside stagedDir MUST be rejected
    fs.symlinkSync(secretFile, path.join(stagedDir, "escape.txt"));
    expect(() => computeStagedDiff({ sourceDir, stagedDir, baseline })).toThrow(/symbolic link/i);
    expect(() => applyStagedChanges({ sourceDir, stagedDir, baseline })).toThrow(/symbolic link/i);

    // Removing the rogue symlink allows clean merge without disturbing pre-existing tools/tool.sh
    fs.unlinkSync(path.join(stagedDir, "escape.txt"));
    const merged = applyStagedChanges({ sourceDir, stagedDir, baseline });
    expect(merged.appliedModified).toEqual(["readme.md"]);
    expect(merged.cleanedUp).toBe(true);
    expect(fs.lstatSync(path.join(sourceDir, "tools", "tool.sh")).isSymbolicLink()).toBe(true);
  });

  it("updates baseline on partial paths merge and truncates UTF-8 multibyte previews cleanly", () => {
    const root = makeTempDir("moco-staged-partial-");
    const sourceDir = path.join(root, "project");
    const stagedDir = path.join(root, "staged");
    fs.mkdirSync(path.join(sourceDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(sourceDir, "src", "b.ts"), "export const b = 1;\n");

    const baseline = cloneStagedWorkspace(sourceDir, stagedDir);
    const cjkPayload = "中文注释验证多字节截断安全性".repeat(40);
    fs.writeFileSync(path.join(stagedDir, "src", "a.ts"), `export const a = "${cjkPayload}";\n`);
    fs.writeFileSync(path.join(stagedDir, "src", "b.ts"), `export const b = "${cjkPayload}";\n`);

    const preview = computeStagedDiff({ sourceDir, stagedDir, baseline, maxPreviewBytes: 300 });
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(preview.diff, "utf8")).toBeLessThanOrEqual(300);
    expect(preview.diff).not.toContain("\uFFFD");

    // Apply only src/a.ts first
    const first = applyStagedChanges({ sourceDir, stagedDir, baseline, paths: ["src/a.ts"] });
    expect(first).toEqual({
      appliedAdded: [],
      appliedModified: ["src/a.ts"],
      appliedDeleted: [],
      cleanedUp: false,
    });
    expect(fs.existsSync(stagedDir)).toBe(true);

    // Subsequent user edit to already-merged src/a.ts must NOT cause a false conflict or re-appear in staged diff
    fs.writeFileSync(path.join(sourceDir, "src", "a.ts"), "export const a = 'user-post-merge';\n");
    const remaining = computeStagedDiff({ sourceDir, stagedDir, baseline });
    expect(remaining.modified).toEqual(["src/b.ts"]);
    expect(remaining.conflictFiles).toEqual([]);

    // Apply remaining src/b.ts via paths -> auto-cleans stagedDir since zero pending changes remain
    const second = applyStagedChanges({ sourceDir, stagedDir, baseline, paths: ["src/b.ts"] });
    expect(second).toEqual({
      appliedAdded: [],
      appliedModified: ["src/b.ts"],
      appliedDeleted: [],
      cleanedUp: true,
    });
    expect(fs.existsSync(stagedDir)).toBe(false);
    expect(fs.readFileSync(path.join(sourceDir, "src", "a.ts"), "utf8")).toBe("export const a = 'user-post-merge';\n");
  });
});

describe("Hub + ExternalAgentService staged workspace, context distillation & attachment materialization", () => {
  it("runs project external tickets in an isolated staged clone, relays diff, and merges via applyStagedChanges", async () => {
    const root = makeTempDir("moco-staged-hub-");
    const projectDir = path.join(root, "demo-project");
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "export const greeting = 'hello';\n");

    const fakeBinDir = path.join(root, "bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeCodex = path.join(fakeBinDir, "codex");
    fs.writeFileSync(fakeCodex, "#!/bin/sh\necho 'codex 0.1.0'\n", { mode: 0o755 });

    const models = createModels();
    const provider = fauxProvider({ provider: "openai", models: [{ id: "hub-model" }] });
    provider.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("Reviewed")])));
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      config: {
        stateDir: path.join(root, "state"),
        identityDir: path.join(root, "identity"),
        localEnvRoot: path.join(root, "workspace"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "openai", defaultModel: "hub-model", thinkingLevel: "off", apiKey: "" },
        roles: {
          "codex-architect": {
            id: "codex-architect",
            label: "Codex 架构师",
            whenToUse: "复杂重构与代码演进",
            prompt: "你是架构师。",
            enabled: true,
            modelId: "gpt-5-codex",
            thinkingLevel: "high",
            external: { kind: "codex", envId: "local", executable: fakeCodex, verifiedAt: 1_700_000_000_000 },
          },
        },
      },
    });
    cleanups.push(() => hub.close());

    const project = await hub.projects.create({
      commandId: "create-demo-project",
      name: "Demo Project",
      deviceId: "local",
      workspaceDir: projectDir,
    });

    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(root, "native-control", "grants.json"),
      scratchRoot: path.join(root, "workspace", "scratch"),
    });
    registry.authorize({ id: project.directoryId, projectId: project.id, path: projectDir, operationId: "grant-demo-1" });

    let observedCwd = "";
    let observedPrompt = "";
    const service = new ExternalAgentService({
      envId: "local",
      rootDir: path.join(root, "workspace"),
      projectRegistry: registry,
      pipeFactory: async (spec) => {
        observedCwd = spec.cwd;
        let closed = false;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        const emit = (msg: unknown) => {
          if (!closed) spec.onStdout(Buffer.from(`${JSON.stringify(msg)}\n`));
        };
        return {
          write(data: string) {
            if (closed) return;
            for (const line of data.split("\n").filter(Boolean)) {
              const parsed = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> };
              if (parsed.method === "initialize") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { userAgent: "codex-test" } }));
              } else if (parsed.method === "model/list") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { data: [{ id: "gpt-5-codex", displayName: "GPT-5 Codex", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] } }));
              } else if (parsed.method === "config/read") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { config: {} } }));
              } else if (parsed.method === "thread/start" || parsed.method === "thread/resume") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { thread: { id: "thread-staged-1" } } }));
              } else if (parsed.method === "turn/start") {
                const input = (parsed.params?.input as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
                observedPrompt = input;
                fs.writeFileSync(path.join(spec.cwd, "src", "index.ts"), "export const greeting = 'staged-updated';\n");
                fs.writeFileSync(path.join(spec.cwd, "src", "feature.ts"), "export const feature = true;\n");
                queueMicrotask(() => {
                  emit({ jsonrpc: "2.0", id: parsed.id, result: { turn: { id: "turn-1" } } });
                  emit({ method: "item/agentMessage/delta", params: { threadId: "thread-staged-1", delta: "Completed refactor in isolated workspace." } });
                  emit({ method: "turn/completed", params: { threadId: "thread-staged-1", turn: { id: "turn-1", status: "completed" } } });
                });
              } else if (parsed.id !== undefined) {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: {} }));
              }
            }
          },
          close() {
            if (!closed) {
              closed = true;
              resolveExit(0);
            }
          },
          exited,
          cleanup: async () => true,
        };
      },
    });
    cleanups.push(() => service.close());

    vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation((_envId, req) => service.request(req));

    // Upload a reference attachment and save a connection secret to test redaction + materialization
    await hub.connectionManager.processText("API_SECRET_TOKEN=sk-supersecretvalue1234567890", { requestId: "seed-secret" });
    const uploaded = hub.uploads.saveUpload({
      name: "spec.md",
      mimeType: "text/markdown",
      bytes: Buffer.from("# Architecture Spec\nUse modular exports.\n", "utf8"),
    });

    const card = await hub.dispatchTicket({
      commandId: "dispatch-staged-1",
      title: "重构导出模块",
      goal: "按规范更新导出模块并新增 feature",
      scope: "src/**",
      role: "codex-architect",
      projectId: project.id,
      contextSummary: "用户要求按规范重构，注意脱敏 sk-supersecretvalue1234567890。",
      attachmentIds: [uploaded.id],
    });

    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(MocoStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 8000, interval: 30 });

    // Verify external CLI ran inside staged clone, NOT real projectDir!
    expect(observedCwd).not.toBe(projectDir);
    expect(observedCwd).toContain(path.join(card.id, "staged"));
    expect(fs.readFileSync(path.join(projectDir, "src", "index.ts"), "utf8")).toBe("export const greeting = 'hello';\n");
    expect(fs.existsSync(path.join(projectDir, "src", "feature.ts"))).toBe(false);

    // Verify prompt includes project attributes, redacted context summary, and materialized attachment path
    expect(observedPrompt).toContain(`Project: Demo Project (project_id=${project.id})`);
    expect(observedPrompt).toContain("Workspace Mode: staged clone");
    expect(observedPrompt).not.toContain("sk-supersecretvalue1234567890");
    expect(observedPrompt).toContain("spec.md");
    const inputMatch = observedPrompt.match(/([^\s]+inputs\/01-spec\.md)/);
    expect(inputMatch).not.toBeNull();
    const epoch1InputPath = inputMatch![1]!;
    expect(fs.readFileSync(epoch1InputPath, "utf8")).toContain("# Architecture Spec");

    // Steer with a second attachment having the SAME filename ("spec.md") -> must NOT overwrite Epoch 1's file
    const uploadedV2 = hub.uploads.saveUpload({
      name: "spec.md",
      mimeType: "text/markdown",
      bytes: Buffer.from("# Addendum Spec v2\nKeep strict types.\n", "utf8"),
    });
    await hub.steerTicket({
      commandId: "steer-staged-att-2",
      ticketId: card.id,
      text: "请结合补充规范再次核对",
      attachments: [{ id: uploadedV2.id }],
    });
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(MocoStateDoc, context);
      expect(snap?.tickets[card.id]?.runEpoch).toBe(2);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 8000, interval: 30 });

    const epoch2Match = observedPrompt.match(/([^\s]+inputs\/e2-01-spec\.md)/);
    expect(epoch2Match).not.toBeNull();
    expect(fs.readFileSync(epoch2Match![1]!, "utf8")).toContain("# Addendum Spec v2");
    expect(fs.readFileSync(epoch1InputPath, "utf8")).toContain("# Architecture Spec");

    // Inspect staged diff via Hub controller
    const diff = await hub.inspectStagedDiff(card.id);
    expect(diff.hasChanges).toBe(true);
    expect(diff.added).toEqual(["src/feature.ts"]);
    expect(diff.modified).toEqual(["src/index.ts"]);

    // Verify relay entry contains staged diff summary for Moco's Main Agent
    const rootEntries = await hub.rootConversation.entries({}, 50, undefined, context);
    const relay = rootEntries.items.find((e) => e.kind === "moco.worker_relay");
    expect(relay).toBeDefined();

    // Apply staged changes back to real projectDir
    const applied = await hub.applyStagedChanges({
      commandId: "apply-staged-1",
      ticketId: card.id,
    });
    expect(applied).toEqual({
      appliedAdded: ["src/feature.ts"],
      appliedModified: ["src/index.ts"],
      appliedDeleted: [],
      cleanedUp: true,
    });
    expect(fs.readFileSync(path.join(projectDir, "src", "index.ts"), "utf8")).toBe("export const greeting = 'staged-updated';\n");
    expect(fs.readFileSync(path.join(projectDir, "src", "feature.ts"), "utf8")).toBe("export const feature = true;\n");
    expect(fs.existsSync(observedCwd)).toBe(false);

    const updatedTicket = (await hub.harness.snapshot(MocoStateDoc, context))!.tickets[card.id]!;
    expect(updatedTicket.externalExecution?.stagedAppliedAt).toEqual(expect.any(Number));
    expect(updatedTicket.externalExecution?.stagedCwd).toBeUndefined();

    // Disconnecting the external client removes both the client entry and its persona roles
    const disconnected = await hub.removeExternalClient("codex:local");
    expect(disconnected.settings.externalClients?.["codex:local"]).toBeUndefined();
    expect(disconnected.settings.blocks.roles.value["codex-architect"]).toBeUndefined();
  });

  it("blocks ACP fs/write_text_file against project files in read_only mode while allowing scratch/notes", async () => {
    const root = makeTempDir("moco-readonly-acp-");
    const projectDir = path.join(root, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Original\n");

    const fakeBinDir = path.join(root, "bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeAgy = path.join(fakeBinDir, "agy");
    fs.writeFileSync(fakeAgy, "#!/bin/sh\necho 'agy 1.0.0'\n", { mode: 0o755 });

    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(root, "native-control", "grants.json"),
      scratchRoot: path.join(root, "scratch"),
    });
    const grant = registry.authorize({ id: "dir-ro", projectId: "proj-ro", path: projectDir, operationId: "grant-ro-1" });

    let blockedError = "";
    let noteWriteSucceeded = false;

    const service = new ExternalAgentService({
      envId: "local",
      rootDir: root,
      projectRegistry: registry,
      pipeFactory: async (spec) => {
        let closed = false;
        let promptId: number | string | undefined;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        const emit = (msg: unknown) => {
          if (!closed) spec.onStdout(Buffer.from(`${JSON.stringify(msg)}\n`));
        };
        return {
          write(data: string) {
            if (closed) return;
            for (const line of data.split("\n").filter(Boolean)) {
              const parsed = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; error?: { message?: string }; result?: unknown };
              if (parsed.method === "initialize") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { agentCapabilities: {} } }));
              } else if (parsed.method === "session/new") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { sessionId: "acp-ro-1" } }));
              } else if (parsed.method === "session/prompt") {
                promptId = parsed.id;
                queueMicrotask(() => emit({
                  jsonrpc: "2.0",
                  id: 901,
                  method: "fs/write_text_file",
                  params: { sessionId: "acp-ro-1", path: path.join(spec.cwd, "README.md"), content: "# Overwritten\n" },
                }));
              } else if (parsed.id === 901) {
                blockedError = parsed.error?.message ?? "";
                const notesFile = path.join(root, "scratch", "T-ro", "notes", "audit.md");
                queueMicrotask(() => emit({
                  jsonrpc: "2.0",
                  id: 902,
                  method: "fs/write_text_file",
                  params: { sessionId: "acp-ro-1", path: notesFile, content: "# Audit Report\nAll clean.\n" },
                }));
              } else if (parsed.id === 902) {
                noteWriteSucceeded = !parsed.error;
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } }));
              } else if (parsed.id !== undefined && parsed.method) {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: {} }));
              }
            }
          },
          close() {
            if (!closed) {
              closed = true;
              resolveExit(0);
            }
          },
          exited,
          cleanup: async () => true,
        };
      },
    });
    cleanups.push(() => service.close());

    const started = await service.request({
      operation: "run",
      binding: { kind: "antigravity", envId: "local", executable: fakeAgy, verifiedAt: 1_700_000_000_000 },
      taskId: "T-ro",
      runEpoch: 1,
      requestId: "run-ro-1",
      prompt: "Audit README",
      cwd: projectDir,
      workspaceMode: "read_only",
      readOnly: false,
      allowSubagents: false,
      projectId: "proj-ro",
      directoryId: grant.directoryId,
      grantRevision: grant.revision,
      timeoutMs: 15_000,
    });
    expect(started.type).toBe("run");

    await vi.waitFor(async () => {
      const inspected = await service.request({ operation: "inspect", runId: "run-ro-1" });
      expect(inspected.type === "run" && inspected.run.state).toBe("completed");
      expect(inspected.type === "run" && inspected.run.quiescent).toBe(true);
    }, { timeout: 5000, interval: 20 });

    expect(blockedError).toMatch(/refused|read-only/i);
    expect(noteWriteSucceeded).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, "README.md"), "utf8")).toBe("# Original\n");
    expect(fs.readFileSync(path.join(root, "scratch", "T-ro", "notes", "audit.md"), "utf8")).toContain("# Audit Report");
    // Read-only staged clone is automatically cleaned up once quiescent
    expect(fs.existsSync(path.join(root, "scratch", "T-ro", "staged"))).toBe(false);
  });
});
