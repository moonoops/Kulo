import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = path.join(repoRoot, "packages/web/src");
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return /\.(css|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx$/.test(entry.name) ? [file] : [];
  });
}

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((prop): prop is ts.JsxAttribute =>
    ts.isJsxAttribute(prop) && prop.name.getText() === name);
}

function initializer(identifier: ts.Identifier): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      const declaration = statement.declarationList.declarations.find((candidate) =>
        ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text);
      if (declaration) return declaration.initializer;
    }
  }
  return undefined;
}

function classOptions(value: ts.Node | undefined, seen = new Set<ts.Node>()): string[] | undefined {
  if (!value || seen.has(value)) return undefined;
  const next = new Set(seen).add(value);
  if (ts.isStringLiteralLike(value)) return [value.text];
  if (ts.isJsxExpression(value)) return classOptions(value.expression, next);
  if (ts.isParenthesizedExpression(value)) return classOptions(value.expression, next);
  if (ts.isIdentifier(value)) return classOptions(initializer(value), next);
  if (ts.isConditionalExpression(value)) {
    const yes = classOptions(value.whenTrue, next);
    const no = classOptions(value.whenFalse, next);
    return yes && no ? [...yes, ...no] : undefined;
  }
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = classOptions(value.left, next);
    const right = classOptions(value.right, next);
    return left && right ? left.flatMap((prefix) => right.map((suffix) => prefix + suffix)) : undefined;
  }
  if (ts.isTemplateExpression(value)) {
    let options = [value.head.text];
    for (const span of value.templateSpans) {
      const additions = classOptions(span.expression, next);
      if (!additions) return undefined;
      options = options.flatMap((prefix) => additions.map((addition) => prefix + addition + span.literal.text));
    }
    return options;
  }
  return undefined;
}

function utility(token: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    if (token[index] === "[" || token[index] === "(") depth++;
    else if (token[index] === "]" || token[index] === ")") depth--;
    else if (token[index] === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!|!$/g, "");
}

