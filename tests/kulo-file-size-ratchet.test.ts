import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCAN_ROOTS = ["packages", "integrations"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".py"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "release",
  ".venv",
  "__pycache__",
  "__tests__",
  "fixtures",
]);

/** Maximum lines allowed for any new or currently small source file. */
const NEW_FILE_MAX_LINES = 900;

/**
 * Legacy large-file ratchet ceilings (exact `wc -l` line counts).
 * Files listed here may never grow above their ceiling; when refactored below
 * their ceiling, run `KULO_TIGHTEN_RATCHET=1 pnpm test tests/kulo-file-size-ratchet.test.ts`
 * to permanently tighten the baseline (or delete the entry once <= 900 lines).
 */
const LEGACY_FILE_LINE_CEILINGS: Record<string, number> = {
  "packages/hub/src/hub.ts": 7600,
  "packages/protocol/src/android.ts": 3886,
  "packages/env/src/bridge.ts": 2630,
  "packages/hub/src/server.ts": 2266,
  "packages/hub/src/settings-assistant.ts": 2213,
  "packages/web/src/App.tsx": 2074,
  "packages/hub/src/providers.ts": 1951,
  "packages/hub/src/settings.ts": 1821,
  "packages/hub/src/connectors/home-assistant.ts": 1810,
  "packages/hub/src/cluster-sync.ts": 1724,
  "packages/env/src/peer.ts": 1663,
  "packages/web/src/kulo-api.ts": 1642,
  "packages/hub/src/scheduler.ts": 1349,
  "packages/hub/src/hindsight.ts": 1301,
  "packages/hub/src/connections.ts": 1224,
  "packages/env/src/agent.ts": 1195,
  "packages/hub/src/cluster-lifecycle.ts": 1132,
  "packages/env/src/staged-workspace.ts": 1080,
  "packages/hub/skills/diagram-design/scripts/check-diagram.mjs": 1064,
  "packages/env/src/external-agent-drivers.ts": 1063,
  "packages/web/src/features/settings/external-agent-connect-card.tsx": 1062,
  "packages/hub/src/identity-files.ts": 1043,
  "packages/protocol/src/domain.ts": 1014,
  "packages/hub/src/hindsight-service.ts": 984,
  "packages/protocol/src/diagram-validator.ts": 983,
  "packages/hub/src/tool-surface.ts": 972,
  "packages/hub/src/capabilities.ts": 951,
  "packages/hub/src/devices.ts": 935,
  "packages/web/src/features/settings/api-provider-modal.tsx": 924,
};

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

function collectSourceFiles(): Array<{ relPath: string; lines: number }> {
  const results: Array<{ relPath: string; lines: number }> = [];
  const walk = (absDir: string) => {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const absPath = path.join(absDir, entry.name);
      const relPath = path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || relPath === "packages/env/native") continue;
        walk(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (/\.(?:test|spec)\.[^.]+$|\.d\.ts$/.test(entry.name)) continue;
      results.push({ relPath, lines: countLines(fs.readFileSync(absPath, "utf8")) });
    }
  };
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root));
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function tightenRatchetInPlace(files: ReadonlyArray<{ relPath: string; lines: number }>): void {
  const lineMap = new Map(files.map((item) => [item.relPath, item.lines]));
  const nextEntries: Array<[string, number]> = [];
  for (const [relPath, ceiling] of Object.entries(LEGACY_FILE_LINE_CEILINGS)) {
    const current = lineMap.get(relPath);
    if (current === undefined || current <= NEW_FILE_MAX_LINES) continue;
    nextEntries.push([relPath, Math.min(ceiling, current)]);
  }
  nextEntries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const selfPath = path.join(REPO_ROOT, "tests", "kulo-file-size-ratchet.test.ts");
  const source = fs.readFileSync(selfPath, "utf8");
  const serialized = nextEntries.map(([k, v]) => `  ${JSON.stringify(k)}: ${v},`).join("\n");
  const replaced = source.replace(
    /const LEGACY_FILE_LINE_CEILINGS: Record<string, number> = \{[\s\S]*?\n\};/,
    `const LEGACY_FILE_LINE_CEILINGS: Record<string, number> = {\n${serialized}\n};`,
  );
  fs.writeFileSync(selfPath, replaced, "utf8");
}

describe("Kulo source file-size ratchet", () => {
  it("prevents new oversized files (>900 lines) and blocks growth on legacy large files", () => {
    const files = collectSourceFiles();
    if (process.env.KULO_TIGHTEN_RATCHET === "1") {
      tightenRatchetInPlace(files);
    }

    const lineMap = new Map(files.map((item) => [item.relPath, item.lines]));
    const violations: string[] = [];

    for (const { relPath, lines } of files) {
      const ceiling = LEGACY_FILE_LINE_CEILINGS[relPath] ?? NEW_FILE_MAX_LINES;
      if (lines > ceiling) {
        const kind = Object.hasOwn(LEGACY_FILE_LINE_CEILINGS, relPath)
          ? `exceeded legacy ratchet ceiling (${lines} > ${ceiling})`
          : `exceeded new-file limit (${lines} > ${NEW_FILE_MAX_LINES})`;
        violations.push(`${relPath}: ${kind} — extract logic into a focused module instead of expanding this file.`);
      }
    }

    // Also guard against stale baseline keys pointing to deleted files
    for (const relPath of Object.keys(LEGACY_FILE_LINE_CEILINGS)) {
      if (!lineMap.has(relPath)) {
        violations.push(`${relPath}: listed in LEGACY_FILE_LINE_CEILINGS but no longer exists (run KULO_TIGHTEN_RATCHET=1).`);
      }
    }

    expect(violations).toEqual([]);
  });
});
