import { translate as tr, useI18n } from "../../kulo-i18n";
import {
  Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ErrorInfo, type ReactNode,
} from "react";
import { createStateStore } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { Button, Card, Chip, Disclosure, Form, Spinner } from "@heroui/react";
import {
  UiCardSnapshotSchema, getUiSpecFields, validateUiActionValues,
  type UiActionInput, type UiActionReceipt, type UiCardSnapshot, type UiValue, type UiValues,
} from "@kulo/protocol";
import { kuloUiRegistry } from "./catalog";
import {
  cardInitialValues, hasDraftConflict, isDefiniteActionRejection, readCardDraft,
  reconcileCardDraft, writeCardDraft, type CardDraft, type DraftStorage,
} from "./card-drafts";
import { CardRuntimeContext, type CardCodeProps, type CardMediaProps } from "./card-runtime";
import { cardValueSummary } from "./card-value-summary";
import "./genui.css";

export interface GeneratedCardProps {
  card: UiCardSnapshot;
  onAction: (input: UiActionInput) => Promise<UiActionReceipt>;
  isConnected?: boolean;
  animateEntry?: boolean;
  fallbackText?: string;
  onAdjust?: (card: UiCardSnapshot, values: UiValues) => void;
  renderMedia?: (props: CardMediaProps) => ReactNode;
  renderCode?: (props: CardCodeProps) => ReactNode;
}

class CardRenderBoundary extends Component<{ children: ReactNode; revision: number; fallbackText?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Generated card could not render", error, info.componentStack);
  }
  componentDidUpdate(previous: Readonly<{ children: ReactNode; revision: number; fallbackText?: string }>) {
    if (this.state.failed && previous.revision !== this.props.revision) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <p className="kulo-genui-fallback" role="status">{this.props.fallbackText || tr("此卡片暂时无法显示", "This card is temporarily unavailable")}</p> : this.props.children;
  }
}

function browserStorage(): DraftStorage | undefined {
  if (typeof window === "undefined") return undefined;
  // Access itself may be blocked in a private or embedded browser.
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  };
}

