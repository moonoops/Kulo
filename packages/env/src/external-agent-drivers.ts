import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cleanSupervisedExecution, processFingerprint, supervisedCommand } from "./worker-supervisor.js";
import { defaultProtectedPaths } from "./isolation.js";
import { ExternalAgentRpc, type ExternalAgentPipeFactory, type RpcValue } from "./external-agent-rpc.js";
import { isBlockedCustomAcpExecutableName, isBundledClaudeSdkExecutable, isSupportedExternalAgentKind, KULO_VERSION, validateCustomAcpArgs, type ExternalAgentBinding, type ExternalAgentCapabilities, type ExternalAgentKind, type ExternalAgentModelInfo, type ExternalAgentQuotaProbeResult, type ExternalAgentServiceTierInfo, type ExternalWorkspaceMode } from "@kulo/protocol";
import { ACP_FLAVORS, acpReadableSkillSubdirs, extractModelsFromAcpInitialize, extractModelsFromAcpModelState, getAcpFlavor, isSensitiveCredentialFilename, sortEffortTokens } from "./external-agent-acp.js";
import { filterNativeAgentEnvironment, type NativeAgentEnvOptions } from "./external-agent-env.js";
import { parseCodexRateLimitsSnapshot, sanitizeQuotaError } from "./external-agent-quota.js";

export interface ExternalDriverContext {
  binding: ExternalAgentBinding;
  executable: string;
  cwd: string;
  workspaceMode?: ExternalWorkspaceMode;
  scratchNotesDir?: string;
  readOnly: boolean;
  prompt: string;
  modelId?: string;
  thinkingLevel?: string;
  serviceTier?: string;
  sessionId?: string;
  timeoutMs: number;
  servers: Array<{name:string;url:string;headers?:Array<{name:string;value:string}>}>;
  pipe: ExternalAgentPipeFactory;
  event(type:"message"|"tool"|"permission"|"state"|"error", text:string):void;
  activity?(label?:string):void;
  quota?(snapshot: ExternalAgentQuotaProbeResult):void;
  session(id:string):void;
  submitted():void;
  complete(state:"completed"|"failed"|"cancelled"|"uncertain", error?:string):void;
  permission(id:string,title:string,choices:Array<{id:string;label:string}>):Promise<string>;
  controlRoot?:string;
  projectId?:string;
  registerCleanup?:(cleanup:()=>Promise<boolean>)=>void;
}
export interface ExternalDriver { cancel():Promise<void>; close():void; cleanup?():Promise<boolean> }
export const externalCapabilities = (kind:ExternalAgentKind):ExternalAgentCapabilities => {
  const supported = isSupportedExternalAgentKind(kind);
  return {
    resume: supported,
    cancel: supported,
    models: supported,
    permissions: supported,
    collaboration: supported,
    terminalEvidence: kind === "grok-bot" ? "observed" : supported ? "native" : "none",
  };
};
export const kindBinary: Partial<Record<ExternalAgentKind, string>> = {
  codex: "codex",
  "claude-code": "claude",
  ...Object.fromEntries(Object.values(ACP_FLAVORS).filter((flavor): flavor is NonNullable<typeof flavor> => Boolean(flavor)).map((flavor) => [flavor.kind, flavor.binary])),
};

const PATH_SENTINEL_START = "__KULO_PATH_START__";
const PATH_SENTINEL_END = "__KULO_PATH_END__";
const SYSTEM_STUB_PATH_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
let cachedLoginShellPath: string[] | undefined;
let loginShellPathPromise: Promise<string[]> | undefined;

function isValidAbsolutePathSegment(segment: string): boolean {
  return segment.length > 0 && path.isAbsolute(segment) && !/[\x00-\x1f\x7f]/.test(segment);
}

