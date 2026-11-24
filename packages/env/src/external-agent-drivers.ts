import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cleanSupervisedExecution, processFingerprint, supervisedCommand } from "./worker-supervisor.js";
import { defaultProtectedPaths } from "./isolation.js";
import { ExternalAgentRpc, type ExternalAgentPipeFactory, type RpcValue } from "./external-agent-rpc.js";
import { isBlockedCustomAcpExecutableName, isBundledClaudeSdkExecutable, isSupportedExternalAgentKind, KULO_VERSION, validateCustomAcpArgs, type ExecutionTrustMode, type ExternalAgentBinding, type ExternalAgentCapabilities, type ExternalAgentInputAttachment, type ExternalAgentKind, type ExternalAgentModelInfo, type ExternalAgentQuotaProbeResult, type ExternalWorkspaceMode } from "@kulo/protocol";
import { ACP_FLAVORS, acpReadableSkillSubdirs, extractModelsFromAcpInitialize, extractModelsFromAcpModelState, getAcpFlavor, isSensitiveCredentialFilename, sortEffortTokens } from "./external-agent-acp.js";
import { filterNativeAgentEnvironment, type NativeAgentEnvOptions } from "./external-agent-env.js";
import { resolveCrossPlatformSpawn } from "./platform-process.js";
import { prependKuloInstructions, resolveSafeExternalImages } from "./external-agent-validation.js";
import {
  augmentedNativePath,
  isValidAbsolutePathSegment,
  KULO_CORE_STATE_SENSITIVE_NAMES,
  parseLoginShellPathOutput,
  primeLoginShellPath,
  resolveLoginShellPath,
} from "./trusted-execution.js";
export {
  augmentedNativePath,
  parseLoginShellPathOutput,
  primeLoginShellPath,
  resolveLoginShellPath,
};

