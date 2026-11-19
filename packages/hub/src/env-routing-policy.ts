import type {
  DispatchTargetScope,
  EnvNodeDescriptor,
  TicketEnvBinding,
  TicketRecord,
} from "@moco/protocol";

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
    const target = proposedEnvId ?? (localEnv?.online && hasWorkerIsolation(localEnv) ? "local" : recoveryTicket.envId);
    return {
      envId: target,
      envBinding: target === "local" ? "hub_local" : "pool_fallback",
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
  if (externalBindingDeviceId) {
    return {
      envId: externalBindingDeviceId,
      envBinding: "agent_bound",
      waitForSource: Boolean(sourceEnvId && externalBindingDeviceId === sourceEnvId),
    };
  }

  // Tier 2 & 3: Ungrouped built-in computer tasks
  const localSignals = detectSenderLocalSignals({
    userMessage,
    goal,
    scope,
    senderRootDir: sourceRootDir,
  });

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

    // Location-independent task from a paired device: never drift to a 3rd unnamed device C
    if (proposedEnvId && proposedEnvId !== sourceEnvId && proposedEnvId !== "local") {
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
        envId: "local",
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
      envBinding: proposedEnvId === "local" ? "hub_local" : "pool_fallback",
      waitForSource: false,
    };
  }
  if (localEnv?.online && hasWorkerIsolation(localEnv)) {
    return {
      envId: "local",
      envBinding: "hub_local",
      waitForSource: false,
    };
  }
  const fallback = pickFallbackEnvId();
  return {
    envId: fallback,
    envBinding: fallback === "local" ? "hub_local" : "pool_fallback",
    waitForSource: false,
  };
}
