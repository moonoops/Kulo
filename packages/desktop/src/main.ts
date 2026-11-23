import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { app, clipboard, dialog } from "electron";
import { resolveDesktopAppIdentity, resolveDesktopDataDirectory, resolvePackagedRescuePath } from "./desktop-config.js";

const desktopIdentity = resolveDesktopAppIdentity();
const desktopAppName = desktopIdentity.appName;
let dataDir: string | undefined;
app.setName(desktopAppName);
if (process.platform === "win32") app.setAppUserModelId(desktopIdentity.bundleId);
void app.whenReady().then(() => {
  app.dock?.setIcon(fileURLToPath(new URL("../assets/kulo-icon.png", import.meta.url)));
});
try {
  dataDir = resolveDesktopDataDirectory(process.argv, path.join(app.getPath("appData"), desktopAppName));
  const sessionDir = path.join(dataDir, "chromium");
  app.setPath("userData", dataDir);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessionStat = fs.lstatSync(sessionDir);
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) throw new Error("桌面会话目录不可用。");
  app.setPath("sessionData", sessionDir);
  await import("./shell.js");
} catch (error) {
  if (!dataDir) {
    dialog.showErrorBox(desktopAppName, "Kulo 数据目录参数无效。");
    app.exit(1);
  }
  await app.whenReady();
  let instructions = dataDir ? `Kulo 数据目录：${dataDir}` : "Kulo 数据目录参数无效，请检查启动参数。";
  const launcher = app.isPackaged ? resolvePackagedRescuePath(process.resourcesPath, process.platform) : undefined;
  let diagnostic = error instanceof Error ? error.name : "Error";
  if (dataDir) {
    try {
      const { RecoveryManager, redactDiagnosticText } = await import("@kulo/recovery");
      instructions = await new RecoveryManager(dataDir).repairInstructions();
      diagnostic = redactDiagnosticText(error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 16_384);
    } catch {
      instructions += "\n恢复模块无法加载，请使用独立救援入口检查。";
    }
    try {
      const directory = path.join(dataDir, "recovery");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, "bootstrap-failure.json"), JSON.stringify({
        at: Date.now(), phase: "desktop-import", error: diagnostic,
      }), { mode: 0o600 });
    } catch {
      console.error("Kulo 启动诊断未能保存，请使用独立救援入口检查。");
    }
  }
  if (launcher) instructions += `\n独立救援入口：${launcher}`;
  const result = await dialog.showMessageBox({
    type: "error", title: desktopAppName, message: "Kulo 暂时无法启动。",
    buttons: ["复制修复信息", "退出"], defaultId: 0, cancelId: 1,
  });
  if (result.response === 0) clipboard.writeText(instructions);
  app.exit(1);
}
