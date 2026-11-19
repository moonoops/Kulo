import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord/context";
import type { CreateProjectInput, ProjectView, TopicSummary } from "@moco/protocol";
import { MocoStateDoc } from "./state.js";
import { isMainOrchestratorApi, settingsTopicId } from "./settings-doc.js";
import { ProjectError, type ProjectHistoryMatch, type ProjectPatch, type RemoveProjectResult } from "./projects.js";
import { resolveDeferredAddTools } from "./tool-surface.js";

export interface ProjectController {
  listProjects(context: Context, includeDeleted?: boolean): Promise<ProjectView[]>;
  listProjectTopics(projectId: string | null | undefined, context: Context, includeDeleted?: boolean): Promise<TopicSummary[]>;
  createProject(input: CreateProjectInput, context: Context): Promise<ProjectView>;
  patchProject(id: string, patch: ProjectPatch, context: Context): Promise<ProjectView>;
  deleteProject(id: string, options: { stopTasks?: boolean }, context: Context): Promise<RemoveProjectResult>;
  restoreProject(id: string, context: Context): Promise<ProjectView>;
  moveProjectTopic(topicId: string, projectId: string | null, context: Context): Promise<TopicSummary>;
  renameProjectTopic(topicId: string, title: string, context: Context): Promise<TopicSummary>;
  restoreProjectTopic(topicId: string, context: Context): Promise<TopicSummary>;
  searchProjectHistory(projectId: string, query: string, context: Context): Promise<ProjectHistoryMatch[]>;
}

async function permitted(api: ToolExecutionApi, context: Context): Promise<boolean> {
  const main = await isMainOrchestratorApi(api, context);
  if (!main.allowed) return false;
  if (main.isSettings) return true;
  const topicId = main.state?.conversationToTopic?.[String(api.conversationId)];
  return !topicId || main.state?.topics?.[topicId]?.deletedAt === undefined;
}

const denied = () => ({ isError: true, output: [{ type: "text" as const, text: "只有主脑可以管理项目和检索项目会话。" }] });
async function result(run: () => Promise<unknown>, addTools?: string[]) {
  try {
    return {
      output: [{ type: "text" as const, text: JSON.stringify(await run()) }],
      ...(addTools?.length ? { control: { addTools } } : {}),
    };
  }
  catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    return { isError: true, output: [{ type: "text" as const, text: JSON.stringify({ error: error.message, code: error.code, details: error.details }) }] };
  }
}

