import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { KULO_STATE_VERSION } from "./state.js";

interface StateStorageVersion {
  version: number;
  preparedAt: number;
  backupFile?: string;
}

const VERSION_FILE = "state-version.json";
const BACKUP_FILE = `backups/kulo-before-state-v${KULO_STATE_VERSION}.sqlite`;
const VALID_BACKUP_FILES = new Set(["backups/kulo-before-state-v2.sqlite", BACKUP_FILE]);
const WINDOWS_RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function renameSyncWithWindowsRetry(tempPath: string, targetPath: string): void {
  const maxAttempts = process.platform === "win32" ? 5 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < maxAttempts && code && WINDOWS_RETRYABLE_CODES.has(code)) {
        const deadline = Date.now() + 20 * attempt;
        while (Date.now() < deadline) {
          // Brief spin wait for transient Windows AV / indexer file lock release.
        }
        continue;
      }
      throw error;
    }
  }
}

function readVersion(filename: string): StateStorageVersion | undefined {
  if (!fs.existsSync(filename)) return undefined;
  const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!value || typeof value !== "object" || !("version" in value) ||
      typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new Error("Invalid Kulo state storage version marker");
  }
  if (value.version > KULO_STATE_VERSION) {
    throw new Error(`Kulo state storage has newer version ${value.version} than ${KULO_STATE_VERSION}`);
  }
  if (!("preparedAt" in value) || typeof value.preparedAt !== "number" || !Number.isSafeInteger(value.preparedAt) || value.preparedAt < 0 ||
      ("backupFile" in value && (typeof value.backupFile !== "string" || !VALID_BACKUP_FILES.has(value.backupFile)))) {
    throw new Error("Invalid Kulo state storage version marker");
  }
  return value as StateStorageVersion;
}

function checkDatabaseVersion(database: DatabaseSync): number {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'documents'").get()) return 0;
  // Durable stores indexed string columns as JSON strings, including their quotes.
  const row = database.prepare(`
    SELECT MAX(revision.version) AS version
    FROM document_revisions AS revision JOIN documents AS document ON document.id = revision.document_id
    WHERE document.kind = ?
  `).get(JSON.stringify("kulo.state")) as { version: number | null };
  const version = row.version ?? 0;
  if (version > KULO_STATE_VERSION) {
    throw new Error(`Kulo state document has newer version ${version} than ${KULO_STATE_VERSION}`);
  }
  return version;
}

function checkBackup(filename: string): void {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (result.quick_check !== "ok") throw new Error("Kulo state migration backup failed its integrity check");
    checkDatabaseVersion(database);
  } finally {
    database.close();
  }
}

/** Prepare the on-disk format before Durable can persist its document migration. */
export async function prepareStateStorage(stateDir: string): Promise<void> {
  const markerPath = path.join(stateDir, VERSION_FILE);
  const marker = readVersion(markerPath);
  const databasePath = path.join(stateDir, "kulo.sqlite");
  let source: DatabaseSync | undefined;
  let databaseVersion = 0;
  try {
    if (fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0) {
      source = new DatabaseSync(databasePath, { readOnly: true });
      databaseVersion = checkDatabaseVersion(source);
    }
    if (marker?.version === KULO_STATE_VERSION && (!source || marker.backupFile || databaseVersion >= KULO_STATE_VERSION)) return;

    let backupFile: string | undefined;
    if (source) {
      backupFile = BACKUP_FILE;
      const backupPath = path.join(stateDir, backupFile);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(backupPath)) {
        // A process may have stopped after the backup rename but before its marker commit.
        checkBackup(backupPath);
      } else {
        const temporary = `${backupPath}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
        try {
          // The SQLite backup API includes committed WAL pages; copying the main file does not.
          await backup(source, temporary);
          checkBackup(temporary);
          renameSyncWithWindowsRetry(temporary, backupPath);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      }
    }

    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${markerPath}.${randomUUID()}.tmp`;
    const value: StateStorageVersion = { version: KULO_STATE_VERSION, preparedAt: Date.now(), ...(backupFile ? { backupFile } : {}) };
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSyncWithWindowsRetry(temporary, markerPath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  } finally {
    source?.close();
  }
}
