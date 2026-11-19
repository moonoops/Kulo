import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey } from "node:crypto";
import { RecoveryManager, readReleaseManifest, type RecoveryReleaseManifest } from "@moco/recovery";
import type { MocoHubConfig } from "./config.js";
import { MocoCustomizationService } from "./customization.js";
import { createLocalCustomizationRunner, type CustomizationSource } from "./customization-source.js";
import { proxyFetch } from "./http-transport.js";

interface HostMetadata {
  source?: { repositoryUrl: string; commit: string; version: string };
  keys: Record<string, string>;
  feedUrl?: string;
}

function readHostFile(root: string, filename: string, manifest: RecoveryReleaseManifest): unknown | undefined {
  const file = path.join(root, filename);
  let descriptor: number;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("受信桌面元信息不可用。");
    const bytes = fs.readFileSync(descriptor);
    const expected = manifest.files.find((entry) => entry.path === filename && entry.kind === "file");
    if (!expected || expected.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("桌面元信息与已验证制品不匹配。");
    return JSON.parse(bytes.toString("utf8"));
  } finally { fs.closeSync(descriptor); }
}

function readHostMetadata(root: string, manifest: RecoveryReleaseManifest): HostMetadata {
  const input = readHostFile(root, "moco-update-trust.json", manifest);
  if (input === undefined) return { keys: {} };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("更新信任配置格式无效。");
  const value = input as Record<string, unknown>;
  if (value.formatVersion !== 1) throw new Error("更新信任配置版本不受支持。");
  const rawKeys = value.keys ?? {};
  if (!rawKeys || typeof rawKeys !== "object" || Array.isArray(rawKeys) || Object.keys(rawKeys).length > 16) throw new Error("更新信任公钥配置无效。");
  const keys: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, pem] of Object.entries(rawKeys)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id) || typeof pem !== "string" || pem.length > 8192 || createPublicKey(pem).asymmetricKeyType !== "ed25519") throw new Error("更新信任公钥无效。");
    keys[id] = pem;
  }
  let source: HostMetadata["source"];
  let feedUrl: string | undefined;
  if (value.feedUrl !== undefined) {
    if (typeof value.feedUrl !== "string" || value.feedUrl.length > 2048) throw new Error("官方更新地址无效。");
    const url = new URL(value.feedUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("官方更新必须使用不含凭据的固定 HTTPS 地址。");
    feedUrl = url.href;
  }
  if (value.source !== undefined) {
    if (!value.source || typeof value.source !== "object" || Array.isArray(value.source)) throw new Error("官方源码配置无效。");
    const raw = value.source as Record<string, unknown>;
    if (typeof raw.repositoryUrl !== "string" || typeof raw.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(raw.commit) || typeof raw.version !== "string" || !raw.version.trim() || raw.version.length > 80) throw new Error("官方源码配置不完整。");
    const url = new URL(raw.repositoryUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname)) throw new Error("官方源码必须使用固定的公开 GitHub 仓库地址。");
    source = { repositoryUrl: url.href, commit: raw.commit, version: raw.version };
  }
  return { keys, ...(source ? { source } : {}), ...(feedUrl ? { feedUrl } : {}) };
}

