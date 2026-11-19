import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDesktopDataDirectory } from "../packages/desktop/src/desktop-config.js";
import { buildRuntimeEnvironment, loadDesktopRuntimeOptions } from "../packages/desktop/src/runtime-config.js";
import { DesktopStartupReady } from "../packages/desktop/src/startup-ready.js";
import { createBuildIdentity, prepareRuntimePayload, readUpdateTrustFile } from "../packages/desktop/scripts/package.mjs";
import { pruneInstallerBackups, recordInstallerBackup } from "../packages/desktop/scripts/installer-history.mjs";
import { DESKTOP_LOG_FILE_BYTES, writeDesktopLog } from "../packages/desktop/src/desktop-log.js";

const directories: string[] = [];
function directory(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-isolated-desktop-")));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("isolated desktop recovery profile", () => {
  it("uses the selected private profile without touching the ordinary profile", () => {
    const parent = directory();
    const ordinary = path.join(parent, "ordinary");
    const isolated = path.join(parent, "isolated");
    expect(resolveDesktopDataDirectory(["--kulo-data-dir=" + isolated], ordinary)).toBe(fs.realpathSync(isolated));
    expect(fs.statSync(isolated).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(ordinary)).toBe(false);
    expect(resolveDesktopDataDirectory([], ordinary)).toBe(fs.realpathSync(ordinary));
    expect(fs.realpathSync(ordinary)).not.toBe(fs.realpathSync(isolated));
  });

  it("rejects ambiguous, root and linked profile directories before changing their target", () => {
    const parent = directory();
    const ordinary = path.join(parent, "ordinary");
    for (const args of [["--kulo-data-dir"], ["--kulo-data-dir=relative"], ["--kulo-data-dir=/"], ["--kulo-data-dir=" + os.homedir()], ["--kulo-data-dir=" + parent, "--kulo-data-dir=" + parent]]) {
      expect(() => resolveDesktopDataDirectory(args, ordinary)).toThrow();
    }
    const outside = path.join(parent, "outside");
    const linked = path.join(parent, "linked");
    fs.mkdirSync(outside, { mode: 0o755 });
    fs.chmodSync(outside, 0o755);
    fs.symlinkSync(outside, linked);
    expect(() => resolveDesktopDataDirectory(["--kulo-data-dir=" + linked], ordinary)).toThrow("普通目录");
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(ordinary)).toBe(false);
  });

  it("passes only the selected trusted runtime roots to the child service", () => {
    const dataDir = directory();
    const appRoot = path.join(dataDir, "payload");
    const trustedRoot = path.join(dataDir, "trusted");
    const webDir = path.join(appRoot, "web/dist");
    const source = {
      PATH: "/usr/bin:/bin", KULO_DESKTOP_APP_ROOT: "/inherited", KULO_DESKTOP_TRUSTED_ROOT: "/inherited-trust",
      KULO_DESKTOP_SOURCE_ROOT: "/inherited-source", KULO_AUTH_TOKEN: "test-inherited-token",
    };
    const env = buildRuntimeEnvironment(source, { dataDir, appRoot, trustedRoot, webDir, shellVersion: "0.1.0" });
    expect(loadDesktopRuntimeOptions(env)).toEqual({ dataDir, appRoot, trustedRoot, webDir, shellVersion: "0.1.0" });
    expect(env.KULO_AUTH_TOKEN).toBeUndefined();
    expect(env.KULO_DESKTOP_SOURCE_ROOT).toBeUndefined();
    expect(source.KULO_DESKTOP_APP_ROOT).toBe("/inherited");
    expect(() => loadDesktopRuntimeOptions({ ...env, KULO_DESKTOP_APP_ROOT: "relative" })).toThrow();
    expect(() => buildRuntimeEnvironment(source, { dataDir, webDir, shellVersion: "invalid version" })).toThrow();
  });
});

describe("desktop diagnostics and update trust boundaries", () => {
  it("keeps both desktop logs inside their shared budget and hides the current token", () => {
    const root = directory(), current = path.join(root, "desktop.log"), previous = current + ".previous";
    fs.writeFileSync(current, Buffer.alloc(DESKTOP_LOG_FILE_BYTES + 100, 65), { mode: 0o600 });
    fs.writeFileSync(previous, Buffer.alloc(DESKTOP_LOG_FILE_BYTES + 100, 66), { mode: 0o600 });
    const token = "test-management-token";
    writeDesktopLog(root, "runtime failure: " + token, token);
    expect(fs.statSync(current).size + fs.statSync(previous).size).toBeLessThanOrEqual(2 * DESKTOP_LOG_FILE_BYTES);
    expect(fs.readFileSync(current, "utf8")).not.toContain(token);
    expect(fs.statSync(current).mode & 0o777).toBe(0o600);
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "preserve");
    fs.unlinkSync(current);
    fs.symlinkSync(outside, current);
    expect(() => writeDesktopLog(root, "do not follow")).toThrow("普通文件");
    expect(fs.readFileSync(outside, "utf8")).toBe("preserve");
  });

  it("packages only explicit public trust and rejects private keys, credentials and unknown fields", async () => {
    const root = directory(), file = path.join(root, "trust.json");
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const valid = { formatVersion: 1, keys: { fixture: publicKey }, feedUrl: "https://example.com/kulo/update.json" };
    fs.writeFileSync(file, JSON.stringify(valid));
    await expect(readUpdateTrustFile(file)).resolves.toEqual(valid);
    for (const invalid of [
      { ...valid, privateKey: "not-a-public-field" },
      { ...valid, keys: { fixture: "-----BEGIN PRIVATE KEY-----\nnot-a-key" } },
      { ...valid, feedUrl: "https://user:fixture@example.com/update.json" },
      { ...valid, feedUrl: "http://example.com/update.json" },
    ]) {
      fs.writeFileSync(file, JSON.stringify(invalid));
      await expect(readUpdateTrustFile(file)).rejects.toThrow();
    }
  });
});

