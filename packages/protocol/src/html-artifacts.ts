import type { ChatAttachment } from "./domain.js";

/** The response policy also isolates a preview opened as a top-level browser page. */
export const HTML_ARTIFACT_CSP = [
  "default-src 'none'",
  "sandbox allow-scripts allow-forms",
  "script-src 'unsafe-inline' data: blob:",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export const HTML_ARTIFACT_BROWSER_CSP = HTML_ARTIFACT_CSP.replace("frame-src 'none'", "frame-src about:");

export function isHtmlArtifact(asset: Pick<ChatAttachment, "name" | "mimeType">): boolean {
  return /\.html?$/i.test(asset.name) && asset.mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/html";
}

/** Applied only inside isolated artifact documents, never to the application DOM. */
export function htmlArtifactDocument(html: string): string {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style data-moco-artifact>html{scrollbar-width:thin;scrollbar-color:var(--scrollbar-thumb,var(--muted,#a1a1aa)) transparent}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{border-radius:3px;background:var(--scrollbar-thumb,var(--muted,#a1a1aa))}</style>`;
  return `<!doctype html>${head}${html}`;
}

function htmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** An outer frame policy also prevents the artifact from exfiltrating via self-navigation. */
export function htmlArtifactBrowserDocument(html: string, name = "HTML"): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlAttribute(name)}</title><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;border:0;width:100%;height:100%;color-scheme:light;background:Canvas}</style></head><body><iframe title="${htmlAttribute(name)}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" srcdoc="${htmlAttribute(htmlArtifactDocument(html))}"></iframe></body></html>`;
}
