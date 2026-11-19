import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseManifest, verifyRelease, writeReleaseManifest } from "@kulo/recovery";
import { prepareWebCustomizationPayload } from "../packages/hub/src/customization-payload.js";

const roots: string[] = [];
afterEach(async () => {
  const writable = async (root: string): Promise<void> => {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    await fs.chmod(root, 0o700);
    for (const entry of await fs.readdir(root)) await writable(path.join(root, entry));
  };
  for (const root of roots.splice(0)) { await writable(root); await fs.rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kulo-web-payload-"))); roots.push(root);
  const workRoot = path.join(root, "work"), sourceRoot = path.join(workRoot, "source"), basePayloadRoot = path.join(root, "base"), outputRoot = path.join(workRoot, "payload");
  const write = async (file: string, content: string, mode = 0o600) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, { mode }); };
  await write(path.join(basePayloadRoot, "package.json"), '{"type":"module"}');
  await write(path.join(basePayloadRoot, "dist/runtime.js"), "export {value} from '../node_modules/fixture-dep/index.js';");
  await write(path.join(basePayloadRoot, "node_modules/fixture-dep/package.json"), '{"type":"module"}');
  await write(path.join(basePayloadRoot, "node_modules/fixture-dep/index.js"), "export const value='preserved-production-dependency';");
  await fs.symlink("fixture-dep", path.join(basePayloadRoot, "node_modules/fixture-dep-alias"));
  await write(path.join(basePayloadRoot, "native/helper"), "#!/bin/sh\nprintf 'preserved-native'\n", 0o700);
  await write(path.join(basePayloadRoot, "web/dist/index.html"), '<div id="root">old</div><script src="/app.js"></script>');
  await write(path.join(basePayloadRoot, "web/dist/app.js"), "window.old=true;");
  await write(path.join(basePayloadRoot, "kulo-source.json"), '{"fixture":"source-metadata"}');
  await write(path.join(basePayloadRoot, "kulo-source.json.gz"), "fixture-source-archive");
  await write(path.join(sourceRoot, "packages/web/dist/index.html"), '<div id="root">new</div><script src="/app.js"></script>');
  await write(path.join(sourceRoot, "packages/web/dist/app.js"), "window.new=true;");
  await fs.symlink("app.js", path.join(sourceRoot, "packages/web/dist/app-alias.js"));
  await write(path.join(sourceRoot, "packages/hub/dist/runtime.js"), "throw new Error('candidate backend must not enter payload');");
  await write(path.join(sourceRoot, "packages/desktop/scripts/package.mjs"), "throw new Error('candidate packaging must never execute');");
  await write(path.join(sourceRoot, "node_modules/fixture-dep/index.js"), "export const value='candidate-installed-dependency';");
  const manifest = await createReleaseManifest(basePayloadRoot, { kind: "official", version: "0.1.0" }); writeReleaseManifest(basePayloadRoot, manifest);
  const options = { workRoot, sourceRoot, basePayloadRoot, baseReleaseId: manifest.id };
  return { root, workRoot, sourceRoot, outputRoot, basePayloadRoot, manifest, options, write };
}

describe("stable Web payload overlay", () => {
  it("preserves the exact base runtime, dependencies, native executables and internal links while replacing only Web output", async () => {
    const f = await fixture();
    for (const directory of [f.basePayloadRoot, path.join(f.basePayloadRoot, "dist"), path.join(f.basePayloadRoot, "node_modules"),
      path.join(f.basePayloadRoot, "node_modules/fixture-dep"), path.join(f.basePayloadRoot, "native"), path.join(f.basePayloadRoot, "web"), path.join(f.basePayloadRoot, "web/dist")]) await fs.chmod(directory, 0o500);
    await prepareWebCustomizationPayload(f.outputRoot, f.options);
    expect(await fs.readFile(path.join(f.outputRoot, "web/dist/app.js"), "utf8")).toBe("window.new=true;");
    expect(await fs.readlink(path.join(f.outputRoot, "web/dist/app-alias.js"))).toBe("app.js");
    expect(await fs.readlink(path.join(f.outputRoot, "node_modules/fixture-dep-alias"))).toBe("fixture-dep");
    const result = await createReleaseManifest(f.outputRoot, { kind: "custom", version: "0.1.0" }); await verifyRelease(f.outputRoot, result, { full: true });
    const inherited = f.manifest.files.filter((file) => !file.path.startsWith("web/dist/") && !file.path.startsWith("kulo-source.json"));
    expect(result.files.filter((file) => !file.path.startsWith("web/dist/"))).toEqual(inherited);
    expect(execFileSync(path.join(f.outputRoot, "native/helper"), { encoding: "utf8" })).toBe("preserved-native");
    const script = "const m=await import(" + JSON.stringify(new URL("file://" + path.join(f.outputRoot, "dist/runtime.js")).href) + ");console.log(m.value);";
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim()).toBe("preserved-production-dependency");
    for (const file of ["kulo-release.json", "kulo-release.identity.json", "kulo-source.json", "kulo-source.json.gz"]) await expect(fs.lstat(path.join(f.outputRoot, file))).rejects.toMatchObject({ code: "ENOENT" });
    await verifyRelease(f.basePayloadRoot, f.manifest, { full: true });
  });

  it("rejects a different base identity and a modified or externally linked base before copying", async () => {
    const f = await fixture();
    await expect(prepareWebCustomizationPayload(f.outputRoot, { ...f.options, baseReleaseId: "release_" + "0".repeat(24) })).rejects.toMatchObject({ code: "customization_payload_invalid" });
    await f.write(path.join(f.root, "external"), "outside"); await fs.symlink("../../external", path.join(f.basePayloadRoot, "node_modules/escape"));
    await expect(prepareWebCustomizationPayload(f.outputRoot, f.options)).rejects.toMatchObject({ code: "unsafe_release_link" });
    await expect(fs.lstat(f.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["source", "web-parent", "output"])("rejects a linked %s directory without writing through it", async (target) => {
    const f = await fixture(), external = path.join(f.root, "outside-directory"); await fs.mkdir(external);
    const location = target === "source" ? f.sourceRoot : target === "web-parent" ? path.join(f.sourceRoot, "packages/web") : f.outputRoot;
    if (target !== "output") await fs.rename(location, path.join(f.workRoot, "moved-" + target));
    await fs.symlink(external, location);
    await expect(prepareWebCustomizationPayload(f.outputRoot, f.options)).rejects.toMatchObject({ code: "customization_payload_invalid" });
    expect(await fs.readdir(external)).toEqual([]);
  });

  it.each(["symlink", "hardlink", "special"])("rejects a Web %s that is outside the supported build tree", async (kind) => {
    const f = await fixture(), outside = path.join(f.root, "outside-file"), target = path.join(f.sourceRoot, "packages/web/dist/unsafe");
    await f.write(outside, "untouched-outside");
    if (kind === "symlink") await fs.symlink(outside, target);
    else if (kind === "hardlink") await fs.link(outside, target);
    else if (process.platform === "win32") return;
    else execFileSync("mkfifo", [target]);
    await expect(prepareWebCustomizationPayload(f.outputRoot, f.options)).rejects.toMatchObject({ code: "customization_payload_invalid" });
    expect(await fs.readFile(outside, "utf8")).toBe("untouched-outside");
    await expect(fs.lstat(f.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
