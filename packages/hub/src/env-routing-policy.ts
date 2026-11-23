import type {
  DispatchTargetScope,
  EnvNodeDescriptor,
  TicketEnvBinding,
  TicketRecord,
} from "@kulo/protocol";
import { namedDispatchDevices } from "./agent-routing.js";

const EXPLICIT_SENDER_DEICTIC_PATTERNS: readonly RegExp[] = [
  /这台(?:电脑|设备|机器|笔记本)|我(?:的)?(?:电脑|笔记本|机器)|我电脑上|当前(?:电脑|设备|机器)/,
  /\b(?:this|my)\s+(?:computer|machine|laptop|mac|pc|device)\b/i,
];

export function hasExplicitSenderReference(text: string | undefined): boolean {
  if (!text || !text.trim()) return false;
  return EXPLICIT_SENDER_DEICTIC_PATTERNS.some((re) => re.test(text));
}

export interface PriorUserDeviceTurn {
  text?: string;
  targetDeviceId?: string;
  sourceDeviceId?: string;
}

export interface NamedOrContextualEnvResolution {
  envId: string;
  source: "current" | "context";
}

/**
 * Resolve an explicitly user-named device from the current user turn, or carry over
 * the most recently established device target from prior turns in the same conversation
 * when the model explicitly passes `proposedEnvId` and the user has not pivoted back
 * to the sender machine or another device.
 */
export function resolveNamedOrContextualEnv(input: {
  currentText?: string;
  priorUserTurns?: readonly PriorUserDeviceTurn[];
  envs: readonly EnvNodeDescriptor[];
  proposedEnvId?: string;
  targetScope?: DispatchTargetScope;
  isRecovery?: boolean;
}): NamedOrContextualEnvResolution | undefined {
  if (input.isRecovery) return undefined;
  const { currentText, priorUserTurns = [], envs, proposedEnvId, targetScope } = input;
  const currentNamed = namedDispatchDevices(currentText, envs);
  const currentUnambiguous = [
    ...new Set(currentNamed.filter((ids) => ids.length === 1).map((ids) => ids[0]!)),
  ];
  const currentExplicitSender = hasExplicitSenderReference(currentText);

  if (proposedEnvId) {
    if (currentUnambiguous.includes(proposedEnvId)) {
      return { envId: proposedEnvId, source: "current" };
    }
    if (currentUnambiguous.length > 0) return undefined;
    if (currentExplicitSender) return undefined;
    for (const turn of priorUserTurns) {
      if (turn.targetDeviceId) {
        return turn.targetDeviceId === proposedEnvId
          ? { envId: proposedEnvId, source: "context" }
          : undefined;
      }
      const priorNamed = namedDispatchDevices(turn.text, envs);
      const priorUnambiguous = [
        ...new Set(priorNamed.filter((ids) => ids.length === 1).map((ids) => ids[0]!)),
      ];
      if (priorUnambiguous.length > 0) {
        return priorUnambiguous.includes(proposedEnvId)
          ? { envId: proposedEnvId, source: "context" }
          : undefined;
      }
      if (hasExplicitSenderReference(turn.text) && turn.sourceDeviceId && turn.sourceDeviceId !== proposedEnvId) {
        return undefined;
      }
    }
    return undefined;
  }

  // Respect explicit target_scope='sender_device' rather than hijacking it via a partial text match
  // (e.g. a multi-device message where only one device's name matched an alias).
  if (targetScope === "sender_device") {
    return undefined;
  }

  if (currentUnambiguous.length === 1 && !currentExplicitSender) {
    return { envId: currentUnambiguous[0]!, source: "current" };
  }
  return undefined;
}

