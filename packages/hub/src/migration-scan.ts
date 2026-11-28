import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseDocument } from "yaml";
import {
  inspectSensitiveText,
  type ConnectionRecordView,
  type McpAuthMode,
  type MigrationManualNotice,
  type MigrationMcpCandidate,
  type MigrationPendingItem,
  type MigrationSkillCandidate,
  type MigrationSourceTool,
  type SkillRecord,
} from "@kulo/protocol";
import { binding } from "./connection-fields.js";
import { MCP_PRESET_CATALOG, isLoopbackHost, isNonPublicMcpUrl } from "./mcp-presets.js";
import {
  MIGRATION_MAX_CONFIG_BYTES,
  MIGRATION_MAX_SKILL_DEPTH,
  MIGRATION_MAX_SKILL_FILES,
  MIGRATION_MAX_SKILL_FILE_BYTES,
  MIGRATION_MAX_SKILL_MD_BYTES,
  MIGRATION_MAX_SKILL_PACKAGE_BYTES,
  SKILL_HARMLESS_DOTFILES,
  SKILL_IGNORED,
  SKILL_SENSITIVE_NAME,
  UNSAFE_PATH_SEGMENTS,
  classifyStdioRisks,
  collectEnvKeys,
  displayHomePath,
  extractMcpServerEntries,
  extractToolFilterNames,
  normalizeMigratedSkillName,
  parseHeadersInfo,
  readBoundedRegularFile,
  recordSecret,
  sanitizeCliArgs,
  sanitizeDisplayText,
  sha256Hex,
  stripUrlCredentialsAndQuery,
  stripUtf8Bom,
} from "./migration-sanitize.js";

export {
  MIGRATION_MAX_CONFIG_BYTES,
  MIGRATION_MAX_SKILL_DEPTH,
  MIGRATION_MAX_SKILL_FILES,
  MIGRATION_MAX_SKILL_FILE_BYTES,
  MIGRATION_MAX_SKILL_MD_BYTES,
  MIGRATION_MAX_SKILL_PACKAGE_BYTES,
  buildStdioPrefillFromEntry,
  classifyStdioRisks,
  displayHomePath,
  extractMcpServerEntries,
  isHighEntropySecret,
  normalizeMigratedSkillName,
  readBoundedFileAtPath,
  readBoundedRegularFile,
  sanitizeCliArgs,
  sanitizeDisplayText,
  sha256Hex,
  stripUrlCredentialsAndQuery,
  stripUtf8Bom,
  type BoundedFileRead,
  type ParsedMcpEntry,
} from "./migration-sanitize.js";

export interface InternalHttpMcpRecord {
  kind: "http_mcp";
  candidate: MigrationMcpCandidate;
  absPath: string;
  fileSha256: string;
  serverKey: string;
  jsonScope: "root" | "project";
  projectKey?: string;
  cleanUrl?: string;
  matchedPresetId?: string;
  disabledInSource: boolean;
}

export interface InternalStdioMcpRecord {
  kind: "stdio_mcp";
  candidate: MigrationMcpCandidate;
  absPath: string;
  fileSha256: string;
  serverKey: string;
  jsonScope: "root" | "project";
  projectKey?: string;
}

export interface InternalSkillRecord {
  kind: "skill";
  candidate: MigrationSkillCandidate;
  absDirPath: string;
  dirSha256: string;
}

export type InternalMigrationCandidate =
  | InternalHttpMcpRecord
  | InternalStdioMcpRecord
  | InternalSkillRecord;

export interface LocalMigrationScanOutput {
  httpMcpCandidates: MigrationMcpCandidate[];
  stdioMcpCandidates: MigrationMcpCandidate[];
  skillCandidates: MigrationSkillCandidate[];
  manualNotices: MigrationManualNotice[];
  internalById: Map<string, InternalMigrationCandidate>;
  candidateHashes: Map<string, string>;
  seenSecrets: Set<string>;
}

interface ConfigSourceSpec {
  source: MigrationSourceTool;
  sourceLabel: string;
  relSegments: readonly string[];
  kind: "json" | "codex-toml";
}

