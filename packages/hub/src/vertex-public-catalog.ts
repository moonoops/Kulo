import { inferModelPurpose } from "@moco/protocol";
import { parseHTML, type HTMLElement } from "linkedom";
import type { RawDiscoveredModel } from "./provider-discovery.js";

export const VERTEX_PUBLIC_CATALOG_URL = "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions?hl=en";
const GOOGLE_MODELS_URL = "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/google-models?hl=en";
const DOCS_ORIGIN = "https://docs.cloud.google.com";
const GEMINI_DETAIL_PATH = /^\/gemini-enterprise-agent-platform\/models\/gemini\/[a-z0-9-]+$/;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_PAGES = 24;
const MAX_MODELS = 2_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DATE_PATTERN = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/;

type DocumentFetcher = (url: URL, signal: AbortSignal) => Promise<Response>;

function text(node: { textContent: string | null } | null | undefined): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function modelId(value: string): string | undefined {
  const id = value.trim().replace(/[\s*†‡]+$/, "");
  return /^gemini-[a-z0-9][a-z0-9._-]{0,126}$/.test(id) ? id : undefined;
}

function belongsToModelDirectory(id: string): boolean {
  // Dedicated embedding and omni experimental endpoints are outside Moco's 5-purpose model directory.
  return !/(?:^|-)(?:embedding|omni)(?:-|$)/.test(id);
}

function discoveredVertexModel(id: string, extra: Omit<RawDiscoveredModel, "id" | "purpose"> = {}): RawDiscoveredModel {
  const purpose = inferModelPurpose({ id });
  return { id, ...(purpose !== "chat" ? { purpose } : {}), ...extra };
}

function utcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function documentDate(value: string): number | undefined {
  const date = value.match(DATE_PATTERN);
  if (!date) return undefined;
  const day = Number(date[2]);
  const month = MONTHS.indexOf(date[1]!);
  const year = Number(date[3]);
  const valueUtc = Date.UTC(year, month, day);
  const parsed = new Date(valueUtc);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month && parsed.getUTCDate() === day ? valueUtc : undefined;
}

function article(html: string) {
  const root = parseHTML(html).document.querySelector(".devsite-article-body");
  if (!root) throw new Error("Google 官方模型文档结构已变化，无法读取模型目录。");
  for (const node of root.querySelectorAll("script,style,nav")) node.remove();
  return root;
}

export function parseVertexModelLifecycle(html: string, now = new Date()): { models: RawDiscoveredModel[]; retiredIds: Set<string> } {
  const root = article(html);
  if (!root.querySelector("#retired-models")) throw new Error("Google 官方模型生命周期文档缺少退休模型分区。");
  const today = utcDay(now);
  const models = new Map<string, RawDiscoveredModel>();
  const retiredIds = new Set<string>();
  let retired = false;
  let catalogTables = 0;
  for (const element of root.querySelectorAll("h2,h3,h4,table")) {
    if (element.id === "retired-models") retired = true;
    if (element.localName !== "table") continue;
    const rows = [...element.querySelectorAll("tr")];
    const headings = [...(rows[0]?.querySelectorAll("th") ?? [])].map((cell) => text(cell).toLowerCase());
    if (headings[0] !== "model id" || headings[1] !== "release date" || headings[2] !== "retirement date") continue;
    if (!retired) catalogTables++;
    for (const row of rows.slice(1)) {
      const cells = [...row.querySelectorAll("td")];
      if (cells.length < 3) throw new Error("Google 官方模型生命周期表格包含不完整记录。");
      const codes = cells[0]!.querySelectorAll("code");
      const ids = [...codes].map((code) => modelId(text(code))).filter((id): id is string => Boolean(id));
      if (!ids.length) continue;
      const retirement = text(cells[2]);
      const retirementDate = documentDate(retirement);
      // "or later" is a lower bound, not an announced retirement date.
      const isRetired = retired || retirementDate !== undefined && retirementDate <= today && !/or later|no sooner than/i.test(retirement);
      if (isRetired) {
        ids.forEach((id) => retiredIds.add(id));
        continue;
      }
      const release = documentDate(text(cells[1]));
      if (release === undefined) throw new Error("Google 官方模型生命周期表格包含无法读取的发布日期。");
      if (release > today) continue;
      if (retirement && retirementDate === undefined && !/^no retirement date announced$/i.test(retirement)) {
        throw new Error("Google 官方模型生命周期表格包含无法读取的退休日期。");
      }
      for (const id of ids) if (belongsToModelDirectory(id)) models.set(id, discoveredVertexModel(id));
    }
  }
  if (!catalogTables || !models.size) throw new Error("Google 官方模型生命周期文档未返回可读取的 Gemini 目录。");
  for (const id of retiredIds) models.delete(id);
  return { models: [...models.values()], retiredIds };
}

