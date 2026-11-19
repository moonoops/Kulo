import { translate as tr, useI18n } from "./kulo-i18n";
/** Identity & relationship document editor: CAS guard, Diff review, Dual-Sign Modal & Rollback. */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Label,
  Modal,
  Spinner,
  TextArea,
  TextField,
} from "@heroui/react";
import type { IdentityFile, IdentityProposal, IdentityRead, IdentityVersion } from "@kulo/protocol";
import { ConfirmDialog } from "./components/confirm-dialog";
import { useRegisterShortcutSave } from "./features/shortcuts/shortcuts";
import { KuloApiError, kuloRest } from "./kulo-api";

function identityFileLabel(file: IdentityFile): string {
  switch (file) {
    case "identity-agreement.md": return tr("身份约定", "Identity agreement");
    case "relationship.md": return tr("协作关系", "Collaboration");
  }
}

interface IdentityReviewState {
  open: boolean;
  file: IdentityFile;
  before: string;
  after: string;
  removes?: boolean;
  rollback?: boolean;
  backupId?: string;
  expected?: IdentityVersion;
  summary?: string;
}

export function createIdentitySaveReview(read: IdentityRead, content: string): IdentityReviewState {
  return {
    open: true,
    file: read.file,
    // The identity agreement is already active via its factory preset before its first explicit save.
    before: read.exists || read.file === "identity-agreement.md" ? read.content : "",
    after: content,
    expected: read.version,
  };
}

export function ReviewDiffView({
  value,
  other,
  added,
}: {
  value: string;
  other: string;
  added?: boolean;
}) {
  useI18n();
  const lines = value.split("\n");
  const compared = other.split("\n");
  let start = 0;
  let end = 0;
  while (
    start < Math.min(lines.length, compared.length) &&
    lines[start] === compared[start]
  ) {
    start++;
  }
  while (
    end < Math.min(lines.length, compared.length) - start &&
    lines[lines.length - end - 1] === compared[compared.length - end - 1]
  ) {
    end++;
  }

  return (
    <pre className="mc-diff-pre" style={{ maxHeight: "40dvh", minHeight: 160 }}>
      {lines.map((line, index) => {
        const text = line + (index < lines.length - 1 ? "\n" : "");
        const unchanged = index < start || index >= lines.length - end;
        if (unchanged) return <span key={index}>{text}</span>;
        return added ? (
          <ins key={index}>{text}</ins>
        ) : (
          <del key={index}>{text}</del>
        );
      })}
    </pre>
  );
}

