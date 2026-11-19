import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { searchSuggestionsDocument } from "../packages/web/src/features/chat/message-sources";
import { auditCssTypography, auditHeroUiTypographySlots, auditJsxTypography, auditOverlayHeadingTypography, auditTableHeaderTypography, auditTypographyTokens } from "./helpers/typography";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(repoRoot, "packages/web");
const css = (source: string, file = "view.css") => auditCssTypography(source, file);
const jsx = (source: string) => auditJsxTypography(source, "view.tsx");
const webRequire = createRequire(path.join(web, "package.json"));
const installedStyleDirectory = path.join(path.dirname(webRequire.resolve("@heroui/styles/package.json")), "dist/components");
const installedStyles = fs.readdirSync(installedStyleDirectory).filter((name) => name.endsWith(".css"))
  .map((name) => fs.readFileSync(path.join(installedStyleDirectory, name), "utf8")).join("\n");
async function slots(source: string): Promise<string[]> {
  // Some structural slots are emitted by variants without their own CSS rules.
  const { disclosureVariants } = await import(pathToFileURL(webRequire.resolve("@heroui/styles/components/disclosure")).href);
  const { fieldsetVariants } = await import(pathToFileURL(webRequire.resolve("@heroui/styles/components/fieldset")).href);
  const emitted = [disclosureVariants(), fieldsetVariants()].flatMap((variant) =>
    Object.values(variant as Record<string, () => string>).flatMap((slot) => slot().split(/\s+/)));
  return auditHeroUiTypographySlots(source, "moco-typography.css", installedStyles, emitted);
}
const tokenFixture = `:root {
  --moco-text-caption: 0.75rem; --moco-leading-caption: 18px;
  --moco-text-body: 0.875rem; --moco-leading-body: 20px;
  --moco-text-heading: 1.125rem; --moco-leading-heading: 26px;
  --moco-text-title: 1.5rem; --moco-leading-title: 32px;
}
@theme {
  --text-xs: var(--moco-text-caption); --text-xs--line-height: var(--moco-leading-caption);
  --text-sm: var(--moco-text-body); --text-sm--line-height: var(--moco-leading-body);
  --text-lg: var(--moco-text-heading); --text-lg--line-height: var(--moco-leading-heading);
  --text-2xl: var(--moco-text-title); --text-2xl--line-height: var(--moco-leading-title);
  --text-base: var(--moco-text-body); --text-base--line-height: var(--moco-leading-body);
  --text-xl: var(--moco-text-heading); --text-xl--line-height: var(--moco-leading-heading);
}`;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return /\.(css|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx$/.test(entry.name) ? [file] : [];
  }).sort();
}

