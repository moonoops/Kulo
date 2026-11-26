import path from "node:path";
import {
  isWorkerEnvReady,
  resolveEffectiveExecutionMode,
  type EnvNodeDescriptor,
  type ExecutionTrustMode,
} from "@kulo/protocol";

export interface OrchestratorEnvReadinessInput {
  hubTrustMode: ExecutionTrustMode;
  activeSettings: boolean;
  isLocal: boolean;
}

export function isOrchestratorComputerEnvUsable(
  descriptor: EnvNodeDescriptor | undefined,
  options: OrchestratorEnvReadinessInput,
): boolean {
  if (!descriptor || descriptor.executionKind === "native-device") return false;
  if (descriptor.kind === "ssh") {
    return !options.activeSettings && options.hubTrustMode === "trusted";
  }
  const effectiveMode = resolveEffectiveExecutionMode({
    hubTrustMode: options.activeSettings ? "sandboxed" : options.hubTrustMode,
    descriptor,
    isLocal: options.isLocal,
    requireOsIsolation: options.activeSettings,
  });
  return effectiveMode === "sandboxed"
    ? isWorkerEnvReady(descriptor, "sandboxed", { isLocal: options.isLocal, requireOsIsolation: true })
    : true;
}

function normalizeComparablePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const resolved = path.resolve(trimmed);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
}

export interface OrchestratorDefaultCwdInput {
  targetCwd?: string;
  mainWorkspaceDir: string;
  localEnvId: string;
  resolvedEnvId?: string;
  envRootDir?: string;
  topicTargetDeviceId?: string;
  activeSettings?: boolean;
  onlineComputerCount: number;
}

export function resolveOrchestratorDefaultCwd(input: OrchestratorDefaultCwdInput): string {
  const {
    targetCwd, mainWorkspaceDir, localEnvId, resolvedEnvId,
    envRootDir, topicTargetDeviceId, activeSettings, onlineComputerCount,
  } = input;
  if (!targetCwd?.trim()) return envRootDir || mainWorkspaceDir;
  const isRemoteNode = Boolean(resolvedEnvId && resolvedEnvId !== localEnvId && resolvedEnvId !== "local");
  const unambiguousRemoteTarget =
    (!activeSettings && Boolean(topicTargetDeviceId) && topicTargetDeviceId === resolvedEnvId) ||
    onlineComputerCount === 1;
  if (
    isRemoteNode &&
    envRootDir?.trim() &&
    unambiguousRemoteTarget &&
    normalizeComparablePath(targetCwd) === normalizeComparablePath(mainWorkspaceDir)
  ) {
    return envRootDir;
  }
  return targetCwd;
}

export interface OrchestratorDefaultEnvSelectionInput {
  listEnvs: () => readonly EnvNodeDescriptor[];
  localEnvId: string;
  isLocalEnv: (id: string) => boolean;
  getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined;
  pickDefaultEnvId: () => string;
  targetCwd?: string;
  mainWorkspaceDir: string;
  topicTargetDeviceId?: string;
  activeSettings: boolean;
  hubTrustMode: ExecutionTrustMode;
}

export interface OrchestratorDefaultEnvSelection {
  candidateEnv: EnvNodeDescriptor;
  activeEnvId?: string;
  cwd: string;
  resolveLazy: (latestTrustMode: ExecutionTrustMode) => { envId: string; cwd: string };
}

export function selectOrchestratorDefaultEnv(
  input: OrchestratorDefaultEnvSelectionInput,
): OrchestratorDefaultEnvSelection | undefined {
  const {
    listEnvs, localEnvId, isLocalEnv, getEnvDescriptor, pickDefaultEnvId,
    targetCwd, mainWorkspaceDir, topicTargetDeviceId, activeSettings, hubTrustMode,
  } = input;
  const envs = listEnvs();
  const usable = (desc: EnvNodeDescriptor | undefined, mode = hubTrustMode) =>
    isOrchestratorComputerEnvUsable(desc, {
      hubTrustMode: mode,
      activeSettings,
      isLocal: Boolean(desc && isLocalEnv(desc.id)),
    });
  const usableEnvs = envs.filter((env) => usable(env));
  if (usableEnvs.length === 0) return undefined;

  const onlineComputerCount = envs.filter((env) => env.online && env.executionKind !== "native-device").length;
  const explicitTopicDesc = !activeSettings && topicTargetDeviceId ? getEnvDescriptor(topicTargetDeviceId) : undefined;
  const candidateEnv = explicitTopicDesc && usable(explicitTopicDesc) ? explicitTopicDesc : usableEnvs[0]!;

  let defaultEnvId: string | undefined;
  try { defaultEnvId = pickDefaultEnvId(); } catch { defaultEnvId = undefined; }
  const defaultDesc = defaultEnvId ? getEnvDescriptor(defaultEnvId) : undefined;
  const activeDesc =
    defaultEnvId === undefined
      ? undefined
      : explicitTopicDesc?.online && usable(explicitTopicDesc)
        ? explicitTopicDesc
        : defaultDesc?.online && usable(defaultDesc)
          ? defaultDesc
          : usableEnvs.find((env) => env.online);
  const effectiveDesc = activeDesc ?? candidateEnv;
  const cwd = resolveOrchestratorDefaultCwd({
    targetCwd, mainWorkspaceDir, localEnvId,
    resolvedEnvId: effectiveDesc.id, envRootDir: effectiveDesc.rootDir,
    topicTargetDeviceId, activeSettings, onlineComputerCount,
  });

  return {
    candidateEnv,
    activeEnvId: activeDesc?.id,
    cwd,
    resolveLazy: (latestTrustMode: ExecutionTrustMode) => {
      const liveEnvs = listEnvs();
      const latestTopicDesc = !activeSettings && topicTargetDeviceId ? getEnvDescriptor(topicTargetDeviceId) : undefined;
      const resolvedId =
        latestTopicDesc?.online && usable(latestTopicDesc, latestTrustMode)
          ? latestTopicDesc.id
          : pickDefaultEnvId();
      const resolvedInfo = getEnvDescriptor(resolvedId);
      const latestOnlineCount = liveEnvs.filter((env) => env.online && env.executionKind !== "native-device").length;
      return {
        envId: resolvedId,
        cwd: resolveOrchestratorDefaultCwd({
          targetCwd, mainWorkspaceDir, localEnvId,
          resolvedEnvId: resolvedId, envRootDir: resolvedInfo?.rootDir,
          topicTargetDeviceId, activeSettings, onlineComputerCount: latestOnlineCount,
        }),
      };
    },
  };
}
