import fs from "node:fs";
import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { isIP, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const CHALLENGE = "x-kulo-instance-challenge";
const REQUEST = "x-kulo-instance-request";
const STATUS = "x-kulo-instance-status";
const INSTANCE = "x-kulo-instance-proof";
const CREDENTIAL = "x-kulo-credential-proof";

export interface LocalInstanceFiles { directory: string; name: string; identity?: string }
export interface LocalInstanceStatus { pid: number; role?: "hub" | "joined"; hubUrl?: string; ready?: boolean; error?: string }
type Endpoint = { address: string; port: number; key: string };

export function localListenerOrigin(bound: Pick<AddressInfo, "address" | "port">): string {
  const host = bound.address === "0.0.0.0" ? "127.0.0.1" : bound.address === "::" ? "::1" : bound.address;
  return "http://" + (isIP(host) === 6 ? "[" + host + "]" : host) + ":" + bound.port;
}

export class LocalInstanceInUseError extends Error {
  constructor(readonly directory: string, message: string) { super(message); }
}

function lockPath(files: LocalInstanceFiles): string { return path.join(files.directory, files.name + "-owner.sqlite"); }
function endpointPath(files: LocalInstanceFiles): string { return path.join(files.directory, files.name + "-endpoint.json"); }

/** Authoritative filenames owned by a `LocalInstanceOwner` lease (preserved across cluster promotion). */
export function localInstanceLockFiles(name: string): readonly string[] {
  return [
    `${name}-owner.sqlite`,
    `${name}-owner.sqlite-wal`,
    `${name}-owner.sqlite-shm`,
    `${name}-endpoint.json`,
  ];
}

export const KULO_RUNTIME_INSTANCE_FILES: readonly string[] = localInstanceLockFiles("kulo-runtime");
export const HUB_STATE_LOCK_FILES: readonly string[] = localInstanceLockFiles("hub");

function lockDirectory(files: LocalInstanceFiles): DatabaseSync | undefined {
  const filename = lockPath(files);
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error("Kulo 数据目录中的运行锁文件无效。");
  const database = new DatabaseSync(filename);
  try {
    // This database is dedicated to ownership. SQLite and the OS release its writer on process exit.
    database.exec("BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    database.close();
    if ((error as { errcode?: number }).errcode === 5) return undefined; // SQLITE_BUSY
    throw error;
  }
}

function proof(key: string, parts: readonly unknown[]): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update(JSON.stringify(parts)).digest("hex");
}

function localAddress(address: string): boolean {
  return Boolean(isIP(address)) && (address.startsWith("127.") || address === "::1" ||
    Object.values(os.networkInterfaces()).some((addresses) => addresses?.some((item) => item.address === address)));
}

export class LocalInstanceOwner {
  readonly #key = randomBytes(32).toString("hex");
  readonly #listeners = new Set<AddressInfo>();
  #closed = false;

  private constructor(private readonly files: LocalInstanceFiles, private readonly database: DatabaseSync) {}

  static acquire(location: LocalInstanceFiles, busyMessage: string): LocalInstanceOwner {
    fs.mkdirSync(location.directory, { recursive: true, mode: 0o700 });
    const files = { ...location, directory: fs.realpathSync(location.directory) };
    const database = lockDirectory(files);
    if (!database) throw new LocalInstanceInUseError(files.directory, busyMessage);
    try {
      fs.rmSync(endpointPath(files), { force: true });
      return new LocalInstanceOwner(files, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  publish(address: AddressInfo): () => void {
    if (this.#closed) throw new Error("Kulo 已关闭。");
    this.#listeners.add(address);
    try { this.#publishCurrent(); }
    catch (error) { this.#listeners.delete(address); throw error; }
    return () => {
      if (this.#listeners.delete(address) && !this.#closed) this.#publishCurrent();
    };
  }

  #publishCurrent(): void {
    const marker = endpointPath(this.files);
    const bound = [...this.#listeners].at(-1);
    if (!bound) { fs.rmSync(marker, { force: true }); return; }
    const temporary = marker + "." + randomBytes(8).toString("hex");
    try {
      fs.writeFileSync(temporary, JSON.stringify({ address: bound.address, port: bound.port, key: this.#key }), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, marker);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  proveLocalIdentity(req: http.IncomingMessage, res: http.ServerResponse, token?: string, status?: Omit<LocalInstanceStatus, "pid">): boolean {
    const challenge = req.headers[CHALLENGE];
    const remote = req.socket.remoteAddress;
    const port = req.socket.localPort;
    if (this.#closed || typeof challenge !== "string" || !/^[a-f0-9]{64}$/.test(challenge) ||
        !remote || !(remote === req.socket.localAddress || remote === "::ffff:127.0.0.1" || localAddress(remote))) return false;
    const request = [challenge, port, this.files.identity ?? null];
    if (req.headers[REQUEST] !== proof(this.#key, ["request", ...request])) return false;
    const details = Buffer.from(JSON.stringify({ ...status, pid: process.pid })).toString("base64url");
    res.setHeader(STATUS, details);
    res.setHeader(INSTANCE, proof(this.#key, ["instance", ...request, details]));
    res.setHeader(CREDENTIAL, proof(this.#key, ["credential", ...request, token ?? null]));
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    try { fs.rmSync(endpointPath(this.files), { force: true }); }
    finally { this.database.close(); }
  }
}

function readEndpoint(files: LocalInstanceFiles): Endpoint | undefined {
  const invalid = () => new Error("无法核对本机 Kulo 的运行地址。");
  const filename = endpointPath(files);
  let fd: number;
  try { fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let item: Partial<Endpoint> | null;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw invalid();
    try { item = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<Endpoint> | null; }
    catch (error) { if (error instanceof SyntaxError) throw invalid(); throw error; }
  } finally { fs.closeSync(fd); }
  if (!item || typeof item.key !== "string" || !/^[a-f0-9]{64}$/.test(item.key) || typeof item.port !== "number" ||
      !Number.isInteger(item.port) || item.port < 1 || item.port > 65535 || typeof item.address !== "string" ||
      !(item.address === "0.0.0.0" || item.address === "::" || localAddress(item.address))) {
    throw invalid();
  }
  return item as Endpoint;
}

async function probe(endpoint: Endpoint, files: LocalInstanceFiles, route: string, token?: string): Promise<{ url: URL; status: LocalInstanceStatus } | undefined> {
  const url = new URL(localListenerOrigin(endpoint));
  const challenge = randomBytes(32).toString("hex");
  const identity = [challenge, endpoint.port, files.identity ?? null];
  // Connect directly without proxies, redirects or credentials. Both directions prove knowledge of the private marker.
  const headers = await new Promise<http.IncomingHttpHeaders | undefined>((resolve, reject) => {
    const request = http.get(new URL(route, url), { agent: false, signal: AbortSignal.timeout(1000),
      headers: { [CHALLENGE]: challenge, [REQUEST]: proof(endpoint.key, ["request", ...identity]) } }, (response) => {
      resolve(response.statusCode === 200 ? response.headers : undefined);
      response.destroy();
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      if (["ECONNREFUSED", "ECONNRESET", "ABORT_ERR", "EHOSTUNREACH"].includes(error.code ?? "")) resolve(undefined);
      else reject(error);
    });
  });
  const details = headers?.[STATUS];
  if (!headers || typeof details !== "string" || headers[INSTANCE] !== proof(endpoint.key, ["instance", ...identity, details])) return;
  if (headers[CREDENTIAL] !== proof(endpoint.key, ["credential", ...identity, null])) {
    if (!token || headers[CREDENTIAL] !== proof(endpoint.key, ["credential", ...identity, token])) {
      throw new Error("这份 Kulo 已在运行，当前命令的管理密钥与运行实例不匹配。请从原启动环境打开。");
    }
    url.searchParams.set("token", token);
  }
  return { url, status: JSON.parse(Buffer.from(details, "base64url").toString("utf8")) as LocalInstanceStatus };
}

/** No owner (including an exit during startup) means the caller can start this instance. */
export async function discoverLocalInstance(files: LocalInstanceFiles, route: string, token?: string, timeoutMs = 90_000): Promise<{ url: URL; status: LocalInstanceStatus } | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!fs.lstatSync(lockPath(files), { throwIfNoEntry: false })) return;
    const available = lockDirectory(files);
    if (available) { available.close(); return; }
    const endpoint = readEndpoint(files);
    if (endpoint) {
      const result = await probe(endpoint, files, route, token);
      if (result) return result;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(150, remaining));
  } while (Date.now() < deadline);
  throw new Error("这份 Kulo 数据已在运行，但现有界面暂未就绪。");
}

/** This lease outlives both listeners when the application changes between Hub and joined device. */
export function claimKuloRuntime(directory: string): LocalInstanceOwner {
  return LocalInstanceOwner.acquire({ directory, name: "kulo-runtime" }, "这份 Kulo 数据已在运行。使用 open 可以打开已有的 Kulo。");
}

export function discoverKuloRuntime(directory: string, token?: string) {
  return discoverLocalInstance({ directory, name: "kulo-runtime" }, "/_kulo/instance", token);
}