export function parseLoginShellPathOutput(stdout: string, delimiter = path.delimiter): string[] {
  const start = stdout.lastIndexOf(PATH_SENTINEL_START);
  if (start < 0) return [];
  const end = stdout.indexOf(PATH_SENTINEL_END, start + PATH_SENTINEL_START.length);
  if (end < 0) return [];
  const raw = stdout.slice(start + PATH_SENTINEL_START.length, end);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const segment of raw.split(delimiter)) {
    const trimmed = segment.trim();
    if (!isValidAbsolutePathSegment(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export async function resolveLoginShellPath(options?: { shell?: string; timeoutMs?: number }): Promise<string[]> {
  if (process.platform === "win32") return [];
  const shellCandidate = options?.shell ?? (process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : (fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh"));
  const timeoutMs = options?.timeoutMs ?? 2500;
  return new Promise<string[]>((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (paths: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(paths);
    };
    const child = spawn(
      shellCandidate,
      ["-lc", `printf '%s%s%s' '${PATH_SENTINEL_START}' "$PATH" '${PATH_SENTINEL_END}'`],
      {
        env: {
          HOME: os.homedir(),
          USER: process.env.USER ?? "",
          TERM: "dumb",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish([]);
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 64_000) {
        try { child.kill(); } catch { /* ignore */ }
        finish(parseLoginShellPathOutput(stdout));
      }
    });
    child.once("error", () => finish([]));
    child.once("exit", (code) => finish(code === 0 ? parseLoginShellPathOutput(stdout) : []));
  });
}

export function primeLoginShellPath(): Promise<string[]> {
  if (cachedLoginShellPath !== undefined) return Promise.resolve(cachedLoginShellPath);
  if (process.platform === "win32" || process.env.KULO_DISABLE_LOGIN_SHELL_PATH === "1" || process.env.VITEST) {
    cachedLoginShellPath = [];
    return Promise.resolve([]);
  }
  loginShellPathPromise ??= resolveLoginShellPath()
    .then((paths) => { cachedLoginShellPath = paths; return paths; })
    .catch(() => { cachedLoginShellPath = []; return []; });
  return loginShellPathPromise;
}

function listVersionedNodeDirs(parent: string, suffix: string[]): string[] {
  try {
    const entries = fs.readdirSync(parent);
    entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
    const dirs: string[] = [];
    for (const entry of entries) {
      const candidate = path.join(parent, entry, ...suffix);
      if (isValidAbsolutePathSegment(candidate) && fs.existsSync(candidate)) dirs.push(candidate);
    }
    return dirs;
  } catch {
    return [];
  }
}

function wellKnownUserToolDirs(): string[] {
  const home = os.homedir();
  const candidates = process.platform === "win32"
    ? [
        path.join(home, ".local", "bin"),
        path.join(home, ".bun", "bin"),
        path.join(home, ".cargo", "bin"),
        path.join(home, "AppData", "Local", "pnpm"),
      ]
    : [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        path.join(home, ".local", "bin"),
        path.join(home, ".bun", "bin"),
        path.join(home, ".cargo", "bin"),
        path.join(home, ".volta", "bin"),
        path.join(home, ".npm-global", "bin"),
        path.join(home, "Library", "pnpm"),
        path.join(home, ".local", "share", "pnpm"),
        path.join(home, ".asdf", "shims"),
        path.join(home, ".local", "share", "mise", "shims"),
        path.join(home, ".nodenv", "shims"),
        path.join(home, ".pyenv", "shims"),
        path.join(home, ".proto", "shims"),
        path.join(home, ".grok", "bin"),
        path.join(home, ".opencode", "bin"),
        path.join(home, ".cursor", "bin"),
        path.join(home, ".kiro", "bin"),
        path.join(home, ".gemini", "antigravity", "bin"),
        path.join(home, "Library", "Application Support", "Antigravity", "bin"),
        ...listVersionedNodeDirs(path.join(home, ".nvm", "versions", "node"), ["bin"]),
        ...listVersionedNodeDirs(path.join(home, "Library", "Application Support", "fnm", "node-versions"), ["installation", "bin"]),
        ...listVersionedNodeDirs(path.join(home, ".fnm", "node-versions"), ["installation", "bin"]),
        ...listVersionedNodeDirs(path.join(home, ".local", "share", "fnm", "node-versions"), ["installation", "bin"]),
      ];
  return candidates.filter((dir) => isValidAbsolutePathSegment(dir) && fs.existsSync(dir));
}

export function augmentedNativePath(basePath = process.env.PATH ?? "", loginShellDirs = cachedLoginShellPath ?? []): string {
  const nonStubBase: string[] = [];
  const systemStubs: string[] = [];
  for (const rawSegment of basePath.split(path.delimiter)) {
    const segment = rawSegment.trim();
    if (!isValidAbsolutePathSegment(segment)) continue;
    if (SYSTEM_STUB_PATH_DIRS.has(segment)) systemStubs.push(segment);
    else nonStubBase.push(segment);
  }
  const ordered = [
    ...loginShellDirs.filter(isValidAbsolutePathSegment),
    ...nonStubBase,
    ...wellKnownUserToolDirs(),
    ...systemStubs,
  ];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of ordered) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    deduped.push(dir);
  }
  return deduped.join(path.delimiter);
}

function isShimLauncherPath(filePath: string, home = os.homedir()): boolean {
  const resolved = path.resolve(filePath);
  const shimDirs = [
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".nodenv", "shims"),
    path.join(home, ".pyenv", "shims"),
    path.join(home, ".proto", "shims"),
  ];
  return shimDirs.some((dir) => {
    const rel = path.relative(dir, resolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

export function resolveExternalExecutable(kind:ExternalAgentKind,requested?:string):string|undefined {
  if (kind === "acp") {
    if (!requested) return undefined;
    if (!path.isAbsolute(requested) || /[\x00-\x1f\x7f]/.test(requested)) {
      throw new Error("Agent executable must be an absolute native executable path");
    }
    if (isBlockedCustomAcpExecutableName(requested)) {
      throw new Error("Custom ACP executable cannot be a generic shell, script runtime, or package runner");
    }
    const home = os.homedir();
    try {
      const actual = fs.realpathSync(requested);
      if (!fs.statSync(actual).isFile()) {
        throw new Error("Agent executable is unavailable on this device");
      }
      fs.accessSync(actual, fs.constants.X_OK);
      if (isBlockedCustomAcpExecutableName(actual)) {
        throw new Error("Custom ACP executable cannot point to a generic shell, script runtime, or package runner");
      }
      return isShimLauncherPath(requested, home) ? path.resolve(requested) : actual;
    } catch (error) {
      if (error instanceof Error && /Custom ACP executable|Agent executable/.test(error.message)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(code === "ENOENT" || code === "ENOTDIR" ? "Agent executable was not found on this device" : code === "EACCES" || code === "EPERM" ? "Agent executable is not executable on this device" : "Agent executable is unavailable on this device");
    }
  }
  const binary = kindBinary[kind]; if (!binary) return;
  const effectiveRequested = kind === "claude-code" && isBundledClaudeSdkExecutable(requested) ? undefined : requested;
  const home = os.homedir();
  const flavor = getAcpFlavor(kind);
  const directories = [...new Set([
    ...augmentedNativePath().split(path.delimiter).filter(isValidAbsolutePathSegment),
    ...((flavor?.extraToolDirs?.(home) ?? []).filter((dir) => isValidAbsolutePathSegment(dir) && fs.existsSync(dir))),
  ])];
  const nativeApps: Partial<Record<ExternalAgentKind, string[]>> = {
    codex: [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"),
      path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/bin/codex",
      path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
    ],
    "claude-code": [
      path.join(home, ".claude", "local", "claude"),
    ],
  };
  const flavorMacPaths = flavor?.macAppPaths ? [...flavor.macAppPaths(home)] : [];
  const extraPaths = process.platform === "darwin"
    ? [...(nativeApps[kind] ?? []), ...flavorMacPaths]
    : (kind === "claude-code" ? (nativeApps[kind] ?? []) : []);
  const candidates = effectiveRequested
    ? [effectiveRequested]
    : [...directories.flatMap(dir => process.platform === "win32" ? [path.join(dir, binary + ".exe"), path.join(dir, binary)] : [path.join(dir, binary)]), ...extraPaths];
  for (const value of candidates) {
    if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
      if (effectiveRequested) throw new Error("Agent executable must be an absolute native executable path");
      continue;
    }
    try {
      const actual = fs.realpathSync(value);
      if (!fs.statSync(actual).isFile()) continue;
      fs.accessSync(actual, fs.constants.X_OK);
      if (kind === "claude-code" && (isBundledClaudeSdkExecutable(value) || isBundledClaudeSdkExecutable(actual))) {
        if (effectiveRequested) throw new Error("Bundled Claude SDK executable cannot be configured as a native client");
        continue;
      }
      return isShimLauncherPath(value, home) ? path.resolve(value) : actual;
    } catch (error) {
      if (effectiveRequested) {
        if (error instanceof Error && /Bundled Claude SDK/.test(error.message)) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        throw new Error(code === "ENOENT" || code === "ENOTDIR" ? "Agent executable was not found on this device" : code === "EACCES" || code === "EPERM" ? "Agent executable is not executable on this device" : "Agent executable is unavailable on this device");
      }
    }
  }
}
export function externalRuntimePaths(executable:string):string[]{
  let resolved = executable;
  try { resolved = fs.realpathSync(executable); } catch { /* keep raw path if not resolvable */ }
  const home = (() => { try { return fs.realpathSync(os.homedir()); } catch { return path.resolve(os.homedir()); } })();
  const roots=[executable, resolved];let current=path.dirname(resolved);
  // Only the installed package containing the executable is granted; stop before $HOME so shims never grant home stores.
  for(let depth=0;depth<5&&current!==path.dirname(current)&&current!==home;depth++,current=path.dirname(current)){
    if(fs.existsSync(path.join(current,"package.json"))){roots.push(current);break;}
  }
  if(fs.existsSync(process.execPath))roots.push(fs.realpathSync(process.execPath));
  return [...new Set(roots)];
}
export function nativeProxyEnv():Record<string,string>{return Object.fromEntries(["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"].flatMap(name=>process.env[name]?[[name,process.env[name]!]]:[]));}
export function approvedAgentEnv(kind:ExternalAgentKind):Record<string,string>{
  const flavorKeys = getAcpFlavor(kind)?.approvedEnvKeys;
  const keys = kind === "codex"
    ? ["OPENAI_API_KEY"]
    : kind === "claude-code"
      ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
      : flavorKeys ?? [];
  return Object.fromEntries(keys.flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]));
}
export function nativeAgentEnvironment(kind?: ExternalAgentKind, options?: NativeAgentEnvOptions): NodeJS.ProcessEnv {
  const filtered = filterNativeAgentEnvironment(process.env, kind, options);
  filtered.PATH = augmentedNativePath(process.env.PATH ?? "");
  return filtered;
}
export function managedNativeProcess(options:{executable:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;controlRoot:string;projectId?:string}):{child:ChildProcessWithoutNullStreams;cleanup():Promise<boolean>}{
  fs.mkdirSync(options.controlRoot,{recursive:true,mode:0o700});
  const control=fs.mkdtempSync(path.join(options.controlRoot,"kulo-worker-control-"));
  const temporaryDir=fs.mkdtempSync(path.join(os.tmpdir(),"kulo-worker-native-"));
  fs.writeFileSync(path.join(control,"owner.json"),JSON.stringify({ownerPid:process.pid,ownerIdentity:processFingerprint(process.pid),workspaceDir:options.cwd,projectId:options.projectId,temporaryDir,cleanupModel:"process-group"}),{mode:0o600});
  const command=supervisedCommand([options.executable,...options.args],control);
  const child=spawn(command[0]!,command.slice(1),{cwd:options.cwd,env:options.env,stdio:"pipe",windowsHide:true});
  const exited=new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.once("error",()=>resolve());});
  let cleaning:Promise<boolean>|undefined;
  const cleanup=()=>cleaning??=(async()=>{
    child.stdin.end();child.kill();
    await Promise.race([exited,new Promise<void>(resolve=>{const timer=setTimeout(resolve,2000);timer.unref();})]);
    const pending=await cleanSupervisedExecution(control);
    if(!pending){fs.rmSync(control,{recursive:true,force:true});fs.rmSync(temporaryDir,{recursive:true,force:true});}
    else cleaning=undefined;
    return !pending;
  })();
  return {child,cleanup};
}
export function createExternalPipeFactory(options:{controlRoot:string;projectId?:string;kind?:ExternalAgentKind}):ExternalAgentPipeFactory{
  return async spec=>{
    const managed=managedNativeProcess({executable:spec.executable,args:spec.args,cwd:spec.cwd,env:{...nativeAgentEnvironment(options.kind),...spec.env},controlRoot:options.controlRoot,projectId:options.projectId});const child=managed.child;
    child.stdout.on("data",spec.onStdout);child.stderr.on("data",spec.onStderr);
    const exited=new Promise<number>((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code??-1));});
    return{write:data=>{child.stdin.write(data);},close:()=>{child.kill();},exited,cleanup:managed.cleanup};
  };
}
function obj(v:unknown):RpcValue{return v&&typeof v==="object"&&!Array.isArray(v)?v as RpcValue:{};}
function text(v:unknown):string{return typeof v==="string"?v:"";}
function canonicalAcpPath(filePath: string, depth = 0): string {
  if (depth > 40) throw new Error("ACP file path contains too many symbolic link levels");
  const resolved = path.resolve(filePath);
  const tail: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      const real = fs.realpathSync(cursor);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) {
          const linkTarget = path.resolve(path.dirname(cursor), fs.readlinkSync(cursor));
          const combined = tail.length ? path.join(linkTarget, ...tail.reverse()) : linkTarget;
          return canonicalAcpPath(combined, depth + 1);
        }
      } catch {
        // Non-existent entry; continue walking up to the nearest existing ancestor.
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}
function isWithinAcpDir(target: string, root: string): boolean {
  const rel = path.relative(canonicalAcpPath(root), target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
export function isProtectedAcpPath(canonicalTarget: string, includeGitControl: boolean, currentKind?: ExternalAgentKind): boolean {
  const normalized = canonicalTarget.replace(/\\/g, "/");
  if (/(?:^|\/)(?:\.kulo-state|\.secure)(?:\/|$)/.test(normalized)) return true;
  if (/(?:^|\/)(?:connection\.json|devices\.json|runtime-token|node-identity\.json|cluster-membership\.json|cluster-transition\.json|cluster-sync-meta\.json|sync-key\.enc|vault-envelope\.enc|(?:kulo|assistant)\.sqlite(?:-wal|-shm)?)$/.test(normalized)) return true;
  if (/\/Library\/Group Containers\/group\.com\.apple\.usernoted(?:\/|$)/.test(normalized)) return true;
  if (/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/0\/com\.apple\.notificationcenter(?:\/|$)/.test(normalized)) return true;
  if (includeGitControl && /(?:^|\/)\.git\/(?:hooks(?:\/|$)|config$)/.test(normalized)) return true;
  for (const entry of defaultProtectedPaths()) {
    if (isWithinAcpDir(canonicalTarget, entry)) {
      if (!includeGitControl && currentKind) {
        const home = os.homedir();
        const allowedSubdirs = acpReadableSkillSubdirs(currentKind);
        const insideOwnPublicSubdir = allowedSubdirs.some((relSubdir) =>
          isWithinAcpDir(canonicalTarget, path.join(home, relSubdir)),
        );
        if (insideOwnPublicSubdir && !isSensitiveCredentialFilename(canonicalTarget)) {
          return false;
        }
      }
      return true;
    }
  }
  return false;
}
function createAcpLocalClient(ctx:ExternalDriverContext){
  type Terminal={child:ChildProcessWithoutNullStreams;output:Buffer;limit:number;truncated:boolean;status?:{exitCode:number|null;signal:string|null};exited:Promise<{exitCode:number|null;signal:string|null}>;cleanup:()=>Promise<boolean>};
  const terminals=new Map<string,Terminal>();
  const terminal=(params:RpcValue)=>{const value=terminals.get(text(params.terminalId));if(!value)throw new Error("Unknown ACP terminal");return value;};
  return{
    async request(method:string,params:RpcValue):Promise<unknown>{
      if(method==="fs/read_text_file"){
        if(typeof params.path!=="string"||!path.isAbsolute(params.path))throw new Error("ACP file path must be absolute");
        const target=canonicalAcpPath(params.path);
        if(isProtectedAcpPath(target,false,ctx.binding.kind))throw new Error("ACP file read is denied for protected system or Kulo paths");
        const content=await fs.promises.readFile(target,"utf8");
        if(params.line===undefined&&params.limit===undefined)return{content};
        if(params.line!==undefined&&(!Number.isSafeInteger(params.line)||Number(params.line)<1)||params.limit!==undefined&&(!Number.isSafeInteger(params.limit)||Number(params.limit)<0))throw new Error("Invalid ACP line range");
        const lines=content.split("\n"),start=Number(params.line??1)-1;return{content:lines.slice(start,params.limit===undefined?undefined:start+Number(params.limit)).join("\n")};
      }
      if(method==="fs/write_text_file"){
        if(typeof params.path!=="string"||!path.isAbsolute(params.path)||typeof params.content!=="string")throw new Error("Invalid ACP file write");
        const target=canonicalAcpPath(params.path);
        if(isProtectedAcpPath(target,true,ctx.binding.kind))throw new Error("ACP file write is denied for protected system, git control, or Kulo paths");
        if(ctx.workspaceMode==="read_only"){
          const inNotes=Boolean(ctx.scratchNotesDir&&isWithinAcpDir(target,ctx.scratchNotesDir));
          if(!inNotes)throw new Error("Read-only external task cannot modify files outside its scratch notes directory");
        }else if(ctx.workspaceMode==="staged"){
          const inStaged=isWithinAcpDir(target,ctx.cwd);
          const inNotes=Boolean(ctx.scratchNotesDir&&isWithinAcpDir(target,ctx.scratchNotesDir));
          if(!inStaged&&!inNotes)throw new Error("Staged external task cannot modify files outside its isolated staged workspace or scratch notes directory");
        }
        await fs.promises.mkdir(path.dirname(target),{recursive:true});
        await fs.promises.writeFile(target,params.content,"utf8");return{};
      }
      if(method==="terminal/create"){
        if(ctx.workspaceMode==="read_only")throw new Error("Read-only external task cannot spawn unrestricted ACP terminals");
        if(typeof params.command!=="string"||!params.command||params.args!==undefined&&(!Array.isArray(params.args)||params.args.some(value=>typeof value!=="string")))throw new Error("Invalid ACP terminal command");
        if(!ctx.controlRoot)throw new Error("ACP terminal process supervision is unavailable");
        const env:NodeJS.ProcessEnv={...nativeAgentEnvironment(ctx.binding.kind,{terminal:true})};for(const item of Array.isArray(params.env)?params.env:[]){const value=obj(item);if(typeof value.name!=="string"||typeof value.value!=="string")throw new Error("Invalid ACP terminal environment");env[value.name]=value.value;}
        const limit=params.outputByteLimit===undefined?1024*1024:Number(params.outputByteLimit);if(!Number.isSafeInteger(limit)||limit<0)throw new Error("Invalid ACP output byte limit");
        const managed=managedNativeProcess({executable:params.command,args:(params.args??[]) as string[],cwd:typeof params.cwd==="string"?params.cwd:ctx.cwd,env,controlRoot:ctx.controlRoot,projectId:ctx.projectId});
        const value:Terminal={...managed,output:Buffer.alloc(0),limit,truncated:false,exited:Promise.resolve({exitCode:null,signal:null})};
        const append=(data:Buffer)=>{const output=Buffer.concat([value.output,data]);value.truncated||=output.length>limit;value.output=output.subarray(Math.max(0,output.length-limit));};
        value.child.stdout.on("data",append);value.child.stderr.on("data",append);
        value.exited=new Promise((resolve,reject)=>{value.child.once("close",(exitCode,signal)=>{value.status={exitCode,signal};resolve(value.status);});value.child.once("error",reject);});
        void value.exited.catch(()=>{});const terminalId=randomUUID();terminals.set(terminalId,value);ctx.registerCleanup?.(managed.cleanup);return{terminalId};
      }
      if(method==="terminal/output"){const value=terminal(params);return{output:value.output.toString("utf8"),truncated:value.truncated,...(value.status?{exitStatus:value.status}:{})};}
      if(method==="terminal/wait_for_exit")return terminal(params).exited;
      if(method==="terminal/kill"){terminal(params).child.kill();return{};}
      if(method==="terminal/release"){const value=terminal(params);if(!await value.cleanup())throw new Error("ACP terminal cleanup is pending");terminals.delete(text(params.terminalId));return{};}
      throw new Error(`Unsupported ACP client method: ${method}`);
    },
    async close(){const result=await Promise.all([...terminals.values()].map(value=>value.cleanup()));terminals.clear();return result.every(Boolean);},
  };
}
function isThoughtLevelConfigOption(row: RpcValue): boolean {
  const category = text(row.category);
  const id = text(row.id);
  return (
    category === "thought_level" ||
    category === "thinking" ||
    /^(?:thinking|thinking_level|reasoning_effort|effort|effortLevel)$/.test(id)
  );
}

function modelsFromConfig(session:RpcValue):{models:ExternalAgentModelInfo[];configId:string|undefined;thoughtConfigId:string|undefined;currentModelId:string|undefined}{
  const rawModels:Array<{id:string;name:string}>=[];let configId:string|undefined;let thoughtConfigId:string|undefined;let currentModel:string|undefined;
  const efforts:string[]=[];
  const collectModels=(options:unknown)=>{for(const item of Array.isArray(options)?options:[]){const value=obj(item);if(typeof value.value==="string")rawModels.push({id:value.value,name:text(value.name)||value.value});else collectModels(value.options);}};
  const collectEfforts=(options:unknown)=>{for(const item of Array.isArray(options)?options:[]){const value=obj(item);if(typeof value.value==="string"){if(value.value&&!efforts.includes(value.value))efforts.push(value.value);}else collectEfforts(value.options);}};
  for(const option of Array.isArray(session.configOptions)?session.configOptions:[]){
    const row=obj(option);
    if(!configId&&(row.category==="model"||row.id==="model")){configId=text(row.id)||undefined;currentModel=text(row.currentValue)||undefined;collectModels(row.options);}
    if(!thoughtConfigId&&isThoughtLevelConfigOption(row)){thoughtConfigId=text(row.id)||undefined;collectEfforts(row.options);}
  }
  const sessionModelState = extractModelsFromAcpModelState(obj(session.models));
  if(!currentModel && sessionModelState.currentModelId) currentModel = sessionModelState.currentModelId;
  const perModelEfforts = new Map<string, string[]>(
    sessionModelState.models.map((item) => [item.id, item.efforts ?? []]),
  );
  const sourceModels = rawModels.length
    ? rawModels
    : sessionModelState.models.map(({ id, name }) => ({ id, name }));
  const sortedSharedEfforts = efforts.length ? sortEffortTokens(efforts) : [];
  const hasPerModelCatalog = sessionModelState.models.length > 0 && [...perModelEfforts.values()].some((list) => list.length > 0);
  const models:ExternalAgentModelInfo[]=sourceModels.map(item=>{
    const modelEfforts=hasPerModelCatalog
      ? (perModelEfforts.has(item.id)?perModelEfforts.get(item.id)!:sortedSharedEfforts)
      : sortedSharedEfforts;
    return{
      ...item,
      ...(modelEfforts.length?{efforts:[...modelEfforts]}:{}),
      ...(currentModel&&item.id===currentModel?{isDefault:true}:{}),
    };
  });
  return {models,configId,thoughtConfigId,currentModelId:currentModel};
}

function extractXaiPromptComplete(method: string, params: RpcValue): { sessionId?: string; promptId?: string; stopReason?: string; error?: string } | undefined {
  if (method === "x.ai/session/prompt_complete" || method === "_x.ai/session/prompt_complete") {
    const errObj = obj(params.error);
    return {
      sessionId: text(params.sessionId) || undefined,
      promptId: text(params.promptId) || text(params.requestId) || undefined,
      stopReason: text(params.stopReason) || "end_turn",
      error: text(errObj.message) || (typeof params.error === "string" ? params.error : undefined),
    };
  }
  if (method === "x.ai/session/update" || method === "_x.ai/session/update") {
    const update = obj(params.update);
    const kind = text(update.sessionUpdate) || text(update.type);
    if (kind === "prompt_complete" || kind === "turn_complete") {
      const errObj = obj(update.error);
      return {
        sessionId: text(params.sessionId) || text(update.sessionId) || undefined,
        promptId: text(update.promptId) || text(update.requestId) || undefined,
        stopReason: text(update.stopReason) || "end_turn",
        error: text(errObj.message) || (typeof update.error === "string" ? update.error : undefined),
      };
    }
  }
  return undefined;
}

export async function connectAcp(ctx:ExternalDriverContext,probe=false):Promise<{driver:ExternalDriver;models:ExternalAgentModelInfo[]}>{
  const flavor = getAcpFlavor(ctx.binding.kind);
  let launchArgs: string[];
  if (ctx.binding.kind === "acp") {
    const validated = ctx.binding.acpArgs !== undefined ? validateCustomAcpArgs(ctx.binding.acpArgs) : { ok: true as const, value: [] };
    if (!validated.ok) throw new Error(validated.error);
    launchArgs = validated.value;
  } else if (flavor) {
    launchArgs = [...(probe ? (flavor.probeArgs ?? flavor.acpArgs) : ctx.readOnly ? (flavor.readOnlyArgs ?? flavor.acpArgs) : flavor.acpArgs)];
  } else {
    launchArgs = ["acp", "--process-per-session"];
  }

  let sessionId=ctx.sessionId;let submitted=false;let closed=false;let cancelRequested=false;let permissionCancelled=false;let sawToolOrOutput=false;let promptSettled=false;
  let activePromptId: string | undefined;
  let settlePromptFn: ((stopReason: string, errorMessage?: string) => void) | undefined;
  const tools=new Map<string,string>();
  const bufferedConfigOptions = new Map<string, unknown[]>();
  const configWaiters = new Set<() => void>();
  let replayWaiterKick: (() => void) | undefined;
  const notifyConfigWaiters = () => {
    for (const wake of [...configWaiters]) wake();
  };
  const local=createAcpLocalClient(ctx);
  const rpc=new ExternalAgentRpc({request:async(method,params,id)=>{
    if(params.sessionId!==sessionId)throw new Error("Stale external agent session");
    if(method!=="session/request_permission")return local.request(method,params);
    if(!submitted||closed||cancelRequested)return{outcome:{outcome:"cancelled"}};
    const call=obj(params.toolCall);const callId=text(call.toolCallId);const detail=text(call.title)||tools.get(callId)||"External agent permission";
    const options=(Array.isArray(params.options)?params.options:[]).map(value=>obj(value)).filter(value=>typeof value.optionId==="string");
    const choices=options.map(value=>({id:text(value.optionId),label:text(value.name)||text(value.kind)}));
    if(!choices.length)return{outcome:{outcome:"cancelled"}};
    const choice=await ctx.permission(`acp:${createHash("sha256").update(String(id)).digest("hex")}`,detail,choices);
    const option=options.find(value=>value.optionId===choice);
    if(!option){if(!closed&&!cancelRequested)permissionCancelled=true;return{outcome:{outcome:"cancelled"}};}
    const optKind=text(option.kind).toLowerCase();
    if(optKind.includes("reject")||optKind.includes("deny")||optKind.includes("cancel")){permissionCancelled=true;}
    return{outcome:{outcome:"selected",optionId:choice}};
  },notification:(method,params)=>{
    if (flavor?.xaiPromptCompletionFallback && submitted && !promptSettled) {
      const complete = extractXaiPromptComplete(method, params);
      if (complete && (!complete.sessionId || complete.sessionId === sessionId) && (!complete.promptId || !activePromptId || complete.promptId === activePromptId)) {
        settlePromptFn?.(complete.stopReason ?? "end_turn", complete.error);
        return;
      }
    }
    if (method !== "session/update") return;
    const update=obj(params.update),kind=text(update.sessionUpdate);
    const notifSessionId = text(params.sessionId);
    if (!submitted) {
      if (replayWaiterKick && (!sessionId || notifSessionId === sessionId)) {
        replayWaiterKick();
      }
      if (kind === "config_option_update" && Array.isArray(update.configOptions)) {
        const key = notifSessionId || "__pending__";
        bufferedConfigOptions.set(key, update.configOptions);
        if (!sessionId || notifSessionId === sessionId) notifyConfigWaiters();
      }
      return;
    }
    if (notifSessionId !== sessionId) return;
    if(kind==="agent_message_chunk"){
      if(Array.isArray(update.content)){
        for(const block of update.content){const item=obj(block);if(item.type==="text"){const chunk=text(item.text);if(chunk)sawToolOrOutput=true;ctx.event("message",chunk);}}
      }else{
        const content=obj(update.content);if(content.type==="text"){const chunk=text(content.text);if(chunk)sawToolOrOutput=true;ctx.event("message",chunk);}
      }
    }
    if(kind==="agent_thought_chunk")ctx.activity?.("Thinking...");
    if(kind==="plan"||kind==="current_mode_update"||kind==="config_option_update"||kind==="compaction_update"||kind==="compaction_summary_chunk"||kind==="usage_update"||kind==="notice"||kind==="session_info_update")ctx.activity?.("Working...");
    if(kind==="tool_call"||kind==="tool_call_update"){sawToolOrOutput=true;const id=text(update.toolCallId);if(update.title)tools.set(id,text(update.title));ctx.event("tool",text(update.title)||tools.get(id)||"Tool update");}
  },failed:error=>{if(!closed&&submitted&&!promptSettled)ctx.complete("uncertain",error.message);}});
  const pipe=await ctx.pipe({executable:ctx.executable,args:launchArgs,cwd:ctx.cwd,env:{},isolated:false,readOnly:ctx.readOnly,runtimePaths:externalRuntimePaths(ctx.executable),onStdout:data=>rpc.accept(data),onStderr:data=>ctx.event("error",Buffer.from(data).toString("utf8"))});rpc.attach(pipe);
  const driver:ExternalDriver={
    cancel:async()=>{
      cancelRequested=true;
      if(sessionId){
        rpc.notify("session/cancel",{sessionId,...(flavor?.cancelMeta?{_meta:flavor.cancelMeta}:{})});
      }
    },
    close:()=>{
      if(closed)return;
      closed=true;
      try{if(sessionId)rpc.notify("session/close",{sessionId});}catch{/* The protocol may already have ended. */}finally{rpc.close();}
    },
    cleanup:async()=>{
      const processes=await local.close();
      return (await(pipe.cleanup?.()??pipe.exited.then(()=>true,()=>false)))&&processes;
    },
  };
  const validateRequestedModelAndEffort = (models: ExternalAgentModelInfo[], currentModelId?: string) => {
    if (ctx.modelId && models.length > 0 && !models.some((model) => model.id === ctx.modelId)) {
      throw new Error("Selected model is not advertised by this local agent");
    }
    if (ctx.thinkingLevel) {
      const targetId = ctx.modelId || currentModelId || models.find((model) => model.isDefault)?.id;
      const target = targetId ? models.find((model) => model.id === targetId) : undefined;
      if (target?.efforts?.length && !target.efforts.includes(ctx.thinkingLevel)) {
        throw new Error("Selected thinking level is not advertised by this local agent");
      }
    }
  };
  try{
    const init=await rpc.call(
      "initialize",
      {
        protocolVersion:1,
        clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:true},
        clientInfo:{name:"kulo",version:KULO_VERSION},
        ...(flavor?.initializeMeta?{_meta:flavor.initializeMeta}:{}),
      },
      flavor?.initializeTimeoutMs ?? 30_000,
    );
    const initModels = extractModelsFromAcpInitialize(init);
    if (probe && flavor?.probeInitializeOnly && initModels.models.length > 0) {
      validateRequestedModelAndEffort(initModels.models, initModels.currentModelId);
      return { driver, models: initModels.models };
    }
    const capabilities=obj(init.agentCapabilities);const mcpServers=obj(capabilities.mcpCapabilities).http?ctx.servers.map(server=>({type:"http",name:`kulo-${randomUUID()}-${server.name}`,url:server.url,headers:server.headers??[]})):[];
    if(ctx.servers.length&&!mcpServers.length)ctx.event("state","This client does not advertise HTTP MCP; continuing with its native tools");
    let session:RpcValue;
    if(sessionId){
      const canResume = Boolean(obj(capabilities.sessionCapabilities).resume);
      if(!capabilities.loadSession&&!canResume)throw new Error("Installed agent does not support native session resume");
      if (!canResume && flavor?.sessionLoadReplayIdleReadiness) {
        let idleTimer: NodeJS.Timeout | undefined;
        const loadPromise = rpc.call("session/load",{sessionId,cwd:ctx.cwd,mcpServers});
        session = await new Promise<RpcValue>((resolve, reject) => {
          let done = false;
          const finish = (value: RpcValue | Error) => {
            if (done) return;
            done = true;
            replayWaiterKick = undefined;
            if (idleTimer) clearTimeout(idleTimer);
            if (value instanceof Error) reject(value);
            else resolve(value);
          };
          replayWaiterKick = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => finish({ sessionId }), 1_200);
            idleTimer.unref();
          };
          void loadPromise.then(finish, (err: unknown) => finish(err instanceof Error ? err : new Error("ACP session/load failed")));
        });
      } else {
        session=await rpc.call(canResume?"session/resume":"session/load",{sessionId,cwd:ctx.cwd,mcpServers});
      }
    } else {
      session=await rpc.call("session/new",{cwd:ctx.cwd,mcpServers});
    }
    sessionId=text(session.sessionId)||sessionId;if(!sessionId)throw new Error("Agent did not return a native session ID");ctx.session(sessionId);

    const mergeBufferedConfig = () => {
      const buffered = bufferedConfigOptions.get(sessionId!) ?? bufferedConfigOptions.get("__pending__");
      if (buffered && (!Array.isArray(session.configOptions) || session.configOptions.length === 0)) {
        session = { ...session, configOptions: buffered };
      }
    };
    mergeBufferedConfig();
    let parsed = modelsFromConfig(session);
    if (probe && parsed.models.length === 0 && initModels.models.length === 0 && flavor?.modelAdvertisementGraceMs && flavor.modelAdvertisementGraceMs > 0) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          configWaiters.delete(onUpdate);
          resolve();
        };
        const onUpdate = () => {
          mergeBufferedConfig();
          parsed = modelsFromConfig(session);
          if (parsed.models.length > 0) finish();
        };
        const timer = setTimeout(finish, flavor.modelAdvertisementGraceMs);
        timer.unref();
        configWaiters.add(onUpdate);
        onUpdate();
      });
    }
    let models = parsed.models.length > 0 ? parsed.models : initModels.models;
    const currentModelId = parsed.currentModelId ?? initModels.currentModelId;
    const configId = parsed.configId;
    const thoughtConfigId = parsed.thoughtConfigId;

    const useSetSessionModel = Boolean(
      flavor?.preferSetSessionModel ||
      (!configId && (ctx.modelId || (ctx.thinkingLevel && !thoughtConfigId))),
    );

    if (useSetSessionModel) {
      validateRequestedModelAndEffort(models, currentModelId);
      const effectiveModelId = ctx.modelId || currentModelId || models.find((model) => model.isDefault)?.id;
      if ((ctx.modelId || ctx.thinkingLevel) && effectiveModelId) {
        await rpc.call("session/set_model", {
          sessionId,
          modelId: effectiveModelId,
          ...(ctx.thinkingLevel ? { _meta: { reasoningEffort: ctx.thinkingLevel } } : {}),
        });
      } else if (ctx.modelId) {
        throw new Error("Selected model is not advertised by this local agent");
      }
    } else {
      if (ctx.modelId) {
        if (!configId || !models.some((model) => model.id === ctx.modelId)) {
          throw new Error("Selected model is not advertised by this local agent");
        }
        const updated = await rpc.call("session/set_config_option", { sessionId, configId, value: ctx.modelId });
        if (Array.isArray(updated.configOptions)) {
          session = { ...session, configOptions: updated.configOptions };
          const refreshed = modelsFromConfig(session);
          if (refreshed.models.length > 0) models = refreshed.models;
        }
      }
      if (ctx.thinkingLevel) {
        const options = (Array.isArray(session.configOptions) ? session.configOptions : []).map(obj);
        const option = options.find((value) => isThoughtLevelConfigOption(value));
        const values: RpcValue[] = [];
        const collect = (items: unknown) => {
          for (const item of Array.isArray(items) ? items : []) {
            const row = obj(item);
            if (typeof row.value === "string") values.push(row);
            else collect(row.options);
          }
        };
        collect(option?.options);
        if (!option || !values.some((value) => value.value === ctx.thinkingLevel)) {
          throw new Error("Selected thinking level is not advertised by this local agent");
        }
        await rpc.call("session/set_config_option", { sessionId, configId: option.id, value: ctx.thinkingLevel });
      }
    }

    if(!probe){
      submitted=true;
      ctx.submitted();
      settlePromptFn = (reason: string, errorMessage?: string) => {
        if (promptSettled) return;
        promptSettled = true;
        if (reason === "cancelled") {
          if (cancelRequested || permissionCancelled) ctx.complete("cancelled");
          else if (sawToolOrOutput) ctx.complete("uncertain", errorMessage || "External agent spontaneously cancelled mid-turn without an explicit cancel request");
          else ctx.complete("failed", errorMessage || "External agent cancelled without an explicit cancel request");
        } else if (["end_turn", "max_tokens", "max_turn_requests", "refusal"].includes(reason)) ctx.complete("completed");
        else ctx.complete(cancelRequested ? "uncertain" : "failed", errorMessage || `Unexpected ACP stop reason: ${reason || "missing"}`);
        driver.close();
      };
      const promptParams: RpcValue = { sessionId, prompt: [{ type: "text", text: ctx.prompt }] };
      if (flavor?.xaiPromptCompletionFallback) {
        activePromptId = `kulo-xai-prompt-${randomUUID()}`;
        promptParams._meta = { promptId: activePromptId, requestId: activePromptId };
      }
      void rpc.call("session/prompt", promptParams, ctx.timeoutMs).then(
        (result) => {
          settlePromptFn?.(text(result.stopReason));
        },
        (error) => {
          if (promptSettled) return;
          promptSettled = true;
          ctx.complete("uncertain", error instanceof Error ? error.message : "Agent prompt failed");
          driver.close();
        },
      );
    }
    return{driver,models};
  }catch(error){driver.close();throw error;}
}

