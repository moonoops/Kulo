import os from "node:os";
import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { canonicalExecutionPath, isApplicationPrivatePath, KULO_CORE_STATE_SENSITIVE_NAMES, type EnvManager } from "@kulo/env";
import { classifyShellSafetyFloor, type ExecutionTrustMode, type ProjectRecord, type TicketRecord } from "@kulo/protocol";
import { createProactiveWakeBeforeToolHook } from "./assistant-proactive-guard.js";
import { SettingsAssistantDoc, isActiveSettingsConversation } from "./settings-assistant.js";
import { KuloStateDoc, isOrchestratorConversation, isTicketHoldingWriteLock, ticketsShareWriteScope } from "./state.js";

const ORCHESTRATOR_DEFAULT_BASH_TIMEOUT_SECONDS = 60;
const ORCHESTRATOR_MAX_BASH_TIMEOUT_SECONDS = 300;
const TRUSTED_ORCHESTRATOR_DEFAULT_BASH_TIMEOUT_SECONDS = 120;
const TRUSTED_ORCHESTRATOR_MAX_BASH_TIMEOUT_SECONDS = 600;

const HOME_SENSITIVE_DIR_NAMES = [
  ".ssh",
  ".gnupg",
  ".kube",
  ".aws",
  ".claude",
  ".codex",
  ".gemini",
  ".antigravity",
  ".grok",
  ".cursor",
  ".opencode",
  ".kiro",
  ".copilot",
  ".dsh",
] as const;

