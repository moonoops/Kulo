import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, afterEach, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import {
  EXTERNAL_AGENT_MCP_TOOL_NAMES,
  type ExternalAgentRun,
  type WorkerInspectResult,
} from "@moco/protocol";
import { EnvManager } from "@moco/env";
import { MocoStateDoc } from "@moco/hub";
import { openTestHub } from "./helpers/secure-hub.js";
import {
  BRIDGE_EXTERNAL_AGENT_TOOL_ALLOWLIST,
  EXTERNAL_AGENT_MCP_DEFINED_TOOL_NAMES,
  ExternalAgentService,
  ProjectDirectoryRegistry,
  SAFE_HOST_GIT_ARGS,
  applyStagedChanges,
  buildLinuxSandboxArguments,
  buildWindowsSandboxPolicy,
  buildWorkerSandboxProfile,
  cloneStagedWorkspace,
  computeStagedDiff,
  discoverGitWriteDeniedPaths,
  isExternalAgentRequest,
  isExternalAgentResponse,
  safeHostGitEnv,
} from "@moco/env";
import {
  EXTERNAL_AGENT_TOOL_HANDLER_NAMES,
  INSPECT_RESULT_MAX_UTF8_BYTES,
  MocoUploadStore,
  boundInspectResult,
  clampTicketCardReport,
  inferBuiltInWorkerPhaseAndFiles,
  spillOversizedReport,
} from "@moco/hub";
import {
  formatStagedDiffRelayLines,
  formatWorkerRelayMessage,
} from "../packages/hub/src/prompts/events-and-jobs.js";

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Batch 1a — R1.2 External MCP Tool Allowlist Single Source of Truth", () => {
  it("keeps protocol, bridge allowlist, MCP tool definitions, and Hub handler names 100% identical including moco_memory_reflect", () => {
    const expected = [...EXTERNAL_AGENT_MCP_TOOL_NAMES].sort();
    expect(expected).toContain("moco_memory_reflect");
    expect([...BRIDGE_EXTERNAL_AGENT_TOOL_ALLOWLIST].sort()).toEqual(expected);
    expect([...EXTERNAL_AGENT_MCP_DEFINED_TOOL_NAMES].sort()).toEqual(expected);
    expect([...EXTERNAL_AGENT_TOOL_HANDLER_NAMES].sort()).toEqual(expected);
  });
});

