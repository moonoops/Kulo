import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReleaseManifest, readReleaseIdentity, readReleaseManifest, verifyRelease, writeReleaseManifest } from "@kulo/recovery";
import { assertClosedLinks, finalizePackagedRelease, parseCodeSigningIdentities, prepareMacAgentClis, prepareRecoveryRuntime, preserveConnectorBroker, repairDeployedSelfLink, resolveDesktopChannel, resolveMacSignIdentity, signMacAppBundle, verifyRecoveryCleanupRuntime, withPreservedWorkspaceState } from "../packages/desktop/scripts/package.mjs";
import { patchMacAppBundleUuids, patchMachOUuidBuffer, patchMachOUuidFile, readMachOUuidsFromBuffer } from "../packages/desktop/scripts/macho-uuid.mjs";
import { resolveDesktopAppIdentity } from "../packages/desktop/src/desktop-config.js";

const execFileAsync = promisify(execFile);

const temporary: string[] = [];
const desktopRoot = fileURLToPath(new URL("../packages/desktop/", import.meta.url)).replace(/\/$/, "");

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-packaging-test-"));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const nativeIt = process.platform === "darwin" ? it : it.skip;
describe("final packaged release identity", () => {
  it("records the final package JSON after packager mutations and synchronizes the runtime release", async () => {
    const root = await fixture(), resources = path.join(root, "Kulo Dev.app/Contents/Resources");
    const app = path.join(resources, "app"), runtime = path.join(resources, "runtime");
    const recovery = path.join(app, "node_modules/@kulo/recovery");
    await Promise.all([path.join(app, "dist"), path.join(app, "web/dist"), recovery, runtime].map((directory) => fs.mkdir(directory, { recursive: true })));
    await fs.cp(fileURLToPath(new URL("../packages/recovery/dist", import.meta.url)), path.join(recovery, "dist"), { recursive: true });
    await fs.writeFile(path.join(recovery, "package.json"), '{"name":"@kulo/recovery","type":"module","main":"dist/index.js"}');
    const packageFile = path.join(app, "package.json");
    const packageManifest = { name: "@kulo/desktop", version: "0.1.0", type: "module", main: "dist/main.js" };
    await fs.writeFile(packageFile, JSON.stringify({ ...packageManifest, private: true, scripts: { build: "tsc" }, devDependencies: { typescript: "5" } }));
    await fs.writeFile(path.join(app, "dist/runtime.js"), "export {};\n");
    await fs.writeFile(path.join(app, "web/dist/index.html"), "<html></html>");
    const options = { version: "0.1.0", kind: "custom" as const, sourceTreeHash: "a".repeat(64), shellVersion: "0.1.0", checks: ["closed-dependencies"] };
    const before = await createReleaseManifest(app, options);
    writeReleaseManifest(app, before);
    const bundle = { appId: "io.kulo.desktop.dev", appVersion: "0.1.0", sourceTreeHash: options.sourceTreeHash, releaseId: before.id };
    await fs.writeFile(path.join(runtime, "bundle.json"), JSON.stringify(bundle));
    await fs.writeFile(packageFile, JSON.stringify(packageManifest));
    await expect(verifyRelease(app, before, { full: true })).rejects.toThrow("版本文件");

    const finalized = await finalizePackagedRelease(app, runtime, options);
    const full = readReleaseManifest(app), compact = readReleaseIdentity(app);
    expect(finalized.id).not.toBe(before.id);
    expect(full.id).toBe(finalized.id);
    expect(compact.id).toBe(finalized.id);
    expect(JSON.parse(await fs.readFile(path.join(runtime, "bundle.json"), "utf8"))).toEqual({ ...bundle, releaseId: finalized.id });
    expect(full.files.find((entry) => entry.path === "package.json")?.sha256).toBe(createHash("sha256").update(await fs.readFile(packageFile)).digest("hex"));
    expect((await fs.stat(path.join(app, "kulo-release.json"))).mode & 0o777).toBe(0o644);
    expect((await fs.stat(path.join(app, "kulo-release.identity.json"))).mode & 0o777).toBe(0o644);
    await expect(verifyRelease(app, full, { full: true })).resolves.toBeUndefined();
    await fs.appendFile(packageFile, "\n");
    await expect(verifyRelease(app, full, { full: true })).rejects.toThrow("版本文件");
  });
});

