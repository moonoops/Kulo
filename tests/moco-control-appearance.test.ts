import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditControlContractSafety, auditCssControlAppearance, auditHeroUiControlSlots, auditJsxControlAppearance } from "./helpers/control-appearance";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSource = path.join(repoRoot, "packages/web/src");
const imports = 'import { Button, Input, TextArea, TextField, Select, ComboBox, NumberField, SearchField, InputGroup, Switch } from "@heroui/react";';
const audit = (jsx: string, file = "view.tsx") => auditJsxControlAppearance(`${imports}\n${jsx}`, file).violations;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return /\.(tsx|css)$/.test(file) && !/\.(test|spec)\.tsx$/.test(file) ? [file] : [];
  });
}

describe("shared control appearance ownership", () => {
  it("keeps production controls on the shared appearance in JSX and feature CSS", () => {
    const files = sourceFiles(webSource);
    const classes = new Set<string>();
    const violations = files.filter((file) => file.endsWith(".tsx")).flatMap((file) => {
      const result = auditJsxControlAppearance(fs.readFileSync(file, "utf8"), path.relative(repoRoot, file));
      result.controlClasses.forEach((name) => classes.add(name));
      return result.violations;
    });
    // These files independently own the shared visual, density and focus contracts.
    const sharedOwners = new Set(["moco-controls.css", "moco-typography.css", "moco-focus.css"]);
    violations.push(...files.filter((file) => file.endsWith(".css") && !sharedOwners.has(path.relative(webSource, file))).flatMap((file) =>
      auditCssControlAppearance(fs.readFileSync(file, "utf8"), path.relative(repoRoot, file), classes)));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("loads the contract after HeroUI and applies it through the body to Portals", () => {
    const entry = fs.readFileSync(path.join(webSource, "moco.css"), "utf8");
    const document = fs.readFileSync(path.join(webSource, "../index.html"), "utf8");
    expect(entry.indexOf('@import "./moco-controls.css";')).toBeGreaterThan(entry.indexOf('@import "@heroui/styles";'));
    expect(document).toMatch(/<body\b[^>]*\bclass=["'][^"']*\bmoco-ui\b/);
    const controls = fs.readFileSync(path.join(webSource, "moco-controls.css"), "utf8");
    expect(controls).toMatch(/@layer\s+components\b/);
    expect(auditControlContractSafety(controls)).toEqual([]);
  });

  it("uses real installed HeroUI BEM slots rather than guessed component names", () => {
    const webRequire = createRequire(path.join(webSource, "../package.json"));
    const installed = path.join(path.dirname(webRequire.resolve("@heroui/styles/package.json")), "dist/components");
    const styles = fs.readdirSync(installed).filter((name) => name.endsWith(".css"))
      .map((name) => fs.readFileSync(path.join(installed, name), "utf8")).join("\n");
    const controls = fs.readFileSync(path.join(webSource, "moco-controls.css"), "utf8");
    expect(auditHeroUiControlSlots(controls, styles)).toEqual([]);
    for (const invalid of ["popover__content", "number-field__button", "switch__track"]) {
      expect(auditHeroUiControlSlots(controls + `\n.moco-ui .${invalid} { border-radius: 1px; }`, styles))
        .toContainEqual(expect.stringContaining(`.${invalid} is not an installed HeroUI styling slot`));
    }
    expect(auditHeroUiControlSlots(controls + '\n/* .popover__content {} */', styles)).toEqual([]);
  });

  it("accepts layout, typography and semantic variants without repainting", () => {
    expect(audit(`<><Button variant="danger" className="moco-message-action shrink-0 text-xs"/>
      <Button variant="outline" className="min-w-0 justify-start px-3"/>
      <Input variant="secondary" className="moco-form-field font-mono"/>
      <Switch isSelected><Switch.Control><Switch.Thumb/></Switch.Control></Switch></>`)).toEqual([]);
  });

  it.each(["bg-blue-500", "dark:bg-white/10", "hover:text-accent", "rounded-full", "border-0", "border-border", "shadow-none", "data-[pressed=true]:shadow-md", "[--button-fg:red]", "[--default:red]", "[--border-width-field:0px]", "[border-radius:99px]"])
    ("rejects local appearance utility %s on standard controls", (token) => {
      expect(audit(`<Button className="${token}"/>`)).toHaveLength(1);
    });

  it.each(["Input", "TextArea", "TextField", "Select", "Select.Trigger", "ComboBox.InputGroup", "NumberField.Group", "SearchField.Group", "InputGroup", "Switch.Control", "Switch.Thumb"])
    ("checks the %s owning or visual slot", (tag) => {
      expect(audit(`<${tag} className="bg-accent rounded-full"/>`)).toHaveLength(1);
    });

  it("checks every conditional or constant class branch", () => {
    expect(audit('const classes = active ? "text-sm" : "hover:bg-blue-500"; const view = <Button className={classes}/>;')).toHaveLength(1);
    expect(audit('const view = <Button className={`moco-action ${active ? "border-0" : ""}`}/>;')).toHaveLength(1);
    expect(audit('const classes = "text-sm" + " shadow-md"; const view = <Button className={classes}/>;')).toHaveLength(1);
  });

  it("resolves HeroUI aliases and namespaces without claiming domain components", () => {
    const source = 'import { Button as Action } from "@heroui/react"; import * as Hero from "@heroui/react"; import { Button } from "./domain";'
      + 'const view = <><Action className="rounded-full"/><Hero.Switch.Control className="bg-blue-500"/><Button className="bg-blue-500"/></>;';
    expect(auditJsxControlAppearance(source, "aliases.tsx").violations).toHaveLength(2);
  });

  it("rejects direct, constant and conditional inline repainting", () => {
    expect(audit('<Button style={{ color: "blue", borderRadius: 20 }}/>')).toHaveLength(2);
    expect(audit('const appearance = { boxShadow: "none" }; const view = <Input style={appearance}/>;')).toHaveLength(1);
    expect(audit('<Switch.Control style={active ? { backgroundColor: "blue" } : { backgroundColor: "gray" }}/>')).toHaveLength(2);
    expect(audit('<Button style={{ marginInlineStart: "auto" }}/>')).toEqual([]);
  });

  it("limits transparent identity document editor utilities to its real owner and exact properties", () => {
    const editor = '<TextArea variant="secondary" className="moco-identity-textarea border-0 bg-transparent shadow-none"/>';
    expect(audit(editor, "packages/web/src/identity-document-editor.tsx")).toEqual([]);
    expect(audit(editor)).toHaveLength(1);
    expect(audit(editor.replace("TextArea", "Input"), "packages/web/src/identity-document-editor.tsx")).toHaveLength(1);
    expect(audit(editor.replace("shadow-none", "rounded-full"), "packages/web/src/identity-document-editor.tsx")).toHaveLength(1);
  });

  it("detects feature CSS repainting through BEM, custom classes and apply", () => {
    const classes = auditJsxControlAppearance(`${imports}\nconst view = <Button className="moco-custom-action"/>;`, "view.tsx").controlClasses;
    expect(auditCssControlAppearance('.moco-custom-action { border-radius: 30px; --button-fg: blue; }', "view.css", classes)).toHaveLength(1);
    expect(auditCssControlAppearance('.button--secondary { color: blue; }', "view.css", classes)).toHaveLength(1);
    expect(auditCssControlAppearance('.textfield { --default: blue; --radius-field: 30px; }', "view.css", classes)).toHaveLength(1);
    expect(auditCssControlAppearance('.moco-custom-action { @apply bg-blue-500 rounded-full; }', "view.css", classes)).toHaveLength(1);
    expect(auditCssControlAppearance('.moco-custom-action { margin-inline-start: auto; width: 100%; }', "view.css", classes)).toEqual([]);
  });

  it("distinguishes control targets from parent surfaces, child icons and selector context", () => {
    const classes = new Set(["moco-action"]);
    expect(auditCssControlAppearance('.panel:has(.button) { background: var(--surface); } .button .mc-icon { color: var(--danger); }', "view.css", classes)).toEqual([]);
    expect(auditCssControlAppearance('.moco-ui :is(.button, .moco-action):not(.unrelated) { color: blue; }', "view.css", classes)).toHaveLength(1);
    expect(auditCssControlAppearance('.button:not([data-invalid="true"]) { background: blue; }', "view.css", classes)).toHaveLength(1);
  });

  it("limits domain-surface CSS exceptions by class, source and property", () => {
    const classes = new Set(["moco-chat-image-trigger", "moco-task-card-button", "moco-agent-profile-overview"]);
    const crop = '.moco-chat-image-gallery:not([data-count="1"]) .moco-chat-image-trigger { border-radius: 12px; }';
    expect(auditCssControlAppearance(crop, "packages/web/src/features/chat/chat-content.css", classes)).toEqual([]);
    expect(auditCssControlAppearance(crop, "view.css", classes)).toHaveLength(1);
    expect(auditCssControlAppearance('.moco-chat-image-trigger { --button-fg: blue; }', "packages/web/src/features/chat/chat-content.css", classes)).toHaveLength(1);
    expect(auditCssControlAppearance('.moco-task-card-button, .button { background: blue; }', "packages/web/src/features/tasks/task-rail.css", classes)).toHaveLength(1);
    expect(auditCssControlAppearance('.moco-agent-profile-overview { background: blue; border-radius: 14px; }', "packages/web/src/features/topics/agent-terminal.css", classes)).toHaveLength(1);
  });

  it("keeps shared styles scoped and preserves library state and motion ownership", () => {
    expect(auditControlContractSafety('@layer components { .moco-ui .button { --button-fg: var(--foreground); } }')).toEqual([]);
    expect(auditControlContractSafety('.button { color: var(--foreground); }')).toContainEqual(expect.stringContaining("Unscoped"));
    expect(auditControlContractSafety('.moco-ui-other .button { color: var(--foreground); }')).toContainEqual(expect.stringContaining("Unscoped"));
    for (const declaration of ['--focus: red', 'opacity: 1', 'pointer-events: auto', 'transition: none', 'transform: none', '--tw-ring-shadow: none', 'outline: 0']) {
      expect(auditControlContractSafety(`.moco-ui .button { ${declaration}; }`)).toContainEqual(expect.stringContaining("preserve library"));
    }
    expect(auditControlContractSafety('.moco-ui .button { --button-fg: #1677ff; }')).toContainEqual(expect.stringContaining("semantic colors"));
    expect(auditControlContractSafety('.moco-ui { --accent: var(--foreground); }')).toContainEqual(expect.stringContaining("root accent"));
  });
});
