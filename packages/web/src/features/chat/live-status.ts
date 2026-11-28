import type {
  KuloLanguage,
  LiveStreamState,
  ToolActionMeta,
  ToolActionStatus,
} from "@kulo/protocol";
import { translate } from "../../kulo-i18n";

export const LIVE_WAIT_ELAPSED_THRESHOLD_SECONDS = 5;

export interface LiveWaitStatus {
  /** Discrete stage status announced to assistive tech (no per-second timer churn). */
  label: string | null;
  /** Decorative elapsed seconds suffix rendered with aria-hidden and tabular-nums. */
  elapsedSuffix: string | null;
}

export interface BilingualActionPhrase {
  running: readonly [zh: string, en: string];
  done: readonly [zh: string, en: string];
}

/**
 * Single bilingual vocabulary shared by live streaming wait status (`resolveLiveWaitStatus`)
 * and historical chat execution step summaries (`ChatToolStepList`).
 */
export const TOOL_ACTION_LABELS: Readonly<Record<string, BilingualActionPhrase>> = {
  kulo_dispatch: {
    running: ["正在派发任务", "Dispatching task"],
    done: ["派发任务", "Dispatched task"],
  },
  kulo_steer: {
    running: ["正在更新任务指令", "Updating task"],
    done: ["更新任务指令", "Updated task"],
  },
  kulo_stop: {
    running: ["正在更新任务状态", "Updating task status"],
    done: ["停止任务", "Stopped task"],
  },
  kulo_close: {
    running: ["正在更新任务状态", "Updating task status"],
    done: ["收口任务", "Closed task"],
  },
  kulo_status: {
    running: ["正在查看任务状态", "Checking task status"],
    done: ["查看任务状态", "Checked task status"],
  },
  kulo_inspect: {
    running: ["正在查看任务状态", "Checking task status"],
    done: ["检查任务详情", "Inspected task"],
  },
  kulo_task_board: {
    running: ["正在查看任务看板", "Checking task board"],
    done: ["查看任务看板", "Checked task board"],
  },
  kulo_inspect_staged_diff: {
    running: ["正在审查改动", "Reviewing diff"],
    done: ["审查改动", "Reviewed diff"],
  },
  kulo_inspect_asset: {
    running: ["正在检查产物", "Inspecting asset"],
    done: ["检查产物", "Inspected asset"],
  },
  kulo_apply_staged_changes: {
    running: ["正在应用工作区修改", "Applying workspace changes"],
    done: ["应用工作区修改", "Applied workspace changes"],
  },
  web_search: {
    running: ["正在搜索", "Searching"],
    done: ["搜索网页", "Searched web"],
  },
  web_fetch: {
    running: ["正在读取网页", "Reading webpage"],
    done: ["读取网页", "Read webpage"],
  },
  kulo_browser: {
    running: ["正在操作浏览器", "Using browser"],
    done: ["操作浏览器", "Used browser"],
  },
  browser_observe: {
    running: ["正在查看网页", "Inspecting webpage"],
    done: ["查看网页", "Inspected webpage"],
  },
  browser_interact: {
    running: ["正在操作浏览器", "Interacting with browser"],
    done: ["操作浏览器", "Interacted with browser"],
  },
  kulo_desktop: {
    running: ["正在操作桌面", "Using desktop"],
    done: ["操作桌面", "Used desktop"],
  },
  desktop_observe: {
    running: ["正在查看桌面", "Inspecting desktop"],
    done: ["查看桌面", "Inspected desktop"],
  },
  kulo_computer_handoff: {
    running: ["正在请求人工接管", "Requesting handoff"],
    done: ["请求人工接管", "Requested handoff"],
  },
  memory_recall: {
    running: ["正在检索记忆", "Searching memory"],
    done: ["检索记忆", "Searched memory"],
  },
  memory_retain: {
    running: ["正在保存记忆", "Saving memory"],
    done: ["保存记忆", "Saved memory"],
  },
  memory_forget: {
    running: ["正在清理记忆", "Removing memory"],
    done: ["清理记忆", "Removed memory"],
  },
  hindsight_recall: {
    running: ["正在检索记忆", "Searching memory"],
    done: ["检索记忆", "Searched memory"],
  },
  hindsight_reflect: {
    running: ["正在检索记忆", "Searching memory"],
    done: ["检索记忆", "Searched memory"],
  },
  hindsight_search_pages: {
    running: ["正在检索记忆", "Searching memory"],
    done: ["检索记忆", "Searched memory"],
  },
  hindsight_get_page_tree: {
    running: ["正在检索记忆", "Searching memory"],
    done: ["检索记忆", "Searched memory"],
  },
  hindsight_retain: {
    running: ["正在保存记忆", "Saving memory"],
    done: ["保存记忆", "Saved memory"],
  },
  kulo_memory_recall: {
    running: ["正在检索记忆", "Searching memory"],
    done: ["检索记忆", "Searched memory"],
  },
  kulo_memory_retain: {
    running: ["正在保存记忆", "Saving memory"],
    done: ["保存记忆", "Saved memory"],
  },
  kulo_history_search: {
    running: ["正在搜索历史记录", "Searching history"],
    done: ["搜索历史记录", "Searched history"],
  },
  kulo_history_read: {
    running: ["正在查阅历史记录", "Reading history"],
    done: ["查阅历史记录", "Read history"],
  },
  read: {
    running: ["正在读取文件", "Reading file"],
    done: ["读取文件", "Read file"],
  },
  write: {
    running: ["正在编辑文件", "Editing file"],
    done: ["写入文件", "Wrote file"],
  },
  edit: {
    running: ["正在编辑文件", "Editing file"],
    done: ["编辑文件", "Edited file"],
  },
  bash: {
    running: ["正在执行命令", "Running command"],
    done: ["执行命令", "Ran command"],
  },
  kulo_host_action: {
    running: ["正在执行命令", "Running command"],
    done: ["执行本机命令", "Ran host command"],
  },
  kulo_host_action_inspect: {
    running: ["正在诊断本机状态", "Inspecting host"],
    done: ["诊断本机状态", "Inspected host"],
  },
  kulo_host_action_decide: {
    running: ["正在审批本机操作", "Deciding host action"],
    done: ["审批本机操作", "Decided host action"],
  },
  tool_search: {
    running: ["正在准备工具", "Preparing tools"],
    done: ["准备工具", "Prepared tools"],
  },
  kulo_skill_read: {
    running: ["正在准备工具", "Preparing tools"],
    done: ["读取技能说明", "Read skill guide"],
  },
  kulo_generate_image: {
    running: ["正在生成图片", "Generating image"],
    done: ["生成图片", "Generated image"],
  },
  kulo_generate_video: {
    running: ["正在生成视频", "Generating video"],
    done: ["生成视频", "Generated video"],
  },
  kulo_synthesize_speech: {
    running: ["正在合成语音", "Synthesizing speech"],
    done: ["合成语音", "Synthesized speech"],
  },
  kulo_lark_bridge: {
    running: ["正在访问飞书", "Accessing Feishu"],
    done: ["访问飞书", "Accessed Feishu"],
  },
  lark_list_chats: {
    running: ["正在查看飞书会话", "Listing Feishu chats"],
    done: ["查看飞书会话", "Listed Feishu chats"],
  },
  lark_read_chat: {
    running: ["正在查阅飞书消息", "Reading Feishu chat"],
    done: ["查阅飞书消息", "Read Feishu chat"],
  },
  lark_search_messages: {
    running: ["正在搜索飞书消息", "Searching Feishu messages"],
    done: ["搜索飞书消息", "Searched Feishu messages"],
  },
  lark_propose_reply: {
    running: ["正在草拟飞书回复", "Drafting Feishu reply"],
    done: ["草拟飞书回复", "Drafted Feishu reply"],
  },
  lark_configure: {
    running: ["正在配置飞书连接", "Configuring Feishu"],
    done: ["配置飞书连接", "Configured Feishu"],
  },
  lark_sync_now: {
    running: ["正在同步飞书消息", "Syncing Feishu"],
    done: ["同步飞书消息", "Synced Feishu"],
  },
  kulo_spark_mail: {
    running: ["正在访问邮件", "Accessing mail"],
    done: ["访问邮件", "Accessed mail"],
  },
  spark_mail_read: {
    running: ["正在查阅邮件", "Reading mail"],
    done: ["查阅邮件", "Read mail"],
  },
  spark_mail_propose_draft: {
    running: ["正在草拟邮件回复", "Drafting email reply"],
    done: ["草拟邮件回复", "Drafted email reply"],
  },
  kulo_home_assistant: {
    running: ["正在操作智能家居", "Using smart home"],
    done: ["操作智能家居", "Used smart home"],
  },
  home_assistant_read: {
    running: ["正在查看智能家居状态", "Checking smart home"],
    done: ["查看智能家居状态", "Checked smart home"],
  },
  home_assistant_write: {
    running: ["正在控制智能家居", "Controlling smart home"],
    done: ["控制智能家居", "Controlled smart home"],
  },
  home_assistant_confirm: {
    running: ["正在提交家居确认", "Proposing smart home action"],
    done: ["提交家居确认", "Proposed smart home action"],
  },
  kulo_connections: {
    running: ["正在查看可用连接", "Listing connections"],
    done: ["查看可用连接", "Listed connections"],
  },
  connection_read: {
    running: ["正在查阅连接资料", "Reading via connection"],
    done: ["查阅连接资料", "Read via connection"],
  },
  connection_use: {
    running: ["正在调用外部连接", "Using connection"],
    done: ["调用外部连接", "Used connection"],
  },
  kulo_connection_request: {
    running: ["正在申请连接权限", "Requesting connection access"],
    done: ["申请连接权限", "Requested connection access"],
  },
  kulo_connection_decide: {
    running: ["正在处理连接授权", "Deciding connection access"],
    done: ["处理连接授权", "Decided connection access"],
  },
  kulo_projects_read: {
    running: ["正在查看项目信息", "Checking projects"],
    done: ["查看项目信息", "Checked projects"],
  },
  kulo_projects_write: {
    running: ["正在更新项目信息", "Updating project"],
    done: ["更新项目信息", "Updated project"],
  },
  kulo_settings_read: {
    running: ["正在查看设置", "Checking settings"],
    done: ["查看设置", "Checked settings"],
  },
  kulo_settings_update: {
    running: ["正在更新设置", "Updating settings"],
    done: ["更新设置", "Updated settings"],
  },
  kulo_assistant_digests: {
    running: ["正在查看通知摘要", "Reading notification digests"],
    done: ["查看通知摘要", "Read notification digests"],
  },
  kulo_assistant_event_read: {
    running: ["正在查阅通知原文", "Reading notification details"],
    done: ["查阅通知原文", "Read notification details"],
  },
  kulo_assistant_read: {
    running: ["正在查看助理状态", "Checking assistant status"],
    done: ["查看助理状态", "Checked assistant status"],
  },
  kulo_assistant_configure: {
    running: ["正在配置个人助理", "Configuring assistant"],
    done: ["配置个人助理", "Configured assistant"],
  },
  assistant_watch_read: {
    running: ["正在查看关注规则", "Listing watch rules"],
    done: ["查看关注规则", "Listed watch rules"],
  },
  assistant_watch_write: {
    running: ["正在更新关注规则", "Updating watch rules"],
    done: ["更新关注规则", "Updated watch rules"],
  },
  kulo_identity_read: {
    running: ["正在查阅身份设置", "Reading identity"],
    done: ["查阅身份设置", "Read identity"],
  },
  kulo_identity_propose: {
    running: ["正在提议身份更新", "Proposing identity update"],
    done: ["提议身份更新", "Proposed identity update"],
  },
  kulo_ui_show: {
    running: ["正在展示交互卡片", "Showing card"],
    done: ["展示交互卡片", "Shown card"],
  },
  kulo_ui_update: {
    running: ["正在更新交互卡片", "Updating card"],
    done: ["更新交互卡片", "Updated card"],
  },
  kulo_ui_diagram: {
    running: ["正在生成图表", "Creating diagram"],
    done: ["生成图表", "Created diagram"],
  },
  kulo_publish_asset: {
    running: ["正在发送文件", "Publishing asset"],
    done: ["发送文件", "Published asset"],
  },
  kulo_ticket_ask_user: {
    running: ["正在等待你的确认", "Asking for confirmation"],
    done: ["等待确认", "Asked for confirmation"],
  },
  kulo_external_permission: {
    running: ["正在处理外部权限", "Handling permission"],
    done: ["处理外部权限", "Handled permission"],
  },
  generic_action: {
    running: ["正在执行操作", "Running action"],
    done: ["执行操作", "Ran action"],
  },
};

