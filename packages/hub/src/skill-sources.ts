import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as officialSkills from "skills";

export interface SkillSourceSpec {
  kind: "git" | "local";
  locator: string;
  input: string;
  ref?: string;
  subpath?: string;
  skill?: string;
}

export class SkillSourceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "SkillSourceError"; }
}

export interface InstallSkillSourceOptions {
  stagingDir: string;
  resolveLocalSource?: (source: string) => Promise<{ directory: string; dispose(): Promise<void> }>;
  validateDirectory?: (directory: string) => void | Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  localApi?: Pick<typeof officialSkills, "resolveSource" | "installSkills">;
}

const ignored = new Set([".git", "node_modules", ".DS_Store", ".gitignore", ".gitattributes", ".ignore", ".fdignore"]);
const sensitiveName = /^(?:credentials?(?:\.[^.]+)?|auth\.json|secrets?(?:\.[^.]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:key|p12|pfx))$/i;
const unsafeNames = new Set(["__proto__", "prototype", "constructor"]);
function invalid(message: string): never { throw new SkillSourceError(400, "invalid_skill", message); }

function sourcePath(value: string): string {
  if (!value || value.length > 1024 || value.includes("\\") || path.posix.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
    || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".") || unsafeNames.has(part))) invalid("Skill 来源路径无效。");
  return value;
}
function safeRef(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) || value.includes("..")) invalid("Git 版本引用无效。");
  return value;
}
function decodeSourceValue(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return invalid("Skill 来源参数编码无效。"); }
}

