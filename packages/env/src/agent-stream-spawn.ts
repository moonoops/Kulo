import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { localDaemon } from "@earendil-works/pi-env";
import type { ExecutionTrustMode, HubToEnvControlMessage, ProjectEnvRequest } from "@kulo/protocol";
import {
  canonicalExecutionPath,
  createWorkerSandbox,
  nativeProtectedPaths,
  type WorkerSandbox,
} from "./isolation.js";
import type { ProjectDirectoryRegistry } from "./project-directories.js";
import type { StagedWorkspaceService } from "./staged-workspace-service.js";
import {
  buildCoreStateProtectedPaths,
  buildTrustedHostEnv,
  createTrustedWorkerSession,
} from "./trusted-execution.js";
import { cleanupRecordedExecutions, hasOrphanedExecution } from "./worker-supervisor.js";

export interface AgentStreamScope {
  workspaceDir?: string;
  scratchDir?: string;
  projectId?: string;
  executionKey?: string;
  controlDir?: string;
}

export function ownRuntimeProtectedPaths(): string[] {
  const envPackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const paths = [envPackage, path.join(envPackage, "node_modules"), path.resolve(envPackage, "../../node_modules")];
  for (const sibling of ["cli", "protocol"]) paths.push(path.resolve(envPackage, "..", sibling));
  try {
    const protocolEntry = createRequire(import.meta.url).resolve("@kulo/protocol");
    paths.push(path.resolve(path.dirname(protocolEntry), ".."));
  } catch (error) {
    // Installed peers bundle the protocol into their own protected runtime.
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  }
  for (let current = envPackage; current !== path.dirname(current); current = path.dirname(current)) {
    if (path.basename(current) === "node_modules") paths.push(current);
  }
  return [...new Set(paths.filter((entry) => fs.existsSync(entry)))];
}

export function buildAgentCoreProtectedPaths(options: {
  rootDir: string;
  privateDirectory: string;
  extraProtectedPaths?: readonly string[];
}): string[] {
  return buildCoreStateProtectedPaths({
    stateDir: path.join(options.rootDir, ".kulo-state"),
    extraProtectedPaths: options.extraProtectedPaths,
    controlDirs: [
      options.privateDirectory,
      path.resolve(process.env.KULO_PEER_CONFIG?.trim() || path.join(os.homedir(), ".kulo", "connection.json")),
    ],
  });
}

export function buildAgentSandboxProtectedPaths(options: {
  rootDir: string;
  privateDirectory: string;
  launchProtectedPaths: readonly string[];
  extraProtectedPaths?: readonly string[];
}): string[] {
  return [
    path.join(options.rootDir, ".kulo-state"),
    path.join(options.rootDir, ".env"),
    options.privateDirectory,
    ...options.launchProtectedPaths,
    ...ownRuntimeProtectedPaths(),
    ...(options.extraProtectedPaths ?? []),
  ];
}

