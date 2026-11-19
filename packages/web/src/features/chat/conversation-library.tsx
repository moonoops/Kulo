import { Button, Description, Label, ListBox, Modal, SearchField, Spinner } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import type { ConversationFilesPage, ConversationSearchMatch, ConversationSearchPage } from "@moco/protocol";
import { mocoRest } from "../../moco-api";
import { MocoIcon } from "../../moco-icon";
import { useI18n } from "../../moco-i18n";
import { formatAssetSize } from "./asset-preview";
import { formatMessageTime } from "./message-time";
import { searchExcerptParts } from "./conversation-navigation";
import "./conversation-library.css";

export interface ConversationDestination { topicId: string; messageId?: number; assetId?: string }

export function SearchExcerpt({ text, query }: { text: string; query: string }) {
  return <>{searchExcerptParts(text, query).map((part, index) => part.match ? <mark className="moco-conversation-search-match" key={index}>{part.text}</mark> : part.text)}</>;
}

export function ConversationSearchDialog({ isOpen, onOpenChange, topicId, scopeKey, initialScope = "all", scopeVersion = 0, onNavigate }: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  topicId: string;
  scopeKey?: string;
  initialScope?: "all" | "current";
  scopeVersion?: number;
  onNavigate: (destination: ConversationDestination) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [currentOnly, setCurrentOnly] = useState(initialScope === "current");
  const [page, setPage] = useState<ConversationSearchPage>({ items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const needle = query.trim();
  useEffect(() => { setQuery(""); setPage({ items: [] }); setError(""); }, [scopeKey]);
  useEffect(() => {
    if (!isOpen) return;
    setCurrentOnly(initialScope === "current");
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen, initialScope, scopeVersion]);
  useEffect(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPage({ items: [] }); setError("");
    if (!isOpen || !needle) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    const timer = setTimeout(() => {
      void mocoRest.searchConversations({ query: needle, ...(currentOnly ? { topicId } : {}), limit: 30 }, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setPage(result); })
        .catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("搜索失败，请重试", "Search failed. Please retry.")); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [isOpen, needle, currentOnly, topicId, scopeKey, attempt]);
  const loadMore = async () => {
    if (!page.nextCursor || loading) return;
    const controller = request.current;
    if (!controller || controller.signal.aborted) return;
    setLoading(true); setError("");
    try {
      const result = await mocoRest.searchConversations({ query: needle, ...(currentOnly ? { topicId } : {}), cursor: page.nextCursor, limit: 30 }, controller.signal);
      if (!controller.signal.aborted) setPage((previous) => ({ ...result, items: [...previous.items, ...result.items] }));
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("搜索失败，请重试", "Search failed. Please retry.")); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const key = (match: ConversationSearchMatch) => `${match.topicId}:${match.kind}:${match.messageId ?? "title"}`;
  return <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
    <Modal.Container size="lg" scroll="inside"><Modal.Dialog data-moco-overlay="conversation-search">
      <Modal.Header><Modal.Heading>{t("搜索对话", "Search conversations")}</Modal.Heading><Modal.CloseTrigger aria-label={t("关闭对话搜索", "Close conversation search")} /></Modal.Header>
      <Modal.Body className="moco-conversation-library-body">
        <SearchField variant="secondary" className="moco-context-field" aria-label={t("搜索标题或正文", "Search titles or messages")} value={query} onChange={setQuery} fullWidth>
          <SearchField.Group><SearchField.SearchIcon /><SearchField.Input ref={input} autoFocus maxLength={256} placeholder={t("搜索标题或正文…", "Search titles or messages…")} /><SearchField.ClearButton aria-label={t("清空对话搜索", "Clear conversation search")} /></SearchField.Group>
        </SearchField>
        <div className="moco-conversation-library-scope">
          <Button size="sm" variant="ghost" aria-pressed={!currentOnly} onPress={() => setCurrentOnly(false)}>{t("全部对话", "All conversations")}</Button>
          <Button size="sm" variant="ghost" aria-pressed={currentOnly} onPress={() => setCurrentOnly(true)}>{t("当前对话", "This conversation")}</Button>
        </div>
        {page.items.length > 0 && <ListBox aria-label={t("对话搜索结果", "Conversation search results")} selectionMode="none" onAction={(selected) => {
          const match = page.items.find((item) => key(item) === String(selected));
          if (match) { onOpenChange(false); onNavigate({ topicId: match.topicId, messageId: match.messageId }); }
        }}>{page.items.map((match) => <ListBox.Item key={key(match)} id={key(match)} textValue={`${match.topicTitle} ${match.excerpt}`}>
          <div className="moco-conversation-library-item">
            <Label><SearchExcerpt text={match.topicTitle || t("新对话", "New conversation")} query={needle} />{match.archived && <span className="moco-item-description"> · {t("已归档", "Archived")}</span>}</Label>
            <Description className="moco-conversation-search-excerpt"><SearchExcerpt text={match.excerpt} query={needle} /></Description>
            {match.role && <span className="moco-item-description">{match.role === "user" ? t("你", "You") : "Moco"}{match.createdAt ? ` · ${formatMessageTime(match.createdAt)?.label ?? ""}` : ""}</span>}
          </div>
        </ListBox.Item>)}</ListBox>}
        {loading && <div role="status" className="moco-conversation-library-status"><Spinner size="sm" />{t("搜索中…", "Searching…")}</div>}
        {!loading && !error && needle && !page.items.length && <p role="status" className="moco-conversation-library-status">{t("未找到匹配的对话", "No matching conversations")}</p>}
        {error && <div className="moco-conversation-library-status" role="alert"><span>{error}</span><Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>{t("重试", "Retry")}</Button></div>}
        {page.nextCursor && !error && <Button size="sm" variant="ghost" isDisabled={loading} onPress={() => void loadMore()}>{t("更多结果", "More results")}</Button>}
      </Modal.Body>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}

export function ConversationFilesButton({ topicId, revision, scopeKey, isLocal, onNavigate }: {
  topicId: string;
  revision: string;
  scopeKey?: string;
  isLocal?: boolean;
  onNavigate: (destination: ConversationDestination) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ConversationFilesPage>({ items: [], total: 0 });
  const [loadedKey, setLoadedKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const request = useRef<AbortController | null>(null);
  const key = `${scopeKey ?? ""}:${topicId}:${revision}`;
  useEffect(() => { setOpen(false); setLoadedKey(""); setPage({ items: [], total: 0 }); setError(""); }, [topicId, scopeKey]);
  useEffect(() => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    if (!open) return () => controller.abort();
    setError(""); setPage({ items: [], total: 0 }); setLoadedKey("");
    if (isLocal) { setLoading(false); setLoadedKey(key); return () => controller.abort(); }
    setLoading(true);
    void mocoRest.listTopicFiles(topicId, { limit: 40 }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setPage(result); setLoadedKey(key); } })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("文件加载失败，请重试", "Could not load files. Please retry.")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, key, topicId, isLocal, attempt]);
  const loadMore = async () => {
    if (!page.nextCursor || loading || !request.current || request.current.signal.aborted) return;
    const controller = request.current;
    setLoading(true); setError("");
    try {
      const result = await mocoRest.listTopicFiles(topicId, { cursor: page.nextCursor, limit: 40 }, controller.signal);
      if (!controller.signal.aborted) setPage((previous) => ({ ...result, items: [...previous.items, ...result.items] }));
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("文件加载失败，请重试", "Could not load files. Please retry.")); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const title = t("本次文件", "Conversation files");
  return <>
    <Button size="sm" isIconOnly variant="ghost" className="moco-window-control" aria-haspopup="dialog" aria-label={title} onPress={() => setOpen(true)}><MocoIcon name="document" size={18} /></Button>
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container size="lg" scroll="inside"><Modal.Dialog>
        <Modal.Header><Modal.Heading>{title}{loadedKey === key ? ` · ${page.total}` : ""}</Modal.Heading><Modal.CloseTrigger aria-label={t("关闭本次文件", "Close conversation files")} /></Modal.Header>
        <Modal.Body className="moco-conversation-library-body">
          {page.items.length > 0 && <ListBox aria-label={t("本次文件列表", "Conversation file list")} selectionMode="none" onAction={(selected) => {
            const file = page.items.find((item) => item.asset.id === String(selected));
            if (file) { setOpen(false); onNavigate({ topicId, messageId: file.messageId, assetId: file.asset.id }); }
          }}>{page.items.map((file) => <ListBox.Item key={file.asset.id} id={file.asset.id} textValue={file.asset.name} aria-label={t(`定位文件：${file.asset.name}`, `Locate file: ${file.asset.name}`)}>
            <MocoIcon name={file.asset.kind === "image" ? "image" : "document"} size={20} />
            <div className="moco-conversation-library-item"><Label className="moco-conversation-file-name">{file.asset.name}</Label><Description>{file.asset.name.split(".").at(-1)?.toUpperCase()} · {formatAssetSize(file.asset.size)} · {file.role === "user" ? t("来自你", "From you") : t("来自 Moco", "From Moco")}</Description></div>
            <MocoIcon name="chevron-right" size={16} />
          </ListBox.Item>)}</ListBox>}
          {loading && <div className="moco-conversation-library-status" role="status"><Spinner size="sm" />{t("加载中…", "Loading…")}</div>}
          {!loading && !error && loadedKey === key && !page.items.length && <p className="moco-conversation-library-status" role="status">{t("本次对话暂无文件", "No files in this conversation")}</p>}
          {error && <div className="moco-conversation-library-status" role="alert"><span>{error}</span><Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>{t("重试", "Retry")}</Button></div>}
          {page.nextCursor && !error && <Button size="sm" variant="ghost" isDisabled={loading} onPress={() => void loadMore()}>{t("更多文件", "More files")}</Button>}
        </Modal.Body>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
  </>;
}
