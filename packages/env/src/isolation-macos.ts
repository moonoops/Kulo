import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

declare const KULO_MACOS_CLEANUP_BINARY: string | undefined;
declare const KULO_MACOS_CLEANUP_SOURCE: string | undefined;
let helperBinary: Buffer | undefined;

export function macSandboxCleanupAvailable(): boolean {
  if (helperBinary || typeof KULO_MACOS_CLEANUP_BINARY === "string" && KULO_MACOS_CLEANUP_BINARY || fs.existsSync(fileURLToPath(new URL("./macos-worker-cleanup", import.meta.url)))) return true;
  const developer = spawnSync("/usr/bin/xcode-select", ["--print-path"], { timeout: 2_000, stdio: "ignore" });
  return !developer.error && developer.status === 0;
}

/** Each execution gets a private copy, outside every Worker-writable directory. */
export function createMacSandboxCleanupCommand(controlDirectory: string, marker: string, negative: string): readonly string[] {
  const executable = path.join(controlDirectory, "macos-worker-cleanup");
  if (!helperBinary) {
    if (typeof KULO_MACOS_CLEANUP_BINARY === "string" && KULO_MACOS_CLEANUP_BINARY) helperBinary = Buffer.from(KULO_MACOS_CLEANUP_BINARY, "base64");
    else {
      const built = fileURLToPath(new URL("./macos-worker-cleanup", import.meta.url));
      if (fs.existsSync(built)) helperBinary = fs.readFileSync(built);
      else {
        const source = typeof KULO_MACOS_CLEANUP_SOURCE === "string" ? KULO_MACOS_CLEANUP_SOURCE : fs.readFileSync(fileURLToPath(new URL("../native/macos-worker-cleanup.c", import.meta.url)), "utf8");
        const result = spawnSync("/usr/bin/clang", ["-x", "c", "-O2", "-Wall", "-Wextra", "-Werror", "-o", executable, "-"], { input: source, encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/bin:/bin" } });
        if (result.error || result.status !== 0) throw new Error("macOS Worker cleanup requires its bundled native helper or Command Line Tools; unrestricted execution is disabled");
        helperBinary = fs.readFileSync(executable);
      }
    }
  }
  fs.writeFileSync(executable, helperBinary, { mode: 0o500 });
  fs.chmodSync(executable, 0o500);
  const probe = spawnSync(executable, ["--probe"], { timeout: 5_000, stdio: "ignore" });
  if (probe.error || probe.status !== 0) throw new Error("macOS native sandbox membership checks are unavailable; Worker execution is disabled");
  return [executable, "--cleanup", marker, negative];
}