export async function cleanupAgentProjectScopes(
  request: Extract<ProjectEnvRequest, { action: "revoke" | "cleanup" }>,
  deps: {
    projectDirectories: ProjectDirectoryRegistry;
    stagedWorkspaces: StagedWorkspaceService;
    streamScopes: ReadonlyMap<number, AgentStreamScope>;
    stopExternalProject: (projectId: string) => Promise<boolean>;
    stopStream: (streamId: number) => Promise<boolean>;
  },
): Promise<{ cleanupPending: boolean }> {
  if (request.action === "revoke") {
    deps.projectDirectories.revoke(request.projectId);
    deps.stagedWorkspaces.discardProject(request.projectId);
  }
  const selected = [...deps.streamScopes].filter(([, scope]) =>
    request.action === "revoke"
      ? scope.projectId === request.projectId
      : scope.workspaceDir === canonicalExecutionPath(request.workspaceDir)
        && (request.scratchDir === undefined || scope.scratchDir === canonicalExecutionPath(request.scratchDir))
        && (request.executionKey === undefined || scope.executionKey === request.executionKey),
  );
  const selectedIds = new Set(selected.map(([id]) => id));
  const excludeDirectories = new Set<string>();
  for (const [id, scope] of deps.streamScopes) {
    if (selectedIds.has(id)) continue;
    if (scope.controlDir) excludeDirectories.add(scope.controlDir);
  }
  const externalPending = request.action === "revoke" ? await deps.stopExternalProject(request.projectId) : false;
  const pending = await Promise.all(selected.map(([id]) => deps.stopStream(id)));
  const recordedPending = await cleanupRecordedExecutions(
    path.join(deps.projectDirectories.privateDirectory, "executions"),
    request.action === "revoke"
      ? { projectId: request.projectId }
      : {
          workspaceDir: canonicalExecutionPath(request.workspaceDir),
          ...(request.scratchDir ? { scratchDir: canonicalExecutionPath(request.scratchDir) } : {}),
          ...(request.executionKey ? { executionKey: request.executionKey } : {}),
          excludeDirectories,
        },
  );
  return { cleanupPending: externalPending || pending.some(Boolean) || recordedPending };
}

export interface PreparedAgentDaemonSpawn {
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  workerSandbox?: WorkerSandbox;
}

/**
 * Read-only Workers cannot create their workspace, so an explicit or inferred directory must already exist;
 * otherwise sandbox setup would silently mount an empty directory. Kulo-managed ticket desks
 * (`<root>/table/<ticket>`) remain created on demand for file-less research tickets.
 */
export function assertReadOnlyWorkspaceExists(rootDir: string, workspaceDir: string): void {
  const relative = path.relative(path.join(canonicalExecutionPath(rootDir), "table"), canonicalExecutionPath(workspaceDir));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
  let directory = false;
  try { directory = fs.statSync(workspaceDir).isDirectory(); } catch { directory = false; }
  if (!directory) throw new Error("Read-only workspace directory does not exist on target Env");
}

export interface AgentStreamSpawnDeps {
  rootDir: string;
  projectDirectories: ProjectDirectoryRegistry;
  stagedWorkspaces: StagedWorkspaceService;
  cleaningStreams: ReadonlyMap<number, Promise<boolean>>;
  streamScopes: ReadonlyMap<number, AgentStreamScope>;
  executionTrustMode: ExecutionTrustMode;
  sandboxProtectedPaths: () => readonly string[];
  coreProtectedPaths: () => readonly string[];
  blockedEnvNames?: () => Iterable<string>;
}

/**
 * Resolve execution mode, validate workspace/scratch grants, and construct
 * the spawn command & environment for an incoming `hub.open_stream` message.
 */
