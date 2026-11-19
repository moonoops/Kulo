import { useI18n } from "../../kulo-i18n";
import { Chip, Disclosure, Spinner } from "@heroui/react";
import type { ChatReplyReference, ChatDisplayItem, LiveStreamState } from "@kulo/protocol";
import { ConnectedMessageContent } from "../chat/connected-message-content";
import { formatMessageTime } from "../chat/message-time";
import type { PreviewableImage } from "../chat/asset-preview";
import { KuloMarkdown } from "../../kulo-markdown";
import { taskTimeline, toolActionSummary, type TaskToolEvent } from "./task-timeline-model";

function TimelineTime({ at }: { at?: number }) {
  useI18n();
  const time = formatMessageTime(at);
  return <span className="kulo-task-event-time">{time && <time dateTime={time.dateTime} title={time.title}>{time.label}</time>}</span>;
}

function ToolEvent({ event, active, level = 3 }: { event: TaskToolEvent; active: boolean; level?: 3 | 4 }) {
  const { t } = useI18n();
  const { call } = event;
  return <Disclosure className="kulo-task-tool-event">
    <Disclosure.Heading level={level}>
      <Disclosure.Trigger className="kulo-task-event-trigger">
        <span className="kulo-task-tool-name">{call.name}</span>
        <span className="kulo-task-event-preview">{toolActionSummary(call)}</span>
        {active ? <Spinner size="sm" /> : call.result && <Chip size="sm" variant="soft" color={call.result.isError ? "danger" : "default"}>{call.result.isError ? t("失败", "Failed") : t("已返回", "Returned")}</Chip>}
        <Disclosure.Indicator />
      </Disclosure.Trigger>
    </Disclosure.Heading>
    <Disclosure.Content>
      <Disclosure.Body className="kulo-task-event-body">
        <span className="kulo-item-description">{t("参数", "Arguments")}</span>
        <pre className="scrollbar kulo-task-event-code">{call.argsSummary}</pre>
        {call.result && <>
          <span className="kulo-item-description">{t("输出", "Output")}{call.result.truncated ? t("（已截断）", "(truncated)") : ""}</span>
          <pre className="scrollbar kulo-task-event-code" data-error={call.result.isError || undefined}>{call.result.text || t("（无文本输出）", "(no text output)")}</pre>
        </>}
      </Disclosure.Body>
    </Disclosure.Content>
  </Disclosure>;
}

export function TaskTimeline({ transcript, live, ticketId, roleLabel, onPreviewImage, onReply }: {
  transcript: ChatDisplayItem[];
  live: LiveStreamState;
  ticketId: string;
  roleLabel: string;
  onPreviewImage?: (image: PreviewableImage) => void;
  onReply?: (reply: ChatReplyReference) => void;
}) {
  const { t } = useI18n();
  const entries = taskTimeline(transcript);
  const active = new Set(live.activeTools.map(tool => tool.callId));
  return <ol className="kulo-task-timeline" aria-label={t("任务执行时间线", "Task execution timeline")}>
    {entries.map(entry => {
      if (entry.kind === "tools") {
        const first = entry.calls[0]!;
        return <li key={entry.id} className="kulo-task-event" data-error={entry.calls.some(event => event.call.result?.isError) || undefined}>
          <TimelineTime at={first.createdAt} />
          <div className="kulo-task-event-main">
            {entry.calls.length === 1 ? <ToolEvent event={first} active={active.has(first.call.id)} /> : <Disclosure>
              <Disclosure.Heading level={3}>
                <Disclosure.Trigger className="kulo-task-event-trigger">
                  <span className="kulo-task-tool-name">{entry.name}</span>
                  <span className="kulo-task-event-preview">{entry.calls.length}  {t("次调用", "calls")}</span>
                  {entry.calls.some(event => event.call.result?.isError) && <Chip size="sm" variant="soft" color="danger">{t("有失败", "With failures")}</Chip>}
                  <Disclosure.Indicator />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content><Disclosure.Body className="kulo-task-tool-group">
                {entry.calls.map(event => <ToolEvent key={event.id} event={event} level={4} active={active.has(event.call.id)} />)}
              </Disclosure.Body></Disclosure.Content>
            </Disclosure>}
          </div>
        </li>;
      }
      const { item } = entry;
      const content = Boolean(item.text.trim() || item.parts?.length || item.attachments?.length);
      const label = item.role === "user" ? t("任务要求", "Task request") : item.role === "system_note" ? t("上下文记录", "Context") : !content && item.thinking ? t("思考过程", "Thinking") : roleLabel;
      return <li key={entry.id} className="kulo-task-event">
        <TimelineTime at={item.createdAt} />
        <Disclosure className="kulo-task-event-main">
          <Disclosure.Heading level={3}>
            <Disclosure.Trigger className="kulo-task-event-trigger">
              <span className="kulo-task-event-label">{label}</span>
              <span className="kulo-task-event-preview">{item.text.trim().split("\n")[0] || (item.attachments?.length ? t(`${item.attachments.length} 个附件`, `${item.attachments.length} attachments`) : "")}</span>
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content><Disclosure.Body className="kulo-task-event-body">
            {content && <ConnectedMessageContent contentOnly item={{ ...item, role: "assistant" }} conversationKey={`ticket:${ticketId}`} onPreviewImage={onPreviewImage} onReply={onReply} />}
            {item.thinking && <Disclosure>
              <Disclosure.Heading level={4}><Disclosure.Trigger className="kulo-task-event-trigger"><span>{t("思考过程", "Thinking")}</span><Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
              <Disclosure.Content><Disclosure.Body><pre className="scrollbar kulo-task-event-code">{item.thinking}</pre></Disclosure.Body></Disclosure.Content>
            </Disclosure>}
          </Disclosure.Body></Disclosure.Content>
        </Disclosure>
      </li>;
    })}
    {live.busy && <li className="kulo-task-event" aria-live="polite">
      <span className="kulo-task-event-time"><Spinner size="sm" /></span>
      <div className="kulo-task-event-main kulo-task-live-event">
        <div className="kulo-task-live-heading"><span>{live.activeTools.map(tool => tool.name).join(" · ") || t("执行中", "Executing")}</span></div>
        {live.streamingText && <KuloMarkdown text={live.streamingText} />}
      </div>
    </li>}
  </ol>;
}
