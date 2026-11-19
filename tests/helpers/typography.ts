import ts from "typescript";

const roles = ["caption", "body", "heading", "title"] as const;
const fontValues = new Set(roles.map((role) => `var(--moco-text-${role})`));
const leadingValues = new Set(roles.map((role) => `var(--moco-leading-${role})`));
const compact = (value: string) => value.replace(/\s+/g, "");
const overlayHeadingNames = ["modal__heading", "alert-dialog__heading", "drawer__heading"];
const customTableHeaderNames = ["moco-search-plan-head", "moco-model-column-head"];
const tableHeaderNames = ["table__column", "moco-table-header", "moco-settings-table-column", ...customTableHeaderNames];
type TypographyRole = typeof roles[number];
const componentRoles: Record<string, TypographyRole> = {
  Label: "body", "Alert.Title": "body", "Alert.Description": "caption",
  "Card.Description": "caption", "Table.Column": "body", "Table.Cell": "body", Button: "body",
  "Modal.Heading": "heading", "AlertDialog.Heading": "heading", "Drawer.Heading": "heading",
};
const componentSlotRoles: Record<string, TypographyRole> = {
  label: "body", alert__title: "body", alert__description: "caption",
  card__description: "caption", table__column: "body", table__cell: "body", "moco-table-header": "body", button: "body",
  "moco-message-action": "caption",
  ...Object.fromEntries(overlayHeadingNames.map((name) => [name, "heading" as const])),
};

function selectorTargets(selector: string, names: readonly string[]): string[] {
  const subject = [" ", ">", "+", "~"].reduce((part, separator) => splitOutside(part, separator).at(-1)!.trim(), selector.replace(/\s+/g, " ").trim());
  const direct = /^(?:\.[\w-]+)+/.exec(subject)?.[0];
  if (direct) return direct.slice(1).split(".").filter((name) => names.includes(name));
  const group = /^:(?:is|where)\(([^()]*)\)(?:[.:[#].*)?$/.exec(subject)?.[1];
  return group ? splitOutside(group, ",").flatMap((part) => selectorTargets(part, names)) : [];
}
const headingTargets = (selector: string) => selectorTargets(selector, overlayHeadingNames);

function slotRoles(selector: string): Array<{ name: string; role: TypographyRole }> {
  const targets = selectorTargets(selector, [...Object.keys(componentSlotRoles), ...tableHeaderNames]);
  return targets.filter((name) => name !== "button" || !targets.includes("moco-message-action"))
    .map((name) => ({ name, role: componentSlotRoles[name] ?? "body" }));
}

interface Declaration {
  property: string;
  value: string;
  selectors: string[];
  start: number;
  rule: number;
  conditional: boolean;
}

// Preserve offsets and quoted strings so comments, CSS content and data URLs
// cannot masquerade as declarations or alter their reported locations.
function uncomment(source: string): string {
  const chars = source.split("");
  let quote = "";
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "/" && chars[i + 1] === "*") {
      const start = i;
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) i++;
      i++;
      for (let j = start; j <= i && j < chars.length; j++) if (chars[j] !== "\n") chars[j] = " ";
    }
  }
  return chars.join("");
}

function splitOutside(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (!depth && char === separator) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  return [...parts, value.slice(start)];
}