describe("standalone recovery cleanup runtime", () => {
  async function runtimeFixture() {
    const root = await fixture(), app = path.join(root, "app"), runtime = path.join(root, "runtime");
    const recovery = path.join(app, "node_modules/@kulo/recovery");
    const env = path.join(app, "node_modules/@kulo/env");
    await Promise.all([path.join(recovery, "dist"), path.join(env, "dist"), runtime].map((directory) => fs.mkdir(directory, { recursive: true })));
    await fs.writeFile(path.join(app, "package.json"), '{"name":"fixture","type":"module"}');
    for (const [name, directory] of [["recovery", recovery], ["env", env]]) {
      await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "@kulo/" + name, type: "module", main: "dist/index.js" }));
      await fs.writeFile(path.join(directory, "dist/index.js"), 'throw new Error("Packaging must not import runtime modules");');
    }
    await fs.writeFile(path.join(recovery, "dist/bin.js"), 'throw new Error("Packaging must not invoke the CLI");');
    await fs.writeFile(path.join(runtime, "node"), "existing-node-runtime");
    const binary = path.join(env, "dist/macos-worker-cleanup");
    await fs.copyFile(fileURLToPath(new URL("../packages/env/dist/macos-worker-cleanup", import.meta.url)), binary);
    return { root, app, runtime, binary, recovery: path.join(runtime, "recovery") };
  }

  nativeIt("copies only the fixed cleanup helper and verifies it without importing Hub or Env", async () => {
    const f = await runtimeFixture();
    await prepareRecoveryRuntime(f.app, f.runtime);
    const binary = path.join(f.recovery, "macos-worker-cleanup");
    const metadata = JSON.parse(await fs.readFile(path.join(f.recovery, "kulo-cleanup-runtime.json"), "utf8"));
    expect(metadata).toEqual({ formatVersion: 1, file: "macos-worker-cleanup", sha256: createHash("sha256").update(await fs.readFile(binary)).digest("hex") });
    expect((await fs.stat(binary)).mode & 0o777).toBe(0o500);
    expect(await fs.readFile(path.join(f.runtime, "node"), "utf8")).toBe("existing-node-runtime");
    await fs.rm(path.join(f.app, "node_modules"), { recursive: true });
    await expect(verifyRecoveryCleanupRuntime(f.recovery)).resolves.toBeUndefined();
    await fs.chmod(binary, 0o700);
    await fs.appendFile(binary, Buffer.from([0]));
    await fs.chmod(binary, 0o500);
    await expect(verifyRecoveryCleanupRuntime(f.recovery)).rejects.toThrow("摘要");
  });

  nativeIt("rejects absent or linked helpers and refuses alternate cleanup metadata paths", async () => {
    const missing = await runtimeFixture();
    await fs.rm(missing.binary);
    await expect(prepareRecoveryRuntime(missing.app, missing.runtime)).rejects.toMatchObject({ code: "ENOENT" });
    const linked = await runtimeFixture();
    const outside = path.join(linked.root, "outside-cleanup");
    await fs.rename(linked.binary, outside);
    await fs.symlink(outside, linked.binary);
    await expect(prepareRecoveryRuntime(linked.app, linked.runtime)).rejects.toThrow("稳定包内的普通文件");
    const valid = await runtimeFixture();
    await prepareRecoveryRuntime(valid.app, valid.runtime);
    const metadataFile = path.join(valid.recovery, "kulo-cleanup-runtime.json");
    const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
    await fs.chmod(metadataFile, 0o600);
    await fs.writeFile(metadataFile, JSON.stringify({ ...metadata, file: "../macos-worker-cleanup" }));
    await expect(verifyRecoveryCleanupRuntime(valid.recovery)).rejects.toThrow("清单无效");
  });
});

