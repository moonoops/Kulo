import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditCssTabLayout, auditJsxTabLayout } from "./helpers/tab-layout";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = path.join(repoRoot, "packages/web/src");
const container = "w-fit max-w-full min-w-0 shrink-0";
const list = "w-max";
const tab = "w-auto shrink-0 whitespace-nowrap";
const jsx = (view: string) => auditJsxTabLayout(`import { Tabs } from "@heroui/react";\n${view}`, "view.tsx");
const sidebarFile = "packages/web/src/features/topics/topics-sidebar.tsx";
const sidebarContainer = "kulo-navigation-tabs-container w-full max-w-full min-w-0 shrink-0";
const sidebarList = "kulo-navigation-tabs w-full";
const sidebarTab = "kulo-navigation-tab w-0 min-w-0 flex-1 whitespace-nowrap gap-2";
const sidebarBar = `<Tabs data-kulo-sidebar-tabs><Tabs.ListContainer className="${sidebarContainer}"><Tabs.List className="${sidebarList}"><Tabs.Tab id="topics" className="${sidebarTab}"/><Tabs.Tab id="projects" className="${sidebarTab}"/></Tabs.List></Tabs.ListContainer></Tabs>`;
const sidebarJsx = (view = sidebarBar, file = sidebarFile) => auditJsxTabLayout(`import { Tabs } from "@heroui/react";\n${view}`, file);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return /\.(css|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx$/.test(entry.name) ? [file] : [];
  }).sort();
}

