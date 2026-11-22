import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const HUB_SRC_ROOT = path.join(REPO_ROOT, "packages", "hub", "src");
const HUB_ENTRY = "packages/hub/src/hub.ts";
const HUB_BARREL = "packages/hub/src/index.ts";
const HTTP_DIR_PREFIX = "packages/hub/src/http/";

/**
 * Exact allowlist for files allowed to reference `packages/hub/src/hub.ts` (never `index.ts`).
 * Transport files (`server.ts`, `packages/hub/src/http/*`, plus legacy `image-configuration-http.ts`
 * until moved under `src/http/`) may ONLY use `import type` (zero runtime value imports).
 */
const HUB_RUNTIME_IMPORT_ALLOWLIST = new Set<string>([HUB_BARREL]);
const HUB_TYPE_ONLY_IMPORT_ALLOWLIST = new Set<string>([
  "packages/hub/src/server.ts",
  "packages/hub/src/image-configuration-http.ts",
]);

/**
 * Frozen legacy runtime SCCs (exact sorted member sets AND exact sorted internal edges).
 * Neither a new SCC nor any extra member/edge inside this SCC may be added.
 */
const FROZEN_LEGACY_RUNTIME_SCCS: ReadonlyArray<{
  members: readonly string[];
  edges: readonly string[];
}> = [
  {
    members: [
      "packages/hub/src/composio-bridge.ts",
      "packages/hub/src/mcp-fetch.ts",
      "packages/hub/src/mcp-presets.ts",
    ],
    edges: [
      "packages/hub/src/composio-bridge.ts -> packages/hub/src/mcp-fetch.ts",
      "packages/hub/src/mcp-fetch.ts -> packages/hub/src/mcp-presets.ts",
      "packages/hub/src/mcp-presets.ts -> packages/hub/src/composio-bridge.ts",
    ],
  },
];

export interface ModuleEdge {
  from: string;
  to: string;
  kind: "static-runtime" | "static-type" | "dynamic-runtime";
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function collectHubSourceFiles(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules" || entry.name === "__tests__") continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (/\.(?:test|spec)\.ts$|\.d\.ts$/.test(entry.name)) continue;
      results.push(toPosix(path.relative(REPO_ROOT, abs)));
    }
  };
  walk(rootDir);
  return results.sort();
}

function resolveLocalSpecifier(
  fromRel: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const fromDir = path.posix.dirname(fromRel);
  const raw = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates: string[] = [];
  if (raw.endsWith(".js") || raw.endsWith(".mjs") || raw.endsWith(".cjs")) {
    const stem = raw.replace(/\.(?:m|c)?js$/, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`);
  } else if (raw.endsWith(".ts") || raw.endsWith(".tsx")) {
    candidates.push(raw);
  } else {
    candidates.push(`${raw}.ts`, `${raw}.tsx`, `${raw}/index.ts`);
  }
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return undefined;
}

export function extractEdgesFromSource(
  fromRel: string,
  sourceText: string,
  knownFiles: ReadonlySet<string>,
): ModuleEdge[] {
  const sf = ts.createSourceFile(fromRel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: ModuleEdge[] = [];

  const pushEdge = (specifier: string, kind: ModuleEdge["kind"]) => {
    const target = resolveLocalSpecifier(fromRel, specifier, knownFiles);
    if (target) edges.push({ from: fromRel, to: target, kind });
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let isTypeOnly = false;
      if (clause) {
        if (clause.isTypeOnly) {
          isTypeOnly = true;
        } else if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          const elements = clause.namedBindings.elements;
          isTypeOnly = elements.length > 0 && elements.every((el) => el.isTypeOnly);
        }
      }
      pushEdge(node.moduleSpecifier.text, isTypeOnly ? "static-type" : "static-runtime");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      let isTypeOnly = node.isTypeOnly;
      if (!isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
        const elements = node.exportClause.elements;
        isTypeOnly = elements.length > 0 && elements.every((el) => el.isTypeOnly);
      }
      pushEdge(node.moduleSpecifier.text, isTypeOnly ? "static-type" : "static-runtime");
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      pushEdge(node.arguments[0]!.text, "dynamic-runtime");
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return edges;
}

export function findStronglyConnectedCycles(
  nodes: readonly string[],
  edges: ReadonlyArray<{ from: string; to: string }>,
): Array<{ members: string[]; edges: string[] }> {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n, new Set());
  for (const { from, to } of edges) {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongConnect = (v: string) => {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (component.length > 1 || (component.length === 1 && adj.get(v)?.has(v))) {
        sccs.push(component.sort());
      }
    }
  };

  for (const n of [...nodes].sort()) {
    if (!indices.has(n)) strongConnect(n);
  }

  return sccs
    .map((members) => {
      const memberSet = new Set(members);
      const internalEdges = new Set<string>();
      for (const m of members) {
        for (const target of adj.get(m) ?? []) {
          if (memberSet.has(target)) internalEdges.add(`${m} -> ${target}`);
        }
      }
      return { members, edges: [...internalEdges].sort() };
    })
    .sort((a, b) => a.members[0]!.localeCompare(b.members[0]!));
}

export function auditHubFacadeImports(edges: readonly ModuleEdge[]): string[] {
  const violations: string[] = [];
  for (const edge of edges) {
    if (edge.to === HUB_BARREL) {
      violations.push(
        `${edge.from}: must not import hub barrel ${HUB_BARREL} (${edge.kind}) — import the specific domain module directly.`,
      );
      continue;
    }
    if (edge.to !== HUB_ENTRY) continue;
    if (HUB_RUNTIME_IMPORT_ALLOWLIST.has(edge.from)) continue;
    const isAllowedTypeOnly =
      HUB_TYPE_ONLY_IMPORT_ALLOWLIST.has(edge.from) || edge.from.startsWith(HTTP_DIR_PREFIX);
    if (isAllowedTypeOnly) {
      if (edge.kind !== "static-type") {
        violations.push(
          `${edge.from}: transport layer may only use \`import type\` from ${HUB_ENTRY} (found ${edge.kind}).`,
        );
      }
      continue;
    }
    violations.push(
      `${edge.from}: domain module must not import ${HUB_ENTRY} (${edge.kind}) — pass narrow dependency interfaces instead.`,
    );
  }
  return violations.sort();
}