interface SkillRootSpec {
  source: MigrationSourceTool;
  sourceLabel: string;
  relSegments: readonly string[];
}

const CONFIG_SOURCES: readonly ConfigSourceSpec[] = [
  { source: "claude-code", sourceLabel: "Claude Code", relSegments: [".claude.json"], kind: "json" },
  { source: "claude-code", sourceLabel: "Claude Code", relSegments: [".claude", "settings.json"], kind: "json" },
  { source: "cursor", sourceLabel: "Cursor", relSegments: [".cursor", "mcp.json"], kind: "json" },
  { source: "antigravity", sourceLabel: "Antigravity", relSegments: [".gemini", "config", "mcp_config.json"], kind: "json" },
  { source: "codex", sourceLabel: "Codex", relSegments: [".codex", "config.toml"], kind: "codex-toml" },
];

const SKILL_ROOTS: readonly SkillRootSpec[] = [
  { source: "claude-code", sourceLabel: "Claude Code", relSegments: [".claude", "skills"] },
  { source: "cursor", sourceLabel: "Cursor", relSegments: [".cursor", "skills"] },
  { source: "antigravity", sourceLabel: "Antigravity", relSegments: [".gemini", "config", "skills"] },
  { source: "agents-shared", sourceLabel: "共享技能 (~/.agents)", relSegments: [".agents", "skills"] },
  { source: "codex", sourceLabel: "Codex", relSegments: [".codex", "skills"] },
];

function opaqueId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function existingHttpMcpBindings(connections: readonly ConnectionRecordView[]): Set<string> {
  const set = new Set<string>();
  for (const conn of connections) {
    if (conn.kind !== "mcp" || conn.mcpTransport !== "http" || !conn.url) continue;
    try {
      const u = new URL(conn.url);
      set.add(`${u.origin}${u.pathname}`);
    } catch {
      // ignore invalid
    }
  }
  return set;
}

export interface VerifiedSkillSnapshot {
  originalName: string;
  normalizedName: string;
  nameNormalized: boolean;
  description: string;
  sha256: string;
  fileCount: number;
  totalBytes: number;
  skippedDotfiles: string[];
  files: Array<{ relPath: string; bytes: Buffer; executable: boolean }>;
  rawSkillMdText: string;
}

