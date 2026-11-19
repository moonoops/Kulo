import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);

export async function ensureElectron() {
  const manifestPath = require.resolve("electron/package.json");
  const directory = path.dirname(manifestPath);
  const { version } = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const binary = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
  const executable = path.join(directory, "dist", binary);
  try {
    if ((await fs.readFile(path.join(directory, "dist/version"), "utf8")).trim().replace(/^v/, "") === version) {
      await fs.access(executable, fs.constants.X_OK);
      return executable;
    }
  } catch (error) { if (!["ENOENT", "EACCES"].includes(error.code)) throw error; }
  const dependencyRequire = createRequire(manifestPath);
  const { downloadArtifact } = await import(dependencyRequire.resolve("@electron/get"));
  const { default: extractZip } = await import(dependencyRequire.resolve("@electron-internal/extract-zip"));
  const checksums = JSON.parse(await fs.readFile(path.join(directory, "checksums.json"), "utf8"));
  // curl follows the same proxy environment as the developer's terminal on Node 22.
  const downloader = {
    download: (url, target) => new Promise((resolve, reject) => {
      const child = spawn("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "30", "--max-time", "600", "--output", target, url], { stdio: ["ignore", "ignore", "inherit"] });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Electron 下载失败（${code}）。`)));
    }),
  };
  console.log(`正在准备 Electron ${version}（${process.platform}/${process.arch}）…`);
  const archive = await downloadArtifact({ version, artifactName: "electron", platform: process.platform, arch: process.arch, checksums, downloader });
  await extractZip(archive, { dir: path.join(directory, "dist") });
  await fs.writeFile(path.join(directory, "path.txt"), binary);
  return executable;
}