export function createProjectToolsExtension(controller: ProjectController) {
  return defineExtension({
    name: "moco-projects",
    tools: [
      defineTool({
        name: "moco_projects", replay: "safe", deferred: true,
        description: "List projects, bound devices, workspaces, and availability (`include_deleted=true` only when the user asks to find or restore a deleted project). 关键词：项目列表 查看项目 已归档项目 工作目录",
        parameters: obj({ include_deleted: opt(bool()) }),
        execute: async (args, api, context) => {
          if (!await permitted(api, context)) return denied();
          const addTools = await resolveDeferredAddTools(api, context, [
            "moco_project_conversations",
            "moco_project_history",
            "moco_project_update",
            "moco_project_create",
          ]);
          return result(() => controller.listProjects(context, args.include_deleted), addTools);
        },
      }),
      defineTool({
        name: "moco_project_conversations", replay: "safe", deferred: true,
        description: "List conversations (`project_id` for one project, `ordinary_only=true` for ungrouped topics, or omit both for all; pass `include_deleted=true` first to confirm exact IDs before restoring). 关键词：对话列表 话题列表 项目会话 查看已删会话",
        parameters: obj({ project_id: opt(str()), ordinary_only: opt(bool()), include_deleted: opt(bool()) }),
        execute: async (args, api, context) => {
          if (!await permitted(api, context)) return denied();
          if (args.project_id && args.ordinary_only) return { isError: true, output: [{ type: "text", text: "project_id 与 ordinary_only 不能同时设置。" }] };
          return result(() => controller.listProjectTopics(args.project_id ?? (args.ordinary_only ? null : undefined), context, args.include_deleted));
        },
      }),
      defineTool({
        name: "moco_project_create", replay: "safe", deferred: true,
        description: "Link or create a project directory on explicit user request (`device_id` and `workspace_dir` must be explicit; reuse `command_id` on retry; grants directory scope only, never whole-device access). 关键词：新建项目 创建项目 关联目录 绑定工程",
        parameters: obj({ command_id: str(), name: str(), device_id: str(), workspace_dir: str(), create_directory: opt(bool()) }),
        execute: async (args, api, context) => {
          if (!await permitted(api, context)) return denied();
          return result(() => controller.createProject({ commandId: args.command_id, name: args.name, deviceId: args.device_id, workspaceDir: args.workspace_dir, createDirectory: args.create_directory }, context));
        },
      }),
      defineTool({
        name: "moco_project_update", replay: "unsafe", deferred: true,
        description: "Update project name, notes, or explicitly requested device/workspace binding (settle unfinished tasks before changing directories; renaming does not rename folders on disk). 关键词：修改项目 更新项目 备注 切换项目目录",
        parameters: obj({ project_id: str(), expected_revision: num(), name: opt(str()), notes: opt(str()), device_id: opt(str()), workspace_dir: opt(str()) }),
        execute: async (args, api, context) => {
          if (!await permitted(api, context)) return denied();
          return result(() => controller.patchProject(args.project_id, { expectedRevision: args.expected_revision, name: args.name, notes: args.notes, deviceId: args.device_id, workspaceDir: args.workspace_dir }, context));
        },
      }),
      defineTool({
        name: "moco_project_delete", replay: "unsafe", deferred: true,
        description: "Soft-delete a project and its conversations on explicit user request while preserving disk files (`stop_tasks=true` only after the user agrees to stop active tasks). 关键词：删除项目 移除项目 归档项目",
        parameters: obj({ project_id: str(), stop_tasks: opt(bool()) }),
        execute: async (args, api, context) => {
          if (!await permitted(api, context)) return denied();
          return result(() => controller.deleteProject(args.project_id, { stopTasks: args.stop_tasks }, context));
        },
      }),
      defineTool({
        name: "moco_project_restore", replay: "unsafe", deferred: true,
        description: "Restore a soft-deleted project and conversations hidden with that deletion on explicit user request (does not restart old tasks or restore separately deleted topics). 关键词：恢复项目 还原已删除项目",
        parameters: obj({ project_id: str() }),
        execute: async (args, api, context) => {
          if (!await permitted(api, context)) return denied();
          return result(() => controller.restoreProject(args.project_id, context));
        },
      }),
      defineTool({
        name: "moco_conversation_rename", replay: "unsafe", deferred: true,
        description: "Rename the active conversation title on user request (does not change project membership or ticket names; background auto-title failure is not a user permission error). 关键词：重命名对话 修改标题 话题改名 会话名称",
        parameters: obj({ title: str({ minLength: 1, maxLength: 120 }) }),
        execute: async (args, api, context) => {
          const main = await isMainOrchestratorApi(api, context);
          if (!main.allowed) return denied();
          const topicId = main.isSettings ? settingsTopicId(Number(api.conversationId)) : main.state?.conversationToTopic?.[String(api.conversationId)];
          if (!topicId || (!main.isSettings && main.state?.topics?.[topicId]?.deletedAt !== undefined)) return denied();
          return result(async () => {
            const title = args.title.trim();
            if (!title) throw new ProjectError(400, "invalid_topic", "会话名称无效。");
            return controller.renameProjectTopic(topicId, title, context);
          });
        },
      }),
      defineTool({
        name: "moco_conversation_move", replay: "unsafe", deferred: true,
        description: "Move a conversation (`topic_id`) to `project_id` or back to ungrouped topics when `project_id` is omitted (settle unfinished tasks first). 关键词：移动对话 归入项目 移出项目 整理话题",
        parameters: obj({ topic_id: str(), project_id: opt(str()) }),
        execute: async (args, api, context) => {
          if (!await permitted(api, context)) return denied();
          return result(() => controller.moveProjectTopic(args.topic_id, args.project_id || null, context));
        },
      }),
      defineTool({
        name: "moco_conversation_restore", replay: "unsafe", deferred: true,
        description: "Restore a soft-deleted conversation (`topic_id`) on user request without restarting old tasks (restore its deleted project first if needed). 关键词：恢复对话 还原话题 找回已删会话",
        parameters: obj({ topic_id: str() }),
        execute: async (args, api, context) => {
          if (!await permitted(api, context)) return denied();
          return result(() => controller.restoreProjectTopic(args.topic_id, context));
        },
      }),
      defineTool({
        name: "moco_project_history", replay: "safe", deferred: true,
        description: "Search user/assistant messages across other active conversations in `project_id` on demand (excludes system prompts, identity/relationship files, and deleted conversations). 关键词：项目历史检索 搜索项目聊天记录 跨话题查找",
        parameters: obj({ project_id: str(), query: str() }),
        execute: async (args, api, context) => {
          if (!await permitted(api, context)) return denied();
          return result(() => controller.searchProjectHistory(args.project_id, args.query, context));
        },
      }),
    ],
  });
}
