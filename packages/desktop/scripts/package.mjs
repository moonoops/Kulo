import path from "node:path";
import { pathToFileURL } from "node:url";

export {
  APP_ID,
  APP_NAME,
  RELEASE_APP_ID,
  RELEASE_APP_NAME,
  assertClosedLinks,
  assertRegularFile,
  contained,
  createBuildIdentity,
  desktopRoot,
  finalizePackagedRelease,
  materializeWindowsNodeModules,
  portableNode,
  prepareAgentClis,
  prepareMacAgentClis,
  prepareRecoveryRuntime,
  prepareRuntimePayload,
  preserveConnectorBroker,
  readUpdateTrustFile,
  repairDeployedSelfLink,
  resolveDesktopChannel,
  resolvePnpmInvocation,
  runPackagedSmokeTest,
  verifyRecoveryCleanupRuntime,
  withPreservedWorkspaceState,
  workspaceRoot,
  writeSha256File,
} from "./payload.mjs";

export {
  createMacDmg,
  packageMacApp,
  parseCodeSigningIdentities,
  resolveMacSignIdentity,
  signMacAppBundle,
  verifyMacApp,
} from "./package-mac.mjs";

export {
  packageWindowsApp,
  verifyWindowsApp,
} from "./package-win.mjs";

export {
  packageLinuxApp,
  packageLinuxRuntime,
  renderLinuxCliWrapper,
  renderLinuxRuntimeHostWrapper,
  verifyLinuxApp,
} from "./package-linux.mjs";

import { packageMacApp } from "./package-mac.mjs";
import { packageWindowsApp } from "./package-win.mjs";
import { packageLinuxApp, packageLinuxRuntime } from "./package-linux.mjs";

export async function packageDesktopApp(options = {}) {
  const targetPlatform = options.platform ?? process.platform;
  if (targetPlatform === "darwin") return packageMacApp(options);
  if (targetPlatform === "win32") return packageWindowsApp(options);
  if (targetPlatform === "linux") {
    return options.runtimeOnly ? packageLinuxRuntime(options) : packageLinuxApp(options);
  }
  throw new Error(`不支持的桌面打包平台：${targetPlatform}`);
}

function parseCliChannel(argv) {
  const explicit = argv.find((arg) => arg.startsWith("--channel="));
  if (explicit) return explicit.slice("--channel=".length);
  if (argv.includes("--release")) return "release";
  if (argv.includes("--dev")) return "dev";
  return undefined;
}

function parseCliOption(argv, flag) {
  const prefix = `${flag}=`;
  const explicit = argv.find((arg) => arg.startsWith(prefix));
  return explicit ? explicit.slice(prefix.length) : undefined;
}

function parseCliPlatform(argv) {
  return parseCliOption(argv, "--platform");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const channel = parseCliChannel(argv);
  const platform = parseCliPlatform(argv);
  const updateTrustFile = parseCliOption(argv, "--update-trust-file") ?? (process.env.KULO_UPDATE_TRUST_FILE?.trim() || undefined);
  packageDesktopApp({
    channel,
    platform,
    updateTrustFile,
    createDmg: argv.includes("--dmg"),
    runtimeOnly: argv.includes("--runtime-only"),
    requireInstaller: argv.includes("--require-installer"),
    requireDeb: argv.includes("--require-deb"),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Kulo 桌面打包失败。");
    process.exitCode = 1;
  });
}