describe("Batch 1a — R1.3 Staged Workspace Completeness, Modes, Empty Dirs, Conflicts & Build Caches", () => {
  it("detects tail-byte edits on >16 MiB files via full streaming SHA-256", () => {
    const root = mkTempDir("moco-r13-large-");
    const sourceDir = path.join(root, "src");
    const stagedDir = path.join(root, "staged");
    fs.mkdirSync(sourceDir, { recursive: true });
    const bigFile = path.join(sourceDir, "payload.bin");
    const bytes = Buffer.alloc(17 * 1024 * 1024, 0x41);
    fs.writeFileSync(bigFile, bytes);

    const baseline = cloneStagedWorkspace(sourceDir, stagedDir);
    expect(computeStagedDiff({ sourceDir, stagedDir, baseline }).hasChanges).toBe(false);

    // Mutate only the very last byte beyond 16 MiB
    const fd = fs.openSync(path.join(stagedDir, "payload.bin"), "r+");
    try {
      fs.writeSync(fd, Buffer.from([0x42]), 0, 1, bytes.length - 1);
    } finally {
      fs.closeSync(fd);
    }

    const diff = computeStagedDiff({ sourceDir, stagedDir, baseline });
    expect(diff.hasChanges).toBe(true);
    expect(diff.modified).toEqual(["payload.bin"]);

    const applied = applyStagedChanges({ sourceDir, stagedDir, baseline });
    expect(applied.appliedModified).toEqual(["payload.bin"]);
    const updated = fs.readFileSync(bigFile);
    expect(updated[updated.length - 1]).toBe(0x42);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("tracks exact POSIX exec-bit changes, empty directories, conflict banner, build caches, and sensitive paths", () => {
    const root = mkTempDir("moco-r13-meta-");
    const sourceDir = path.join(root, "src");
    const stagedDir = path.join(root, "staged");
    fs.mkdirSync(path.join(sourceDir, "old-empty"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, ".gitignore"), "ignored-out/\n*.tmp.log\n");
    fs.writeFileSync(path.join(sourceDir, "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o644 });
    fs.writeFileSync(path.join(sourceDir, "conflict.txt"), "base line\n");
    fs.writeFileSync(path.join(sourceDir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest" } }, null, 2));

    const baseline = cloneStagedWorkspace(sourceDir, stagedDir);

    // 1) Exec bit change only (0644 -> 0755)
    if (process.platform !== "win32") {
      fs.chmodSync(path.join(stagedDir, "run.sh"), 0o755);
    }
    // 2) Add empty dir & remove old empty dir
    fs.mkdirSync(path.join(stagedDir, "new-empty/nested"), { recursive: true });
    fs.rmdirSync(path.join(stagedDir, "old-empty"));
    // 3) Concurrent live edit on conflict.txt
    fs.writeFileSync(path.join(sourceDir, "conflict.txt"), "live edit\n");
    fs.writeFileSync(path.join(stagedDir, "conflict.txt"), "staged edit\n");
    // 4) Build caches & gitignored noise (must be excluded)
    fs.mkdirSync(path.join(stagedDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, "dist/bundle.js"), "console.log(1)");
    fs.mkdirSync(path.join(stagedDir, "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, "__pycache__/mod.pyc"), "bytecode");
    fs.writeFileSync(path.join(stagedDir, "tsconfig.tsbuildinfo"), "{}");
    fs.mkdirSync(path.join(stagedDir, "ignored-out"), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, "ignored-out/noise.txt"), "noise");
    fs.writeFileSync(path.join(stagedDir, "debug.tmp.log"), "log");
    // 5) Sensitive auto-exec paths (.husky + package.json postinstall)
    fs.mkdirSync(path.join(stagedDir, ".husky"), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, ".husky/pre-commit"), "echo hook\n");
    fs.writeFileSync(
      path.join(stagedDir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "vitest", postinstall: "node evil.js" } }, null, 2),
    );

    const diff = computeStagedDiff({ sourceDir, stagedDir, baseline });
    expect(diff.hasChanges).toBe(true);
    expect(diff.added).toContain(".husky/pre-commit");
    expect(diff.added).not.toContain("dist/bundle.js");
    expect(diff.added).not.toContain("__pycache__/mod.pyc");
    expect(diff.added).not.toContain("tsconfig.tsbuildinfo");
    expect(diff.added).not.toContain("ignored-out/noise.txt");
    expect(diff.added).not.toContain("debug.tmp.log");
    expect(diff.emptyDirsAdded).toEqual(["new-empty/nested"]);
    expect(diff.emptyDirsDeleted).toEqual(["old-empty"]);
    expect(diff.conflictFiles).toEqual(["conflict.txt"]);
    expect(diff.unifiedPreview).toContain("[Source file modified concurrently since task baseline; diff shown against current live file]");
    expect(diff.sensitivePaths).toContain(".husky/pre-commit");
    expect(diff.sensitivePaths).toContain("package.json");
    if (process.platform !== "win32") {
      expect(diff.modeChanged).toEqual(["run.sh"]);
      expect(diff.sensitivePaths).toContain("run.sh");
      expect(diff.unifiedPreview).toContain("new mode 100755");
    }

    const relayLines = formatStagedDiffRelayLines(diff);
    expect(relayLines.join("\n")).toContain("[HIGH-SENSITIVITY PATHS]");

    // Hard-reject .git/** paths on apply
    expect(() =>
      applyStagedChanges({ sourceDir, stagedDir, baseline, paths: [".git/hooks/pre-commit"] }),
    ).toThrow(/Disallowed relative workspace path/i);

    // Apply with allowConflicts: true and verify mode + empty dirs + no build cache leaked
    applyStagedChanges({ sourceDir, stagedDir, baseline, allowConflicts: true });
    expect(fs.existsSync(path.join(sourceDir, "new-empty/nested"))).toBe(true);
    expect(fs.existsSync(path.join(sourceDir, "old-empty"))).toBe(false);
    expect(fs.existsSync(path.join(sourceDir, "dist/bundle.js"))).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(sourceDir, "run.sh")).mode & 0o111).toBe(0o111);
    }

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("Batch 1a — R1.4 Three-Platform writeDeniedPaths (Readable, Write-Denied)", () => {
  it("discovers git hooks/config/worktree/attributes/modules and enforces Seatbelt, Linux bwrap, and Windows policy", () => {
    const root = mkTempDir("moco-r14-git-");
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const init = spawnSync("git", [...SAFE_HOST_GIT_ARGS, "init", repo], { encoding: "utf8", env: safeHostGitEnv() });
    expect(init.status).toBe(0);
    fs.mkdirSync(path.join(repo, ".git/modules/sub/hooks"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git/modules/sub/config"), "[core]\n");
    fs.writeFileSync(path.join(repo, "hello.txt"), "world\n");

    const denied = discoverGitWriteDeniedPaths(repo);
    const canonRepo = fs.realpathSync(repo);
    expect(denied).toContain(path.join(canonRepo, ".git", "hooks"));
    expect(denied).toContain(path.join(canonRepo, ".git", "config"));
    expect(denied).toContain(path.join(canonRepo, ".git", "config.worktree"));
    expect(denied).toContain(path.join(canonRepo, ".git", "info", "attributes"));
    expect(denied).toContain(path.join(canonRepo, ".git", "modules", "sub", "hooks"));
    expect(denied).toContain(path.join(canonRepo, ".git", "modules", "sub", "config"));

    // 1) Linux bwrap args: --ro-bind ONLY for existing targets (no crash on nonexistent config.worktree)
    const linuxArgs = buildLinuxSandboxArguments({
      workspaceDir: canonRepo,
      temporaryDir: path.join(root, "tmp"),
      executable: "/bin/sh",
      protectedPaths: [],
      writeDeniedPaths: denied,
      port: 34567,
    });
    const roBindTargets: string[] = [];
    for (let i = 0; i < linuxArgs.length - 2; i++) {
      if (linuxArgs[i] === "--ro-bind") roBindTargets.push(linuxArgs[i + 2]!);
    }
    expect(roBindTargets).toContain(path.join(canonRepo, ".git", "hooks"));
    expect(roBindTargets).toContain(path.join(canonRepo, ".git", "config"));
    expect(roBindTargets).not.toContain(path.join(canonRepo, ".git", "config.worktree"));

    // 2) Windows policy: writeDeniedPaths stored separately from protectedPaths
    const winPolicy = buildWindowsSandboxPolicy({
      workspaceDir: "C:\\Work\\Repo",
      temporaryDir: "C:\\Temp\\moco-worker",
      executable: "C:\\Program Files\\Moco\\pi-env.exe",
      protectedPaths: ["C:\\Users\\Alice\\.ssh"],
      writeDeniedPaths: ["C:\\Work\\Repo\\.git\\hooks", "C:\\Work\\Repo\\.git\\config"],
      port: 34567,
    });
    expect(winPolicy.writeDeniedPaths).toEqual([
      "C:\\Work\\Repo\\.git\\hooks",
      "C:\\Work\\Repo\\.git\\config",
    ]);
    expect(winPolicy.protectedPaths).not.toContain("C:\\Work\\Repo\\.git\\hooks");

    // 3) macOS Seatbelt live execution test (git status allowed, writes to .git/hooks, .git/config, and mv .git denied)
    if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
      const profile = buildWorkerSandboxProfile({
        writablePaths: [canonRepo],
        executable: "/bin/sh",
        protectedPaths: [],
        writeDeniedPaths: denied,
      });
      expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(path.join(canonRepo, ".git", "hooks"))}))`);
      expect(profile).not.toContain(`(deny file-read* (subpath ${JSON.stringify(path.join(canonRepo, ".git", "hooks"))}))`);

      const statusRes = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/git", ...SAFE_HOST_GIT_ARGS, "-C", canonRepo, "status", "--short"], {
        encoding: "utf8",
        env: safeHostGitEnv(),
      });
      expect(statusRes.status).toBe(0);
      expect(statusRes.stdout).toContain("hello.txt");

      const hookWrite = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", `echo pwn > "${path.join(canonRepo, ".git/hooks/post-checkout")}"`], {
        encoding: "utf8",
      });
      expect(hookWrite.status).not.toBe(0);

      const configWrite = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", `echo '[core]' >> "${path.join(canonRepo, ".git/config")}"`], {
        encoding: "utf8",
      });
      expect(configWrite.status).not.toBe(0);

      const renameGit = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", `mv "${path.join(canonRepo, ".git")}" "${path.join(canonRepo, ".git.bak")}"`], {
        encoding: "utf8",
      });
      expect(renameGit.status).not.toBe(0);
      expect(fs.existsSync(path.join(canonRepo, ".git"))).toBe(true);
    }

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("Batch 1a — R1.6, R1.7 & R2.3 ExternalAgentService Audit, Resumable Timeout & Compact Inspect", () => {
  it("detects read-only native Shell mutation on project clone (discarded) and direct dir, tracks phase/touchedFiles, supports compact inspect, and marks timeout uncertainReason", async () => {
    const root = mkTempDir("moco-r16-ext-");
    const envRoot = path.join(root, "env-root");
    const privateDir = path.join(root, "private");
    const projectDir = path.join(root, "project");
    fs.mkdirSync(envRoot, { recursive: true });
    fs.mkdirSync(privateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "app.ts"), "export const x = 1;\n");

    const scratchRoot = path.join(root, "scratch");
    fs.mkdirSync(scratchRoot, { recursive: true });
    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(privateDir, "project-directories.json"),
      scratchRoot,
    });
    const grant = registry.authorize({ projectId: "proj-ro", path: projectDir, operationId: "grant-ro-1" });

    const fakeAcpScript = path.join(root, "fake-dsh");
    fs.writeFileSync(fakeAcpScript, "#!/bin/sh\necho 'dsh 0.1.0'\n", { mode: 0o755 });

    let fakeMode: "ro_violate" | "ro_direct" | "timeout" = "ro_violate";
    const service = new ExternalAgentService({
      envId: "local",
      rootDir: envRoot,
      projectRegistry: registry,
      pipeFactory: async (spec) => {
        let closed = false;
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
        const emit = (obj: unknown) => {
          if (!closed) spec.onStdout(Buffer.from(`${JSON.stringify(obj)}\n`));
        };
        return {
          write(data: string) {
            if (closed) return;
            for (const line of data.split("\n").filter(Boolean)) {
              const msg = JSON.parse(line) as { id?: number | string; method?: string };
              if (msg.method === "initialize") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }));
              } else if (msg.method === "session/new") {
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-checkpoint-1" } }));
              } else if (msg.method === "session/prompt") {
                queueMicrotask(() => {
                  for (let i = 0; i < 20; i++) {
                    emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-checkpoint-1", update: { sessionUpdate: "tool_call", title: `read src/file${i}.ts` } } });
                  }
                  emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-checkpoint-1", update: { sessionUpdate: "tool_call", title: "pnpm test packages/hub/src/hub.ts" } } });
                  emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-checkpoint-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A".repeat(4000) } } } });
                  if (fakeMode === "ro_violate" || fakeMode === "ro_direct") {
                    fs.writeFileSync(path.join(spec.cwd, "app.ts"), "export const x = 2; // unauthorized edit\n");
                    fs.mkdirSync(path.join(spec.cwd, "__pycache__"), { recursive: true });
                    fs.writeFileSync(path.join(spec.cwd, "__pycache__/ignore.pyc"), "ignored");
                    emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
                    closed = true;
                    resolveExit(0);
                  } else if (fakeMode === "timeout") {
                    fs.writeFileSync(path.join(spec.cwd, "app.ts"), "export const x = 99;\n");
                  }
                });
              }
            }
          },
          close() {
            if (!closed) {
              closed = true;
              resolveExit(0);
            }
          },
          cleanup: async () => true,
          exited,
        };
      },
    });

    // Validate request/response schemas accept compact, uncertainReason, phase, touchedFiles, readOnlyViolation
    expect(isExternalAgentRequest({ operation: "inspect", runId: "run_1", compact: true })).toBe(true);

    // 1) Read-only violation on staged project clone
    fakeMode = "ro_violate";
    const started = await service.request({
      operation: "run",
      binding: { kind: "dsh", envId: "local", executable: fakeAcpScript },
      taskId: "T-ro-1",
      runEpoch: 1,
      requestId: "req-ro-1",
      prompt: "Audit app.ts read-only",
      cwd: projectDir,
      workspaceMode: "read_only",
      readOnly: true,
      allowSubagents: false,
      projectId: "proj-ro",
      directoryId: grant.directoryId,
      grantRevision: grant.revision,
      timeoutMs: 10_000,
    });
    expect(started.type).toBe("run");

    let finalRun: ExternalAgentRun | undefined;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const res = await service.request({ operation: "inspect", runId: "req-ro-1" });
      if (res.type === "run" && res.run.state === "completed" && res.run.quiescent) {
        finalRun = res.run;
        break;
      }
    }
    expect(finalRun).toBeDefined();
    expect(isExternalAgentResponse({ type: "run", run: finalRun })).toBe(true);
    expect(finalRun!.readOnlyViolation).toEqual({
      mutatedPaths: ["app.ts"],
      totalCount: 1,
      discardedFromClone: true,
    });
    expect(finalRun!.stagedDiff).toBeUndefined();
    expect(finalRun!.phase).toBe("responding");
    expect(finalRun!.touchedFiles?.length).toBeGreaterThan(0);
    // Live project untouched
    expect(fs.readFileSync(path.join(projectDir, "app.ts"), "utf8")).toBe("export const x = 1;\n");

    // Compact inspect bounds events <= 15 and text <= 1600
    const compactRes = await service.request({ operation: "inspect", runId: "req-ro-1", compact: true });
    expect(compactRes.type).toBe("run");
    if (compactRes.type === "run") {
      expect(compactRes.run.events.length).toBeLessThanOrEqual(15);
      expect(compactRes.run.text.length).toBeLessThanOrEqual(1600);
    }

    // 2) Direct (non-project) read-only violation -> discardedFromClone: false
    const directDir = path.join(envRoot, "direct-ro");
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(path.join(directDir, "app.ts"), "export const x = 1;\n");
    fakeMode = "ro_direct";
    await service.request({
      operation: "run",
      binding: { kind: "dsh", envId: "local", executable: fakeAcpScript },
      taskId: "T-ro-direct",
      runEpoch: 1,
      requestId: "req-ro-direct",
      prompt: "Audit direct dir read-only",
      cwd: directDir,
      readOnly: true,
      allowSubagents: false,
      timeoutMs: 10_000,
    });
    let directRun: ExternalAgentRun | undefined;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const res = await service.request({ operation: "inspect", runId: "req-ro-direct" });
      if (res.type === "run" && res.run.state === "completed" && res.run.quiescent) {
        directRun = res.run;
        break;
      }
    }
    expect(directRun?.readOnlyViolation).toEqual({
      mutatedPaths: ["app.ts"],
      totalCount: 1,
      discardedFromClone: false,
    });

    // 3) Timeout with native sessionId and staged partial changes
    fakeMode = "timeout";
    await service.request({
      operation: "run",
      binding: { kind: "dsh", envId: "local", executable: fakeAcpScript },
      taskId: "T-to-1",
      runEpoch: 1,
      requestId: "req-to-1",
      prompt: "Edit app.ts",
      cwd: projectDir,
      workspaceMode: "staged",
      readOnly: false,
      allowSubagents: false,
      projectId: "proj-ro",
      directoryId: grant.directoryId,
      grantRevision: grant.revision,
      timeoutMs: 1100,
    });

    let timedOutRun: ExternalAgentRun | undefined;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 80));
      const res = await service.request({ operation: "inspect", runId: "req-to-1" });
      if (res.type === "run" && res.run.state === "uncertain") {
        timedOutRun = res.run;
        break;
      }
    }
    expect(timedOutRun).toBeDefined();
    expect(timedOutRun!.uncertainReason).toBe("timeout");
    expect(timedOutRun!.sessionId).toBe("sess-checkpoint-1");
    expect(timedOutRun!.stagedDiff?.modified).toEqual(["app.ts"]);

    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("Batch 1a — R2 Report Spillover, Independent overflowAsset & <= 8 KiB Inspect Bound", () => {
  it("spills >8000-char deliverables idempotently into internal overflowAsset without touching attachments, preserves late URLs, and formats relay warnings", () => {
    const root = mkTempDir("moco-r2-spill-");
    const uploads = new MocoUploadStore(path.join(root, "uploads"));

    const longDeliverable = `${"Body section line.\n".repeat(460)}\nSee [Deep Reference](https://example.com/deep-ref) for details.`;
    expect(longDeliverable.length).toBeGreaterThan(8000);

    const existing16Attachments = Array.from({ length: 16 }, (_, i) => ({
      id: `att_explicit_${i}`,
      name: `file-${i}.txt`,
      mimeType: "text/plain",
      size: 10,
      kind: "file" as const,
      url: `/api/uploads/att_explicit_${i}`,
    }));

    const spilledA = spillOversizedReport({
      uploads,
      ticketId: "T-0001",
      runEpoch: 2,
      version: 1,
      ownerConversationId: 10,
      originConversationId: 1,
      report: {
        state: "ready",
        summary: "S".repeat(4500),
        deliverable: longDeliverable,
        attachments: existing16Attachments,
        at: 1000,
      },
    });
    const spilledB = spillOversizedReport({
      uploads,
      ticketId: "T-0001",
      runEpoch: 2,
      version: 1,
      ownerConversationId: 10,
      originConversationId: 1,
      report: {
        state: "ready",
        summary: "S".repeat(4500),
        deliverable: longDeliverable,
        attachments: existing16Attachments,
        at: 1000,
      },
    });

    // Idempotent overflowAsset ID & does not consume the 16 explicit attachments
    expect(spilledA.overflowAsset).toBeDefined();
    expect(spilledA.overflowAsset!.id).toBe(spilledB.overflowAsset!.id);
    expect(spilledA.overflowAsset!.totalChars).toBe(longDeliverable.length);
    expect(spilledA.attachments).toHaveLength(16);
    expect(spilledA.summary.length).toBeLessThanOrEqual(4000);
    expect(spilledA.deliverable!.length).toBeLessThan(3500);
    expect(spilledA.deliverable).toContain("https://example.com/deep-ref");

    const stored = uploads.getUpload(spilledA.overflowAsset!.id);
    expect(stored?.record.internalOnly).toBe(true);
    expect(uploads.readUploadBytes(stored!).toString("utf8")).toBe(longDeliverable);

    // Ticket card clamp keeps deliverable <= 2000 chars
    const cardReport = clampTicketCardReport({
      state: "ready",
      summary: "ok",
      deliverable: "X".repeat(5000),
      at: 1000,
    });
    expect(cardReport!.deliverable!.length).toBeLessThanOrEqual(2000);

    // Relay formatting includes overflowAsset + readOnlyViolation + resumable timeout guidance
    const relayText = formatWorkerRelayMessage({
      ticketId: "T-0001",
      title: "Architecture review",
      role: "codex",
      report: {
        ...spilledA,
        readOnlyViolation: { mutatedPaths: ["src/a.ts"], totalCount: 1, discardedFromClone: true },
      },
    });
    expect(relayText).toContain("Overflow Handoff Report");
    expect(relayText).toContain("Never call moco_publish_asset");
    expect(relayText).toContain("[READ-ONLY VIOLATION WARNING]");

    const timeoutRelay = formatWorkerRelayMessage({
      ticketId: "T-0002",
      title: "Refactor",
      role: "codex",
      report: { state: "blocked", summary: "timed out", question: "continue?", at: 2000 },
      uncertainReason: "timeout",
      hasNativeSession: true,
    });
    expect(timeoutRelay).toContain("moco_steer");
    expect(timeoutRelay).toContain("native session checkpoint");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("bounds WorkerInspectResult strictly to <= 8192 UTF-8 bytes while preserving priority diagnostics", () => {
    const hugeInspect: WorkerInspectResult = {
      ticketId: "T-0099",
      title: "Large Task",
      role: "coder",
      status: "running",
      runEpoch: 3,
      phase: "verifying",
      touchedFiles: ["packages/hub/src/hub.ts", "packages/env/src/staged-workspace.ts"],
      idleSec: 42,
      busy: true,
      streamingPreview: "中文流式输出".repeat(800),
      thinkingPreview: "思考内容".repeat(500),
      activeTools: [
        { callId: "c1", name: "bash", status: "running", outputTail: "log line\n".repeat(400) },
      ],
      runFailure: { reason: "transient", detail: "detail ".repeat(300) },
      latestReport: {
        state: "progress",
        summary: "Running test suite",
        deliverable: "Long verbose deliverable ".repeat(500),
        at: Date.now(),
      },
      recentEntries: Array.from({ length: 20 }, (_, i) => ({
        id: i + 1,
        kind: "tool_result" as const,
        summary: `Entry #${i + 1}: ${"verbose output ".repeat(80)}`,
        createdAt: Date.now() - (20 - i) * 1000,
      })),
    };

    const bounded = boundInspectResult(hugeInspect, INSPECT_RESULT_MAX_UTF8_BYTES);
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(INSPECT_RESULT_MAX_UTF8_BYTES);
    expect(bounded.ticketId).toBe("T-0099");
    expect(bounded.phase).toBe("verifying");
    expect(bounded.idleSec).toBe(42);
    expect(bounded.touchedFiles).toContain("packages/hub/src/hub.ts");
    expect(bounded.latestReport?.summary).toContain("Running test suite");

    const inferred = inferBuiltInWorkerPhaseAndFiles({
      activeTools: [{ name: "bash", status: "running", outputTail: "pnpm vitest run tests/a.test.ts" }],
      recentEntries: [{ id: 1, kind: "tool_call", summary: "edit packages/hub/src/scheduler.ts", createdAt: 1 }],
    });
    expect(inferred.phase).toBe("verifying");
    expect(inferred.touchedFiles).toContain("packages/hub/src/scheduler.ts");
  });
});

describe("Batch 1a — R1.1 + R2 Hub E2E Explicit Ready Preservation & Overflow Isolation", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it("preserves explicit moco_task_report(state='ready') summary, attachment, and overflowAsset across polling errors and natural completed exit", async () => {
    const root = mkTempDir("moco-r11-e2e-");
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const projectDir = path.join(root, "demo-project");
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "export const v = 1;\n");

    const fakeBin = path.join(root, "fake-codex");
    fs.writeFileSync(fakeBin, "#!/bin/sh\necho 'codex 0.1.0'\n", { mode: 0o755 });

    const models = createModels();
    const provider = fauxProvider({ provider: "openai", models: [{ id: "hub-model" }] });
    provider.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("Done")])));
    models.setProvider(provider.provider);

    const context = BACKGROUND_CONTEXT;
    let mcpToolHandler: ((inv: any) => Promise<unknown>) | undefined;
    const origSetHandlerFn = EnvManager.prototype.setExternalAgentToolHandler;
    const captureSpy = vi.spyOn(EnvManager.prototype, "setExternalAgentToolHandler").mockImplementation(function (this: EnvManager, handler) {
      mcpToolHandler = handler as any;
      return origSetHandlerFn.call(this, handler);
    });
    cleanups.push(() => captureSpy.mockRestore());

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
          "codex-r11": {
            id: "codex-r11",
            label: "Codex R1.1",
            whenToUse: "Test external explicit ready preservation",
            prompt: "You are a test external agent.",
            enabled: true,
            modelId: "gpt-5-codex",
            thinkingLevel: "high",
            external: { kind: "codex", envId: "local", executable: fakeBin, verifiedAt: 1_700_000_000_000 },
          },
        },
      },
    });
    cleanups.push(() => hub.close());

    const project = await hub.projects.create({
      commandId: "create-r11-proj",
      name: "R11 Demo",
      deviceId: "local",
      workspaceDir: projectDir,
    });

    const registry = new ProjectDirectoryRegistry({
      deviceId: "local",
      filePath: path.join(root, "native-control", "grants.json"),
      scratchRoot: path.join(root, "workspace", "scratch"),
    });
    registry.authorize({ id: project.directoryId, projectId: project.id, path: projectDir, operationId: "grant-r11-1" });

    let latestStartedRun: { runId: string; taskId: string; runEpoch: number } | undefined;
    const service = new ExternalAgentService({
      envId: "local",
      rootDir: path.join(root, "workspace"),
      projectRegistry: registry,
      toolHandler: (inv) => mcpToolHandler!(inv),
      pipeFactory: async (spec) => {
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
                queueMicrotask(() => emit({ jsonrpc: "2.0", id: parsed.id, result: { thread: { id: "thread-r11-1" } } }));
              } else if (parsed.method === "turn/start") {
                fs.writeFileSync(path.join(spec.cwd, "report.txt"), "formal artifact content\n");
                queueMicrotask(() => {
                  emit({ jsonrpc: "2.0", id: parsed.id, result: { turn: { id: "turn-r11-1", status: "inProgress" } } });
                  emit({ method: "item/agentMessage/delta", params: { threadId: "thread-r11-1", delta: "Chatter stdout text that MUST NOT clobber explicit ready report" } });
                });
                let reportErr: unknown;
                void (async () => {
                  try {
                    // Wait until Hub has committed runId & stagedCwd on the ticket
                    for (let w = 0; w < 40; w++) {
                      const s = await hub.harness.snapshot(MocoStateDoc, context);
                      const t = latestStartedRun ? s?.tickets[latestStartedRun.taskId] : undefined;
                      if (t?.status === "running" && t.externalExecution?.runId === latestStartedRun?.runId && t.externalExecution?.stagedCwd) {
                        break;
                      }
                      await new Promise((r) => setTimeout(r, 25));
                    }
                    const runMeta = latestStartedRun!;
                    await mcpToolHandler!({
                      envId: "local",
                      runId: runMeta.runId,
                      taskId: runMeta.taskId,
                      runEpoch: runMeta.runEpoch,
                      cwd: projectDir,
                      allowSubagents: false,
                      name: "moco_task_report",
                      args: {
                        state: "ready",
                        summary: "EXPLICIT_READY_SUMMARY_PRESERVED",
                        deliverable: "Long detailed explicit report.\n".repeat(320),
                        files: [{ path: "report.txt", name: "report.txt" }],
                      },
                    });
                    await new Promise((r) => setTimeout(r, 120));
                    emit({ method: "turn/completed", params: { threadId: "thread-r11-1", turn: { id: "turn-r11-1", status: "completed" } } });
                    closed = true;
                    resolveExit(0);
                  } catch (err) {
                    reportErr = err;
                    emit({ method: "turn/completed", params: { threadId: "thread-r11-1", turn: { id: "turn-r11-1", status: "failed" } } });
                    closed = true;
                    resolveExit(1);
                  }
                })();
                void reportErr;
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
          cleanup: async () => true,
          exited,
        };
      },
    });
    cleanups.push(() => service.close());

    let transientErrorInjected = false;
    vi.spyOn(hub.envManager, "requestExternalAgent").mockImplementation(async (_envId, req) => {
      if (req.operation === "run") {
        latestStartedRun = { runId: req.requestId, taskId: req.taskId, runEpoch: req.runEpoch };
      }
      if (req.operation === "inspect" && !req.compact && !transientErrorInjected) {
        transientErrorInjected = true;
        throw new Error("Transient polling hiccup");
      }
      return service.request(req);
    });

    const card = await hub.dispatchTicket({
      commandId: "dispatch-r11-1",
      title: "Explicit ready test",
      goal: "Generate formal report and submit via moco_task_report",
      scope: "src/**",
      role: "codex-r11",
      projectId: project.id,
    });

    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(MocoStateDoc, context);
      expect(snap?.tickets[card.id]?.status).toBe("ready");
    }, { timeout: 10_000, interval: 40 });

    const snap = await hub.harness.snapshot(MocoStateDoc, context);
    const ticket = snap!.tickets[card.id]!;
    // R1.1: explicit ready summary, attachment, AND R2 overflowAsset MUST survive transient polling error & completed exit!
    expect(ticket.latestReport?.state).toBe("ready");
    expect(ticket.latestReport?.summary).toBe("EXPLICIT_READY_SUMMARY_PRESERVED");
    expect(ticket.latestReport?.attachments?.map((a) => a.name)).toEqual(["report.txt"]);
    expect(ticket.latestReport?.overflowAsset?.id).toBeTruthy();
    expect(ticket.latestReport?.overflowAsset?.totalChars).toBeGreaterThan(8000);

    // R2.2: listTicketDeliverables exposes formal report.txt but NOT internal overflowAsset
    const deliverables = await hub.listTicketDeliverables(card.id, context);
    expect("files" in deliverables && deliverables.files.map((f) => f.name)).toEqual(["report.txt"]);
    expect("files" in deliverables && deliverables.files.some((f) => f.id === ticket.latestReport?.overflowAsset?.id)).toBe(false);

    // R2.3: inspectWorker returns bounded <= 8192 UTF-8 bytes with phase & compact external inspect
    const inspect = await hub.inspectWorker(card.id, context);
    expect(Buffer.byteLength(JSON.stringify(inspect), "utf8")).toBeLessThanOrEqual(INSPECT_RESULT_MAX_UTF8_BYTES);
    expect(inspect.phase).toBeTruthy();
  });
});
