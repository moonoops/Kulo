import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Alert, Button, Drawer, Spinner, TextArea, TextField } from "@heroui/react";
import type { SideQuestionView } from "@kulo/protocol";
import { translate as t, useI18n } from "../../kulo-i18n";
import { KuloMarkdown } from "../../kulo-markdown";
import { composerEnterAction, insertComposerNewline } from "./composer-keyboard";
import { isSideQuestionAwaitingReply } from "./use-side-question";

export interface SideQuestionDrawerProps {
  open: boolean;
  sideQuestion: SideQuestionView | null;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  connected: boolean;
  onSend: (question: string) => Promise<boolean> | boolean;
  onInsertToMainComposer: (answerText: string) => void;
  onClose: () => void;
}

export function SideQuestionDrawer({
  open,
  sideQuestion,
  loading,
  submitting,
  error,
  connected,
  onSend,
  onInsertToMainComposer,
  onClose,
}: SideQuestionDrawerProps) {
  useI18n();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastSideIdRef = useRef<string | undefined>(undefined);

  const sideId = sideQuestion?.record.id;
  useEffect(() => {
    if (sideId !== lastSideIdRef.current) {
      lastSideIdRef.current = sideId;
      setDraft("");
    }
  }, [sideId]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, sideId]);

  const awaitingReply = isSideQuestionAwaitingReply(sideQuestion);
  const messageCount = sideQuestion?.messages.length ?? 0;
  const streamingText = sideQuestion?.live.streamingText ?? "";

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !open) return;
    el.scrollTop = el.scrollHeight;
  }, [open, messageCount, streamingText, awaitingReply]);

  const limitReached = Boolean(sideQuestion?.limitReached);
  const runFailureText = sideQuestion?.live.runFailure
    ? sideQuestion.live.runFailure.detail || sideQuestion.live.runFailure.reason
    : null;
  const visibleError = error || runFailureText;
  const inputDisabled =
    !connected ||
    loading ||
    submitting ||
    !sideQuestion ||
    sideQuestion.record.status !== "active" ||
    limitReached;
  const sendDisabled = inputDisabled || !draft.trim();

  const handleSend = async () => {
    const clean = draft.trim();
    if (!clean || sendDisabled) return;
    const sent = await onSend(clean);
    if (sent) {
      setDraft("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const platform = typeof navigator !== "undefined" ? navigator.platform : "";
    const action = composerEnterAction(event, platform);
    if (action === "send") {
      event.preventDefault();
      void handleSend();
    } else if (action === "newline") {
      event.preventDefault();
      const target = event.currentTarget;
      const next = insertComposerNewline(
        draft,
        target.selectionStart ?? draft.length,
        target.selectionEnd ?? draft.length,
      );
      setDraft(next.text);
      requestAnimationFrame(() => {
        target.setSelectionRange(next.caret, next.caret);
      });
    }
  };

  return (
    <Drawer
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Drawer.Backdrop
        isOpen={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <Drawer.Content placement="right">
          <Drawer.Dialog
            data-kulo-overlay="side-question-drawer"
            aria-label={t("支线 · 不写入主对话", "Side question · Not saved to main chat")}
            className="flex h-full w-full max-w-[440px] flex-col"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
              <Drawer.Heading className="min-w-0 truncate">
                {t("支线 · 不写入主对话", "Side question · Not saved to main chat")}
              </Drawer.Heading>
              <Drawer.CloseTrigger aria-label={t("关闭支线", "Close side question")} />
            </div>

            <Drawer.Body className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
              {sideQuestion?.record.quoteSnippet && (
                <div className="shrink-0 border-b border-border bg-surface-secondary px-4 py-2.5">
                  <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted">
                    {sideQuestion.record.quoteSnippet}
                  </p>
                </div>
              )}

              <div
                ref={scrollRef}
                className="scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
              >
                {loading && !sideQuestion && (
                  <div className="flex items-center gap-2 py-4 text-xs text-muted">
                    <Spinner size="sm" />
                    <span>{t("正在开启支线…", "Opening side question…")}</span>
                  </div>
                )}

                {sideQuestion?.messages.map((msg) => {
                  if (msg.role === "user") {
                    return (
                      <div key={msg.id} className="flex justify-end">
                        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-surface-secondary px-3 py-2 text-sm text-foreground">
                          {msg.text}
                        </div>
                      </div>
                    );
                  }
                  if (msg.role === "assistant" && msg.text.trim()) {
                    return (
                      <article key={msg.id} className="flex flex-col gap-2">
                        <div className="text-sm text-foreground">
                          <KuloMarkdown text={msg.text} />
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onPress={() => onInsertToMainComposer(msg.text)}
                          >
                            {t("插入主框", "Insert to composer")}
                          </Button>
                        </div>
                      </article>
                    );
                  }
                  return null;
                })}

                {streamingText && (
                  <article className="flex flex-col gap-2 text-sm text-foreground">
                    <KuloMarkdown text={streamingText} />
                  </article>
                )}

                {!streamingText && awaitingReply && (
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Spinner size="sm" />
                    <span>{t("正在回答…", "Answering…")}</span>
                  </div>
                )}

                {visibleError && (
                  <Alert status="danger">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description className="text-xs">{visibleError}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}
              </div>

              <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
                <div className="flex items-end gap-2">
                  <TextField
                    aria-label={t("支线追问输入", "Side question input")}
                    variant="secondary"
                    className="kulo-context-field min-w-0 flex-1"
                    value={draft}
                    onChange={setDraft}
                    isDisabled={inputDisabled}
                  >
                    <TextArea
                      ref={inputRef}
                      variant="secondary"
                      rows={2}
                      className="scrollbar max-h-28 resize-none"
                      placeholder={
                        limitReached
                          ? t("已达 12 轮追问上限", "12-turn limit reached")
                          : t("输入支线追问…", "Ask a follow-up…")
                      }
                      onKeyDown={handleKeyDown}
                    />
                  </TextField>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    isDisabled={sendDisabled}
                    onPress={() => {
                      void handleSend();
                    }}
                  >
                    {t("发送", "Send")}
                  </Button>
                </div>

                {sideQuestion && (
                  <div className="flex items-center justify-between gap-2 text-xs text-muted">
                    <span>
                      {limitReached
                        ? t(
                            `已达 ${sideQuestion.record.maxUserTurns} 轮追问上限`,
                            `${sideQuestion.record.maxUserTurns}-turn limit reached`,
                          )
                        : t(
                            `剩余 ${sideQuestion.remainingTurns}/${sideQuestion.record.maxUserTurns} 轮`,
                            `${sideQuestion.remainingTurns}/${sideQuestion.record.maxUserTurns} turns left`,
                          )}
                    </span>
                    <Button type="button" size="sm" variant="ghost" onPress={onClose}>
                      {t("关闭支线", "Close")}
                    </Button>
                  </div>
                )}
              </div>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
