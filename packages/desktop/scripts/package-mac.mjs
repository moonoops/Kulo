import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { patchMacAppBundleUuids } from "./macho-uuid.mjs";
import {
  APP_ID,
  assertClosedLinks,
  assertRegularFile,
  contained,
  desktopRoot,
  finalizePackagedRelease,
  portableNode,
  prepareRecoveryRuntime,
  prepareRuntimePayload,
  readUpdateTrustFile,
  resolveDesktopChannel,
  runPackagedSmokeTest,
  verifyRecoveryCleanupRuntime,
  workspaceRoot,
  writeSha256File,
} from "./payload.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export function parseCodeSigningIdentities(output) {
  const identities = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"(?:\s+\(([^)]+)\))?\s*$/.exec(line);
    if (!match) continue;
    const [, hash, name, note] = match;
    if (note && /CSSMERR|REVOKED|EXPIRED|INVALID/i.test(note)) continue;
    identities.push({ hash: hash.toUpperCase(), name });
  }
  return identities;
}

export async function resolveMacSignIdentity(options = {}) {
  const rawExplicit = options.signIdentity ?? process.env.KULO_MAC_SIGN_IDENTITY;
  const explicit = typeof rawExplicit === "string" ? rawExplicit.trim() : "";
  if (explicit) {
    if (explicit === "-" || explicit.toLowerCase() === "adhoc") {
      return { identity: "-", label: "ad-hoc", source: "explicit-adhoc", useTimestamp: false };
    }
    if (explicit.length > 256 || /[\x00-\x1f\x7f]/.test(explicit) || explicit.startsWith("-")) {
      throw new Error("macOS 签名证书标识无效。");
    }
    return {
      identity: explicit,
      label: explicit,
      source: "explicit",
      useTimestamp: explicit.startsWith("Developer ID Application:"),
    };
  }
  const listIdentities = options.listIdentities ?? (async () => {
    const { stdout } = await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    return stdout;
  });
  let identities = [];
  try {
    identities = parseCodeSigningIdentities(await listIdentities());
  } catch {
    return { identity: "-", label: "ad-hoc", source: "fallback-adhoc", useTimestamp: false };
  }
  const preferred =
    identities.find((entry) => /^Kulo\b/i.test(entry.name))
    ?? identities.find((entry) => entry.name.startsWith("Developer ID Application:"))
    ?? identities.find((entry) => entry.name.startsWith("Apple Development:"));
  if (preferred) {
    return {
      identity: preferred.hash,
      label: preferred.name,
      source: "auto",
      useTimestamp: preferred.name.startsWith("Developer ID Application:"),
    };
  }
  return { identity: "-", label: "ad-hoc", source: "fallback-adhoc", useTimestamp: false };
}

