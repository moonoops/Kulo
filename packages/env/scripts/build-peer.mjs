import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

export async function buildPeer(options = {}) {
  const outfile = path.resolve(options.outfile ?? path.join(packageDirectory, "dist", "peer.mjs"));
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const sourceFile = path.join(packageDirectory, "native", "macos-worker-cleanup.c");
  const macCleanupSource = fs.readFileSync(sourceFile, "utf8");
  let macCleanupBinary = "";
  const prebuiltCleanupPath = options.macCleanupPrebuilt ?? process.env.KULO_MACOS_CLEANUP_PREBUILT;
  if (process.platform === "darwin") {
    const helper = path.join(path.dirname(outfile), "macos-worker-cleanup");
    execFileSync("/usr/bin/clang", ["-O2", "-Wall", "-Wextra", "-Werror", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0", sourceFile, "-o", helper]);
    macCleanupBinary = fs.readFileSync(helper).toString("base64");
  } else if (prebuiltCleanupPath && prebuiltCleanupPath.trim()) {
    const resolvedPrebuilt = path.resolve(prebuiltCleanupPath.trim());
    const bytes = fs.readFileSync(resolvedPrebuilt);
    if (bytes.length < 4) throw new Error(`预构建 macOS 清理程序无效：${resolvedPrebuilt}`);
    const magic = bytes.readUInt32BE(0);
    // Accept Mach-O universal fat (0xcafebabe / 0xcafebabf) or 64-bit Mach-O (0xcffaedfe / 0xfeedfacf).
    if (![0xcafebabe, 0xcafebabf, 0xcffaedfe, 0xfeedfacf].includes(magic)) {
      throw new Error(`预构建 macOS 清理程序不是有效的 Mach-O 二进制：${resolvedPrebuilt}`);
    }
    macCleanupBinary = bytes.toString("base64");
  }

  await build({
    absWorkingDir: packageDirectory,
    entryPoints: [path.join(packageDirectory, "src", "peer-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["undici", "@anthropic-ai/claude-agent-sdk", "@earendil-works/pi-env", "ws", "agent-browser", "agent-desktop"],
    outfile,
    define: {
      KULO_WINDOWS_SANDBOX_SOURCE: JSON.stringify(fs.readFileSync(new URL("../native/windows-sandbox.ps1", import.meta.url), "utf8")),
      KULO_MACOS_CLEANUP_SOURCE: JSON.stringify(macCleanupSource),
      KULO_MACOS_CLEANUP_BINARY: JSON.stringify(macCleanupBinary),
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPeer();
