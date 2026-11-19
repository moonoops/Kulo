import ts from "typescript";

const variantOwners = new Set(["Select", "SearchField", "NumberField", "ComboBox", "InputGroup"]);
const inputLeaves = new Set(["Input", "TextArea"]);
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attribute(node: Opening, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((prop): prop is ts.JsxAttribute =>
    ts.isJsxAttribute(prop) && prop.name.getText() === name);
}

function literalAttribute(node: Opening, name: string): string | undefined {
  const value = attribute(node, name)?.initializer;
  if (value && ts.isStringLiteral(value)) return value.text;
  if (value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteral(value.expression)) return value.expression.text;
  return undefined;
}

function hasVariant(node: Opening): boolean {
  const value = attribute(node, "variant")?.initializer;
  if (!value) return false;
  if (ts.isStringLiteral(value)) return value.text.trim().length > 0;
  if (!ts.isJsxExpression(value) || !value.expression) return false;
  const expression = value.expression;
  if (ts.isStringLiteral(expression)) return expression.text.trim().length > 0;
  if (expression.kind === ts.SyntaxKind.NullKeyword || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.TrueKeyword) return false;
  if (ts.isIdentifier(expression) && expression.text === "undefined") return false;
  return true;
}

function hiddenFileInput(node: Opening): boolean {
  if (literalAttribute(node, "type") !== "file") return false;
  const hidden = attribute(node, "hidden");
  if (hidden && (!hidden.initializer || ts.isJsxExpression(hidden.initializer) && hidden.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword)) return true;
  return literalAttribute(node, "className")?.split(/\s+/).includes("hidden") ?? false;
}

/** Static explicitness check; parent/field color contrast still requires browser verification. */
export function auditInputAppearance(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const namedImports = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@heroui/react" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly) namedImports.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
      }
    }
  }

  function heroRoot(node: Opening): string | undefined {
    const [head, ...members] = node.tagName.getText(file).split(".");
    if (!head) return undefined;
    let canonical: string[];
    if (namespaces.has(head)) canonical = members;
    else {
      const imported = namedImports.get(head);
      if (!imported) return undefined;
      canonical = [imported, ...members];
    }
    // Compound component internals (SearchField.Input, NumberField.Group, etc.)
    // take their appearance from their owning root, not an independent variant.
    return canonical.length === 1 || canonical.length === 2 && canonical[1] === "Root" ? canonical[0] : undefined;
  }

  function inheritedVariant(node: Opening, root: string): boolean {
    let nearestTextField: Opening | undefined;
    let nearestComboBox: Opening | undefined;
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (!ts.isJsxElement(parent) || parent.openingElement === node) continue;
      const opening = parent.openingElement;
      const root = heroRoot(opening);
      if (root === "TextField" && !nearestTextField) nearestTextField = opening;
      if (root === "ComboBox" && !nearestComboBox) nearestComboBox = opening;
    }
    // A nested TextField replaces the outer TextField context, even without a
    // variant. ComboBox is a separate fallback context in HeroUI v3 Input.
    return Boolean(nearestTextField && hasVariant(nearestTextField) || root === "Input" && nearestComboBox && hasVariant(nearestComboBox));
  }

  const violations: string[] = [];
  function report(node: Opening, message: string) {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${fileName}:${line + 1}:${character + 1} <${node.tagName.getText(file)}> ${message}`);
  }
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const root = heroRoot(node);
      if (root && variantOwners.has(root) && !hasVariant(node)) {
        report(node, 'must declare variant="primary" or "secondary" on the owning control.');
      } else if (root && inputLeaves.has(root) && !hasVariant(node) && !inheritedVariant(node, root)) {
        report(node, `must declare a variant or inherit one from its enclosing ${root === "Input" ? "TextField/ComboBox" : "TextField"}; shared fields must own this choice.`);
      }
      const tag = node.tagName.getText(file);
      if (["input", "textarea", "select"].includes(tag) && !(tag === "input" && (literalAttribute(node, "type") === "hidden" || hiddenFileInput(node)))) {
        report(node, "is a visible native control; use the HeroUI field with an explicit variant.");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}