export function inspectSkillDirectorySafe(
  homeDir: string,
  absSkillDir: string,
  seenSecrets: Set<string>,
  extraRedact?: (text: string) => string,
): { ok: true; snapshot: VerifiedSkillSnapshot } | { ok: false; reason: string } {
  const relToHome = path.relative(homeDir, absSkillDir);
  if (!relToHome || relToHome.startsWith("..") || path.isAbsolute(relToHome)) {
    return { ok: false, reason: "技能目录超出主目录范围。" };
  }
  let walkRoot = homeDir;
  for (const seg of relToHome.split(path.sep)) {
    walkRoot = path.join(walkRoot, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(walkRoot);
    } catch {
      return { ok: false, reason: "技能目录不存在或不可读取。" };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, reason: "技能目录包含符号链接，已拒绝。" };
    }
  }

  const files: Array<{ relPath: string; bytes: Buffer; executable: boolean; hash: string }> = [];
  const skippedDotfiles: string[] = [];
  let totalBytes = 0;
  let totalEntries = 0;

  const visit = (dir: string, relPrefix: string, depth: number): string | null => {
    if (depth > MIGRATION_MAX_SKILL_DEPTH) return "技能目录层级超过安全上限。";
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return "无法读取技能目录内容。";
    }
    for (const entry of dirEntries) {
      if (SKILL_IGNORED.has(entry.name)) continue;
      if (SKILL_HARMLESS_DOTFILES.has(entry.name)) {
        skippedDotfiles.push(relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
        continue;
      }
      if (++totalEntries > MIGRATION_MAX_SKILL_FILES * 2) return "技能目录条目数超过安全上限。";
      if (UNSAFE_PATH_SEGMENTS.has(entry.name)) return "技能包含不安全的文件名。";
      if (SKILL_SENSITIVE_NAME.test(entry.name)) {
        return `技能包含敏感或凭据文件（${entry.name}），已拒绝导入。`;
      }
      if (entry.name.startsWith(".")) {
        return `技能包含未知隐藏文件（${entry.name}），已拒绝导入。`;
      }
      const absChild = path.join(dir, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(absChild);
      } catch {
        return "无法读取技能文件元数据。";
      }
      if (st.isSymbolicLink()) return "技能目录包含符号链接，已拒绝导入。";
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (st.isDirectory()) {
        const err = visit(absChild, relPath, depth + 1);
        if (err) return err;
      } else if (st.isFile()) {
        if (files.length + 1 > MIGRATION_MAX_SKILL_FILES) return "技能文件数量超过上限（512）。";
        if (st.size > MIGRATION_MAX_SKILL_FILE_BYTES) return "技能单个文件超过 4 MiB 上限。";
        totalBytes += st.size;
        if (totalBytes > MIGRATION_MAX_SKILL_PACKAGE_BYTES) return "技能总体积超过 16 MiB 上限。";
        let fd: number | undefined;
        try {
          fd = fs.openSync(absChild, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          const actual = fs.fstatSync(fd);
          if (!actual.isFile() || actual.size !== st.size) return "技能文件在扫描期间发生变化。";
          const buf = Buffer.alloc(actual.size);
          let offset = 0;
          while (offset < actual.size) {
            const n = fs.readSync(fd, buf, offset, actual.size - offset, offset);
            if (n <= 0) return "技能文件在扫描期间发生变化。";
            offset += n;
          }
          files.push({
            relPath,
            bytes: buf,
            executable: Boolean(st.mode & 0o111),
            hash: sha256Hex(buf),
          });
        } catch {
          return "技能包含无法安全读取的文件或符号链接。";
        } finally {
          if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
          }
        }
      } else {
        return "技能包含特殊文件类型，已拒绝导入。";
      }
    }
    return null;
  };

  const walkErr = visit(absSkillDir, "", 0);
  if (walkErr) return { ok: false, reason: walkErr };

  const skillMd = files.find((f) => f.relPath === "SKILL.md");
  if (!skillMd) return { ok: false, reason: "目录缺少 SKILL.md。" };
  if (skillMd.bytes.byteLength > MIGRATION_MAX_SKILL_MD_BYTES) {
    return { ok: false, reason: "SKILL.md 超过 256 KiB 上限。" };
  }
  let rawSkillMdText: string;
  try {
    rawSkillMdText = stripUtf8Bom(new TextDecoder("utf-8", { fatal: true }).decode(skillMd.bytes));
  } catch {
    return { ok: false, reason: "SKILL.md 不是有效的 UTF-8 文本。" };
  }
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(rawSkillMdText);
  if (!fmMatch) return { ok: false, reason: "SKILL.md 缺少 YAML 头部元数据。" };
  const yamlDoc = parseDocument(fmMatch[1]!, { uniqueKeys: true });
  if (yamlDoc.errors.length > 0) return { ok: false, reason: "SKILL.md YAML 头部无效。" };
  let meta: unknown;
  try {
    meta = yamlDoc.toJS({ maxAliasCount: 20 });
  } catch {
    return { ok: false, reason: "SKILL.md YAML 引用过多或无效。" };
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return { ok: false, reason: "SKILL.md YAML 头部必须为对象。" };
  }
  const metaRecord = meta as Record<string, unknown>;
  const rawName = typeof metaRecord.name === "string" ? metaRecord.name.trim() : "";
  const normalized = normalizeMigratedSkillName(rawName);
  if (!normalized) {
    return { ok: false, reason: "SKILL.md 名称无效（仅支持小写字母、数字、连字符或下划线）。" };
  }
  const rawDesc = typeof metaRecord.description === "string" ? metaRecord.description.trim() : "";
  if (!rawDesc || rawDesc.length > 1024) {
    return { ok: false, reason: "SKILL.md 缺少有效描述。" };
  }
  const inspectedDesc = inspectSensitiveText(rawDesc);
  for (const s of inspectedDesc.secrets) recordSecret(seenSecrets, s.value);
  const safeDesc = sanitizeDisplayText(rawDesc, seenSecrets, extraRedact, 240);
  const dirSha256 = sha256Hex(
    JSON.stringify(
      files
        .map((f) => [f.relPath, f.hash] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

  return {
    ok: true,
    snapshot: {
      originalName: rawName,
      normalizedName: normalized.normalized,
      nameNormalized: normalized.wasNormalized,
      description: safeDesc || normalized.normalized,
      sha256: dirSha256,
      fileCount: files.length,
      totalBytes,
      skippedDotfiles,
      files: files.map(({ relPath, bytes, executable }) => ({ relPath, bytes, executable })),
      rawSkillMdText,
    },
  };
}

export function buildNormalizedSkillStaging(
  snapshot: VerifiedSkillSnapshot,
  stagingDir: string,
  seenSecrets: ReadonlySet<string>,
  extraRedact?: (text: string) => string,
): void {
  for (const file of snapshot.files) {
    const dest = path.join(stagingDir, ...file.relPath.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (file.relPath === "SKILL.md") {
      const rewritten = rewriteSkillFrontmatter(snapshot.rawSkillMdText, snapshot.normalizedName, seenSecrets, extraRedact);
      fs.writeFileSync(dest, rewritten, { flag: "wx", mode: 0o600 });
    } else {
      fs.writeFileSync(dest, file.bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    }
  }
}

function rewriteSkillFrontmatter(
  rawSkillMd: string,
  normalizedName: string,
  seenSecrets: ReadonlySet<string>,
  extraRedact?: (text: string) => string,
): string {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(rawSkillMd);
  if (!fmMatch) return rawSkillMd;
  const yamlDoc = parseDocument(fmMatch[1]!, { uniqueKeys: true });
  yamlDoc.set("name", normalizedName);
  const rawDesc = yamlDoc.get("description");
  if (typeof rawDesc === "string") {
    const safeDesc = sanitizeDisplayText(rawDesc, seenSecrets, extraRedact, 1000);
    if (safeDesc !== rawDesc.trim()) {
      yamlDoc.set("description", safeDesc || normalizedName);
    }
  }
  const rest = rawSkillMd.slice(fmMatch[0].length);
  return `---\n${yamlDoc.toString().trimEnd()}\n---${fmMatch[2]}${rest}`;
}

export function scanLocalHostConfigs(options: {
  homeDir?: string;
  existingConnections: readonly ConnectionRecordView[];
  existingSkills: readonly SkillRecord[];
  redact?: (text: string) => string;
}): LocalMigrationScanOutput {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const httpMcpCandidates: MigrationMcpCandidate[] = [];
  const stdioMcpCandidates: MigrationMcpCandidate[] = [];
  const skillCandidates: MigrationSkillCandidate[] = [];
  const manualNotices: MigrationManualNotice[] = [];
  const internalById = new Map<string, InternalMigrationCandidate>();
  const candidateHashes = new Map<string, string>();
  const seenSecrets = new Set<string>();
  const existingHttp = existingHttpMcpBindings(options.existingConnections);
  const existingSkillsByName = new Map(options.existingSkills.map((s) => [s.name, s]));

  for (const spec of CONFIG_SOURCES) {
    const displayPath = `~/${spec.relSegments.join("/")}`;
    const read = readBoundedRegularFile(homeDir, spec.relSegments, MIGRATION_MAX_CONFIG_BYTES);
    if (read.kind === "missing") continue;
    if (read.kind === "symlink") {
      manualNotices.push({
        source: spec.source,
        sourceLabel: spec.sourceLabel,
        sourcePath: displayPath,
        code: "symlink_rejected",
        message: "检测到符号链接配置文件，出于安全策略已跳过。",
      });
      continue;
    }
    if (read.kind === "too_large") {
      manualNotices.push({
        source: spec.source,
        sourceLabel: spec.sourceLabel,
        sourcePath: displayPath,
        code: "file_too_large",
        message: "配置文件超过 2 MiB 安全上限，已跳过自动扫描。",
      });
      continue;
    }
    if (read.kind !== "ok") {
      manualNotices.push({
        source: spec.source,
        sourceLabel: spec.sourceLabel,
        sourcePath: displayPath,
        code: "read_error",
        message: read.kind === "error" ? read.message : "配置文件不可作为普通文件读取。",
      });
      continue;
    }

    if (spec.kind === "codex-toml") {
      manualNotices.push({
        source: spec.source,
        sourceLabel: spec.sourceLabel,
        sourcePath: displayPath,
        code: "codex_toml_manual",
        message: "检测到 Codex TOML 配置，请参考清单手工添加。",
      });
      continue;
    }

    let parsedJson: unknown;
    try {
      const text = stripUtf8Bom(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
      parsedJson = JSON.parse(text);
    } catch {
      manualNotices.push({
        source: spec.source,
        sourceLabel: spec.sourceLabel,
        sourcePath: displayPath,
        code: "invalid_json",
        message: "JSON 配置解析失败，请核对文件格式后手工添加。",
      });
      continue;
    }

    const entries = extractMcpServerEntries(parsedJson);
    for (const entry of entries) {
      const raw = entry.raw;
      const disabledInSource = raw.disabled === true || raw.enabled === false;
      const rawDesc = typeof raw.description === "string" ? raw.description : "";
      const envInfo = collectEnvKeys(raw.env, seenSecrets);
      const headersInfo = parseHeadersInfo(raw.headers, seenSecrets);
      const rawArgs = Array.isArray(raw.args) ? raw.args : [];
      const argSanitized = sanitizeCliArgs(rawArgs, seenSecrets);
      const rawUrlValue =
        typeof raw.url === "string"
          ? raw.url
          : typeof raw.serverUrl === "string"
            ? raw.serverUrl
            : undefined;
      const rawCommand = typeof raw.command === "string" ? raw.command.trim() : "";
      const isStdio = Boolean(rawCommand) || raw.type === "stdio" || raw.transport === "stdio";
      const toolFilters = extractToolFilterNames(raw);

      if (rawDesc) {
        const inspectedDesc = inspectSensitiveText(rawDesc);
        for (const s of inspectedDesc.secrets) recordSecret(seenSecrets, s.value);
      }

      const candidateId = opaqueId("mig-mcp");
      if (isStdio) {
        const hadSecretsStripped = argSanitized.hadSecretsStripped || envInfo.hadSecrets || headersInfo.hadSecrets;
        const riskFlags = classifyStdioRisks(
          rawCommand,
          rawArgs.filter((a): a is string => typeof a === "string"),
          hadSecretsStripped,
        );
        const pendingItems: MigrationPendingItem[] = [];
        if (disabledInSource) {
          pendingItems.push({ kind: "source_disabled", message: "原配置处于禁用状态。" });
        }
        if (toolFilters.length) {
          pendingItems.push({
            kind: "tool_filters",
            message: "原配置包含工具白名单/禁用规则，需在 Kulo 中另行确认。",
            detail: toolFilters.join("；"),
          });
        }
        const safeName = sanitizeDisplayText(entry.serverKey, seenSecrets, options.redact, 120) || "stdio-mcp";
        const candidate: MigrationMcpCandidate = {
          candidateId,
          source: spec.source,
          sourceLabel: spec.sourceLabel,
          sourcePath: displayPath,
          name: safeName,
          transport: "stdio",
          commandSummary: rawCommand ? path.basename(rawCommand).slice(0, 64) : "command",
          disabledInSource,
          importable: false,
          alreadyImported: false,
          hadSecretsStripped,
          ...(rawDesc ? { descriptionSummary: sanitizeDisplayText(rawDesc, seenSecrets, options.redact, 160) } : {}),
          ...(envInfo.envKeys.length ? { requiredEnvKeys: envInfo.envKeys } : {}),
          pendingItems,
          riskFlags,
        };
        stdioMcpCandidates.push(candidate);
        internalById.set(candidateId, {
          kind: "stdio_mcp",
          candidate,
          absPath: read.absPath,
          fileSha256: read.sha256,
          serverKey: entry.serverKey,
          jsonScope: entry.jsonScope,
          ...(entry.projectKey ? { projectKey: entry.projectKey } : {}),
        });
        candidateHashes.set(candidateId, read.sha256);
        continue;
      }

      if (!rawUrlValue) continue;
      const urlInfo = stripUrlCredentialsAndQuery(rawUrlValue, seenSecrets);
      const pendingItems: MigrationPendingItem[] = [];
      let matchedPresetId: string | undefined;
      let inferredAuthMode: McpAuthMode = headersInfo.inferredAuthMode ?? "none";

      if (urlInfo.cleanUrl) {
        const preset = MCP_PRESET_CATALOG.find((p) => {
          try {
            const pu = new URL(p.url);
            const cu = new URL(urlInfo.cleanUrl!);
            return pu.origin === cu.origin && pu.pathname.replace(/\/+$/, "") === cu.pathname.replace(/\/+$/, "");
          } catch {
            return false;
          }
        });
        if (preset && preset.id !== "composio") {
          matchedPresetId = preset.id;
          if (!headersInfo.inferredAuthMode) inferredAuthMode = preset.authMode;
        }
      }
      if (!headersInfo.inferredAuthMode && raw.oauth && typeof raw.oauth === "object") {
        inferredAuthMode = "oauth";
      }

      if (disabledInSource) {
        pendingItems.push({
          kind: "source_disabled",
          message: "原配置为禁用状态，导入后将保持禁用，可在连接页手动启用。",
        });
      }
      if (inferredAuthMode !== "none") {
        pendingItems.push({
          kind: "auth_required",
          message: inferredAuthMode === "oauth" ? "导入后请在连接页完成 OAuth 授权登录。" : "导入不含凭据明文，请在连接页补充访问令牌。",
        });
      }
      if (headersInfo.extraHeaderNames.length > 0) {
        pendingItems.push({
          kind: "multiple_auth_headers",
          message: "原配置包含多个自定义请求头，Kulo 仅支持单个认证请求头，其余需人工核对。",
          detail: headersInfo.extraHeaderNames.join(", "),
        });
      }
      if (headersInfo.hasEnvRef || envInfo.hasEnvRef || urlInfo.hasEnvRef) {
        pendingItems.push({
          kind: "env_var_reference",
          message: "原配置引用了环境变量（如 ${VAR}），导入后请在连接页手动补充对应凭据。",
        });
      }
      if (toolFilters.length > 0) {
        pendingItems.push({
          kind: "tool_filters",
          message: "原配置包含工具过滤规则（allow/deny），Kulo 暂未等价转换，请在导入后核对。",
          detail: toolFilters.join("；"),
        });
      }
      if (urlInfo.hadQuery) {
        pendingItems.push({
          kind: "query_params_stripped",
          message: "已剥离 URL 查询参数以防凭据泄露，请确认无额外非敏感查询参数需求。",
        });
      }
      let importable = urlInfo.valid && Boolean(urlInfo.cleanUrl);
      if (!urlInfo.valid || !urlInfo.cleanUrl) {
        pendingItems.push({
          kind: "invalid_url",
          message: "服务地址无效、含未解析环境变量或受安全策略阻止，无法自动导入。",
        });
      } else {
        const parsedClean = new URL(urlInfo.cleanUrl);
        if (parsedClean.protocol === "http:" && !isLoopbackHost(parsedClean.hostname)) {
          pendingItems.push({
            kind: "private_or_http_url",
            message: "非环回明文 HTTP 地址受安全策略限制，需改用 HTTPS 或在受信任模式手动添加。",
          });
          importable = false;
        } else if (isNonPublicMcpUrl(urlInfo.cleanUrl)) {
          pendingItems.push({
            kind: "private_or_http_url",
            message: "本机/内网地址导入后将绑定到当前主机。",
          });
        }
      }

      const alreadyImported = Boolean(urlInfo.cleanUrl && existingHttp.has(urlInfo.cleanUrl));
      const hadSecretsStripped =
        headersInfo.hadSecrets || envInfo.hadSecrets || urlInfo.hadUserinfo || urlInfo.hadQuery || argSanitized.hadSecretsStripped;
      const safeName = sanitizeDisplayText(entry.serverKey, seenSecrets, options.redact, 120) || "http-mcp";
      const candidate: MigrationMcpCandidate = {
        candidateId,
        source: spec.source,
        sourceLabel: spec.sourceLabel,
        sourcePath: displayPath,
        name: safeName,
        transport: "http",
        ...(urlInfo.hostSummary ? { hostSummary: urlInfo.hostSummary } : {}),
        inferredAuthMode,
        ...(inferredAuthMode === "header" && headersInfo.primaryHeaderName ? { headerName: headersInfo.primaryHeaderName } : {}),
        disabledInSource,
        importable,
        alreadyImported,
        hadSecretsStripped,
        ...(rawDesc ? { descriptionSummary: sanitizeDisplayText(rawDesc, seenSecrets, options.redact, 160) } : {}),
        pendingItems,
        riskFlags: hadSecretsStripped ? ["inline_secret_stripped"] : [],
      };
      httpMcpCandidates.push(candidate);
      internalById.set(candidateId, {
        kind: "http_mcp",
        candidate,
        absPath: read.absPath,
        fileSha256: read.sha256,
        serverKey: entry.serverKey,
        jsonScope: entry.jsonScope,
        ...(entry.projectKey ? { projectKey: entry.projectKey } : {}),
        ...(urlInfo.cleanUrl ? { cleanUrl: urlInfo.cleanUrl } : {}),
        ...(matchedPresetId ? { matchedPresetId } : {}),
        disabledInSource,
      });
      candidateHashes.set(candidateId, read.sha256);
    }
  }

  for (const rootSpec of SKILL_ROOTS) {
    let current = homeDir;
    let validRoot = true;
    for (const seg of rootSpec.relSegments) {
      current = path.join(current, seg);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(current);
      } catch {
        validRoot = false;
        break;
      }
      if (st.isSymbolicLink()) {
        manualNotices.push({
          source: rootSpec.source,
          sourceLabel: rootSpec.sourceLabel,
          sourcePath: `~/${rootSpec.relSegments.join("/")}`,
          code: "symlink_rejected",
          message: "检测到符号链接技能目录，已跳过。",
        });
        validRoot = false;
        break;
      }
      if (!st.isDirectory()) {
        validRoot = false;
        break;
      }
    }
    if (!validRoot) continue;

    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }

    for (const child of children) {
      if (child.name.startsWith(".") || SKILL_IGNORED.has(child.name) || UNSAFE_PATH_SEGMENTS.has(child.name)) continue;
      const absSkillDir = path.join(current, child.name);
      const sourcePath = displayHomePath(homeDir, absSkillDir);
      const candidateId = opaqueId("mig-skill");
      let st: fs.Stats;
      try {
        st = fs.lstatSync(absSkillDir);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        const safeDirName = sanitizeDisplayText(child.name, seenSecrets, options.redact, 64) || "skill";
        skillCandidates.push({
          candidateId,
          source: rootSpec.source,
          sourceLabel: rootSpec.sourceLabel,
          sourcePath,
          sourceDevice: "local",
          originalName: safeDirName,
          normalizedName: safeDirName,
          nameNormalized: false,
          descriptionSummary: "",
          sha256: "",
          fileCount: 0,
          totalBytes: 0,
          skippedDotfiles: [],
          conflictWithManaged: false,
          importable: false,
          blockedReason: "符号链接目录已拒绝导入。",
        });
        continue;
      }
      if (!st.isDirectory()) continue;

      const inspected = inspectSkillDirectorySafe(homeDir, absSkillDir, seenSecrets, options.redact);
      if (!inspected.ok) {
        const safeDirName = sanitizeDisplayText(child.name, seenSecrets, options.redact, 64) || "skill";
        skillCandidates.push({
          candidateId,
          source: rootSpec.source,
          sourceLabel: rootSpec.sourceLabel,
          sourcePath,
          sourceDevice: "local",
          originalName: safeDirName,
          normalizedName: safeDirName,
          nameNormalized: false,
          descriptionSummary: "",
          sha256: "",
          fileCount: 0,
          totalBytes: 0,
          skippedDotfiles: [],
          conflictWithManaged: false,
          importable: false,
          blockedReason: sanitizeDisplayText(inspected.reason, seenSecrets, options.redact, 160),
        });
        continue;
      }

      const snap = inspected.snapshot;
      const existingManaged = existingSkillsByName.get(snap.normalizedName);
      const conflictWithManaged = Boolean(existingManaged);
      const candidate: MigrationSkillCandidate = {
        candidateId,
        source: rootSpec.source,
        sourceLabel: rootSpec.sourceLabel,
        sourcePath,
        sourceDevice: "local",
        originalName: snap.originalName,
        normalizedName: snap.normalizedName,
        nameNormalized: snap.nameNormalized,
        descriptionSummary: snap.description,
        sha256: snap.sha256,
        fileCount: snap.fileCount,
        totalBytes: snap.totalBytes,
        skippedDotfiles: snap.skippedDotfiles,
        conflictWithManaged,
        ...(existingManaged ? { existingSkillId: existingManaged.id } : {}),
        importable: !conflictWithManaged,
        ...(conflictWithManaged ? { blockedReason: "已存在同名 Kulo 托管技能，将保留现有托管版本。" } : {}),
      };
      skillCandidates.push(candidate);
      internalById.set(candidateId, {
        kind: "skill",
        candidate,
        absDirPath: absSkillDir,
        dirSha256: snap.sha256,
      });
      candidateHashes.set(candidateId, snap.sha256);
    }
  }

  const scrubCandidate = (c: MigrationMcpCandidate): MigrationMcpCandidate => ({
    ...c,
    name: sanitizeDisplayText(c.name, seenSecrets, options.redact, 120) || "mcp-server",
    ...(c.descriptionSummary
      ? { descriptionSummary: sanitizeDisplayText(c.descriptionSummary, seenSecrets, options.redact, 160) }
      : {}),
    pendingItems: c.pendingItems.map((item) => ({
      ...item,
      message: sanitizeDisplayText(item.message, seenSecrets, options.redact, 200),
      ...(item.detail ? { detail: sanitizeDisplayText(item.detail, seenSecrets, options.redact, 160) } : {}),
    })),
  });
  const scrubbedHttp = httpMcpCandidates.map(scrubCandidate);
  const scrubbedStdio = stdioMcpCandidates.map(scrubCandidate);
  const scrubbedSkills = skillCandidates.map((s) => ({
    ...s,
    descriptionSummary: sanitizeDisplayText(s.descriptionSummary, seenSecrets, options.redact, 240),
    ...(s.blockedReason ? { blockedReason: sanitizeDisplayText(s.blockedReason, seenSecrets, options.redact, 160) } : {}),
  }));
  const scrubbedNotices = manualNotices.map((n) => ({
    ...n,
    message: sanitizeDisplayText(n.message, seenSecrets, options.redact, 200),
  }));

  for (const c of [...scrubbedHttp, ...scrubbedStdio]) {
    const rec = internalById.get(c.candidateId);
    if (rec && (rec.kind === "http_mcp" || rec.kind === "stdio_mcp")) rec.candidate = c;
  }
  for (const s of scrubbedSkills) {
    const rec = internalById.get(s.candidateId);
    if (rec && rec.kind === "skill") rec.candidate = s;
  }

  return {
    httpMcpCandidates: scrubbedHttp,
    stdioMcpCandidates: scrubbedStdio,
    skillCandidates: scrubbedSkills,
    manualNotices: scrubbedNotices,
    internalById,
    candidateHashes,
    seenSecrets,
  };
}

export function httpMcpUrlBinding(cleanUrl: string): string {
  return binding({ name: "tmp", kind: "mcp", mcpTransport: "http", url: cleanUrl, mcpAuthMode: "none" });
}
