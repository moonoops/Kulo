import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
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
  safeChmod,
  workspaceRoot,
  writeSha256File,
} from "./payload.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const linuxAssetsDir = fileURLToPath(new URL("./linux", import.meta.url));

function debArch(arch) {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`不支持的 Linux Debian 架构：${arch}`);
}

async function hasTool(command, args = ["--version"]) {
  try {
    await run(command, args, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function renderLinuxCliWrapper(installDir, appBinaryName) {
  return `#!/bin/sh
set -eu
KULO_INSTALL_DIR="${installDir}"
KULO_NODE="$KULO_INSTALL_DIR/resources/runtime/node"
KULO_CLI="$KULO_INSTALL_DIR/resources/app/node_modules/@kulo/cli/dist/bin.js"
if [ "$#" -gt 0 ]; then
  case "$1" in
    host|hub|dev|open|join|env|chat|version|-v|--version|help|-h|--help)
      exec "$KULO_NODE" "$KULO_CLI" "$@"
      ;;
  esac
fi
exec "$KULO_INSTALL_DIR/${appBinaryName}" "$@"
`;
}

export function renderLinuxRuntimeHostWrapper() {
  return `#!/bin/sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$ROOT_DIR/runtime/node" "$ROOT_DIR/app/node_modules/@kulo/cli/dist/headless-host.js" "$@"
`;
}

export async function verifyLinuxApp(bundleDir, options = {}) {
  const target = options.appName && options.appId
    ? { appName: options.appName, appId: options.appId }
    : resolveDesktopChannel({ channel: options.channel });
  const resources = path.join(bundleDir, "resources");
  const app = path.join(resources, "app");
  const node = path.join(resources, "runtime/node");
  await assertRegularFile(path.join(bundleDir, target.appName));
  for (const required of [
    "dist/main.js",
    "dist/shell.js",
    "dist/runtime.js",
    "web/dist/index.html",
    "assets/kulo-icon.png",
    "assets/kulo-tray-light.png",
    "assets/kulo-tray-dark.png",
  ]) {
    await assertRegularFile(path.join(app, required));
  }
  await assertRegularFile(path.join(resources, "runtime/recovery/bin.js"));
  await assertRegularFile(path.join(resources, "runtime/kulo-rescue"));
  await assertClosedLinks(app);
  await runPackagedSmokeTest(node, app, path.join(resources, "runtime"), { platform: "linux" });
  return bundleDir;
}

/**
 * Builds the standalone headless Linux runtime archive (`Kulo-Runtime-<ver>-linux-<arch>.tar.gz`)
 * with its own independent `kulo-release.json` / `kulo-release.identity.json`, bundled Node,
 * `@kulo/cli` (`bin/kulo-host`), `@kulo/hub`, `@kulo/env`, `@kulo/recovery`, and `web/dist`.
 */
export async function packageLinuxRuntime(options = {}) {
  if (process.platform !== "linux") throw new Error("当前 Linux 无头运行时打包仅支持在 Linux 上运行。");
  const { channel, appName, appId } = resolveDesktopChannel({ channel: options.channel });
  const output = options.outputDir ?? path.join(workspaceRoot, "dist/desktop");
  if (!path.isAbsolute(output) || path.parse(output).root === output || contained(path.join(desktopRoot, "dist"), output)) {
    throw new Error("运行时产物目录无效。");
  }
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-linux-runtime-"));
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
    const rootName = `Kulo-Runtime-${manifest.version}-linux-${process.arch}`;
    const runtimeRoot = path.join(temporary, rootName);
    const appDir = path.join(runtimeRoot, "app");
    const runtimeDir = path.join(runtimeRoot, "runtime");
    const binDir = path.join(runtimeRoot, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await prepareRuntimePayload(appDir, {
      platform: "linux",
      arch: process.arch,
      requireConnector: Boolean(options.requireConnector ?? (process.env.KULO_REQUIRE_CONNECTOR === "1")),
      verifyConnectorManifest: Boolean(options.verifyConnectorManifest ?? (channel === "release")),
    });
    if (options.updateTrustFile) {
      await fs.writeFile(path.join(appDir, "kulo-update-trust.json"), JSON.stringify(await readUpdateTrustFile(options.updateTrustFile)) + "\n", { mode: 0o644 });
    }
    const appManifestPath = path.join(appDir, "package.json");
    const appManifest = JSON.parse(await fs.readFile(appManifestPath, "utf8"));
    appManifest.productName = appName;
    appManifest.kuloChannel = channel;
    await fs.writeFile(appManifestPath, `${JSON.stringify(appManifest, null, 2)}\n`);

    const nodePath = await portableNode(runtimeDir, { platform: "linux" });
    await prepareRecoveryRuntime(appDir, runtimeDir, { platform: "linux" });
    const sourceHelpers = await import(pathToFileURL(path.join(workspaceRoot, "packages/hub/dist/customization-source.js")).href);
    const sourceIdentity = await sourceHelpers.customizationSourceIdentity(workspaceRoot);
    const dependencyLockHash = createHash("sha256").update(await fs.readFile(path.join(workspaceRoot, "pnpm-lock.yaml"))).digest("hex");
    await fs.writeFile(path.join(runtimeDir, "bundle.json"), `${JSON.stringify({
      appId, channel, kind: "headless-runtime", appVersion: manifest.version,
      nodeVersion: process.versions.node, platform: "linux", arch: process.arch,
      ...(sourceIdentity.commit ? { sourceCommit: sourceIdentity.commit } : {}),
      sourceTreeHash: sourceIdentity.treeHash,
      dependencyLockHash,
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await finalizePackagedRelease(appDir, runtimeDir, {
      version: manifest.version,
      kind: "custom",
      sourceCommit: sourceIdentity.commit,
      sourceTreeHash: sourceIdentity.treeHash,
      shellVersion: manifest.version,
      checks: ["closed-dependencies"],
    });
    const hostBin = path.join(binDir, "kulo-host");
    await fs.writeFile(hostBin, renderLinuxRuntimeHostWrapper(), { mode: 0o755 });
    await safeChmod(hostBin, 0o755);
    const rescueLink = path.join(binDir, "kulo-rescue");
    await fs.symlink("../runtime/kulo-rescue", rescueLink);
    await assertClosedLinks(runtimeRoot);
    await runPackagedSmokeTest(nodePath, appDir, runtimeDir, { platform: "linux" });

    const archivePath = path.join(output, `${rootName}.tar.gz`);
    await fs.rm(archivePath, { force: true });
    await run("tar", ["-czf", archivePath, "-C", temporary, rootName], { maxBuffer: 8 * 1024 * 1024 });
    await writeSha256File(archivePath);
    console.log(`已构建 Linux 无头运行时：${archivePath}`);
    return archivePath;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function buildDebPackage(bundleDir, options) {
  const { channel, appName, version, output } = options;
  const pkgName = channel === "release" ? "kulo" : "kulo-dev";
  const installDir = channel === "release" ? "/opt/Kulo" : "/opt/Kulo-Dev";
  const arch = debArch(process.arch);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-deb-stage-"));
  try {
    const targetOpt = path.join(staging, installDir.slice(1));
    await fs.mkdir(path.dirname(targetOpt), { recursive: true });
    await fs.cp(bundleDir, targetOpt, { recursive: true, dereference: false, verbatimSymlinks: true });

    // /usr/bin/kulo (or /usr/bin/kulo-dev)
    const usrBin = path.join(staging, "usr/bin");
    await fs.mkdir(usrBin, { recursive: true });
    const binPath = path.join(usrBin, pkgName);
    await fs.writeFile(binPath, renderLinuxCliWrapper(installDir, appName), { mode: 0o755 });
    await safeChmod(binPath, 0o755);

    // Desktop entry + icon
    const appsDir = path.join(staging, "usr/share/applications");
    const iconsDir = path.join(staging, "usr/share/icons/hicolor/512x512/apps");
    await fs.mkdir(appsDir, { recursive: true });
    await fs.mkdir(iconsDir, { recursive: true });
    const desktopTpl = (await fs.readFile(path.join(linuxAssetsDir, "kulo.desktop"), "utf8"))
      .replaceAll("@APP_NAME@", appName)
      .replaceAll("/usr/bin/kulo", `/usr/bin/${pkgName}`)
      .replaceAll("Icon=kulo", `Icon=${pkgName}`);
    await fs.writeFile(path.join(appsDir, `${pkgName}.desktop`), desktopTpl, { mode: 0o644 });
    await fs.copyFile(path.join(desktopRoot, "assets/kulo-icon.png"), path.join(iconsDir, `${pkgName}.png`));

    // Ubuntu 24.04 AppArmor profile allowing Chromium + bubblewrap userns
    const apparmorDir = path.join(staging, "etc/apparmor.d");
    await fs.mkdir(apparmorDir, { recursive: true });
    const profile = (await fs.readFile(path.join(linuxAssetsDir, "apparmor.profile"), "utf8"))
      .replaceAll('profile kulo "/opt/Kulo/{Kulo,resources/runtime/node}"', `profile ${pkgName} "${installDir}/{${appName},resources/runtime/node}"`)
      .replaceAll("<local/kulo>", `<local/${pkgName}>`);
    await fs.writeFile(path.join(apparmorDir, pkgName), profile, { mode: 0o644 });

    // DEBIAN metadata
    const debianDir = path.join(staging, "DEBIAN");
    await fs.mkdir(debianDir, { recursive: true });
    const control = [
      `Package: ${pkgName}`,
      `Version: ${version}`,
      "Section: utils",
      "Priority: optional",
      `Architecture: ${arch}`,
      "Maintainer: Kulo <maintainers@kulo.local>",
      "Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0",
      "Recommends: bubblewrap, libsecret-tools",
      `Description: ${appName} — Self-hosted personal SuperAgent`,
      "",
    ].join("\n");
    await fs.writeFile(path.join(debianDir, "control"), control, { mode: 0o644 });
    for (const script of ["postinst", "postrm"]) {
      const content = (await fs.readFile(path.join(linuxAssetsDir, script), "utf8")).replaceAll("/etc/apparmor.d/kulo", `/etc/apparmor.d/${pkgName}`);
      const dest = path.join(debianDir, script);
      await fs.writeFile(dest, content, { mode: 0o755 });
      await safeChmod(dest, 0o755);
    }

    const slug = appName.replace(/\s+/g, "-");
    const debPath = path.join(output, `${slug}-${version}-linux-${arch}.deb`);
    await fs.rm(debPath, { force: true });
    await run("dpkg-deb", ["--build", "--root-owner-group", staging, debPath], { maxBuffer: 8 * 1024 * 1024 });
    await writeSha256File(debPath);
    console.log(`已生成 Linux Debian 安装包：${debPath}`);
    return debPath;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function buildAppImage(bundleDir, options) {
  const { appName, version, output } = options;
  const appimagetool = process.env.KULO_APPIMAGETOOL_PATH ?? "appimagetool";
  if (!await hasTool(appimagetool, ["--version"])) return undefined;
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-appimage-stage-"));
  try {
    const appDir = path.join(staging, `${appName.replace(/\s+/g, "-")}.AppDir`);
    await fs.cp(bundleDir, path.join(appDir, "usr/lib/kulo"), { recursive: true, dereference: false, verbatimSymlinks: true });
    await fs.copyFile(path.join(desktopRoot, "assets/kulo-icon.png"), path.join(appDir, "kulo.png"));
    const desktopTpl = (await fs.readFile(path.join(linuxAssetsDir, "kulo.desktop"), "utf8"))
      .replaceAll("@APP_NAME@", appName)
      .replaceAll("/usr/bin/kulo", "AppRun");
    await fs.writeFile(path.join(appDir, "kulo.desktop"), desktopTpl, { mode: 0o644 });
    const appRun = `#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$HERE/usr/lib/kulo/${appName}" "$@"
`;
    await fs.writeFile(path.join(appDir, "AppRun"), appRun, { mode: 0o755 });
    await safeChmod(path.join(appDir, "AppRun"), 0o755);

    const slug = appName.replace(/\s+/g, "-");
    const outPath = path.join(output, `${slug}-${version}-linux-${process.arch}.AppImage`);
    await fs.rm(outPath, { force: true });
    await run(appimagetool, [appDir, outPath], {
      env: { ...process.env, ARCH: process.arch === "arm64" ? "aarch64" : "x86_64" },
      maxBuffer: 8 * 1024 * 1024,
    });
    await writeSha256File(outPath);
    console.log(`已生成 Linux AppImage：${outPath}`);
    return outPath;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function packageLinuxApp(options = {}) {
  if (process.platform !== "linux") throw new Error("当前 Linux 打包仅支持在 Linux 上运行。");
  if (options.runtimeOnly) return packageLinuxRuntime(options);
  const { channel, appName, appId } = resolveDesktopChannel({ channel: options.channel });
  const { ensureElectron } = await import("./ensure-electron.mjs");
  await ensureElectron();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-desktop-linux-"));
  const output = options.outputDir ?? path.join(workspaceRoot, "dist/desktop");
  if (!path.isAbsolute(output) || path.parse(output).root === output || contained(path.join(desktopRoot, "dist"), output)) {
    throw new Error("桌面产物目录无效。");
  }
  await fs.mkdir(output, { recursive: true });
  try {
    const app = path.join(temporary, "app");
    await prepareRuntimePayload(app, {
      platform: "linux",
      arch: process.arch,
      requireConnector: Boolean(options.requireConnector ?? (process.env.KULO_REQUIRE_CONNECTOR === "1")),
      verifyConnectorManifest: Boolean(options.verifyConnectorManifest ?? (channel === "release")),
    });
    if (options.updateTrustFile) {
      await fs.writeFile(path.join(app, "kulo-update-trust.json"), JSON.stringify(await readUpdateTrustFile(options.updateTrustFile)) + "\n", { mode: 0o644 });
    }
    const runtime = path.join(temporary, "runtime");
    await portableNode(runtime, { platform: "linux" });
    await prepareRecoveryRuntime(app, runtime, { platform: "linux" });

    const electronManifest = require.resolve("electron/package.json");
    const electronVersion = JSON.parse(await fs.readFile(electronManifest, "utf8")).version;
    const checksums = JSON.parse(await fs.readFile(path.join(path.dirname(electronManifest), "checksums.json"), "utf8"));
    const manifest = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
    const sourceHelpers = await import(pathToFileURL(path.join(workspaceRoot, "packages/hub/dist/customization-source.js")).href);
    const sourceArchive = await sourceHelpers.createCustomizationSourceArchive(workspaceRoot, path.join(app, "kulo-source.json.gz"), { version: manifest.version });
    await fs.writeFile(path.join(app, "kulo-source.json"), JSON.stringify(sourceArchive) + "\n");
    await safeChmod(path.join(app, "kulo-source.json.gz"), 0o644);
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
      nodeVersion: process.versions.node, platform: "linux", arch: process.arch,
      ...identity,
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const { packager } = await import("@electron/packager");
    const bundles = await packager({
      dir: app,
      name: appName,
      appVersion: manifest.version,
      icon: path.join(desktopRoot, "assets/kulo-icon.png"),
      electronVersion,
      download: { checksums },
      platform: "linux",
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
      extraResource: [runtime],
    });
    if (bundles.length !== 1 || !bundles[0]) throw new Error("没有生成唯一的 Linux 应用目录。");
    const bundleDir = bundles[0];
    const finalResources = path.join(bundleDir, "resources");
    const finalApp = path.join(finalResources, "app");
    const finalManifestPath = path.join(finalApp, "package.json");
    const finalManifest = JSON.parse(await fs.readFile(finalManifestPath, "utf8"));
    finalManifest.productName = appName;
    finalManifest.kuloChannel = channel;
    await fs.writeFile(finalManifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`);
    await finalizePackagedRelease(finalApp, path.join(finalResources, "runtime"), releaseOptions);
    await verifyLinuxApp(bundleDir, { channel });
    console.log(`已构建 Linux 桌面应用：${bundleDir}（通道：${channel}）`);

    const artifacts = { bundleDir };
    if (await hasTool("dpkg-deb")) {
      artifacts.debPath = await buildDebPackage(bundleDir, { channel, appName, version: manifest.version, output });
    } else if (options.requireDeb) {
      throw new Error("未检测到 dpkg-deb，无法构建 Linux .deb 安装包。");
    }
    const appImage = await buildAppImage(bundleDir, { appName, version: manifest.version, output });
    if (appImage) artifacts.appImagePath = appImage;
    if (options.includeRuntime !== false) {
      artifacts.runtimeArchivePath = await packageLinuxRuntime({ ...options, outputDir: output });
    }
    return artifacts.debPath ?? bundleDir;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
