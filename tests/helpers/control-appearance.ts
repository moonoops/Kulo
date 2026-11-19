import ts from "typescript";

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

const controlRoots = new Set([
  "Button", "TextField", "Input", "TextArea", "Select", "ComboBox", "NumberField", "SearchField", "InputGroup", "Switch",
]);
const visualMembers = new Set([
  "Root", "Trigger", "InputGroup", "Group", "Input", "TextArea", "Control", "Thumb", "IncrementButton", "DecrementButton", "ClearButton",
]);
const visualSlots = new Set([
  "button", "textfield", "input", "textarea", "select__trigger", "combo-box__input-group", "combo-box__trigger",
  "number-field__group", "number-field__input", "number-field__increment-button", "number-field__decrement-button",
  "search-field__group", "search-field__input", "input-group", "input-group__input", "switch__control", "switch__thumb",
]);

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText() === name);
}

function constantValue(node: ts.Identifier): ts.Expression | undefined {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) continue;
    const declarations = parent.statements.flatMap((statement) => ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === node.text)
      : []);
    if (declarations.length === 1) return declarations[0]!.initializer;
  }
  return undefined;
}

/** Split Tailwind variants without treating colons inside arbitrary values as variants. */
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

function appearanceUtility(token: string): boolean {
  const name = utility(token);
  return /^(?:bg-|rounded(?:-|$)|border(?:-|$)|shadow(?:-|$)|inset-shadow(?:-|$)|ring(?:-|$)|outline-(?:none|0)$)/.test(name)
    || /^text-(?:foreground|muted|accent|default|danger|success|warning|white|black|inherit|transparent|current|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)(?:\/|$)/.test(name)
    || /^\[(?:--(?:(?:button|field|switch|kulo-control)[\w-]*|(?:default|accent)(?:-[\w-]+)?|foreground|background|radius-field|border-width-field)|background(?:-color|-image)?|color|border[\w-]*|box-shadow)\s*:/.test(name);
}

function literalStrings(node: ts.Node | undefined, file: ts.SourceFile, seen = new Set<ts.Node>()): string[] {
  if (!node || seen.has(node)) return [];
  const visited = new Set(seen).add(node);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node)) return literalStrings(node.expression, file, visited);
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap((span) => [...literalStrings(span.expression, file, visited), span.literal.text])];
  if (ts.isConditionalExpression(node)) return [...literalStrings(node.whenTrue, file, visited), ...literalStrings(node.whenFalse, file, visited)];
  if (ts.isBinaryExpression(node)) return [...literalStrings(node.left, file, visited), ...literalStrings(node.right, file, visited)];
  if (ts.isIdentifier(node)) return literalStrings(constantValue(node), file, visited);
  // A wrapper's caller-supplied classes are checked at their concrete call site.
  return [];
}

const inlineAppearance = /^(?:background(?:Color|Image)?|color|border(?:Top|Right|Bottom|Left)?(?:Color|Width|Style|Radius)?|border(?:Top|Bottom)(?:Left|Right)Radius|boxShadow|--(?:(?:button|field|switch|kulo-control)[\w-]*|(?:default|accent)(?:-[\w-]+)?|foreground|background|radius-field|border-width-field))$/;

