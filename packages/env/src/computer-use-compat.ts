import {
  browserRequestWantsAutoSnapshot,
  computerUseEnvDeadlineMs,
  computerUseRpcTimeoutMs,
  hasBrowserV2Capability,
  isComputerUseRequest,
  type ComputerUseRequest,
  type ComputerUseResult,
  type EnvNodeDescriptor,
  type ExecutionTrustMode,
} from "@kulo/protocol";
import {
  AUTO_SNAPSHOT_MAX_TIMEOUT_MS,
  AUTO_SNAPSHOT_MIN_REMAINING_MS,
  attachAutoSnapshotFailure,
  collectInputSecrets,
  mergeAutoSnapshotPayload,
} from "./computer-browser-batch.js";
import { scopeComputerUseForTarget } from "./bridge-execution-env.js";

export type PreparedComputerUseTargetRequest =
  | {
      kind: "direct";
      request: ComputerUseRequest;
      timeoutMs: number;
    }
  | {
      kind: "unsupported";
      result: ComputerUseResult;
    }
  | {
      kind: "emulate-auto-snapshot";
      primary: ComputerUseRequest;
      primaryTimeoutMs: number;
      followUpSnapshot: Extract<ComputerUseRequest, { tool: "browser"; action: "snapshot" }>;
      envDeadlineMs: number;
      inputSecrets: string[];
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Strip browser-v2 fields for older remote Envs lacking `agent-browser-v2` so legacy
 * `isComputerUseRequest` strict key allowlists never reject rolling-upgrade requests.
 */
export function prepareComputerUseForTarget(
  request: ComputerUseRequest,
  targetMode: ExecutionTrustMode,
  targetCapabilities: readonly string[],
  isLocal: boolean,
  targetPlatform: string,
): PreparedComputerUseTargetRequest {
  const scoped = scopeComputerUseForTarget(request, targetMode, targetCapabilities, isLocal);
  const supportsBrowserV2 = isLocal || hasBrowserV2Capability(targetCapabilities);
  if (scoped.tool !== "browser" || supportsBrowserV2) {
    return {
      kind: "direct",
      request: scoped,
      timeoutMs: computerUseRpcTimeoutMs(scoped),
    };
  }

  if (scoped.action === "batch") {
    return {
      kind: "unsupported",
      result: {
        tool: "browser",
        action: "batch",
        sessionId: scoped.sessionId,
        platform: targetPlatform,
        ok: false,
        error: {
          code: "CAPABILITY_UNSUPPORTED",
          message: "Target Env does not support browser batch (agent-browser-v2); upgrade the remote Kulo Env or execute steps individually.",
        },
      },
    };
  }

  if (scoped.action === "snapshot") {
    const { mode: _strippedMode, ...legacySnapshot } = scoped;
    const legacy = legacySnapshot as ComputerUseRequest;
    return {
      kind: "direct",
      request: legacy,
      timeoutMs: computerUseRpcTimeoutMs(legacy),
    };
  }

  if (
    scoped.action === "open"
    || scoped.action === "click"
    || scoped.action === "scroll"
    || scoped.action === "back"
    || scoped.action === "forward"
    || scoped.action === "fill"
    || scoped.action === "type"
  ) {
    const wantsAutoSnapshot = browserRequestWantsAutoSnapshot(scoped);
    const { returnSnapshot: _strippedReturn, snapshotMode: _strippedMode, ...legacyPrimary } = scoped;
    const primary = legacyPrimary as ComputerUseRequest;
    if (!wantsAutoSnapshot) {
      return {
        kind: "direct",
        request: primary,
        timeoutMs: 45_000,
      };
    }
    const followUpSnapshot: Extract<ComputerUseRequest, { tool: "browser"; action: "snapshot" }> = {
      tool: "browser",
      action: "snapshot",
      sessionId: scoped.sessionId,
      ...(scoped.executionMode ? { executionMode: scoped.executionMode } : {}),
    };
    const inputSecrets = scoped.action === "fill" || scoped.action === "type"
      ? collectInputSecrets([scoped.text])
      : [];
    return {
      kind: "emulate-auto-snapshot",
      primary,
      primaryTimeoutMs: 45_000,
      followUpSnapshot,
      envDeadlineMs: computerUseEnvDeadlineMs(scoped),
      inputSecrets,
    };
  }

  return {
    kind: "direct",
    request: scoped,
    timeoutMs: 45_000,
  };
}

export interface ExecuteComputerUseCompatOptions {
  closed?: boolean;
  descriptor?: Pick<EnvNodeDescriptor, "online" | "executionKind" | "platform" | "capabilities">;
  request: ComputerUseRequest;
  targetMode: ExecutionTrustMode;
  targetCapabilities?: readonly string[];
  isLocal: boolean;
  targetPlatform?: string;
  signal?: AbortSignal;
  sendRpc: (request: ComputerUseRequest, timeoutMs: number, signal?: AbortSignal) => Promise<ComputerUseResult>;
}

export async function executeComputerUseWithCompat(options: ExecuteComputerUseCompatOptions): Promise<ComputerUseResult> {
  if (options.closed) throw new Error("Env manager is closed");
  if (!isComputerUseRequest(options.request)) throw new Error("Invalid computer-use request");
  if (options.signal?.aborted) throw Object.assign(new Error("Computer-use operation cancelled"), { name: "AbortError" });
  if (options.descriptor !== undefined || (options.targetCapabilities === undefined && options.targetPlatform === undefined)) {
    const descriptor = options.descriptor;
    if (!descriptor?.online) throw new Error("Computer-use device is offline");
    if (descriptor.executionKind === "native-device" || !["darwin", "linux", "win32"].includes(descriptor.platform)) {
      throw new Error("This device has no supported computer-use driver");
    }
    if (!descriptor.capabilities.includes(options.request.tool === "browser" ? "agent-browser" : "agent-desktop")) {
      throw new Error(`Computer-use ${options.request.tool} is not enabled on this device`);
    }
  }
  const targetCapabilities = options.targetCapabilities ?? options.descriptor!.capabilities;
  const targetPlatform = options.targetPlatform ?? options.descriptor!.platform;
  const prepared = prepareComputerUseForTarget(
    options.request,
    options.targetMode,
    targetCapabilities,
    options.isLocal,
    targetPlatform,
  );
  if (prepared.kind === "unsupported") return prepared.result;
  if (prepared.kind === "direct") {
    return options.sendRpc(prepared.request, prepared.timeoutMs, options.signal);
  }

  const startedAt = Date.now();
  const primaryResult = await options.sendRpc(prepared.primary, prepared.primaryTimeoutMs, options.signal);
  if (!primaryResult.ok) return primaryResult;

  const mainObj = asRecord(primaryResult.data);
  const reset = asRecord(mainObj?.sessionReset);
  if (prepared.primary.action !== "open" && reset?.unexpectedRestart === true) {
    return primaryResult;
  }

  const remainingMs = prepared.envDeadlineMs - (Date.now() - startedAt);
  if (options.signal?.aborted) {
    return {
      ...primaryResult,
      data: attachAutoSnapshotFailure(primaryResult.data, "Skipped automatic snapshot because operation was cancelled", prepared.inputSecrets),
    };
  }
  if (remainingMs < AUTO_SNAPSHOT_MIN_REMAINING_MS) {
    return {
      ...primaryResult,
      data: attachAutoSnapshotFailure(primaryResult.data, "Skipped automatic snapshot due to remaining timeout budget", prepared.inputSecrets),
    };
  }

  try {
    const snapTimeoutMs = Math.min(AUTO_SNAPSHOT_MAX_TIMEOUT_MS, remainingMs);
    const snapResult = await options.sendRpc(prepared.followUpSnapshot, snapTimeoutMs, options.signal);
    if (!snapResult.ok) {
      return {
        ...primaryResult,
        data: attachAutoSnapshotFailure(
          primaryResult.data,
          snapResult.error?.message ?? "Automatic snapshot failed",
          prepared.inputSecrets,
        ),
      };
    }
    return {
      ...primaryResult,
      data: mergeAutoSnapshotPayload(primaryResult.data, snapResult.data, prepared.inputSecrets),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automatic snapshot failed";
    return {
      ...primaryResult,
      data: attachAutoSnapshotFailure(primaryResult.data, message, prepared.inputSecrets),
    };
  }
}
