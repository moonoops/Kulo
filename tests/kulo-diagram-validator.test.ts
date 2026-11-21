import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_DIAGRAM_BRIDGE_SCRIPT,
  CANONICAL_DIAGRAM_BRIDGE_SCRIPT_SHA256,
  DIAGRAM_DEFAULT_DARK_VARS,
  HTML_DIAGRAM_BROWSER_CSP,
  HTML_DIAGRAM_CSP,
  diagramDisplayName,
  diagramTitleFromName,
  extractInlineSvgsFromHtml,
  htmlDiagramBrowserDocument,
  validateAndNormalizeDiagramSvg,
  wrapInlineDiagramDocument,
} from "@kulo/protocol";
import { buildStandaloneDiagramCheckerSource } from "../packages/hub/scripts/sync-diagram-checker.mjs";

const hubRequire = createRequire(new URL("../packages/hub/package.json", import.meta.url));
const { parseHTML } = hubRequire("linkedom") as { parseHTML: (html: string) => { document: Document } };

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

const VALID_SVG = `<svg viewBox="0 0 640 240">
  <defs>
    <marker id="arrow" viewBox="0 0 8 6" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="var(--d-muted)"/>
    </marker>
    <linearGradient id="accentGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="var(--d-accent-tint)"/>
      <stop offset="100%" stop-color="var(--d-paper)"/>
    </linearGradient>
    <clipPath id="boxClip"><rect x="40" y="80" width="140" height="56" rx="6"/></clipPath>
  </defs>
  <path d="M 180 108 L 280 108 Q 288 108 288 116 L 288 140 L 420 140" fill="none" stroke="var(--d-muted)" stroke-width="1.25" marker-end="url(#arrow)"/>
  <rect x="200" y="88" width="60" height="16" rx="2" fill="var(--d-paper)"/>
  <text x="230" y="100" text-anchor="middle" font-size="11" fill="var(--d-muted)">请求</text>
  <g transform="translate(40, 80)">
    <rect x="0" y="0" width="140" height="56" rx="6" fill="url(#accentGrad)" stroke="var(--d-accent)" stroke-width="1.5"/>
    <text x="70" y="24" text-anchor="middle" font-size="13" fill="var(--d-ink)">
      <tspan x="70" dy="0">客户端</tspan>
      <tspan x="70" dy="18">Web / Mac</tspan>
    </text>
  </g>
  <rect x="420" y="112" width="160" height="56" rx="6" fill="var(--d-paper)" stroke="var(--d-ink)" stroke-width="1"/>
  <text x="500" y="144" text-anchor="middle" font-size="13" fill="var(--d-ink)">核心服务</text>
</svg>`;