function readSourceArchive(root: string, manifest: RecoveryReleaseManifest): CustomizationSource | undefined {
  const input = readHostFile(root, "moco-source.json", manifest);
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("源码归档元信息无效。");
  const value = input as Record<string, unknown>;
  const boundedInteger = (raw: unknown, maximum: number) => typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 && raw <= maximum;
  if (value.formatVersion !== 1 || value.archiveFile !== "moco-source.json.gz" || typeof value.archiveHash !== "string" || !/^[a-f0-9]{64}$/.test(value.archiveHash) ||
      typeof value.treeHash !== "string" || !/^[a-f0-9]{64}$/.test(value.treeHash) || value.version !== manifest.version ||
      value.commit !== undefined && (typeof value.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(value.commit)) ||
      manifest.sourceCommit !== undefined && value.commit !== manifest.sourceCommit ||
      manifest.sourceTreeHash !== undefined && value.treeHash !== manifest.sourceTreeHash ||
      !boundedInteger(value.compressedBytes, 16 * 1024 * 1024) || !boundedInteger(value.sourceBytes, 256 * 1024 * 1024) || !boundedInteger(value.fileCount, 20_000)) throw new Error("源码归档与当前版本不匹配。");
  const archivePath = path.join(root, value.archiveFile);
  const stat = fs.lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== value.compressedBytes) throw new Error("源码归档文件不可用。");
  return { archivePath, archiveHash: value.archiveHash, treeHash: value.treeHash, version: manifest.version,
    ...(typeof value.commit === "string" ? { commit: value.commit } : {}) };
}

/** Reads host-owned trust data only when a customization tool is actually used. */
export async function createDesktopCustomizationService(config: MocoHubConfig, redact: (text: string) => string): Promise<MocoCustomizationService> {
  const host = config.customization;
  if (!host) throw new Error("当前实例没有受管桌面运行环境。");
  for (const value of [host.dataDir, host.appRoot, host.nodePath, host.trustedRoot ?? host.appRoot, ...(host.sourceRoot ? [host.sourceRoot] : [])]) {
    if (!path.isAbsolute(value) || path.parse(value).root === path.resolve(value)) throw new Error("桌面定制路径无效。");
  }
  if (path.resolve(config.stateDir) !== path.join(path.resolve(host.dataDir), "hub")) throw new Error("定制环境与当前数据目录不匹配。");
  const trustedRoot = fs.realpathSync(host.trustedRoot ?? host.appRoot);
  const trustedManifest = await readReleaseManifest(trustedRoot);
  const metadata = readHostMetadata(trustedRoot, trustedManifest);
  const recovery = new RecoveryManager(host.dataDir, { shellVersion: host.shellVersion });
  const state = await recovery.inspect();
  const effective = state.pending ?? state.current;
  const basis = effective?.manifest.baseReleaseId ? state.releases.find((record) => record.id === effective.manifest.baseReleaseId) : effective;
  if (effective?.manifest.baseReleaseId && !basis) throw new Error("此定制的源码基线缺失，已保留当前运行版本，请先检查恢复资料。");
  const basisRoot = basis?.root ?? trustedRoot;
  const manifest = basisRoot === trustedRoot ? trustedManifest : await readReleaseManifest(basisRoot);
  const repository = metadata.source?.repositoryUrl;
  const selectedSource = host.sourceRoot
    ? { directory: fs.realpathSync(host.sourceRoot), version: manifest.version, ...(manifest.sourceCommit ? { commit: manifest.sourceCommit } : {}), ...(manifest.sourceTreeHash ? { treeHash: manifest.sourceTreeHash } : {}), ...(repository ? { repositoryUrl: repository } : {}) }
    : readSourceArchive(basisRoot, manifest) ?? (metadata.source && (manifest.sourceCommit || metadata.source.version === manifest.version)
      ? { ...metadata.source, version: manifest.version, commit: manifest.sourceCommit ?? metadata.source.commit, ...(manifest.sourceTreeHash ? { treeHash: manifest.sourceTreeHash } : {}) }
      : undefined);
  const source = selectedSource && repository ? { ...selectedSource, repositoryUrl: repository } : selectedSource;
  return new MocoCustomizationService({
    dataDir: host.dataDir,
    stateDir: config.stateDir,
    recovery,
    source,
    shellVersion: host.shellVersion,
    runner: createLocalCustomizationRunner({ nodePath: host.nodePath, dataDir: host.dataDir, trustedRoot }),
    trustedUpdateKeys: metadata.keys,
    updateFeedUrl: metadata.feedUrl,
    fetch: proxyFetch,
    updateInboxRoot: path.join(host.dataDir, "updates", "inbox"),
    redact,
  });
}
