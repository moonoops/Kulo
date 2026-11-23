import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-vault-bundle-test-"));
  directories.push(root);
  const dist = path.join(root, "dist"), native = path.join(root, "native"), stateDir = path.join(root, "state");
  await Promise.all([dist, native, stateDir].map((directory) => fs.mkdir(directory)));
  for (const sibling of ["connection-vault-errors", "linux-keystore"]) {
    const siblingSource = await fs.readFile(new URL(`../packages/hub/src/${sibling}.ts`, import.meta.url), "utf8");
    const siblingTransformed = await transform(siblingSource, { loader: "ts", format: "esm", target: "node22" });
    await fs.writeFile(path.join(dist, `${sibling}.js`), siblingTransformed.code);
  }
  const source = await fs.readFile(new URL("../packages/hub/src/connection-vault.ts", import.meta.url), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "node22" });
  const module = path.join(dist, "connection-vault.mjs");
  await fs.writeFile(module, code);
  // Invalid C makes an accidental compiler fallback fail even on a development Mac.
  await fs.writeFile(path.join(native, "kulo-vault-keychain.c"), "compiler must not run");
  const bundled = path.join(dist, "kulo-vault-keychain");
  const body = '#!/bin/sh\n[ "$1" = "--status" ]\n';
  await fs.writeFile(bundled, body, { mode: 0o500 });
  const { LocalConnectionVault } = await import(/* @vite-ignore */ pathToFileURL(module).href);
  return { bundled, body, stateDir, vault: new LocalConnectionVault({ stateDir }) };
}

describe.skipIf(process.platform !== "darwin")("packaged macOS credential helper", () => {
  it("probes the bundled helper without a compiler or runtime signing and reuses its private copy", async () => {
    const { bundled, body, stateDir, vault } = await fixture();
    expect(await vault.ready()).toEqual({ available: true });
    const secure = path.join(stateDir, ".secure");
    const files = await fs.readdir(secure);
    expect(files).toHaveLength(1);
    const helper = path.join(secure, files[0]!);
    expect(await fs.readFile(helper, "utf8")).toBe(body);
    expect((await fs.stat(helper)).mode & 0o777).toBe(0o500);
    expect((await fs.stat(secure)).mode & 0o777).toBe(0o700);
    await fs.rm(bundled);
    expect(await vault.ready()).toEqual({ available: true });
    expect(await fs.readdir(secure)).toEqual(files);
  });

  it.each(["directory", "symlink"])("rejects a bundled %s instead of executing or compiling it", async (kind) => {
    const { bundled, stateDir, vault } = await fixture();
    await fs.rm(bundled);
    if (kind === "directory") await fs.mkdir(bundled);
    else await fs.symlink("/usr/bin/true", bundled);
    expect(await vault.ready()).toEqual({ available: false, error: "本机安全凭证存储不可用。" });
    expect(await fs.readdir(path.join(stateDir, ".secure"))).toEqual([]);
  });
});