describe("diagram validator, CSP pinning, and standalone script parity", () => {
  it("computes exact Base64 SHA-256 matching node:crypto and locks CSP without unsafe-inline or allow-forms", () => {
    const expected = createHash("sha256").update(CANONICAL_DIAGRAM_BRIDGE_SCRIPT, "utf8").digest("base64");
    expect(CANONICAL_DIAGRAM_BRIDGE_SCRIPT_SHA256).toBe(expected);
    expect(HTML_DIAGRAM_CSP).toContain(`script-src 'sha256-${expected}'`);
    expect(HTML_DIAGRAM_CSP).toContain("sandbox allow-scripts");
    expect(HTML_DIAGRAM_CSP).not.toContain("allow-forms");
    expect(HTML_DIAGRAM_CSP).not.toContain("allow-same-origin");
    expect(HTML_DIAGRAM_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(HTML_DIAGRAM_BROWSER_CSP).toContain(`script-src 'sha256-${expected}'`);
    expect(HTML_DIAGRAM_BROWSER_CSP).toContain("frame-src about:");

    const wrapped = wrapInlineDiagramDocument({ title: "订单流程", svg: VALID_SVG, motion: "none" });
    expect(wrapped.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(wrapped).toContain(`<script>${CANONICAL_DIAGRAM_BRIDGE_SCRIPT}</script>`);
    expect(wrapped).not.toContain('<div class="kulo-diagram-controls"');

    const browserDoc = htmlDiagramBrowserDocument(wrapped, "订单流程.html");
    expect(browserDoc).toContain('sandbox="allow-scripts"');
    expect(browserDoc).not.toContain("allow-forms");
    expect(browserDoc).toContain("color-scheme:light dark");
  });

  it("preserves multilingual readable titles cleanly", () => {
    expect(diagramDisplayName("订单状态流转图")).toBe("订单状态流转图.html");
    expect(diagramDisplayName("系统架构/v2.html")).toBe("系统架构 v2.html");
    expect(diagramTitleFromName("订单状态流转图.html")).toBe("订单状态流转图");
    const longTitle = "甲".repeat(200);
    const display = diagramDisplayName(longTitle);
    expect(display.endsWith(".html")).toBe(true);
    expect(Array.from(display).length).toBeLessThanOrEqual(125);
  });

  it("blocks SVG HTML Integration Point mXSS, unsafe tags, CSS backslash escapes, and host selector hijacking", () => {
    const payloads = [
      // P0-1 mXSS via <svg><title><style><!--</style>...
      `<svg viewBox="0 0 320 200"><title><style><!--</style><a href="https://evil.example">x</a><img src="https://evil.example/x" onerror="alert(1)">--></style></title></svg>`,
      `<svg viewBox="0 0 320 200"><script>alert(1)</script></svg>`,
      `<svg viewBox="0 0 320 200"><foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>`,
      `<svg viewBox="0 0 320 200"><a href="https://evil.example"><rect x="10" y="10" width="80" height="40"/></a></svg>`,
      `<svg viewBox="0 0 320 200"><image href="https://evil.example/a.png" width="50" height="50"/></svg>`,
      `<svg viewBox="0 0 320 200"><rect x="10" y="10" width="80" height="40" onload="alert(1)"/></svg>`,
      `<svg viewBox="0 0 320 200"><style>@\\69mport "https://evil.example/a.css";</style></svg>`,
      `<svg viewBox="0 0 320 200"><style>body { display: none; }</style></svg>`,
      `<svg viewBox="0 0 320 200"><style>.x { fill: url(https://evil.example/x); }</style></svg>`,
      `<svg viewBox="0 0 320 200"><animate attributeName="x" from="0" to="100" dur="1s"/></svg>`,
    ];
    for (const payload of payloads) {
      const result = validateAndNormalizeDiagramSvg(payload, { allowGeometryWarnings: true });
      expect(result.ok, payload).toBe(false);
      expect(result.errors.some((e) => e.level === "L1"), payload).toBe(true);
    }
  });

  it("preserves camelCase SVG tags, normalizes xlink:href, and accepts Q/A rounded elbows and multiline tspans", () => {
    const withXlink = VALID_SVG.replace("</svg>", '<use xlink:href="#boxClip"/></svg>');
    const res = validateAndNormalizeDiagramSvg(withXlink, { title: "架构图", description: "客户端连接核心服务" });
    expect(res.ok).toBe(true);
    expect(res.svg).toContain("<linearGradient ");
    expect(res.svg).toContain("<clipPath ");
    expect(res.svg).toContain('href="#boxClip"');
    expect(res.svg).not.toContain("xlink:href");
    expect(res.svg).toContain('role="img"');
    expect(res.svg).toContain("<title id=");
    expect(res.svg).toContain("<desc id=");
    expect(res.width).toBe(640);
    expect(res.height).toBe(240);
  });

  it("silently auto-expands minor viewBox overflow (<=48px) and blocks severe clipping, mask occlusion, and severe text overflow", () => {
    const minorOverflow = `<svg viewBox="0 0 400 200"><rect x="330" y="60" width="90" height="60" rx="6" fill="var(--d-paper)" stroke="var(--d-ink)"/></svg>`;
    const fixed = validateAndNormalizeDiagramSvg(minorOverflow, { title: "轻微越界" });
    expect(fixed.ok).toBe(true);
    expect(fixed.autoFixed.length).toBeGreaterThan(0);
    expect(fixed.width).toBeGreaterThan(400);

    const severeOverflow = `<svg viewBox="0 0 400 200"><rect x="420" y="60" width="120" height="60" rx="6" fill="var(--d-paper)" stroke="var(--d-ink)"/></svg>`;
    const clipped = validateAndNormalizeDiagramSvg(severeOverflow);
    expect(clipped.ok).toBe(false);
    expect(clipped.errors.some((e) => e.code === "viewbox_overflow")).toBe(true);

    const occludedMask = `<svg viewBox="0 0 400 200">
      <rect x="110" y="70" width="60" height="16" fill="var(--d-paper)"/>
      <rect x="120" y="50" width="120" height="60" rx="6" fill="var(--d-paper)" stroke="var(--d-ink)"/>
    </svg>`;
    const masked = validateAndNormalizeDiagramSvg(occludedMask);
    expect(masked.ok).toBe(false);
    expect(masked.errors.some((e) => e.code === "mask_clipped_by_later_node")).toBe(true);

    const overflowText = `<svg viewBox="0 0 400 200">
      <rect x="40" y="60" width="80" height="56" rx="6" fill="var(--d-paper)" stroke="var(--d-ink)"/>
      <text x="80" y="92" text-anchor="middle" font-size="14" fill="var(--d-ink)">这是一段超级长的节点标题文字肯定溢出</text>
    </svg>`;
    const textRes = validateAndNormalizeDiagramSvg(overflowText);
    expect(textRes.ok).toBe(false);
    expect(textRes.errors.some((e) => e.code === "text_overflow_node")).toBe(true);

    // allowGeometryWarnings lets non-fatal L2 pass while L1 still blocks
    expect(validateAndNormalizeDiagramSvg(overflowText, { allowGeometryWarnings: true }).ok).toBe(true);
  });

  it("keeps standalone Worker check-diagram.mjs synced, dependency-free, and working on multi-SVG HTML reports", () => {
    const compiled = fs.readFileSync(path.resolve("packages/protocol/dist/diagram-validator.js"), "utf8");
    const scriptPath = path.resolve("packages/hub/skills/diagram-design/scripts/check-diagram.mjs");
    const actual = fs.readFileSync(scriptPath, "utf8");
    expect(actual).toBe(buildStandaloneDiagramCheckerSource(compiled));
    expect(actual).not.toMatch(/from\s+["'](?!node:)/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-check-diagram-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const reportPath = path.join(dir, "report.html");
    const html = `<!doctype html><html><body><section>${VALID_SVG}</section></body></html>`;
    expect(extractInlineSvgsFromHtml(html)).toHaveLength(1);
    fs.writeFileSync(reportPath, html, "utf8");

    const stdout = execFileSync(process.execPath, [scriptPath, "--strict", reportPath], { encoding: "utf8" });
    const parsed = JSON.parse(stdout) as { ok: boolean; results: Array<{ svgCount: number; ok: boolean }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.results[0]!.svgCount).toBe(1);
    expect(parsed.results[0]!.ok).toBe(true);
  });

  it("normalizes shorthand data-step markers and executes canonical bridge step playback, live theme sync, and reduced-motion fallback", () => {
    const stepSvg = `<svg viewBox="0 0 600 180">
      <g data-step="1"><rect x="20" y="50" width="140" height="60" rx="6" fill="var(--d-accent-tint)" stroke="var(--d-accent)"/></g>
      <g data-step="2"><rect x="220" y="50" width="140" height="60" rx="6" fill="var(--d-paper)" stroke="var(--d-ink)"/></g>
      <g data-step="3"><rect x="420" y="50" width="140" height="60" rx="6" fill="var(--d-paper-2)" stroke="var(--d-success)"/></g>
    </svg>`;
    const validated = validateAndNormalizeDiagramSvg(stepSvg, { title: "分步演示", motion: "step" });
    expect(validated.ok).toBe(true);
    expect(validated.stats.motionItems).toBe(3);
    expect(validated.svg).toContain('data-motion-item="true"');

    const wrapped = wrapInlineDiagramDocument({ title: "分步演示", svg: validated.svg!, motion: "step" });
    const { document } = parseHTML(wrapped);
    const root = document.getElementById("kulo-diagram-root")!;
    root.getBoundingClientRect = () => ({ height: 240, width: 600, top: 0, left: 0, right: 600, bottom: 240, x: 0, y: 0, toJSON() { return {}; } });

    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    const posted: unknown[] = [];
    const parentWin = { postMessage: (msg: unknown) => posted.push(msg) };
    const win = {
      parent: parentWin,
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
    };
    const ctx = vm.createContext({
      window: win,
      document,
      requestAnimationFrame: (fn: () => void) => fn(),
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(CANONICAL_DIAGRAM_BRIDGE_SCRIPT, ctx);

    const status = root.querySelector("[data-motion-status]")!;
    const controls = root.querySelector("[data-motion-controls]") as HTMLElement;
    const items = Array.from(root.querySelectorAll("[data-motion-item]"));
    const prevBtn = controls.querySelector('[data-motion-action="prev"]') as HTMLButtonElement;
    const nextBtn = controls.querySelector('[data-motion-action="next"]') as HTMLButtonElement;

    expect(status.textContent).toBe("第 3 / 3 步");
    expect(nextBtn.disabled).toBe(true);
    expect(items.map((el) => el.getAttribute("data-motion-visible"))).toEqual(["true", "true", "true"]);

    // Click Prev twice -> step 1/3, then Next once -> step 2/3
    prevBtn.click();
    prevBtn.click();
    expect(status.textContent).toBe("第 1 / 3 步");
    expect(items.map((el) => el.getAttribute("data-motion-visible"))).toEqual(["true", "false", "false"]);
    nextBtn.click();
    expect(status.textContent).toBe("第 2 / 3 步");
    expect(items.map((el) => el.getAttribute("data-motion-visible"))).toEqual(["true", "true", "false"]);

    // Live theme + locale switch via postMessage keeps current step 2/3 without reload
    const emitMessage = (data: unknown) => {
      for (const fn of listeners.get("message") ?? []) fn({ source: parentWin, data });
    };
    emitMessage({
      type: "kulo:diagram-theme",
      theme: "dark",
      reduceMotion: false,
      expanded: false,
      locale: "en",
      vars: DIAGRAM_DEFAULT_DARK_VARS,
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--d-paper")).toBe(DIAGRAM_DEFAULT_DARK_VARS["--d-paper"]);
    expect(status.textContent).toBe("Step 2 / 3");
    expect(prevBtn.textContent).toBe("Prev");
    expect(items.map((el) => el.getAttribute("data-motion-visible"))).toEqual(["true", "true", "false"]);

    // Reduced motion hides playback controls and renders complete static frame (all visible)
    emitMessage({
      type: "kulo:diagram-theme",
      theme: "dark",
      reduceMotion: true,
      expanded: false,
      locale: "zh",
      vars: DIAGRAM_DEFAULT_DARK_VARS,
    });
    expect(document.documentElement.dataset.reduceMotion).toBe("true");
    expect(controls.hidden).toBe(true);
    expect(root.classList.contains("motion-ready")).toBe(false);
    expect(items.map((el) => el.getAttribute("data-motion-visible"))).toEqual(["true", "true", "true"]);

    // Turning reduced motion off restores controls
    emitMessage({
      type: "kulo:diagram-theme",
      theme: "light",
      reduceMotion: false,
      expanded: false,
      locale: "zh",
      vars: DIAGRAM_DEFAULT_DARK_VARS,
    });
    expect(controls.hidden).toBe(false);
    expect(root.classList.contains("motion-ready")).toBe(true);
    expect(posted.some((m) => typeof m === "object" && m !== null && (m as { type?: string }).type === "kulo:diagram-ready")).toBe(true);
  });
});