export async function signMacAppBundle(bundle, options = {}) {
  const resolved = await resolveMacSignIdentity(options);
  const exec = options.run ?? run;
  const appId = options.appId ?? APP_ID;
  const argsFor = (identity, useTimestamp) => (
    identity === "-"
      ? ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", "--identifier", appId, bundle]
      : [
          "--force",
          "--deep",
          "--sign",
          identity,
          "--preserve-metadata=entitlements",
          useTimestamp ? "--timestamp" : "--timestamp=none",
          bundle,
        ]
  );
  if (resolved.identity === "-") {
    await exec("/usr/bin/codesign", argsFor("-", false), { maxBuffer: 1024 * 1024 });
    return resolved;
  }
  try {
    await exec("/usr/bin/codesign", argsFor(resolved.identity, Boolean(resolved.useTimestamp)), { maxBuffer: 1024 * 1024 });
    return resolved;
  } catch (error) {
    if (resolved.source === "explicit") throw error;
    if (resolved.label.startsWith("Developer ID Application:")) {
      throw new Error(
        `Developer ID 签名失败（钥匙串可能已锁定，禁止静默降级为 ad-hoc）：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    await exec("/usr/bin/codesign", argsFor("-", false), { maxBuffer: 1024 * 1024 });
    return {
      identity: "-",
      label: "ad-hoc",
      source: "fallback-adhoc",
      useTimestamp: false,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createMacDmg(bundle, options = {}) {
  const appName = options.appName ?? path.basename(bundle, ".app");
  const version = options.version ?? "0.0.0";
  const arch = options.arch ?? process.arch;
  const outDir = options.outputDir ?? path.dirname(path.dirname(bundle));
  const dmgName = `${appName.replace(/\s+/g, "-")}-${version}-darwin-${arch}.dmg`;
  const dmgPath = path.join(outDir, dmgName);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-dmg-stage-"));
  try {
    await fs.cp(bundle, path.join(staging, `${appName}.app`), { recursive: true, dereference: false, verbatimSymlinks: true });
    await fs.symlink("/Applications", path.join(staging, "Applications"));
    await fs.rm(dmgPath, { force: true });
    await run("/usr/bin/hdiutil", ["create", "-volname", appName, "-srcfolder", staging, "-ov", "-format", "UDZO", dmgPath], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const signed = await resolveMacSignIdentity({ signIdentity: options.signIdentity });
    if (signed.identity !== "-") {
      await run("/usr/bin/codesign", [
        "--force",
        "--sign",
        signed.identity,
        signed.useTimestamp ? "--timestamp" : "--timestamp=none",
        dmgPath,
      ]);
    }
    await writeSha256File(dmgPath);
    return dmgPath;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function verifyMacApp(bundle, options = {}) {
  const target = options.appName && options.appId
    ? { appName: options.appName, appId: options.appId }
    : resolveDesktopChannel({ channel: options.channel });
  const resources = path.join(bundle, "Contents/Resources");
  const app = path.join(resources, "app");
  const node = path.join(resources, "runtime/node");
  const { stdout: identifier } = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")]);
  if (identifier.trim() !== target.appId) throw new Error("安装包应用标识不匹配。");
  await assertRegularFile(path.join(bundle, `Contents/MacOS/${target.appName}`));
  for (const required of [
    "dist/main.js",
    "dist/shell.js",
    "dist/runtime.js",
    "web/dist/index.html",
    "assets/kulo-icon.png",
    "assets/kulo-trayTemplate.png",
    "assets/kulo-trayTemplate@2x.png",
    "assets/kulo-tray-badge-light.png",
    "assets/kulo-tray-badge-light@2x.png",
    "assets/kulo-tray-badge-dark.png",
    "assets/kulo-tray-badge-dark@2x.png",
  ]) {
    await assertRegularFile(path.join(app, required));
  }
  await assertRegularFile(path.join(resources, "runtime/recovery/bin.js"));
  await assertRegularFile(path.join(resources, "runtime/kulo-rescue"));
  await assertClosedLinks(app);
  if (Array.isArray(options.patchedUuids)) {
    for (const entry of options.patchedUuids) {
      const { stdout: dump } = await run("/usr/bin/dwarfdump", ["--uuid", entry.executablePath]);
      for (const slice of entry.slices) {
        if (!dump.includes(slice.patchedUuid) || dump.includes(slice.originalUuid)) {
          throw new Error(`安装包可执行文件 Mach-O UUID 隔离校验失败：${entry.executablePath}`);
        }
      }
    }
  }
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  await verifyRecoveryCleanupRuntime(path.join(resources, "runtime/recovery"));
  await runPackagedSmokeTest(node, app, path.join(resources, "runtime"), { platform: "darwin" });
  return bundle;
}

export async function packageMacApp(options = {}) {
  if (process.platform !== "darwin") throw new Error("当前 macOS 打包仅支持在 macOS 上运行。");
  const { channel, appName, appId } = resolveDesktopChannel({ channel: options.channel });
  const { ensureElectron } = await import("./ensure-electron.mjs");
  await ensureElectron();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-desktop-package-"));
  const output = options.outputDir ?? path.join(workspaceRoot, "dist/desktop");
  if (!path.isAbsolute(output) || path.parse(output).root === output || contained(path.join(desktopRoot, "dist"), output)) throw new Error("桌面产物目录无效。");
  try {
    const app = path.join(temporary, "app");
    await prepareRuntimePayload(app, {
      platform: "darwin",
      requireConnector: Boolean(options.requireConnector ?? (process.env.KULO_REQUIRE_CONNECTOR === "1")),
      verifyConnectorManifest: Boolean(options.verifyConnectorManifest ?? (channel === "release")),
    });
    if (options.updateTrustFile) {
      await fs.writeFile(path.join(app, "kulo-update-trust.json"), JSON.stringify(await readUpdateTrustFile(options.updateTrustFile)) + "\n", { mode: 0o644 });
    }
    const runtime = path.join(temporary, "runtime");
    await portableNode(runtime, { platform: "darwin" });
    await prepareRecoveryRuntime(app, runtime, { platform: "darwin" });
    const electronManifest = require.resolve("electron/package.json");
    const electronVersion = JSON.parse(await fs.readFile(electronManifest, "utf8")).version;
    const checksums = JSON.parse(await fs.readFile(path.join(path.dirname(electronManifest), "checksums.json"), "utf8"));
    const manifest = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
    const sourceHelpers = await import(pathToFileURL(path.join(workspaceRoot, "packages/hub/dist/customization-source.js")).href);
    const sourceArchive = await sourceHelpers.createCustomizationSourceArchive(workspaceRoot, path.join(app, "kulo-source.json.gz"), { version: manifest.version });
    await fs.writeFile(path.join(app, "kulo-source.json"), JSON.stringify(sourceArchive) + "\n");
    await fs.chmod(path.join(app, "kulo-source.json.gz"), 0o644);
    const identity = {
      ...(sourceArchive.commit ? { sourceCommit: sourceArchive.commit } : {}),
      sourceTreeHash: sourceArchive.treeHash,
      dependencyLockHash: createHash("sha256").update(await fs.readFile(path.join(workspaceRoot, "pnpm-lock.yaml"))).digest("hex"),
    };
    const releaseOptions = {
      version: manifest.version, kind: "custom", sourceCommit: identity.sourceCommit,
      sourceTreeHash: identity.sourceTreeHash, shellVersion: manifest.version,
      checks: ["closed-dependencies"],
    };
    await fs.writeFile(path.join(runtime, "bundle.json"), `${JSON.stringify({
      appId, channel, appVersion: manifest.version, electronVersion,
      nodeVersion: process.versions.node, platform: process.platform, arch: process.arch,
      ...identity,
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const { packager } = await import("@electron/packager");
    const bundles = await packager({
      dir: app,
      name: appName,
      appBundleId: appId,
      appVersion: manifest.version,
      appCategoryType: "public.app-category.productivity",
      icon: path.join(desktopRoot, "assets/kulo.icns"),
      electronVersion,
      download: { checksums },
      platform: "darwin",
      arch: process.arch,
      out: output,
      overwrite: true,
      asar: false,
      prune: false,
      derefSymlinks: false,
      ignore: /^\/node_modules(?:\/|$)/,
      afterCopy: [async ({ buildPath }) => {
        await fs.cp(path.join(app, "node_modules"), path.join(buildPath, "node_modules"), {
          recursive: true, dereference: false, verbatimSymlinks: true,
        });
        await assertClosedLinks(buildPath);
      }],
      darwinDarkModeSupport: true,
      extendInfo: {
        CFBundleDisplayName: appName,
        LSMinimumSystemVersion: "14.0",
        NSMicrophoneUsageDescription: "Kulo 使用麦克风进行语音输入和通话。",
        NSLocalNetworkUsageDescription: "Kulo 按任务访问和诊断同一局域网内的设备与本地服务。",
        NSAppleEventsUsageDescription: "Kulo 在你连接消息和邮件后，按任务读取内容、发送消息或邮件。",
      },
      extraResource: [runtime],
    });
    if (bundles.length !== 1 || !bundles[0]) throw new Error("没有生成唯一的 macOS 应用。");
    const bundle = path.join(bundles[0], `${appName}.app`);
    const finalResources = path.join(bundle, "Contents/Resources");
    const finalApp = path.join(finalResources, "app");
    const finalManifestPath = path.join(finalApp, "package.json");
    const finalManifest = JSON.parse(await fs.readFile(finalManifestPath, "utf8"));
    finalManifest.productName = appName;
    finalManifest.kuloChannel = channel;
    await fs.writeFile(finalManifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`);
    const patchedUuids = await patchMacAppBundleUuids(bundle, { appId, appName });
    await finalizePackagedRelease(finalApp, path.join(finalResources, "runtime"), releaseOptions);
    const signed = await signMacAppBundle(bundle, { signIdentity: options.signIdentity, appId });
    await verifyMacApp(bundle, { channel, patchedUuids });
    console.log(`已构建：${bundle}（通道：${channel}，签名：${signed.label}）`);
    if (signed.identity === "-") {
      console.warn("提示：当前使用 ad-hoc 临时签名，每次重新安装后 macOS 辅助功能/录屏等系统权限需要重新授权；配置本机签名证书或 KULO_MAC_SIGN_IDENTITY 可保留权限。");
    }
    if (options.createDmg) {
      const dmg = await createMacDmg(bundle, { appName, version: manifest.version, outputDir: output, signIdentity: options.signIdentity });
      console.log(`已生成安装包：${dmg}`);
    }
    return bundle;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