function IdentityConfirmationModal({
  review,
  busy,
  blocked,
  error,
  onClose,
  onConfirm,
  requireAuthorization = true,
}: {
  review: IdentityReviewState | null;
  busy: boolean;
  blocked: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: (summary: string) => void;
  requireAuthorization?: boolean;
}) {
  useI18n();
  const isOpen = Boolean(review?.open);
  const lastReviewRef = useRef<IdentityReviewState | null>(null);
  if (review) {
    lastReviewRef.current = review;
  }
  const active = review ?? lastReviewRef.current;

  const [summary, setSummary] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const errId = useId();

  useEffect(() => {
    if (!review?.open) return;
    setSummary(
      review.summary ??
        (review.rollback
          ? tr(`回滚 ${identityFileLabel(review.file)}`, `Roll back ${identityFileLabel(review.file)}`)
          : tr(`更新 ${identityFileLabel(review.file)}`, `Update ${identityFileLabel(review.file)}`)),
    );
    setReviewed(false);
    setAuthorized(false);
  }, [review?.open, review?.file, review?.rollback, review?.backupId, review?.summary]);

  const canConfirm = Boolean(
    active &&
      !busy &&
      !blocked &&
      (!requireAuthorization || (reviewed && authorized)) &&
      summary.trim().length > 0 &&
      [...summary.trim()].length <= 500,
  );

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal.Backdrop
        isOpen={isOpen}
        isDismissable={!busy}
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <Modal.Container placement="center" size="lg" scroll="inside" className="max-w-[960px]">
          <Modal.Dialog
            aria-label={active?.rollback ? tr("确认回滚", "Confirm rollback") : tr("确认修改", "Confirm changes")}
            className="w-full max-w-[960px] rounded-3xl"
          >
            <Modal.Header className="flex items-center justify-between gap-2">
              <Modal.Heading className="font-semibold">
                {active
                  ? active.rollback
                    ? tr(`回滚 · ${identityFileLabel(active.file)}`, `Roll back · ${identityFileLabel(active.file)}`)
                    : tr(`确认写入 · ${identityFileLabel(active.file)}`, `Confirm write · ${identityFileLabel(active.file)}`)
                  : tr("确认变更", "Confirm changes")}
              </Modal.Heading>
              {!busy && <Modal.CloseTrigger aria-label={tr("关闭", "Close")} />}
            </Modal.Header>

            <Modal.Body className="kulo-form-stack">
              {active && (
                <>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <section className="flex flex-col gap-1.5">
                      <h4 className="text-sm font-medium text-muted">{tr("变更前", "Before")}</h4>
                      <ReviewDiffView value={active.before} other={active.after} />
                    </section>
                    <section className="flex flex-col gap-1.5">
                      <h4 className="text-sm font-medium text-muted">{tr("变更后", "After")}</h4>
                      {active.removes ? (
                        <pre className="mc-diff-pre text-muted">{tr("未创建", "Not created")}</pre>
                      ) : (
                        <ReviewDiffView
                          value={active.after}
                          other={active.before}
                          added
                        />
                      )}
                    </section>
                  </div>

                  <TextField className="kulo-form-field"
                    value={summary}
                    onChange={setSummary}
                    maxLength={500}
                    isDisabled={busy}
                    fullWidth
                  >
                    <Label className="text-sm font-medium text-muted">{tr("变更摘要", "Change summary")}</Label>
                    <Input variant="secondary" aria-describedby={error ? errId : undefined} />
                  </TextField>

                  {requireAuthorization && <div className="flex flex-col gap-2.5">
                    <Checkbox
                      isSelected={reviewed}
                      onChange={setReviewed}
                      isDisabled={busy}
                    >
                      <Checkbox.Content className="flex items-center gap-2 text-sm text-foreground">
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                        <Label className="text-sm font-normal">{tr("已核对变更内容", "I have reviewed the changes")}</Label>
                      </Checkbox.Content>
                    </Checkbox>

                    <Checkbox
                      isSelected={authorized}
                      onChange={setAuthorized}
                      isDisabled={busy}
                    >
                      <Checkbox.Content className="flex items-center gap-2 text-sm text-foreground">
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                        <Label className="text-sm font-normal">{tr("授权写入身份文档", "Allow writing identity document")}</Label>
                      </Checkbox.Content>
                    </Checkbox>
                  </div>}

                  {error && (
                    <Alert id={errId} status="danger" className="rounded-xl p-3">
                      <Alert.Indicator />
                      <Alert.Content className="text-xs">{error}</Alert.Content>
                    </Alert>
                  )}
                </>
              )}
            </Modal.Body>

            <Modal.Footer className="flex items-center justify-end gap-2">
              <Button variant="ghost" isDisabled={busy} onPress={onClose}>
                {tr("取消", "Cancel")}</Button>
              <Button
                variant="primary"
                isPending={busy}
                isDisabled={!canConfirm}
                onPress={() => onConfirm(summary.trim())}
              >
                {busy
                  ? tr("正在保存…", "Saving…")
                  : active?.rollback
                    ? tr("确认回滚", "Confirm rollback")
                    : tr("确认写入", "Confirm write")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function IdentityDocumentEditor({
  directoryRevision,
  file,
  onDirtyChange,
  onBusyChange,
  readFile = kuloRest.readIdentityFile,
  directSave = false,
  identityProposal,
  onDismissProposal,
  onSaved,
  loadPreset,
  refreshKey,
}: {
  directoryRevision: number;
  file: IdentityFile;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  readFile?: (file: IdentityFile) => Promise<IdentityRead>;
  directSave?: boolean;
  identityProposal?: IdentityProposal | null;
  onDismissProposal?: () => Promise<void>;
  onSaved?: () => void;
  loadPreset?: () => Promise<{ content: string }>;
  refreshKey?: string | number;
}) {
  useI18n();
  const [reloadRequested, setReloadRequested] = useState(false);
  const [read, setRead] = useState<IdentityRead | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [review, setReview] = useState<IdentityReviewState | null>(null);

  const sectionRef = useRef<HTMLElement>(null);
  const reqSeq = useRef(0);
  const dirty = Boolean(read && content !== read.content);
  const byteSize = new TextEncoder().encode(content).byteLength;
  const tooLarge = byteSize > 64 * 1024;
  const sizeMessageId = useId();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const previousLocation = useRef({ file, directoryRevision, refreshKey });

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const load = useCallback(
    async (keepDraft = false) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      try {
        const res = await readFile(file);
        if (seq !== reqSeq.current) return;
        if (res.version.directoryRevision !== directoryRevision) {
          setConflict(true);
          setError(tr("文件版本已变更，请重新读取。", "File version changed. Read it again."));
          return;
        }
        setRead(res);
        if (!keepDraft) setContent(res.content);
        setConflict(false);
        setError(undefined);
      } catch (err) {
        if (seq !== reqSeq.current) return;
        setConflict(true);
        if (err instanceof KuloApiError && err.status === 409) {
          setError(tr("检测到版本冲突，请重新读取。", "Version conflict detected. Read the file again."));
        } else {
          setError(err instanceof Error ? err.message : tr("读取失败", "Read failed"));
        }
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [file, directoryRevision, readFile],
  );

  useEffect(() => {
    const previous = previousLocation.current;
    previousLocation.current = { file, directoryRevision, refreshKey };
    if (
      previous.file === file &&
      (previous.directoryRevision !== directoryRevision || previous.refreshKey !== refreshKey) &&
      dirtyRef.current
    ) {
      reqSeq.current++;
      setLoading(false);
      setConflict(true);
      setError(tr("文件已更新，当前草稿已保留。请重新读取最新版本。", "File updated. Your draft has been kept. Read the latest version again."));
      return;
    }
    if (previous.file !== file) {
      setRead(null);
      setError(undefined);
    }
    setReview(null);
    setNotice(undefined);
    void load();
    return () => {
      reqSeq.current++;
    };
  }, [load, file, directoryRevision, refreshKey]);

  const openSaveReview = () => {
    if (!read || loading || busy || tooLarge || conflict) return;
    setError(undefined);
    setReview(createIdentitySaveReview(read, content));
  };

  const openRollbackReview = async () => {
    if (!read?.lastBackup || loading || busy || conflict) return;
    setBusy(true);
    try {
      const preview = await kuloRest.readIdentityBackup(file, read.lastBackup.backupId);
      setError(undefined);
      setReview({
        ...createIdentitySaveReview(read, preview.content),
        removes: preview.previouslyMissing,
        rollback: true,
        backupId: read.lastBackup.backupId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("读取备份失败", "Unable to read backup"));
    } finally {
      setBusy(false);
    }
  };

  const confirmReview = async (summary: string) => {
    if (!read || !review || loading || busy || conflict) return;
    setBusy(true);
    try {
      if (review.backupId) {
        if (directSave) await kuloRest.rollbackRelationship({
          expected: review.expected ?? read.version,
          backupId: review.backupId,
          summary,
        });
        else await kuloRest.rollbackIdentityFile({
          file,
          expected: review.expected ?? read.version,
          backupId: review.backupId,
          summary,
          dualSignConfirmed: true,
        });
        setNotice(tr("已恢复备份", "Backup restored"));
      } else {
        await kuloRest.saveIdentityFile({
          file,
          expected: review.expected ?? read.version,
          content: review.after,
          summary,
          dualSignConfirmed: true,
        });
        setNotice(tr("已保存", "Saved"));
      }
      setError(undefined);
      setReview((prev) => (prev ? { ...prev, open: false } : null));
      await load(false);
      onSaved?.();
    } catch (err) {
      if (err instanceof KuloApiError && err.status === 409) {
        setConflict(true);
        setError(tr("文件已被更新，请重新读取。", "File updated. Read it again."));
      } else {
        setError(err instanceof Error ? err.message : tr("保存失败", "Save failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const saveRelationship = async () => {
    if (!read || loading || busy || conflict || tooLarge) return;
    setBusy(true);
    try {
      await kuloRest.saveRelationship({ expected: read.version, content, summary: tr("修订协作关系", "Update collaboration") });
      setError(undefined);
      setNotice(tr("已保存", "Saved"));
      await load(false);
      onSaved?.();
    } catch (err) {
      if (err instanceof KuloApiError && err.status === 409) setConflict(true);
      setError(err instanceof Error ? err.message : tr("保存失败", "Save failed"));
    } finally { setBusy(false); }
  };

  const restorePreset = async () => {
    if (!loadPreset || loading || busy || conflict) return;
    setBusy(true);
    try {
      const preset = await loadPreset();
      setContent(preset.content);
      setNotice(undefined);
      setError(undefined);
    } catch (err) { setError(err instanceof Error ? err.message : tr("读取预设失败", "Unable to read preset")); }
    finally { setBusy(false); }
  };

  const canPrimarySave = Boolean(
    read && !loading && !busy && !tooLarge && !conflict && !review?.open &&
    (dirty || (!read.exists && file !== "identity-agreement.md")),
  );
  useRegisterShortcutSave(sectionRef, canPrimarySave, () => {
    if (directSave) void saveRelationship();
    else openSaveReview();
  });

  const label = identityFileLabel(file);

  return (
    <section ref={sectionRef} className="kulo-identity-editor kulo-settings-form gap-4" style={{ minHeight: 0 }} aria-label={tr(`${label}编辑器`, `${label} editor`)} aria-busy={loading || busy}>
      {identityProposal && <Alert status="accent" className="flex flex-wrap items-center gap-3 rounded-2xl p-3">
        <Alert.Indicator />
        <Alert.Content className="flex-1 text-sm">{tr("Kulo 提出了身份约定修改", "Kulo proposed changes to the identity agreement")}</Alert.Content>
        <Button variant="secondary" size="sm" isDisabled={loading || busy || dirty || !read || conflict} onPress={() => {
          if (!read || loading || busy || conflict) return;
          setReview({ open: true, file, before: read.content, after: identityProposal.content, expected: identityProposal.expected, summary: identityProposal.summary });
        }}>{tr("审阅建议", "Review suggestion")}</Button>
        {onDismissProposal && <Button variant="tertiary" size="sm" isDisabled={busy} onPress={async () => {
          setBusy(true);
          try { await onDismissProposal(); }
          catch (err) { setError(err instanceof Error ? err.message : tr("忽略失败", "Unable to dismiss")); }
          finally { setBusy(false); }
        }}>{tr("忽略", "Dismiss")}</Button>}
      </Alert>}

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {loading && !read && (
          <div className="flex min-h-[360px] items-center justify-center gap-2 text-sm text-muted">
            <Spinner size="sm" aria-label={tr(`正在读取${label}`, `Reading ${label}`)} />
            <span>{tr("正在读取…", "Reading…")}</span>
          </div>
        )}

        {read && (
          <div className="kulo-identity-field flex min-h-0 flex-col rounded-2xl bg-surface-secondary p-1">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted">
              <span className="flex items-center gap-2 text-sm text-foreground">{label}{loading && <Spinner size="sm" aria-label={tr(`正在更新${label}`, `Updating ${label}`)} />}</span>
              <span className={tooLarge ? "font-medium text-danger" : undefined}>
                {!read.exists && (file === "identity-agreement.md" ? tr("预设 · ", "Preset · ") : tr("模板 · ", "Template · "))}{(byteSize / 1024).toFixed(1)} / 64 KiB
              </span>
            </div>
            <TextArea
              aria-label={tr(`${label}内容`, `${label} content`)}
              aria-describedby={tooLarge ? sizeMessageId : undefined}
              rows={18}
              value={content}
              spellCheck={false}
              readOnly={loading || busy}
              variant="secondary"
              className="scrollbar kulo-identity-textarea resize-y border-0 bg-transparent px-4 py-3 font-mono text-sm shadow-none "
              style={{ minHeight: "clamp(360px, calc(100dvh - 400px), 640px)" }}
              fullWidth
              onChange={(event) => {
                setContent(event.target.value);
                setNotice(undefined);
              }}
            />
          </div>
        )}

        {!review?.open && error && (
          <Alert status="danger" className="rounded-xl p-3">
            <Alert.Indicator />
            <Alert.Content className="text-sm">{error}</Alert.Content>
            {!read && !loading && (
              <Button variant="secondary" size="sm" onPress={() => void load(false)}>
                {tr("重试", "Retry")}</Button>
            )}
          </Alert>
        )}

        {read && (
          <div className="kulo-settings-savebar">
            <span
              id={sizeMessageId}
              className={"shrink-0 whitespace-nowrap " + (tooLarge ? "text-sm font-medium text-danger" : "text-sm text-muted")}
            >
              {tooLarge
                ? tr("超出 64 KiB 上限", "Exceeds the 64 KiB limit")
                : dirty
                  ? tr("已修改", "Modified")
                  : notice
                    ? notice
                    : read.lastBackup
                      ? tr(`上次备份 ${new Date(read.lastBackup.createdAt).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}`, `Last backup ${new Date(read.lastBackup.createdAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}`)
                      : ""}
            </span>

            <div className="flex flex-wrap items-center justify-end gap-2">
              {loadPreset && <Button variant="tertiary" isDisabled={loading || busy || conflict} onPress={() => void restorePreset()}>{tr("恢复预设", "Restore preset")}</Button>}
              {dirty && (
                <Button
                  variant="tertiary"
                  isDisabled={loading || busy}
                  onPress={() => {
                    setContent(read.content);
                    setError(undefined);
                  }}
                >
                  {tr("放弃", "Discard")}</Button>
              )}

              {read.lastBackup && (
                <Button
                  variant="secondary"
                  isDisabled={loading || busy || conflict}
                  onPress={() => void openRollbackReview()}
                >
                  {tr("恢复备份", "Restore backup")}</Button>
              )}

              {conflict ? (
                <Button
                  variant="secondary"
                  isDisabled={loading || busy}
                  onPress={() => {
                    if (dirty) setReloadRequested(true);
                    else void load(false);
                  }}
                >
                  {tr("重新读取", "Read again")}</Button>
              ) : (
                <Button
                  variant="primary"
                  isDisabled={loading || busy || tooLarge || (!dirty && (read.exists || file === "identity-agreement.md"))}
                  onPress={directSave ? () => void saveRelationship() : openSaveReview}
                >
                  {directSave ? tr("保存", "Save") : read.exists || file === "identity-agreement.md" ? tr("审阅更改", "Review changes") : tr("初始化", "Initialize")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <IdentityConfirmationModal
        review={review}
        busy={busy}
        blocked={loading || conflict}
        error={error}
        onClose={() => setReview((previous) => (previous ? { ...previous, open: false } : null))}
        onConfirm={(summary) => void confirmReview(summary)}
        requireAuthorization={!directSave}
      />

      <ConfirmDialog
        open={reloadRequested}
        title={tr("放弃修改并重新读取？", "Discard changes and read again?")}
        description={tr("当前文件的草稿将被最新版本替换。", "The current draft will be replaced with the latest version.")}
        confirmLabel={tr("重新读取", "Read again")}
        cancelLabel={tr("继续编辑", "Keep editing")}
        status="warning"
        onCancel={() => setReloadRequested(false)}
        onConfirm={() => {
          setReloadRequested(false);
          void load(false);
        }}
      />
    </section>
  );
}
