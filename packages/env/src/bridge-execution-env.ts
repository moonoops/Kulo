import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import {
  hasTrustedHostExecutionCapability,
  isWorkerEnvReady,
  resolveEffectiveExecutionMode,
  type ComputerUseRequest,
  type EnvNodeDescriptor,
  type ExecutionTrustMode,
  type HostActionRequest,
} from "@kulo/protocol";
import {
  canonicalExecutionPath,
  createWorkerSandbox,
  type WorkerExecutionOptions,
  type WorkerNetworkPolicy,
  type WorkerSandbox,
} from "./isolation.js";
import type { ProjectDirectoryRegistry } from "./project-directories.js";
import type { StagedWorkspaceService } from "./staged-workspace-service.js";
import {
  createTrustedWorkerSession,
  TrustedLocalExecutionEnv,
} from "./trusted-execution.js";
import { cleanupRecordedExecutions, hasOrphanedExecution } from "./worker-supervisor.js";

export interface WorkerConnectionEntry {
  envId: string;
  cwd: string;
  scratchDir?: string;
  projectId?: string;
  executionMode: ExecutionTrustMode;
  executionKey?: string;
  isOrchestrator?: boolean;
  connection: Connection;
  sandbox?: WorkerSandbox;
  cleaning?: boolean;
  retired?: boolean;
}

export interface BridgeExecutionContext {
  closed: boolean;
  localEnvId: string;
  localDescriptor?: EnvNodeDescriptor;
  localConnection: Connection | null;
  localProjects: ProjectDirectoryRegistry | null;
  localStagedWorkspaces: StagedWorkspaceService | null;
  bridgePort: number;
  bridgeSecret: string;
  stdioRelayPath: string;
  workerEnvIds?: readonly string[];
  workerNetwork?: WorkerNetworkPolicy;
  deviceTokens: ReadonlyMap<string, string>;
  revokedProjects: ReadonlySet<string>;
  workerConnections: Map<string, WorkerConnectionEntry>;
  retiredWorkerConnections: Set<WorkerConnectionEntry>;
  cleanupTasks: Set<Promise<boolean>>;
  executionTrustMode: ExecutionTrustMode;
  isLocalEnv: (envId: string) => boolean;
  assertPiEnv: (envId: string) => void;
  getEnvDescriptor: (envId: string) => EnvNodeDescriptor | undefined;
  hasWsPeer: (envId: string) => boolean;
  getWsPeerDescriptor: (envId: string) => EnvNodeDescriptor | undefined;
  getWsPeerConnection: (envId: string, mode: ExecutionTrustMode) => Connection | null;
  getSshPeerConnection: (envId: string) => Connection | null;
  getSandboxProtectedPaths: () => string[];
  getCoreProtectedPaths: () => string[];
  getBlockedEnvNames: () => Iterable<string>;
  abortRemoteStreams: (envId: string, cwd: string, scratchDir?: string, executionKey?: string) => boolean;
  requestRemoteCleanup: (envId: string, cwd: string, scratchDir?: string, executionKey?: string) => Promise<{ cleanupPending: boolean }>;
}

/**
 * Strip `executionMode` before sending to older Peers without `trusted-host-v1` capability
 * so strict schema allowlists on legacy Peers never reject requests during rolling upgrades.
 */
export function scopeHostActionForTarget(
  request: HostActionRequest,
  targetMode: ExecutionTrustMode,
  targetCapabilities: readonly string[],
  isLocal: boolean,
): HostActionRequest {
  const mode = request.executionMode ?? targetMode;
  if (isLocal || hasTrustedHostExecutionCapability(targetCapabilities)) {
    return { ...request, executionMode: mode };
  }
  const { executionMode: _stripped, ...legacy } = request;
  return legacy as HostActionRequest;
}

export function scopeComputerUseForTarget(
  request: ComputerUseRequest,
  targetMode: ExecutionTrustMode,
  targetCapabilities: readonly string[],
  isLocal: boolean,
): ComputerUseRequest {
  const mode = request.executionMode ?? targetMode;
  if (isLocal || hasTrustedHostExecutionCapability(targetCapabilities)) {
    return { ...request, executionMode: mode };
  }
  const { executionMode: _stripped, ...legacy } = request;
  return legacy as ComputerUseRequest;
}

