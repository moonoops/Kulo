import ts from "typescript";

interface CssRule {
  selector: string;
  body: string;
  start: number;
  conditional: boolean;
}

const scrollbarUtilities = new Set(["scrollbar", "scrollbar-thin", "scrollbar-default", "scrollbar-none"]);
const overflowUtility = /^(.*:)?overflow-(?:[xy]-)?(?:auto|scroll)$/;
const scrollingDeclaration = /(?:^|;)\s*overflow(?:-[xy])?\s*:\s*(?:auto|scroll)\b/;

function appliedScrollbar(body: string): boolean {
  return [...body.matchAll(/@apply\s+([^;]+);/g)].some((match) =>
    match[1]?.split(/\s+/).some((token) => scrollbarUtilities.has(token)));
}

// Only leaf rules are needed here. Keep offsets while discarding comments, and
// do not treat conditional or descendant selectors as globally styled classes.
function cssRules(source: string): CssRule[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const stack: Array<{ selector: string; start: number; bodyStart: number; conditional: boolean; hasChildren: boolean }> = [];
  const rules: CssRule[] = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "{") {
      const selector = clean.slice(start, index).trim();
      const parent = stack.at(-1);
      if (parent) parent.hasChildren = true;
      const conditional = Boolean(parent?.conditional || parent && !/^@layer\b/.test(parent.selector) || selector.startsWith("@") && !/^@layer\b/.test(selector));
      stack.push({ selector, start: start + clean.slice(start, index).search(/\S/), bodyStart: index + 1, conditional, hasChildren: false });
      start = index + 1;
    } else if (char === "}") {
      const rule = stack.pop();
      if (rule && !rule.hasChildren && !rule.selector.startsWith("@")) {
        rules.push({ selector: rule.selector, body: clean.slice(rule.bodyStart, index), start: rule.start, conditional: rule.conditional });
      }
      start = index + 1;
    } else if (char === ";") start = index + 1;
  }
  return rules;
}

export function scrollbarStyledClasses(sources: readonly string[]): Set<string> {
  const classes = new Set<string>();
  for (const source of sources) {
    for (const rule of cssRules(source)) {
      if (rule.conditional || !appliedScrollbar(rule.body)) continue;
      for (const selector of rule.selector.split(",")) {
        const match = selector.trim().match(/^\.([\w-]+)$/);
        if (match?.[1]) classes.add(match[1]);
      }
    }
  }
  return classes;
}

function location(source: string, start: number, fileName: string): string {
  return `${fileName}:${source.slice(0, start).split("\n").length}`;
}

export function auditCssScrollbars(source: string, fileName: string, styledClasses: ReadonlySet<string>): string[] {
  return cssRules(source).flatMap((rule) => {
    if (!scrollingDeclaration.test(rule.body) || appliedScrollbar(rule.body)) return [];
    const selectors = rule.selector.split(",").map((selector) => selector.trim());
    if (selectors.every((selector) => {
      const match = selector.match(/^\.([\w-]+)$/);
      return Boolean(match?.[1] && styledClasses.has(match[1]));
    })) return [];
    return [`${location(source, rule.start, fileName)} ${rule.selector} must apply a HeroUI scrollbar utility on its scroll slot.`];
  });
}

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText() === name);
}

function combinations(left: string[], right: string[]): string[] {
  return left.flatMap((prefix) => right.map((suffix) => prefix + suffix));
}

function classOptions(expression: ts.Expression): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression)) return classOptions(expression.expression);
  if (ts.isConditionalExpression(expression)) return [...classOptions(expression.whenTrue), ...classOptions(expression.whenFalse)];
  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.reduce((options, span) =>
      combinations(options, classOptions(span.expression)).map((option) => option + span.literal.text), [expression.head.text]);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return combinations(classOptions(expression.left), classOptions(expression.right));
  }
  if (ts.isArrowFunction(expression) && !ts.isBlock(expression.body)) return classOptions(expression.body);
  // Unknown additions cannot establish a scrollbar contract for a known slot.
  return [""];
}

function classes(node: Opening): string[] {
  const value = attribute(node, "className")?.initializer;
  if (value && ts.isStringLiteral(value)) return [value.text];
  if (value && ts.isJsxExpression(value) && value.expression) return classOptions(value.expression);
  return [""];
}

function hiddenFileInput(node: Opening): boolean {
  const type = attribute(node, "type")?.initializer;
  if (node.tagName.getText() !== "input" || !type || !ts.isStringLiteral(type) || type.text !== "file") return false;
  const hidden = attribute(node, "hidden");
  return Boolean(hidden && (!hidden.initializer || ts.isJsxExpression(hidden.initializer) && hidden.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword)
    || classes(node).every((option) => option.split(/\s+/).includes("hidden")));
}

export function auditJsxScrollbars(source: string, fileName: string, styledClasses: ReadonlySet<string>): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@heroui/react" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) if (!binding.isTypeOnly) imports.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
    }
  }
  function isTextArea(node: Opening): boolean {
    const [head, ...members] = node.tagName.getText(file).split(".");
    if (!head) return false;
    const name = namespaces.has(head) ? members.join(".") : [imports.get(head), ...members].filter(Boolean).join(".");
    return name === "TextArea" || name === "TextArea.Root" || name === "InputGroup.TextArea";
  }
  const violations: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (hiddenFileInput(node)) return;
      const textArea = isTextArea(node);
      const needsScrollbar = classes(node).some((option) => {
        const tokens = option.trim().split(/\s+/);
        const overflows = tokens.filter((token) => overflowUtility.test(token));
        if (!textArea && !overflows.length) return false;
        if (tokens.some((token) => scrollbarUtilities.has(token) || styledClasses.has(token))) return false;
        return textArea || overflows.some((overflow) => {
          const prefix = overflow.match(overflowUtility)?.[1] ?? "";
          return !prefix || !tokens.some((token) => token.startsWith(prefix) && scrollbarUtilities.has(token.slice(prefix.length)));
        });
      });
      if (needsScrollbar) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        violations.push(`${fileName}:${line + 1} <${node.tagName.getText(file)}> must declare a HeroUI scrollbar utility or use an application class that applies it on this scroll slot.`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}