const nativeIt = process.platform === "darwin" ? it : it.skip;
describe("native installer backup cleanup", () => {
  nativeIt("preserves protected, unknown and modified backups while pruning old owned backups", async () => {
    const root = directory(), appId = "io.kulo.desktop.dev", appName = "Kulo Dev";
    async function backup(index: number, owned = true): Promise<string> {
      const bundle = path.join(root, "." + appName + ".backup-" + index + ".app");
      fs.mkdirSync(path.join(bundle, "Contents/MacOS"), { recursive: true });
      fs.mkdirSync(path.join(bundle, "Contents/Resources/app"), { recursive: true });
      fs.writeFileSync(path.join(bundle, "Contents/Info.plist"), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>' + appId + '</string><key>CFBundleExecutable</key><string>' + appName + '</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
      fs.copyFileSync("/usr/bin/true", path.join(bundle, "Contents/MacOS", appName));
      execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--identifier", appId, bundle], { stdio: "pipe" });
      if (owned) {
        await recordInstallerBackup(bundle);
        const marker = bundle + ".kulo-backup.json";
        fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(fs.readFileSync(marker, "utf8")), createdAt: index }));
      }
      return bundle;
    }
    const first = await backup(1), second = await backup(2), third = await backup(3), fourth = await backup(4), unknown = await backup(5, false);
    const protectedRoot = path.join(first, "Contents/Resources/app");
    let protectedAlias = protectedRoot.startsWith("/private/var/") ? protectedRoot.slice("/private".length) : protectedRoot;
    if (protectedAlias === protectedRoot) {
      protectedAlias = path.join(root, "protected-source-alias");
      fs.symlinkSync(protectedRoot, protectedAlias, "dir");
    }
    expect(protectedAlias).not.toBe(protectedRoot);
    expect(fs.realpathSync(protectedAlias)).toBe(protectedRoot);
    const removed = await pruneInstallerBackups(path.join(root, appName + ".app"), [protectedAlias]);
    expect(removed).toEqual([second]);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(third)).toBe(true);
    expect(fs.existsSync(fourth)).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);
    fs.appendFileSync(path.join(first, "Contents/Info.plist"), "\n");
    await pruneInstallerBackups(path.join(root, appName + ".app"), [], 0);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);
  });
});

describe("application-level startup readiness", () => {
  it("requires the selected frame origin before resolving, and ignores late duplicate receipts", async () => {
    const ready = new DesktopStartupReady();
    const pending = ready.wait(7, "http://127.0.0.1:17800");
    expect(ready.acknowledge(8, "http://127.0.0.1:17800")).toBe(false);
    expect(ready.acknowledge(7, "http://127.0.0.1:17801")).toBe(false);
    expect(ready.acknowledge(7, "http://127.0.0.1:17800")).toBe(true);
    await pending;
    expect(ready.acknowledge(7, "http://127.0.0.1:17800")).toBe(false);
  });

  it("rejects a UI that never renders and cancels superseded startup waits", async () => {
    const ready = new DesktopStartupReady();
    await expect(ready.wait(7, "http://127.0.0.1:17800", 5)).rejects.toThrow("界面启动超时");
    const first = expect(ready.wait(7, "http://127.0.0.1:17800")).rejects.toThrow("新的请求替代");
    const second = ready.wait(7, "http://127.0.0.1:17800");
    ready.acknowledge(7, "http://127.0.0.1:17800");
    await Promise.all([first, second]);
  });
});

describe("candidate source and runtime boundaries", () => {
  it("records actual source and dependency changes without reading private env or generated files", async () => {
    const root = directory();
    fs.mkdirSync(path.join(root, "packages/example/src"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/example/dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"kulo-monorepo"}');
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(root, "packages/example/src/index.ts"), "export const value = 1;");
    const first = await createBuildIdentity(root);
    fs.writeFileSync(path.join(root, ".env"), "PRIVATE_TEST_VALUE=first");
    fs.writeFileSync(path.join(root, "packages/example/src/.env"), "PRIVATE_TEST_VALUE=second");
    fs.writeFileSync(path.join(root, "packages/example/dist/index.js"), "generated output");
    expect(await createBuildIdentity(root)).toEqual(first);
    fs.writeFileSync(path.join(root, "packages/example/src/index.ts"), "export const value = 2;");
    expect((await createBuildIdentity(root)).sourceTreeHash).not.toBe(first.sourceTreeHash);
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '10.0'\n");
    expect((await createBuildIdentity(root)).dependencyLockHash).not.toBe(first.dependencyLockHash);
  });

  it("refuses a runtime deployment overlapping its source before running deploy or trimming files", async () => {
    const root = directory();
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"kulo-monorepo"}');
    await expect(prepareRuntimePayload(path.join(root, "payload"), { workspaceRoot: root })).rejects.toThrow("独立于源码");
    expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toContain("kulo-monorepo");
    expect(fs.existsSync(path.join(root, "payload"))).toBe(false);
  });
});