export function pickBridgeDefaultWorkerEnvId(ctx: BridgeExecutionContext): string {
  if (ctx.closed) throw new Error("Env manager is closed");
  const trustMode = ctx.executionTrustMode;
  if (ctx.localDescriptor?.online && isWorkerEnvReady(ctx.localDescriptor, trustMode, { isLocal: true })) {
    return ctx.localEnvId;
  }
  for (const envId of ctx.workerEnvIds ?? []) {
    const descriptor = ctx.getEnvDescriptor(envId);
    if (descriptor?.online && isWorkerEnvReady(descriptor, trustMode, { isLocal: false })) {
      return envId;
    }
  }
  for (const envId of ctx.deviceTokens.keys()) {
    const descriptor = ctx.getEnvDescriptor(envId);
    if (descriptor?.online && isWorkerEnvReady(descriptor, trustMode, { isLocal: false })) {
      return envId;
    }
  }
  throw new Error(
    trustMode === "trusted"
      ? "No ready Worker Env is available. Register an online local or trusted-host-v1 Env before starting a Worker."
      : "No isolated Worker Env is available. Register an approved sandboxed Env before starting a Worker.",
  );
}

function scheduleEntryCleanup(
  entry: WorkerConnectionEntry,
  cleanupTasks: Set<Promise<boolean>>,
  onClean?: () => void,
): void {
  entry.cleaning = true;
  entry.connection.close();
  if (entry.sandbox) {
    const cleanup = entry.sandbox.cleanup().then((pending) => {
      if (!pending) onClean?.();
      return pending;
    });
    cleanupTasks.add(cleanup);
    void cleanup
      .finally(() => cleanupTasks.delete(cleanup))
      .catch((error: unknown) =>
        console.error("[KuloEnv:cleanup]", error instanceof Error ? error.message : "Worker cleanup failed"),
      );
  } else {
    onClean?.();
  }
}

/**
 * Non-destructive retirement for hot-switching executionTrustMode:
 * live Workers move into `retiredWorkerConnections` so they finish cleanly and are never overwritten
 * or leaked when a cacheKey is reused; cached orchestrator sandbox connections are closed & cleaned immediately.
 */
export function retireIdleWorkerConnections(
  workerConnections: Map<string, WorkerConnectionEntry>,
  retiredWorkerConnections: Set<WorkerConnectionEntry>,
  cleanupTasks: Set<Promise<boolean>>,
): void {
  for (const [key, entry] of [...workerConnections]) {
    workerConnections.delete(key);
    if (entry.isOrchestrator) {
      retiredWorkerConnections.add(entry);
      scheduleEntryCleanup(entry, cleanupTasks, () => {
        retiredWorkerConnections.delete(entry);
      });
    } else {
      entry.retired = true;
      retiredWorkerConnections.add(entry);
    }
  }
}

export function invalidateAllWorkerConnections(
  workerConnections: Map<string, WorkerConnectionEntry>,
  cleanupTasks: Set<Promise<boolean>>,
  predicate?: (entry: WorkerConnectionEntry) => boolean,
  retiredWorkerConnections?: Set<WorkerConnectionEntry>,
): void {
  for (const [key, entry] of [...workerConnections]) {
    if (predicate && !predicate(entry)) continue;
    scheduleEntryCleanup(entry, cleanupTasks, () => {
      if (workerConnections.get(key) === entry) workerConnections.delete(key);
    });
  }
  if (retiredWorkerConnections) {
    for (const entry of [...retiredWorkerConnections]) {
      if (predicate && !predicate(entry)) continue;
      scheduleEntryCleanup(entry, cleanupTasks, () => {
        retiredWorkerConnections.delete(entry);
      });
    }
  }
}

