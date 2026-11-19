import { translate as tr, useI18n } from "./moco-i18n";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import { Link } from "@heroui/react";
import { useMemo } from "react";
import { AssetImage, safeContentUrl, type PreviewableImage } from "./features/chat/asset-preview";
import { CodeBlock } from "./features/chat/code-block";
import "./features/chat/chat-content.css";

export { CodeBlock } from "./features/chat/code-block";

export function markdownUrlTransform(url: string, key: string): string {
  if (key === "src") return safeContentUrl(url) ?? "";
  if (/^mailto:/i.test(url) || url.startsWith("#")) return defaultUrlTransform(url);
  return safeContentUrl(url) ?? "";
}

export function MocoMarkdown({ text, onPreviewImage }: { text: string; onPreviewImage?: (image: PreviewableImage) => void }) {
  const { language } = useI18n();
  const components: Components = useMemo(() => ({
    pre: ({ node, children }) => {
      const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
      if (!code || code.type !== "element") return <pre>{children}</pre>;
      const classNames = Array.isArray(code.properties.className) ? code.properties.className : [];
      const language = classNames.map(String).find((name) => name.startsWith("language-"))?.slice(9);
      const value = code.children.map((child) => child.type === "text" ? child.value : "").join("").replace(/\n$/, "");
      return <CodeBlock code={value} language={language} />;
    },
    code: ({ children }) => <code className="moco-chat-inline-code">{children}</code>,
    a: ({ href, children }) => href ? <Link href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" className="moco-chat-prose-link">{children}</Link> : <span>{children}</span>,
    img: ({ src, alt }) => typeof src === "string" && src ? <AssetImage image={{ src, name: alt || tr("图片", "Image") }} onPreviewImage={onPreviewImage} /> : <span className="moco-chat-meta">{alt || tr("图片无法显示", "Image unavailable")}</span>,
    table: ({ children }) => <div className="moco-chat-table-scroll" tabIndex={0} role="region" aria-label={tr("表格", "Table")}><table className="moco-chat-table">{children}</table></div>,
    blockquote: ({ children, node }) => {
      const content = node?.children.flatMap((child) => child.type === "element" ? child.children : [child]).map((child) => child.type === "text" ? child.value : "").join("") ?? "";
      return <blockquote className={/🧠|Hindsight/.test(content) ? "moco-chat-memory-callout" : undefined}>{children}</blockquote>;
    },
    input: ({ checked }) => <span className="moco-chat-task-mark" role="img" aria-label={checked ? tr("已完成", "Complete") : tr("未完成", "Incomplete")}>{checked ? "☑" : "☐"}</span>,
  }), [onPreviewImage, language]);
  if (!text) return null;
  return <div className="moco-chat-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough]} urlTransform={markdownUrlTransform} components={components}>{text}</Markdown></div>;
}
