import type { EnvNodeDescriptor } from "./domain.js";

export type ExecutionTrustMode = "trusted" | "sandboxed";

/** Fresh installations start in native trusted host mode unless explicitly tightened. */
export const NEW_INSTALL_EXECUTION_TRUST_MODE: ExecutionTrustMode = "trusted";

/** Legacy databases upgraded without an explicit executionTrustMode retain sandboxed isolation until enabled. */
export const LEGACY_MIGRATION_EXECUTION_TRUST_MODE: ExecutionTrustMode = "sandboxed";

/** Capability advertised by Envs that support trusted host execution and mode negotiation. */
export const TRUSTED_HOST_EXECUTION_CAPABILITY = "trusted-host-v1" as const;

export function parseExecutionTrustMode(value: unknown): ExecutionTrustMode | undefined {
  return value === "trusted" || value === "sandboxed" ? value : undefined;
}

export function isExecutionTrustMode(value: unknown): value is ExecutionTrustMode {
  return value === "trusted" || value === "sandboxed";
}

/** Return the stricter of two trust modes (sandboxed always wins over trusted). */
export function stricterExecutionTrustMode(
  a: ExecutionTrustMode | undefined,
  b: ExecutionTrustMode | undefined,
): ExecutionTrustMode {
  if (a === "sandboxed" || b === "sandboxed") return "sandboxed";
  if (a === "trusted" || b === "trusted") return "trusted";
  return LEGACY_MIGRATION_EXECUTION_TRUST_MODE;
}

export function hasWorkerBasicOrFullIsolationCaps(capabilities: readonly string[]): boolean {
  if (capabilities.includes("worker-isolation-unavailable")) return false;
  return capabilities.includes("worker-isolation") || capabilities.includes("worker-isolation-basic");
}

export function hasWorkerStrictNetworkIsolationCaps(capabilities: readonly string[]): boolean {
  if (capabilities.includes("worker-isolation-unavailable")) return false;
  return capabilities.includes("worker-isolation");
}

export function hasTrustedHostExecutionCapability(capabilities: readonly string[]): boolean {
  return capabilities.includes(TRUSTED_HOST_EXECUTION_CAPABILITY);
}

export interface WorkerEnvReadinessOptions {
  isLocal?: boolean;
  requireStrictNetwork?: boolean;
  requireOsIsolation?: boolean;
}

/**
 * Shared protocol-level readiness predicate for computer Worker Envs.
 * Used uniformly across EnvManager, Projects, Routing Policy, Dispatch Plan, and Prompts.
 */
export function isWorkerEnvReady(
  descriptor: Pick<EnvNodeDescriptor, "executionKind" | "capabilities"> | undefined,
  trustMode: ExecutionTrustMode,
  options?: WorkerEnvReadinessOptions,
): boolean {
  if (!descriptor || descriptor.executionKind === "native-device") return false;
  const caps = descriptor.capabilities;
  if (options?.requireStrictNetwork) {
    return hasWorkerStrictNetworkIsolationCaps(caps);
  }
  if (trustMode === "sandboxed" || options?.requireOsIsolation) {
    return hasWorkerBasicOrFullIsolationCaps(caps);
  }
  return Boolean(
    options?.isLocal ||
    hasTrustedHostExecutionCapability(caps) ||
    hasWorkerBasicOrFullIsolationCaps(caps),
  );
}

export interface EffectiveExecutionModeInput {
  hubTrustMode: ExecutionTrustMode;
  descriptor?: Pick<EnvNodeDescriptor, "executionKind" | "capabilities">;
  isLocal?: boolean;
  /** True when the task explicitly asks for OS-enforced read_only, staged, or offline isolation. */
  requireOsIsolation?: boolean;
  requireStrictNetwork?: boolean;
}

/**
 * Negotiate the actual effective execution mode for a specific target device and task.
 * Prevents mismatched combinations such as running an older sandbox-only Peer in "direct" mode.
 */
export function resolveEffectiveExecutionMode(input: EffectiveExecutionModeInput): ExecutionTrustMode {
  if (input.hubTrustMode === "sandboxed" || input.requireOsIsolation || input.requireStrictNetwork) {
    return "sandboxed";
  }
  if (input.isLocal) return "trusted";
  if (input.descriptor && hasTrustedHostExecutionCapability(input.descriptor.capabilities)) {
    return "trusted";
  }
  return "sandboxed";
}