export async function releaseBridgeWorkerEnv(
  ctx: BridgeExecutionContext,
  envId: string,
  cwd: string,
  options?: { scratchDir?: string; executionMode?: ExecutionTrustMode; executionKey?: string },
): Promise<{ cleanupPending: boolean }> {
  ctx.assertPiEnv(envId);
  const workspaceDir = ctx.isLocalEnv(envId) ? canonicalExecutionPath(cwd) : cwd;
  const scratchDir =
    ctx.isLocalEnv(envId) && options?.scratchDir
      ? canonicalExecutionPath(options.scratchDir)
      : options?.scratchDir;
  const matchesEntry = (entry: WorkerConnectionEntry): boolean => {
    if (entry.envId !== envId || entry.cwd !== workspaceDir) return false;
    if (options && "scratchDir" in options && entry.scratchDir !== scratchDir) return false;
    if (options?.executionMode && entry.executionMode !== options.executionMode) return false;
    if (options?.executionKey && entry.executionKey !== options.executionKey) return false;
    return true;
  };
  const activeMatches = [...ctx.workerConnections].filter(([, entry]) => matchesEntry(entry));
  const retiredMatches = [...ctx.retiredWorkerConnections].filter((entry) => matchesEntry(entry));
  const matchedSet = new Set<WorkerConnectionEntry>([
    ...activeMatches.map(([, entry]) => entry),
    ...retiredMatches,
  ]);

  const activeResults = await Promise.all(
    activeMatches.map(async ([key, entry]) => {
      entry.cleaning = true;
      entry.connection.close();
      if (!entry.sandbox) {
        ctx.workerConnections.delete(key);
        return false;
      }
      const pending = await entry.sandbox.cleanup();
      if (!pending && ctx.workerConnections.get(key) === entry) ctx.workerConnections.delete(key);
      return pending;
    }),
  );
  const retiredResults = await Promise.all(
    retiredMatches.map(async (entry) => {
      entry.cleaning = true;
      entry.connection.close();
      if (!entry.sandbox) {
        ctx.retiredWorkerConnections.delete(entry);
        return false;
      }
      const pending = await entry.sandbox.cleanup();
      if (!pending) ctx.retiredWorkerConnections.delete(entry);
      return pending;
    }),
  );
  const results = [...activeResults, ...retiredResults];

  if (ctx.isLocalEnv(envId)) {
    const excludeDirectories = new Set<string>();
    for (const entry of [...ctx.workerConnections.values(), ...ctx.retiredWorkerConnections]) {
      if (matchedSet.has(entry)) continue;
      if (entry.sandbox?.controlDir) excludeDirectories.add(entry.sandbox.controlDir);
    }
    const recordedPending = ctx.localProjects
      ? await cleanupRecordedExecutions(path.join(ctx.localProjects.privateDirectory, "executions"), {
          workspaceDir,
          ...(options && "scratchDir" in options ? { scratchDir } : {}),
          ...(options?.executionKey ? { executionKey: options.executionKey } : {}),
          excludeDirectories,
        })
      : false;
    return { cleanupPending: results.some(Boolean) || recordedPending };
  }

  if (ctx.abortRemoteStreams(envId, cwd, options?.scratchDir, options?.executionKey)) {
    return { cleanupPending: true };
  }
  const remote = await ctx.requestRemoteCleanup(envId, cwd, options?.scratchDir, options?.executionKey);
  return { cleanupPending: results.some(Boolean) || remote.cleanupPending };
}