function addedPadding(token: string): boolean {
  const name = utility(token);
  return /^p[trblxyse]?-/.test(name) && !/^p[trblxyse]?-0$/.test(name)
    || /^\[padding(?:-[\w-]+)?:/.test(name);
}

function auditPopoverPadding(source: string, fileName: string) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@heroui/react" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (!binding.isTypeOnly) imports.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
    }
  }
  const violations: string[] = [];
  const contentClasses = new Set<string>();
  let contentCount = 0;
  function report(node: Opening, message: string) {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${fileName}:${line + 1} <${node.tagName.getText(file)}> ${message}`);
  }
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const [head, ...members] = node.tagName.getText(file).split(".");
      const name = namespaces.has(head!) ? members.join(".") : [imports.get(head!), ...members].join(".");
      if (name === "Popover.Content" || name === "PopoverContent") {
        contentCount++;
        const className = attribute(node, "className");
        const options = className ? classOptions(className.initializer) : [""];
        if (!options) report(node, "must use statically inspectable classes so Dialog owns padding.");
        for (const option of options ?? []) {
          const tokens = option.split(/\s+/).filter(Boolean);
          tokens.forEach((token) => contentClasses.add(token));
          const padding = tokens.filter(addedPadding);
          if (padding.length) report(node, `must leave padding to Popover.Dialog; found ${padding.join(" ")}.`);
        }
        const style = attribute(node, "style")?.initializer;
        if (style && /\bpadding(?:Top|Bottom|Left|Right|Block|Inline|BlockStart|BlockEnd|InlineStart|InlineEnd)?\s*:/.test(style.getText(file))) {
          report(node, "must leave inline padding to Popover.Dialog.");
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { violations, contentClasses, contentCount };
}

function auditCssPadding(source: string, fileName: string, contentClasses: ReadonlySet<string>): string[] {
  const known = new Set([...contentClasses, "popover"]);
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const violations: string[] = [];
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!.trim();
    const targetsContent = selector.split(",").some((part) => {
      const target = part.trim().split(/[\s>+~]+/).at(-1) ?? "";
      return [...target.matchAll(/\.([\w-]+)/g)].some((match) => known.has(match[1]!));
    });
    if (!targetsContent) continue;
    const body = rule[2]!;
    const padding = [...body.matchAll(/(?:^|;)\s*(padding(?:-[\w-]+)?)\s*:\s*([^;]+)/g)]
      .filter((match) => !/^(?:0(?:px|rem|em|%)?\s*)+(?:!important)?$/.test(match[2]!.trim()))
      .map((match) => `${match[1]}: ${match[2]!.trim()}`);
    for (const apply of body.matchAll(/@apply\s+([^;]+);/g)) padding.push(...apply[1]!.split(/\s+/).filter(addedPadding));
    if (padding.length) violations.push(`${fileName}:${clean.slice(0, rule.index).split("\n").length} ${selector} must leave padding to Popover.Dialog; found ${padding.join(", ")}.`);
  }
  return violations;
}

const jsx = (view: string) => auditPopoverPadding(`import { Popover } from "@heroui/react";\n${view}`, "view.tsx");

describe("Popover padding ownership", () => {
  it("keeps production Content unpadded so Dialog supplies exactly one inset", () => {
    const files = sourceFiles(webSrc).map((file) => ({ name: path.relative(repoRoot, file), source: fs.readFileSync(file, "utf8") }));
    const audits = files.filter((file) => file.name.endsWith(".tsx")).map((file) => auditPopoverPadding(file.source, file.name));
    expect(audits.reduce((total, audit) => total + audit.contentCount, 0)).toBeGreaterThan(0);
    const classes = new Set(audits.flatMap((audit) => [...audit.contentClasses]));
    const violations = [...audits.flatMap((audit) => audit.violations),
      ...files.filter((file) => file.name.endsWith(".css")).flatMap((file) => auditCssPadding(file.source, file.name, classes))];
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("allows sizing on Content and spacing on Dialog or its children", () => {
    expect(jsx('<Popover.Content className="w-80 max-w-full p-0"><Popover.Dialog className="p-4"><div className="px-2"/></Popover.Dialog></Popover.Content>').violations).toEqual([]);
    expect(jsx('<Popover.Content><Popover.Dialog/></Popover.Content>').violations).toEqual([]);
  });

  it.each(["p-4", "px-2", "md:py-3", "!ps-2", "lg:pe-4!", "[padding:16px]", "sm:[padding-inline:12px]"])("rejects added Content inset: %s", (padding) => {
    expect(jsx(`<Popover.Content className="w-80 ${padding}"/>`).violations).toHaveLength(1);
  });

  it("resolves constants, conditional branches, concatenation and template classes", () => {
    expect(jsx('const spacing = compact ? "p-0" : "p-4"; const view = <Popover.Content className={`w-80 ${spacing}`}/>;').violations).toHaveLength(1);
    expect(jsx('const width = "w-" + "80"; const view = <Popover.Content className={width}/>;').violations).toEqual([]);
    expect(jsx('<Popover.Content className={unknownClasses}/>').violations).toHaveLength(1);
  });

  it("resolves HeroUI aliases and namespaces without checking domain popovers", () => {
    const audit = auditPopoverPadding(`import { Popover as Hint, PopoverContent as Content } from "@heroui/react";
      import * as Hero from "@heroui/react"; import { Popover } from "./domain";
      const view = <><Hint.Content className="p-4"/><Hero.Popover.Content className="p-2"/><Content className="p-3"/><Popover.Content className="p-4"/></>;`, "aliases.tsx");
    expect(audit.contentCount).toBe(3);
    expect(audit.violations).toHaveLength(3);
  });

  it("rejects inline padding even if classes do not add it", () => {
    expect(jsx('<Popover.Content style={{ paddingInline: 16 }}/>').violations).toHaveLength(1);
  });

  it("catches CSS and @apply that restore an inset on Content", () => {
    for (const css of [".local-popover { padding:16px; }", ".kulo-ui .popover { padding-inline:8px; }", "@media (min-width:600px) { .wrapper .local-popover { @apply p-4; } }"]) {
      expect(auditCssPadding(css, "style.css", new Set(["local-popover"]))).toHaveLength(1);
    }
  });

  it("allows zero Content padding, Dialog padding and descendant spacing", () => {
    expect(auditCssPadding(".local-popover { width:360px; padding:0; } .popover__dialog { padding:16px; } .local-popover .item { padding:8px; }", "style.css", new Set(["local-popover"]))).toEqual([]);
  });
});