describe("HeroUI tab width contracts", () => {
  it("keeps production tabs intrinsic except the explicitly equal sidebar navigation", () => {
    const files = sourceFiles(webSrc).map((file) => ({ name: path.relative(repoRoot, file), source: fs.readFileSync(file, "utf8") }));
    const audits = files.filter((file) => file.name.endsWith(".tsx")).map((file) => auditJsxTabLayout(file.source, file.name));
    expect(audits.reduce((total, audit) => total + audit.slotCount, 0)).toBeGreaterThan(0);
    const slotClasses = new Set(audits.flatMap((audit) => [...audit.slotClasses]));
    const violations = [...audits.flatMap((audit) => audit.violations), ...files.filter((file) => file.name.endsWith(".css")).flatMap((file) => auditCssTabLayout(file.source, file.name, slotClasses))];
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("requires the sidebar navigation to fill its container with equally growing tabs", () => {
    const audit = sidebarJsx();
    expect(audit.slotCount).toBe(4);
    expect(audit.violations).toEqual([]);
    for (const token of ["kulo-navigation-tabs-container", "max-w-full", "kulo-navigation-tabs w-full", "kulo-navigation-tab", "w-0", "min-w-0 flex-1", "whitespace-nowrap", "gap-2"]) {
      expect(sidebarJsx(sidebarBar.replace(token, "")).violations.length, token).toBeGreaterThan(0);
    }
  });

  it("does not allow the sidebar contract in another file or without its explicit root", () => {
    expect(sidebarJsx(sidebarBar, "packages/web/src/features/other/topics-sidebar.tsx").violations.length).toBeGreaterThan(0);
    expect(sidebarJsx(sidebarBar.replace("data-kulo-sidebar-tabs", "")).violations.length).toBeGreaterThan(0);
    expect(sidebarJsx(sidebarBar.replace("data-kulo-sidebar-tabs", "data-kulo-sidebar-tabs={enabled}")).violations.length).toBeGreaterThan(0);
    expect(sidebarJsx(`<Tabs>${sidebarBar.match(/<Tabs.ListContainer[\s\S]*<\/Tabs.ListContainer>/)![0]}</Tabs>`).violations.length).toBeGreaterThan(0);
  });

  it.each(["w-auto", "w-[180px]", "md:w-full", "sm:w-0", "flex-auto", "grow", "basis-1/2", "min-w-48", "grid grid-cols-2"])("rejects sidebar sizing overrides %s", (sizing) => {
    const audit = sidebarJsx(sidebarBar.replace(sidebarTab, `${sidebarTab} ${sizing}`));
    expect(audit.violations.some((message) => message.includes("must not override"))).toBe(true);
  });

  it("keeps sibling and nested usage tab bars intrinsic even inside the sidebar file", () => {
    const usage = `<Tabs><Tabs.ListContainer className="${container}"><Tabs.List className="${list}"><Tabs.Tab className="${tab}"/></Tabs.List></Tabs.ListContainer></Tabs>`;
    expect(sidebarJsx(`<>${sidebarBar}${usage}</>`).violations).toEqual([]);
    const nested = sidebarBar.replace("</Tabs>", `<Tabs.Panel>${usage}</Tabs.Panel></Tabs>`);
    expect(sidebarJsx(nested).violations).toEqual([]);
    for (const view of [`<>${sidebarBar}${usage}</>`, nested]) {
      expect(sidebarJsx(view.replace(`className="${list}"`, 'className="w-full"')).violations.some((message) => message.includes("must not stretch"))).toBe(true);
    }
  });

  it("does not permit broad CSS or local CSS to override the sidebar sizing utilities", () => {
    const slots = sidebarJsx().slotClasses;
    for (const selector of [".tabs__tab", ".kulo-ui .tabs__list", ".kulo-navigation-tabs", ".kulo-navigation-tab"]) {
      expect(auditCssTabLayout(`${selector} { width:100%; flex:1; }`, "style.css", slots)).toHaveLength(1);
    }
  });

  it("allows full-width content panels while the tab controls stay intrinsic", () => {
    const audit = jsx(`<Tabs className="w-full"><Tabs.ListContainer className="${container}"><Tabs.List className="${list}"><Tabs.Tab className="${tab}" /></Tabs.List></Tabs.ListContainer><Tabs.Panel className="w-full flex-1" /></Tabs>`);
    expect(audit.slotCount).toBe(3);
    expect(audit.violations).toEqual([]);
  });

  it("requires the container cap, content-width list, and explicit auto-width tabs", () => {
    expect(jsx('<><Tabs.ListContainer/><Tabs.List/><Tabs.Tab/></>').violations).toHaveLength(3);
    expect(jsx('<Tabs.Tab className="shrink-0 whitespace-nowrap"/>').violations[0]).toContain("w-auto");
  });

  it.each(["w-full", "md:w-full", "w-[500px]", "sm:w-72", "!w-full", "lg:w-full!"])("rejects forced tab-slot width %s", (width) => {
    expect(jsx(`<Tabs.ListContainer className="${container} ${width}"/>`).violations.some((message) => message.includes("must not stretch"))).toBe(true);
  });

  it.each(["flex-1", "sm:flex-auto", "grow", "md:grow-1", "grid grid-cols-3", "grid-cols-[repeat(3,1fr)]", "basis-1/3", "justify-between"])("rejects equal distribution via %s", (sizing) => {
    expect(jsx(`<Tabs.Tab className="${tab} ${sizing}"/>`).violations.some((message) => message.includes("must not stretch"))).toBe(true);
  });

  it("checks both conditional branches and static template additions", () => {
    expect(jsx('<Tabs.ListContainer className={`' + container + ' ${singleFile ? "hidden" : ""}`}/>').violations).toEqual([]);
    expect(jsx('<Tabs.List className={compact ? "w-max" : "w-full"}/>').violations.length).toBeGreaterThan(0);
    expect(jsx('<Tabs.List className={`w-max ${compact ? "md:w-full" : ""}`}/>').violations.some((message) => message.includes("md:w-full"))).toBe(true);
    expect(jsx('<Tabs.List className={"w-" + "max"}/>').violations).toEqual([]);
  });

  it("resolves HeroUI aliases and namespace imports without checking domain Tabs", () => {
    const audit = auditJsxTabLayout(`import { Tabs as Navigation } from "@heroui/react";
      import * as Hero from "@heroui/react";
      import { Tabs } from "./domain";
      const view = <><Navigation.List/><Hero.Tabs.Tab/><Tabs.List className="w-full"/></>;`, "aliases.tsx");
    expect(audit.slotCount).toBe(2);
    expect(audit.violations).toHaveLength(2);
  });

  it.each(["width: '100%'", "flex: 1", "flexGrow: 1", "gridTemplateColumns: '1fr 1fr'"])("rejects inline tab sizing %s", (style) => {
    expect(jsx(`<Tabs.Tab className="${tab}" style={{${style}}}/>`).violations.some((message) => message.includes("inline width/flex"))).toBe(true);
  });

  it("catches local CSS that reintroduces fixed widths or growing tabs", () => {
    const classes = new Set(["local-tabs", "local-tab"]);
    for (const source of [".local-tabs { width:100%; }", ".local-tab { width:180px; }", ".local-tab { flex:1; }", "@media (min-width:600px) { .wrapper .local-tabs { display:grid; grid-template-columns:repeat(3,1fr); } }", ".local-tab { @apply sm:flex-1; }"]) {
      expect(auditCssTabLayout(source, "style.css", classes)).toHaveLength(1);
    }
    expect(auditCssTabLayout(".kulo-ui .tabs__list { width:100%; }", "style.css", classes)).toHaveLength(1);
  });

  it("allows intrinsic CSS, touch minimums, and full-width panels or descendants", () => {
    const css = `/* .local-tab { width:100%; } */
      .local-tabs { width:fit-content; max-width:100%; min-width:0; }
      .local-tab { width:auto; flex:0 0 auto; min-width:44px; }
      .panel { width:100%; flex:1; }
      .local-tab .description { width:100%; }`;
    expect(auditCssTabLayout(css, "style.css", new Set(["local-tabs", "local-tab"]))).toEqual([]);
  });
});
