import fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { isClusterHubEndpoint, type ClusterHubEndpoint, type ClusterRole } from "@kulo/protocol";

export const CLUSTER_AUTH_HEADER = "x-kulo-cluster-auth" as const;

const NODE_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const NONCE_RE = /^[a-f0-9]{32,64}$/;

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface NodeIdentityFile {
  version: 1;
  nodeId: string;
  createdAt: number;
}

export interface ClusterMembershipSelfTokens {
  envToken: string;
  clientToken: string;
  syncToken: string;
}

export interface ClusterMembership {
  version: 1;
  hubId: string;
  nodeId: string;
  myRole: ClusterRole;
  epoch: number;
  primaryNodeId: string;
  preferredPrimaryNodeId: string;
  selfTokens?: ClusterMembershipSelfTokens;
  hubs: ClusterHubEndpoint[];
  updatedAt: number;
}

export interface ClusterNodeKeyMaterial {
  version: 1;
  x25519PublicKey: string;
  x25519PrivateDerB64: string;
  ed25519PublicKey: string;
  ed25519PrivateDerB64: string;
}

export interface ClusterEncryptedEnvelopeHeader {
  version: 1;
  hubId: string;
  epoch: number;
  generation: number;
  senderNodeId: string;
  targetNodeId: string;
  requestNonce: string;
  resourceId: string;
  ephemeralPublicKey: string;
  iv: string;
  tag: string;
  signature: string;
}

export interface ClusterEncryptedEnvelope {
  header: ClusterEncryptedEnvelopeHeader;
  ciphertext: string;
}

export interface ParsedClusterAuthHeader {
  nodeId: string;
  timestampMs: number;
  nonce: string;
  hmacHex: string;
}

