#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RecoveryManager } from "./manager.js";
import { RecoveryError, redact } from "./files.js";
import { recoverCustomizationExecutions } from "./customization-executions.js";
import { bundledCustomizationCleanup } from "./cleanup-runtime.js";

const HELP = "kulo-rescue <inspect|versions|rollback|export|gc|safe-mode|cleanup> --data-dir <absolute-directory> [--json]\n";

export async function runRecoveryCli(args: readonly string[]): Promise<{ exitCode: number; output: string }> {
  try {
    const flags = new Map<string, string>();
    const positional: string[] = [];
    let json = false;
    let apply = false;
    let exitCode = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--help" || arg === "-h") return { exitCode: 0, output: HELP };
      if (arg === "--json") json = true;
      else if (arg === "--apply") apply = true;
      else if (["--data-dir", "--release", "--output", "--shell-version"].includes(arg)) {
        const value = args[++i];
        if (!value || value.startsWith("--")) throw new RecoveryError("invalid_arguments", "命令参数不完整。");
        flags.set(arg, value);
      } else if (arg.startsWith("--data-dir=")) flags.set("--data-dir", arg.slice("--data-dir=".length));
      else if (arg.startsWith("-")) throw new RecoveryError("invalid_arguments", "不支持此命令参数。");
      else positional.push(arg);
    }
    const command = positional[0] ?? "inspect";
    if (!["inspect", "versions", "rollback", "export", "gc", "safe-mode", "cleanup", "help"].includes(command) || positional.length > 1) throw new RecoveryError("invalid_arguments", "恢复命令无效。");
    if (command === "help") return { exitCode: 0, output: HELP };
    const dataDir = flags.get("--data-dir") ?? process.env.KULO_DESKTOP_DATA_DIR;
    if (!dataDir) throw new RecoveryError("missing_data_directory", "请指定此 Kulo 实例的数据目录。");
    let manager = new RecoveryManager(dataDir);
    const initial = await manager.inspect();
    const baseline = initial.baseline?.manifest ?? initial.current?.manifest;
    manager = new RecoveryManager(dataDir, {
      shellVersion: flags.get("--shell-version") ?? baseline?.shellVersion ?? "1",
      protocolVersion: baseline?.protocolVersion ?? 1,
      dataVersion: baseline?.dataVersion ?? 2,
    });
    const inspection = await manager.inspect();
    let result: unknown;
    if (command === "inspect") result = inspection;
    else if (command === "versions") result = { current: inspection.current?.id ?? null, pending: inspection.pending?.id ?? null, history: inspection.history.map((record) => record.id), releases: inspection.releases, warnings: inspection.warnings };
    else if (command === "rollback") result = { restored: (await manager.rollback(flags.get("--release"))).id, restartRequired: true };
    else if (command === "safe-mode") {
      if (!inspection.baseline) throw new RecoveryError("no_baseline", "没有已登记的基础恢复版本。");
      result = { restored: (await manager.rollback(inspection.baseline.id)).id, restartRequired: true, mode: "baseline" };
    } else if (command === "cleanup") {
      const cleaned = await manager.withOfflineMaintenance(async () => {
        const cleanup = bundledCustomizationCleanup();
        return recoverCustomizationExecutions({ dataDir: manager.dataDir, cleanup });
      });
      result = cleaned;
      if (cleaned.pending.length) exitCode = 1;
    } else if (command === "gc") result = await manager.gc({ dryRun: !apply });
    else result = await manager.exportDiagnostics(flags.get("--output"));
    if (json) return { exitCode, output: JSON.stringify(result) + "\n" };
    return { exitCode, output: JSON.stringify(result, null, 2) + "\n" };
  } catch (error) {
    const code = error instanceof RecoveryError ? error.code : "recovery_failed";
    const message = redact(error instanceof Error ? error.message : "恢复操作未完成。");
    return { exitCode: 1, output: JSON.stringify({ error: { code, message } }) + "\n" };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRecoveryCli(process.argv.slice(2));
  (result.exitCode ? process.stderr : process.stdout).write(result.output);
  process.exitCode = result.exitCode;
}
