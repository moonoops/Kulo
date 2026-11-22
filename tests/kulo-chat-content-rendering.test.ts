import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chatContentCss = fs.readFileSync(path.join(repoRoot, "packages/web/src/features/chat/chat-content.css"), "utf8");
const messageSourcesCss = fs.readFileSync(path.join(repoRoot, "packages/web/src/features/chat/message-sources.css"), "utf8");

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? "";
}

function auditProseLinkContrast(css: string): string[] {
  const block = extractBlock(css, ".kulo-chat-prose-link");
  const violations: string[] = [];
  if (!block) return ["missing .kulo-chat-prose-link rule"];
  if (!/text-decoration(?:-line)?\s*:\s*[^;]*underline/.test(block)) {
    violations.push(".kulo-chat-prose-link must declare a static underline so links are distinguishable from prose without hover");
  }
  if (/text-decoration(?:-line)?\s*:\s*none/.test(block)) {
    violations.push(".kulo-chat-prose-link must not hide underline at rest");
  }
  if (!/color\s*:\s*var\(--accent-soft-foreground\)/.test(block)) {
    violations.push(".kulo-chat-prose-link must use semantic var(--accent-soft-foreground) instead of inheriting foreground");
  }
  return violations;
}

function auditSemanticColorsOnly(css: string, selectors: readonly string[]): string[] {
  const violations: string[] = [];
  for (const selector of selectors) {
    const block = extractBlock(css, selector);
    if (!block) {
      violations.push(`missing ${selector} rule`);
      continue;
    }
    if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i.test(block)) {
      violations.push(`${selector} must derive colors from HeroUI semantic CSS variables instead of hardcoded color literals`);
    }
  }
  return violations;
}

describe("conversation prose, citation, and sources rendering contract", () => {
  it("keeps ordinary prose links statically distinguishable with semantic color and underline", () => {
    expect(auditProseLinkContrast(chatContentCss)).toEqual([]);
    // Negative cases verify regressions back to invisible HeroUI default links fail
    expect(auditProseLinkContrast(".kulo-chat-prose-link { display: inline; font-size: inherit; }")).toHaveLength(2);
    expect(auditProseLinkContrast(".kulo-chat-prose-link { color: var(--foreground); text-decoration: none; }")).toHaveLength(3);
  });

  it("uses only HeroUI semantic tokens for Scheme A citations, tooltips, and collapsed sources", () => {
    expect(auditSemanticColorsOnly(chatContentCss, [
      ".kulo-chat-prose-link",
      ".kulo-chat-citation",
      ".kulo-chat-citation-tooltip",
    ])).toEqual([]);
    expect(auditSemanticColorsOnly(messageSourcesCss, [
      ".kulo-message-sources",
      ".kulo-message-sources-trigger",
      ".kulo-message-source-link",
      ".kulo-message-source-index",
    ])).toEqual([]);
    // Negative case verifies hardcoded hex colors are rejected
    expect(auditSemanticColorsOnly(".kulo-chat-citation { background: #232323; color: #a8a8a8; }", [".kulo-chat-citation"])).toHaveLength(1);
  });

  it("preserves top separator, coarse-pointer 44px touch targets, and reduced-motion rules for sources", () => {
    expect(extractBlock(messageSourcesCss, ".kulo-message-sources")).toMatch(/border-top\s*:\s*1px\s+solid\s+var\(--separator\)/);
    expect(messageSourcesCss).toMatch(/@media\s*\(pointer:\s*coarse\)[\s\S]*\.kulo-message-sources-trigger[\s\S]*\.kulo-message-source-link[\s\S]*min-height:\s*44px/);
    expect(messageSourcesCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*transition:\s*none/);
  });
});