function isInsideLocalOrPosix(candidatePath: string, dirPath: string): boolean {
  if (!dirPath) return false;
  const resolvedDir = path.resolve(dirPath);
  const resolvedTarget = path.resolve(candidatePath);
  const rel = path.relative(resolvedDir, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeCanonical(value: string): string {
  try {
    return canonicalExecutionPath(value);
  } catch {
    return path.resolve(value);
  }
}

export interface ProtectedPathCheckerConfig {
  stateDir: string;
  mainWorkspaceDir: string;
  defaultIdentityDir: string;
  defaultMemoryAuthFile?: string;
  extraProtectedPaths?: readonly string[];
  getLiveIdentityDir: () => string;
  getLiveMemoryAuthFile: () => string | undefined;
  getExecutionTrustMode?: () => ExecutionTrustMode;
}

/**
 * Identifies Kulo core runtime state, peer config, and vault paths on remote Envs
 * (protected across both trusted and sandboxed modes).
 */
export function isRemoteKuloCorePath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/");
  if (/(?:^|\/)(?:\.kulo-state|\.secure|\.kulo-env)(?:\/|$)/i.test(normalized)) return true;
  if (/(?:^|\/)\.kulo\/(?:connection\.json|node-identity\.json|cluster-membership\.json|cluster-transition\.json|peer\.json)$/i.test(normalized)) return true;
  if (/(?:^|\/)(?:kulo-state|kulo|assistant|memory)\.sqlite(?:-wal|-shm|\.(?:failover-paused|redaction-pending))?$/i.test(normalized)) return true;
  if (/(?:^|\/)(?:connection-vault\.json|vault-envelope\.enc|sync-key\.enc|kulo-runtime-owner\.sqlite(?:-wal|-shm)?|hub-owner\.sqlite(?:-wal|-shm)?|runtime-token)$/i.test(normalized)) return true;
  return false;
}

/**
 * Pure local-host path policy checker for orchestrator / settings-assistant coding tools.
 * Evaluates live identity dir, memory auth file, and execution trust mode dynamically on every invocation.
 */
export function createProtectedOrchestratorPathChecker(
  cfg: ProtectedPathCheckerConfig,
): (candidatePath: string, options?: { forceSandboxed?: boolean }) => string | undefined {
  const resolvedStateDir = safeCanonical(cfg.stateDir);
  const resolvedMainWorkspace = safeCanonical(cfg.mainWorkspaceDir);
  const homeDir = os.homedir();
  const homeSensitiveDirs = HOME_SENSITIVE_DIR_NAMES.map((name) => safeCanonical(path.join(homeDir, name)));
  const extraProtectedCanonical = (cfg.extraProtectedPaths ?? []).map((entry) => safeCanonical(path.resolve(entry)));
  const coreStateTargets = KULO_CORE_STATE_SENSITIVE_NAMES.map((name) => safeCanonical(path.join(cfg.stateDir, name)));

  return (candidatePath: string, options?: { forceSandboxed?: boolean }): string | undefined => {
    const trusted = !options?.forceSandboxed && cfg.getExecutionTrustMode?.() === "trusted";
    const canonicalCandidate = safeCanonical(candidatePath);
    if (!trusted && (isApplicationPrivatePath(candidatePath) || isApplicationPrivatePath(canonicalCandidate))) {
      return "请通过已授权的消息或邮件应用读取内容。";
    }
    const liveIdentityDir = safeCanonical(cfg.getLiveIdentityDir());
    const defaultIdentityCanonical = safeCanonical(cfg.defaultIdentityDir);
    const liveAuth = cfg.getLiveMemoryAuthFile();
    const liveAuthFile = liveAuth ? safeCanonical(path.resolve(liveAuth)) : undefined;
    const defaultAuthFile = cfg.defaultMemoryAuthFile
      ? safeCanonical(path.resolve(cfg.defaultMemoryAuthFile))
      : undefined;
    const dotEnvPath = safeCanonical(path.resolve(".env"));

    if (
      isInsideLocalOrPosix(canonicalCandidate, liveIdentityDir) ||
      isInsideLocalOrPosix(canonicalCandidate, defaultIdentityCanonical)
    ) {
      return "禁止直接读写私有身份目录；请使用 kulo_identity_read、kulo_identity_propose 或 kulo_relationship_update。";
    }
    if (trusted) {
      const inMainWorkspace =
        resolvedMainWorkspace !== resolvedStateDir &&
        isInsideLocalOrPosix(resolvedMainWorkspace, resolvedStateDir) &&
        isInsideLocalOrPosix(canonicalCandidate, resolvedMainWorkspace);
      if (
        !inMainWorkspace &&
        (coreStateTargets.some((target) => isInsideLocalOrPosix(canonicalCandidate, target)) ||
          extraProtectedCanonical.some((dir) => isInsideLocalOrPosix(canonicalCandidate, dir)))
      ) {
        return "禁止经由文件工具直接读写 Kulo 运行时核心状态库或凭据目录。";
      }
      if (
        (liveAuthFile && canonicalCandidate === liveAuthFile) ||
        (defaultAuthFile && canonicalCandidate === defaultAuthFile)
      ) {
        return "禁止经由文件工具直接访问 Kulo 内部记忆认证文件。";
      }
      return undefined;
    }
    if (
      (isInsideLocalOrPosix(canonicalCandidate, resolvedStateDir) &&
        !(
          resolvedMainWorkspace !== resolvedStateDir &&
          isInsideLocalOrPosix(resolvedMainWorkspace, resolvedStateDir) &&
          isInsideLocalOrPosix(canonicalCandidate, resolvedMainWorkspace)
        )) ||
      extraProtectedCanonical.some((dir) => isInsideLocalOrPosix(canonicalCandidate, dir))
    ) {
      return "主脑沙箱禁止直接访问 Kulo 状态库或凭据目录。";
    }
    if (
      canonicalCandidate === dotEnvPath ||
      (liveAuthFile && canonicalCandidate === liveAuthFile) ||
      (defaultAuthFile && canonicalCandidate === defaultAuthFile) ||
      homeSensitiveDirs.some((dir) => isInsideLocalOrPosix(canonicalCandidate, dir))
    ) {
      return "主脑沙箱禁止直接访问敏感密钥或凭据路径。";
    }
    return undefined;
  };
}

export interface OrchestratorCodingGuardDeps extends ProtectedPathCheckerConfig {
  envManager: Pick<EnvManager, "localEnvId" | "isLocalEnv">;
  redact: (text: string) => string;
  assertChatReadTarget: (
    conversationId: number,
    toolTaskId: number,
    envId: string | undefined,
    context: Context,
    topic?: { targetDeviceId?: string },
  ) => Promise<void>;
  getProject: (projectId: string, context: Context) => Promise<ProjectRecord>;
}

export function createOrchestratorCodingGuardExtension(deps: OrchestratorCodingGuardDeps) {
  const isProtectedOrchestratorPath = createProtectedOrchestratorPathChecker(deps);

  const wrapOrchestratorCodingTool = (toolName: "read" | "write" | "edit" | "bash") => ({
    tool: toolName,
    wrap: (tool: ToolRegistration): ToolRegistration => ({
      ...tool,
      execute: async (args, api, context) => {
        const state = await api.snapshot(KuloStateDoc, context);
        const settingsDoc = await api.snapshot(SettingsAssistantDoc, context);
        const activeSettings = isActiveSettingsConversation(api.conversationId, settingsDoc);
        const isOrchestrator = isOrchestratorConversation(api.conversationId, state);
        if (!isOrchestrator && !activeSettings) {
          return tool.execute(args, api, context);
        }
        const blockResult = (message: string) => ({
          isError: true as const,
          output: [{ type: "text" as const, text: message }],
        });
        if (activeSettings && toolName !== "read") {
          return blockResult("设置助手仅支持只读读取操作。");
        }
        const topicId = activeSettings ? undefined : (state?.conversationToTopic?.[String(api.conversationId)] ?? "root");
        const topic = topicId ? state?.topics?.[topicId] : undefined;
        if (topic?.deletedAt) {
          return blockResult("会话已删除。");
        }
        try {
          await deps.assertChatReadTarget(Number(api.conversationId), Number(api.taskId), api.env?.id, context, topic);
        } catch (error) {
          return blockResult(deps.redact(error instanceof Error ? error.message : String(error)));
        }
        let authorizedProject: ProjectRecord | undefined;
        if (topic?.projectId) {
          try {
            authorizedProject = await deps.getProject(topic.projectId, context);
          } catch (error) {
            return blockResult(deps.redact(error instanceof Error ? error.message : String(error)));
          }
        }
        const authorizedWorkspaceDir = authorizedProject?.workspaceDir ?? api.env?.cwd ?? deps.mainWorkspaceDir;
        const localHostId = deps.envManager.localEnvId;
        const targetEnvId =
          authorizedProject?.deviceId ??
          (api.env?.id === "node:local"
            ? localHostId
            : api.env?.id?.startsWith("pi-env:")
              ? api.env.id.slice("pi-env:".length)
              : localHostId);
        const targetIsLocalHost = api.env?.id === "node:local" || deps.envManager.isLocalEnv(targetEnvId);

        const checkActiveWriteLock = async (targetPath: string): Promise<string | undefined> => {
          const normalizedScopePath = targetIsLocalHost ? safeCanonical(targetPath) : targetPath;
          const writeProbe = {
            envId: targetEnvId,
            workspaceDir: normalizedScopePath,
            readOnly: false,
          } as TicketRecord;
          const conflictingTicket = Object.values(state?.tickets ?? {}).find(
            (t) =>
              isTicketHoldingWriteLock(t) &&
              ticketsShareWriteScope(
                writeProbe,
                targetIsLocalHost && deps.envManager.isLocalEnv(t.envId) && t.workspaceDir
                  ? { ...t, workspaceDir: safeCanonical(t.workspaceDir) }
                  : t,
              ),
          );
          if (conflictingTicket) {
            return `当前工作区正在由活跃工单 ${conflictingTicket.id}（${conflictingTicket.title}）持有写锁（运行中、待清理或待合并）；请勿在主脑争抢同一目录写锁，改用 kulo_steer('${conflictingTicket.id}') 或等待其释放写锁。`;
          }
          return undefined;
        };

        const trusted = !activeSettings && deps.getExecutionTrustMode?.() === "trusted";

        if (toolName === "read" || toolName === "write" || toolName === "edit") {
          const rawPath = String((args as { path?: unknown })?.path ?? "")
            .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ")
            .replace(/^@/u, "");
          let absolute: string;
          if (api.env) {
            try {
              absolute = getOrThrow(await api.env.absolutePath(rawPath, context));
            } catch (error) {
              return blockResult(deps.redact(error instanceof Error ? error.message : String(error)));
            }
          } else {
            absolute = path.resolve(authorizedWorkspaceDir, rawPath);
          }

          if (targetIsLocalHost) {
            const blockedReason = isProtectedOrchestratorPath(absolute, { forceSandboxed: activeSettings });
            if (blockedReason) {
              return blockResult(blockedReason);
            }
          } else {
            let remoteCanonical = absolute;
            if (api.env) {
              const canon = await api.env.canonicalPath(absolute, context);
              if (canon.ok) remoteCanonical = canon.value;
            }
            if (isRemoteKuloCorePath(remoteCanonical) || isRemoteKuloCorePath(absolute)) {
              return blockResult("禁止直接读取或修改远端设备的 Kulo 核心运行状态、配置或加密凭据文件。");
            }
            if (!trusted && isApplicationPrivatePath(remoteCanonical)) {
              return blockResult("请通过已授权的消息或邮件应用读取内容。");
            }
          }

          if (toolName === "write" || toolName === "edit") {
            const conflictReason = await checkActiveWriteLock(absolute);
            if (conflictReason) {
              return blockResult(conflictReason);
            }
          }
          return tool.execute(args, api, context);
        }

        // toolName === "bash"
        const cmd = String((args as { command?: unknown })?.command ?? "");
        const floor = classifyShellSafetyFloor(cmd);
        if (floor.verdict === "block") {
          return blockResult(`主脑安全护栏拦截了毁灭性 Shell 命令（${floor.reason ?? "catastrophic"}）："${cmd.slice(0, 120)}"。`);
        }
        const liveIdentityDir = deps.getLiveIdentityDir();
        const sensitiveStateTargets = KULO_CORE_STATE_SENSITIVE_NAMES.map((name) => path.join(deps.stateDir, name));
        if (
          (liveIdentityDir && cmd.includes(liveIdentityDir)) ||
          (deps.defaultIdentityDir && cmd.includes(deps.defaultIdentityDir)) ||
          sensitiveStateTargets.some((target) => cmd.includes(target)) ||
          (!trusted && /\b(?:systemd-creds|secret-tool)\b/.test(cmd)) ||
          /\.secure[/\\]linux-keystore\b/.test(cmd)
        ) {
          return blockResult("禁止通过 bash 直接访问私有身份目录或 Kulo 核心状态凭据文件。");
        }
        const conflictReason = await checkActiveWriteLock(authorizedWorkspaceDir);
        if (conflictReason) {
          return blockResult(conflictReason);
        }
        // Also intercept bash commands from root/neutral cwd that explicitly target another write-locked project directory on the same device.
        const lockedByCommand = Object.values(state?.tickets ?? {}).find((t) => {
          if (!isTicketHoldingWriteLock(t) || !t.workspaceDir) return false;
          const sameDevice = targetIsLocalHost ? deps.envManager.isLocalEnv(t.envId) : t.envId === targetEnvId;
          if (!sameDevice) return false;
          const ws = targetIsLocalHost ? safeCanonical(t.workspaceDir) : t.workspaceDir;
          return cmd.includes(t.workspaceDir) || (ws !== t.workspaceDir && cmd.includes(ws));
        });
        if (lockedByCommand) {
          return blockResult(
            `目标工作区 ${lockedByCommand.workspaceDir} 正在由活跃工单 ${lockedByCommand.id}（${lockedByCommand.title}）持有写锁；请勿在主脑争抢同一目录写锁，改用 kulo_steer('${lockedByCommand.id}') 或等待其释放写锁。`,
          );
        }
        const defaultTimeout = trusted
          ? TRUSTED_ORCHESTRATOR_DEFAULT_BASH_TIMEOUT_SECONDS
          : ORCHESTRATOR_DEFAULT_BASH_TIMEOUT_SECONDS;
        const maxTimeout = trusted
          ? TRUSTED_ORCHESTRATOR_MAX_BASH_TIMEOUT_SECONDS
          : ORCHESTRATOR_MAX_BASH_TIMEOUT_SECONDS;
        const rawTimeout = (args as { timeout?: unknown })?.timeout;
        const clampedTimeout =
          typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
            ? Math.min(rawTimeout, maxTimeout)
            : defaultTimeout;
        const nextArgs =
          rawTimeout !== clampedTimeout
            ? { ...(args as Record<string, unknown>), timeout: clampedTimeout }
            : args;
        return tool.execute(nextArgs as never, api, context);
      },
    }),
  });

  return defineExtension({
    name: "kulo-orchestrator-guard",
    hooks: [createProactiveWakeBeforeToolHook()],
    wraps: [
      wrapOrchestratorCodingTool("read"),
      wrapOrchestratorCodingTool("write"),
      wrapOrchestratorCodingTool("edit"),
      wrapOrchestratorCodingTool("bash"),
    ],
  });
}
