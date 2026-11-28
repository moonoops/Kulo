import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import {
  redactSensitiveText,
  type ConnectionSaveRequest,
  type MigrationImportItemOutcome,
  type MigrationImportRequest,
  type MigrationImportResult,
  type MigrationScanResult,
  type MigrationStdioPrefill,
  type SkillAudience,
} from "@kulo/protocol";
import type { KuloConnections } from "./connections.js";
import type { KuloSkills } from "./skills.js";
import {
  MIGRATION_MAX_CONFIG_BYTES,
  buildNormalizedSkillStaging,
  buildStdioPrefillFromEntry,
  extractMcpServerEntries,
  inspectSkillDirectorySafe,
  readBoundedFileAtPath,
  sanitizeDisplayText,
  scanLocalHostConfigs,
  stripUtf8Bom,
  type InternalMigrationCandidate,
} from "./migration-scan.js";

export const MIGRATION_SCAN_TTL_MS = 10 * 60_000;
export const MIGRATION_MAX_CONNECTION_RECORDS = 256;
const MAX_CACHED_SCANS = 32;
const VALID_SKILL_AUDIENCES: ReadonlySet<SkillAudience> = new Set(["settings", "chat", "worker"]);

export class MigrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

interface StoredMigrationScan {
  scanId: string;
  principalId: string;
  envId: string;
  scannedAt: number;
  expiresAt: number;
  candidateHashes: Map<string, string>;
  candidates: Map<string, InternalMigrationCandidate>;
  seenSecrets: Set<string>;
}

export interface LocalConfigMigrationOptions {
  stateDir: string;
  homeDir?: string;
  connections: Pick<KuloConnections, "snapshot" | "save" | "remove" | "redact">;
  skills: Pick<KuloSkills, "snapshot" | "importLocalSnapshot">;
  getLocalNodeId: () => string;
  onClusterDirty?: (kind: "vault" | "files") => void;
  scanTtlMs?: number;
  now?: () => number;
}

export interface MigrationCallerContext {
  principalId: string;
  isHubLocalDisplay: boolean;
}

