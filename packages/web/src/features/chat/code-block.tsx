import { translate as tr, useI18n } from "../../moco-i18n";
import { Button, Link, Modal } from "@heroui/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ThemedToken } from "shiki";
import { MocoIcon } from "../../moco-icon";
import { useContentResize } from "./use-content-motion";
import "./chat-content.css";

const highlighted = new Map<string, Promise<ThemedToken[][] | null>>();
let shikiModule: Promise<typeof import("shiki")> | undefined;

function highlight(code: string, language: string): Promise<ThemedToken[][] | null> {
  if (!language || code.length > 100_000) return Promise.resolve(null);
  const key = `${language}\u0000${code}`;
  const cached = highlighted.get(key);
  if (cached) return cached;
  const result = (async () => {
    const shiki = await (shikiModule ??= import("shiki"));
    if (!Object.hasOwn(shiki.bundledLanguages, language)) return null;
    const output = await shiki.codeToTokens(code, {
      lang: language as keyof typeof shiki.bundledLanguages,
      themes: { light: "github-light", dark: "github-dark" },
    });
    return output.tokens;
  })();
  highlighted.set(key, result);
  if (highlighted.size > 24) highlighted.delete(highlighted.keys().next().value!);
  result.catch(() => { highlighted.delete(key); shikiModule = undefined; });
  return result;
}

const extensions: Record<string, string> = {
  javascript: "js", typescript: "ts", python: "py", shell: "sh", bash: "sh", jsx: "jsx", tsx: "tsx",
  json: "json", css: "css", html: "html", markdown: "md", yaml: "yml", rust: "rs", go: "go", java: "java",
};

export function codeFileName(language?: string, fileName?: string): string {
  if (fileName) return fileName.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180) || "code.txt";
  return `code.${extensions[language ?? ""] ?? (/^[a-z0-9]{1,8}$/i.test(language ?? "") ? language : "txt")}`;
}

function CodeText({ code, tokens }: { code: string; tokens: ThemedToken[][] | null }) {
  useI18n();
  if (!tokens) return <code>{code}</code>;
  return <code>{tokens.map((line, lineIndex) => <span className="moco-chat-code-line" key={lineIndex}>
    {line.map((token, index) => <span key={index} className="moco-chat-code-token" style={{
      "--code-token-light": token.color ?? token.htmlStyle?.color,
      "--code-token-dark": token.htmlStyle?.["--shiki-dark"] ?? token.color,
      fontStyle: token.fontStyle && (token.fontStyle & 1) ? "italic" : undefined,
      fontWeight: token.fontStyle && (token.fontStyle & 2) ? "bold" : undefined,
      textDecoration: token.fontStyle && (token.fontStyle & 4) ? "underline" : undefined,
    } as CSSProperties}>{token.content}</span>)}
    {lineIndex < tokens.length - 1 ? "\n" : null}
  </span>)}</code>;
}

