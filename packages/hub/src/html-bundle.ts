import path from "node:path";
import { parse } from "acorn";
import { parseHTML } from "linkedom";
import { MAX_UPLOAD_BYTES, normalizeUploadMimeType } from "./uploads.js";
import { UiCardError } from "./ui-cards.js";

const MAX_RESOURCES = 64;
const MAX_CSS_DEPTH = 8;
const EXTRA_MIMES: Record<string, string> = { ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".ico": "image/x-icon", ".avif": "image/avif", ".bmp": "image/bmp" };

function invalid(message: string): never {
  throw new UiCardError("html_artifact_unavailable", message, 400);
}

function checkScriptDependencies(source: string, module: boolean): void {
  let program: ReturnType<typeof parse>;
  try { program = parse(source, { ecmaVersion: "latest", sourceType: module ? "module" : "script" }); }
  catch (error) {
    if (error instanceof SyntaxError) invalid("HTML 的脚本语法无效，请先修正脚本后再交付。");
    throw error;
  }
  const pending: unknown[] = [program];
  while (pending.length) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (Array.isArray(candidate)) { for (const child of candidate) pending.push(child); continue; }
    const node = candidate as Record<string, unknown>;
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression" ||
        (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source != null) {
      invalid(module ? "HTML 的模块脚本包含导入或重新导出，请先将脚本打包为独立文件。" : "HTML 的脚本包含模块导入，请先将脚本打包为独立文件。");
    }
    pending.push(...Object.values(node));
  }
}

function localReference(value: string): boolean {
  const reference = value.trim();
  if (/^(?:file|filesystem):/i.test(reference)) invalid("HTML 不能依赖本机文件地址，请使用工作区内的相对资源。");
  if (!reference || reference.startsWith("#") || /^data:/i.test(reference)) return false;
  if (reference.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(reference)) {
    invalid("HTML 依赖外部或临时资源，请将脚本、样式和媒体嵌入后重新生成。");
  }
  return true;
}

