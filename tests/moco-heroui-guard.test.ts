import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseAppearance,
  resolveMode,
  CHAT_FONT_SIZE,
  CHAT_FONT_SIZE_OPTIONS,
} from "../packages/web/src/moco-appearance";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrcDir = path.join(repoRoot, "packages/web/src");

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("HeroUI v3 Zero-Residue & Default Light/Dark Guard", () => {
  it("1. ensures retired Material Design files and forbidden tokens/selectors do not exist in packages/web/src", () => {
    expect(fs.existsSync(path.join(webSrcDir, "moco-tokens.css"))).toBe(false);
    expect(fs.existsSync(path.join(webSrcDir, "moco-motion.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(webSrcDir, "moco-expressive.tsx"))).toBe(false);

    const forbiddenPattern =
      /--md-sys-|--md-ref-|moco-expressive|moco-motion|moco-tokens|mc-m3|data-moco-style|MocoStyle|墨韵|素墨|HeroUIProvider|@heroui\/theme|\[data-slot="button"\]/;

    const files = collectFiles(webSrcDir).filter(
      (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
    );
    expect(files.length).toBeGreaterThan(5);

    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      const match = forbiddenPattern.exec(content);
      if (match) {
        violations.push(`${path.relative(repoRoot, file)}: matched '${match[0]}'`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("2. parses legacy moco:appearance storage backward-compatibly into Default Light/Dark mode only", () => {
    expect(parseAppearance(JSON.stringify({ style: "a", mode: "light" }))).toEqual({
      mode: "light",
      chatFontSize: 14,
    });
    expect(parseAppearance(JSON.stringify({ style: "c", mode: "system" }))).toEqual({
      mode: "system",
      chatFontSize: 14,
    });
    expect(parseAppearance("light")).toEqual({ mode: "light", chatFontSize: 14 });
    expect(parseAppearance("invalid-json{")).toEqual({ mode: "system", chatFontSize: 14 });

    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });

  it("restores valid saved chat font sizes together with the selected theme", () => {
    for (const { value: chatFontSize } of CHAT_FONT_SIZE_OPTIONS) {
      const appearance = { mode: "light", chatFontSize };
      expect(parseAppearance(JSON.stringify(appearance))).toEqual(appearance);
    }
    expect(parseAppearance({ mode: "system", chatFontSize: 17 })).toEqual({ mode: "system", chatFontSize: 17 });
  });

  it("uses the compact medium size for new and formerly default preferences", () => {
    expect(parseAppearance(undefined)).toEqual({ mode: "system", chatFontSize: 14 });
    expect(parseAppearance(JSON.stringify({ mode: "light", chatFontSize: 15 }))).toEqual({ mode: "light", chatFontSize: 14 });
  });

  it.each([[12, 13], [16, 17], [18, 17], [19, 20]])("maps former slider size %s to preset %s", (previous, next) => {
    expect(parseAppearance({ mode: "light", chatFontSize: previous })).toEqual({ mode: "light", chatFontSize: next });
  });

  it.each([undefined, null, "18", 0, 11, 21, 15.5, NaN, Infinity, {}, []])("uses the default for an invalid saved chat font size: %s", (chatFontSize) => {
    expect(parseAppearance({ mode: "light", chatFontSize })).toEqual({ mode: "light", chatFontSize: CHAT_FONT_SIZE.default });
  });
});