function commandId(): string {
  if (!globalThis.crypto?.getRandomValues) throw new Error(tr("当前浏览器无法创建提交标识", "This browser cannot create a submission ID"));
  if (globalThis.crypto.randomUUID) return `ui-${globalThis.crypto.randomUUID()}`;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `ui-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function statusLabel(card: UiCardSnapshot, pending: boolean, uncertain: boolean): string {
  if (uncertain) return tr("待核实", "Unconfirmed");
  if (pending) return tr("提交中", "Submitting");
  const ready = !card.actions.length ? tr("预览", "Preview") : Object.values(card.spec.elements).some((element) => element.type === "Choice" || element.type === "Table" && typeof element.props.field === "string") ? tr("待选择", "Choose an option") : tr("待提交", "Ready to submit");
  return { ready, submitted: tr("已提交", "Submitted"), cancelled: tr("已取消", "Cancelled"), failed: tr("提交失败", "Submission failed"), expired: tr("已失效", "Expired") }[card.status];
}

function ResultValues({ card }: { card: UiCardSnapshot }) {
  useI18n();
  const entries = cardValueSummary(card, card.committedState);
  if (!entries.length) return null;
  return <dl className="kulo-genui-result-values">{entries.map(({ name, label, display }) => {
    return <div className="kulo-genui-result-row" key={name}>
      <dt className="kulo-genui-result-key">{label}</dt><dd className="kulo-genui-result-value">{display}</dd>
    </div>;
  })}</dl>;
}

function CardSession({ card, onAction, isConnected = true, animateEntry = false, fallbackText, onAdjust, renderMedia, renderCode }: GeneratedCardProps) {
  useI18n();
  const [initial] = useState(() => readCardDraft(card, browserStorage()));
  const [draft, setDraft] = useState(initial.draft);
  const [store] = useState(() => createStateStore({ values: initial.draft.values }));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const values = state.values as UiValues;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const pendingRef = useRef(draft.pending);
  const busyRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [storageError, setStorageError] = useState(initial.storageError);
  const [receipt, setReceipt] = useState<UiActionReceipt>();
  const [submittedValues, setSubmittedValues] = useState<UiValues>();
  const entrance = useRef(animateEntry).current;
  const cardElementRef = useRef<HTMLDivElement>(null);
  const submissionOwnedFocus = useRef(false);
  const disclosureRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLFormElement>(null);
  const lastSnapshot = useRef(`${card.revision}:${card.status}`);
  const currentCard = receipt && receipt.revision >= card.revision
    ? receipt.card ?? { ...card, status: receipt.status, revision: receipt.revision,
      committedState: receipt.status === "submitted" ? submittedValues ?? card.committedState : card.committedState }
    : card;
  const terminal = currentCard.status !== "ready" && currentCard.status !== "failed";
  const conflict = !terminal && hasDraftConflict(draft, currentCard);
  const uncertain = !!draft.pending && !sending && !terminal;
  const locked = terminal || conflict || !!draft.pending;

  const restoreDisclosureFocus = useCallback((afterSubmission = false) => {
    if (typeof document === "undefined") return;
    const active = document.activeElement;
    // A terminal push may remove the footer button before its HTTP receipt arrives.
    const lostSubmitFocus = afterSubmission && submissionOwnedFocus.current
      && (active === document.body || active === document.documentElement || !!cardElementRef.current?.contains(active));
    if (contentRef.current?.contains(active) || lostSubmitFocus) {
      disclosureRef.current?.querySelector<HTMLButtonElement>("button[data-card-toggle]")?.focus({ preventScroll: true });
    }
    if (afterSubmission) submissionOwnedFocus.current = false;
  }, []);

  const applyDraft = useCallback((next: CardDraft) => {
    draftRef.current = next;
    pendingRef.current = next.pending;
    setDraft(next);
    store.set("/values", next.values);
  }, [store]);

  useEffect(() => {
    const key = `${card.revision}:${card.status}`;
    if (lastSnapshot.current === key) return;
    lastSnapshot.current = key;
    const next = reconcileCardDraft(draftRef.current, card);
    if (!next.expanded) restoreDisclosureFocus(card.status !== "ready" && card.status !== "failed");
    applyDraft(next);
    setFieldErrors({});
    if (card.status !== "ready" && card.status !== "failed") setError(undefined);
  }, [card, applyDraft, restoreDisclosureFocus]);

  useEffect(() => {
    const failure = writeCardDraft(card.cardId, draft, browserStorage());
    if (failure) setStorageError(failure);
  }, [card.cardId, draft]);

  const send = useCallback(async (input: UiActionInput) => {
    if (!isConnected || busyRef.current) return;
    submissionOwnedFocus.current = typeof document !== "undefined" && !!cardElementRef.current?.contains(document.activeElement);
    busyRef.current = true;
    pendingRef.current = input;
    const pendingDraft = { ...draftRef.current, pending: input };
    applyDraft(pendingDraft);
    const persistenceFailure = writeCardDraft(card.cardId, pendingDraft, browserStorage());
    if (persistenceFailure) setStorageError(persistenceFailure);
    setSending(true);
    setError(undefined);
    try {
      const result = await onAction(input);
      if (result.commandId !== input.commandId || result.cardId !== card.cardId) {
        throw new Error(tr("提交回执不匹配，请核实状态", "Submission receipt mismatch. Please verify the status."));
      }
      setReceipt(result);
      if (result.status === "submitted") setSubmittedValues(input.values);
      const complete = result.status !== "ready" && result.status !== "failed";
      if (complete) restoreDisclosureFocus(true);
      else submissionOwnedFocus.current = false;
      applyDraft({
        ...draftRef.current,
        pending: undefined,
        baseRevision: result.revision,
        dirty: result.status === "submitted" ? false : draftRef.current.dirty,
        expanded: !complete,
      });
      if (result.status === "failed") setError(result.card?.error || tr("提交失败，输入已保留", "Submission failed. Your input has been kept."));
    } catch (failure) {
      if (isDefiniteActionRejection(failure)) {
        submissionOwnedFocus.current = false;
        applyDraft({ ...draftRef.current, pending: undefined });
      }
      setError(failure instanceof Error ? failure.message : tr("提交状态待核实", "Submission status unconfirmed"));
    } finally {
      busyRef.current = false;
      setSending(false);
    }
  }, [applyDraft, card.cardId, isConnected, onAction, restoreDisclosureFocus]);

  const act = useCallback((actionId: string) => {
    if (locked || !isConnected || pendingRef.current || busyRef.current) return;
    const action = currentCard.actions.find((item) => item.id === actionId);
    if (!action) return;
    const fields = new Set((action.fields ?? []).map((field) => field.name));
    const actionValues = Object.fromEntries(Object.entries(draftRef.current.values).filter(([field]) => fields.has(field)));
    const parsed = validateUiActionValues(action, actionValues);
    if (!parsed.success) {
      setFieldErrors(parsed.errors);
      if (!draftRef.current.expanded) applyDraft({ ...draftRef.current, expanded: true });
      return;
    }
    setFieldErrors({});
    try {
      void send({ cardId: currentCard.cardId, revision: currentCard.revision, actionId, values: parsed.data, commandId: commandId() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : tr("无法创建提交标识", "Unable to create a submission ID"));
    }
  }, [applyDraft, currentCard, isConnected, locked, send]);

  const change = useCallback((field: string, value: UiValue) => {
    if (locked) return;
    const next = { ...draftRef.current.values, [field]: value };
    store.set(`/values/${field}`, value);
    applyDraft({ ...draftRef.current, values: next, dirty: true });
    setFieldErrors((previous) => { const updated = { ...previous }; delete updated[field]; return updated; });
    setError(undefined);
  }, [applyDraft, locked, store]);

  const adoptRevision = () => {
    const fields = new Set(getUiSpecFields(card.spec).map((field) => field.name));
    const retained = Object.fromEntries(Object.entries(draftRef.current.values).filter(([key]) => fields.has(key)));
    applyDraft({ ...draftRef.current, baseRevision: card.revision, values: { ...cardInitialValues(card), ...retained } });
    setReceipt(undefined);
    setError(undefined);
  };

  const runtime = {
    card: currentCard, values, errors: fieldErrors, locked,
    actionDisabled: locked || !isConnected || sending,
    pendingActionId: sending ? draft.pending?.actionId : undefined,
    change, act, renderMedia, renderCode,
  };
  const wide = Object.values(card.spec.elements).some((element) => element.type === "Table");
  const previewOnly = !card.actions.length && !getUiSpecFields(card.spec).length;
  const explicitActions = new Set(Object.values(card.spec.elements)
    .filter((element) => element.type === "Button").map((element) => String(element.props.actionId)));
  const footerActions = card.actions.filter((action) => !explicitActions.has(action.id));
  const firstSubmitId = card.actions.find((action) => action.kind === "submit")?.id;
  const committedCard = currentCard;
  const status = statusLabel(currentCard, sending, uncertain);
  const renderedSpec = <CardRuntimeContext value={runtime}>
    <JSONUIProvider registry={kuloUiRegistry} store={store}>
      <CardRenderBoundary revision={card.revision} fallbackText={fallbackText}><Renderer spec={card.spec} registry={kuloUiRegistry} /></CardRenderBoundary>
    </JSONUIProvider>
  </CardRuntimeContext>;
  const contentLabel = terminal ? draft.dirty ? tr("保留的输入", "Saved input") : tr("参数", "Parameters") : tr("卡片内容", "Card content");
  const content = <>
    <Card.Header className="kulo-genui-header">
      <Card.Title className="kulo-genui-title">{card.title}</Card.Title>
      <Chip size="sm" variant="soft" color={currentCard.status === "failed" ? "danger" : "default"} className="kulo-genui-status">
        {sending && <Spinner size="sm" />}<Chip.Label>{status}</Chip.Label>
      </Chip>
      {!previewOnly && <Disclosure.Heading className="kulo-genui-toggle-heading">
        <Button slot="trigger" variant="ghost" size="sm" isIconOnly data-card-toggle
          aria-label={tr(`${draft.expanded ? "收起" : "展开"}${contentLabel}：${card.title}`, `${draft.expanded ? "Collapse" : "Expand"} ${contentLabel}: ${card.title}`)}>
          <Disclosure.Indicator />
        </Button>
      </Disclosure.Heading>}
    </Card.Header>
    <Card.Content className="kulo-genui-content">
      {terminal && <div className="kulo-genui-result" aria-live="polite">
        {committedCard.resultSummary && <p className="kulo-genui-result-summary">{committedCard.resultSummary}</p>}
        <ResultValues card={committedCard} />
      </div>}
      {previewOnly ? renderedSpec : <Disclosure.Content className="kulo-genui-panel"><Disclosure.Body className="kulo-genui-disclosure-body">
        <Form ref={contentRef} validationBehavior="aria" onSubmit={(event) => {
          event.preventDefault();
          const first = card.actions.find((action) => action.kind === "submit");
          if (first) act(first.id);
        }}>
          {renderedSpec}
        </Form>
      </Disclosure.Body></Disclosure.Content>}
      {(error || card.error || conflict || uncertain || !isConnected || storageError || fieldErrors._form) && <div className="kulo-genui-feedback">
        {(error || card.error || fieldErrors._form) && <p role="alert" className="kulo-genui-error">{error || card.error || fieldErrors._form}</p>}
        {conflict && <div className="kulo-genui-footer"><p role="status" className="kulo-genui-note">{tr("卡片已更新，输入已保留", "Card updated. Your input has been kept.")}</p>
          <Button size="sm" variant="secondary" onPress={adoptRevision} isDisabled={!!draft.pending}>{tr("采用新版", "Use latest version")}</Button>
        </div>}
        {uncertain && <div className="kulo-genui-footer"><p role="status" className="kulo-genui-note">{tr("提交状态待核实", "Submission status unconfirmed")}</p>
          <Button size="sm" variant="secondary" isDisabled={!isConnected || sending} onPress={() => {
            if (pendingRef.current) void send(pendingRef.current);
          }}>{tr("核实状态", "Verify status")}</Button>
        </div>}
        {!isConnected && <p role="status" className="kulo-genui-note">{tr("离线 · 输入已保留", "Offline · Input kept")}</p>}
        {storageError && <p role="status" className="kulo-genui-note">{storageError}</p>}
      </div>}
    </Card.Content>
    {(!terminal && footerActions.length > 0 || terminal && onAdjust) && <Card.Footer className="kulo-genui-footer">
      {!terminal && footerActions.map((action) => <Button key={action.id} type="button"
        variant={action.id === firstSubmitId ? "primary" : "secondary"}
        isDisabled={runtime.actionDisabled} isPending={sending && draft.pending?.actionId === action.id}
        onPress={() => act(action.id)}>{action.label}</Button>)}
      {terminal && onAdjust && <Button variant="secondary" size="sm" onPress={() => onAdjust(currentCard, values)}>{tr("以此调整", "Adjust from this")}</Button>}
    </Card.Footer>}
  </>;
  return <Card ref={cardElementRef} className="kulo-genui-card" data-wide={wide || undefined} data-enter={entrance || undefined} aria-label={card.title}>
    {previewOnly ? content : <Disclosure ref={disclosureRef} className="kulo-genui-shell" isExpanded={draft.expanded}
      onExpandedChange={(expanded) => {
        if (!expanded) restoreDisclosureFocus();
        applyDraft({ ...draftRef.current, expanded });
      }}>{content}</Disclosure>}
  </Card>;
}

export function GeneratedCard(props: GeneratedCardProps) {
  useI18n();
  const parsed = useMemo(() => UiCardSnapshotSchema.safeParse(props.card), [props.card]);
  if (!parsed.success) return <Card className="kulo-genui-card">
    <Card.Header><Card.Title>{typeof props.card?.title === "string" ? props.card.title : tr("交互卡片", "Interactive card")}</Card.Title></Card.Header>
    <Card.Content><p className="kulo-genui-fallback" role="status">{props.fallbackText || tr("此卡片暂不支持显示", "This card cannot be displayed yet")}</p></Card.Content>
  </Card>;
  return <CardSession key={parsed.data.cardId} {...props} card={parsed.data} />;
}
