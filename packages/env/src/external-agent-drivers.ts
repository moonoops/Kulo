import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cleanSupervisedExecution, processFingerprint, supervisedCommand } from "./worker-supervisor.js";
import { defaultProtectedPaths } from "./isolation.js";
import { ExternalAgentRpc, type ExternalAgentPipeFactory, type RpcValue } from "./external-agent-rpc.js";
import { KULO_VERSION, type ExternalAgentBinding, type ExternalAgentCapabilities, type ExternalAgentKind, type ExternalAgentModelInfo, type ExternalWorkspaceMode } from "@kulo/protocol";

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
  sessionId?: string;
  timeoutMs: number;
  servers: Array<{name:string;url:string;headers?:Array<{name:string;value:string}>}>;
  pipe: ExternalAgentPipeFactory;
  event(type:"message"|"tool"|"permission"|"state"|"error", text:string):void;
  session(id:string):void;
  submitted():void;
  complete(state:"completed"|"failed"|"cancelled"|"uncertain", error?:string):void;
  permission(id:string,title:string,choices:Array<{id:string;label:string}>):Promise<string>;
  controlRoot?:string;
  projectId?:string;
  registerCleanup?:(cleanup:()=>Promise<boolean>)=>void;
}
export interface ExternalDriver { cancel():Promise<void>; close():void; cleanup?():Promise<boolean> }
export const externalCapabilities = (kind:ExternalAgentKind):ExternalAgentCapabilities => ({resume:["codex","claude-code","antigravity","dsh"].includes(kind),cancel:["codex","claude-code","antigravity","dsh"].includes(kind),models:["codex","claude-code","antigravity","dsh"].includes(kind),permissions:["codex","claude-code","antigravity","dsh"].includes(kind),collaboration:["codex","claude-code","antigravity","dsh"].includes(kind),terminalEvidence:kind==="grok-bot"?"observed":["dots","muse"].includes(kind)?"none":"native"});
export const kindBinary:Partial<Record<ExternalAgentKind,string>>={codex:"codex","claude-code":"claude",antigravity:"agy",dsh:"dsh"};
export function resolveExternalExecutable(kind:ExternalAgentKind,requested?:string):string|undefined {
  const binary=kindBinary[kind]; if(!binary) return;
  if(kind==="claude-code"&&!requested){
    try{const require=createRequire(import.meta.url);const sdkRequire=createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));const packaged=sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform==="win32"?".exe":""}`);fs.accessSync(packaged,fs.constants.X_OK);return fs.realpathSync(packaged);}catch{/* Fall back to the separately installed native CLI. */}
  }
  const directories=[...(process.env.PATH??"").split(path.delimiter),path.join(os.homedir(),".local","bin"),path.join(os.homedir(),".bun","bin"),"/opt/homebrew/bin","/usr/local/bin"].filter(Boolean);
  const nativeApps:Partial<Record<ExternalAgentKind,string[]>>={codex:["/Applications/Codex.app/Contents/Resources/codex","/Applications/Codex.app/Contents/Resources/bin/codex"],antigravity:["/Applications/Antigravity.app/Contents/Resources/app/bin/agy"]};
  const candidates=requested?[requested]:[...directories.flatMap(dir=>process.platform==="win32"?[path.join(dir,binary+".exe"),path.join(dir,binary)]:[path.join(dir,binary)]),...(process.platform==="darwin"?nativeApps[kind]??[]:[])];
  for(const value of candidates){
    if(!path.isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value)) {if(requested) throw new Error("Agent executable must be an absolute native executable path");continue;}
    try{const actual=fs.realpathSync(value);if(!fs.statSync(actual).isFile())continue;fs.accessSync(actual,fs.constants.X_OK);return actual;}catch(error){if(requested){
      const code=(error as NodeJS.ErrnoException).code;
      throw new Error(code==="ENOENT"||code==="ENOTDIR"?"Agent executable was not found on this device":code==="EACCES"||code==="EPERM"?"Agent executable is not executable on this device":"Agent executable is unavailable on this device");
    }}
  }
}
export function externalRuntimePaths(executable:string):string[]{
  const roots=[executable];let current=path.dirname(executable);
  // Only the installed package containing the executable is granted; its parent may contain account stores.
  for(let depth=0;depth<5&&current!==path.dirname(current);depth++,current=path.dirname(current)){
    if(fs.existsSync(path.join(current,"package.json"))){roots.push(current);break;}
  }
  if(fs.existsSync(process.execPath))roots.push(fs.realpathSync(process.execPath));
  return [...new Set(roots)];
}
export function nativeProxyEnv():Record<string,string>{return Object.fromEntries(["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"].flatMap(name=>process.env[name]?[[name,process.env[name]!]]:[]));}
export function approvedAgentEnv(kind:ExternalAgentKind):Record<string,string>{
  const keys=kind==="codex"?["OPENAI_API_KEY"]:kind==="dsh"?["DEEPSEEK_API_KEY"]:kind==="antigravity"?["GEMINI_API_KEY"]:["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN"];
  return Object.fromEntries(keys.flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]));
}
export function nativeAgentEnvironment():NodeJS.ProcessEnv{
  return Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^KULO_.*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PEER.*CONFIG)/i.test(name)));
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
export function createExternalPipeFactory(options:{controlRoot:string;projectId?:string}):ExternalAgentPipeFactory{
  return async spec=>{
    const managed=managedNativeProcess({executable:spec.executable,args:spec.args,cwd:spec.cwd,env:{...nativeAgentEnvironment(),...spec.env},controlRoot:options.controlRoot,projectId:options.projectId});const child=managed.child;
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
function isProtectedAcpPath(canonicalTarget: string, includeGitControl: boolean): boolean {
  const normalized = canonicalTarget.replace(/\\/g, "/");
  if (/(?:^|\/)(?:\.kulo-state|\.secure)(?:\/|$)/.test(normalized)) return true;
  if (/(?:^|\/)(?:connection\.json|devices\.json|runtime-token|(?:kulo|assistant)\.sqlite(?:-wal|-shm)?)$/.test(normalized)) return true;
  if (/\/Library\/Group Containers\/group\.com\.apple\.usernoted(?:\/|$)/.test(normalized)) return true;
  if (/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/0\/com\.apple\.notificationcenter(?:\/|$)/.test(normalized)) return true;
  if (includeGitControl && /(?:^|\/)\.git\/(?:hooks(?:\/|$)|config$)/.test(normalized)) return true;
  for (const entry of defaultProtectedPaths()) {
    if (isWithinAcpDir(canonicalTarget, entry)) return true;
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
        if(isProtectedAcpPath(target,false))throw new Error("ACP file read is denied for protected system or Kulo paths");
        const content=await fs.promises.readFile(target,"utf8");
        if(params.line===undefined&&params.limit===undefined)return{content};
        if(params.line!==undefined&&(!Number.isSafeInteger(params.line)||Number(params.line)<1)||params.limit!==undefined&&(!Number.isSafeInteger(params.limit)||Number(params.limit)<0))throw new Error("Invalid ACP line range");
        const lines=content.split("\n"),start=Number(params.line??1)-1;return{content:lines.slice(start,params.limit===undefined?undefined:start+Number(params.limit)).join("\n")};
      }
      if(method==="fs/write_text_file"){
        if(typeof params.path!=="string"||!path.isAbsolute(params.path)||typeof params.content!=="string")throw new Error("Invalid ACP file write");
        const target=canonicalAcpPath(params.path);
        if(isProtectedAcpPath(target,true))throw new Error("ACP file write is denied for protected system, git control, or Kulo paths");
        if(ctx.workspaceMode==="read_only"){
          const inNotes=Boolean(ctx.scratchNotesDir&&isWithinAcpDir(target,ctx.scratchNotesDir));
          if(!inNotes)throw new Error("Read-only external task cannot modify files outside its scratch notes directory");
        }else if(ctx.workspaceMode==="staged"){
          const inStaged=isWithinAcpDir(target,ctx.cwd);
          const inNotes=Boolean(ctx.scratchNotesDir&&isWithinAcpDir(target,ctx.scratchNotesDir));
          if(!inStaged&&!inNotes)throw new Error("Staged external task cannot modify files outside its isolated staged workspace or scratch notes directory");
        }
        await fs.promises.writeFile(target,params.content,"utf8");return{};
      }
      if(method==="terminal/create"){
        if(ctx.workspaceMode==="read_only")throw new Error("Read-only external task cannot spawn unrestricted ACP terminals");
        if(typeof params.command!=="string"||!params.command||params.args!==undefined&&(!Array.isArray(params.args)||params.args.some(value=>typeof value!=="string")))throw new Error("Invalid ACP terminal command");
        if(!ctx.controlRoot)throw new Error("ACP terminal process supervision is unavailable");
        const env:NodeJS.ProcessEnv={...nativeAgentEnvironment()};for(const item of Array.isArray(params.env)?params.env:[]){const value=obj(item);if(typeof value.name!=="string"||typeof value.value!=="string")throw new Error("Invalid ACP terminal environment");env[value.name]=value.value;}
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
function modelsFromConfig(session:RpcValue):{models:ExternalAgentModelInfo[];configId:string|undefined}{
  const rawModels:Array<{id:string;name:string}>=[];let configId:string|undefined;let currentModel:string|undefined;
  const efforts:string[]=[];
  const collectModels=(options:unknown)=>{for(const item of Array.isArray(options)?options:[]){const value=obj(item);if(typeof value.value==="string")rawModels.push({id:value.value,name:text(value.name)||value.value});else collectModels(value.options);}};
  const collectEfforts=(options:unknown)=>{for(const item of Array.isArray(options)?options:[]){const value=obj(item);if(typeof value.value==="string"){if(value.value&&!efforts.includes(value.value))efforts.push(value.value);}else collectEfforts(value.options);}};
  for(const option of Array.isArray(session.configOptions)?session.configOptions:[]){
    const row=obj(option);
    if(!configId&&(row.category==="model"||row.id==="model")){configId=text(row.id)||undefined;currentModel=text(row.currentValue)||undefined;collectModels(row.options);}
    if(!efforts.length&&(row.category==="thought_level"||/^(?:thinking|thinking_level|reasoning_effort|effort)$/.test(text(row.id))))collectEfforts(row.options);
  }
  const models:ExternalAgentModelInfo[]=rawModels.map(item=>({...item,...(efforts.length?{efforts:[...efforts]}:{}),...(currentModel&&item.id===currentModel?{isDefault:true}:{})}));
  return {models,configId};
}
export async function connectAcp(ctx:ExternalDriverContext,probe=false):Promise<{driver:ExternalDriver;models:ExternalAgentModelInfo[]}>{
  let sessionId=ctx.sessionId;let submitted=false;let closed=false;let cancelRequested=false;
  const tools=new Map<string,string>();
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
    if(!option)return{outcome:{outcome:"cancelled"}};
    return{outcome:{outcome:"selected",optionId:choice}};
  },notification:(method,params)=>{
    if(method!=="session/update"||params.sessionId!==sessionId||!submitted)return;
    const update=obj(params.update),kind=text(update.sessionUpdate);
    if(kind==="agent_message_chunk"){const content=obj(update.content);if(content.type==="text")ctx.event("message",text(content.text));}
    if(kind==="tool_call"||kind==="tool_call_update"){const id=text(update.toolCallId);if(update.title)tools.set(id,text(update.title));ctx.event("tool",text(update.title)||tools.get(id)||"Tool update");}
  },failed:error=>{if(!closed&&submitted)ctx.complete("uncertain",error.message);}});
  const pipe=await ctx.pipe({executable:ctx.executable,args:ctx.binding.kind==="dsh"?["--profile","acp"]:["acp","--process-per-session"],cwd:ctx.cwd,env:{},isolated:false,readOnly:ctx.readOnly,runtimePaths:externalRuntimePaths(ctx.executable),onStdout:data=>rpc.accept(data),onStderr:data=>ctx.event("error",Buffer.from(data).toString("utf8"))});rpc.attach(pipe);
  const driver:ExternalDriver={cancel:async()=>{cancelRequested=true;if(sessionId)rpc.notify("session/cancel",{sessionId});},close:()=>{if(closed)return;closed=true;try{if(sessionId)rpc.notify("session/close",{sessionId});}catch{/* The protocol may already have ended. */}finally{rpc.close();}},cleanup:async()=>{const processes=await local.close();return (await(pipe.cleanup?.()??pipe.exited.then(()=>true,()=>false)))&&processes;}};
  try{
    const init=await rpc.call("initialize",{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:true},clientInfo:{name:"kulo",version:KULO_VERSION}});
    const capabilities=obj(init.agentCapabilities);const mcpServers=obj(capabilities.mcpCapabilities).http?ctx.servers.map(server=>({type:"http",name:`kulo-${randomUUID()}-${server.name}`,url:server.url,headers:server.headers??[]})):[];
    if(ctx.servers.length&&!mcpServers.length)ctx.event("state","This client does not advertise HTTP MCP; continuing with its native tools");
    let session:RpcValue;
    if(sessionId){if(!capabilities.loadSession&&!obj(capabilities.sessionCapabilities).resume)throw new Error("Installed agent does not support native session resume");session=await rpc.call(obj(capabilities.sessionCapabilities).resume?"session/resume":"session/load",{sessionId,cwd:ctx.cwd,mcpServers});}
    else session=await rpc.call("session/new",{cwd:ctx.cwd,mcpServers});
    sessionId=text(session.sessionId)||sessionId;if(!sessionId)throw new Error("Agent did not return a native session ID");ctx.session(sessionId);
    const {models,configId}=modelsFromConfig(session);
    if(ctx.modelId){if(!configId||!models.some(model=>model.id===ctx.modelId))throw new Error("Selected model is not advertised by this local agent");const updated=await rpc.call("session/set_config_option",{sessionId,configId,value:ctx.modelId});if(Array.isArray(updated.configOptions))session={...session,configOptions:updated.configOptions};}
    if(ctx.thinkingLevel){
      const options=(Array.isArray(session.configOptions)?session.configOptions:[]).map(obj);
      const option=options.find(value=>value.category==="thought_level"||/^(?:thinking|thinking_level|reasoning_effort|effort)$/.test(text(value.id)));
      const values:RpcValue[]=[];const collect=(items:unknown)=>{for(const item of Array.isArray(items)?items:[]){const row=obj(item);if(typeof row.value==="string")values.push(row);else collect(row.options);}};collect(option?.options);
      if(!option||!values.some(value=>value.value===ctx.thinkingLevel))throw new Error("Selected thinking level is not advertised by this local agent");
      await rpc.call("session/set_config_option",{sessionId,configId:option.id,value:ctx.thinkingLevel});
    }
    if(!probe){submitted=true;ctx.submitted();void rpc.call("session/prompt",{sessionId,prompt:[{type:"text",text:ctx.prompt}]},ctx.timeoutMs).then(result=>{const reason=text(result.stopReason);if(reason==="cancelled")ctx.complete("cancelled");else if(["end_turn","max_tokens","max_turn_requests","refusal"].includes(reason))ctx.complete("completed");else ctx.complete(cancelRequested?"uncertain":"failed",`Unexpected ACP stop reason: ${reason||"missing"}`);driver.close();},error=>{ctx.complete("uncertain",error instanceof Error?error.message:"Agent prompt failed");driver.close();});}
    return{driver,models};
  }catch(error){driver.close();throw error;}
}

export async function connectCodex(ctx:ExternalDriverContext,probe=false):Promise<{driver:ExternalDriver;models:ExternalAgentModelInfo[];authenticated:boolean|null}>{
  let sessionId=ctx.sessionId;let turnId:string|undefined;let submitted=false;let closed=false;
  const rpc=new ExternalAgentRpc({request:async(method,params,id)=>{
    if(params.threadId&&params.threadId!==sessionId)throw new Error("Stale Codex thread");
    if(method==="item/commandExecution/requestApproval"||method==="item/fileChange/requestApproval"){
      const decisions=Array.isArray(params.availableDecisions)?params.availableDecisions:["accept","acceptForSession","decline","cancel"];
      const choices=decisions.map((decision,index)=>({id:String(index),label:typeof decision==="string"?decision:JSON.stringify(decision)}));
      const choice=await ctx.permission(`codex:${createHash("sha256").update(String(id)).digest("hex")}`,text(params.reason)||text(params.command)||"Codex tool approval",choices);
      const selected=choices.findIndex(value=>value.id===choice);if(selected<0)throw new Error("Codex approval input was cancelled");
      return{decision:decisions[selected]};
    }
    if(method==="item/permissions/requestApproval"){
      const choice=await ctx.permission(`codex:${createHash("sha256").update(String(id)).digest("hex")}`,text(params.reason)||JSON.stringify(params.permissions),[{id:"turn",label:"Allow for this turn"},{id:"session",label:"Allow for this session"},{id:"deny",label:"Reject"}]);
      return{permissions:choice==="turn"||choice==="session"?params.permissions:{},scope:choice==="session"?"session":"turn"};
    }
    throw new Error("Unsupported Codex request");
  },notification:(method,params)=>{
    if(params.threadId&&params.threadId!==sessionId)return;
    if(method==="item/agentMessage/delta")ctx.event("message",text(params.delta));
    if(method==="item/started"||method==="item/completed"){const item=obj(params.item);if(item.type!=="agentMessage")ctx.event("tool",text(item.type)||"Tool update");}
    if(method==="turn/started")turnId=text(obj(params.turn).id)||turnId;
    if(method==="turn/completed"){const turn=obj(params.turn);const status=text(turn.status);ctx.complete(status==="completed"?"completed":status==="interrupted"?"cancelled":"failed",text(obj(turn.error).message)||undefined);driver.close();}
    if(method==="error"&&params.willRetry!==true)ctx.event("error",text(obj(params.error).message)||"Codex reported an error");
  },failed:error=>{if(!closed&&submitted)ctx.complete("uncertain",error.message);}});
  const pipe=await ctx.pipe({executable:ctx.executable,args:["app-server"],cwd:ctx.cwd,env:{},isolated:false,readOnly:ctx.readOnly,runtimePaths:externalRuntimePaths(ctx.executable),onStdout:data=>rpc.accept(data),onStderr:data=>ctx.event("error",Buffer.from(data).toString("utf8"))});rpc.attach(pipe);
  const driver:ExternalDriver={cancel:async()=>{if(!sessionId||!turnId)throw new Error("Codex turn is not yet available to cancel");await rpc.call("turn/interrupt",{threadId:sessionId,turnId});},close:()=>{closed=true;rpc.close();},cleanup:()=>pipe.cleanup?.()??pipe.exited.then(()=>true,()=>false)};
  try{
    await rpc.call("initialize",{clientInfo:{name:"kulo",version:KULO_VERSION},capabilities:{experimentalApi:true}});rpc.notify("initialized",{});
    const modelResult=await rpc.call("model/list",{});const catalog=(Array.isArray(modelResult.data)?modelResult.data:[]).map(obj);
    const models:ExternalAgentModelInfo[]=catalog.filter(value=>typeof value.id==="string").map(value=>{
      const efforts=(Array.isArray(value.supportedReasoningEfforts)?value.supportedReasoningEfforts:[]).map(item=>text(obj(item).reasoningEffort)).filter(Boolean);
      return{id:text(value.model)||text(value.id),name:text(value.displayName)||text(value.id),...(efforts.length?{efforts:[...new Set(efforts)]}:{}),...(value.isDefault===true?{isDefault:true}:{})};
    });
    const account=await rpc.call("account/read",{refreshToken:false}).catch(()=>({}));
    const authenticated=Boolean(approvedAgentEnv("codex").OPENAI_API_KEY||obj(account).account);
    if(ctx.modelId&&models.length&&!models.some(model=>model.id===ctx.modelId))throw new Error("Selected model is not advertised by Codex");
    if(!probe){
      const mcp_servers=Object.fromEntries(ctx.servers.map(server=>[`kulo-${randomUUID()}-${server.name}`,{enabled:true,url:server.url,http_headers:Object.fromEntries((server.headers??[]).map(item=>[item.name,item.value]))}]));
      const thread=await rpc.call(sessionId?"thread/resume":"thread/start",{...(sessionId?{threadId:sessionId}:{}),cwd:ctx.cwd,...(ctx.modelId?{model:ctx.modelId}:{}),...(ctx.servers.length?{config:{mcp_servers}}:{})});
      if(ctx.thinkingLevel){
        const selected=catalog.find(value=>(value.model??value.id)===(ctx.modelId??thread.model))??(!ctx.modelId?catalog.find(value=>value.isDefault):undefined);
        if(!selected||!(Array.isArray(selected.supportedReasoningEfforts)?selected.supportedReasoningEfforts:[]).some(value=>obj(value).reasoningEffort===ctx.thinkingLevel))throw new Error("Selected thinking level is not advertised by Codex for this model");
      }
      sessionId=text(obj(thread.thread).id);if(!sessionId)throw new Error("Codex did not return a native thread ID");ctx.session(sessionId);
      submitted=true;ctx.submitted();const turn=await rpc.call("turn/start",{threadId:sessionId,cwd:ctx.cwd,input:[{type:"text",text:ctx.prompt,text_elements:[]}],...(ctx.modelId?{model:ctx.modelId}:{}),...(ctx.thinkingLevel?{effort:ctx.thinkingLevel}:{})});turnId=text(obj(turn.turn).id)||turnId;
    }
    return{driver,models,authenticated};
  }catch(error){driver.close();throw error;}
}