export function isLoopbackSocket(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function writePrivateJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error("集群配置目录不可用。");
  }
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error("集群配置文件不能是符号链接。");
  }
  const temporary = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readPrivateJson(filePath: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("集群配置文件必须是普通文件。");
  if (process.platform !== "win32" && (stat.mode & 0o077)) throw new Error("集群配置文件权限必须为 0600。");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function generateClusterNodeId(): string {
  return `device-${randomBytes(8).toString("hex")}`;
}

export function readNodeIdentity(filePath: string): string | undefined {
  const raw = readPrivateJson(filePath);
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("节点身份文件无效。");
  const data = raw as Record<string, unknown>;
  if (data.version !== 1 || typeof data.nodeId !== "string" || !NODE_ID_RE.test(data.nodeId) || data.nodeId === "local") {
    throw new Error("节点身份文件无效。");
  }
  return data.nodeId;
}

export function readOrCreateNodeIdentity(filePath: string, fallbackNodeId?: string): string {
  const existing = readNodeIdentity(filePath);
  if (existing) return existing;
  const candidate = fallbackNodeId && NODE_ID_RE.test(fallbackNodeId) && fallbackNodeId !== "local"
    ? fallbackNodeId
    : generateClusterNodeId();
  const payload: NodeIdentityFile = { version: 1, nodeId: candidate, createdAt: Date.now() };
  writePrivateJsonAtomic(filePath, payload);
  return candidate;
}

export function validateClusterMembership(value: unknown): ClusterMembership {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("集群成员配置无效。");
  const data = value as Record<string, unknown>;
  if (
    data.version !== 1 ||
    typeof data.hubId !== "string" || !NODE_ID_RE.test(data.hubId) ||
    typeof data.nodeId !== "string" || !NODE_ID_RE.test(data.nodeId) || data.nodeId === "local" ||
    (data.myRole !== "primary" && data.myRole !== "standby" && data.myRole !== "peer") ||
    typeof data.epoch !== "number" || !Number.isSafeInteger(data.epoch) || data.epoch < 1 ||
    typeof data.primaryNodeId !== "string" || !NODE_ID_RE.test(data.primaryNodeId) ||
    typeof data.preferredPrimaryNodeId !== "string" || !NODE_ID_RE.test(data.preferredPrimaryNodeId) ||
    typeof data.updatedAt !== "number" || !Number.isSafeInteger(data.updatedAt) || data.updatedAt < 0 ||
    !Array.isArray(data.hubs) || data.hubs.length > 32 || !data.hubs.every(isClusterHubEndpoint)
  ) {
    throw new Error("集群成员配置无效。");
  }
  let selfTokens: ClusterMembershipSelfTokens | undefined;
  if (data.selfTokens !== undefined) {
    if (!data.selfTokens || typeof data.selfTokens !== "object" || Array.isArray(data.selfTokens)) {
      throw new Error("集群成员凭证无效。");
    }
    const tokens = data.selfTokens as Record<string, unknown>;
    if (
      typeof tokens.envToken !== "string" || !tokens.envToken || /\s/.test(tokens.envToken) ||
      typeof tokens.clientToken !== "string" || !tokens.clientToken || /\s/.test(tokens.clientToken) ||
      typeof tokens.syncToken !== "string" || !tokens.syncToken || /\s/.test(tokens.syncToken) ||
      tokens.envToken === tokens.clientToken
    ) {
      throw new Error("集群成员凭证无效。");
    }
    selfTokens = { envToken: tokens.envToken, clientToken: tokens.clientToken, syncToken: tokens.syncToken };
  }
  return {
    version: 1,
    hubId: data.hubId,
    nodeId: data.nodeId,
    myRole: data.myRole,
    epoch: data.epoch,
    primaryNodeId: data.primaryNodeId,
    preferredPrimaryNodeId: data.preferredPrimaryNodeId,
    ...(selfTokens ? { selfTokens } : {}),
    hubs: data.hubs,
    updatedAt: data.updatedAt,
  };
}

export function readClusterMembership(filePath: string): ClusterMembership | null {
  const raw = readPrivateJson(filePath);
  return raw === undefined ? null : validateClusterMembership(raw);
}

export function saveClusterMembership(filePath: string, membership: ClusterMembership): void {
  writePrivateJsonAtomic(filePath, validateClusterMembership(membership));
}

export function removeClusterMembership(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function generateClusterNodeKeyMaterial(): ClusterNodeKeyMaterial {
  const x25519 = generateKeyPairSync("x25519");
  const ed25519 = generateKeyPairSync("ed25519");
  const xPubDer = x25519.publicKey.export({ format: "der", type: "spki" });
  const edPubDer = ed25519.publicKey.export({ format: "der", type: "spki" });
  const xPrivDer = x25519.privateKey.export({ format: "der", type: "pkcs8" });
  const edPrivDer = ed25519.privateKey.export({ format: "der", type: "pkcs8" });
  return {
    version: 1,
    x25519PublicKey: xPubDer.subarray(X25519_SPKI_PREFIX.length).toString("base64url"),
    x25519PrivateDerB64: xPrivDer.toString("base64"),
    ed25519PublicKey: edPubDer.subarray(ED25519_SPKI_PREFIX.length).toString("base64url"),
    ed25519PrivateDerB64: edPrivDer.toString("base64"),
  };
}

export function importRawX25519PublicKey(rawBase64Url: string): KeyObject {
  const raw = Buffer.from(rawBase64Url, "base64url");
  if (raw.length !== 32) throw new Error("无效的 X25519 公钥。");
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function importRawEd25519PublicKey(rawBase64Url: string): KeyObject {
  const raw = Buffer.from(rawBase64Url, "base64url");
  if (raw.length !== 32) throw new Error("无效的 Ed25519 公钥。");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function encryptKeyMaterialWithKek(material: ClusterNodeKeyMaterial, kek32: Buffer, aadContext: string): string {
  if (kek32.length !== 32) throw new Error("主封装密钥长度无效。");
  const iv = randomBytes(12);
  const aad = Buffer.from(`kulo-cluster-key-v1\0${aadContext}`, "utf8");
  const plaintext = Buffer.from(JSON.stringify(material), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", kek32, iv);
    cipher.setAAD(aad);
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  } finally {
    plaintext.fill(0);
  }
}

export function decryptKeyMaterialWithKek(serialized: string, kek32: Buffer, aadContext: string): ClusterNodeKeyMaterial {
  if (kek32.length !== 32) throw new Error("主封装密钥长度无效。");
  const parsed = JSON.parse(serialized) as { version?: number; iv?: string; tag?: string; data?: string };
  if (parsed?.version !== 1 || typeof parsed.iv !== "string" || typeof parsed.tag !== "string" || typeof parsed.data !== "string") {
    throw new Error("节点密钥封装格式无效。");
  }
  const aad = Buffer.from(`kulo-cluster-key-v1\0${aadContext}`, "utf8");
  const decipher = createDecipheriv("aes-256-gcm", kek32, Buffer.from(parsed.iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]);
  try {
    const material = JSON.parse(plaintext.toString("utf8")) as ClusterNodeKeyMaterial;
    if (
      material?.version !== 1 ||
      typeof material.x25519PublicKey !== "string" ||
      typeof material.x25519PrivateDerB64 !== "string" ||
      typeof material.ed25519PublicKey !== "string" ||
      typeof material.ed25519PrivateDerB64 !== "string"
    ) {
      throw new Error("节点密钥内容损坏。");
    }
    return material;
  } finally {
    plaintext.fill(0);
  }
}

export function computeClusterAuthHmac(input: {
  secret: string;
  nodeId: string;
  method: string;
  pathWithQuery: string;
  timestampMs: number;
  nonce: string;
  body?: Buffer | string;
}): string {
  const bodySha = createHash("sha256")
    .update(input.body ? (Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, "utf8")) : Buffer.alloc(0))
    .digest("hex");
  const payload = [
    "kulo-cluster-auth-v1",
    input.nodeId,
    input.method.toUpperCase(),
    input.pathWithQuery,
    String(input.timestampMs),
    input.nonce,
    bodySha,
  ].join("\n");
  return createHmac("sha256", input.secret).update(payload).digest("hex");
}

export function createClusterAuthHeader(input: {
  secret: string;
  nodeId: string;
  method: string;
  pathWithQuery: string;
  body?: Buffer | string;
  timestampMs?: number;
  nonce?: string;
}): { header: string; nonce: string; timestampMs: number } {
  const timestampMs = input.timestampMs ?? Date.now();
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const hmacHex = computeClusterAuthHmac({ ...input, timestampMs, nonce });
  return {
    header: `v1:${input.nodeId}:${timestampMs}:${nonce}:${hmacHex}`,
    nonce,
    timestampMs,
  };
}

export function parseClusterAuthHeader(raw: string | undefined): ParsedClusterAuthHeader | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const parts = raw.trim().split(":");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const [, nodeId, rawTs, nonce, hmacHex] = parts;
  if (!nodeId || !NODE_ID_RE.test(nodeId) || !rawTs || !/^\d{10,16}$/.test(rawTs) || !nonce || !NONCE_RE.test(nonce) || !hmacHex || !HEX64_RE.test(hmacHex)) {
    return null;
  }
  const timestampMs = Number(rawTs);
  if (!Number.isSafeInteger(timestampMs)) return null;
  return { nodeId, timestampMs, nonce, hmacHex };
}

export class ClusterNonceGuard {
  readonly #seen = new Map<string, number>();
  readonly #windowMs: number;
  readonly #maxEntries: number;

  constructor(windowMs = 60_000, maxEntries = 10_000) {
    this.#windowMs = windowMs;
    this.#maxEntries = maxEntries;
  }

  verifyAndConsume(input: {
    headerValue: string | undefined;
    method: string;
    pathWithQuery: string;
    body?: Buffer | string;
    resolveSecret: (nodeId: string) => string | undefined;
    now?: number;
  }): { ok: true; nodeId: string; nonce: string } | { ok: false; reason: string } {
    const parsed = parseClusterAuthHeader(input.headerValue);
    if (!parsed) return { ok: false, reason: "invalid_auth_header" };
    const now = input.now ?? Date.now();
    if (Math.abs(now - parsed.timestampMs) > this.#windowMs) {
      return { ok: false, reason: "timestamp_out_of_window" };
    }
    const secret = input.resolveSecret(parsed.nodeId);
    if (!secret) return { ok: false, reason: "unknown_node" };
    const expected = computeClusterAuthHmac({
      secret,
      nodeId: parsed.nodeId,
      method: input.method,
      pathWithQuery: input.pathWithQuery,
      timestampMs: parsed.timestampMs,
      nonce: parsed.nonce,
      body: input.body,
    });
    const actualBuf = Buffer.from(parsed.hmacHex, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
      return { ok: false, reason: "invalid_hmac" };
    }
    const ttl = this.#windowMs * 2;
    for (const [key, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(key);
    }
    const nonceKey = `${parsed.nodeId}:${parsed.nonce}`;
    if (this.#seen.has(nonceKey)) return { ok: false, reason: "replayed_nonce" };
    if (this.#seen.size >= this.#maxEntries) {
      const oldest = this.#seen.keys().next().value;
      if (oldest) this.#seen.delete(oldest);
    }
    this.#seen.set(nonceKey, now + ttl);
    return { ok: true, nodeId: parsed.nodeId, nonce: parsed.nonce };
  }
}

function buildEnvelopeAad(fields: {
  version: 1;
  hubId: string;
  epoch: number;
  generation: number;
  senderNodeId: string;
  targetNodeId: string;
  requestNonce: string;
  resourceId: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify([
      fields.version,
      fields.hubId,
      fields.epoch,
      fields.generation,
      fields.senderNodeId,
      fields.targetNodeId,
      fields.requestNonce,
      fields.resourceId,
    ]),
    "utf8",
  );
}

export function encryptClusterEnvelope(input: {
  plaintext: Buffer;
  hubId: string;
  epoch: number;
  generation: number;
  senderNodeId: string;
  targetNodeId: string;
  requestNonce: string;
  resourceId: string;
  recipientX25519PublicKey: string;
  senderEd25519PrivateDerB64: string;
}): ClusterEncryptedEnvelope {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPubDer = ephemeral.publicKey.export({ format: "der", type: "spki" });
  const ephemeralPubRaw = ephemeralPubDer.subarray(X25519_SPKI_PREFIX.length);
  const recipientPub = importRawX25519PublicKey(input.recipientX25519PublicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPub });
  const info = Buffer.from(
    `kulo-sync-e2e-v1|${input.hubId}|${input.epoch}|${input.senderNodeId}|${input.targetNodeId}|${input.resourceId}`,
    "utf8",
  );
  const aesKey = Buffer.from(hkdfSync("sha256", shared, Buffer.from(input.requestNonce, "utf8"), info, 32));
  const iv = randomBytes(12);
  const aad = buildEnvelopeAad({
    version: 1,
    hubId: input.hubId,
    epoch: input.epoch,
    generation: input.generation,
    senderNodeId: input.senderNodeId,
    targetNodeId: input.targetNodeId,
    requestNonce: input.requestNonce,
    resourceId: input.resourceId,
  });
  let ciphertext: Buffer;
  let tag: Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
  } finally {
    shared.fill(0);
    aesKey.fill(0);
  }
  const cipherSha = createHash("sha256").update(ciphertext).digest();
  const signPayload = Buffer.concat([aad, ephemeralPubRaw, iv, tag, cipherSha]);
  const senderKey = createPrivateKey({
    key: Buffer.from(input.senderEd25519PrivateDerB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = cryptoSign(null, signPayload, senderKey);
  return {
    header: {
      version: 1,
      hubId: input.hubId,
      epoch: input.epoch,
      generation: input.generation,
      senderNodeId: input.senderNodeId,
      targetNodeId: input.targetNodeId,
      requestNonce: input.requestNonce,
      resourceId: input.resourceId,
      ephemeralPublicKey: ephemeralPubRaw.toString("base64url"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      signature: signature.toString("base64url"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
}

export function verifyAndDecryptClusterEnvelope(input: {
  envelope: ClusterEncryptedEnvelope;
  expectedHubId: string;
  expectedMinEpoch: number;
  expectedTargetNodeId: string;
  expectedRequestNonce?: string;
  expectedResourceId?: string;
  expectedSenderIdentityPublicKey: string;
  recipientX25519PrivateDerB64: string;
}): Buffer {
  const { header, ciphertext } = input.envelope;
  if (
    !header ||
    header.version !== 1 ||
    header.hubId !== input.expectedHubId ||
    header.epoch < input.expectedMinEpoch ||
    header.targetNodeId !== input.expectedTargetNodeId ||
    (input.expectedRequestNonce !== undefined && header.requestNonce !== input.expectedRequestNonce) ||
    (input.expectedResourceId !== undefined && header.resourceId !== input.expectedResourceId)
  ) {
    throw new Error("同步加密信封头校验失败。");
  }
  const ephemeralPubRaw = Buffer.from(header.ephemeralPublicKey, "base64url");
  if (ephemeralPubRaw.length !== 32) throw new Error("同步信封临时公钥无效。");
  const iv = Buffer.from(header.iv, "base64");
  const tag = Buffer.from(header.tag, "base64");
  const ciphertextBuf = Buffer.from(ciphertext, "base64");
  const signatureBuf = Buffer.from(header.signature, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("同步信封加密参数无效。");

  const aad = buildEnvelopeAad(header);
  const cipherSha = createHash("sha256").update(ciphertextBuf).digest();
  const signPayload = Buffer.concat([aad, ephemeralPubRaw, iv, tag, cipherSha]);
  const senderVerifyKey = importRawEd25519PublicKey(input.expectedSenderIdentityPublicKey);
  if (!cryptoVerify(null, signPayload, senderVerifyKey, signatureBuf)) {
    throw new Error("同步信封发送方签名验证失败。");
  }

  const recipientPriv = createPrivateKey({
    key: Buffer.from(input.recipientX25519PrivateDerB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const ephemeralPub = importRawX25519PublicKey(header.ephemeralPublicKey);
  const shared = diffieHellman({ privateKey: recipientPriv, publicKey: ephemeralPub });
  const info = Buffer.from(
    `kulo-sync-e2e-v1|${header.hubId}|${header.epoch}|${header.senderNodeId}|${header.targetNodeId}|${header.resourceId}`,
    "utf8",
  );
  const aesKey = Buffer.from(hkdfSync("sha256", shared, Buffer.from(header.requestNonce, "utf8"), info, 32));
  try {
    const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]);
  } finally {
    shared.fill(0);
    aesKey.fill(0);
  }
}

export function isRfc1918Host(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "");
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(clean);
}

/**
 * Happy Eyeballs concurrent URL probe: launches LAN candidates first, then starts
 * Tailscale/other candidates after `staggerMs` (default 150ms) if none succeeded yet.
 * Cancels remaining in-flight probes as soon as the first URL succeeds.
 */
export async function probeUrlsHappyEyeballs<T>(
  urls: readonly string[],
  probe: (url: string, signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; staggerMs?: number; signal?: AbortSignal } = {},
): Promise<{ url: string; value: T }> {
  const unique = [...new Set(urls.filter(Boolean))];
  if (!unique.length) throw new Error("没有可探测的主机地址。");
  const timeoutMs = options.timeoutMs ?? 3_000;
  const staggerMs = options.staggerMs ?? 150;
  const lan: string[] = [];
  const rest: string[] = [];
  for (const raw of unique) {
    try {
      const host = new URL(raw).hostname;
      if (isRfc1918Host(host)) lan.push(raw);
      else rest.push(raw);
    } catch {
      rest.push(raw);
    }
  }
  const firstWave = lan.length > 0 ? lan : rest;
  const secondWave = lan.length > 0 ? rest : [];

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  deadline.unref();

  let settled = false;
  let remaining = unique.length;
  let lastError: unknown = new Error("所有候选主机地址均不可达。");

  return new Promise<{ url: string; value: T }>((resolve, reject) => {
    let staggerTimer: NodeJS.Timeout | undefined;
    const finishSuccess = (url: string, value: T) => {
      if (settled) return;
      settled = true;
      if (staggerTimer) clearTimeout(staggerTimer);
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onParentAbort);
      controller.abort();
      resolve({ url, value });
    };
    const finishFailure = (error: unknown) => {
      lastError = error;
      remaining -= 1;
      if (!settled && remaining <= 0) {
        settled = true;
        if (staggerTimer) clearTimeout(staggerTimer);
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", onParentAbort);
        reject(lastError);
      }
    };
    const launch = (url: string) => {
      if (settled) return;
      void probe(url, controller.signal).then(
        (value) => finishSuccess(url, value),
        (error) => finishFailure(error),
      );
    };
    for (const url of firstWave) launch(url);
    if (secondWave.length > 0) {
      staggerTimer = setTimeout(() => {
        staggerTimer = undefined;
        for (const url of secondWave) launch(url);
      }, staggerMs);
      staggerTimer.unref();
    }
  });
}