export function prepareAgentDaemonSpawn(
  message: Extract<HubToEnvControlMessage, { type: "hub.open_stream" }>,
  deps: AgentStreamSpawnDeps,
): PreparedAgentDaemonSpawn {
  const requireOsIsolation = Boolean(
    message.readOnly || message.stagedTaskId || message.network?.offline,
  );
  const requestedMode: ExecutionTrustMode =
    message.executionMode ?? deps.executionTrustMode;
  const effectiveMode: ExecutionTrustMode = requireOsIsolation
    ? "sandboxed"
    : requestedMode;

  let command: readonly string[];
  let workerSandbox: WorkerSandbox | undefined;

  if (message.workspaceDir) {
    const controlRoot = path.join(deps.projectDirectories.privateDirectory, "executions");
    const canonicalWs = canonicalExecutionPath(message.workspaceDir);
    if (hasOrphanedExecution(controlRoot, canonicalWs)) {
      throw new Error("Previous Worker execution cleanup is pending");
    }
    let rootDir = canonicalExecutionPath(deps.rootDir);
    if (message.projectId && message.stagedTaskId) {
      rootDir = deps.stagedWorkspaces.validateStagedCwd(
        message.stagedTaskId,
        message.projectId,
        message.workspaceDir,
        message.grantRevision,
      ).stagedDir;
      if (message.scratchDir) deps.projectDirectories.validateScratch(message.scratchDir);
    } else if (message.projectId) {
      rootDir = deps.projectDirectories.validate(
        message.projectId,
        message.workspaceDir,
        message.grantRevision,
      ).workspaceDir;
      if (message.scratchDir) deps.projectDirectories.validateScratch(message.scratchDir);
    }
    if (!message.projectId) {
      deps.projectDirectories.assertUnregistered(message.workspaceDir);
      if (message.scratchDir) deps.projectDirectories.assertUnregistered(message.scratchDir);
    }
    for (const requested of message.projectId
      ? []
      : [message.workspaceDir, ...(message.scratchDir ? [message.scratchDir] : [])]) {
      const relative = path.relative(rootDir, canonicalExecutionPath(requested));
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Worker execution path is outside this Env's registered root");
      }
    }
    // Existence is probed only after grant/root validation so the check cannot act as an out-of-root oracle.
    if (message.readOnly && !message.stagedTaskId) assertReadOnlyWorkspaceExists(deps.rootDir, message.workspaceDir);
    for (const id of deps.cleaningStreams.keys()) {
      if (deps.streamScopes.get(id)?.workspaceDir === canonicalWs) {
        throw new Error("Previous Worker execution cleanup is pending");
      }
    }

    if (effectiveMode === "trusted") {
      workerSandbox = createTrustedWorkerSession({
        workspaceDir: message.workspaceDir,
        scratchDir: message.scratchDir,
        projectId: message.projectId,
        executionKey: message.executionKey,
        controlRoot,
        coreProtectedPaths: nativeProtectedPaths([
          ...deps.coreProtectedPaths(),
          ...(message.protectedPaths ?? []),
        ]),
        blockedEnvNames: deps.blockedEnvNames?.(),
      });
      command = workerSandbox.command;
    } else {
      workerSandbox = createWorkerSandbox({
        workspaceDir: message.workspaceDir,
        workspaceRoot: rootDir,
        managedScratchRoot: deps.projectDirectories.scratchRoot,
        scratchDir: message.scratchDir,
        projectId: message.projectId,
        grantRevision: message.grantRevision,
        executionKey: message.executionKey,
        readOnly: message.readOnly,
        controlRoot,
        protectedPaths: nativeProtectedPaths([
          ...deps.sandboxProtectedPaths(),
          ...(message.protectedPaths ?? []),
        ]),
        network: message.network,
      });
      command = workerSandbox.command;
    }
  } else {
    if (message.readOnly || message.network?.offline || message.projectId || message.stagedTaskId) {
      throw new Error("Sandboxed or constrained execution stream requires workspaceDir");
    }
    command = [localDaemon()];
  }

  const env: NodeJS.ProcessEnv =
    effectiveMode === "trusted"
      ? buildTrustedHostEnv({
          sourceEnv: process.env,
          nonInteractiveSudo: true,
          blockedEnvNames: deps.blockedEnvNames?.(),
        })
      : {
          PATH:
            process.platform === "win32"
              ? `${path.dirname(process.execPath)};${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0`
              : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: workerSandbox ? path.join(workerSandbox.temporaryDir, "home") : os.homedir(),
          TMPDIR: workerSandbox ? path.join(workerSandbox.temporaryDir, "tmp") : os.tmpdir(),
          LANG: "en_US.UTF-8",
          ...(process.platform === "win32"
            ? {
                SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
                WINDIR: process.env.WINDIR ?? "C:\\Windows",
                TEMP: workerSandbox ? path.join(workerSandbox.temporaryDir, "tmp") : os.tmpdir(),
                TMP: workerSandbox ? path.join(workerSandbox.temporaryDir, "tmp") : os.tmpdir(),
                ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
              }
            : {}),
        };

  return {
    command,
    cwd: workerSandbox?.workspaceDir ?? deps.rootDir,
    env,
    workerSandbox,
  };
}