export interface ExternalDriverContext {
  binding: ExternalAgentBinding;
  executable: string;
  cwd: string;
  workspaceMode?: ExternalWorkspaceMode;
  scratchNotesDir?: string;
  inputsDir?: string;
  overlapsProtected?: (canonicalPath: string) => boolean;
  readOnly: boolean;
  prompt: string;
  developerInstructions?: string;
  attachments?: ExternalAgentInputAttachment[];
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
  trustMode?: ExecutionTrustMode;
  blockedEnvNames?: Iterable<string>;
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
    : [...directories.flatMap(dir => process.platform === "win32" ? [path.join(dir, binary + ".exe"), path.join(dir, binary + ".cmd"), path.join(dir, binary)] : [path.join(dir, binary)]), ...extraPaths];
  for (const value of candidates) {
    if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
      if (effectiveRequested) throw new Error("Agent executable must be an absolute native executable path");
      continue;
    }
    try {
      const actual = fs.realpathSync(value);
      if (!fs.statSync(actual).isFile()) continue;
      fs.accessSync(actual, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
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
  const spec=resolveCrossPlatformSpawn(options.executable,options.args,{env:options.env});
  const command=supervisedCommand([spec.command,...spec.args],control,undefined,{windowsVerbatimArguments:spec.windowsVerbatimArguments});
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
export function createExternalPipeFactory(options:{controlRoot:string;projectId?:string;kind?:ExternalAgentKind;trustMode?:ExecutionTrustMode;blockedEnvNames?:Iterable<string>}):ExternalAgentPipeFactory{
  return async spec=>{
    const managed=managedNativeProcess({executable:spec.executable,args:spec.args,cwd:spec.cwd,env:{...nativeAgentEnvironment(options.kind,{trustMode:options.trustMode,blockedEnvNames:options.blockedEnvNames}),...spec.env},controlRoot:options.controlRoot,projectId:options.projectId});const child=managed.child;
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
export function isProtectedAcpPath(canonicalTarget: string, includeGitControl: boolean, currentKind?: ExternalAgentKind, trustMode?: ExecutionTrustMode): boolean {
  const normalized = canonicalTarget.replace(/\\/g, "/");
  if (/(?:^|\/)(?:\.kulo-state|\.secure)(?:\/|$)/.test(normalized)) return true;
  if (KULO_CORE_STATE_SENSITIVE_NAMES.includes(path.basename(canonicalTarget) as (typeof KULO_CORE_STATE_SENSITIVE_NAMES)[number])) return true;
  if (/(?:^|\/)(?:connection\.json|connections\.json|devices\.json|runtime-token|node-identity\.json|cluster-membership\.json|cluster-transition\.json|cluster-sync-meta\.json|sync-key\.enc|vault-envelope\.enc|(?:kulo|assistant|memory)\.sqlite(?:-wal|-shm|\.(?:failover-paused|redaction-pending))?)$/.test(normalized)) return true;
  if (trustMode === "trusted") return false;
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
        if(isProtectedAcpPath(target,false,ctx.binding.kind,ctx.trustMode)||ctx.overlapsProtected?.(target))throw new Error("ACP file read is denied for protected system or Kulo paths");
        const content=await fs.promises.readFile(target,"utf8");
        if(params.line===undefined&&params.limit===undefined)return{content};
        if(params.line!==undefined&&(!Number.isSafeInteger(params.line)||Number(params.line)<1)||params.limit!==undefined&&(!Number.isSafeInteger(params.limit)||Number(params.limit)<0))throw new Error("Invalid ACP line range");
        const lines=content.split("\n"),start=Number(params.line??1)-1;return{content:lines.slice(start,params.limit===undefined?undefined:start+Number(params.limit)).join("\n")};
      }
      if(method==="fs/write_text_file"){
        if(typeof params.path!=="string"||!path.isAbsolute(params.path)||typeof params.content!=="string")throw new Error("Invalid ACP file write");
        const target=canonicalAcpPath(params.path);
        if(isProtectedAcpPath(target,true,ctx.binding.kind,ctx.trustMode)||ctx.overlapsProtected?.(target))throw new Error("ACP file write is denied for protected system, git control, or Kulo paths");
        if(ctx.readOnly||ctx.workspaceMode==="read_only"){
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
        if(ctx.readOnly||ctx.workspaceMode==="read_only")throw new Error("Read-only external task cannot spawn unrestricted ACP terminals");
        if(typeof params.command!=="string"||!params.command||params.args!==undefined&&(!Array.isArray(params.args)||params.args.some(value=>typeof value!=="string")))throw new Error("Invalid ACP terminal command");
        if(!ctx.controlRoot)throw new Error("ACP terminal process supervision is unavailable");
        const env:NodeJS.ProcessEnv={...nativeAgentEnvironment(ctx.binding.kind,{terminal:true,trustMode:ctx.trustMode,blockedEnvNames:ctx.blockedEnvNames})};for(const item of Array.isArray(params.env)?params.env:[]){const value=obj(item);if(typeof value.name!=="string"||typeof value.value!=="string")throw new Error("Invalid ACP terminal environment");env[value.name]=value.value;}
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
  const effectiveReadOnly = Boolean(ctx.readOnly || ctx.workspaceMode === "read_only");
  let launchArgs: string[];
  if (ctx.binding.kind === "acp") {
    const validated = ctx.binding.acpArgs !== undefined ? validateCustomAcpArgs(ctx.binding.acpArgs) : { ok: true as const, value: [] };
    if (!validated.ok) throw new Error(validated.error);
    launchArgs = validated.value;
  } else if (flavor) {
    launchArgs = [...(probe ? (flavor.probeArgs ?? flavor.acpArgs) : effectiveReadOnly ? (flavor.readOnlyArgs ?? flavor.acpArgs) : flavor.acpArgs)];
  } else {
    launchArgs = ["acp", "--process-per-session"];
  }

  const isResumingSession = Boolean(ctx.sessionId);
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
  const pipe=await ctx.pipe({executable:ctx.executable,args:launchArgs,cwd:ctx.cwd,env:{},isolated:false,readOnly:effectiveReadOnly,runtimePaths:externalRuntimePaths(ctx.executable),onStdout:data=>rpc.accept(data),onStderr:data=>ctx.event("error",Buffer.from(data).toString("utf8"))});rpc.attach(pipe);
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
    const capabilities=obj(init.agentCapabilities);const mcpServers=obj(capabilities.mcpCapabilities).http?ctx.servers.map(server=>({type:"http",name:server.name,url:server.url,headers:server.headers??[]})):[];
    const noHttpMcpFallback=ctx.servers.length>0&&!mcpServers.length;
    if(noHttpMcpFallback)ctx.event("state","This client does not advertise HTTP MCP; continuing with its native tools");
    const supportsSessionSystemPrompt=Boolean(obj(capabilities.sessionCapabilities).systemPrompt);
    const systemPromptParam=supportsSessionSystemPrompt&&ctx.developerInstructions?.trim()?{systemPrompt:{mode:"append",text:ctx.developerInstructions.trim()}}:{};
    let session:RpcValue;
    if(sessionId){
      const canResume = Boolean(obj(capabilities.sessionCapabilities).resume);
      if(!capabilities.loadSession&&!canResume)throw new Error("Installed agent does not support native session resume");
      if (!canResume && flavor?.sessionLoadReplayIdleReadiness) {
        let idleTimer: NodeJS.Timeout | undefined;
        const loadPromise = rpc.call("session/load",{sessionId,cwd:ctx.cwd,mcpServers,...systemPromptParam});
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
        session=await rpc.call(canResume?"session/resume":"session/load",{sessionId,cwd:ctx.cwd,mcpServers,...systemPromptParam});
      }
    } else {
      session=await rpc.call("session/new",{cwd:ctx.cwd,mcpServers,...systemPromptParam});
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
        } else if (reason === "end_turn") {
          ctx.complete("completed");
        } else if (["max_tokens", "max_turn_requests", "refusal"].includes(reason)) {
          ctx.event("state", `External agent stopped with reason: ${reason}`);
          ctx.complete("completed", errorMessage || `External agent stopped early (${reason})`);
        } else ctx.complete(cancelRequested ? "uncertain" : "failed", errorMessage || `Unexpected ACP stop reason: ${reason || "missing"}`);
        driver.close();
      };
      let promptText = !supportsSessionSystemPrompt && !isResumingSession
        ? prependKuloInstructions(ctx.developerInstructions, ctx.prompt)
        : ctx.prompt;
      if (noHttpMcpFallback) {
        promptText = `${promptText}\n\nNote: kulo-task HTTP MCP tools are unavailable in this client; deliver your full findings and status directly in your final response.`;
      }
      const promptBlocks: RpcValue[] = [{ type: "text", text: promptText }];
      if (Boolean(obj(capabilities.promptCapabilities).image) && ctx.attachments?.length) {
        // Keep combined base64 payload safely under ExternalAgentRpc's 8 MiB inbound replay frame cap.
        const images = resolveSafeExternalImages({
          attachments: ctx.attachments,
          expectedInputsDir: ctx.inputsDir,
          overlapsProtected: ctx.overlapsProtected,
          maxCount: 4,
          maxFileBytes: 3 * 1024 * 1024,
          maxTotalBytes: 4 * 1024 * 1024,
          readBytes: true,
          onSkip: (reason) => ctx.event("state", reason),
        });
        for (const img of images) {
          promptBlocks.push({ type: "image", mimeType: img.mimeType, data: img.base64! });
        }
      }
      const promptParams: RpcValue = { sessionId, prompt: promptBlocks };
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

export { connectCodex, probeCodexQuota } from "./external-agent-codex.js";
