import fs from "node:fs/promises";
import path from "node:path";
import { alive, dataDirectory, operationLock, privateDirectory, readJson } from "./files.js";

export interface CustomizationExecutionScope {
  directory: string;
  marker: string;
  negative: string;
  workRoot: string;
}
export interface CustomizationExecutionRecovery {
  recovered: number;
  pending: Array<{ id: string; reason: "invalid-record" | "owner-active" | "cleanup-failed" }>;
}

/** Shared by the Hub and offline rescue so cleanup cannot race a new sandbox. */
export function acquireCustomizationOperationLock(dataDir: string): () => void {
  const root = path.join(dataDirectory(dataDir), "customizations");
  privateDirectory(root);
  return operationLock(root, alive);
}

/** Pure Node entry for a trusted rescue caller; recorded commands are never executed. */
export async function recoverCustomizationExecutions(options: {
  dataDir: string;
  cleanup: (scope: CustomizationExecutionScope) => Promise<void>;
  operationLockHeld?: boolean;
}): Promise<CustomizationExecutionRecovery> {
  const release = options.operationLockHeld ? undefined : acquireCustomizationOperationLock(options.dataDir);
  try {
    const result: CustomizationExecutionRecovery = { recovered: 0, pending: [] };
    const dataDir = await fs.realpath(options.dataDir), executions = path.join(dataDir, "customizations", "executions");
    let entries;
    try {
      const stat = await fs.lstat(executions);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { recovered: 0, pending: [{ id: "executions", reason: "invalid-record" }] };
      entries = await fs.readdir(executions, { withFileTypes: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
    for (const entry of entries) {
      const invalid = () => result.pending.push({ id: entry.name, reason: "invalid-record" });
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.name) ||
          !entry.isDirectory() || entry.isSymbolicLink()) { invalid(); continue; }
      const directory = path.join(executions, entry.name);
      const directoryStat = await fs.lstat(directory);
      if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) { invalid(); continue; }
      const ownerStat = await fs.lstat(path.join(directory, "owner.json")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined; throw error;
      });
      if (!ownerStat || !ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 8000 ||
          typeof process.getuid === "function" && ownerStat.uid !== process.getuid()) { invalid(); continue; }
      let raw: unknown;
      try { raw = readJson(path.join(directory, "owner.json"), 8000); }
      catch { invalid(); continue; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { invalid(); continue; }
      const owner = raw as { ownerPid?: unknown; workRoot?: unknown; cleanupCommand?: unknown };
      if (!Number.isSafeInteger(owner.ownerPid) || Number(owner.ownerPid) <= 0 || typeof owner.workRoot !== "string" ||
          !Array.isArray(owner.cleanupCommand) || owner.cleanupCommand.length !== 4 ||
          owner.cleanupCommand[0] !== path.join(directory, "macos-worker-cleanup") || owner.cleanupCommand[1] !== "--cleanup" ||
          typeof owner.cleanupCommand[2] !== "string" || !/^kulo\.customization\.[a-f0-9]{48}$/.test(owner.cleanupCommand[2]) ||
          typeof owner.cleanupCommand[3] !== "string" || !/^kulo\.unowned\.[a-f0-9]{48}$/.test(owner.cleanupCommand[3])) { invalid(); continue; }
      const relative = path.relative(path.join(dataDir, "staging", "customization"), path.resolve(owner.workRoot));
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(relative) || owner.workRoot !== path.resolve(owner.workRoot)) { invalid(); continue; }
      let ownerAlive = true;
      try { process.kill(Number(owner.ownerPid), 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") ownerAlive = false; else if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
      const pending = await fs.lstat(path.join(directory, "cleanup-pending.json")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined; throw error;
      });
      if (ownerAlive && !pending) { result.pending.push({ id: entry.name, reason: "owner-active" }); continue; }
      try {
        await options.cleanup({ directory, marker: owner.cleanupCommand[2], negative: owner.cleanupCommand[3], workRoot: owner.workRoot });
        await fs.rm(directory, { recursive: true });
        result.recovered++;
      } catch {
        result.pending.push({ id: entry.name, reason: "cleanup-failed" });
      }
    }
    return result;
  } finally { release?.(); }
}