describe("shared UI typography guard", () => {
  it("keeps every authored UI size and line-height on the shared scale", () => {
    const files = sourceFiles(path.join(web, "src"));
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) => {
      const name = path.relative(repoRoot, file), source = fs.readFileSync(file, "utf8");
      return file.endsWith(".css") ? auditCssTypography(source, name) : auditJsxTypography(source, name);
    });
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("defines the four sizes once, with fixed leading and library aliases", () => {
    const name = "packages/web/src/moco-typography.css";
    const source = fs.readFileSync(path.join(repoRoot, name), "utf8");
    const violations = auditTypographyTokens(source, name);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("keeps Modal, AlertDialog and Drawer titles on the heading role", () => {
    const name = "packages/web/src/moco-typography.css";
    const source = fs.readFileSync(path.join(repoRoot, name), "utf8");
    const violations = auditOverlayHeadingTypography(source, name);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("gives standard and custom table headers the same body size and 600 weight", () => {
    const name = "packages/web/src/moco-typography.css";
    expect(auditTableHeaderTypography(fs.readFileSync(path.join(repoRoot, name), "utf8"), name)).toEqual([]);
  });

  it("uses actual installed HeroUI slots and covers their semantic typography roles", async () => {
    const source = fs.readFileSync(path.join(web, "src/moco-typography.css"), "utf8");
    expect(await slots(source)).toEqual([]);
    expect(await slots(source + "\n/* .tab { font-size: 99px; } */")).toEqual([]);
    for (const invalid of ["tab", "combo-box__input", "input-group__textarea", "menu-section__heading", "list-box-section__heading"]) {
      expect(await slots(source + `\n.moco-ui .${invalid} { font-size: var(--moco-text-body); }`))
        .toContainEqual(expect.stringContaining(`.${invalid} is not an installed HeroUI slot`));
    }
    expect(await slots(source.replaceAll(".tabs__tab", ".tabs__panel")))
      .toContainEqual(expect.stringContaining(".tabs__tab needs unconditional scoped body font-size"));
    expect(await slots(source.replaceAll(".card__description", ".card__content")))
      .toContainEqual(expect.stringContaining(".card__description needs unconditional scoped caption font-size"));
  });

  it("loads the shared styles and scopes Portal typography from body", () => {
    const entry = fs.readFileSync(path.join(web, "src/moco.css"), "utf8");
    const document = fs.readFileSync(path.join(web, "index.html"), "utf8");
    expect(entry).toMatch(/@import\s+["']\.\/moco-typography\.css["']\s*;/);
    const bodyClasses = /<body\b[^>]*\bclass=["']([^"']*)["']/.exec(document)?.[1]?.split(/\s+/);
    expect(bodyClasses).toContain("moco-ui");
  });

  it("gives HeroUI text fields and selects the same label gap", () => {
    const source = fs.readFileSync(path.join(web, "src/moco-typography.css"), "utf8");
    const fieldSelectors = source.match(/\.moco-ui\s+:is\(([^)]+)\)\s*\{\s*gap:\s*var\(--moco-field-gap\);\s*\}/)?.[1];
    expect(fieldSelectors?.split(/,\s*/)).toEqual(expect.arrayContaining([".textfield", ".select"]));
  });

  it("gives the isolated search-suggestion document the same 14/20 body type", () => {
    const document = searchSuggestionsDocument("<p>Search result</p>");
    const style = /<style>([\s\S]*?)<\/style>/.exec(document)?.[1];
    expect(style).toBeDefined();
    expect(style).toMatch(/body\s*\{[^}]*\bfont\s*:\s*14px\s*\/\s*20px\s+system-ui\s*,\s*sans-serif\s*;/);
    expect(style?.match(/\bfont(?:-size)?\s*:/g)).toHaveLength(1);
  });

  it("accepts semantic CSS sizes, line-heights, inheritance and matched shorthand", () => {
    expect(css(`.row { font-size: var(--moco-text-body); line-height: var(--moco-leading-body); }
      .heading { font: 600 var(--moco-text-heading)/var(--moco-leading-heading) system-ui, sans-serif; }
      .nested { font: inherit; font-size: inherit; line-height: inherit; }
      .utilities { @apply text-xs; }`)).toEqual([]);
  });

  it("rejects mismatched semantic font-size and line-height in the same CSS rule", () => {
    expect(css(".row { font-size: var(--moco-text-body); line-height: var(--moco-leading-heading); }")).toEqual([
      expect.stringContaining("pairs body font-size with heading line-height"),
    ]);
    expect(css(".row { font: 400 var(--moco-text-body)/var(--moco-leading-body) system-ui; line-height: var(--moco-leading-heading); }")).toHaveLength(1);
  });

  it("allows inherited leading and does not pair declarations across separate rules or media", () => {
    expect(css(`.row { font-size: var(--moco-text-body); }
      .child { font-size: var(--moco-text-body); line-height: inherit; }
      .row { line-height: var(--moco-leading-heading); }
      @media (max-width:600px) { .row { font-size: var(--moco-text-heading); } }`)).toEqual([]);
  });

  it("requires semantic overlay titles rather than accepting any valid size tier", () => {
    const titleRule = (size = "heading", leading = "heading") => `.moco-ui :is(.modal__heading, .alert-dialog__heading, .drawer__heading) {
      font-size: var(--moco-text-${size}); line-height: var(--moco-leading-${leading}); }`;
    expect(auditOverlayHeadingTypography(titleRule(), "typography.css")).toEqual([]);
    const smallerTitles = titleRule("body", "body");
    expect(css(smallerTitles)).toHaveLength(6);
    expect(auditOverlayHeadingTypography(smallerTitles, "typography.css")).toContainEqual(expect.stringContaining(".modal__heading must keep the heading font-size role"));
    expect(auditOverlayHeadingTypography(titleRule("heading", "body"), "typography.css")).toContainEqual(expect.stringContaining(".drawer__heading must keep the heading line-height role"));
  });

  it("accepts grouped or separate scoped title declarations, but requires default coverage", () => {
    const separate = ["modal__heading", "alert-dialog__heading", "drawer__heading"].map((heading) => `.moco-ui .${heading} {
      font-size: var(--moco-text-heading); } .moco-ui .${heading} { line-height: var(--moco-leading-heading); }`).join("\n");
    expect(auditOverlayHeadingTypography(separate, "typography.css")).toEqual([]);
    expect(auditOverlayHeadingTypography(`@layer components { ${separate} }`, "typography.css")).toEqual([]);
    expect(auditOverlayHeadingTypography(`@media (min-width:600px) { ${separate} }`, "typography.css")).toHaveLength(3);
    expect(auditOverlayHeadingTypography(separate.replaceAll(".moco-ui ", ""), "typography.css")).toHaveLength(3);
    expect(auditOverlayHeadingTypography(separate.replaceAll(".modal__heading", ".modal__heading .label"), "typography.css")).toHaveLength(1);
  });

  it("requires unconditional 14/20 and 600 header type instead of a valid but smaller tier", () => {
    const shared = `.moco-ui :is(.table__column, .moco-table-header) {
      font-size: var(--moco-text-body); line-height: var(--moco-leading-body); font-weight: 600; }`;
    expect(auditTableHeaderTypography(shared, "typography.css")).toEqual([]);
    expect(auditTableHeaderTypography(`@layer components { ${shared} }`, "typography.css")).toEqual([]);
    expect(auditTableHeaderTypography(shared.replaceAll("body", "caption"), "typography.css")).toHaveLength(4);
    expect(auditTableHeaderTypography(shared.replace("600", "500"), "typography.css")).toHaveLength(2);
    expect(auditTableHeaderTypography(shared.replace("font-weight: 600;", ""), "typography.css")).toHaveLength(2);
    expect(auditTableHeaderTypography(`@media (min-width:600px) { ${shared} }`, "typography.css")).toHaveLength(6);
    expect(auditTableHeaderTypography(shared.replace(".moco-ui ", ""), "typography.css")).toHaveLength(6);
    expect(auditTableHeaderTypography(shared.replace(".moco-table-header", ".moco-table-header .label"), "typography.css")).toHaveLength(3);
  });

  it.each(["table__column", "moco-table-header", "moco-search-plan-head", "moco-model-column-head", "moco-settings-table-column"])("rejects smaller, weaker or inherited CSS type on %s", (name) => {
    expect(css(`.scope .${name} { font-size: var(--moco-text-caption); line-height: var(--moco-leading-caption); }`)).toHaveLength(2);
    expect(css(`.scope .${name} { font-weight: 500; }`)).toHaveLength(1);
    expect(css(`.scope .${name} { @apply text-xs; }`)).toHaveLength(1);
    expect(css(`.scope .${name} { @apply font-normal; }`)).toHaveLength(1);
    expect(css(`.scope .${name} { font: 400 var(--moco-text-body)/var(--moco-leading-body) system-ui; }`)).toHaveLength(1);
    expect(css(`.scope .${name} { font-weight: inherit; }`)).toHaveLength(1);
    expect(css(`.scope .${name} { font-size: var(--moco-text-body); line-height: var(--moco-leading-body); font-weight: 600; }`)).toEqual([]);
  });

  it.each(["13px", "14px", "0.875rem", "88%", "calc(var(--moco-text-body) + 1px)", "var(--local-size)"])("rejects a local CSS size %s even if it looks close to a role", (value) => {
    expect(css(`.row { font-size: ${value}; }`)).toHaveLength(1);
  });

  it.each(["20px", "1.5", "normal", "var(--leading-local)"])("rejects a local CSS line-height %s", (value) => {
    expect(css(`.row { line-height: ${value}; }`)).toHaveLength(1);
  });

  it("checks font shorthands and CSS @apply rather than only font-size declarations", () => {
    const violations = css(`.one { font: 13px/20px system-ui; }
      .two { font: 500 var(--moco-text-body)/21px system-ui; }
      .three { @apply text-base; }
      .four { @apply md:text-[15px]; }
      .five { @apply leading-5; }`);
    expect(violations).toHaveLength(5);
    expect(violations[0]).toMatch(/^view\.css:1 .*font:/);
  });

  it("checks media, layers and nested declarations without interpreting strings or comments", () => {
    expect(css(`/* .ignored { font-size: 13px; } */
      @layer components { @media (max-width:600px) { .card {
        content: 'font-size: 13px; { line-height: 99px; } /* literal */';
        background-image: url("data:text/plain;charset=utf-8,font:13px/21px");
        & .label { font-size: 13px; }
      } } }`)).toEqual([expect.stringMatching(/^view\.css:5 \.card \.label font-size:/)]);
  });

  it("does not let a module or a theme redefine the shared font tokens", () => {
    expect(css(":root { --moco-text-body: 13px; --text-tiny: 11px; }", "feature.css")).toHaveLength(2);
    expect(auditTypographyTokens(tokenFixture, "moco-typography.css")).toEqual([]);
    expect(auditTypographyTokens(tokenFixture.replace("0.875rem", "13px"), "moco-typography.css")).toHaveLength(1);
    expect(auditTypographyTokens(tokenFixture + ":root { --moco-text-body: 14px; }", "moco-typography.css")).toHaveLength(1);
    expect(auditTypographyTokens(tokenFixture + "@theme { --text-tiny: 11px; }", "moco-typography.css")).toHaveLength(1);
  });

  it("preserves explicit user-content typography without exempting chat UI", () => {
    const file = "packages/web/src/features/chat/chat-content.css";
    expect(css(`.moco-chat-markdown { font-size: var(--moco-chat-font-size); line-height: var(--moco-chat-line-height); }
      .moco-chat-markdown h1 { font-size: 1.55em; line-height: 1.5; }
      .moco-chat-inline-code { font: .88em/1.5 ui-monospace, monospace; }
      .moco-chat-table { font-size: max(12px, calc(var(--moco-chat-font-size) - 1px)); }
      .moco-chat-code-pre { font: max(12px, calc(var(--moco-chat-font-size) - 2px))/1.65 ui-monospace, monospace; }`, file)).toEqual([]);
    expect(css(".moco-chat-meta { font-size: 13px; }", file)).toHaveLength(1);
    expect(css(".moco-chat-markdown { font-size: 13px; }", file)).toHaveLength(1);
    expect(css(".moco-chat-markdown, .menu { font-size: var(--moco-chat-font-size); }", file)).toHaveLength(1);
    expect(css(".moco-chat-markdown h1 { font-size: 1.55em; }", "other.css")).toHaveLength(1);
  });

  it("limits composer exceptions to the existing chat preference and mobile expression", () => {
    expect(css(`.moco-composer-input, .mc-user-message { font-size: var(--moco-chat-font-size); line-height: var(--moco-chat-line-height); }
      @media (max-width:639px) { .moco-composer-input { font-size: max(var(--moco-text-heading), var(--moco-chat-font-size)); } }`, "packages/web/src/moco.css")).toEqual([]);
    expect(css(".moco-composer-input { font-size: 16px; }", "packages/web/src/moco.css")).toHaveLength(1);
    expect(css(".moco-composer-input-extra { font-size: var(--moco-chat-font-size); }", "packages/web/src/moco.css")).toHaveLength(1);
  });

  it("allows only PDF glyph geometry in the document text layer", () => {
    const file = "packages/web/src/features/chat/pdf-preview.css";
    expect(css(`.moco-pdf-text-layer { line-height: 1; --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size)); }
      .moco-pdf-text-layer > :not(.markedContent), .moco-pdf-text-layer .markedContent span:not(.markedContent) { font-size: calc(var(--text-scale-factor) * var(--font-height)); }`, file)).toEqual([]);
    expect(css(".moco-pdf-toolbar { font-size: calc(var(--text-scale-factor) * var(--font-height)); }", file)).toHaveLength(1);
    expect(css(".moco-pdf-text-layer { font-size: 13px; line-height: 1.4; }", file)).toHaveLength(2);
    expect(css(".moco-pdf-text-layer > :not(.markedContent), .menu { font-size: calc(var(--text-scale-factor) * var(--font-height)); }", file)).toHaveLength(1);
    expect(css(".moco-pdf-text-layer { --text-scale-factor: 13px; }", file)).toHaveLength(1);
    expect(css(".moco-pdf-toolbar { --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size)); }", file)).toHaveLength(1);
    expect(css(".moco-pdf-text-layer { line-height: 1; }", "other.css")).toHaveLength(1);
  });

  it("accepts the four JSX utilities, inherited text, color utilities and semantic leading", () => {
    expect(jsx(`<><div className="text-xs text-sm sm:text-lg text-2xl text-[inherit]"/>
      <div className="text-muted text-[color:var(--accent)] text-[#fff] text-[oklch(0.6_0.1_250)] text-[var(--accent)]"/>
      <div className="moco-item-title leading-(--moco-leading-body) leading-[var(--moco-leading-body)]"/></>`)).toEqual([]);
  });

  it.each(["text-base", "sm:text-base", "!text-xl", "text-3xl!", "text-[13px]", "hover:text-[0.8rem]", "text-[length:var(--local)]", "text-(length:--local)", "text-sm/6", "leading-5", "leading-relaxed", "[font-size:13px]"])("rejects JSX utility %s", (token) => {
    expect(jsx(`<div className="${token}"/>`)).toHaveLength(1);
  });

  it("checks every static branch, templates, concatenations and class helper arguments", () => {
    expect(jsx("const view = <><div className={compact ? 'text-sm' : 'text-base'}/>" +
      "<div className={`px-2 ${compact ? 'text-sm' : 'text-[13px]'}`}/>" +
      "<div className={'text-' + 'xl'}/>" +
      "<div className={cx('text-sm', compact && 'leading-6')}/>" +
      "<div className={cx({'text-base': compact})}/></>;")).toHaveLength(5);
    expect(jsx("const view = <div className={`text-${size}`}/>;")).toHaveLength(1);
  });

  it("resolves local class constants and render callbacks without scanning prose or comments", () => {
    expect(jsx(`// <div className="text-base"/>
      const prose = 'the text-base class was removed';
      const size = 'text-base'; const safe = 'text-sm';
      const view = <><div className={size}/><div className={() => safe}/>
        <div className={() => { return 'leading-6'; }}/></>;`)).toHaveLength(2);
    expect(jsx(`const size = 'text-base'; function View(size) { return <div className={size}/>; }`)).toEqual([]);
    expect(jsx(`const size = 'text-base'; function View() { let size; return <div className={size}/>; }`)).toEqual([]);
  });

  it("checks aliases and namespace controls just like native and local JSX elements", () => {
    expect(jsx(`import { Modal as Dialog } from '@heroui/react'; import * as Hero from '@heroui/react';
      const view = <><Dialog.Heading className="text-base"/><Hero.Label className="text-[13px]"/>
      <LocalRow className="text-xl"/><span className="text-sm"/></>;`)).toHaveLength(3);
  });

  it.each(["text-xs", "md:text-sm", "!text-2xl", "text-[inherit]", "leading-(--moco-leading-body)", "sm:leading-[var(--moco-leading-caption)]"])("rejects a valid utility that overrides an overlay heading: %s", (token) => {
    expect(jsx(`import { Modal } from '@heroui/react'; const view = <Modal.Heading className="${token}"/>;`)).toHaveLength(1);
  });

  it("checks HeroUI heading aliases, namespace imports and conditional class branches", () => {
    expect(jsx(`import { Modal as Dialog, AlertDialog as Confirm } from '@heroui/react'; import * as Hero from '@heroui/react';
      const view = <><Dialog.Heading className="text-sm"/><Confirm.Heading className="text-xs"/>
      <Hero.Drawer.Heading className={compact ? 'text-lg' : 'text-2xl'}/></>;`)).toHaveLength(3);
  });

  it("allows inherited or explicit heading type, visibility, layout, family and weight", () => {
    expect(jsx(`import { Modal, AlertDialog, Drawer } from '@heroui/react'; const view = <>
      <Modal.Heading/><AlertDialog.Heading className="sr-only"/>
      <Drawer.Heading className="min-w-0 flex-1 font-mono font-semibold text-foreground text-lg leading-(--moco-leading-heading)"/>
      <Modal.Heading className="sm:text-lg leading-[var(--moco-leading-heading)]"/></>;`)).toEqual([]);
  });

  it("does not apply HeroUI heading semantics to local or shadowed components", () => {
    expect(jsx(`import { Modal } from './domain'; import * as Local from './ui';
      const view = <><Modal.Heading className="text-sm"/><Local.Drawer.Heading className="text-xs"/></>;`)).toEqual([]);
    expect(jsx(`import { Modal, Drawer } from '@heroui/react'; import * as Hero from '@heroui/react';
      function A(Modal) { return <Modal.Heading className="text-sm"/>; }
      function B({ Drawer }) { return <Drawer.Heading className="text-sm"/>; }
      function C() { const Hero = domain; return <Hero.Modal.Heading className="text-sm"/>; }`)).toEqual([]);
  });

  it.each([
    ["Label", "text-sm", "text-xs", "body"],
    ["Alert.Title", "text-sm", "text-lg", "body"],
    ["Alert.Description", "text-xs", "text-sm", "caption"],
    ["Card.Description", "text-xs", "text-sm", "caption"],
    ["Table.Column", "text-sm", "text-xs", "body"],
    ["Table.Cell", "text-sm", "text-xs", "body"],
    ["Button", "text-sm", "text-xs", "body"],
  ])("keeps HeroUI %s on its component role even when another tier is valid", (component, good, bad, expected) => {
    const imports = `import { Label, Alert, Card, Table, Button } from '@heroui/react';`;
    expect(jsx(`${imports} const view = <${component} className="${good}"/>;`)).toEqual([]);
    expect(jsx(`${imports} const view = <${component} className="md:${bad}"/>;`))
      .toEqual([expect.stringContaining(`must keep its ${expected} typography role`)]);
    expect(jsx(`${imports} const view = <${component} className={compact ? '${good}' : '${bad}'}/>;`)).toHaveLength(1);
    expect(jsx(`${imports} const view = <${component} className="text-[inherit]"/>;`)).toHaveLength(1);
  });

  it("checks aliases, namespaces and semantic leading without confusing local controls", () => {
    expect(jsx(`import { Label as FieldLabel, Alert as Notice, Button as Action } from '@heroui/react'; import * as Hero from '@heroui/react';
      const view = <><FieldLabel className="text-xs"/><Notice.Description className="md:text-sm"/>
      <Hero.Card.Description className="leading-(--moco-leading-body)"/><Action className="moco-item-description"/></>;`)).toHaveLength(4);
    expect(jsx(`import { Label, Alert, Button } from './domain'; import * as Local from './ui';
      const view = <><Label className="text-xs"/><Alert.Description className="text-sm"/>
      <Local.Card.Description className="text-sm"/><Button className="size-6 text-xs"/></>;`)).toEqual([]);
    expect(jsx(`import { Label, Alert, Button } from '@heroui/react'; import * as Hero from '@heroui/react';
      function A(Label) { return <Label className="text-xs"/>; }
      function B({ Alert }) { return <Alert.Description className="text-sm"/>; }
      function C() { const Hero = domain; return <Hero.Card.Description className="text-sm"/>; }
      function D() { const Button = domain; return <Button className="size-6 text-xs"/>; }`)).toEqual([]);
  });

  it.each(["font-medium", "hover:font-normal", "!font-bold", "font-[500]", "font-(weight:--local)", "[font-weight:400]"])("rejects header weight override %s on standard and custom headers", (token) => {
    expect(jsx(`import { Table as Grid } from '@heroui/react'; import * as Hero from '@heroui/react';
      const view = <><Grid.Column className="${token}"/><Hero.Table.Column className="${token}"/>
        <div className="moco-table-header ${token}"/></>;`)).toHaveLength(3);
    expect(jsx(`<div className="${token}"/>;`)).toEqual([]);
  });

  it("checks conditional header classes and inline weight without confusing local components", () => {
    expect(jsx(`import { Table } from '@heroui/react'; const view = <>
      <Table.Column className={compact ? 'font-semibold' : 'font-medium'}/>
      <div className="moco-table-header text-xs"/><div className="moco-table-header leading-(--moco-leading-caption)"/>
      <Table.Column style={{ fontWeight: 500 }}/><div className="moco-table-header" style={{ ['font' + 'Weight']: 400 }}/>
      </>;`)).toHaveLength(5);
    expect(jsx(`import { Table } from './domain'; const view = <Table.Column className="font-medium"/>;`)).toEqual([]);
    expect(jsx(`import { Table } from '@heroui/react'; const view = <><Table.Column className="text-sm font-semibold font-mono"/>
      <div className="moco-table-header text-sm font-semibold"/></>;`)).toEqual([]);
  });

  it.each(["moco-search-plan-head", "moco-model-column-head"])("requires the shared header role on custom %s branches", (name) => {
    expect(jsx(`<div className="${name}"/>;`)).toEqual([expect.stringContaining("custom table headers must use moco-table-header")]);
    expect(jsx(`<div className="${name} moco-table-header"/>;`)).toEqual([]);
    expect(jsx(`<div className={compact ? '${name} moco-table-header' : '${name}'}/>;`)).toHaveLength(1);
  });

  it("keeps message-footer controls at caption size and regular buttons at body size", () => {
    const imports = `import { Button } from '@heroui/react';`;
    expect(jsx(`${imports} const view = <><Button/><Button className="text-sm leading-(--moco-leading-body)"/>
      <Button className="moco-message-action text-xs leading-(--moco-leading-caption)"/></>;`)).toEqual([]);
    expect(jsx(`${imports} const view = <Button className="moco-message-action text-sm"/>;`)).toHaveLength(1);
    expect(jsx(`${imports} const view = <Button className="text-xs"/>;`)).toHaveLength(1);
    expect(jsx(`${imports} const view = <Button className={cx('moco-message-action', compact && 'text-xs')}/>;`)).toEqual([]);
    expect(jsx(`${imports} const view = <Button className={compact ? 'moco-message-action text-xs' : 'text-xs'}/>;`)).toHaveLength(1);
    expect(jsx(`${imports} const view = <Button className={cx(compact && 'moco-message-action', 'text-xs')}/>;`)).toHaveLength(1);
  });

  it.each(["size-6", "h-8", "min-h-0", "md:max-h-8", "!min-h-[32px]"])("rejects Button utility %s that overrides shared control dimensions", (token) => {
    expect(jsx(`import { Button as Action } from '@heroui/react'; const view = <Action className="${token}"/>;`)).toHaveLength(1);
    expect(jsx(`<div className="${token}"/>;`)).toEqual([]);
    expect(jsx(`import { Button } from '@heroui/react'; function View(Button) { return <Button className="${token}"/>; }`)).toEqual([]);
  });

  it("allows Button layout and size props while checking local CSS component roles", () => {
    expect(jsx(`import { Button } from '@heroui/react'; const view = <Button size="sm" className="w-full h-auto [&_svg]:h-4 [&>svg]:size-4"/>;`)).toEqual([]);
    expect(css(".scope .label { font-size: var(--moco-text-caption); line-height: var(--moco-leading-caption); }")).toHaveLength(2);
    expect(css(".scope :is(.alert__description, .card__description, .table__column) { @apply text-sm; }")).toHaveLength(1);
    expect(css(".scope .alert__title { font-size: var(--moco-text-heading); line-height: var(--moco-leading-heading); }")).toHaveLength(2);
    expect(css(".button.moco-message-action { font-size: var(--moco-text-caption); line-height: var(--moco-leading-caption); }")).toEqual([]);
    expect(css(".scope .label { font: inherit; }")).toHaveLength(1);
    expect(css(".label .content { font-size: var(--moco-text-caption); line-height: var(--moco-leading-caption); }")).toEqual([]);
  });

  it("blocks local CSS overrides on the actual overlay heading rather than its descendants", () => {
    expect(css(".dialog .modal__heading { font-size: var(--moco-text-body); line-height: var(--moco-leading-body); }")).toHaveLength(2);
    expect(css(".drawer__heading:hover { font-size: var(--moco-text-caption); }")).toHaveLength(1);
    expect(css(".scope :is(.modal__heading, .alert-dialog__heading) { @apply text-sm; }")).toHaveLength(1);
    expect(css(".modal__heading .label { font-size: var(--moco-text-body); line-height: var(--moco-leading-body); }")).toEqual([]);
    expect(css(".label:has(.modal__heading) { font-size: var(--moco-text-body); }")).toEqual([]);
    expect(css(".modal__heading, .alert-dialog__heading { font-size: var(--moco-text-heading); line-height: var(--moco-leading-heading); }")).toEqual([]);
  });

  it("rejects inline typography, referenced/spread styles and direct SVG font-size attributes", () => {
    expect(jsx(`const size = { fontSize: 13 }; const shared = { ...size, lineHeight: '21px' };
      const view = <><div style={shared}/><div style={{ font: '13px/21px system-ui' }}/>
      <div style={{ ['font' + 'Size']: 13 }}/><div style={{ '--moco-text-body': '13px' }}/>
      <svg><text fontSize={13}/></svg></>;`)).toHaveLength(6);
    expect(jsx(`<div style={{ color: 'var(--foreground)', width: 16, fontFamily: 'monospace' }}/>`)).toEqual([]);
  });
});