export async function connectCodex(ctx:ExternalDriverContext,probe=false):Promise<{driver:ExternalDriver;models:ExternalAgentModelInfo[];authenticated:boolean|null}>{
  let sessionId=ctx.sessionId;let turnId:string|undefined;let submitted=false;let closed=false;let sawMessageDelta=false;
  let cancelRequested=false;let pendingInterrupt=false;let permissionCancelled=false;let sawToolOrOutput=false;
  const flushPendingInterrupt=()=>{if(pendingInterrupt&&sessionId&&turnId&&!closed){pendingInterrupt=false;void rpc.call("turn/interrupt",{threadId:sessionId,turnId}).catch(()=>{});}};
  const rpc=new ExternalAgentRpc({request:async(method,params,id)=>{
    if(params.threadId&&params.threadId!==sessionId)throw new Error("Stale Codex thread");
    if(method==="item/commandExecution/requestApproval"||method==="item/fileChange/requestApproval"){
      const decisions=Array.isArray(params.availableDecisions)?params.availableDecisions:["accept","acceptForSession","decline","cancel"];
      const choices=decisions.map((decision,index)=>({id:String(index),label:typeof decision==="string"?decision:JSON.stringify(decision)}));
      const choice=await ctx.permission(`codex:${createHash("sha256").update(String(id)).digest("hex")}`,text(params.reason)||text(params.command)||"Codex tool approval",choices);
      const selected=choices.findIndex(value=>value.id===choice);if(selected<0){permissionCancelled=true;throw new Error("Codex approval input was cancelled");}
      const picked=decisions[selected];
      if(picked==="decline"||picked==="cancel")permissionCancelled=true;
      return{decision:picked};
    }
    if(method==="item/permissions/requestApproval"){
      const choice=await ctx.permission(`codex:${createHash("sha256").update(String(id)).digest("hex")}`,text(params.reason)||JSON.stringify(params.permissions),[{id:"turn",label:"Allow for this turn"},{id:"session",label:"Allow for this session"},{id:"deny",label:"Reject"}]);
      if(choice!=="turn"&&choice!=="session")permissionCancelled=true;
      return{permissions:choice==="turn"||choice==="session"?params.permissions:{},scope:choice==="session"?"session":"turn"};
    }
    if(method==="item/tool/requestUserInput"){
      const questions=(Array.isArray(params.questions)?params.questions:[]).map(obj);
      const answers:Record<string,{answers:string[]}>={};
      for(const [qIndex,q] of questions.entries()){
        const qId=text(q.id)||`q${qIndex}`;
        const qTitle=[text(q.header),text(q.question)].filter(Boolean).join(": ")||"Codex requested input";
        const rawOptions=(Array.isArray(q.options)?q.options:[]).map(obj).filter(opt=>typeof opt.label==="string"&&opt.label.length>0);
        const choices=rawOptions.length
          ?rawOptions.map((opt,idx)=>({id:String(idx),label:text(opt.description)?`${text(opt.label)} — ${text(opt.description)}`:text(opt.label)}))
          :[{id:"continue",label:"Proceed with best judgment"},{id:"decline",label:"Cancel"}];
        const choice=await ctx.permission(`codex:${createHash("sha256").update(`${String(id)}:${qId}`).digest("hex")}`,qTitle,choices);
        if(rawOptions.length){
          const idx=Number(choice);
          const selected=Number.isInteger(idx)&&idx>=0&&idx<rawOptions.length?rawOptions[idx]:undefined;
          if(!selected)permissionCancelled=true;
          answers[qId]={answers:selected?[text(selected.label)]:[]};
        }else{
          if(choice!=="continue")permissionCancelled=true;
          answers[qId]={answers:choice==="continue"?["Proceed with best judgment"]:[]};
        }
      }
      return{answers};
    }
    throw new Error("Unsupported Codex request");
  },notification:(method,params)=>{
    if(params.threadId&&params.threadId!==sessionId)return;
    if(method==="item/agentMessage/delta"){sawMessageDelta=true;const delta=text(params.delta);if(delta)sawToolOrOutput=true;ctx.event("message",delta);}
    if(method==="item/reasoning/summaryTextDelta"||method==="item/reasoning/textDelta"||method==="item/reasoning/summaryPartAdded")ctx.activity?.("Reasoning...");
    if(method==="item/commandExecution/outputDelta"||method==="item/fileChange/outputDelta"||method==="item/plan/delta"||method==="turn/plan/updated"||method==="turn/diff/updated")ctx.activity?.("Executing...");
    if(method==="item/started"||method==="item/completed"){
      const item=obj(params.item);
      if(item.type==="agentMessage"){
        if(method==="item/completed"&&!sawMessageDelta){
          const fallback=text(item.text)||(Array.isArray(item.content)?item.content.map(part=>{const p=obj(part);return (p.type==="text"||p.type==="output_text")?text(p.text):"";}).join(""):"");
          if(fallback){sawToolOrOutput=true;ctx.event("message",fallback);}
        }
      }else{
        sawToolOrOutput=true;
        ctx.event("tool",text(item.type)||"Tool update");
      }
    }
    if(method==="turn/started"){sawMessageDelta=false;turnId=text(obj(params.turn).id)||turnId;flushPendingInterrupt();}
    if(method==="turn/completed"){
      const turn=obj(params.turn);const status=text(turn.status);const errMsg=text(obj(turn.error).message)||undefined;
      if(status==="completed")ctx.complete("completed",errMsg);
      else if(status==="interrupted"){
        if(cancelRequested||permissionCancelled)ctx.complete("cancelled",errMsg);
        else if(sawToolOrOutput)ctx.complete("uncertain",errMsg||"Codex turn was interrupted mid-execution without a cancel request");
        else ctx.complete("failed",errMsg||"Codex turn was interrupted without a cancel request");
      }else ctx.complete("failed",errMsg);
      driver.close();
    }
    if(method==="account/rateLimits/updated"){
      const parsed=parseCodexRateLimitsSnapshot(params,{source:"passive_run"});
      if(parsed)ctx.quota?.(parsed);
    }
    if(method==="error"&&params.willRetry!==true)ctx.event("error",text(obj(params.error).message)||"Codex reported an error");
  },failed:error=>{if(!closed&&submitted)ctx.complete("uncertain",error.message);}});
  const pipe=await ctx.pipe({executable:ctx.executable,args:["app-server"],cwd:ctx.cwd,env:{},isolated:false,readOnly:ctx.readOnly,runtimePaths:externalRuntimePaths(ctx.executable),onStdout:data=>rpc.accept(data),onStderr:data=>ctx.event("error",Buffer.from(data).toString("utf8"))});rpc.attach(pipe);
  const driver:ExternalDriver={cancel:async()=>{cancelRequested=true;if(!sessionId||!turnId){pendingInterrupt=true;return;}await rpc.call("turn/interrupt",{threadId:sessionId,turnId});},close:()=>{closed=true;rpc.close();},cleanup:()=>pipe.cleanup?.()??pipe.exited.then(()=>true,()=>false)};
  try{
    await rpc.call("initialize",{clientInfo:{name:"kulo",version:KULO_VERSION},capabilities:{experimentalApi:true}});rpc.notify("initialized",{});
    const [modelResult,account]=probe?await Promise.all([rpc.call("model/list",{}),rpc.call("account/read",{refreshToken:false}).catch(()=>({}))]):[ctx.modelId||ctx.thinkingLevel||ctx.serviceTier?await rpc.call("model/list",{}):{},{}];
    const catalog=(Array.isArray(modelResult.data)?modelResult.data:[]).map(obj);
    const parseCodexServiceTiers=(value:RpcValue):ExternalAgentServiceTierInfo[]=>{
      const seen=new Set<string>(),tiers:ExternalAgentServiceTierInfo[]=[];
      const pushTier=(id:string,name?:string,description?:string)=>{
        const clean=id.trim();if(!clean||seen.has(clean))return;seen.add(clean);
        tiers.push({id:clean,...(name?.trim()?{name:name.trim()}:{}),...(description?.trim()?{description:description.trim()}:{})});
      };
      if(Array.isArray(value.serviceTiers)){
        for(const item of value.serviceTiers){
          const row=obj(item);
          if(typeof row.id==="string")pushTier(row.id,text(row.name),text(row.description));
        }
      }
      if(Array.isArray(value.additionalSpeedTiers)){
        for(const item of value.additionalSpeedTiers){
          if(typeof item==="string")pushTier(item);
        }
      }
      return tiers;
    };
    const models:ExternalAgentModelInfo[]=catalog.filter(value=>typeof value.id==="string").map(value=>{
      const efforts=(Array.isArray(value.supportedReasoningEfforts)?value.supportedReasoningEfforts:[]).map(item=>text(obj(item).reasoningEffort)).filter(Boolean);
      const serviceTiers=parseCodexServiceTiers(value);
      const defaultServiceTier=text(value.defaultServiceTier).trim()||undefined;
      return{
        id:text(value.model)||text(value.id),
        name:text(value.displayName)||text(value.id),
        ...(efforts.length?{efforts:[...new Set(efforts)]}:{}),
        ...(serviceTiers.length?{serviceTiers}:{}),
        ...(defaultServiceTier?{defaultServiceTier}:{}),
        ...(value.isDefault===true?{isDefault:true}:{}),
      };
    });
    const authenticated=probe?Boolean(approvedAgentEnv("codex").OPENAI_API_KEY||obj(account).account):null;
    if(ctx.modelId&&models.length&&!models.some(model=>model.id===ctx.modelId))throw new Error("Selected model is not advertised by Codex");
    if(!probe){
      const mcp_servers=Object.fromEntries(ctx.servers.map(server=>[`kulo-${randomUUID()}-${server.name}`,{enabled:true,url:server.url,http_headers:Object.fromEntries((server.headers??[]).map(item=>[item.name,item.value]))}]));
      const preSelected=catalog.find(value=>(value.model??value.id)===ctx.modelId)??(!ctx.modelId?catalog.find(value=>value.isDefault):undefined);
      if(ctx.serviceTier&&preSelected){
        const advertisedTiers=parseCodexServiceTiers(preSelected);
        if(advertisedTiers.length>0&&ctx.serviceTier!=="default"&&!advertisedTiers.some(tier=>tier.id===ctx.serviceTier)){
          throw new Error("Selected service tier is not advertised by Codex for this model");
        }
      }
      const thread=await rpc.call(sessionId?"thread/resume":"thread/start",{...(sessionId?{threadId:sessionId}:{}),cwd:ctx.cwd,...(ctx.modelId?{model:ctx.modelId}:{}),...(ctx.serviceTier?{serviceTier:ctx.serviceTier}:{}),...(ctx.servers.length?{config:{mcp_servers}}:{})});
      const selected=catalog.find(value=>(value.model??value.id)===(ctx.modelId??thread.model))??(!ctx.modelId?catalog.find(value=>value.isDefault):undefined);
      if(ctx.thinkingLevel){
        if(!selected||!(Array.isArray(selected.supportedReasoningEfforts)?selected.supportedReasoningEfforts:[]).some(value=>obj(value).reasoningEffort===ctx.thinkingLevel))throw new Error("Selected thinking level is not advertised by Codex for this model");
      }
      if(ctx.serviceTier&&selected){
        const advertisedTiers=parseCodexServiceTiers(selected);
        if(advertisedTiers.length>0&&ctx.serviceTier!=="default"&&!advertisedTiers.some(tier=>tier.id===ctx.serviceTier)){
          throw new Error("Selected service tier is not advertised by Codex for this model");
        }
      }
      sessionId=text(obj(thread.thread).id);if(!sessionId)throw new Error("Codex did not return a native thread ID");ctx.session(sessionId);
      submitted=true;ctx.submitted();const turn=await rpc.call("turn/start",{threadId:sessionId,cwd:ctx.cwd,input:[{type:"text",text:ctx.prompt,text_elements:[]}],...(ctx.modelId?{model:ctx.modelId}:{}),...(ctx.thinkingLevel?{effort:ctx.thinkingLevel}:{}),...(ctx.serviceTier?{serviceTier:ctx.serviceTier}:{})});turnId=text(obj(turn.turn).id)||turnId;flushPendingInterrupt();
    }
    return{driver,models,authenticated};
  }catch(error){driver.close();throw error;}
}