const LOCAL_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s"'`(])~[/\\]/,
  /(?:^|[\s"'`(])\/(?:Users|home|Volumes|mnt)\//i,
  /(?:^|[\s"'`(])[A-Za-z]:[\\/]/,
];

const LOCAL_NETWORK_PATTERNS: readonly RegExp[] = [
  /\blocalhost\b/i,
  /\b127\.0\.0\.1\b/,
  /\b0\.0\.0\.0\b/,
  /(?:localhost|127\.0\.0\.1|::1|\[::1\]):\d{2,5}\b/i,
  /(?:^|[\s"'`(]):\d{4,5}\b/,
  /本地\s*端口|localhost\s*端口|本地服务/i,
];

const LOCAL_COLLOQUIAL_PATTERNS: readonly RegExp[] = [
  /桌面|\bDesktop\b/i,
  /下载(?:文件夹|目录|里|中)?|\bDownloads\b/i,
  /文稿|\bDocuments\b/i,
  /剪贴板|\bclipboard\b/i,
  /本机|这台电脑|这台设备|我电脑上|我的电脑|当前电脑|本地文件|本地目录|当前打开的页面|当前浏览器|当前窗口/i,
  /\b(?:this\s+(?:computer|machine|laptop|mac|pc)|my\s+(?:computer|machine|laptop|mac|pc)|local\s+(?:files?|directory|folder|disk|browser|port)|open\s+(?:tab|page|window))\b/i,
];

export function hasWorkerIsolation(desc: EnvNodeDescriptor | undefined): boolean {
  if (!desc || desc.executionKind === "native-device") return false;
  const caps = new Set(desc.capabilities);
  return caps.has("worker-isolation") && !caps.has("worker-isolation-unavailable");
}

export function detectSenderLocalSignals(input: {
  userMessage?: string;
  goal?: string;
  scope?: string;
  senderRootDir?: string;
}): boolean {
  const combined = [input.userMessage, input.goal, input.scope].filter(Boolean).join("\n");
  if (!combined.trim()) return false;
  if (input.senderRootDir && input.senderRootDir.length >= 4 && combined.includes(input.senderRootDir)) {
    return true;
  }
  return (
    LOCAL_PATH_PATTERNS.some((re) => re.test(combined)) ||
    LOCAL_NETWORK_PATTERNS.some((re) => re.test(combined)) ||
    LOCAL_COLLOQUIAL_PATTERNS.some((re) => re.test(combined))
  );
}

/**
 * Determine whether a failed ticket is allowed to switch to another computer Env during automatic recovery.
 * Legacy tickets without `envBinding` are conservatively treated as device-locked.
 */
export function canSwitchEnvDuringRecovery(
  failed: Readonly<TicketRecord>,
  originTopicTargetDeviceId?: string,
): boolean {
  if ((failed.executionDomain ?? "computer") !== "computer") return false;
  if (failed.envBinding !== "hub_local") return false;
  if (failed.projectId) return false;
  if (originTopicTargetDeviceId) return false;
  if (failed.agentAssignment?.source === "explicit" || failed.agentAssignment?.source === "manual") return false;
  if (failed.deviceStateTouched) return false;
  if (failed.cleanupPending) return false;
  return true;
}

export interface ComputerEnvResolutionInput {
  projectDeviceId?: string;
  explicitWorkspaceDir?: string;
  messageTargetDeviceId?: string;
  topicTargetDeviceId?: string;
  namedEnvId?: string;
  explicitAgentDeviceId?: string;
  externalBindingDeviceId?: string;
  recoveryTicket?: Readonly<TicketRecord>;
  sourceEnvId?: string;
  sourceRootDir?: string;
  proposedEnvId?: string;
  targetScope?: DispatchTargetScope;
  userMessage?: string;
  goal?: string;
  scope?: string;
  localEnv?: EnvNodeDescriptor;
  pickFallbackEnvId: () => string;
}

export interface ComputerEnvResolution {
  envId: string;
  envBinding: TicketEnvBinding;
  waitForSource: boolean;
  /** True when the caller tried to force a third unnamed device against sender/local rules. */
  conflictWithSource?: boolean;
}

export function resolveComputerEnvBinding(input: ComputerEnvResolutionInput): ComputerEnvResolution {
  const {
    projectDeviceId,
    explicitWorkspaceDir,
    messageTargetDeviceId,
    topicTargetDeviceId,
    namedEnvId,
    explicitAgentDeviceId,
    externalBindingDeviceId,
    recoveryTicket,
    sourceEnvId,
    sourceRootDir,
    proposedEnvId,
    targetScope,
    userMessage,
    goal,
    scope,
    localEnv,
    pickFallbackEnvId,
  } = input;

  // Tier 1: Hard bindings
  if (projectDeviceId) {
    return { envId: projectDeviceId, envBinding: "project", waitForSource: false };
  }
  if (messageTargetDeviceId) {
    return { envId: messageTargetDeviceId, envBinding: "message_target", waitForSource: false };
  }
  if (topicTargetDeviceId) {
    return { envId: topicTargetDeviceId, envBinding: "topic_target", waitForSource: false };
  }
  const localEnvId = localEnv?.id ?? "local";
  if (namedEnvId) {
    return { envId: namedEnvId, envBinding: "message_named", waitForSource: false };
  }
  if (recoveryTicket) {
    const canSwitch = canSwitchEnvDuringRecovery(recoveryTicket, topicTargetDeviceId);
    if (!canSwitch) {
      return {
        envId: recoveryTicket.envId,
        envBinding: recoveryTicket.envBinding ?? "sender_local",
        waitForSource: recoveryTicket.envBinding === "sender_local",
      };
    }
    const target = proposedEnvId ?? (localEnv?.online && hasWorkerIsolation(localEnv) ? localEnvId : recoveryTicket.envId);
    return {
      envId: target,
      envBinding: target === localEnvId ? "hub_local" : "pool_fallback",
      waitForSource: false,
    };
  }
  if (explicitAgentDeviceId) {
    return { envId: explicitAgentDeviceId, envBinding: "agent_bound", waitForSource: false };
  }
  if (explicitWorkspaceDir) {
    const envId = proposedEnvId ?? externalBindingDeviceId ?? sourceEnvId ?? pickFallbackEnvId();
    return { envId, envBinding: "workspace_dir", waitForSource: Boolean(sourceEnvId && envId === sourceEnvId) };
  }
  const localSignals = detectSenderLocalSignals({
    userMessage,
    goal,
    scope,
    senderRootDir: sourceRootDir,
  });

  if (externalBindingDeviceId) {
    if (sourceEnvId && (targetScope === "sender_device" || localSignals) && externalBindingDeviceId !== sourceEnvId) {
      return {
        envId: sourceEnvId,
        envBinding: "sender_local",
        waitForSource: true,
        conflictWithSource: true,
      };
    }
    return {
      envId: externalBindingDeviceId,
      envBinding: "agent_bound",
      waitForSource: Boolean(sourceEnvId && externalBindingDeviceId === sourceEnvId),
    };
  }

  // Tier 2 & 3: Ungrouped built-in computer tasks

  if (sourceEnvId) {
    // Conservative rule: local-machine signals ALWAYS override model's target_scope='hub_local'
    const requiresSender = targetScope === "sender_device" || localSignals;
    if (requiresSender) {
      if (proposedEnvId && proposedEnvId !== sourceEnvId) {
        return {
          envId: sourceEnvId,
          envBinding: "sender_local",
          waitForSource: true,
          conflictWithSource: true,
        };
      }
      return {
        envId: sourceEnvId,
        envBinding: "sender_local",
        waitForSource: true,
      };
    }

    // Explicit sender device ID (equivalent to target_scope='sender_device') must never be silently
    // downgraded to Hub local; reject only if target_scope explicitly contradicted it with 'hub_local'.
    if (proposedEnvId === sourceEnvId) {
      if (targetScope === "hub_local") {
        return {
          envId: sourceEnvId,
          envBinding: "sender_local",
          waitForSource: true,
          conflictWithSource: true,
        };
      }
      return {
        envId: sourceEnvId,
        envBinding: "sender_local",
        waitForSource: true,
      };
    }

    // Location-independent task from a paired device: never drift to a 3rd unnamed device C
    if (proposedEnvId && proposedEnvId !== sourceEnvId && proposedEnvId !== localEnvId && proposedEnvId !== "local") {
      return {
        envId: sourceEnvId,
        envBinding: "sender_local",
        waitForSource: true,
        conflictWithSource: true,
      };
    }

    const localReady = Boolean(localEnv?.online && hasWorkerIsolation(localEnv));
    if (localReady) {
      return {
        envId: localEnvId,
        envBinding: "hub_local",
        waitForSource: false,
      };
    }
    // Hub local Env unavailable: fall back ONLY to authenticated sourceEnv (never to an unrelated edge device)
    return {
      envId: sourceEnvId,
      envBinding: "sender_local",
      waitForSource: true,
    };
  }

  // No paired source computer (e.g. local Hub UI, phone computer-domain task, or programmatic dispatch)
  if (proposedEnvId) {
    return {
      envId: proposedEnvId,
      envBinding: proposedEnvId === localEnvId || proposedEnvId === "local" ? "hub_local" : "pool_fallback",
      waitForSource: false,
    };
  }
  if (localEnv?.online && hasWorkerIsolation(localEnv)) {
    return {
      envId: localEnvId,
      envBinding: "hub_local",
      waitForSource: false,
    };
  }
  const fallback = pickFallbackEnvId();
  return {
    envId: fallback,
    envBinding: fallback === localEnvId || fallback === "local" ? "hub_local" : "pool_fallback",
    waitForSource: false,
  };
}

export interface ChatRoutingSignals {
  text?: string;
  targetDeviceId?: string;
  sourceDeviceId?: string;
}

export interface RoutingPolicyError {
  ok: false;
  code:
    | "target_device_conflict"
    | "source_device_ambiguous"
    | "browser_device_unavailable"
    | "read_device_mismatch";
  message: string;
}

export interface OrchestratorTargetEnvResolution {
  ok: true;
  envId: string;
  descriptor: EnvNodeDescriptor;
}

export interface OrchestratorSkillTarget {
  platform?: string;
  capabilities: string[];
}

export type OrchestratorTargetPreflight =
  | { ok: true; explicitTarget?: string; sourceId?: string }
  | RoutingPolicyError;

export function preflightOrchestratorTargetEnv(input: {
  routings: readonly ChatRoutingSignals[];
  topicTargetDeviceId?: string;
  envs: readonly EnvNodeDescriptor[];
}): OrchestratorTargetPreflight {
  const message = input.routings[0] ?? {};
  const namedTargets = message.text
    ? [...new Set(namedDispatchDevices(message.text, input.envs).flat())]
    : [];
  if (namedTargets.length > 1) {
    return { ok: false, code: "target_device_conflict", message: "消息中提到多台设备，请用 kulo_dispatch 明确指定执行设备。" };
  }
  const explicitTarget = message.targetDeviceId || input.topicTargetDeviceId || namedTargets[0];
  if (message.targetDeviceId && namedTargets[0] && message.targetDeviceId !== namedTargets[0]) {
    return { ok: false, code: "target_device_conflict", message: "消息中指定的设备与会话选定的设备不同，请先确认目标设备。" };
  }
  if (
    input.routings.some((inp) => inp.sourceDeviceId !== message.sourceDeviceId) &&
    !message.targetDeviceId &&
    !input.topicTargetDeviceId
  ) {
    return { ok: false, code: "source_device_ambiguous", message: "本轮有来自不同设备的消息，请用 kulo_dispatch 并填写对应的 source_request_id。" };
  }
  return { ok: true, explicitTarget, sourceId: message.sourceDeviceId };
}

export function resolveOrchestratorTargetEnv(input: {
  explicitTarget?: string;
  sourceId?: string;
  projectDeviceId?: string;
  priorContextualComputerId?: string;
  activeTopicBrowserEnvId?: string;
  getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined;
  isLocalEnv: (id: string) => boolean;
  localEnvId: string;
  pickDefaultEnvId: () => string;
}): OrchestratorTargetEnvResolution | RoutingPolicyError {
  const isOnlineComputer = (id: string | undefined): boolean => {
    if (!id) return false;
    const desc = input.getEnvDescriptor(id);
    return Boolean(desc?.online && desc.executionKind !== "native-device");
  };
  let envId: string;
  if (input.projectDeviceId) {
    if (input.explicitTarget && input.explicitTarget !== input.projectDeviceId) {
      return { ok: false, code: "target_device_conflict", message: "所选设备与当前项目绑定设备不同，请确认目标设备或使用 kulo_dispatch。" };
    }
    envId = input.projectDeviceId;
  } else if (input.explicitTarget) {
    envId = input.explicitTarget;
  } else if (input.sourceId && !(input.isLocalEnv(input.sourceId) && !input.getEnvDescriptor(input.localEnvId))) {
    const sourceDesc = input.getEnvDescriptor(input.sourceId);
    if (sourceDesc?.executionKind === "native-device") {
      envId = input.priorContextualComputerId
        ? input.priorContextualComputerId
        : input.activeTopicBrowserEnvId
          ? input.activeTopicBrowserEnvId
          : isOnlineComputer(input.localEnvId)
            ? input.localEnvId
            : input.pickDefaultEnvId();
    } else {
      envId = input.sourceId;
    }
  } else {
    envId = input.pickDefaultEnvId();
  }

  const descriptor = input.getEnvDescriptor(envId);
  if (!descriptor?.online || descriptor.executionKind === "native-device") {
    return {
      ok: false,
      code: "browser_device_unavailable",
      message: "目标电脑当前不在线或不支持桌面浏览器；请连接该电脑或用 kulo_dispatch 指定其他在线电脑。",
    };
  }
  return { ok: true, envId, descriptor };
}

function summarizeComputerCapabilities(
  descriptors: readonly EnvNodeDescriptor[],
  sortCapabilities: boolean,
): OrchestratorSkillTarget {
  if (!descriptors.length) return { capabilities: [] };
  const raw = [...new Set(descriptors.flatMap((desc) => desc.capabilities))];
  const capabilities = sortCapabilities ? raw.sort() : raw;
  const platforms = new Set(descriptors.map((desc) => desc.platform));
  return {
    ...(platforms.size === 1 ? { platform: [...platforms][0] } : {}),
    capabilities,
  };
}

export function resolveOrchestratorCatalogSkillTarget(input: {
  routings: readonly ChatRoutingSignals[];
  topicTargetDeviceId?: string;
  projectDeviceId?: string;
  envs: readonly EnvNodeDescriptor[];
  getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined;
}): OrchestratorSkillTarget {
  const explicitComputerIds = new Set<string>();
  const addIfComputer = (id: string | undefined) => {
    if (!id) return;
    const desc = input.getEnvDescriptor(id);
    if (desc && desc.executionKind !== "native-device") explicitComputerIds.add(id);
  };

  for (const routing of input.routings) {
    addIfComputer(routing.targetDeviceId);
    if (routing.text) {
      for (const id of namedDispatchDevices(routing.text, input.envs).flat()) {
        addIfComputer(id);
      }
    }
  }
  addIfComputer(input.topicTargetDeviceId);
  addIfComputer(input.projectDeviceId);

  if (explicitComputerIds.size > 0) {
    const explicitOnline = [...explicitComputerIds]
      .map((id) => input.getEnvDescriptor(id))
      .filter((desc): desc is EnvNodeDescriptor => Boolean(desc?.online && desc.executionKind !== "native-device"));
    return summarizeComputerCapabilities(explicitOnline, true);
  }

  // Keep the orchestrator skill catalog prefix-cache stable across sender-device switches,
  // Android turns, worker relays, and transient peer sleep/reconnects using registered computers.
  const registeredComputers = input.envs.filter((desc) => desc.executionKind !== "native-device");
  return summarizeComputerCapabilities(registeredComputers, true);
}

export function resolveOrchestratorConflictSkillTarget(input: {
  errorCode: "target_device_conflict" | "source_device_ambiguous";
  routings: readonly ChatRoutingSignals[];
  topicTargetDeviceId?: string;
  projectDeviceId?: string;
  envs: readonly EnvNodeDescriptor[];
  getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined;
}): OrchestratorSkillTarget {
  const candidateIds = new Set<string>();
  for (const routing of input.routings) {
    if (routing.targetDeviceId) candidateIds.add(routing.targetDeviceId);
    if (routing.text) {
      for (const id of namedDispatchDevices(routing.text, input.envs).flat()) {
        candidateIds.add(id);
      }
    }
  }
  if (input.topicTargetDeviceId) candidateIds.add(input.topicTargetDeviceId);
  if (input.projectDeviceId) candidateIds.add(input.projectDeviceId);
  if (input.errorCode === "source_device_ambiguous" || candidateIds.size === 0) {
    for (const routing of input.routings) {
      if (routing.sourceDeviceId) candidateIds.add(routing.sourceDeviceId);
    }
  }

  const onlineComputers = [...candidateIds]
    .map((id) => input.getEnvDescriptor(id))
    .filter((desc): desc is EnvNodeDescriptor => Boolean(desc?.online && desc.executionKind !== "native-device"));
  return summarizeComputerCapabilities(onlineComputers, false);
}

export type ChatReadTargetPreflight =
  | { status: "project"; projectId: string; explicitTarget?: string }
  | { status: "env"; explicitTarget?: string; envTargetId?: string; sourceId?: string; currentText?: string }
  | ({ status: "error" } & Omit<RoutingPolicyError, "ok">);

/**
 * Reconciles a historical control entry's stamped `targetDeviceId` against the
 * topic's current durable `targetDeviceId`. During an admitted turn the two
 * are kept identical by `#bindChatTarget`; they only diverge when the user
 * updates or clears the topic target while idle (e.g. via `PATCH /api/topics/:id`)
 * before triggering `chat.retry` or a continuation turn.
 */
export function reconcileTopicRoutingTarget(
  entryTargetDeviceId: string | undefined,
  topicTargetDeviceId: string | undefined,
  hasTopic: boolean,
): string | undefined {
  return hasTopic ? (topicTargetDeviceId || undefined) : (entryTargetDeviceId || undefined);
}

export function inspectChatReadTarget(input: {
  routings: readonly ChatRoutingSignals[];
  topicTargetDeviceId?: string;
  envs: readonly EnvNodeDescriptor[];
  environment?: string;
  localEnvId: string;
}): ChatReadTargetPreflight {
  const message = input.routings[0] ?? {};
  const namedTargets = message.text ? [...new Set(namedDispatchDevices(message.text, input.envs).flat())] : [];
  if (namedTargets.length > 1) {
    return { status: "error", code: "target_device_conflict", message: "消息中提到多台设备，请用 kulo_dispatch 指定文件所在的设备。" };
  }
  const boundTarget = message.targetDeviceId || input.topicTargetDeviceId;
  const explicitTarget = boundTarget || namedTargets[0];
  if (boundTarget && namedTargets[0] && boundTarget !== namedTargets[0]) {
    return { status: "error", code: "target_device_conflict", message: "消息中指定的设备与会话选定的设备不同，请确认文件所在设备。" };
  }
  if (input.environment?.startsWith("kulo-project:")) {
    return { status: "project", projectId: input.environment.slice("kulo-project:".length), explicitTarget };
  }
  if (input.routings.some((inp) => inp.sourceDeviceId !== message.sourceDeviceId) && !boundTarget) {
    return { status: "error", code: "source_device_ambiguous", message: "本轮有来自不同设备的消息，请用 kulo_dispatch 并填写对应的 source_request_id。" };
  }
  const envTargetId = input.environment === "node:local"
    ? input.localEnvId
    : input.environment?.startsWith("pi-env:")
      ? input.environment.slice("pi-env:".length)
      : undefined;
  return { status: "env", explicitTarget, envTargetId, sourceId: message.sourceDeviceId, currentText: message.text };
}

/**
 * Infer the most recent unambiguous computer device established in earlier turns of the
 * conversation when the current turn does not pivot back to the sender device or name another device.
 */
export function resolvePriorContextualComputerId(input: {
  currentText?: string;
  priorUserTurns?: readonly PriorUserDeviceTurn[];
  envs: readonly EnvNodeDescriptor[];
}): string | undefined {
  const { currentText, priorUserTurns = [], envs } = input;
  if (hasExplicitSenderReference(currentText)) return undefined;
  const currentNamed = namedDispatchDevices(currentText, envs);
  if (currentNamed.some((ids) => ids.length > 0)) return undefined;
  const isComputer = (id: string) => {
    const desc = envs.find((env) => env.id === id);
    return Boolean(desc && desc.executionKind !== "native-device");
  };
  for (const turn of priorUserTurns) {
    if (turn.targetDeviceId) return isComputer(turn.targetDeviceId) ? turn.targetDeviceId : undefined;
    const priorNamed = namedDispatchDevices(turn.text, envs);
    const priorUnambiguous = [...new Set(priorNamed.filter((ids) => ids.length === 1).map((ids) => ids[0]!))];
    if (priorUnambiguous.length === 1) return isComputer(priorUnambiguous[0]!) ? priorUnambiguous[0] : undefined;
    if (priorUnambiguous.length > 1) return undefined;
    if (hasExplicitSenderReference(turn.text)) {
      return turn.sourceDeviceId && isComputer(turn.sourceDeviceId) ? turn.sourceDeviceId : undefined;
    }
  }
  return undefined;
}

export type HostActionTargetResolution =
  | { ok: true; envId: string; descriptor: EnvNodeDescriptor; routedToHubFallback?: boolean }
  | { ok: false; message: string };

/**
 * Six-tier deterministic routing for orchestrator `kulo_host_action`:
 * 1) explicit envId -> 2) bound project device -> 3) message/topic target device ->
 * 4) named or multi-turn contextual computer -> 5) sender computer (never silently drift if offline) ->
 * 6) proactive Hub fallback when sender is a phone (`native-device`) or no sender device exists.
 */
export function resolveHostActionTargetEnv(input: {
  requestedEnvId?: string;
  projectDeviceId?: string;
  messageTargetDeviceId?: string;
  topicTargetDeviceId?: string;
  sourceDeviceId?: string;
  currentText?: string;
  priorUserTurns?: readonly PriorUserDeviceTurn[];
  envs: readonly EnvNodeDescriptor[];
  getEnvDescriptor: (id: string) => EnvNodeDescriptor | undefined;
  localEnvId: string;
  pickDefaultEnvId: () => string;
}): HostActionTargetResolution {
  const isOnlineComputer = (id: string | undefined): EnvNodeDescriptor | undefined => {
    if (!id) return undefined;
    const desc = input.getEnvDescriptor(id);
    return desc?.online && desc.executionKind !== "native-device" ? desc : undefined;
  };
  const namedAll = input.currentText ? namedDispatchDevices(input.currentText, input.envs) : [];
  const namedUnambiguous = [...new Set(namedAll.filter((ids) => ids.length === 1).map((ids) => ids[0]!))];
  const singleNamed = namedAll.length === 1 && namedUnambiguous.length === 1 ? namedUnambiguous[0] : undefined;

  let envId: string | undefined;
  let routedToHubFallback = false;

  if (input.requestedEnvId?.trim()) {
    envId = input.requestedEnvId.trim();
  } else if (input.projectDeviceId) {
    if (singleNamed && singleNamed !== input.projectDeviceId) {
      return { ok: false, message: "消息中指定的设备与当前项目绑定设备不同，请显式传入 env_id。" };
    }
    envId = input.projectDeviceId;
  } else if (input.messageTargetDeviceId || input.topicTargetDeviceId) {
    envId = input.messageTargetDeviceId || input.topicTargetDeviceId;
  } else if (singleNamed && !hasExplicitSenderReference(input.currentText)) {
    envId = singleNamed;
  } else {
    const priorComputer = resolvePriorContextualComputerId({
      currentText: input.currentText,
      priorUserTurns: input.priorUserTurns,
      envs: input.envs,
    });
    if (priorComputer) {
      envId = priorComputer;
    } else if (input.sourceDeviceId) {
      const sourceDesc = input.getEnvDescriptor(input.sourceDeviceId);
      if (sourceDesc?.executionKind === "native-device") {
        envId = isOnlineComputer(input.localEnvId) ? input.localEnvId : input.pickDefaultEnvId();
        routedToHubFallback = true;
      } else {
        envId = input.sourceDeviceId;
      }
    } else {
      envId = input.pickDefaultEnvId();
    }
  }

  const descriptor = envId ? input.getEnvDescriptor(envId) : undefined;
  if (!descriptor) return { ok: false, message: `找不到执行设备 '${envId ?? ""}'。` };
  if (!descriptor.online) {
    const isSender = Boolean(input.sourceDeviceId && envId === input.sourceDeviceId && !input.requestedEnvId);
    return {
      ok: false,
      message: isSender
        ? `当前设备 '${descriptor.name}' (${envId}) 执行通道离线；如需在主机执行请显式指定 env_id。`
        : `目标设备 '${descriptor.name}' (${envId}) 当前离线。`,
    };
  }
  if (descriptor.executionKind === "native-device") {
    return { ok: false, message: `设备 '${descriptor.name}' 是 Android 手机，不支持电脑本机操作。` };
  }
  return { ok: true, envId: descriptor.id, descriptor, ...(routedToHubFallback ? { routedToHubFallback: true } : {}) };
}

export function verifyChatReadTargetEnv(input: {
  explicitTarget?: string;
  envTargetId?: string;
  sourceId?: string;
  currentText?: string;
  priorUserTurns?: readonly PriorUserDeviceTurn[];
  envs: readonly EnvNodeDescriptor[];
  localEnvId: string;
  isLocalEnv: (id: string) => boolean;
  hasLocalEnv: boolean;
  environment?: string;
}): { ok: true } | RoutingPolicyError {
  const contextualTarget = !input.explicitTarget && input.envTargetId
    ? resolveNamedOrContextualEnv({
        currentText: input.currentText,
        priorUserTurns: input.priorUserTurns,
        envs: input.envs,
        proposedEnvId: input.envTargetId,
      })?.envId
    : undefined;
  const sourceDesc = input.sourceId ? input.envs.find((env) => env.id === input.sourceId) : undefined;
  const phoneSourceTarget =
    !input.explicitTarget && !contextualTarget && sourceDesc?.executionKind === "native-device"
      ? resolvePriorContextualComputerId({
          currentText: input.currentText,
          priorUserTurns: input.priorUserTurns,
          envs: input.envs,
        })
      : undefined;
  const target =
    input.explicitTarget ||
    contextualTarget ||
    (sourceDesc?.executionKind === "native-device"
      ? phoneSourceTarget
      : input.sourceId && input.isLocalEnv(input.sourceId) && !input.hasLocalEnv
        ? undefined
        : input.sourceId);
  const expectedEnv = target && input.isLocalEnv(target) ? "node:local" : target ? `pi-env:${target}` : undefined;
  if (target && input.environment !== expectedEnv) {
    return { ok: false, code: "read_device_mismatch", message: "请用 kulo_dispatch 在这条消息对应的设备上读取文件。" };
  }
  return { ok: true };
}