export function createBridgeWorkerExecutionEnv(
  ctx: BridgeExecutionContext,
  envId: string,
  cwd: string,
  options: WorkerExecutionOptions = {},
): ExecutionEnv {
  if (ctx.closed) throw new Error("Env manager is closed");
  ctx.assertPiEnv(envId);
  const isLocal = ctx.isLocalEnv(envId);
  if (isLocal) {
    cwd = canonicalExecutionPath(cwd);
    if (options.scratchDir) options = { ...options, scratchDir: canonicalExecutionPath(options.scratchDir) };
  }

  if (!isLocal && !ctx.workerEnvIds?.includes(envId) && !ctx.deviceTokens.has(envId)) {
    throw new Error(`Env '${envId}' has not been approved for Worker execution`);
  }
  const descriptor = ctx.getEnvDescriptor(envId);
  if (!descriptor?.online) throw new Error(`Worker Env '${envId}' is offline`);
  if (!isLocal && !ctx.hasWsPeer(envId)) {
    throw new Error("SSH Worker execution requires a managed Env agent; direct SSH daemons are not supported for Workers");
  }

  const network: WorkerNetworkPolicy = {
    localConnectPorts: [...(ctx.workerNetwork?.localConnectPorts ?? []), ...(options.network?.localConnectPorts ?? [])],
    localListenPorts: [...(ctx.workerNetwork?.localListenPorts ?? []), ...(options.network?.localListenPorts ?? [])],
    ...(options.network?.offline ? { offline: true } : {}),
  };
  const requireStrictNetwork = Boolean(network.offline || network.localConnectPorts?.length);
  const requireOsIsolation = Boolean(options.readOnly || options.stagedTaskId || requireStrictNetwork);
  const effectiveMode = resolveEffectiveExecutionMode({
    hubTrustMode: options.executionMode ?? ctx.executionTrustMode,
    descriptor,
    isLocal,
    requireOsIsolation,
    requireStrictNetwork,
  });

  if (!isWorkerEnvReady(descriptor, effectiveMode, { isLocal, requireStrictNetwork, requireOsIsolation })) {
    throw new Error(`Worker Env '${envId}' has no ready native isolation backend; update or configure the Env before execution`);
  }
  if (options.projectId && ctx.revokedProjects.has(JSON.stringify([envId, options.projectId]))) {
    throw new Error("Project execution has been revoked");
  }

  const protectedPaths =
    effectiveMode === "trusted" ? ctx.getCoreProtectedPaths() : ctx.getSandboxProtectedPaths();
  const protection = JSON.stringify(protectedPaths);
  const previousExecutions = [...ctx.workerConnections.values(), ...ctx.retiredWorkerConnections].filter(
    (entry) => entry.envId === envId && entry.cwd === cwd && entry.cleaning,
  );
  const cacheKey = JSON.stringify([
    envId,
    cwd,
    options.scratchDir,
    network,
    options.projectId,
    options.grantRevision,
    options.stagedTaskId,
    Boolean(options.readOnly),
    effectiveMode,
    options.executionKey ?? "",
    protection,
  ]);
  let entry = ctx.workerConnections.get(cacheKey);
  if (entry?.cleaning || entry?.retired) entry = undefined;

  if (!entry) {
    if (isLocal) {
      if (
        hasOrphanedExecution(
          path.join(ctx.localProjects!.privateDirectory, "executions"),
          canonicalExecutionPath(cwd),
        )
      ) {
        throw new Error("Previous Worker execution cleanup is pending");
      }
      let workspaceRoot = canonicalExecutionPath(ctx.localDescriptor!.rootDir);
      if (options.projectId && options.stagedTaskId) {
        workspaceRoot = ctx.localStagedWorkspaces!.validateStagedCwd(
          options.stagedTaskId,
          options.projectId,
          cwd,
          options.grantRevision,
        ).stagedDir;
        if (options.scratchDir) ctx.localProjects!.validateScratch(options.scratchDir);
      } else if (options.projectId) {
        workspaceRoot = ctx.localProjects!.validate(options.projectId, cwd, options.grantRevision).workspaceDir;
        if (options.scratchDir) ctx.localProjects!.validateScratch(options.scratchDir);
      }
      if (!options.projectId) {
        ctx.localProjects!.assertUnregistered(cwd);
        if (options.scratchDir) ctx.localProjects!.assertUnregistered(options.scratchDir);
      }
      for (const candidate of options.projectId ? [] : [cwd, ...(options.scratchDir ? [options.scratchDir] : [])]) {
        const relative = path.relative(workspaceRoot, canonicalExecutionPath(candidate));
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error("Worker execution path is outside the local Env's registered root");
        }
      }
      const controlRoot = path.join(ctx.localProjects!.privateDirectory, "executions");
      const sandbox =
        effectiveMode === "trusted"
          ? createTrustedWorkerSession({
              workspaceDir: cwd,
              scratchDir: options.scratchDir,
              projectId: options.projectId,
              executionKey: options.executionKey,
              controlRoot,
              coreProtectedPaths: [...protectedPaths, ctx.localProjects!.privateDirectory],
              blockedEnvNames: ctx.getBlockedEnvNames(),
            })
          : createWorkerSandbox({
              ...options,
              workspaceDir: cwd,
              workspaceRoot,
              managedScratchRoot: ctx.localProjects!.scratchRoot,
              controlRoot,
              protectedPaths: [...protectedPaths, ctx.localProjects!.privateDirectory],
              network,
            });
      const command = async () => {
        const pending = await Promise.all(previousExecutions.map((previous) => previous.sandbox?.cleanup() ?? false));
        if (pending.some(Boolean)) throw new Error("Worker execution cleanup is pending");
        return sandbox.command;
      };
      entry = {
        envId,
        cwd,
        scratchDir: options.scratchDir,
        projectId: options.projectId,
        executionMode: effectiveMode,
        executionKey: options.executionKey,
        connection: new Connection({ command }),
        sandbox,
      };
    } else {
      const supportsTrusted = hasTrustedHostExecutionCapability(descriptor.capabilities);
      entry = {
        envId,
        cwd,
        scratchDir: options.scratchDir,
        projectId: options.projectId,
        executionMode: effectiveMode,
        executionKey: options.executionKey,
        connection: new Connection({
          command: [
            process.execPath,
            ctx.stdioRelayPath,
            String(ctx.bridgePort),
            envId,
            ctx.bridgeSecret,
            JSON.stringify({
              workspaceDir: cwd,
              scratchDir: options.scratchDir,
              projectId: options.projectId,
              grantRevision: options.grantRevision,
              ...(options.stagedTaskId ? { stagedTaskId: options.stagedTaskId } : {}),
              readOnly: options.readOnly,
              protectedPaths,
              network,
              ...(supportsTrusted ? { executionMode: effectiveMode, ...(options.executionKey ? { executionKey: options.executionKey } : {}) } : {}),
            }),
          ],
        }),
      };
    }
    ctx.workerConnections.set(cacheKey, entry);
  }
  return new RemoteExecutionEnv({
    connection: entry.connection,
    id: `kulo-worker:${envId}:${cwd}`,
    cwd,
    shellPath: descriptor.platform === "win32" ? "powershell.exe" : "/bin/bash",
  });
}