export function vertexPreviewDocumentUrls(html: string): URL[] {
  const root = article(html);
  const heading = root.querySelector("#preview-gemini-models");
  if (!heading) throw new Error("Google 官方模型文档缺少 Preview 模型分区。");
  const urls = new Map<string, URL>();
  for (let element = heading.nextElementSibling; element && !/^h[12]$/.test(element.localName); element = element.nextElementSibling) {
    for (const link of element.querySelectorAll("a[href]")) {
      let url: URL;
      try { url = new URL(link.getAttribute("href")!, GOOGLE_MODELS_URL); }
      catch { throw new Error("Google 官方 Preview 模型文档链接无效。"); }
      if (url.origin !== DOCS_ORIGIN || !GEMINI_DETAIL_PATH.test(url.pathname) || url.username || url.password) continue;
      url.hash = "";
      url.search = "?hl=en";
      urls.set(url.href, url);
    }
  }
  if (!urls.size) throw new Error("Google 官方 Preview 模型分区没有可读取的模型详情。");
  if (urls.size > MAX_PREVIEW_PAGES) throw new Error("Google 官方 Preview 模型详情页超过获取上限，未返回不完整目录。");
  return [...urls.values()];
}

export function parseVertexPreviewModels(html: string, now = new Date()): RawDiscoveredModel[] {
  const root = article(html);
  const fields = new Map<string, HTMLElement>();
  for (const row of root.querySelectorAll("table tr")) {
    const label = text([...row.querySelectorAll("th")].at(-1)).toLowerCase();
    const cell = row.querySelector("td");
    if (label && cell) fields.set(label, cell);
  }
  const identity = fields.get("model id");
  const versions = fields.get("versions");
  const ids = new Set([...(identity?.querySelectorAll("code") ?? [])].map((code) => modelId(text(code))).filter((id): id is string => Boolean(id)));
  if (!ids.size || !versions) throw new Error("Google 官方 Preview 模型详情缺少 Model ID 或 Versions。");
  const today = utcDay(now);
  const future = new Set<string>();
  let versionCount = 0;
  for (const code of versions.querySelectorAll("code")) {
    const id = modelId(text(code));
    if (!id) continue;
    versionCount++;
    const item = code.closest("li");
    const metadata = `${text(item)} ${item?.nextElementSibling?.localName === "ul" ? text(item.nextElementSibling) : ""}`;
    const release = documentDate(metadata.match(/Release date:\s*(.*)/i)?.[1] ?? "");
    if (release === undefined) throw new Error("Google 官方 Preview 模型详情缺少可读取的版本发布日期。");
    if (release > today) future.add(id);
    else ids.add(id);
  }
  if (!versionCount) throw new Error("Google 官方 Preview 模型详情缺少可读取的版本 ID。");
  const number = (field: string): number | undefined => {
    const value = text(fields.get(field)).match(/^([\d,]+)(?:\s|$)/)?.[1]?.replace(/,/g, "");
    return value && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
  };
  const contextWindow = number("context window");
  const maxTokens = number("maximum output tokens");
  return [...ids].filter((id) => !future.has(id) && belongsToModelDirectory(id)).map((id) => discoveredVertexModel(id, {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  }));
}

async function readDocument(url: URL, fetchPage: DocumentFetcher, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const response = await fetchPage(url, signal);
  if (!response.ok) throw new Error(`获取 Google 官方模型文档失败 (HTTP ${response.status})。`);
  if (!/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("content-type") ?? "")) {
    throw new Error("Google 官方模型文档未返回 HTML 页面。");
  }
  if (Number(response.headers.get("content-length")) > MAX_DOCUMENT_BYTES) throw new Error("Google 官方模型文档超过大小限制。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Google 官方模型文档内容为空。");
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        throw new Error("Google 官方模型文档超过大小限制。");
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, length).toString("utf8");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Refresh an anonymous published-model directory; it does not probe account permissions. */
export async function fetchVertexPublicModels(fetchPage: DocumentFetcher, callerSignal: AbortSignal): Promise<RawDiscoveredModel[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([callerSignal, controller.signal]);
  try {
    const [lifecycle, overview] = await Promise.all([
      readDocument(new URL(VERTEX_PUBLIC_CATALOG_URL), fetchPage, signal),
      readDocument(new URL(GOOGLE_MODELS_URL), fetchPage, signal),
    ]);
    const now = new Date();
    const parsed = parseVertexModelLifecycle(lifecycle, now);
    const urls = vertexPreviewDocumentUrls(overview);
    const models = new Map(parsed.models.map((model) => [model.id, model]));
    for (let index = 0; index < urls.length; index += 3) {
      const details = await Promise.all(urls.slice(index, index + 3).map(async (url) => parseVertexPreviewModels(await readDocument(url, fetchPage, signal), now)));
      for (const model of details.flat()) if (!parsed.retiredIds.has(model.id)) models.set(model.id, model);
    }
    if (!models.size || models.size > MAX_MODELS) throw new Error("Google 官方模型目录为空或超过获取上限。");
    return [...models.values()];
  } finally {
    controller.abort();
  }
}
