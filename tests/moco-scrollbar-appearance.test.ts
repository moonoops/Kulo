import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditCssScrollbars, auditJsxScrollbars, scrollbarStyledClasses } from "./helpers/scrollbar-appearance";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = path.join(repoRoot, "packages/web/src");
const styled = scrollbarStyledClasses([".chat-scroll, .composer { @apply scrollbar; }"]);
const jsx = (view: string) => auditJsxScrollbars(`import { TextArea, InputGroup } from "@heroui/react";\n${view}`, "view.tsx", styled);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return /\.(css|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx$/.test(entry.name) ? [file] : [];
  }).sort();
}

describe("HeroUI scrollbar coverage", () => {
  it("styles every declared application scroll slot and HeroUI text area", () => {
    const files = sourceFiles(webSrc).map((file) => ({ name: path.relative(repoRoot, file), source: fs.readFileSync(file, "utf8") }));
    const css = files.filter((file) => file.name.endsWith(".css"));
    const covered = scrollbarStyledClasses(css.map((file) => file.source));
    expect(covered.size).toBeGreaterThan(0);
    const violations = files.flatMap((file) => file.name.endsWith(".css")
      ? auditCssScrollbars(file.source, file.name, covered)
      : auditJsxScrollbars(file.source, file.name, covered));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it.each(["overflow:auto", "overflow-x:scroll", "overflow-y:auto"])("requires coverage for CSS %s", (overflow) => {
    expect(auditCssScrollbars(`.settings { ${overflow}; }`, "style.css", styled)).toHaveLength(1);
    expect(auditCssScrollbars(`.settings { @apply scrollbar; ${overflow}; }`, "style.css", styled)).toEqual([]);
  });

  it("recognizes an earlier grouped application rule without duplicating the utility", () => {
    expect(auditCssScrollbars(".chat-scroll { overflow-y: auto; }", "style.css", styled)).toEqual([]);
    expect(jsx('<div className="chat-scroll overflow-y-auto"/>')).toEqual([]);
    expect(jsx('<TextArea className="composer"/>')).toEqual([]);
  });

  it("does not count comments, descendant selectors or conditional styling as shared coverage", () => {
    const css = `/* .comment { @apply scrollbar; } */
      .hover:hover { @apply scrollbar; }
      .parent .child { @apply scrollbar; }
      .parent { .nested { @apply scrollbar; } }
      @media (min-width: 600px) { .wide { @apply scrollbar; } }
      @layer components { .actual { @apply scrollbar; } }`;
    expect([...scrollbarStyledClasses([css])]).toEqual(["actual"]);
    expect(auditCssScrollbars(".settings { /* @apply scrollbar; */ overflow: auto; }", "style.css", styled)).toHaveLength(1);
  });

  it("checks scroll rules inside media and preserves intentionally hidden scrollbars", () => {
    expect(auditCssScrollbars("@media (min-width:600px) { .list { @apply scrollbar-none; overflow-y:auto; } }", "style.css", styled)).toEqual([]);
    expect(auditCssScrollbars("@media (min-width:600px) { .list { overflow-y:auto; } }", "style.css", styled)).toHaveLength(1);
    expect(jsx('<><div className="scrollbar-none overflow-y-auto"/><div className="scrollbar overflow-x-auto"/></>')).toEqual([]);
  });

  it("requires the utility on the actual JSX owner, not on a sibling or parent", () => {
    expect(jsx('<><div className="scrollbar"/><div className="overflow-auto"/></>')).toHaveLength(1);
    expect(jsx('<div className="scrollbar"><div className="overflow-y-auto"/></div>')).toHaveLength(1);
  });

  it("requires a scrollbar contract for native scrolling inside HeroUI text areas", () => {
    expect(jsx('<TextArea/>')).toHaveLength(1);
    expect(jsx('<TextArea className="scrollbar resize-y"/>')).toEqual([]);
    expect(jsx('<InputGroup.TextArea/>')).toHaveLength(1);
  });

  it("resolves aliases and namespace imports without checking unrelated controls", () => {
    const source = `import { TextArea as Area } from "@heroui/react";
      import * as Hero from "@heroui/react";
      import { TextArea } from "./domain";
      const view = <><Area/><Hero.TextArea/><Hero.InputGroup.TextArea/><TextArea/></>;`;
    expect(auditJsxScrollbars(source, "aliases.tsx", styled)).toHaveLength(3);
  });

  it("checks each known class branch and allows common static template coverage", () => {
    expect(jsx('<div className={`scrollbar overflow-y-auto ${extra}`}/>' )).toEqual([]);
    expect(jsx('<div className={compact ? "scrollbar overflow-auto" : "overflow-auto"}/>' )).toHaveLength(1);
    expect(jsx('<div className={`overflow-auto ${compact ? "scrollbar" : ""}`}/>' )).toHaveLength(1);
    expect(jsx('<div className="md:overflow-y-auto md:scrollbar"/>' )).toEqual([]);
  });

  it("does not turn hidden file pickers into scroll controls", () => {
    expect(jsx('<><input type="file" hidden className="overflow-auto"/><input type="file" className="hidden overflow-auto"/></>')).toEqual([]);
  });
});
