import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrcDir = path.join(repoRoot, "packages/web/src");
const fieldOwners = new Set(["TextField", "Select", "ComboBox", "NumberField", "SearchField"]);
const fieldLayouts = new Set(["moco-settings-row", "moco-form-field", "moco-context-field", "moco-compact-row"]);
const legacyLayouts = new Set([
  "moco-setting-row", "moco-preference-row", "moco-runtime-setting-row",
  "moco-model-setting-row", "moco-agent-field-row", "moco-agent-switch-row",
]);
const visualSlots = new Set([
  "Input", "TextArea", "InputGroup", "Select.Trigger", "ComboBox.InputGroup",
  "NumberField.Group", "NumberField.Input", "SearchField.Group", "SearchField.Input",
]);
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return entry.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(entry.name) ? [file] : [];
  });
}

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((prop): prop is ts.JsxAttribute =>
    ts.isJsxAttribute(prop) && prop.name.getText() === name);
}

function parse(source: string, fileName: string) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@heroui/react" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly) imports.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
      }
    }
  }

  function heroName(node: Opening): string | undefined {
    const [head, ...members] = node.tagName.getText(file).split(".");
    if (namespaces.has(head!)) return members.join(".");
    const imported = imports.get(head!);
    return imported ? [imported, ...members].join(".") : undefined;
  }
  return { file, heroName };
}

function classValues(value: ts.Node | undefined, file: ts.SourceFile, seen = new Set<ts.Node>()): string[] | undefined {
  if (!value || seen.has(value)) return undefined;
  const next = new Set(seen).add(value);
  if (ts.isStringLiteralLike(value)) return [value.text];
  if (ts.isJsxExpression(value)) return classValues(value.expression, file, next);
  if (ts.isParenthesizedExpression(value)) return classValues(value.expression, file, next);
  if (ts.isConditionalExpression(value)) {
    const yes = classValues(value.whenTrue, file, next);
    const no = classValues(value.whenFalse, file, next);
    return yes && no ? [...yes, ...no] : undefined;
  }
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = classValues(value.left, file, next);
    const right = classValues(value.right, file, next);
    return left && right ? left.flatMap((a) => right.map((b) => a + b)) : undefined;
  }
  if (ts.isTemplateExpression(value)) {
    let values = [value.head.text];
    for (const span of value.templateSpans) {
      const additions = classValues(span.expression, file, next);
      if (!additions) return undefined;
      values = values.flatMap((prefix) => additions.map((addition) => prefix + addition + span.literal.text));
    }
    return values;
  }
  if (ts.isIdentifier(value)) {
    let scope: ts.Node | undefined = value.parent;
    while (scope) {
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
        const declarations: ts.VariableDeclaration[] = [];
        for (const statement of scope.statements) {
          if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === value.text) declarations.push(declaration);
          }
        }
        if (declarations.length === 1) return classValues(declarations[0]!.initializer, file, next);
      }
      scope = scope.parent;
    }
  }
  return undefined;
}