/** Kulo retains its existing locator format; parsing and discovery are performed by skills. */
export function parseSkillSource(input: string): SkillSourceSpec {
  if (typeof input !== "string" || !input.trim() || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) invalid("Skill 来源无效。");
  const value = input.trim();
  const raw = value.startsWith("git:") ? value.slice(4) : value;
  if (raw.startsWith("project://")) {
    const match = /^project:\/\/([^/?#]+)(\/[^?#]*)?$/.exec(raw);
    if (!match) invalid("项目 Skill 来源无效。");
    let relative: string;
    try { relative = decodeURIComponent((match[2] ?? "").replace(/^\//, "")); } catch { return invalid("项目 Skill 来源无效。"); }
    if (relative) {
      const standard = /^(?:\.agents|\.pi)\/skills\/(.+)$/.exec(relative);
      sourcePath(standard ? `skills/${standard[1]}` : relative);
    }
    const url = new URL(raw);
    if (!url.hostname || url.username || url.password || url.search || url.hash) invalid("项目 Skill 来源无效。");
    return { kind: "local", locator: url.toString(), input: url.toString() };
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith(".") || fs.existsSync(raw)
    || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[/@#].*)?$/.test(raw)) {
    const locator = path.resolve(raw);
    return { kind: "local", locator, input: locator };
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([^#]+))?(?:#([^@]+)?(?:@(.+))?)?$/.exec(raw);
    if (!match || unsafeNames.has(match[1]!) || unsafeNames.has(match[2]!)) invalid("Skill 仓库简称无效。");
    const selected = match[5] ?? match[3];
    const ref = match[4] ? safeRef(decodeSourceValue(match[4])) : undefined;
    const skill = selected ? sourcePath(decodeSourceValue(selected)) : undefined;
    return { kind: "git", locator: raw, input: raw, ...(ref ? { ref } : {}), ...(skill ? { skill } : {}) };
  }
  let url: URL;
  try { url = new URL(raw); } catch { return invalid("Skill 来源地址无效。"); }
  const rawPath = raw.split("#")[0]!.replace(/^https:\/\/[^/]+/i, "");
  if (raw.includes("\\") || /%(?:2e|2f|5c)/i.test(rawPath) || rawPath.split("/").some((part) => part === "." || part === "..")) invalid("Skill 来源路径无效。");
  if (url.protocol !== "https:" || url.username || url.password || url.search || /%(?:2e|2f|5c)/i.test(url.pathname)) invalid("Git Skill 来源需要不含凭证的 HTTPS 仓库地址。");
  if (url.pathname.split("/").some((part) => part === ".." || unsafeNames.has(part))) invalid("Skill 来源路径无效。");
  const fragment = url.hash.slice(1);
  let ref: string | undefined;
  let subpath: string | undefined;
  let skill: string | undefined;
  const legacy = fragment.startsWith("ref=") || fragment.startsWith("path=");
  if (legacy) {
    const params = new URLSearchParams(fragment);
    if ([...params.keys()].some((key) => key !== "ref" && key !== "path") || params.getAll("ref").length > 1 || params.getAll("path").length > 1) invalid("Skill 来源参数无效。");
    ref = params.get("ref") || undefined;
    subpath = params.get("path") || undefined;
  } else if (fragment) {
    const at = fragment.indexOf("@");
    try {
      ref = decodeURIComponent(at < 0 ? fragment : fragment.slice(0, at)) || undefined;
      skill = at < 0 ? undefined : decodeURIComponent(fragment.slice(at + 1));
    } catch { return invalid("Skill 来源参数无效。"); }
  }
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) invalid("Skill 仓库地址无效。");
    if (parts[2] === "tree" && parts.length >= 4) {
      ref ??= parts[3]; subpath ??= parts.slice(4).join("/") || undefined;
      url.pathname = `/${parts[0]}/${parts[1]}`;
    } else if (parts.length > 2) invalid("Skill 来源需要仓库地址或 tree 目录地址。");
  }
  if (ref) safeRef(ref);
  if (subpath) sourcePath(subpath);
  if (skill) sourcePath(skill);
  url.hash = "";
  const repository = url.toString().replace(/\/$/, "");
  const suffix = new URLSearchParams();
  if (ref) suffix.set("ref", ref);
  if (subpath) suffix.set("path", subpath);
  const locator = skill ? `${repository}#${ref ? encodeURIComponent(ref) : ""}@${encodeURIComponent(skill)}` : `${repository}${suffix.size ? `#${suffix}` : ""}`;
  return { kind: "git", locator, input: repository, ...(ref ? { ref } : {}), ...(subpath ? { subpath } : {}), ...(skill ? { skill } : {}) };
}

function verifyDirectory(directory: string): void {
  const root = fs.lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) invalid("Skill 来源需要是普通目录。");
  let files = 0; let bytes = 0; let entries = 0;
  const visit = (current: string, depth: number): void => {
    if (depth > 24) invalid("Skill 目录层级过深。");
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      if (++entries > 1024 || entry.name.startsWith(".") || sensitiveName.test(entry.name) || unsafeNames.has(entry.name)) invalid("Skill 资源不能包含隐藏、凭证或不安全文件。");
      const absolute = path.join(current, entry.name);
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) invalid("Skill 来源不能包含符号链接。");
      if (info.isDirectory()) visit(absolute, depth + 1);
      else if (!info.isFile()) invalid("Skill 不能包含特殊文件。");
      else if (++files > 512 || info.size > 4 * 1024 * 1024 || (bytes += info.size) > 16 * 1024 * 1024) throw new SkillSourceError(413, "skill_package_too_large", "Skill 超过文件数量或体积上限。");
    }
  };
  visit(directory, 0);
}

type StageResult = { directory: string; commit?: string };
type SourceApi = Pick<typeof officialSkills, "resolveSource" | "installSkills">;
interface StageModules { fs: typeof import("node:fs"); path: typeof import("node:path"); childProcess: Pick<typeof import("node:child_process"), "execFileSync"> }

// This function is self-contained so the remote path can run the same API workflow
// in an isolated process with its own Git environment and cancellation boundary.
async function installWithApi(api: SourceApi, spec: SkillSourceSpec, work: string, validate: (directory: string) => Promise<void>, modules: StageModules): Promise<StageResult> {
  const { fs, path, childProcess } = modules;
  const settings = { scope: "project" as const, mode: "copy" as const, lockfile: false, telemetry: false, duplicates: "error" as const, symlinks: "reject" as const };
  // Explicit local roots may bundle other SKILL.md files as guidance. Git must
  // use full discovery so the API clones it and returns its actual commit.
  const handle = await api.resolveSource(spec.input, { cwd: work, fullDepth: spec.kind === "git", includeInternal: true, ...(spec.ref ? { ref: spec.ref } : {}), config: settings });
  try {
    const selectedPath = spec.subpath ?? handle.source.subpath;
    let choices = [...handle.skills];
    if (selectedPath) choices = choices.filter((skill) => skill.path === selectedPath);
    // The official parser decides whether a bare @suffix is a version pin.
    // An explicit #ref@skill remains a selection even if both strings match.
    if (spec.skill && (spec.ref || handle.source.ref !== spec.skill)) choices = choices.filter((skill) => skill.name === spec.skill);
    if (choices.length !== 1) throw Object.assign(new Error(choices.length ? "请选择仓库内一个明确的 Skill。" : "没有找到所选 Skill。"), { status: 400, code: choices.length ? "skill_selection_required" : "invalid_skill" });
    const selected = choices[0]!;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selected.name) || selected.duplicates?.length) throw Object.assign(new Error("Skill 名称无效或在来源中重复。"), { status: 400, code: "invalid_skill" });
    const relative = selected.path ?? ".";
    if (relative !== "." && (path.posix.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some((part) => !part || part === ".." || part === "."))) throw Object.assign(new Error("Skill 来源路径无效。"), { status: 400, code: "invalid_skill" });
    let rawRoot = handle.source.url;
    if (spec.kind === "git") {
      if (!/^[a-f0-9]{40,64}$/i.test(handle.source.commit ?? "")) throw Object.assign(new Error("Skill 来源未返回可验证的 Git 版本。"), { status: 502, code: "skill_source_unavailable" });
      const temporary = path.join(work, "tmp");
      const candidates = fs.readdirSync(temporary, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && fs.existsSync(path.join(temporary, entry.name, ".git")));
      if (candidates.length !== 1) throw Object.assign(new Error("无法验证 Skill 来源目录。"), { status: 502, code: "skill_source_unavailable" });
      rawRoot = path.join(temporary, candidates[0]!.name);
      const entries = childProcess.execFileSync("git", ["-C", rawRoot, "ls-files", "--stage", "-z"], { encoding: "utf8", env: process.env, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
      const prefix = relative === "." ? "" : relative + "/";
      if (entries.split("\0").some((entry) => entry.startsWith("160000 ") && (prefix === "" || entry.slice(entry.indexOf("\t") + 1).startsWith(prefix)))) {
        throw Object.assign(new Error("Skill 包含未安装的 Git 子模块，请使用完整的普通目录资源。"), { status: 400, code: "invalid_skill" });
      }
    }
    let current = rawRoot;
    for (const part of relative === "." ? [] : relative.split("/")) {
      current = path.join(current, part);
      const info = fs.lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error("Skill 来源不能经过符号链接。"), { status: 400, code: "invalid_skill" });
    }
    await validate(current);
    const result = await api.installSkills(handle, { ...settings, cwd: work, skills: [selected.name], agents: ["universal"], config: settings });
    if (result.failed.length || result.skipped.length || result.installed.length !== 1) throw Object.assign(new Error("官方 Skill 安装未完整完成。"), { status: 502, code: "skill_install_failed" });
    const installed = result.installed[0]!;
    const expected = path.join(work, ".agents", "skills", selected.name);
    if (installed.agent !== "universal" || installed.scope !== "project" || installed.mode !== "copy" || path.resolve(installed.path) !== expected) throw Object.assign(new Error("官方 Skill 安装位置无效。"), { status: 502, code: "skill_install_failed" });
    return { directory: expected, ...(handle.source.commit ? { commit: handle.source.commit } : {}) };
  } finally { await handle.dispose(); }
}

function sourceError(error: unknown, remote: boolean): SkillSourceError {
  if (error instanceof SkillSourceError) return error;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && (code.startsWith("skill_") || code === "invalid_skill")) return new SkillSourceError(Number((error as { status?: unknown }).status) || 400, code, (error as Error).message);
  if (code === "SKILLS_LOCAL_PATH_NOT_FOUND" || (error as NodeJS.ErrnoException)?.code === "ENOENT") return new SkillSourceError(404, "skill_source_not_found", "Skill 来源或资源不存在。");
  if (typeof code === "string" && ["SKILLS_NO_VALID_SKILLS", "SKILLS_NO_MATCHING_SKILLS", "SKILLS_AMBIGUOUS_SKILL_SELECTOR", "SKILLS_DUPLICATE_SKILL_NAME", "SKILLS_SKILL_CONTAINS_SYMLINKS", "SKILLS_INVALID_OPTION_VALUE"].includes(code)) return new SkillSourceError(400, "invalid_skill", "Skill 来源、名称或资源无效。");
  return new SkillSourceError(502, remote ? "skill_source_unavailable" : "skill_install_failed", remote ? "无法获取 Git Skill 来源，请检查地址、版本和网络。" : "官方 Skill 安装未完成。");
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? process.env.windir;
    const killer = spawn(root ? path.join(root, "System32", "taskkill.exe") : "taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false, windowsHide: true });
    killer.on("error", () => { child.kill(); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

function remoteEnvironment(work: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "windir", "LANG", "LC_CTYPE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const name of ["tmp", "home", "hooks", "templates", "xdg-config", "xdg-cache", "xdg-state"]) fs.mkdirSync(path.join(work, name), { mode: 0o700 });
  const config = path.join(work, "gitconfig"); fs.writeFileSync(config, "", { mode: 0o600, flag: "wx" });
  Object.assign(env, { HOME: path.join(work, "home"), USERPROFILE: path.join(work, "home"), TMPDIR: path.join(work, "tmp"), TMP: path.join(work, "tmp"), TEMP: path.join(work, "tmp"), XDG_CONFIG_HOME: path.join(work, "xdg-config"), XDG_CACHE_HOME: path.join(work, "xdg-cache"), XDG_STATE_HOME: path.join(work, "xdg-state"), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" });
  const settings = [["core.hooksPath", path.join(work, "hooks")], ["submodule.active", `kulo-${randomBytes(20).toString("hex")}`], ["protocol.file.allow", "never"], ["protocol.ext.allow", "never"], ["init.templateDir", path.join(work, "templates")], ["core.fsmonitor", "false"]];
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
  return env;
}

async function installRemote(spec: SkillSourceSpec, work: string, validate: (directory: string) => Promise<void>, options: InstallSkillSourceOptions): Promise<StageResult> {
  const apiUrl = pathToFileURL(createRequire(import.meta.url).resolve("skills")).href;
  const nonce = randomBytes(24).toString("hex");
  const env = remoteEnvironment(work);
  const script = `
    import * as fs from 'node:fs';
    import * as path from 'node:path';
    import * as childProcess from 'node:child_process';
    const ownedWork = process.cwd();
    const parentExited = () => {
      try { fs.rmSync(ownedWork, {recursive:true, force:true}); }
      finally {
        try {
          if (process.platform === 'win32') {
            const root = process.env.SystemRoot ?? process.env.WINDIR ?? process.env.windir;
            childProcess.execFileSync(root ? path.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], {stdio:'ignore', windowsHide:true, timeout:5000});
          } else process.kill(-process.pid, 'SIGKILL');
        } finally { process.exit(1); }
      }
    };
    process.once('disconnect', parentExited);
    if (!process.connected) parentExited();
    let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 32768) throw new Error('Invalid input'); }
    const p = JSON.parse(text);
    if (fs.realpathSync(p.work) !== ownedWork) throw new Error('Invalid working directory');
    const report = message => {
      if (!process.connected) return parentExited();
      process.send(message, error => {
        if (error || !process.connected) return parentExited();
        process.removeListener('disconnect', parentExited);
        process.disconnect();
      });
    };
    const api = await import(p.apiUrl);
    const validate = async directory => {
      const approved = new Promise((resolve, reject) => process.once('message', message => message?.nonce === p.nonce && message?.type === 'approved' ? resolve() : reject(new Error('Validation refused'))));
      process.send({type:'validate', nonce:p.nonce, directory}, error => { if (error) parentExited(); }); await approved;
    };
    try {
      const modules = {fs,path,childProcess};
      const result = await (${installWithApi.toString()})(api, p.spec, p.work, validate, modules);
      // The API and its Git commands have settled before releasing the parent watch.
      report({type:'done', nonce:p.nonce, result});
    } catch (error) {
      report({type:'error', nonce:p.nonce, code:typeof error?.code === 'string' ? error.code : '', status:typeof error?.status === 'number' ? error.status : 502});
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: work, env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    let settled = false; let result: StageResult | undefined; let failure: unknown; let diagnosticBytes = 0;
    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure); else if (result) resolve(result); else reject(new SkillSourceError(502, "skill_source_unavailable", "官方 Skill 来源进程未返回有效结果。"));
    };
    const stop = (error: unknown) => { if (settled || failure) return; failure = error; killProcessTree(child); };
    const abort = () => stop(new SkillSourceError(409, "skill_source_cancelled", "Skill 来源处理已取消。"));
    const timer = setTimeout(() => stop(new SkillSourceError(504, "skill_source_timeout", "Skill 来源处理超时。")), options.timeoutMs ?? 60_000); timer.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (data: Buffer) => { diagnosticBytes += data.length; if (diagnosticBytes > 1024 * 1024) stop(new SkillSourceError(502, "skill_source_unavailable", "Skill 来源进程输出超过上限。")); });
    child.stdin!.on("error", () => {});
    child.on("error", () => { failure = new SkillSourceError(502, "skill_source_unavailable", "无法启动官方 Skill 来源处理进程。"); finish(); });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { nonce?: unknown }).nonce !== nonce || settled || failure) { stop(new SkillSourceError(502, "skill_source_unavailable", "Skill 来源进程返回无效消息。")); return; }
      const m = message as { type?: unknown; directory?: unknown; result?: StageResult; code?: string; status?: number };
      if (m.type === "validate" && typeof m.directory === "string") {
        const relative = path.relative(path.join(work, "tmp"), m.directory);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) { stop(new SkillSourceError(400, "invalid_skill", "Skill 来源目录越界。")); return; }
        void validate(m.directory).then(() => { if (!failure && child.connected) child.send({ type: "approved", nonce }); }, stop);
      } else if (m.type === "done" && m.result && typeof m.result.directory === "string" && /^[a-f0-9]{40,64}$/i.test(m.result.commit ?? "")) result = m.result;
      else if (m.type === "error") { failure = sourceError(Object.assign(new Error("官方 Skill 来源处理失败。"), { code: m.code, status: m.status }), true); }
      else stop(new SkillSourceError(502, "skill_source_unavailable", "Skill 来源进程返回无效结果。"));
    });
    child.once("close", finish);
    child.stdin!.end(JSON.stringify({ apiUrl, nonce, spec, work }));
  });
}

/** Prepare one skill through Vercel's public API; Kulo remains the owner of the resulting snapshot. */
export async function installSkillSource(spec: SkillSourceSpec, options: InstallSkillSourceOptions): Promise<StageResult & { dispose(): Promise<void> }> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(options.timeoutMs ?? 60_000) || (options.timeoutMs ?? 60_000) < 1 || (options.timeoutMs ?? 60_000) > 300_000) invalid("Skill 来源超时设置无效。");
  const work = fs.mkdtempSync(path.join(options.stagingDir, "official-")); fs.chmodSync(work, 0o700);
  let project: Awaited<ReturnType<NonNullable<InstallSkillSourceOptions["resolveLocalSource"]>>> | undefined;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return; disposed = true;
    try { if (project) await project.dispose(); } finally { fs.rmSync(work, { recursive: true, force: true }); }
  };
  try {
    let resolved = spec;
    if (spec.kind === "local" && spec.locator.startsWith("project://")) {
      if (!options.resolveLocalSource) throw new SkillSourceError(400, "skill_project_source_unavailable", "当前没有可用的项目 Skill 导入通道。");
      project = await options.resolveLocalSource(spec.locator);
      resolved = { ...spec, input: project.directory };
    }
    if (resolved.kind === "local") verifyDirectory(resolved.input);
    const validate = async (directory: string) => { verifyDirectory(directory); await options.validateDirectory?.(directory); };
    const result = resolved.kind === "local"
      ? await installWithApi(options.localApi ?? officialSkills, resolved, work, validate, { fs, path, childProcess: { execFileSync } })
      : await installRemote(resolved, work, validate, options);
    const relative = path.relative(path.join(work, ".agents", "skills"), result.directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) throw new SkillSourceError(502, "skill_install_failed", "官方 Skill 安装位置越界。");
    await validate(result.directory);
    return { ...result, dispose };
  } catch (error) {
    await dispose();
    const code = (error as { code?: unknown })?.code;
    if (typeof code !== "string" || !(code.startsWith("SKILLS_") || code.startsWith("skill_") || code === "invalid_skill")) throw error;
    throw sourceError(error, spec.kind === "git");
  }
}