describe("Kulo hub module dependency & cycle guardrails", () => {
  it("prevents new runtime circular dependencies in packages/hub/src (static and dynamic)", () => {
    const files = collectHubSourceFiles(HUB_SRC_ROOT);
    const knownFiles = new Set(files);
    const allEdges = files.flatMap((rel) =>
      extractEdgesFromSource(rel, fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"), knownFiles),
    );

    const staticRuntimeEdges = allEdges.filter((e) => e.kind === "static-runtime");
    const runtimeSccs = findStronglyConnectedCycles(files, staticRuntimeEdges);
    expect(runtimeSccs).toEqual(FROZEN_LEGACY_RUNTIME_SCCS);

    // Ensure combining dynamic runtime imports introduces no additional cycle beyond the frozen static SCC.
    const allRuntimeEdges = allEdges.filter(
      (e) => e.kind === "static-runtime" || e.kind === "dynamic-runtime",
    );
    const combinedSccs = findStronglyConnectedCycles(files, allRuntimeEdges);
    expect(combinedSccs).toEqual(FROZEN_LEGACY_RUNTIME_SCCS);
  });

  it("blocks domain modules from back-importing hub.ts or index.ts", () => {
    const files = collectHubSourceFiles(HUB_SRC_ROOT);
    const knownFiles = new Set(files);
    const allEdges = files.flatMap((rel) =>
      extractEdgesFromSource(rel, fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"), knownFiles),
    );
    const violations = auditHubFacadeImports(allEdges);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("detects synthetic cycles, re-export cycles, and forbidden hub.ts back-imports", () => {
    const known = new Set([
      "packages/hub/src/hub.ts",
      "packages/hub/src/index.ts",
      "packages/hub/src/a.ts",
      "packages/hub/src/b.ts",
      "packages/hub/src/connectors/bad.ts",
      "packages/hub/src/http/ok-routes.ts",
      "packages/hub/src/http/bad-routes.ts",
    ]);

    const cycleEdges = [
      ...extractEdgesFromSource("packages/hub/src/a.ts", `export { b } from "./b.js";`, known),
      ...extractEdgesFromSource("packages/hub/src/b.ts", `import { a } from "./a.js"; export const b = a;`, known),
    ];
    expect(
      findStronglyConnectedCycles(["packages/hub/src/a.ts", "packages/hub/src/b.ts"], cycleEdges),
    ).toEqual([
      {
        members: ["packages/hub/src/a.ts", "packages/hub/src/b.ts"],
        edges: [
          "packages/hub/src/a.ts -> packages/hub/src/b.ts",
          "packages/hub/src/b.ts -> packages/hub/src/a.ts",
        ],
      },
    ]);

    const typeOnlyCycle = [
      ...extractEdgesFromSource("packages/hub/src/a.ts", `import type { B } from "./b.js"; export type A = B;`, known),
      ...extractEdgesFromSource("packages/hub/src/b.ts", `import { type A } from "./a.js"; export type B = A;`, known),
    ];
    expect(typeOnlyCycle.every((e) => e.kind === "static-type")).toBe(true);

    const badSubdirImport = extractEdgesFromSource(
      "packages/hub/src/connectors/bad.ts",
      `import type { KuloHub } from "../hub.js";`,
      known,
    );
    expect(auditHubFacadeImports(badSubdirImport)).toHaveLength(1);

    const barrelBackImport = extractEdgesFromSource(
      "packages/hub/src/a.ts",
      `import { KuloHub } from "./index.js";`,
      known,
    );
    expect(auditHubFacadeImports(barrelBackImport)).toHaveLength(1);

    const okHttpRoute = extractEdgesFromSource(
      "packages/hub/src/http/ok-routes.ts",
      `import type { KuloHub } from "../hub.js";`,
      known,
    );
    expect(auditHubFacadeImports(okHttpRoute)).toEqual([]);

    const badHttpRoute = extractEdgesFromSource(
      "packages/hub/src/http/bad-routes.ts",
      `import { KuloHub } from "../hub.js";`,
      known,
    );
    expect(auditHubFacadeImports(badHttpRoute)).toHaveLength(1);
  });
});