export async function probeCodexQuota(options: {
  executable: string;
  cwd: string;
  controlRoot: string;
  pipeFactory?: ExternalAgentPipeFactory;
  signal?: AbortSignal;
  timeoutMs?: number;
  redact?: (value: string) => string;
}): Promise<ExternalAgentQuotaProbeResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const startedAt = Date.now();
  const remainingMs = () => Math.max(500, timeoutMs - (Date.now() - startedAt));
  if (options.signal?.aborted) {
    return { kind: "codex", status: "unavailable", source: "live", fetchedAt: Date.now(), windows: [], error: "Quota check aborted" };
  }
  const rpc = new ExternalAgentRpc({
    request: async () => { throw new Error("Quota probe does not accept interactive requests"); },
    notification: () => {},
    failed: () => {},
  });
  const factory = options.pipeFactory ?? createExternalPipeFactory({ controlRoot: options.controlRoot, kind: "codex" });
  const pipe = await factory({
    executable: options.executable,
    args: ["app-server", "-c", "mcp_servers={}"],
    cwd: options.cwd,
    env: {},
    isolated: false,
    readOnly: true,
    runtimePaths: externalRuntimePaths(options.executable),
    onStdout: (data) => rpc.accept(data),
    onStderr: () => {},
  });
  rpc.attach(pipe);
  const onAbort = () => { try { rpc.close(); pipe.close(); } catch { /* ignore */ } };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await rpc.call("initialize", { clientInfo: { name: "kulo", version: KULO_VERSION }, capabilities: { experimentalApi: true } }, remainingMs());
    rpc.notify("initialized", {});
    const accountResp = await rpc.call("account/read", { refreshToken: false }, remainingMs()).catch(() => ({} as RpcValue));
    const account = obj(accountResp.account);
    const accountType = text(account.type);
    if (!accountType) {
      return {
        kind: "codex",
        status: approvedAgentEnv("codex").OPENAI_API_KEY ? "api_key_billing" : "unauthenticated",
        source: "live",
        fetchedAt: Date.now(),
        windows: [],
      };
    }
    if (accountType !== "chatgpt") {
      return {
        kind: "codex",
        status: "api_key_billing",
        source: "live",
        fetchedAt: Date.now(),
        windows: [],
      };
    }
    let rateLimitsResp: RpcValue;
    try {
      rateLimitsResp = await rpc.call("account/rateLimits/read", { excludeResetCreditDetails: true }, remainingMs());
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const msg = error instanceof Error ? error.message : String(error);
      if (code === -32602 || /-32602|invalid params/i.test(msg)) {
        rateLimitsResp = await rpc.call("account/rateLimits/read", {}, remainingMs());
      } else {
        throw error;
      }
    }
    const parsed = parseCodexRateLimitsSnapshot(rateLimitsResp, {
      source: "live",
      fetchedAt: Date.now(),
      accountPlanType: account.planType,
    });
    if (!parsed) {
      return {
        kind: "codex",
        status: "unavailable",
        source: "live",
        fetchedAt: Date.now(),
        windows: [],
        error: "Codex returned no quota buckets",
      };
    }
    return parsed;
  } catch (error) {
    return {
      kind: "codex",
      status: "unavailable",
      source: "live",
      fetchedAt: Date.now(),
      windows: [],
      error: sanitizeQuotaError(error instanceof Error ? error.message : "Codex quota query failed", options.redact),
    };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try { rpc.close(); } catch { /* ignore */ }
    try { pipe.close(); } catch { /* ignore */ }
    await (pipe.cleanup?.() ?? pipe.exited.then(() => true, () => false)).catch(() => false);
  }
}