export function CodeBlock({ code, language, fileName }: { code: string; language?: string; fileName?: string }) {
  useI18n();
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const [highlightFailed, setHighlightFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string>();
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pre = useRef<HTMLPreElement>(null);
  const fullPre = useRef<HTMLPreElement>(null);
  const prepareResize = useContentResize(pre, `${wrap}:${expanded}`);
  const normalizedLanguage = language?.trim().toLowerCase() ?? "";
  const long = code.split("\n").length > 18;
  useEffect(() => {
    let alive = true;
    setTokens(null); setHighlightFailed(false);
    // Plain text updates immediately while streamed code waits briefly for a stable boundary.
    const timer = setTimeout(() => {
      highlight(code, normalizedLanguage).then((next) => { if (alive) setTokens(next); }, () => { if (alive) setHighlightFailed(true); });
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [code, normalizedLanguage, attempt]);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [code]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("failed");
      const selectedPre = isOpen ? fullPre.current : pre.current;
      if (selectedPre) {
        const range = document.createRange(); range.selectNodeContents(selectedPre);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        selectedPre.focus();
      }
    }
  };
  const source = <CodeText code={code} tokens={tokens} />;
  const changeOpen = (open: boolean) => { setIsOpen(open); if (!open) setCopyState((state) => state === "failed" ? "idle" : state); };
  return <section className="moco-chat-code" aria-label={fileName ? tr(`代码：${fileName}`, `Code: ${fileName}`) : tr(`${normalizedLanguage || "纯文本"}代码`, `${normalizedLanguage || "Plain text"} code`)}>
    <div className="moco-chat-code-toolbar">
      <span className="moco-chat-code-language moco-chat-truncate">{fileName ?? (normalizedLanguage || tr("纯文本", "Plain text"))}</span>
      <div className="moco-chat-actions">
        <Button size="sm" variant="ghost" aria-label={wrap ? tr("关闭代码自动折行", "Disable code wrapping") : tr("开启代码自动折行", "Enable code wrapping")} aria-pressed={wrap} onPress={() => { prepareResize(); setWrap((value) => !value); }}>{tr("折行", "Wrap")}</Button>
        <Button size="sm" variant="ghost" onPress={() => setIsOpen(true)}>{tr("放大", "Expand")}</Button>
        <Button size="sm" variant="ghost" onPress={() => { void copy(); }}><MocoIcon name={copyState === "copied" ? "check" : "copy"} size={14} />{copyState === "copied" ? tr("已复制", "Copied") : tr("复制", "Copy")}</Button>
        {downloadUrl && <Link href={downloadUrl} download={codeFileName(normalizedLanguage, fileName)} className="moco-chat-download-link">{tr("下载", "Download")}</Link>}
      </div>
    </div>
    <pre ref={pre} tabIndex={0} className="moco-chat-code-pre" data-wrap={wrap || undefined} data-collapsed={long && !expanded || undefined}>{source}</pre>
    {(long || copyState === "failed" || highlightFailed) && <div className="moco-chat-code-footer">
      {long && <Button size="sm" variant="ghost" onPress={() => { prepareResize(); setExpanded((value) => !value); }} aria-expanded={expanded}>{expanded ? tr("收起", "Collapse") : tr(`展开 ${code.split("\n").length} 行`, `Show ${code.split("\n").length} lines`)}</Button>}
      {copyState === "failed" && <span role="status" className="moco-chat-meta">{tr("复制失败，代码已选中，可手动复制", "Copy failed. The code is selected for manual copying.")}</span>}
      {highlightFailed && <Button size="sm" variant="ghost" onPress={() => setAttempt((value) => value + 1)}>{tr("重试高亮", "Retry highlighting")}</Button>}
    </div>}
    <Modal.Backdrop isOpen={isOpen} onOpenChange={changeOpen}><Modal.Container size="lg" className="moco-chat-code-modal"><Modal.Dialog className="moco-chat-code-dialog" aria-label={tr("完整代码", "Full code")}>
        <Modal.CloseTrigger />
        <Modal.Header><Modal.Heading>{fileName ?? (normalizedLanguage || tr("代码", "Code"))}</Modal.Heading></Modal.Header>
        <Modal.Body><pre ref={fullPre} tabIndex={0} className="moco-chat-code-pre moco-chat-code-pre-full" data-wrap={wrap || undefined}>{source}</pre></Modal.Body>
        <Modal.Footer>{copyState === "failed" && <span role="status" className="moco-chat-meta">{tr("复制失败，代码已选中，可手动复制", "Copy failed. The code is selected for manual copying.")}</span>}<Button variant="secondary" size="sm" onPress={() => { void copy(); }}>{copyState === "copied" ? tr("已复制", "Copied") : tr("复制代码", "Copy code")}</Button><Button variant="primary" size="sm" onPress={() => changeOpen(false)}>{tr("完成", "Done")}</Button></Modal.Footer>
      </Modal.Dialog></Modal.Container></Modal.Backdrop>
  </section>;
}
