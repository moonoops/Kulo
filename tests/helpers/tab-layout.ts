import ts from "typescript";

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
type Slot = "ListContainer" | "List" | "Tab";
const required: Record<Slot, string[]> = {
  ListContainer: ["w-fit", "max-w-full", "min-w-0", "shrink-0"],
  List: ["w-max"],
  Tab: ["w-auto", "shrink-0", "whitespace-nowrap"],
};
const sidebarFile = "packages/web/src/features/topics/topics-sidebar.tsx";
const sidebarRequired: Record<Slot, string[]> = {
  ListContainer: ["kulo-navigation-tabs-container", "w-full", "max-w-full", "min-w-0", "shrink-0"],
  List: ["kulo-navigation-tabs", "w-full"],
  Tab: ["kulo-navigation-tab", "w-0", "min-w-0", "flex-1", "whitespace-nowrap", "gap-2"],
};

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText() === name);
}

function combine(left: string[], right: string[]): string[] {
  return left.flatMap((prefix) => right.map((suffix) => prefix + suffix));
}

function classOptions(expression: ts.Expression): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression)) return classOptions(expression.expression);
  if (ts.isConditionalExpression(expression)) return [...classOptions(expression.whenTrue), ...classOptions(expression.whenFalse)];
  if (ts.isTemplateExpression(expression)) return expression.templateSpans.reduce((options, span) =>
    combine(options, classOptions(span.expression)).map((option) => option + span.literal.text), [expression.head.text]);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return combine(classOptions(expression.left), classOptions(expression.right));
  // Unknown additions cannot establish the required intrinsic sizing contract.
  return [""];
}

function classes(node: Opening): string[] {
  const value = attribute(node, "className")?.initializer;
  if (value && ts.isStringLiteral(value)) return [value.text];
  if (value && ts.isJsxExpression(value) && value.expression) return classOptions(value.expression);
  return [""];
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

function forcedUtility(token: string): boolean {
  const name = utility(token);
  if (/^w-/.test(name)) return !["w-fit", "w-max", "w-auto"].includes(name);
  return /^(?:flex-(?:1|auto|\[|\()|grow(?:-|$)|grid(?:-|$)|basis-(?!auto$)|justify-(?:between|around|evenly|stretch)$)/.test(name);
}

const inlineSizing = new Set(["width", "inlineSize", "flex", "flexGrow", "flexBasis", "gridTemplateColumns"]);

export function auditJsxTabLayout(source: string, fileName: string): { violations: string[]; slotClasses: Set<string>; slotCount: number } {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@heroui/react" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (!binding.isTypeOnly) imports.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
    }
  }
  const violations: string[] = [];
  const slotClasses = new Set<string>();
  let slotCount = 0;
  function report(node: Opening, message: string) {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${fileName}:${line + 1} <${node.tagName.getText(file)}> ${message}`);
  }
  function canonicalTag(node: Opening): (string | undefined)[] {
    const [head, ...members] = node.tagName.getText(file).split(".");
    return head && namespaces.has(head) ? members : [head && imports.get(head), ...members];
  }
  function sidebarSlot(node: Opening): boolean {
    if (fileName.replaceAll("\\", "/") !== sidebarFile) return false;
    // The nearest Tabs root owns the contract; nested usage tabs stay intrinsic.
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isJsxElement(parent) || parent.openingElement === node) continue;
      const tag = canonicalTag(parent.openingElement);
      if (tag.length !== 1 || tag[0] !== "Tabs") continue;
      const marker = attribute(parent.openingElement, "data-kulo-sidebar-tabs");
      return Boolean(marker && !marker.initializer);
    }
    return false;
  }
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const canonical = canonicalTag(node);
      if (canonical?.length === 2 && canonical[0] === "Tabs" && canonical[1] && canonical[1] in required) {
        const slot = canonical[1] as Slot;
        const equalSidebar = sidebarSlot(node);
        const expected = equalSidebar ? sidebarRequired[slot] : required[slot];
        slotCount++;
        for (const option of classes(node)) {
          const tokens = option.trim().split(/\s+/).filter(Boolean);
          tokens.forEach((token) => slotClasses.add(token));
          const missing = expected.filter((token) => !tokens.includes(token));
          if (missing.length) report(node, equalSidebar
            ? `must include ${missing.join(" ")} so the sidebar navigation fills two equal columns.`
            : `must include ${missing.join(" ")} so tabs size to their content and overflow locally.`);
          const forced = tokens.filter((token) => equalSidebar
            ? (forcedUtility(token) || /^(?:w-|min-w-|max-w-|flex-(?:none|initial)$|shrink(?:-|$))/.test(utility(token))) && !expected.includes(token)
            : forcedUtility(token));
          if (forced.length) report(node, equalSidebar
            ? `must not override the equal sidebar sizing: ${forced.join(" ")}.`
            : `must not stretch or distribute tab widths: ${forced.join(" ")}.`);
        }
        const style = attribute(node, "style")?.initializer;
        if (style && ts.isJsxExpression(style) && style.expression && ts.isObjectLiteralExpression(style.expression)) {
          for (const property of style.expression.properties) {
            if (ts.isPropertyAssignment(property) && inlineSizing.has(property.name.getText(file).replace(/^['"]|['"]$/g, ""))) report(node, "must use the tab sizing utilities instead of inline width/flex sizing.");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { violations, slotClasses, slotCount };
}

function forcedDeclaration(property: string, value: string): boolean {
  value = value.replace(/\s*!important\s*$/, "").trim();
  if (property === "width" || property === "inline-size") return !["auto", "fit-content", "max-content"].includes(value);
  if (property === "flex") return !["none", "initial", "0", "0 0 auto", "0 1 auto"].includes(value);
  if (property === "flex-grow") return value !== "0";
  if (property === "flex-basis") return value !== "auto";
  if (property === "grid-template-columns") return true;
  if (property === "display") return /^(?:inline-)?grid$/.test(value);
  return property === "justify-content" && /^(?:space-between|space-around|space-evenly|stretch)$/.test(value);
}

/** Only inspect declarations targeting a tab slot, not full-width panels or ancestors. */
export function auditCssTabLayout(source: string, fileName: string, slotClasses: ReadonlySet<string>): string[] {
  const known = new Set([...slotClasses, "tabs__list-container", "tabs__list", "tabs__tab"]);
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const violations: string[] = [];
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]?.trim() ?? "";
    const body = rule[2] ?? "";
    const targetsSlot = selector.split(",").some((part) => {
      const target = part.trim().split(/[\s>+~]+/).at(-1) ?? "";
      return [...target.matchAll(/\.([\w-]+)/g)].some((match) => known.has(match[1]!));
    });
    if (!targetsSlot) continue;
    const forced = [...body.matchAll(/(?:^|;)\s*(width|inline-size|flex(?:-grow|-basis)?|grid-template-columns|display|justify-content)\s*:\s*([^;]+)/g)]
      .filter((match) => forcedDeclaration(match[1]!, match[2]!)).map((match) => `${match[1]}: ${match[2]!.trim()}`);
    for (const apply of body.matchAll(/@apply\s+([^;]+);/g)) forced.push(...apply[1]!.split(/\s+/).filter(forcedUtility));
    if (forced.length) violations.push(`${fileName}:${clean.slice(0, rule.index).split("\n").length} ${selector} must not stretch or distribute tab widths: ${forced.join(", ")}.`);
  }
  return violations;
}
