import os from "node:os";
import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { canonicalExecutionPath, isApplicationPrivatePath, type EnvManager } from "@kulo/env";
import { classifyShellSafetyFloor, type ProjectRecord, type TicketRecord } from "@kulo/protocol";
import { SettingsAssistantDoc, isActiveSettingsConversation } from "./settings-assistant.js";
import { KuloStateDoc, isOrchestratorConversation, ticketsShareWriteScope } from "./state.js";

const ORCHESTRATOR_DEFAULT_BASH_TIMEOUT_SECONDS = 60;
const ORCHESTRATOR_MAX_BASH_TIMEOUT_SECONDS = 300;

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
}

/**
 * Pure local-host path policy checker for orchestrator / settings-assistant coding tools.
 * Evaluates live identity dir and memory auth file dynamically on every invocation.
 */
export function createProtectedOrchestratorPathChecker(
  cfg: ProtectedPathCheckerConfig,
): (candidatePath: string) => string | undefined {
  const resolvedStateDir = safeCanonical(cfg.stateDir);
  const resolvedMainWorkspace = safeCanonical(cfg.mainWorkspaceDir);
  const homeDir = os.homedir();
  const homeSensitiveDirs = HOME_SENSITIVE_DIR_NAMES.map((name) => safeCanonical(path.join(homeDir, name)));
  const extraProtectedCanonical = (cfg.extraProtectedPaths ?? []).map((entry) => safeCanonical(path.resolve(entry)));

  return (candidatePath: string): string | undefined => {
    const canonicalCandidate = safeCanonical(candidatePath);
    if (isApplicationPrivatePath(candidatePath) || isApplicationPrivatePath(canonicalCandidate)) {
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
      return "主脑沙箱禁止直接读写私有身份目录；请使用 kulo_identity_read、kulo_identity_propose 或 kulo_relationship_update。";
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
              (t.status === "running" || t.status === "pausing") &&
              !t.readOnly &&
              ticketsShareWriteScope(
                writeProbe,
                targetIsLocalHost && deps.envManager.isLocalEnv(t.envId) && t.workspaceDir
                  ? { ...t, workspaceDir: safeCanonical(t.workspaceDir) }
                  : t,
              ),
          );
          if (conflictingTicket) {
            return `当前工作区正在由活跃工单 ${conflictingTicket.id}（${conflictingTicket.title}）写入中；请勿在主脑争抢同一目录写锁，改用 kulo_steer('${conflictingTicket.id}') 或等待该工单完成。`;
          }
          return undefined;
        };

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
            const blockedReason = isProtectedOrchestratorPath(absolute);
            if (blockedReason) {
              return blockResult(blockedReason);
            }
          } else if (isApplicationPrivatePath(absolute)) {
            return blockResult("请通过已授权的消息或邮件应用读取内容。");
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
        if (
          (liveIdentityDir && cmd.includes(liveIdentityDir)) ||
          (deps.defaultIdentityDir && cmd.includes(deps.defaultIdentityDir)) ||
          cmd.includes(path.join(deps.stateDir, "kulo.sqlite")) ||
          cmd.includes(path.join(deps.stateDir, "credentials.json"))
        ) {
          return blockResult("主脑沙箱禁止通过 bash 访问私有身份目录或 Kulo 状态凭据文件。");
        }
        const conflictReason = await checkActiveWriteLock(authorizedWorkspaceDir);
        if (conflictReason) {
          return blockResult(conflictReason);
        }
        const rawTimeout = (args as { timeout?: unknown })?.timeout;
        const clampedTimeout =
          typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
            ? Math.min(rawTimeout, ORCHESTRATOR_MAX_BASH_TIMEOUT_SECONDS)
            : ORCHESTRATOR_DEFAULT_BASH_TIMEOUT_SECONDS;
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
    wraps: [
      wrapOrchestratorCodingTool("read"),
      wrapOrchestratorCodingTool("write"),
      wrapOrchestratorCodingTool("edit"),
      wrapOrchestratorCodingTool("bash"),
    ],
  });
}
