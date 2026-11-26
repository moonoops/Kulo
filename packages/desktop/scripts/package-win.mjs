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
  workspaceRoot,
  writeSha256File,
} from "./payload.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

async function resolveMakensis() {
  const candidates = [
    process.env.KULO_MAKENSIS_PATH,
    "makensis.exe",
    "C:\\Program Files (x86)\\NSIS\\makensis.exe",
    "C:\\Program Files\\NSIS\\makensis.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      await run(candidate, ["-VERSION"], { timeout: 5_000, windowsHide: true });
      return candidate;
    } catch { /* try next */ }
  }
  return undefined;
}

async function signWindowsBinary(filePath, options = {}) {
  const pfx = (options.pfxPath ?? process.env.KULO_WIN_CERT_PFX)?.trim();
  const password = options.pfxPassword ?? process.env.KULO_WIN_CERT_PASSWORD;
  if (!pfx) return false;
  if (!existsSync(pfx)) {
    throw new Error(`Windows 签名证书文件不存在：${pfx}`);
  }
  const signtool = options.signtool ?? process.env.KULO_SIGNTOOL_PATH ?? "signtool.exe";
  const timestampUrl = options.timestampUrl ?? process.env.KULO_WIN_TIMESTAMP_URL ?? "http://timestamp.digicert.com";
  await run(signtool, [
    "sign", "/fd", "SHA256", "/f", pfx,
    ...(password ? ["/p", password] : []),
    "/tr", timestampUrl, "/td", "SHA256", filePath,
  ], { maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return true;
}

export async function verifyWindowsApp(bundleDir, options = {}) {
  const target = options.appName && options.appId
    ? { appName: options.appName, appId: options.appId }
    : resolveDesktopChannel({ channel: options.channel });
  const resources = path.join(bundleDir, "resources");
  const app = path.join(resources, "app");
  const node = path.join(resources, "runtime/node.exe");
  await assertRegularFile(path.join(bundleDir, `${target.appName}.exe`));
  for (const required of [
    "dist/main.js",
    "dist/shell.js",
    "dist/runtime.js",
    "web/dist/index.html",
    "assets/kulo.ico",
    "assets/kulo-icon.png",
    "assets/kulo-tray-light.png",
    "assets/kulo-tray-dark.png",
  ]) {
    await assertRegularFile(path.join(app, required));
  }
  await assertRegularFile(path.join(resources, "runtime/recovery/bin.js"));
  await assertRegularFile(path.join(resources, "runtime/kulo-rescue.cmd"));
  await runPackagedSmokeTest(node, app, path.join(resources, "runtime"), { platform: "win32" });
  return bundleDir;
}

export async function packageWindowsApp(options = {}) {
  if (process.platform !== "win32") throw new Error("当前 Windows 打包仅支持在 Windows 上运行。");
  const { channel, appName, appId } = resolveDesktopChannel({ channel: options.channel });
  const { ensureElectron } = await import("./ensure-electron.mjs");
  await ensureElectron();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kulo-desktop-win-"));
  const output = options.outputDir ?? path.join(workspaceRoot, "dist/desktop");
  if (!path.isAbsolute(output) || path.parse(output).root === output || contained(path.join(desktopRoot, "dist"), output)) {
    throw new Error("桌面产物目录无效。");
  }
  try {
    const app = path.join(temporary, "app");
    await prepareRuntimePayload(app, {
      platform: "win32",
      arch: process.arch,
      requireConnector: Boolean(options.requireConnector ?? (process.env.KULO_REQUIRE_CONNECTOR === "1")),
      verifyConnectorManifest: Boolean(options.verifyConnectorManifest ?? (channel === "release")),
    });
    if (options.updateTrustFile) {
      await fs.writeFile(path.join(app, "kulo-update-trust.json"), JSON.stringify(await readUpdateTrustFile(options.updateTrustFile)) + "\n");
    }
    const runtime = path.join(temporary, "runtime");
    await portableNode(runtime, { platform: "win32" });
    await prepareRecoveryRuntime(app, runtime, { platform: "win32" });

    const electronManifest = require.resolve("electron/package.json");
    const electronVersion = JSON.parse(await fs.readFile(electronManifest, "utf8")).version;
    const checksums = JSON.parse(await fs.readFile(path.join(path.dirname(electronManifest), "checksums.json"), "utf8"));
    const manifest = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
    const sourceHelpers = await import(pathToFileURL(path.join(workspaceRoot, "packages/hub/dist/customization-source.js")).href);
    const sourceArchive = await sourceHelpers.createCustomizationSourceArchive(workspaceRoot, path.join(app, "kulo-source.json.gz"), { version: manifest.version });
    await fs.writeFile(path.join(app, "kulo-source.json"), JSON.stringify(sourceArchive) + "\n");
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
      nodeVersion: process.versions.node, platform: "win32", arch: process.arch,
      ...identity,
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const { packager } = await import("@electron/packager");
    const bundles = await packager({
      dir: app,
      name: appName,
      appVersion: manifest.version,
      icon: path.join(desktopRoot, "assets/kulo.ico"),
      electronVersion,
      download: { checksums },
      platform: "win32",
      arch: process.arch,
      out: output,
      overwrite: true,
      asar: false,
      prune: false,
      derefSymlinks: true,
      win32metadata: {
        CompanyName: "Kulo",
        FileDescription: appName,
        OriginalFilename: `${appName}.exe`,
        ProductName: appName,
        InternalName: appId,
      },
      extraResource: [runtime],
    });
    if (bundles.length !== 1 || !bundles[0]) throw new Error("没有生成唯一的 Windows 应用目录。");
    const bundleDir = bundles[0];
    const finalResources = path.join(bundleDir, "resources");
    const finalApp = path.join(finalResources, "app");
    const finalManifestPath = path.join(finalApp, "package.json");
    const finalManifest = JSON.parse(await fs.readFile(finalManifestPath, "utf8"));
    finalManifest.productName = appName;
    finalManifest.kuloChannel = channel;
    await fs.writeFile(finalManifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`);
    await finalizePackagedRelease(finalApp, path.join(finalResources, "runtime"), releaseOptions);
    await signWindowsBinary(path.join(bundleDir, `${appName}.exe`), options);
    await verifyWindowsApp(bundleDir, { channel });
    console.log(`已构建 Windows 应用：${bundleDir}（通道：${channel}）`);

    const makensis = await resolveMakensis();
    let installerPath;
    if (makensis) {
      const slug = appName.replace(/\s+/g, "-");
      installerPath = path.join(output, `${slug}-Setup-${manifest.version}-win32-${process.arch}.exe`);
      const nsiScript = fileURLToPath(new URL("./nsis/installer.nsi", import.meta.url));
      const { stderr: nsisStderr } = await run(makensis, [
        "/V3",
        `/DAPP_NAME=${appName}`,
        `/DAPP_ID=${appId}`,
        `/DAPP_VERSION=${manifest.version}`,
        `/DSOURCE_DIR=${bundleDir}`,
        `/DOUTPUT_FILE=${installerPath}`,
        `/DICON_FILE=${path.join(desktopRoot, "assets/kulo.ico")}`,
        nsiScript,
      ], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      if (nsisStderr?.trim()) {
        console.warn(`makensis 提示：\n${nsisStderr.trim()}`);
      }
      await signWindowsBinary(installerPath, options);
      await writeSha256File(installerPath);
      console.log(`已生成 Windows 安装包：${installerPath}`);
    } else if (options.requireInstaller) {
      throw new Error("未检测到 makensis.exe，无法构建 Windows NSIS 安装包。");
    }
    return installerPath ?? bundleDir;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