describe("customized payload connector broker", () => {
  const filename = "kulo-connector-" + process.platform + "-" + process.arch + (process.platform === "win32" ? ".exe" : "");

  async function brokerFixture() {
    const root = await fixture(), source = path.join(root, "source"), base = path.join(root, "base"), payload = path.join(root, "payload");
    const sourceNative = path.join(source, "packages/hub/native");
    await fs.mkdir(sourceNative, { recursive: true });
    for (const directory of [base, payload]) {
      const hub = path.join(directory, "node_modules/@kulo/hub");
      await fs.mkdir(path.join(hub, "dist"), { recursive: true });
      await fs.mkdir(path.join(hub, "native"));
      await fs.writeFile(path.join(directory, "package.json"), '{"name":"broker-fixture","type":"module"}');
      await fs.writeFile(path.join(hub, "package.json"), JSON.stringify({ name: "@kulo/hub", type: "module", main: "dist/index.js" }));
      await fs.writeFile(path.join(hub, "dist/index.js"), 'throw new Error("Packaging must not import Hub");');
    }
    const baseNative = path.join(base, "node_modules/@kulo/hub/native"), payloadNative = path.join(payload, "node_modules/@kulo/hub/native");
    async function writeBroker(directory: string, contents: string, mode = 0o751) {
      const file = path.join(directory, filename);
      await fs.writeFile(file, contents);
      await fs.chmod(file, mode);
      return file;
    }
    return { root, source, base, payload, sourceNative, baseNative, payloadNative, writeBroker, options: { workspaceRoot: source, basePayloadRoot: base } };
  }

  it("copies only the fixed base broker with its executable mode and preserves other native modules", async () => {
    const f = await brokerFixture();
    await f.writeBroker(f.baseNative, "trusted-base-broker");
    const other = path.join(f.payloadNative, "kulo-native-applications");
    await fs.writeFile(other, "new-source-native-module");
    await fs.writeFile(path.join(f.baseNative, "kulo-native-applications"), "old-base-native-module");
    await fs.writeFile(path.join(f.baseNative, "unrelated-native"), "not-inherited");
    await preserveConnectorBroker(f.payload, f.options);
    expect(await fs.readFile(path.join(f.payloadNative, filename), "utf8")).toBe("trusted-base-broker");
    expect((await fs.stat(path.join(f.payloadNative, filename))).mode & 0o777).toBe(0o751);
    expect(await fs.readFile(other, "utf8")).toBe("new-source-native-module");
    expect((await fs.readdir(f.payloadNative)).sort()).toEqual([filename, "kulo-native-applications"].sort());
    expect(await fs.readFile(path.join(f.baseNative, filename), "utf8")).toBe("trusted-base-broker");
  });

  it("keeps an existing payload broker and prefers a source broker over the base", async () => {
    const f = await brokerFixture();
    await f.writeBroker(f.sourceNative, "source-built-broker", 0o750);
    await f.writeBroker(f.baseNative, "older-base-broker");
    await preserveConnectorBroker(f.payload, f.options);
    const output = path.join(f.payloadNative, filename);
    expect(await fs.readFile(output, "utf8")).toBe("source-built-broker");
    expect((await fs.stat(output)).mode & 0o777).toBe(0o750);
    await f.writeBroker(f.payloadNative, "already-deployed-broker", 0o700);
    await f.writeBroker(f.sourceNative, "different-source-broker");
    await preserveConnectorBroker(f.payload, f.options);
    expect(await fs.readFile(output, "utf8")).toBe("already-deployed-broker");
    expect((await fs.stat(output)).mode & 0o777).toBe(0o700);
  });

  it("leaves an optional absent broker absent with or without a base payload", async () => {
    const f = await brokerFixture();
    await preserveConnectorBroker(f.payload, { workspaceRoot: f.source });
    await preserveConnectorBroker(f.payload, f.options);
    expect(await fs.readdir(f.payloadNative)).toEqual([]);
  });

  it("rejects linked broker files in the source, base, or output without changing their targets", async () => {
    for (const location of ["sourceNative", "baseNative", "payloadNative"] as const) {
      const f = await brokerFixture();
      const outside = path.join(f.root, "outside-broker");
      await fs.writeFile(outside, "outside-file");
      await fs.chmod(outside, 0o751);
      await fs.symlink(outside, path.join(f[location], filename));
      await expect(preserveConnectorBroker(f.payload, f.options)).rejects.toThrow("可执行的普通文件");
      expect(await fs.readFile(outside, "utf8")).toBe("outside-file");
    }
  });

  it("rejects linked native directories and base Hub dependencies outside the payload", async () => {
    const linked = await brokerFixture();
    const outside = path.join(linked.root, "outside-native");
    await fs.rename(linked.baseNative, outside);
    await linked.writeBroker(outside, "outside-broker");
    await fs.symlink(outside, linked.baseNative, "dir");
    await expect(preserveConnectorBroker(linked.payload, linked.options)).rejects.toThrow("普通目录");
    const escaped = await brokerFixture();
    const baseHub = path.dirname(escaped.baseNative), outsideHub = path.join(escaped.root, "outside-hub");
    await escaped.writeBroker(escaped.baseNative, "outside-dependency-broker");
    await fs.rename(baseHub, outsideHub);
    await fs.symlink(outsideHub, baseHub, "dir");
    await expect(preserveConnectorBroker(escaped.payload, escaped.options)).rejects.toThrow("制品外部");
    expect(await fs.readdir(escaped.payloadNative)).toEqual([]);
  });
});

