import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fail, readJson } from "./files.js";

const run = promisify(execFile);
const NAME = "macos-worker-cleanup";

/** Only the cleanup runtime shipped beside this CLI can execute; owner receipts supply no command. */
export function bundledCustomizationCleanup(): (scope: { marker: string; negative: string }) => Promise<void> {
  if (process.platform !== "darwin") fail("cleanup_runtime_unavailable", "当前安装尚未提供此平台的独立定制进程清理组件。");
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const metadataFile = path.join(directory, "kulo-cleanup-runtime.json");
  const executable = path.join(directory, NAME);
  if (!fs.existsSync(metadataFile) || !fs.existsSync(executable)) fail("cleanup_runtime_unavailable", "当前安装缺少独立定制进程清理组件，恢复记录已保留。");
  let input: unknown;
  try { input = readJson(metadataFile, 4096); }
  catch { return fail("cleanup_runtime_invalid", "独立清理组件的受信清单无效，未执行清理。"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("cleanup_runtime_invalid", "独立清理组件的受信清单无效。");
  const metadata = input as Record<string, unknown>;
  if (Object.keys(metadata).some((key) => !["formatVersion", "file", "sha256"].includes(key)) ||
      metadata.formatVersion !== 1 || metadata.file !== NAME || typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    fail("cleanup_runtime_invalid", "独立清理组件的受信清单无效，未执行清理。");
  }
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4 * 1024 * 1024 || !(stat.mode & 0o111)) {
    fail("cleanup_runtime_invalid", "独立清理组件不是受信可执行文件。");
  }
  const descriptor = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size ||
        createHash("sha256").update(fs.readFileSync(descriptor)).digest("hex") !== metadata.sha256) {
      fail("cleanup_runtime_invalid", "独立清理组件的文件摘要不一致，未执行清理。");
    }
  } finally { fs.closeSync(descriptor); }
  return async ({ marker, negative }) => {
    if (!/^[a-z0-9.-]{24,160}$/.test(marker) || !/^[a-z0-9.-]{24,160}$/.test(negative) || marker === negative) {
      fail("invalid_cleanup_scope", "定制进程清理范围无效，恢复记录已保留。");
    }
    try {
      await run(executable, ["--cleanup", marker, negative], {
        cwd: directory, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        encoding: "utf8", timeout: 10_000, maxBuffer: 4096, windowsHide: true,
      });
    } catch {
      fail("customization_cleanup_failed", "尚未确认先前定制进程已结束，恢复记录已保留。");
    }
  };
}