/** Every read is supplied by the publisher's checked execution-node reader. */
export async function bundleHtmlArtifact(
  bytes: Buffer,
  documentPath: string,
  read: (absolutePath: string, maximumBytes: number) => Promise<Buffer>,
): Promise<Buffer> {
  const source = bytes.toString("utf8");
  const { document } = parseHTML(source);
  const implementation = /^[a-z]:[\\/]/i.test(documentPath) ? path.win32 : path.posix;
  const cache = new Map<string, Buffer>();
  let totalBytes = bytes.length;
  let changed = false;

  const resolve = (reference: string, parent: string): { absolute: string; fragment: string } => {
    const fragmentAt = reference.indexOf("#");
    const fragment = fragmentAt < 0 ? "" : reference.slice(fragmentAt);
    const pathname = (fragmentAt < 0 ? reference : reference.slice(0, fragmentAt)).split("?", 1)[0]!;
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); }
    catch { invalid("HTML 资源地址编码无效。"); }
    if (!decoded || /[\x00-\x1f\x7f\\]/.test(decoded)) invalid("HTML 资源地址无效。");
    return { absolute: implementation.resolve(implementation.dirname(parent), decoded), fragment };
  };

  const load = async (absolute: string) => {
    const prior = cache.get(absolute);
    if (prior) return prior;
    if (cache.size >= MAX_RESOURCES) invalid(`HTML 最多支持 ${MAX_RESOURCES} 个本地依赖，请先合并资源。`);
    const remaining = MAX_UPLOAD_BYTES - totalBytes;
    if (remaining < 1) invalid("HTML 及其依赖总量不能超过 25 MiB。");
    const content = await read(absolute, remaining);
    totalBytes += content.length;
    if (totalBytes > MAX_UPLOAD_BYTES) invalid("HTML 及其依赖总量不能超过 25 MiB。");
    cache.set(absolute, content);
    return content;
  };

  const resource = async (reference: string, parent: string, kind?: "css" | "script", stack: string[] = []): Promise<string> => {
    if (!localReference(reference)) return reference;
    const { absolute, fragment } = resolve(reference.trim(), parent);
    if (stack.includes(absolute) || stack.length >= MAX_CSS_DEPTH) invalid("HTML 样式依赖循环或嵌套过深，请先合并样式。");
    let content = await load(absolute);
    let mimeType = EXTRA_MIMES[implementation.extname(absolute).toLowerCase()] ?? normalizeUploadMimeType(undefined, absolute);
    if (kind === "css") {
      content = Buffer.from(await stylesheet(content.toString("utf8"), absolute, [...stack, absolute]));
      mimeType = "text/css";
    }
    if (kind === "script") {
      mimeType = "text/javascript";
    }
    changed = true;
    return `data:${mimeType};base64,${content.toString("base64")}${fragment}`;
  };

  async function replaceAsync(value: string, expression: RegExp, replace: (match: RegExpExecArray) => Promise<string>): Promise<string> {
    // CSS strings and comments can describe URLs without loading a resource.
    const ignored: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < value.length; index++) {
      const character = value[index];
      if (character === "/" && value[index + 1] === "*") {
        const end = value.indexOf("*/", index + 2);
        ignored.push({ start: index, end: end < 0 ? value.length : end + 2 });
        index = (end < 0 ? value.length : end + 2) - 1;
      } else if (character === '"' || character === "'") {
        const start = index++;
        while (index < value.length && value[index] !== character) { if (value[index] === "\\") index++; index++; }
        ignored.push({ start, end: index + 1 });
      }
    }
    const matches = [...value.matchAll(expression)];
    let result = "";
    let end = 0;
    let ignoredIndex = 0;
    for (const match of matches) {
      while (ignored[ignoredIndex] && ignored[ignoredIndex]!.end <= match.index!) ignoredIndex++;
      if (ignored[ignoredIndex] && ignored[ignoredIndex]!.start <= match.index!) continue;
      result += value.slice(end, match.index) + await replace(match);
      end = match.index! + match[0].length;
    }
    return result + value.slice(end);
  }

  async function stylesheet(value: string, parent: string, stack: string[]): Promise<string> {
    const imported = await replaceAsync(value, /@import\s+(["'])([^"']+)\1([^;]*);/gi, async (match) =>
      `@import url("${await resource(match[2]!, parent, "css", stack)}")${match[3]};`);
    return replaceAsync(imported, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi, async (match) => {
      const reference = match[1] ?? match[2] ?? match[3]!;
      const before = imported.slice(Math.max(0, match.index! - 20), match.index);
      const kind = /@import\s*$/i.test(before) ? "css" : undefined;
      return `url("${await resource(reference, parent, kind, stack)}")`;
    });
  }

  for (const base of document.querySelectorAll("base[href]")) {
    if (base.getAttribute("href")?.trim()) invalid("HTML 包含 base 地址，请先改为相对于页面文件的资源路径。");
  }
  for (const script of document.querySelectorAll("script")) {
    const sourceUrl = script.getAttribute("src");
    const type = (script.getAttribute("type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    const module = type === "module";
    const executable = !type || module || /^(?:text|application)\/(?:java|ecma)script$/.test(type);
    if (sourceUrl && localReference(sourceUrl)) {
      const { absolute } = resolve(sourceUrl, documentPath);
      const scriptBytes = await load(absolute);
      if (executable) checkScriptDependencies(scriptBytes.toString("utf8"), module);
      script.setAttribute("src", await resource(sourceUrl, documentPath, executable ? "script" : undefined));
      script.removeAttribute("integrity");
    } else if (!sourceUrl && executable) checkScriptDependencies(script.textContent ?? "", module);
  }
  for (const link of document.querySelectorAll("link[href]")) {
    const reference = link.getAttribute("href")!;
    const rel: string[] = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.some((value: string) => ["stylesheet", "icon", "preload", "modulepreload"].includes(value))) continue;
    if (!localReference(reference)) continue;
    if (rel.includes("modulepreload")) invalid("HTML 包含模块预加载，请先将脚本打包为独立文件。");
    link.setAttribute("href", await resource(reference, documentPath, rel.includes("stylesheet") ? "css" : undefined));
    link.removeAttribute("integrity");
  }
  for (const style of document.querySelectorAll("style")) {
    const original = style.textContent ?? "";
    const updated = await stylesheet(original, documentPath, []);
    if (updated !== original) style.textContent = updated;
  }
  for (const element of document.querySelectorAll("[style]")) {
    const original = element.getAttribute("style")!;
    const updated = await stylesheet(original, documentPath, []);
    if (updated !== original) element.setAttribute("style", updated);
  }
  const attributes: Array<[string, string]> = [["img[src],source[src],video[src],audio[src],track[src],input[type=image][src]", "src"], ["video[poster]", "poster"], ["image[href]", "href"], ["image[xlink\\:href]", "xlink:href"]];
  for (const [selector, attribute] of attributes) {
    for (const element of document.querySelectorAll(selector)) {
      const original = element.getAttribute(attribute)!;
      const updated = await resource(original, documentPath);
      if (updated !== original) element.setAttribute(attribute, updated);
    }
  }
  for (const element of document.querySelectorAll("img[srcset],source[srcset]")) {
    const original = element.getAttribute("srcset")!;
    const candidates: string[] = [];
    let remaining = original;
    while (remaining.trim()) {
      remaining = remaining.replace(/^[\s,]+/, "");
      if (!remaining) break;
      const match = /^(\S+)([\s\S]*)$/.exec(remaining)!;
      const url = match[1]!;
      remaining = match[2]!;
      if (url.endsWith(",")) { candidates.push(await resource(url.replace(/,+$/, ""), documentPath)); continue; }
      const separator = remaining.indexOf(",");
      const descriptor = (separator < 0 ? remaining : remaining.slice(0, separator)).trim();
      remaining = separator < 0 ? "" : remaining.slice(separator + 1);
      candidates.push(`${await resource(url, documentPath)}${descriptor ? ` ${descriptor}` : ""}`);
    }
    const updated = candidates.join(", ");
    if (updated !== original && changed) element.setAttribute("srcset", updated);
  }
  if (!changed) return bytes;
  const result = Buffer.from(document.toString());
  if (result.length > MAX_UPLOAD_BYTES) invalid("HTML 打包后超过 25 MiB，请压缩或减少依赖资源。");
  return result;
}