function declarations(source: string): Declaration[] {
  const clean = uncomment(source);
  const stack: Array<{ selectors: string[]; start: number; conditional: boolean }> = [];
  const out: Declaration[] = [];
  let start = 0, depth = 0, quote = "";
  const emit = (end: number) => {
    const text = clean.slice(start, end);
    const context = stack.at(-1);
    const declarationContext = { selectors: context?.selectors ?? [], rule: context?.start ?? -1, conditional: context?.conditional ?? false, start: start + text.search(/\S/) };
    const match = /^\s*([\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(text);
    if (match) out.push({ property: match[1]!.toLowerCase(), value: match[2]!, ...declarationContext });
    const apply = /^\s*@apply\s+([\s\S]+?)\s*$/.exec(text);
    if (apply) out.push({ property: "@apply", value: apply[1]!, ...declarationContext });
  };
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    if (depth) continue;
    if (char === "{") {
      const header = clean.slice(start, i).trim();
      const parent = stack.at(-1);
      const ancestors = parent?.selectors ?? [];
      const selectors = header.startsWith("@") ? ancestors : splitOutside(header, ",").flatMap((part) => {
        const selector = part.trim();
        return ancestors.length ? ancestors.map((ancestor) => selector.includes("&") ? selector.replaceAll("&", ancestor) : `${ancestor} ${selector}`) : [selector];
      });
      stack.push({ selectors, start: i, conditional: Boolean(parent?.conditional || header.startsWith("@") && !/^@layer\b/.test(header)) });
      start = i + 1;
    } else if (char === ";") { emit(i); start = i + 1; }
    else if (char === "}") { emit(i); stack.pop(); start = i + 1; }
  }
  return out;
}

function typographyRules(parsed: Declaration[]): Declaration[][] {
  const rules = new Map<number, Declaration[]>();
  for (const decl of parsed) if (["font-size", "line-height", "font"].includes(decl.property)) {
    rules.set(decl.rule, [...rules.get(decl.rule) ?? [], decl]);
  }
  return [...rules.values()];
}

function role(value: string, kind: "text" | "leading"): string | undefined {
  return new RegExp(`^var\\(--moco-${kind}-(caption|body|heading|title)\\)$`).exec(compact(value.replace(/\s*!important\s*$/, "")))?.[1];
}

function ruleRoles(rule: Declaration[]): { size?: string; leading?: string } {
  let size: string | undefined, leading: string | undefined;
  for (const decl of rule) {
    if (decl.property === "font-size") size = role(decl.value, "text");
    else if (decl.property === "line-height") leading = role(decl.value, "leading");
    else if (decl.property === "font") {
      const shorthand = /var\(--moco-text-(caption|body|heading|title)\)\s*\/\s*var\(--moco-leading-(caption|body|heading|title)\)/.exec(decl.value);
      size = shorthand?.[1];
      leading = shorthand?.[2];
    }
  }
  return { size, leading };
}

function contentException(fileName: string, selector: string, property: string, value: string): boolean {
  const file = fileName.replaceAll("\\", "/");
  const v = compact(value);
  if (/(?:^|\/)moco\.css$/.test(file) && [".moco-composer-input", ".mc-user-message"].includes(selector)) {
    return property === "font-size" && ["var(--moco-chat-font-size)", "max(var(--moco-text-heading),var(--moco-chat-font-size))"].includes(v)
      || property === "line-height" && v === "var(--moco-chat-line-height)";
  }
  // PDF.js must reproduce document glyph geometry; its surrounding controls keep the UI scale.
  if (/(?:^|\/)features\/chat\/pdf-preview\.css$/.test(file)) {
    if (selector === ".moco-pdf-text-layer") return property === "line-height" && v === "1";
    return [".moco-pdf-text-layer > :not(.markedContent)", ".moco-pdf-text-layer .markedContent span:not(.markedContent)"].includes(selector)
      && property === "font-size" && v === "calc(var(--text-scale-factor)*var(--font-height))";
  }
  if (!/(?:^|\/)features\/chat\/chat-content\.css$/.test(file)) return false;
  if ([".moco-chat-markdown", ".moco-chat-user-text"].includes(selector)) {
    return property === "font-size" && v === "var(--moco-chat-font-size)" || property === "line-height" && v === "var(--moco-chat-line-height)";
  }
  const heading = /^\.moco-chat-markdown h([1-6])$/.exec(selector)?.[1];
  if (heading) {
    const sizes: Record<string, string> = { 1: "1.55em", 2: "1.3em", 3: "1.12em", 4: "1em", 5: "1em", 6: "1em" };
    return property === "font-size" && v === sizes[heading] || property === "line-height" && v === "1.5";
  }
  if (selector === ".moco-chat-inline-code") return property === "font" && /^\.88em\/1\.5\s+/.test(value);
  if (selector === ".moco-chat-table") return property === "font-size" && /^max\((?:12px|var\(--moco-text-caption\)),calc\(var\(--moco-chat-font-size\)-1px\)\)$/.test(v);
  if (selector === ".moco-chat-code-pre") return property === "font" && /^max\((?:12px|var\(--moco-text-caption\)),calc\(var\(--moco-chat-font-size\)-2px\)\)\/1\.65/.test(v);
  return false;
}

const bareUtility = (token: string) => splitOutside(token, ":").at(-1)!.replace(/^!|!$/g, "");
const targetsDescendant = (token: string) => splitOutside(token, ":").slice(0, -1)
  .some((variant) => ["*", "**"].includes(variant) || /&(?:_|[>+~])/.test(variant));

function headingUtilityProblem(token: string): string | undefined {
  const bare = bareUtility(token);
  if (/^text-(?:xs|sm|2xl)(?:$|\/)|^text-\[inherit\]$/.test(bare)) return "overlay headings must keep text-lg or their inherited heading role";
  if (bare.startsWith("leading-") && !/^leading-(?:\[var\(--moco-leading-heading\)\]|\(--moco-leading-heading\))$/.test(bare)) return "overlay headings must keep the heading line-height role";
  return undefined;
}

function componentUtilityProblem(token: string, expected: TypographyRole): string | undefined {
  if (targetsDescendant(token)) return undefined;
  if (expected === "heading") {
    const problem = headingUtilityProblem(token);
    if (problem) return problem;
  }
  const bare = bareUtility(token);
  const utilityRoles: Record<string, TypographyRole> = { "text-xs": "caption", "text-sm": "body", "text-lg": "heading", "text-2xl": "title",
    "moco-page-title": "title", "moco-section-title": "heading", "moco-group-title": "body",
    "moco-item-title": "body", "moco-item-description": "caption" };
  const utilityRole = utilityRoles[bare];
  if ((utilityRole && utilityRole !== expected) || bare === "text-[inherit]") return `component must keep its ${expected} typography role`;
  const leadingRole = /^leading-(?:\[var\(--moco-leading-(caption|body|heading|title)\)\]|\(--moco-leading-(caption|body|heading|title)\))$/.exec(bare);
  if (bare === "leading-[inherit]" || leadingRole && (leadingRole[1] ?? leadingRole[2]) !== expected) return `component must keep its ${expected} line-height role`;
  return undefined;
}

function buttonSizingProblem(token: string): string | undefined {
  if (targetsDescendant(token)) return undefined;
  return /^(?:h|min-h|max-h|size)-(?:\d|px$|\[|\()/.test(bareUtility(token))
    ? "Button dimensions must use its shared size role so coarse-pointer targets remain intact" : undefined;
}

function tableHeaderUtilityProblem(token: string): string | undefined {
  if (targetsDescendant(token)) return undefined;
  const bare = bareUtility(token);
  if (/^font-(?:thin|extralight|light|normal|medium|bold|extrabold|black)$/.test(bare)
    || /^font-(?:\[(?!family-name:)|\((?:weight:)?--)/.test(bare) && bare !== "font-[600]"
    || /^\[font-weight:/.test(bare) && bare !== "[font-weight:600]") {
    return "table headers must keep font-weight 600";
  }
  return undefined;
}

function utilityProblem(token: string): string | undefined {
  const bare = bareUtility(token);
  if (bare === "text-" || bare === "leading-") return "choose an explicit shared typography role instead of a dynamic size";
  if (/^text-(?:base|xl|[3-9]xl)(?:$|\/)/.test(bare)) return "use text-xs/sm/lg/2xl or a shared semantic role";
  if (/^text-(?:xs|sm|lg|2xl)\//.test(bare)) return "use the size's shared line-height instead of a slash override";
  if (bare.startsWith("text-[") || bare.startsWith("text-(")) {
    const value = bare.slice(6, -1);
    if (value === "inherit" || value.startsWith("color:") || /^(?:#|(?:rgb|hsl|oklch|oklab|lch|lab|color)\()/i.test(value)) return undefined;
    // Untyped variables are color utilities in Tailwind. Typed or visibly
    // typographic variables must not create an extra font-size scale.
    if (/^(?:var\(--[\w-]+\)|--[\w-]+)$/.test(value) && !/(?:font|text|leading|size)/.test(value)) return undefined;
    return "replace an arbitrary font size with text-xs/sm/lg/2xl or a shared semantic role";
  }
  if (bare.startsWith("leading-") && !/^leading-(?:\[var\(--moco-leading-(?:caption|body|heading|title)\)\]|\(--moco-leading-(?:caption|body|heading|title)\)|\[inherit\])$/.test(bare)) {
    return "use the shared line-height for the text role";
  }
  if (/^\[(?:font(?:-size)?|line-height):/.test(bare)) return "declare typography through the shared semantic roles";
  return undefined;
}

/** Checks authored declarations, including nested media rules and font shorthands. */
export function auditCssTypography(source: string, fileName: string): string[] {
  const central = /(?:^|\/)moco-typography\.css$/.test(fileName.replaceAll("\\", "/"));
  const parsed = declarations(source);
  const problems = parsed.flatMap((decl) => {
    const value = compact(decl.value.replace(/\s*!important\s*$/, ""));
    let problem: string | undefined;
    const pdfGlyphScale = /(?:^|\/)features\/chat\/pdf-preview\.css$/.test(fileName.replaceAll("\\", "/"))
      && decl.property === "--text-scale-factor" && decl.selectors.length === 1 && decl.selectors[0] === ".moco-pdf-text-layer"
      && value === "calc(var(--total-scale-factor)*var(--min-font-size))";
    if (/^--(?:moco-(?:text|leading)-|text-)/.test(decl.property) && !central && !pdfGlyphScale) problem = "define typography tokens only in moco-typography.css";
    if (decl.property === "@apply") {
      const targets = decl.selectors.flatMap(slotRoles);
      const header = decl.selectors.some((selector) => selectorTargets(selector, tableHeaderNames).length);
      const tokenProblem = (token: string) => utilityProblem(token) ?? targets.map((target) => componentUtilityProblem(token, target.role)).find(Boolean)
        ?? (header ? tableHeaderUtilityProblem(token) : undefined);
      const bad = decl.value.split(/\s+/).find(tokenProblem);
      if (bad) problem = `${bad}: ${tokenProblem(bad)}`;
    } else if (["font-size", "line-height", "font"].includes(decl.property)) {
      const inherited = value === "inherit";
      const shared = decl.property === "font-size" ? fontValues.has(value) : decl.property === "line-height" ? leadingValues.has(value)
        : /^(?:(?:normal|italic|oblique|small-caps|400|500|600)\s+)*var\(--moco-text-(caption|body|heading|title)\)\s*\/\s*var\(--moco-leading-\1\)\s+\S/.test(decl.value);
      if (!inherited && !shared && !(decl.selectors.length && decl.selectors.every((selector) => contentException(fileName, selector, decl.property, decl.value)))) {
        problem = `${decl.property}: ${decl.value} must use the four shared typography roles`;
      }
      if (inherited && decl.selectors.some((selector) => slotRoles(selector).length)) problem = `${decl.property}: inherit bypasses the component's fixed typography role`;
    }
    if (decl.selectors.some((selector) => selectorTargets(selector, tableHeaderNames).length)) {
      if (decl.property === "font-weight" && value !== "600") problem = "table headers must keep font-weight 600";
      if (decl.property === "font" && !/^(?:(?:normal|italic|oblique|small-caps)\s+)*600\s+/.test(decl.value)) problem = "table header font shorthand must keep font-weight 600";
    }
    return problem ? [`${fileName}:${source.slice(0, decl.start).split("\n").length} ${decl.selectors.join(", ") || ":root"} ${problem}.`] : [];
  });
  for (const rule of typographyRules(parsed)) {
    const { size, leading } = ruleRoles(rule);
    const first = rule[0]!;
    if (size && leading && size !== leading) {
      problems.push(`${fileName}:${source.slice(0, first.start).split("\n").length} ${first.selectors.join(", ")} pairs ${size} font-size with ${leading} line-height; use the same shared role.`);
    }
    const targets = new Map(first.selectors.flatMap(slotRoles).map((target) => [target.name, target.role]));
    for (const [target, expected] of targets) {
      if (size && size !== expected) problems.push(`${fileName}:${source.slice(0, first.start).split("\n").length} .${target} cannot override its ${expected} font-size with the ${size} role.`);
      if (leading && leading !== expected) problems.push(`${fileName}:${source.slice(0, first.start).split("\n").length} .${target} cannot override its ${expected} line-height with the ${leading} role.`);
    }
  }
  return problems;
}

/** Dialog titles are a product role, even when a different tier is itself valid. */
export function auditOverlayHeadingTypography(source: string, fileName: string): string[] {
  const headings = overlayHeadingNames;
  const found = new Map(headings.map((heading) => [heading, { size: false, leading: false }]));
  const problems: string[] = [];
  for (const rule of typographyRules(declarations(source))) {
    const first = rule[0]!;
    const targets = new Set(first.selectors.flatMap((selector) => {
      const scoped = /^\.moco-ui\s+(.+)$/.exec(selector.replace(/\s+/g, " ").trim())?.[1];
      if (!scoped) return [];
      const group = /^:(?:is|where)\((.*)\)$/.exec(scoped)?.[1];
      return (group ? splitOutside(group, ",") : [scoped]).map((part) => part.trim().replace(/^\./, "")).filter((part) => headings.includes(part));
    }));
    const assigned = ruleRoles(rule);
    const hasSize = rule.some((decl) => ["font-size", "font"].includes(decl.property));
    const hasLeading = rule.some((decl) => ["line-height", "font"].includes(decl.property));
    for (const target of targets) {
      const evidence = found.get(target)!;
      if (hasSize && assigned.size !== "heading") problems.push(`${fileName}:${source.slice(0, first.start).split("\n").length} .${target} must keep the heading font-size role.`);
      if (hasLeading && assigned.leading !== "heading") problems.push(`${fileName}:${source.slice(0, first.start).split("\n").length} .${target} must keep the heading line-height role.`);
      if (!first.conditional) {
        evidence.size ||= hasSize && assigned.size === "heading";
        evidence.leading ||= hasLeading && assigned.leading === "heading";
      }
    }
  }
  for (const [heading, evidence] of found) if (!evidence.size || !evidence.leading) problems.push(`${fileName} .${heading} needs an unconditional scoped heading font-size and line-height.`);
  return problems;
}

/** Custom grid headers share the same default role as library table columns. */
export function auditTableHeaderTypography(source: string, fileName: string): string[] {
  const required = ["table__column", "moco-table-header"];
  const parsed = declarations(source);
  return required.flatMap((name) => {
    const evidence = parsed.filter((decl) => !decl.conditional && decl.selectors.some((selector) => {
      const scoped = /^\.moco-ui\s+(.+)$/.exec(selector.replace(/\s+/g, " ").trim())?.[1];
      const group = scoped && /^:(?:is|where)\((.*)\)$/.exec(scoped)?.[1];
      return scoped && (group ? splitOutside(group, ",") : [scoped]).some((part) => part.trim() === `.${name}`);
    }));
    return [["font-size", "var(--moco-text-body)"], ["line-height", "var(--moco-leading-body)"], ["font-weight", "600"]]
      .flatMap(([property, expected]) => {
        const assigned = evidence.filter((decl) => decl.property === property);
        return assigned.length && assigned.every((decl) => compact(decl.value) === expected) ? []
          : [`${fileName} .${name} needs unconditional scoped ${property}: ${expected}.`];
      });
  });
}

/** Check the adapter against installed slots, including unstyled slots emitted by variants. */
export function auditHeroUiTypographySlots(source: string, fileName: string, installedCss: string, emittedSlots: readonly string[] = []): string[] {
  const classes = (selector: string) => [...selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]!);
  const installed = new Set([...declarations(installedCss).flatMap((decl) => decl.selectors.flatMap(classes)), ...emittedSlots]);
  const parsed = declarations(source);
  const problems: string[] = [];
  for (const name of new Set(parsed.flatMap((decl) => decl.selectors.flatMap(classes)))) {
    if (!["moco-ui", "moco-composer-input", "moco-table-header", "mc-icon"].includes(name) && !installed.has(name)) problems.push(`${fileName} .${name} is not an installed HeroUI slot.`);
  }
  const required: Record<string, TypographyRole> = {
    ...componentSlotRoles, input: "body", "input-group__input": "body", "combo-box__value": "body",
    tabs__tab: "body", header: "body", fieldset__legend: "body",
  };
  delete required["moco-message-action"];
  for (const [name, expected] of Object.entries(required)) {
    const evidence = parsed.filter((decl) => !decl.conditional && decl.selectors.some((selector) => /\.moco-ui\s/.test(selector) && selectorTargets(selector, [name]).length));
    for (const property of ["font-size", "line-height"] as const) {
      const matches = evidence.filter((decl) => decl.property === property);
      if (!matches.length || matches.some((decl) => role(decl.value, property === "font-size" ? "text" : "leading") !== expected)) {
        problems.push(`${fileName} .${name} needs unconditional scoped ${expected} ${property}.`);
      }
    }
  }
  return problems;
}

/** Fixed contract; component-library aliases may reference these roles but add no sizes. */
export function auditTypographyTokens(source: string, fileName: string): string[] {
  const expected: Record<string, readonly string[]> = {
    "--moco-text-caption": ["12px", "0.75rem"], "--moco-leading-caption": ["18px"],
    "--moco-text-body": ["14px", "0.875rem"], "--moco-leading-body": ["20px"],
    "--moco-text-heading": ["18px", "1.125rem"], "--moco-leading-heading": ["26px"],
    "--moco-text-title": ["24px", "1.5rem"], "--moco-leading-title": ["32px"],
  };
  for (const [size, role] of Object.entries({ xs: "caption", sm: "body", lg: "heading", "2xl": "title", base: "body", xl: "heading" })) {
    expected[`--text-${size}`] = [`var(--moco-text-${role})`];
    expected[`--text-${size}--line-height`] = [`var(--moco-leading-${role})`];
  }
  const tokens = declarations(source).filter((decl) => /^--(?:moco-(?:text|leading)-|text-)/.test(decl.property));
  const problems: string[] = [];
  for (const [name, allowed] of Object.entries(expected)) {
    const matches = tokens.filter((decl) => decl.property === name);
    if (matches.length !== 1 || !allowed.includes(compact(matches[0]?.value ?? ""))) problems.push(`${fileName} ${name} must have one shared definition: ${allowed.join(" or ")}.`);
  }
  for (const token of tokens) if (!expected[token.property]) problems.push(`${fileName} ${token.property} adds an unreviewed typography token.`);
  return problems;
}

/** Static source guard; actual Portal inheritance and layout require browser QA. */
export function auditJsxTypography(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const heroImports = new Map<string, string>();
  const heroNamespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@heroui/react" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) heroNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) if (!binding.isTypeOnly) heroImports.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
  }
  const declarationsByName = new Map<string, ts.VariableDeclaration[]>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarationsByName.set(node.name.text, [...declarationsByName.get(node.name.text) ?? [], node]);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const binds = (name: ts.BindingName, value: string): boolean => ts.isIdentifier(name) ? name.text === value : name.elements.some((element) => ts.isBindingElement(element) && binds(element.name, value));
  const heroComponent = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | undefined => {
    const [head, ...members] = node.tagName.getText(file).split(".");
    if (!head) return undefined;
    const canonical = heroNamespaces.has(head) ? members : [heroImports.get(head), ...members];
    if (!canonical[0]) return undefined;
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) && parent.parameters.some((parameter) => binds(parameter.name, head))) return undefined;
    }
    const shadowed = declarationsByName.get(head)?.some((decl) => {
      let scope: ts.Node = decl;
      while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      return !ts.isSourceFile(scope) && scope.pos <= node.pos && scope.end >= node.end;
    });
    return shadowed ? undefined : canonical.join(".");
  };
  const initializer = (identifier: ts.Identifier): ts.Expression | undefined => {
    for (let parent: ts.Node | undefined = identifier.parent; parent; parent = parent.parent) {
      if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isArrowFunction(parent))
        && parent.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text)) return undefined;
    }
    return declarationsByName.get(identifier.text)?.map((decl) => {
      let scope: ts.Node = decl;
      while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      return { decl, scope };
    }).filter(({ scope }) => scope.pos <= identifier.pos && scope.end >= identifier.end)
      .sort((a, b) => (a.scope.end - a.scope.pos) - (b.scope.end - b.scope.pos))[0]?.decl.initializer;
  };
  const options = (expression: ts.Expression, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(expression)) return [""];
    const next = new Set(seen).add(expression);
    if (ts.isStringLiteralLike(expression)) return [expression.text];
    if (ts.isIdentifier(expression)) { const init = initializer(expression); return init ? options(init, next) : [""]; }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) return options(expression.expression, next);
    if (ts.isConditionalExpression(expression)) return [...options(expression.whenTrue, next), ...options(expression.whenFalse, next)];
    if (ts.isTemplateExpression(expression)) return expression.templateSpans.reduce((left, span) => left.flatMap((prefix) => options(span.expression, next).map((suffix) => prefix + suffix + span.literal.text)), [expression.head.text]);
    if (ts.isBinaryExpression(expression)) {
      const left = options(expression.left, next), right = options(expression.right, next);
      return expression.operatorToken.kind === ts.SyntaxKind.PlusToken ? left.flatMap((a) => right.map((b) => a + b)) : [...left, ...right];
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      if (!ts.isBlock(expression.body)) return options(expression.body, next);
      const returns: string[] = [];
      const visit = (node: ts.Node) => { if (ts.isReturnStatement(node) && node.expression) returns.push(...options(node.expression, next)); else ts.forEachChild(node, visit); };
      visit(expression.body);
      return returns;
    }
    if (ts.isCallExpression(expression)) return expression.arguments.reduce<string[]>((left, arg) =>
      left.flatMap((prefix) => options(arg, next).map((suffix) => `${prefix} ${suffix}`)), [""]);
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.reduce<string[]>((left, element) =>
      left.flatMap((prefix) => options(ts.isSpreadElement(element) ? element.expression : element, next).map((suffix) => `${prefix} ${suffix}`)), [""]);
    if (ts.isObjectLiteralExpression(expression)) return expression.properties.flatMap((prop) => ts.isPropertyAssignment(prop) ? [prop.name.getText(file).replace(/^['"]|['"]$/g, ""), ...options(prop.initializer, next)] : []);
    return [""];
  };
  const violations: string[] = [];
  const report = (node: ts.Node, message: string) => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${fileName}:${line + 1}:${character + 1} ${message}.`);
  };
  const style = (expression: ts.Expression, header: boolean, seen = new Set<ts.Node>()) => {
    if (seen.has(expression)) return;
    const next = new Set(seen).add(expression);
    if (ts.isIdentifier(expression)) { const init = initializer(expression); if (init) style(init, header, next); }
    else if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) style(expression.expression, header, next);
    else if (ts.isConditionalExpression(expression)) { style(expression.whenTrue, header, next); style(expression.whenFalse, header, next); }
    else if (ts.isObjectLiteralExpression(expression)) for (const prop of expression.properties) {
      if (ts.isSpreadAssignment(prop)) style(prop.expression, header, next);
      else if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
        const names = ts.isComputedPropertyName(prop.name) ? options(prop.name.expression) : [prop.name.getText(file).replace(/^['"]|['"]$/g, "")];
        for (const name of names) if (/^(?:font(?:Size)?|lineHeight|font-size|line-height|--moco-(?:text|leading)-[\w-]+)$/.test(name)) report(prop, `inline ${name} bypasses the shared typography roles`);
        else if (header && ["fontWeight", "font-weight"].includes(name)) report(prop, "inline font-weight bypasses the shared table header role");
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const component = heroComponent(node);
      const classOptions = (value: ts.JsxAttributeValue | undefined): string[] => value && ts.isStringLiteral(value) ? [value.text]
        : value && ts.isJsxExpression(value) && value.expression ? options(value.expression) : [];
      const header = component === "Table.Column" || node.attributes.properties.some((prop) => ts.isJsxAttribute(prop) && prop.name.getText(file) === "className"
        && classOptions(prop.initializer).some((classes) => classes.split(/\s+/).some((name) => tableHeaderNames.includes(name))));
      for (const prop of node.attributes.properties) {
        if (!ts.isJsxAttribute(prop)) continue;
        const name = prop.name.getText(file), value = prop.initializer;
        if (["fontSize", "lineHeight", "font-size", "line-height"].includes(name)) report(prop, `${name} bypasses the shared typography roles`);
        if (name === "style" && value && ts.isJsxExpression(value) && value.expression) style(value.expression, header);
        if (name !== "className" || !value) continue;
        const classes = classOptions(value);
        const messages = new Set<string>();
        for (const className of classes) {
          const tokens = new Set(className.split(/\s+/));
          const customHeader = [...tokens].some((name) => tableHeaderNames.includes(name));
          if ([...tokens].some((name) => customTableHeaderNames.includes(name)) && !tokens.has("moco-table-header")) messages.add("custom table headers must use moco-table-header");
          const expected = component === "Button" && tokens.has("moco-message-action") ? "caption" : customHeader ? "body" : componentRoles[component ?? ""];
          for (const token of tokens) {
            const problem = utilityProblem(token) ?? (expected ? componentUtilityProblem(token, expected) : undefined)
              ?? (component === "Table.Column" || customHeader ? tableHeaderUtilityProblem(token) : undefined)
              ?? (component === "Button" ? buttonSizingProblem(token) : undefined);
            if (problem) messages.add(`${token}: ${problem}`);
          }
        }
        for (const message of messages) report(prop, message);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}