export function auditJsxControlAppearance(source: string, fileName: string): { violations: string[]; controlClasses: Set<string> } {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@heroui/react" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (!binding.isTypeOnly) names.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
    }
  }
  const violations: string[] = [];
  const controlClasses = new Set<string>();
  function report(node: Opening, message: string) {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${fileName}:${line + 1}:${character + 1} <${node.tagName.getText(file)}> ${message}`);
  }
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const [head, ...members] = node.tagName.getText(file).split(".");
      const canonical = head && namespaces.has(head) ? members : [head && names.get(head), ...members];
      const [root, member] = canonical;
      if (root && controlRoots.has(root) && canonical.length <= 2 && (!member || visualMembers.has(member))) {
        const tokens = literalStrings(attribute(node, "className")?.initializer, file).flatMap((value) => value.split(/\s+/)).filter(Boolean);
        for (const token of tokens) if (/^[a-zA-Z_][\w-]*$/.test(token)) controlClasses.add(token);
        const domainEditor = fileName.replaceAll("\\", "/") === "packages/web/src/identity-document-editor.tsx"
          && root === "TextArea" && !member && tokens.includes("kulo-identity-textarea");
        const forced = tokens.filter((token) => appearanceUtility(token)
          && !(domainEditor && ["bg-transparent", "border-0", "shadow-none"].includes(token)));
        if (forced.length) report(node, `must use the shared control appearance; found ${[...new Set(forced)].join(", ")}.`);
        const style = attribute(node, "style")?.initializer;
        const visitedStyles = new Set<ts.Node>();
        function visitStyle(value: ts.Node) {
          if (visitedStyles.has(value)) return;
          visitedStyles.add(value);
          if (ts.isIdentifier(value)) {
            const resolved = constantValue(value);
            if (resolved) visitStyle(resolved);
          }
          if (ts.isPropertyAssignment(value) && inlineAppearance.test(value.name.getText(file).replace(/^['"]|['"]$/g, ""))) {
            report(node, `must leave ${value.name.getText(file)} to the shared control appearance.`);
          }
          ts.forEachChild(value, visitStyle);
        }
        if (style) visitStyle(style);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { violations, controlClasses };
}

const visualDeclaration = /^(?:background(?:-color|-image)?|color|border(?:-(?:top|right|bottom|left))?(?:-(?:color|width|style|radius))?|border-(?:top|bottom)-(?:left|right)-radius|box-shadow|--(?:(?:button|field|switch|kulo-control)[\w-]*|(?:default|accent)(?:-[\w-]+)?|foreground|background|radius-field|border-width-field))$/;

const domainSurfaces: Record<string, { file: string; properties: ReadonlySet<string> }> = {
  "kulo-composer-input": { file: "features/chat/composer-media.css", properties: new Set(["border", "border-radius", "background", "box-shadow"]) },
  "kulo-composer-thumbnail": { file: "features/chat/composer-media.css", properties: new Set(["border-radius"]) },
  "kulo-chat-image-trigger": { file: "features/chat/chat-content.css", properties: new Set(["border", "border-radius", "background", "box-shadow"]) },
  "kulo-voice-bubble": { file: "features/chat/voice-message.css", properties: new Set(["border-radius"]) },
  "kulo-task-card-button": { file: "features/tasks/task-rail.css", properties: new Set(["border-radius", "background"]) },
  "kulo-chat-outline-step": { file: "features/chat/conversation-outline.css", properties: new Set(["border-radius", "background"]) },
};

function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    if (selector[index] === "(" || selector[index] === "[") depth++;
    else if (selector[index] === ")" || selector[index] === "]") depth--;
    else if (selector[index] === "," && depth === 0) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

function targetCompound(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    if (selector[index] === "(" || selector[index] === "[") depth++;
    else if (selector[index] === ")" || selector[index] === "]") depth--;
    else if (/[\s>+~]/.test(selector[index]!) && depth === 0) start = index + 1;
  }
  // Relational/negative selectors describe context, not the painted element.
  return selector.slice(start).replace(/:(?:has|not)\((?:[^()]|\([^()]*\))*\)/g, "");
}

/** Find styling of the actual visual slot; parent surfaces and child icons remain independent. */
export function auditCssControlAppearance(source: string, fileName: string, controlClasses: ReadonlySet<string>): string[] {
  const known = new Set([...visualSlots, ...controlClasses]);
  const relative = fileName.replaceAll("\\", "/").replace(/^packages\/web\/src\//, "");
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const violations: string[] = [];
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]?.trim() ?? "";
    const body = rule[2] ?? "";
    const targets = selectorParts(selector).map((part) => [...targetCompound(part).matchAll(/\.([\w-]+)/g)].map((match) => match[1]!))
      .filter((classes) => classes.some((name) => known.has(name)
        || /^(?:button|textfield|input|textarea|select|combo-box|number-field|search-field|input-group|switch)(?:--[\w-]+)?$/.test(name)));
    if (!targets.length) continue;
    const domainProperty = (property: string) => targets.every((classes) => classes.some((name) => {
      const domain = domainSurfaces[name];
      return domain?.file === relative && domain.properties.has(property);
    }));
    const forced = [...body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;{}]+)/g)]
      .filter((match) => visualDeclaration.test(match[1]!) && !domainProperty(match[1]!)).map((match) => match[1]!);
    for (const apply of body.matchAll(/@apply\s+([^;]+);/g)) forced.push(...apply[1]!.split(/\s+/).filter(appearanceUtility));
    if (forced.length) violations.push(`${fileName}:${clean.slice(0, rule.index).split("\n").length} ${selector} must leave ${[...new Set(forced)].join(", ")} to kulo-controls.css.`);
  }
  return violations;
}

/** Shared visual tokens must not take ownership of library state or motion behavior. */
export function auditControlContractSafety(source: string): string[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const violations: string[] = [];
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!.trim();
    for (const part of selectorParts(selector)) if (!/^\.kulo-ui(?=[\s.:#[>+~]|$)/.test(part)) violations.push(`Unscoped control contract: ${part}`);
    for (const declaration of rule[2]!.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;{}]+)/g)) {
      const [, property, value] = declaration;
      if (/^--accent(?:-|$)/.test(property!) && selectorParts(selector).some((part) => part === ".kulo-ui")) violations.push("Control appearance must not recolor the root accent");
      if (/^(?:--focus|--danger(?:-|$)|--success(?:-|$)|--warning(?:-|$)|--tw-ring[\w-]*|outline(?:-|$)|animation(?:-|$)|transition(?:-|$)|transform|translate|opacity|pointer-events)/.test(property!)) {
        violations.push(`Control appearance must preserve library state/motion: ${property}`);
      }
      if (/(?:#[\da-f]{3,8}\b|\b(?:rgb|hsl|oklch)\s*\()/i.test(value!)) violations.push(`Control appearance must derive from semantic colors: ${property}`);
    }
  }
  return violations;
}

/** A guessed BEM slot silently drops styling; validate against the installed library. */
export function auditHeroUiControlSlots(source: string, installedStyles: string): string[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const known = new Set([...installedStyles.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]!));
  const unknown = new Set<string>();
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const match of rule[1]!.matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
      const name = match[1]!;
      if (!name.startsWith("kulo-") && !known.has(name)) unknown.add(name);
    }
  }
  return [...unknown].map((name) => `.${name} is not an installed HeroUI styling slot`);
}
