import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSource = path.join(repoRoot, "packages/web/src");
const appCss = fs.readFileSync(path.join(webSource, "kulo.css"), "utf8");
const focusCss = fs.readFileSync(path.join(webSource, "kulo-focus.css"), "utf8");

function themeVariables(css: string, theme: string): Record<string, string> {
  const block = css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`Missing ${theme} theme`);
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function resolveColor(variables: Record<string, string>, token: string): string {
  const value = variables[token];
  const reference = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (reference) return resolveColor(variables, reference);
  if (!/^#[\da-f]{6}$/i.test(value ?? "")) throw new Error(`Unsupported color for ${token}: ${value}`);
  return value;
}

function channels(hex: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function luminance(hex: string): number {
  const linear = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(file);
    return /\.(css|tsx)$/.test(file) && !/\.(test|spec)\.tsx$/.test(file) ? [file] : [];
  });
}

describe("shared neutral focus appearance", () => {
  it("loads the focus contract after HeroUI so it also reaches Portals", () => {
    expect(appCss.indexOf('@import "./kulo-focus.css";')).toBeGreaterThan(appCss.indexOf('@import "@heroui/styles";'));
    expect(focusCss).toContain(".kulo-ui ");
  });

  it.each(["light", "dark"])("keeps %s focus neutral and distinguishable against application surfaces", (theme) => {
    const variables = { ...themeVariables(appCss, theme), ...themeVariables(focusCss, theme) };
    const focus = resolveColor(variables, "--focus");
    expect(new Set(channels(focus)).size).toBe(1);
    for (const surface of ["--background", "--surface", "--surface-secondary", "--surface-tertiary", "--overlay", "--default", "--segment"]) {
      const light = [luminance(focus), luminance(resolveColor(variables, surface))].sort((a, b) => b - a);
      expect((light[0] + 0.05) / (light[1] + 0.05), `${theme} focus against ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps production focus colors on the shared token rather than a local accent override", () => {
    const violations = productionFiles(webSource).flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      const violations: string[] = [];
      if (/\bfocus(?:-visible|-within)?:(?:outline|ring|border)-(?:accent|(?:blue|sky|cyan|indigo)-\d+)\b/.test(source)) {
        violations.push(`${path.relative(repoRoot, file)}: colored focus utility`);
      }
      if (file !== path.join(webSource, "kulo-focus.css") && /--focus\s*:/.test(source)) {
        violations.push(`${path.relative(repoRoot, file)}: local focus token override`);
      }
      return violations;
    });
    expect(violations).toEqual([]);
  });
});
