import type { KuloLanguage, LiveStreamState } from "@kulo/protocol";
import { translate } from "../../kulo-i18n";

export const LIVE_WAIT_ELAPSED_THRESHOLD_SECONDS = 5;

export interface LiveWaitStatus {
  /** Discrete stage status announced to assistive tech (no per-second timer churn). */
  label: string | null;
  /** Decorative elapsed seconds suffix rendered with aria-hidden and tabular-nums. */
  elapsedSuffix: string | null;
}

const TOOL_LABELS: Readonly<Record<string, readonly [zh: string, en: string]>> = {
  kulo_dispatch: ["正在派发任务", "Dispatching task"],
  kulo_steer: ["正在更新任务指令", "Updating task"],
  kulo_stop: ["正在更新任务状态", "Updating task status"],
  kulo_close: ["正在更新任务状态", "Updating task status"],
  kulo_status: ["正在查看任务状态", "Checking task status"],
  kulo_inspect: ["正在查看任务状态", "Checking task status"],
  kulo_inspect_staged_diff: ["正在审查改动", "Reviewing diff"],
  kulo_inspect_asset: ["正在检查产物", "Inspecting asset"],
  kulo_apply_staged_changes: ["正在应用工作区修改", "Applying workspace changes"],
  web_search: ["正在搜索", "Searching"],
  web_fetch: ["正在读取网页", "Reading webpage"],
  kulo_browser: ["正在操作浏览器", "Using browser"],
  kulo_desktop: ["正在操作桌面", "Using desktop"],
  hindsight_recall: ["正在检索记忆", "Searching memory"],
  hindsight_reflect: ["正在检索记忆", "Searching memory"],
  hindsight_search_pages: ["正在检索记忆", "Searching memory"],
  hindsight_get_page_tree: ["正在检索记忆", "Searching memory"],
  hindsight_retain: ["正在保存记忆", "Saving memory"],
  read: ["正在读取文件", "Reading file"],
  write: ["正在编辑文件", "Editing file"],
  edit: ["正在编辑文件", "Editing file"],
  bash: ["正在执行命令", "Running command"],
  kulo_host_action: ["正在执行命令", "Running command"],
  tool_search: ["正在准备工具", "Preparing tools"],
  kulo_skill_read: ["正在准备工具", "Preparing tools"],
  kulo_generate_image: ["正在生成图片", "Generating image"],
  kulo_generate_video: ["正在生成视频", "Generating video"],
};

export function resolveLiveWaitStatus(
  live: LiveStreamState,
  options: {
    elapsedSeconds?: number;
    showProcess?: boolean;
    language?: KuloLanguage;
  } = {},
): LiveWaitStatus {
  const tr = (zh: string, en: string) =>
    options.language ? (options.language === "en" ? en : zh) : translate(zh, en);

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
    const mapped = TOOL_LABELS[active.name];
    const base = mapped ? tr(mapped[0], mapped[1]) : tr("正在执行操作", "Running action");
    return {
      label: options.showProcess ? `${base} · ${active.name}` : `${base}…`,
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