export class LocalConfigMigrationService {
  readonly #options: LocalConfigMigrationOptions;
  readonly #scans = new Map<string, StoredMigrationScan>();
  readonly #scanTtlMs: number;
  readonly #now: () => number;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: LocalConfigMigrationOptions) {
    this.#options = options;
    this.#scanTtlMs = options.scanTtlMs ?? MIGRATION_SCAN_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(work, work);
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }

  #homeDir(): string {
    return path.resolve(this.#options.homeDir ?? os.homedir());
  }

  #redact(text: string, seenSecrets?: ReadonlySet<string>): string {
    const first = seenSecrets?.size ? redactSensitiveText(text, [...seenSecrets]) : redactSensitiveText(text);
    return this.#options.connections.redact(first);
  }

  #pruneExpired(now: number): void {
    for (const [id, entry] of this.#scans) {
      if (now > entry.expiresAt) this.#scans.delete(id);
    }
    while (this.#scans.size >= MAX_CACHED_SCANS) {
      const oldest = this.#scans.keys().next().value;
      if (!oldest) break;
      this.#scans.delete(oldest);
    }
  }

  #assertLocalDisplay(caller: MigrationCallerContext): void {
    if (!caller.isHubLocalDisplay || !caller.principalId) {
      throw new MigrationError(403, "migration_local_display_required", "本机配置发现与导入仅限 Hub 本机控制台操作。");
    }
  }

  async scan(caller: MigrationCallerContext): Promise<MigrationScanResult> {
    this.#assertLocalDisplay(caller);
    const now = this.#now();
    this.#pruneExpired(now);

    const [connSnapshot, skillSnapshot] = await Promise.all([
      this.#options.connections.snapshot(),
      this.#options.skills.snapshot(),
    ]);
    const localNodeId = this.#options.getLocalNodeId();
    const scanned = scanLocalHostConfigs({
      homeDir: this.#homeDir(),
      existingConnections: connSnapshot.connections,
      existingSkills: skillSnapshot.skills,
      redact: (text) => this.#options.connections.redact(text),
    });

    const scanId = `mig-scan-${randomBytes(12).toString("hex")}`;
    const expiresAt = now + this.#scanTtlMs;
    this.#scans.set(scanId, {
      scanId,
      principalId: caller.principalId,
      envId: localNodeId,
      scannedAt: now,
      expiresAt,
      candidateHashes: scanned.candidateHashes,
      candidates: scanned.internalById,
      seenSecrets: scanned.seenSecrets,
    });

    return {
      scanId,
      scannedAt: now,
      expiresAt,
      localNodeId,
      currentConnectionCount: connSnapshot.connections.length,
      maxConnections: MIGRATION_MAX_CONNECTION_RECORDS,
      httpMcpCandidates: scanned.httpMcpCandidates,
      stdioMcpCandidates: scanned.stdioMcpCandidates,
      skillCandidates: scanned.skillCandidates,
      manualNotices: scanned.manualNotices,
    };
  }

  async importSelected(caller: MigrationCallerContext, request: MigrationImportRequest): Promise<MigrationImportResult> {
    this.#assertLocalDisplay(caller);
    return this.#serialize(() => this.#importSelectedLocked(caller, request));
  }

  async #importSelectedLocked(
    caller: MigrationCallerContext,
    request: MigrationImportRequest,
  ): Promise<MigrationImportResult> {
    const now = this.#now();
    const scanId = typeof request.scanId === "string" ? request.scanId.trim() : "";
    if (!scanId) {
      throw new MigrationError(400, "migration_invalid_request", "缺少有效的扫描编号 scanId。");
    }
    const scan = this.#scans.get(scanId);
    if (!scan) {
      throw new MigrationError(409, "migration_scan_not_found", "扫描结果不存在或已失效，请重新扫描。");
    }
    if (now > scan.expiresAt) {
      this.#scans.delete(scanId);
      throw new MigrationError(409, "migration_scan_expired", "扫描结果已超过 10 分钟有效期，请重新扫描。");
    }
    const localNodeId = this.#options.getLocalNodeId();
    if (scan.principalId !== caller.principalId || scan.envId !== localNodeId) {
      throw new MigrationError(403, "migration_scan_forbidden", "扫描结果与当前主体或本机节点不匹配。");
    }

    const mcpIds = dedupeStringArray(request.mcpCandidateIds, 128);
    const skillIds = dedupeStringArray(request.skillCandidateIds, 128);
    const stdioPrefillId =
      typeof request.stdioPrefillCandidateId === "string" && request.stdioPrefillCandidateId.trim()
        ? request.stdioPrefillCandidateId.trim()
        : undefined;

    if (!mcpIds.length && !skillIds.length && !stdioPrefillId) {
      throw new MigrationError(400, "migration_empty_selection", "请至少选择一项要导入的配置或要预填的本地命令。");
    }

    const skillAudiences = normalizeSkillAudiences(request.skillAudiences);
    const results: MigrationImportItemOutcome[] = [];
    let stdioPrefill: MigrationStdioPrefill | undefined;

    // 1. Read-only stdio prefill (never auto-saves, never spawns subprocess)
    if (stdioPrefillId) {
      const record = scan.candidates.get(stdioPrefillId);
      if (!record || record.kind !== "stdio_mcp") {
        throw new MigrationError(404, "migration_candidate_not_found", "未找到对应的本地命令配置项。");
      }
      const verified = this.#verifyAndReadJsonEntry(record.absPath, scan.candidateHashes.get(stdioPrefillId)!, record.serverKey, record.jsonScope, record.projectKey);
      stdioPrefill = buildStdioPrefillFromEntry({
        candidateId: stdioPrefillId,
        serverKey: record.serverKey,
        raw: verified,
        localNodeId,
        seenSecrets: scan.seenSecrets,
        extraRedact: (text) => this.#options.connections.redact(text),
      });
    }

    // 2. Pre-validate HTTP MCP candidates (TOCTOU + stdio block + MAX_RECORDS = 256 quota check)
    const connSnapshot = await this.#options.connections.snapshot();
    const existingHttpUrls = new Set<string>();
    for (const conn of connSnapshot.connections) {
      if (conn.kind === "mcp" && conn.mcpTransport === "http" && conn.url) {
        try {
          const u = new URL(conn.url);
          existingHttpUrls.add(`${u.origin}${u.pathname}`);
        } catch {
          // ignore
        }
      }
    }

    const httpToCreate: Array<{
      candidateId: string;
      record: Extract<InternalMigrationCandidate, { kind: "http_mcp" }>;
    }> = [];

    for (const id of mcpIds) {
      const rec = scan.candidates.get(id);
      if (!rec) {
        results.push({
          candidateId: id,
          kind: "http_mcp",
          name: id,
          status: "failed",
          code: "migration_candidate_not_found",
          message: "未找到对应的 MCP 候选项。",
        });
        continue;
      }
      if (rec.kind === "stdio_mcp") {
        results.push({
          candidateId: id,
          kind: "stdio_mcp",
          name: rec.candidate.name,
          status: "failed",
          code: "stdio_auto_import_blocked",
          message: "本地命令 stdio MCP 禁止一键导入，请使用只读清单预填手动表单。",
        });
        continue;
      }
      if (rec.kind !== "http_mcp") {
        results.push({
          candidateId: id,
          kind: "http_mcp",
          name: id,
          status: "failed",
          code: "migration_invalid_candidate_kind",
          message: "所选条目不是 HTTP MCP 配置。",
        });
        continue;
      }
      // TOCTOU verification on disk BEFORE any write
      const expectedHash = scan.candidateHashes.get(id);
      if (!expectedHash) {
        throw new MigrationError(409, "migration_source_changed", "缺少源文件完整性哈希，请重新扫描。");
      }
      this.#verifyAndReadJsonEntry(rec.absPath, expectedHash, rec.serverKey, rec.jsonScope, rec.projectKey);

      if (!rec.candidate.importable || !rec.cleanUrl) {
        results.push({
          candidateId: id,
          kind: "http_mcp",
          name: rec.candidate.name,
          status: "failed",
          code: "migration_http_mcp_not_importable",
          message: "该 HTTP MCP 存在无法自动导入的地址限制，请手工添加。",
          pendingItems: rec.candidate.pendingItems,
        });
        continue;
      }
      if (existingHttpUrls.has(rec.cleanUrl)) {
        results.push({
          candidateId: id,
          kind: "http_mcp",
          name: rec.candidate.name,
          status: "skipped",
          code: "migration_already_imported",
          message: "已存在相同地址的 HTTP MCP 连接，已跳过。",
          disabledInSource: rec.disabledInSource,
          pendingItems: rec.candidate.pendingItems,
        });
        continue;
      }
      existingHttpUrls.add(rec.cleanUrl);
      httpToCreate.push({ candidateId: id, record: rec });
    }

    // Strict quota check BEFORE writing ANY connection: connections.length + selected <= 256
    if (connSnapshot.connections.length + httpToCreate.length > MIGRATION_MAX_CONNECTION_RECORDS) {
      throw new MigrationError(
        409,
        "migration_connection_limit_exceeded",
        `导入 ${httpToCreate.length} 项后将超过连接数量上限（当前 ${connSnapshot.connections.length}/${MIGRATION_MAX_CONNECTION_RECORDS}），已拒绝本次批量写入。`,
      );
    }

    // 3. Pre-verify Skills TOCTOU BEFORE writing anything
    const skillStagingPlans: Array<{
      candidateId: string;
      record: Extract<InternalMigrationCandidate, { kind: "skill" }>;
      verified: ReturnType<typeof inspectSkillDirectorySafe>;
    }> = [];
    for (const id of skillIds) {
      const rec = scan.candidates.get(id);
      if (!rec || rec.kind !== "skill") {
        results.push({
          candidateId: id,
          kind: "skill",
          name: id,
          status: "failed",
          code: "migration_candidate_not_found",
          message: "未找到对应的技能候选项。",
        });
        continue;
      }
      const expectedHash = scan.candidateHashes.get(id);
      const verified = inspectSkillDirectorySafe(
        this.#homeDir(),
        rec.absDirPath,
        scan.seenSecrets,
        (text) => this.#options.connections.redact(text),
      );
      if (!verified.ok) {
        throw new MigrationError(
          409,
          "migration_source_changed",
          `技能「${rec.candidate.normalizedName}」二次校验失败：${this.#redact(verified.reason, scan.seenSecrets)}`,
        );
      }
      if (!expectedHash || verified.snapshot.sha256 !== expectedHash) {
        throw new MigrationError(
          409,
          "migration_source_changed",
          `技能「${rec.candidate.normalizedName}」在扫描后发生变更，已拒绝导入，请重新扫描。`,
        );
      }
      skillStagingPlans.push({ candidateId: id, record: rec, verified });
    }

    // 4. Persist HTTP MCP connections (credential-less, preserving disabled state; rollback batch on quota race)
    const createdConnectionIds: string[] = [];
    try {
      for (const item of httpToCreate) {
        const rec = item.record;
        const authMode = rec.candidate.inferredAuthMode ?? "none";
        const instructionsParts: string[] = [
          `来源：${rec.candidate.sourceLabel} (${rec.candidate.sourcePath})`,
        ];
        if (rec.candidate.pendingItems.length > 0) {
          instructionsParts.push(
            `待处理项：${rec.candidate.pendingItems.map((p) => (p.detail ? `${p.message}（${p.detail}）` : p.message)).join("；")}`,
          );
        }
        const saveReq: ConnectionSaveRequest = {
          name: rec.candidate.name,
          kind: "mcp",
          category: "app",
          mcpTransport: "http",
          url: rec.cleanUrl!,
          mcpAuthMode: authMode,
          ...(authMode === "header" && rec.candidate.headerName ? { headerName: rec.candidate.headerName } : {}),
          ...(rec.matchedPresetId ? { mcpPresetId: rec.matchedPresetId } : {}),
          ...(rec.disabledInSource ? { mcpDisabled: true } : {}),
          instructions: sanitizeDisplayText(instructionsParts.join("\n"), scan.seenSecrets, (t) => this.#options.connections.redact(t), 1000),
        };
        try {
          const saved = await this.#options.connections.save(saveReq, "form");
          createdConnectionIds.push(saved.id);
          results.push({
            candidateId: item.candidateId,
            kind: "http_mcp",
            name: saved.name,
            status: "imported",
            message: rec.disabledInSource
              ? "已导入无凭据 HTTP MCP（已保留原禁用状态）。"
              : "已导入无凭据 HTTP MCP。",
            createdId: saved.id,
            disabledInSource: rec.disabledInSource,
            pendingItems: rec.candidate.pendingItems,
          });
        } catch (err) {
          const rawMsg = err instanceof Error ? err.message : "保存连接失败。";
          if (rawMsg.includes("上限")) {
            throw new MigrationError(409, "migration_connection_limit_exceeded", "连接数量已达到 256 条上限，已回滚本次批量导入。");
          }
          results.push({
            candidateId: item.candidateId,
            kind: "http_mcp",
            name: rec.candidate.name,
            status: "failed",
            code: "migration_http_mcp_save_failed",
            message: this.#redact(rawMsg, scan.seenSecrets),
            pendingItems: rec.candidate.pendingItems,
          });
        }
      }
    } catch (err) {
      // Roll back connections created during this batch if a quota race aborted the batch.
      for (const createdId of createdConnectionIds.reverse()) {
        await this.#options.connections.remove(createdId).catch(() => undefined);
      }
      throw err;
    }

    if (createdConnectionIds.length > 0) {
      this.#options.onClusterDirty?.("files");
    }

    // 5. Persist Skill snapshots (enabled: false, audiences: ["worker"] default, same-name keeps Kulo-managed)
    const commandBase =
      typeof request.commandId === "string" && request.commandId.trim()
        ? request.commandId.trim().slice(0, 120)
        : `${scanId}`;

    for (const plan of skillStagingPlans) {
      if (!plan.verified.ok) continue;
      const snap = plan.verified.snapshot;
      const stagingRoot = path.join(this.#options.stateDir, ".migration-staging");
      fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
      const workDir = fs.mkdtempSync(path.join(stagingRoot, "skill-"));
      try {
        buildNormalizedSkillStaging(snap, workDir, scan.seenSecrets, (t) => this.#options.connections.redact(t));
        const outcome = await this.#options.skills.importLocalSnapshot({
          stagingDirectory: workDir,
          sourceLocator: plan.record.candidate.sourcePath,
          commandId: `migration:${commandBase}:${plan.record.candidate.normalizedName}:${snap.sha256.slice(0, 12)}`,
          enabled: false,
          audiences: skillAudiences,
        });
        if (outcome.status === "skipped") {
          results.push({
            candidateId: plan.candidateId,
            kind: "skill",
            name: snap.normalizedName,
            status: "skipped",
            code: "skill_name_conflict",
            message: "已存在同名 Kulo 托管技能，保留现有托管版本。",
            ...(outcome.existingId ? { createdId: outcome.existingId } : {}),
            sha256: snap.sha256,
          });
        } else {
          results.push({
            candidateId: plan.candidateId,
            kind: "skill",
            name: snap.normalizedName,
            status: "imported",
            message: "已导入技能快照（默认停用，受众：后台任务）。",
            ...(outcome.record?.id ? { createdId: outcome.record.id } : {}),
            sha256: snap.sha256,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "技能快照导入失败。";
        results.push({
          candidateId: plan.candidateId,
          kind: "skill",
          name: snap.normalizedName,
          status: "failed",
          code: "migration_skill_import_failed",
          message: this.#redact(msg, scan.seenSecrets),
          sha256: snap.sha256,
        });
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }

    return {
      scanId,
      importedAt: this.#now(),
      results,
      ...(stdioPrefill ? { stdioPrefill } : {}),
      summary: {
        imported: results.filter((r) => r.status === "imported").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length,
      },
    };
  }

  #verifyAndReadJsonEntry(
    absPath: string,
    expectedSha256: string,
    serverKey: string,
    jsonScope: "root" | "project",
    projectKey?: string,
  ): Record<string, unknown> {
    const reread = readBoundedFileAtPath(absPath, this.#homeDir(), MIGRATION_MAX_CONFIG_BYTES);
    if (reread.kind !== "ok" || reread.sha256 !== expectedSha256) {
      throw new MigrationError(
        409,
        "migration_source_changed",
        "源文件在扫描后发生变化或不可安全读取，已拒绝导入，请重新扫描。",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripUtf8Bom(new TextDecoder("utf-8", { fatal: true }).decode(reread.bytes)));
    } catch {
      throw new MigrationError(409, "migration_source_changed", "源文件 JSON 格式已损坏，请重新扫描。");
    }
    const entries = extractMcpServerEntries(parsed);
    const matched = entries.find(
      (entry) =>
        entry.serverKey === serverKey &&
        entry.jsonScope === jsonScope &&
        entry.projectKey === projectKey,
    );
    if (!matched) {
      throw new MigrationError(409, "migration_source_changed", "源配置条目已变更或被移除，请重新扫描。");
    }
    return matched.raw;
  }
}

function dedupeStringArray(value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new MigrationError(400, "migration_invalid_request", "所选候选项列表无效。");
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function normalizeSkillAudiences(value: unknown): SkillAudience[] {
  if (value === undefined) return ["worker"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !VALID_SKILL_AUDIENCES.has(item as SkillAudience))
  ) {
    throw new MigrationError(400, "migration_invalid_request", "技能使用范围参数无效。");
  }
  return [...new Set(value as SkillAudience[])].sort();
}

export interface MigrationToolsDeps {
  service: () => LocalConfigMigrationService;
  assertHubLocalDisplayTurn: () => Promise<MigrationCallerContext>;
  redact: (text: string) => string;
}

/**
 * Read-only Settings Assistant extension exposing ONLY `kulo_migration_scan`.
 * Strictly requires `isHubLocalDisplay`, returns secret-free safe summaries + opaque `candidateId`s,
 * and never imports or writes connections/skills directly without human UI confirmation.
 */
export function createMigrationToolsExtension(deps: MigrationToolsDeps) {
  return defineExtension({
    name: "kulo-migration-tools",
    tools: [
      defineTool({
        name: "kulo_migration_scan",
        description:
          "Read-only scan of local AI tool configs on the Hub host (Claude Code, Cursor, Antigravity, Codex, ~/.agents/skills). Requires local Hub console display; returns only secret-free summaries and opaque candidate IDs (never raw URLs, args, or credentials). Guide the user to review and import via the Settings UI modal. 关键词：本机配置发现 迁移导入 扫描Claude Cursor Antigravity Codex技能 MCP",
        parameters: obj({}),
        deferred: true,
        replay: "safe",
        execute: async () => {
          const caller = await deps.assertHubLocalDisplayTurn();
          const result = await deps.service().scan(caller);
          const payload = {
            ...result,
            guidance:
              "以上为不含任何凭据明文的安全摘要。请引导用户在「设置 → 授权凭据 → 从本机导入」或「工具技能 → 技能 → 扫描本机技能」弹窗中勾选确认导入；本地命令 stdio 项仅支持预填手动表单，禁止自动执行。",
          };
          return {
            output: [{ type: "text" as const, text: deps.redact(JSON.stringify(payload)) }],
          };
        },
      }),
    ],
  });
}
