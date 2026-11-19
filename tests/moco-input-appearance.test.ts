import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditInputAppearance } from "./helpers/input-appearance";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrcDir = path.join(repoRoot, "packages/web/src");
const imports = 'import { Input, TextArea, TextField, Select, SearchField, NumberField, ComboBox, InputGroup } from "@heroui/react";';
const audit = (jsx: string) => auditInputAppearance(`${imports}\n${jsx}`, "field.tsx");

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return entry.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(entry.name) ? [file] : [];
  });
}

describe("HeroUI input appearance guard", () => {
  it("requires every production field to choose an explicit fill variant", () => {
    const files = sourceFiles(webSrcDir);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) => auditInputAppearance(fs.readFileSync(file, "utf8"), path.relative(repoRoot, file)));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("accepts direct and inherited variants, including transparent domain composites", () => {
    expect(audit(`<><Input variant="secondary"/><TextArea variant="primary" className="bg-transparent"/>
      <TextField variant="secondary"><div><Input/></div><TextArea/></TextField>
      <TextField><Input variant="secondary"/></TextField>
      <ComboBox variant="secondary"><ComboBox.InputGroup><Input/></ComboBox.InputGroup></ComboBox>
      <Input variant={compact ? "primary" : "secondary"}/></>`)).toEqual([]);
  });

  it("reports the location of a shared wrapper that leaves its input implicit", () => {
    const violations = audit(`function ConnectionSecret() { return <TextField><Input type="password"/></TextField>; }
      const form = <TextField variant="secondary"><ConnectionSecret/></TextField>;`);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^field\.tsx:2:\d+ <Input> must declare a variant/);
  });

  it("does not borrow a sibling variant or an outer TextField replaced by a nested field", () => {
    expect(audit(`<><TextField><Input variant="secondary"/><TextArea/></TextField>
      <TextField variant="secondary"><TextField><Input/></TextField></TextField></>`)).toHaveLength(2);
  });

  it("matches Input's separate ComboBox fallback without extending it to TextArea", () => {
    expect(audit(`<ComboBox variant="secondary"><TextField><Input/></TextField></ComboBox>`)).toEqual([]);
    expect(audit(`<ComboBox variant="secondary"><TextArea/></ComboBox>`)).toHaveLength(1);
  });

  it.each(["Select", "SearchField", "NumberField", "ComboBox", "InputGroup"])("checks the %s owner rather than its internal slots", (owner) => {
    expect(audit(`<${owner}><${owner}.Input/></${owner}>`)).toHaveLength(1);
    expect(audit(`<${owner} variant="secondary"><${owner}.Input/></${owner}>`)).toEqual([]);
  });

  it("resolves aliased and namespace HeroUI imports without flagging unrelated components", () => {
    expect(auditInputAppearance(`import { Input as Field, TextField as Group } from "@heroui/react";
      import * as Hero from "@heroui/react";
      import { Input } from "./domain-input";
      const view = <><Field/><Hero.Input/><Hero.Select/><Input/>
        <Group variant="secondary"><Field/></Group><Hero.TextField variant="primary"><Hero.TextArea/></Hero.TextField></>;`, "aliases.tsx")).toHaveLength(3);
  });

  it.each(['', 'variant', 'variant=""', 'variant={undefined}', 'variant={null}', 'variant={false}', 'variant={true}', 'variant={""}'])
    ("rejects a missing or empty variant: %s", (prop) => {
      expect(audit(`<Input ${prop}/>`)).toHaveLength(1);
    });

  it("rejects a variant supplied only through a spread", () => {
    expect(audit(`<Input {...props}/>`)).toHaveLength(1);
  });

  it("allows hidden file pickers but rejects visible native controls", () => {
    expect(audit(`<><input type="file" hidden/><input type="file" hidden={true}/>
      <input type="file" className="hidden"/><input type="hidden"/></>`)).toEqual([]);
    expect(audit(`<><input/><textarea/><select/><input type="file"/>
      <input type="file" hidden={false}/><input type="file" aria-hidden="true"/></>`)).toHaveLength(6);
  });
});
