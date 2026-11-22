import {
  DIAGRAM_DEFAULT_DARK_VARS,
  DIAGRAM_DEFAULT_LIGHT_VARS,
  extractInlineSvgsFromHtml,
  type DiagramSemanticTokenName,
} from "@kulo/protocol";

const SRGB_COLOR_RE = /^(?:#[0-9a-f]{6}|rgba?\(\d{1,3},\s*\d{1,3},\s*\d{1,3}(?:,\s*(?:0|1|0?\.\d+))?\))$/i;

let colorCtx: CanvasRenderingContext2D | null | undefined;

function getColorContext(): CanvasRenderingContext2D | null {
  if (colorCtx !== undefined) return colorCtx;
  if (typeof document === "undefined") { colorCtx = null; return null; }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorCtx = canvas.getContext("2d", { willReadFrequently: true });
  } catch {
    colorCtx = null;
  }
  return colorCtx;
}

/** Normalize any browser CSS color (including oklch() / color-mix()) to strict sRGB #rrggbb or rgba(...). */
export function resolveCssColorToSrgb(rawValue: string | undefined | null, fallback: string): string {
  const trimmed = rawValue?.trim() ?? "";
  if (!trimmed) return fallback;
  if (SRGB_COLOR_RE.test(trimmed)) return trimmed;
  const ctx = getColorContext();
  if (!ctx) return fallback;
  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = trimmed;
    const serialized = ctx.fillStyle;
    if (typeof serialized === "string" && SRGB_COLOR_RE.test(serialized)) {
      return serialized;
    }
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    const r = data[0] ?? 0, g = data[1] ?? 0, b = data[2] ?? 0, a = (data[3] ?? 255) / 255;
    if (a >= 0.996) {
      return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    }
    return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  } catch {
    return fallback;
  }
}