function pickLocalized(zh: string, en: string, language?: KuloLanguage): string {
  return language ? (language === "en" ? en : zh) : translate(zh, en);
}

export function resolveToolActionLabel(input: {
  name: string;
  actionMeta?: Pick<ToolActionMeta, "labelKey" | "status">;
  running?: boolean;
  language?: KuloLanguage;
}): string {
  const entry =
    (input.actionMeta?.labelKey ? TOOL_ACTION_LABELS[input.actionMeta.labelKey] : undefined) ??
    TOOL_ACTION_LABELS[input.name] ??
    TOOL_ACTION_LABELS.generic_action!;
  const isRunning = input.running ?? input.actionMeta?.status === "running";
  const pair = isRunning ? entry.running : entry.done;
  return pickLocalized(pair[0], pair[1], input.language);
}

export function formatReadSummaryLabel(count: number, language?: KuloLanguage): string {
  return pickLocalized(
    `已查阅 ${count} 项资料`,
    count === 1 ? "Checked 1 source" : `Checked ${count} sources`,
    language,
  );
}

export function resolveToolActionStatusLabel(
  status: ToolActionStatus,
  language?: KuloLanguage,
): string | null {
  switch (status) {
    case "running":
      return pickLocalized("执行中", "Running", language);
    case "error":
      return pickLocalized("失败", "Failed", language);
    case "awaiting_confirm":
      return pickLocalized("待确认", "Awaiting confirmation", language);
    case "ok":
      return null;
  }
}