describe("packaged macOS computer drivers", () => {
  async function drivers() {
    const root = await fixture();
    await fs.writeFile(path.join(root, "package.json"), '{"name":"env-fixture"}');
    const browser = path.join(root, "node_modules/agent-browser");
    const desktop = path.join(root, "node_modules/agent-desktop");
    const platform = path.join(root, `node_modules/@agent-browser/cli-darwin-${process.arch}`);
    await Promise.all([path.join(browser, "bin"), path.join(browser, "scripts"), path.join(desktop, "bin"), path.join(platform, "bin")].map((directory) => fs.mkdir(directory, { recursive: true })));
    await fs.writeFile(path.join(browser, "package.json"), JSON.stringify({ name: "agent-browser", type: "module", bin: { "agent-browser": "bin/agent-browser.js" } }));
    await fs.writeFile(path.join(browser, "bin/agent-browser.js"), "launcher creates files");
    const require = (await import("node:module")).createRequire(import.meta.url);
    const locator = path.join(path.dirname(require.resolve("agent-browser/package.json", { paths: [fileURLToPath(new URL("../packages/env", import.meta.url))] })), "scripts/native.js");
    await fs.copyFile(locator, path.join(browser, "scripts/native.js"));
    await fs.writeFile(path.join(platform, "package.json"), JSON.stringify({ name: `@agent-browser/cli-darwin-${process.arch}` }));
    await fs.writeFile(path.join(platform, "bin/agent-browser"), "browser-native");
    await fs.writeFile(path.join(desktop, "package.json"), JSON.stringify({ name: "agent-desktop", bin: { "agent-desktop": "bin/agent-desktop" } }));
    await fs.writeFile(path.join(desktop, "bin/agent-desktop"), "launcher creates a notice");
    await fs.writeFile(path.join(desktop, `bin/agent-desktop-darwin-${process.arch}`), "desktop-native");
    const helper = path.join(desktop, `bin/agent-desktop-macos-helper-darwin-${process.arch}`);
    await fs.writeFile(helper, "desktop-helper");
    return { root, browser, desktop, helper };
  }

  it("points both manifests directly at bundled native drivers and prepares the desktop helper", async () => {
    const { root, browser, desktop } = await drivers();
    await prepareMacAgentClis(root);
    for (const [name, directory] of [["agent-browser", browser], ["agent-desktop", desktop]]) {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      expect(manifest.bin[name]).toBe(`./bin/${name}-darwin-${process.arch}`);
      const binary = path.resolve(directory, manifest.bin[name]);
      expect(await fs.readFile(binary, "utf8")).toBe(name === "agent-browser" ? "browser-native" : "desktop-native");
      expect((await fs.stat(binary)).mode & 0o111).toBe(0o111);
    }
    expect(await fs.readFile(path.join(desktop, "bin/agent-desktop-macos-helper"), "utf8")).toBe("desktop-helper");
    expect(await fs.readFile(path.join(browser, "bin/agent-browser.js"), "utf8")).toBe("launcher creates files");
    await expect(assertClosedLinks(root)).resolves.toBeUndefined();
  });

  it("rejects an incomplete desktop helper before producing a distributable", async () => {
    const { root, helper } = await drivers();
    await fs.rm(helper);
    await expect(prepareMacAgentClis(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("desktop deployment links", () => {
  it("repairs only the legacy deployment's known workspace self-reference", async () => {
    const stage = await fixture();
    const self = path.join(stage, "node_modules/.pnpm/node_modules/@kulo/desktop");
    await fs.mkdir(path.dirname(self), { recursive: true });
    await fs.symlink(path.relative(path.dirname(self), desktopRoot), self, "dir");
    await repairDeployedSelfLink(stage);
    expect(await fs.realpath(self)).toBe(await fs.realpath(stage));
    await expect(assertClosedLinks(stage)).resolves.toBeUndefined();
    await expect(repairDeployedSelfLink(stage)).resolves.toBeUndefined();
  });

  it("rejects an unexpected self-reference target", async () => {
    const stage = await fixture();
    const other = await fixture();
    const self = path.join(stage, "node_modules/.pnpm/node_modules/@kulo/desktop");
    await fs.mkdir(path.dirname(self), { recursive: true });
    await fs.symlink(other, self, "dir");
    await expect(repairDeployedSelfLink(stage)).rejects.toThrow("未知位置");
    expect(await fs.readlink(self)).toBe(other);
  });

  it("continues rejecting other broken or external dependency links", async () => {
    const stage = await fixture();
    await fs.symlink("missing", path.join(stage, "broken"));
    await repairDeployedSelfLink(stage);
    await expect(assertClosedLinks(stage)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(path.join(stage, "broken"));
    const other = await fixture();
    await fs.symlink(other, path.join(stage, "external"), "dir");
    await expect(assertClosedLinks(stage)).rejects.toThrow("指向包外");
  });
});

describe("desktop deployment workspace cache", () => {
  async function workspace() {
    const root = await fixture();
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "package.json"), '{"name":"workspace"}');
    await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await fs.writeFile(path.join(root, "node_modules/.modules.yaml"), "included: dev\n");
    const cache = path.join(root, "node_modules/.pnpm-workspace-state-v1.json");
    const state = { projects: { [root]: { name: "workspace", version: "1" } }, settings: { dev: true, production: false, nodeLinker: "isolated" }, filteredInstall: false, lastValidatedTimestamp: 1 };
    const original = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(cache, original);
    return { root, cache, state, original };
  }

  it("restores the exact development cache after production deployment", async () => {
    const { root, cache, state, original } = await workspace();
    const result = await withPreservedWorkspaceState(root, async () => {
      await fs.writeFile(cache, JSON.stringify({ ...state, settings: { ...state.settings, dev: false, production: true }, filteredInstall: true, lastValidatedTimestamp: 2 }));
      return "deployed";
    });
    expect(result).toBe("deployed");
    expect(await fs.readFile(cache, "utf8")).toBe(original);
  });

  it("restores the cache even when deployment fails", async () => {
    const { root, cache, state, original } = await workspace();
    await expect(withPreservedWorkspaceState(root, async () => {
      await fs.writeFile(cache, JSON.stringify({ ...state, settings: { ...state.settings, dev: false, production: true } }));
      throw new Error("deploy failed");
    })).rejects.toThrow("deploy failed");
    expect(await fs.readFile(cache, "utf8")).toBe(original);
  });

  it("does not overwrite cache updates when project configuration changes concurrently", async () => {
    const { root, cache, state } = await workspace();
    const updated = JSON.stringify({ ...state, settings: { ...state.settings, dev: false, production: true } });
    await expect(withPreservedWorkspaceState(root, async () => {
      await fs.writeFile(cache, updated);
      await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
    })).rejects.toThrow("工作区依赖或配置发生变化");
    expect(await fs.readFile(cache, "utf8")).toBe(updated);
  });

  it("rejects unexpected workspace-state changes without reverting them", async () => {
    const { root, cache, state } = await workspace();
    const updated = JSON.stringify({ ...state, projects: {}, settings: { ...state.settings, dev: false, production: true } });
    await expect(withPreservedWorkspaceState(root, async () => fs.writeFile(cache, updated))).rejects.toThrow("工作区依赖或配置发生变化");
    expect(await fs.readFile(cache, "utf8")).toBe(updated);
  });
});

describe("macOS app bundle code signing", () => {
  const sampleIdentities = [
    '  1) 1111111111111111111111111111111111111111 "Revoked Dev" (CSSMERR_TP_CERT_REVOKED)',
    '  2) 2222222222222222222222222222222222222222 "Apple Development: Example Dev (TEAM123456)"',
    '  3) 3333333333333333333333333333333333333333 "Developer ID Application: Example Corp (TEAM123456)"',
    '  4) 4444444444444444444444444444444444444444 "Kulo Local Dev"',
    '     4 valid identities found',
  ].join("\n");

  it("parses valid identities while ignoring revoked/invalid entries", () => {
    expect(parseCodeSigningIdentities(sampleIdentities)).toEqual([
      { hash: "2222222222222222222222222222222222222222", name: "Apple Development: Example Dev (TEAM123456)" },
      { hash: "3333333333333333333333333333333333333333", name: "Developer ID Application: Example Corp (TEAM123456)" },
      { hash: "4444444444444444444444444444444444444444", name: "Kulo Local Dev" },
    ]);
  });

  it("prioritizes explicit identity, Kulo local cert, Developer ID, Apple Development, then ad-hoc", async () => {
    await expect(resolveMacSignIdentity({ signIdentity: "Custom Cert" })).resolves.toMatchObject({
      identity: "Custom Cert", source: "explicit", useTimestamp: false,
    });
    await expect(resolveMacSignIdentity({ signIdentity: "adhoc" })).resolves.toMatchObject({
      identity: "-", source: "explicit-adhoc",
    });
    await expect(resolveMacSignIdentity({ signIdentity: "--bad" })).rejects.toThrow("无效");

    await expect(resolveMacSignIdentity({ signIdentity: "", listIdentities: async () => sampleIdentities })).resolves.toMatchObject({
      identity: "4444444444444444444444444444444444444444", label: "Kulo Local Dev", source: "auto", useTimestamp: false,
    });
    const withoutKulo = sampleIdentities.split("\n").filter((line) => !line.includes("Kulo Local Dev")).join("\n");
    await expect(resolveMacSignIdentity({ signIdentity: "", listIdentities: async () => withoutKulo })).resolves.toMatchObject({
      identity: "3333333333333333333333333333333333333333", source: "auto", useTimestamp: true,
    });
    const onlyAppleDev = sampleIdentities.split("\n").filter((line) => line.includes("Apple Development")).join("\n");
    await expect(resolveMacSignIdentity({ signIdentity: "", listIdentities: async () => onlyAppleDev })).resolves.toMatchObject({
      identity: "2222222222222222222222222222222222222222", source: "auto", useTimestamp: false,
    });
    await expect(resolveMacSignIdentity({ signIdentity: "", listIdentities: async () => "0 valid identities found" })).resolves.toMatchObject({
      identity: "-", source: "fallback-adhoc",
    });
  });

  it("signs with stable certificates without overriding nested bundle identifiers and falls back only for auto identities", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec = vi.fn(async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    });

    const devSigned = await signMacAppBundle("/tmp/Kulo Dev.app", {
      signIdentity: "",
      listIdentities: async () => '  1) 2222222222222222222222222222222222222222 "Apple Development: Example Dev (TEAM123456)"',
      run: exec,
    });
    expect(devSigned).toMatchObject({ identity: "2222222222222222222222222222222222222222", source: "auto" });
    expect(calls[0]?.args).toEqual(["--force", "--deep", "--sign", "2222222222222222222222222222222222222222", "--preserve-metadata=entitlements", "--timestamp=none", "/tmp/Kulo Dev.app"]);

    // Auto-selected signing failure (e.g. locked keychain in CI) falls back to ad-hoc.
    const lockedExec = vi.fn(async (_file: string, args: string[]) => {
      if (args[3] !== "-") throw new Error("errSecInteractionNotAllowed");
      return { stdout: "", stderr: "" };
    });
    const fallback = await signMacAppBundle("/tmp/Kulo Dev.app", {
      signIdentity: "",
      listIdentities: async () => '  1) 2222222222222222222222222222222222222222 "Apple Development: Example Dev (TEAM123456)"',
      run: lockedExec,
    });
    expect(fallback).toMatchObject({ identity: "-", source: "fallback-adhoc" });
    expect(lockedExec).toHaveBeenCalledTimes(2);

    // Explicit identity failures propagate instead of silently downgrading to ad-hoc.
    await expect(signMacAppBundle("/tmp/Kulo Dev.app", {
      signIdentity: "Developer ID Application: Example Corp (TEAM123456)",
      run: lockedExec,
    })).rejects.toThrow("errSecInteractionNotAllowed");

    // Auto-selected Developer ID Application failures must NOT silently downgrade to ad-hoc (preserves Team ID).
    await expect(signMacAppBundle("/tmp/Kulo Dev.app", {
      signIdentity: "",
      listIdentities: async () => '  1) 1111111111111111111111111111111111111111 "Developer ID Application: Example Corp (TEAM123456)"',
      run: lockedExec,
    })).rejects.toThrow("禁止静默降级");

    // Release channel ad-hoc signing uses the release bundle identifier.
    const releaseCalls: Array<{ file: string; args: string[] }> = [];
    await signMacAppBundle("/tmp/Kulo.app", {
      signIdentity: "adhoc",
      appId: "io.kulo.desktop",
      run: vi.fn(async (file: string, args: string[]) => {
        releaseCalls.push({ file, args });
        return { stdout: "", stderr: "" };
      }),
    });
    expect(releaseCalls[0]?.args).toEqual(["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", "--identifier", "io.kulo.desktop", "/tmp/Kulo.app"]);
  });

  it("resolves dev and release desktop packaging channels and runtime identities cleanly", async () => {
    expect(resolveDesktopChannel({})).toEqual({ channel: "dev", appName: "Kulo Dev", appId: "io.kulo.desktop.dev" });
    expect(resolveDesktopChannel({ channel: "dev" })).toEqual({ channel: "dev", appName: "Kulo Dev", appId: "io.kulo.desktop.dev" });
    expect(resolveDesktopChannel({ channel: "release" })).toEqual({ channel: "release", appName: "Kulo", appId: "io.kulo.desktop" });
    expect(() => resolveDesktopChannel({ channel: "beta" })).toThrow("无效的桌面发布通道");

    const dir = await fixture();
    const devManifest = path.join(dir, "dev-package.json");
    const releaseManifest = path.join(dir, "release-package.json");
    await fs.writeFile(devManifest, JSON.stringify({ productName: "Kulo Dev", kuloChannel: "dev" }));
    await fs.writeFile(releaseManifest, JSON.stringify({ productName: "Kulo", kuloChannel: "release" }));

    expect(resolveDesktopAppIdentity(devManifest)).toEqual({
      channel: "dev", appName: "Kulo Dev", bundleId: "io.kulo.desktop.dev", sessionPartition: "persist:kulo-dev",
    });
    expect(resolveDesktopAppIdentity(releaseManifest)).toEqual({
      channel: "release", appName: "Kulo", bundleId: "io.kulo.desktop", sessionPartition: "persist:kulo",
    });
  });

  it("deterministically rewrites Thin and Universal Fat Mach-O LC_UUIDs per channel and helper role without touching framework/node", async () => {
    function makeThinMachO(cpuType: number, uuidHex: string): Buffer {
      const buf = Buffer.alloc(64);
      buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
      buf.writeUInt32LE(cpuType, 4);
      buf.writeUInt32LE(1, 16); // ncmds = 1
      buf.writeUInt32LE(24, 20); // sizeofcmds = 24
      buf.writeUInt32LE(0x1b, 32); // LC_UUID
      buf.writeUInt32LE(24, 36); // cmdsize = 24
      Buffer.from(uuidHex, "hex").copy(buf, 40);
      return buf;
    }

    const origHex = "4c4c448455553144a1042ea30dd34d47";
    const arm64 = makeThinMachO(0x0100000c, origHex);
    const x86_64 = makeThinMachO(0x01000007, origHex);

    // 1. Thin Mach-O determinism & cross-channel isolation
    const devA = patchMachOUuidBuffer(arm64, { appId: "io.kulo.desktop.dev", role: "main" });
    const devB = patchMachOUuidBuffer(arm64, { appId: "io.kulo.desktop.dev", role: "main" });
    const rel = patchMachOUuidBuffer(arm64, { appId: "io.kulo.desktop", role: "main" });
    const helper = patchMachOUuidBuffer(arm64, { appId: "io.kulo.desktop.dev", role: "helper" });
    expect(devA.buffer.equals(devB.buffer)).toBe(true);
    expect(devA.slices[0]!.patchedUuid).not.toBe("4C4C4484-5555-3144-A104-2EA30DD34D47");
    expect(devA.slices[0]!.patchedUuid).not.toBe(rel.slices[0]!.patchedUuid);
    expect(devA.slices[0]!.patchedUuid).not.toBe(helper.slices[0]!.patchedUuid);
    expect(readMachOUuidsFromBuffer(devA.buffer)).toEqual([{ cpuType: 0x0100000c, uuid: devA.slices[0]!.patchedUuid }]);

    // 2. Universal Fat 32-bit Big-Endian (0xcafebabe) multi-slice patching
    const fat32 = Buffer.alloc(64 + arm64.length + x86_64.length);
    fat32.writeUInt32BE(0xcafebabe, 0);
    fat32.writeUInt32BE(2, 4);
    fat32.writeUInt32BE(0x0100000c, 8); fat32.writeUInt32BE(64, 16); fat32.writeUInt32BE(arm64.length, 20);
    fat32.writeUInt32BE(0x01000007, 28); fat32.writeUInt32BE(64 + arm64.length, 36); fat32.writeUInt32BE(x86_64.length, 40);
    arm64.copy(fat32, 64);
    x86_64.copy(fat32, 64 + arm64.length);
    const patchedFat32 = patchMachOUuidBuffer(fat32, { appId: "io.kulo.desktop.dev", role: "main" });
    expect(patchedFat32.slices).toHaveLength(2);
    expect(patchedFat32.slices[0]!.patchedUuid).not.toBe(patchedFat32.slices[1]!.patchedUuid);
    expect(readMachOUuidsFromBuffer(patchedFat32.buffer).map((s) => s.uuid)).toEqual(patchedFat32.slices.map((s) => s.patchedUuid));

    // 3. Universal Fat 64-bit Big-Endian (0xcafebabf) multi-slice patching
    const fat64 = Buffer.alloc(96 + arm64.length + x86_64.length);
    fat64.writeUInt32BE(0xcafebabf, 0);
    fat64.writeUInt32BE(2, 4);
    fat64.writeUInt32BE(0x0100000c, 8); fat64.writeBigUInt64BE(96n, 16); fat64.writeBigUInt64BE(BigInt(arm64.length), 24);
    fat64.writeUInt32BE(0x01000007, 40); fat64.writeBigUInt64BE(BigInt(96 + arm64.length), 48); fat64.writeBigUInt64BE(BigInt(x86_64.length), 56);
    arm64.copy(fat64, 96);
    x86_64.copy(fat64, 96 + arm64.length);
    const patchedFat64 = patchMachOUuidBuffer(fat64, { appId: "io.kulo.desktop", role: "main" });
    expect(patchedFat64.slices).toHaveLength(2);
    expect(readMachOUuidsFromBuffer(patchedFat64.buffer).map((s) => s.uuid)).toEqual(patchedFat64.slices.map((s) => s.patchedUuid));

    // 4. Bundle patcher rewrites exactly the 5 .app launchers and leaves Electron Framework & runtime/node untouched
    const dir = await fixture();
    const bundle = path.join(dir, "Kulo Dev.app");
    const launchers = [
      path.join(bundle, "Contents/MacOS/Kulo Dev"),
      path.join(bundle, "Contents/Frameworks/Kulo Dev Helper.app/Contents/MacOS/Kulo Dev Helper"),
      path.join(bundle, "Contents/Frameworks/Kulo Dev Helper (GPU).app/Contents/MacOS/Kulo Dev Helper (GPU)"),
      path.join(bundle, "Contents/Frameworks/Kulo Dev Helper (Plugin).app/Contents/MacOS/Kulo Dev Helper (Plugin)"),
      path.join(bundle, "Contents/Frameworks/Kulo Dev Helper (Renderer).app/Contents/MacOS/Kulo Dev Helper (Renderer)"),
    ];
    for (const file of launchers) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, arm64);
    }
    const framework = path.join(bundle, "Contents/Frameworks/Electron Framework.framework/Electron Framework");
    const nodeBin = path.join(bundle, "Contents/Resources/runtime/node");
    await fs.mkdir(path.dirname(framework), { recursive: true });
    await fs.mkdir(path.dirname(nodeBin), { recursive: true });
    await fs.writeFile(framework, arm64);
    await fs.writeFile(nodeBin, arm64);

    const patched = await patchMacAppBundleUuids(bundle, { appId: "io.kulo.desktop.dev", appName: "Kulo Dev" });
    expect(patched).toHaveLength(5);
    expect(new Set(patched.map((p) => p.slices[0]!.patchedUuid)).size).toBe(5);
    expect((await fs.readFile(framework)).equals(arm64)).toBe(true);
    expect((await fs.readFile(nodeBin)).equals(arm64)).toBe(true);
  });

  nativeIt("produces a valid codesign-verifiable macOS binary after LC_UUID rewrite", async () => {
    const dir = await fixture();
    const copyPath = path.join(dir, "launcher");
    await fs.copyFile("/bin/echo", copyPath);
    await fs.chmod(copyPath, 0o755);
    const patched = await patchMachOUuidFile(copyPath, { appId: "io.kulo.desktop.dev", role: "main" });
    await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "io.kulo.desktop.dev.test", copyPath]);
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", copyPath]);
    const { stdout: dump } = await execFileAsync("/usr/bin/dwarfdump", ["--uuid", copyPath]);
    for (const slice of patched.slices) {
      expect(dump).toContain(slice.patchedUuid);
      expect(dump).not.toContain(slice.originalUuid);
    }
    const { stdout: runOut } = await execFileAsync(copyPath, ["kulo-uuid-ok"]);
    expect(runOut.trim()).toBe("kulo-uuid-ok");
  });

  it("wraps all resolved filesystem dynamic imports in desktop scripts with pathToFileURL for Windows ESM compatibility", async () => {
    const scriptsDir = path.resolve("packages/desktop/scripts");
    const entries = await fs.readdir(scriptsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".mjs")) continue;
      const source = await fs.readFile(path.join(scriptsDir, entry), "utf8");
      for (const match of source.matchAll(/\bimport\(\s*([^)]+)\)/g)) {
        const arg = match[1]!.trim();
        // Relative or bare package specifiers like "./ensure-electron.mjs" or "@electron/packager" are valid everywhere.
        if (/^['"`]/.test(arg)) continue;
        expect(arg, `${entry} dynamic import(${arg}) must use pathToFileURL(...).href for Windows`).toMatch(/^pathToFileURL\(/);
      }
    }
  });
});