function hexOrRgbWithAlpha(srgb: string, alpha: number, fallback: string): string {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(srgb);
  if (hex) {
    return `rgba(${parseInt(hex[1]!, 16)}, ${parseInt(hex[2]!, 16)}, ${parseInt(hex[3]!, 16)}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(srgb);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  }
  return fallback;
}

/** Read current Kulo HeroUI / custom appearance tokens from <html> and map them to normalized sRGB --d-* vars. */
export function readHostDiagramThemeVars(mode: "light" | "dark"): Record<DiagramSemanticTokenName, string> {
  const defaults = mode === "dark" ? DIAGRAM_DEFAULT_DARK_VARS : DIAGRAM_DEFAULT_LIGHT_VARS;
  if (typeof window === "undefined" || typeof document === "undefined" || !window.getComputedStyle) {
    return { ...defaults };
  }
  const style = window.getComputedStyle(document.documentElement);
  const read = (prop: string, fallback: string) => resolveCssColorToSrgb(style.getPropertyValue(prop), fallback);

  const paper = read("--surface-secondary", defaults["--d-paper"]);
  const paper2 = read("--surface", defaults["--d-paper-2"]);
  const ink = read("--foreground", defaults["--d-ink"]);
  const muted = read("--muted", defaults["--d-muted"]);
  const ruleSolid = read("--border", defaults["--d-rule-solid"]);
  const accent = read("--accent", defaults["--d-accent"]);
  const success = read("--success", defaults["--d-success"]);
  const warning = read("--warning", defaults["--d-warning"]);
  const danger = read("--danger", defaults["--d-danger"]);

  return {
    "--d-paper": paper,
    "--d-paper-2": paper2,
    "--d-ink": ink,
    "--d-muted": muted,
    "--d-soft": hexOrRgbWithAlpha(muted, mode === "dark" ? 0.84 : 0.78, defaults["--d-soft"]),
    "--d-rule": hexOrRgbWithAlpha(ink, mode === "dark" ? 0.16 : 0.13, defaults["--d-rule"]),
    "--d-rule-solid": ruleSolid,
    "--d-accent": accent,
    "--d-accent-tint": hexOrRgbWithAlpha(accent, mode === "dark" ? 0.15 : 0.1, defaults["--d-accent-tint"]),
    "--d-link": accent,
    "--d-success": success,
    "--d-warning": warning,
    "--d-danger": danger,
  };
}

function parseSvgViewBox(svg: string): [number, number, number, number] {
  const match = /\bviewBox\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(svg);
  const raw = match?.[1] ?? match?.[2];
  if (raw) {
    const nums = raw.trim().split(/[\s,]+/).map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite) && nums[2]! > 0 && nums[3]! > 0) {
      return nums as [number, number, number, number];
    }
  }
  return [0, 0, 960, 540];
}

function resolveDiagramCssVars(svg: string, vars: Record<DiagramSemanticTokenName, string>): string {
  return svg.replace(/var\(\s*(--d-[a-z0-9-]+)(?:\s*,\s*([^)]+))?\s*\)/gi, (_m, name: string, fallback?: string) => {
    const key = name.toLowerCase() as DiagramSemanticTokenName;
    if (Object.hasOwn(vars, key)) return vars[key];
    return fallback?.trim() || "currentColor";
  });
}

function safeDownloadBaseName(title: string): string {
  const clean = title.replace(/[/\\\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, 100).join("").trim() || "diagram";
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Materialize a standalone XML-valid SVG with resolved sRGB colors, non-zero viewBox background rect,
 * and explicit pixel dimensions for crisp SVG/PNG export across Chromium, Safari, Firefox, and Electron.
 */
export function materializeStandaloneDiagramSvg(
  htmlDocument: string,
  vars: Record<DiagramSemanticTokenName, string>,
  options: { pixelScale?: number } = {},
): { svg: string; width: number; height: number } {
  const extracted = extractInlineSvgsFromHtml(htmlDocument)[0];
  if (!extracted) throw new Error("未找到可导出的图示内容。");
  const [minX, minY, vbW, vbH] = parseSvgViewBox(extracted);
  const scale = options.pixelScale ?? 1;
  const outW = Math.max(1, Math.round(vbW * scale));
  const outH = Math.max(1, Math.round(vbH * scale));

  let resolved = resolveDiagramCssVars(extracted, vars)
    .replace(/\bdata-motion-visible\s*=\s*(?:"false"|'false')/gi, 'data-motion-visible="true"');

  // Ensure root <svg> has xmlns and explicit width/height attributes for XML & Firefox/WebKit image rasterization.
  resolved = resolved.replace(/<svg\b([^>]*)>/i, (_full, rawAttrs: string) => {
    let attrs = rawAttrs
      .replace(/\s+\bwidth\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
      .replace(/\s+\bheight\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
    if (!/\bxmlns\s*=/i.test(attrs)) attrs += ' xmlns="http://www.w3.org/2000/svg"';
    return `<svg${attrs} width="${outW}" height="${outH}">`;
  });

  // Inject an opaque background covering the exact viewBox (including non-zero minX/minY) right after leading title/desc.
  const bgRect = `<rect x="${minX}" y="${minY}" width="${vbW}" height="${vbH}" fill="${vars["--d-paper"]}"/>`;
  const leadMeta = /^(<svg\b[^>]*>(?:\s*<title\b[^>]*>[\s\S]*?<\/title>)?(?:\s*<desc\b[^>]*>[\s\S]*?<\/desc>)?)/i;
  if (leadMeta.test(resolved)) {
    resolved = resolved.replace(leadMeta, `$1${bgRect}`);
  } else {
    resolved = resolved.replace(/<svg\b[^>]*>/i, (open) => `${open}${bgRect}`);
  }

  return { svg: resolved, width: outW, height: outH };
}

export function exportDiagramAsSvg(htmlDocument: string, title: string, vars: Record<DiagramSemanticTokenName, string>): void {
  const { svg } = materializeStandaloneDiagramSvg(htmlDocument, vars, { pixelScale: 1 });
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  triggerBlobDownload(blob, `${safeDownloadBaseName(title)}.svg`);
}

export async function exportDiagramAsPng(htmlDocument: string, title: string, vars: Record<DiagramSemanticTokenName, string>): Promise<void> {
  const extracted = extractInlineSvgsFromHtml(htmlDocument)[0];
  if (!extracted) throw new Error("未找到可导出的图示内容。");
  const [, , vbW, vbH] = parseSvgViewBox(extracted);
  const scale = Math.min(2, 4096 / Math.max(vbW, vbH, 1));
  const { svg, width, height } = materializeStandaloneDiagramSvg(htmlDocument, vars, { pixelScale: scale });

  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片生成失败，请改用「存为矢量图」。"));
      image.src = svgUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前环境无法生成图片，请改用「存为矢量图」。");
    ctx.fillStyle = vars["--d-paper"];
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("图片导出失败，请改用「存为矢量图」。"));
      }, "image/png");
    });
    triggerBlobDownload(pngBlob, `${safeDownloadBaseName(title)}.png`);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