export function createBridgeExecutionEnv(
  ctx: BridgeExecutionContext,
  envId: string,
  cwd: string,
  options?: { sandboxed?: boolean; readOnly?: boolean; offline?: boolean; executionMode?: ExecutionTrustMode },
): ExecutionEnv {
  ctx.assertPiEnv(envId);
  const isLocal = ctx.isLocalEnv(envId);

  if (isLocal) {
    if (!ctx.localConnection || !ctx.localDescriptor) {
      throw new Error("Local execution environment is not enabled on this Hub");
    }
    const effectiveMode = resolveEffectiveExecutionMode({
      hubTrustMode: options?.executionMode ?? ctx.executionTrustMode,
      descriptor: ctx.localDescriptor,
      isLocal: true,
      requireOsIsolation: Boolean(options?.readOnly || options?.offline),
    });
    const wantSandboxed =
      options?.sandboxed !== undefined ? options.sandboxed : effectiveMode === "sandboxed";
    if (wantSandboxed) {
      if (
        !isWorkerEnvReady(ctx.localDescriptor, "sandboxed", {
          isLocal: true,
          requireStrictNetwork: Boolean(options?.offline),
          requireOsIsolation: true,
        }) ||
        !ctx.localProjects
      ) {
        throw new Error("Sandboxed execution requires native worker isolation on local Env; refusing unsandboxed fallback.");
      }
      const canonicalCwd = canonicalExecutionPath(cwd);
      const protectedPaths = ctx.getSandboxProtectedPaths();
      const protection = JSON.stringify(protectedPaths);
      const network: WorkerNetworkPolicy = {
        localConnectPorts: [],
        localListenPorts: [],
        ...(options?.offline ? { offline: true } : {}),
      };
      const cacheKey = JSON.stringify([
        "orchestrator-local",
        canonicalCwd,
        Boolean(options?.readOnly),
        Boolean(options?.offline),
        "sandboxed",
        protection,
      ]);
      let entry = ctx.workerConnections.get(cacheKey);
      if (entry?.cleaning || entry?.retired) entry = undefined;
      if (!entry) {
        const workspaceRoot = canonicalExecutionPath(ctx.localDescriptor.rootDir);
        const sandbox = createWorkerSandbox({
          workspaceDir: canonicalCwd,
          workspaceRoot: canonicalCwd.startsWith(workspaceRoot) ? workspaceRoot : canonicalCwd,
          managedScratchRoot: ctx.localProjects.scratchRoot,
          controlRoot: path.join(ctx.localProjects.privateDirectory, "executions"),
          protectedPaths: [...protectedPaths, ctx.localProjects.privateDirectory],
          readOnly: Boolean(options?.readOnly),
          network,
        });
        entry = {
          envId: ctx.localEnvId,
          cwd: canonicalCwd,
          executionMode: "sandboxed",
          isOrchestrator: true,
          connection: new Connection({ command: async () => sandbox.command }),
          sandbox,
        };
        ctx.workerConnections.set(cacheKey, entry);
      }
      return new RemoteExecutionEnv({
        connection: entry.connection,
        id: "node:local",
        cwd: canonicalCwd,
        shellPath: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
      });
    }
    return new TrustedLocalExecutionEnv({
      cwd,
      connection: ctx.localConnection,
      getBlockedEnvNames: ctx.getBlockedEnvNames,
      nonInteractiveSudo: true,
    });
  }

  if (ctx.hasWsPeer(envId)) {
    const wsDesc = ctx.getWsPeerDescriptor(envId);
    if (!wsDesc?.online) {
      throw new Error(`Execution environment '${envId}' (${wsDesc?.name ?? envId}) is currently offline`);
    }
    const effectiveMode = resolveEffectiveExecutionMode({
      hubTrustMode: options?.executionMode ?? ctx.executionTrustMode,
      descriptor: wsDesc,
      isLocal: false,
      requireOsIsolation: Boolean(options?.readOnly || options?.offline),
    });
    const wantSandboxed =
      options?.sandboxed !== undefined ? options.sandboxed : effectiveMode === "sandboxed";
    if (wantSandboxed) {
      if (
        !isWorkerEnvReady(wsDesc, "sandboxed", {
          isLocal: false,
          requireStrictNetwork: Boolean(options?.offline),
          requireOsIsolation: true,
        }) ||
        !(ctx.workerEnvIds?.includes(envId) || ctx.deviceTokens.has(envId))
      ) {
        throw new Error(`Sandboxed execution requires native worker isolation on Env '${envId}'; refusing unsandboxed fallback.`);
      }
      const protectedPaths = ctx.getSandboxProtectedPaths();
      const protection = JSON.stringify(protectedPaths);
      const network: WorkerNetworkPolicy = {
        localConnectPorts: [],
        localListenPorts: [],
        ...(options?.offline ? { offline: true } : {}),
      };
      const cacheKey = JSON.stringify([
        "orchestrator-ws",
        envId,
        cwd,
        Boolean(options?.readOnly),
        Boolean(options?.offline),
        "sandboxed",
        protection,
      ]);
      let entry = ctx.workerConnections.get(cacheKey);
      if (entry?.cleaning || entry?.retired) entry = undefined;
      if (!entry) {
        const supportsTrusted = hasTrustedHostExecutionCapability(wsDesc.capabilities);
        entry = {
          envId,
          cwd,
          executionMode: "sandboxed",
          isOrchestrator: true,
          connection: new Connection({
            command: [
              process.execPath,
              ctx.stdioRelayPath,
              String(ctx.bridgePort),
              envId,
              ctx.bridgeSecret,
              JSON.stringify({
                workspaceDir: cwd,
                readOnly: Boolean(options?.readOnly),
                protectedPaths,
                network,
                ...(supportsTrusted ? { executionMode: "sandboxed" } : {}),
              }),
            ],
          }),
        };
        ctx.workerConnections.set(cacheKey, entry);
      }
      return new RemoteExecutionEnv({
        connection: entry.connection,
        id: `pi-env:${envId}`,
        cwd,
        shellPath: wsDesc.platform === "win32" ? "powershell.exe" : "/bin/bash",
      });
    }
    const connection = ctx.getWsPeerConnection(envId, effectiveMode);
    if (!connection) throw new Error(`Execution environment '${envId}' has no Pi Env connection`);
    return new RemoteExecutionEnv({
      connection,
      id: `pi-env:${envId}`,
      cwd,
    });
  }

  const sshConn = ctx.getSshPeerConnection(envId);
  if (sshConn) {
    if (options?.sandboxed) {
      throw new Error(`Sandboxed execution is not supported on SSH Env '${envId}'; refusing unsandboxed fallback.`);
    }
    return new RemoteExecutionEnv({
      connection: sshConn,
      id: `pi-env:${envId}`,
      cwd,
    });
  }

  throw new Error(`Unknown execution environment '${envId}'`);
}
