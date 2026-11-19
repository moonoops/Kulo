import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    let diagnostic = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192); });
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (status) => { clearTimeout(timer); status === 0 ? resolve() : reject(new Error(`Native application helper build failed: ${diagnostic}`)); });
    child.stdin.end(input);
  });
}

export async function buildNativeApplications({ outputPath } = {}) {
  if (process.platform !== "darwin") return;
  const native = fileURLToPath(new URL("../native/", import.meta.url));
  const source = fs.readFileSync(path.join(native, "moco-native-applications.m"), "utf8");
  const javascript = fs.readFileSync(path.join(native, "moco-native-applications.js"), "utf8");
  const destination = outputPath ?? fileURLToPath(new URL("../dist/moco-native-applications", import.meta.url));
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "moco-native-build-"));
  try {
    const info = path.join(scratch, "Info.plist"), entitlements = path.join(scratch, "entitlements.plist");
    fs.writeFileSync(info, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.moco.native-applications</string><key>CFBundleName</key><string>Moco Applications</string><key>NSAppleEventsUsageDescription</key><string>Moco需要读取您授权的信息和邮件，并按任务发送消息或保存草稿。</string></dict></plist>', { mode: 0o600 });
    fs.writeFileSync(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.automation.apple-events</key><true/></dict></plist>', { mode: 0o600 });
    await run("/usr/bin/clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks", "-O2", "-mmacosx-version-min=13.0", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-framework", "Foundation", "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "OSAKit", "-lsqlite3", "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", info, "-o", temporary, "-"], `#define MOCO_JXA_SOURCE ${JSON.stringify(javascript)}\n${source}`);
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "io.moco.native-applications", "--entitlements", entitlements, temporary]);
    fs.chmodSync(temporary, 0o500);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNativeApplications().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