export function resolveLiveWaitStatus(
  live: LiveStreamState,
  options: {
    elapsedSeconds?: number;
    showProcess?: boolean;
    language?: KuloLanguage;
  } = {},
): LiveWaitStatus {
  const tr = (zh: string, en: string) => pickLocalized(zh, en, options.language);

  if (live.retrying) {
    return {
      label: tr(
        `模型响应异常，正在重试（第 ${live.retrying.attempt} 次）…`,
        `Model response failed. Retrying (attempt ${live.retrying.attempt})…`,
      ),
      elapsedSuffix: null,
    };
  }

  if (live.activeTools.length > 0) {
    const active = live.activeTools.at(-1)!;
    const base = resolveToolActionLabel({
      name: active.name,
      actionMeta: active.actionMeta,
      running: true,
      language: options.language,
    });
    const detail = active.actionMeta?.targetLabel ?? active.name;
    return {
      label: options.showProcess ? `${base} · ${detail}` : `${base}…`,
      elapsedSuffix: null,
    };
  }

  if (live.streamingThinking?.trim()) {
    return {
      label: tr("正在思考…", "Thinking…"),
      elapsedSuffix: null,
    };
  }

  const elapsed = options.elapsedSeconds ?? 0;
  if (elapsed >= LIVE_WAIT_ELAPSED_THRESHOLD_SECONDS) {
    const seconds = Math.floor(elapsed);
    return {
      label: tr("等待模型响应", "Waiting for model"),
      elapsedSuffix: tr(`（${seconds}s）`, ` (${seconds}s)`),
    };
  }

  return { label: null, elapsedSuffix: null };
}