function fixedWidth(token: string): boolean {
  const utility = token.split(":").at(-1)!.replace(/^!/, "").replace(/!$/, "");
  if (["w-full", "min-w-0", "max-w-full", "max-w-none"].includes(utility)) return false;
  return /^(?:min-|max-)?w-/.test(utility)
    || /\[(?:min-|max-)?(?:width|inline-size):/.test(token)
    || /^(?:size|min-size|max-size)-/.test(utility);
}

/** Layout ownership is static; alignment, reflow and focus still need browser checks. */
function auditFormLayout(source: string, fileName: string): string[] {
  const { file, heroName } = parse(source, fileName);
  const violations: string[] = [];
  function report(node: Opening, message: string) {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${fileName}:${line + 1}:${character + 1} <${node.tagName.getText(file)}> ${message}`);
  }
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = heroName(node)?.replace(/\.Root$/, "");
      const classes = classValues(attribute(node, "className")?.initializer, file);
      const owner = Boolean(name && fieldOwners.has(name));
      if (owner && (!classes || classes.some((value) => value.split(/\s+/).filter((token) => fieldLayouts.has(token)).length !== 1))) {
        report(node, "must choose one shared layout on every branch: moco-settings-row, moco-form-field, moco-context-field or moco-compact-row.");
      }
      if (owner || name && visualSlots.has(name)) {
        const widths = classes?.flatMap((value) => value.split(/\s+/).filter(fixedWidth)) ?? [];
        if (widths.length) report(node, `must leave control width to its shared layout; found ${[...new Set(widths)].join(", ")}.`);
        const inlineStyle = attribute(node, "style")?.initializer;
        if (inlineStyle && /\b(?:width|minWidth|maxWidth|inlineSize|minInlineSize|maxInlineSize)\s*:/.test(inlineStyle.getText(file))) {
          report(node, "must leave inline control width to its shared layout.");
        }
      }
      for (const prop of node.attributes.properties) {
        if (!ts.isJsxAttribute(prop) || !["className", "fieldClassName"].includes(prop.name.getText(file))) continue;
        const values = classValues(prop.initializer, file) ?? [];
        if (values.some((value) => value.split(/\s+/).some((token) => legacyLayouts.has(token)))) {
          report(node, "uses a retired per-page field layout.");
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}

function hasDialog(source: string, fileName: string): boolean {
  const { file, heroName } = parse(source, fileName);
  let result = false;
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && /^(?:Modal|Drawer|AlertDialog)\.Dialog$/.test(heroName(node) ?? "")) result = true;
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

const imports = 'import { TextField, Input, TextArea, Select, ComboBox, NumberField, SearchField } from "@heroui/react";';
const audit = (jsx: string) => auditFormLayout(`${imports}\n${jsx}`, "field.tsx");

describe("global form layout guard", () => {
  it("loads the shared 320px control column and reflows inside the settings container", () => {
    const entry = fs.readFileSync(path.join(webSrcDir, "moco.css"), "utf8");
    const layout = fs.readFileSync(path.join(webSrcDir, "moco-forms.css"), "utf8");
    expect(entry).toMatch(/@import\s+["']\.\/moco-forms\.css["']/);
    expect(layout).toMatch(/--moco-settings-control-width\s*:\s*320px\s*;/);
    expect(layout).toMatch(/container\s*:\s*moco-settings-fields\s*\/\s*inline-size/);
    expect(layout).toMatch(/grid-template-columns\s*:[^;]*var\(--moco-settings-control-width\)/);
    expect(layout).toMatch(/@container\s+moco-settings-fields\s*\(max-width:\s*640px\)/);
    expect(layout).toMatch(/\.moco-settings-row:not\(\.moco-settings-row--toggle\)\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("requires all settings, project and dialog fields to own their layout", () => {
    const files = sourceFiles(webSrcDir).map((file) => ({ file, source: fs.readFileSync(file, "utf8") }));
    const scoped = files.filter(({ file, source }) => {
      const relative = path.relative(webSrcDir, file).replaceAll(path.sep, "/");
      return relative.startsWith("features/settings/") || relative.startsWith("features/projects/")
        || relative === "features/topics/conversation-model-settings.tsx" || relative === "identity-document-editor.tsx"
        || hasDialog(source, file);
    });
    expect(scoped.length).toBeGreaterThan(20);
    const violations = scoped.flatMap(({ file, source }) => auditFormLayout(source, path.relative(repoRoot, file)));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("keeps immediate preferences independent of the settings-page stacking threshold", () => {
    const layout = fs.readFileSync(path.join(webSrcDir, "moco-forms.css"), "utf8");
    expect(layout).toMatch(/container\s*:\s*moco-compact-fields\s*\/\s*inline-size/);
    expect(layout).toMatch(/\.moco-compact-row\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*var\(--moco-compact-label-width\)\)\s+minmax\(0,\s*1fr\)/);
    expect(layout).toMatch(/\.moco-compact-row\s*\{[^}]*min-height\s*:\s*var\(--moco-control-height\)/);
    expect(layout).toMatch(/\.moco-compact-row--choice\s*>\s*\.select__trigger\s*\{[^}]*width\s*:\s*fit-content/);
    expect(layout).toMatch(/@container\s+moco-compact-fields\s*\(max-width:\s*240px\)/);
    expect(layout).toMatch(/\.moco-compact-row:not\(\.moco-compact-row--toggle\)\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(layout).toMatch(/\.moco-compact-row--toggle\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s+auto/);
  });

  it("keeps numeric units compact and manual save actions beside their own configuration", () => {
    const layout = fs.readFileSync(path.join(webSrcDir, "moco-forms.css"), "utf8");
    const entry = fs.readFileSync(path.join(webSrcDir, "moco.css"), "utf8");
    expect(layout).toMatch(/--moco-settings-number-width\s*:\s*128px/);
    expect(layout).toMatch(/\.moco-field-with-unit\s*\{[^}]*display:\s*flex/);
    const savebar = entry.match(/\.moco-settings-savebar\s*\{([^}]*)\}/)?.[1];
    expect(savebar).toBeDefined();
    expect(savebar).toContain("var(--moco-control-height)");
    expect(savebar).toMatch(/flex-wrap:\s*wrap/);
    expect(savebar).not.toMatch(/margin-top:\s*auto|(?:min-)?height:\s*(?:72|80)px/);
  });

  it("accepts each task layout and full-width visual slots", () => {
    expect(audit(`<><TextField className="moco-settings-row" fullWidth><Input className="w-full min-w-0"/></TextField>
      <Select className="moco-form-field"><Select.Trigger className="w-full"/></Select>
      <SearchField className="moco-context-field"/><NumberField className="moco-settings-row moco-settings-row--number"/>
      <ComboBox className="moco-form-field"><ComboBox.InputGroup className="min-w-0"/></ComboBox>
      <Select className="moco-compact-row moco-compact-row--choice"/></>`)).toEqual([]);
  });

  it("reports missing and conflicting layout ownership at the actual field", () => {
    const violations = audit(`<><TextField/><Select className="min-w-0"/><ComboBox className="moco-form-field moco-settings-row"/>
      <Select className="moco-compact-row moco-settings-row"/></>`);
    expect(violations).toHaveLength(4);
    expect(violations[0]).toMatch(/^field\.tsx:2:\d+ <TextField> must choose one shared layout/);
  });

  it("checks every branch of a shared constant instead of exempting dynamic classes", () => {
    expect(audit(`function Fields() { const fieldClass = row ? "moco-settings-row" : "moco-form-field";
      return <Select className={fieldClass}/>; }`)).toEqual([]);
    expect(audit(`function Fields() { const fieldClass = row ? "moco-settings-row" : "";
      return <Select className={fieldClass}/>; }`)).toHaveLength(1);
    expect(audit(`<TextField className={unknownClasses}/>`)).toHaveLength(1);
    expect(audit(`<TextField {...props}/>`)).toHaveLength(1);
  });

  it.each([...legacyLayouts])("rejects the retired %s layout even beside an accepted class", (layout) => {
    expect(audit(`<TextField className="moco-form-field ${layout}"/>`)).toHaveLength(1);
  });

  it.each(["w-80", "sm:max-w-md", "md:w-[224px]", "min-w-48", "[width:160px]", "size-80"])
    ("rejects local control sizing: %s", (className) => {
      expect(audit(`<TextField className="moco-form-field ${className}"/>`)).toHaveLength(1);
      expect(audit(`<Select className="moco-form-field"><Select.Trigger className="${className}"/></Select>`)).toHaveLength(1);
    });

  it("finds a width on conditional visual slots and inline styles", () => {
    expect(audit(`<ComboBox className="moco-form-field"><ComboBox.InputGroup className={compact ? "min-w-0" : "max-w-md"}/></ComboBox>`)).toHaveLength(1);
    expect(audit(`<TextField className="moco-form-field" style={{ width: 320 }}/>`)).toHaveLength(1);
  });

  it("allows real compound columns and attached actions on the parent", () => {
    expect(audit(`<div className="moco-form-grid grid-cols-[1fr_96px]"><TextField className="moco-form-field"/>
      <div className="moco-field-action-row"><TextField className="moco-form-field flex-1"/><button/></div></div>`)).toEqual([]);
  });

  it("resolves HeroUI aliases and namespaces without flagging domain components", () => {
    const source = `import { TextField as Field, Select as Picker } from "@heroui/react";
      import * as Hero from "@heroui/react"; import { TextField } from "./domain";
      const view = <><Field/><Picker className="moco-form-field"/><Hero.ComboBox/><TextField/></>;`;
    expect(auditFormLayout(source, "aliases.tsx")).toHaveLength(2);
  });

  it("discovers newly introduced dialog files through aliases", () => {
    expect(hasDialog('import { Modal as Editor } from "@heroui/react"; const view = <Editor.Dialog/>;', "new.tsx")).toBe(true);
    expect(hasDialog('import * as Hero from "@heroui/react"; const view = <Hero.Drawer.Dialog/>;', "new.tsx")).toBe(true);
    expect(hasDialog('import { Modal } from "./domain"; const view = <Modal.Dialog/>;', "domain.tsx")).toBe(false);
  });
});
