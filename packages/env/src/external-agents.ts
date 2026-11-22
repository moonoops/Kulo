import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { EXTERNAL_AGENT_KINDS, isPersonalExternalAgentKind, isQuotaSupportedExternalAgentKind, redactSensitiveText, validateCustomAcpArgs, type ExternalAgentBinding, type ExternalAgentDetection, type ExternalAgentKind, type ExternalAgentPendingReport, type ExternalAgentPendingReportFile, type ExternalAgentQuotaProbeResult, type ExternalAgentRequest, type ExternalAgentResponse, type ExternalAgentRun, type ExternalAgentUncertainReason, type ExternalWorkspaceMode, type ReadOnlyViolationSummary, type StagedWorkspaceDiffSummary, type WorkerExecutionPhase } from "@kulo/protocol";
import { canonicalExecutionPath } from "./isolation.js";
import { cleanupRecordedExecutions, hasOrphanedExecution } from "./worker-supervisor.js";
import { ProjectDirectoryRegistry } from "./project-directories.js";
import { getAcpFlavor, probeGrokQuota, type GrokQuotaCliRunner } from "./external-agent-acp.js";
import { augmentedNativePath, connectAcp, connectCodex, createExternalPipeFactory, externalCapabilities, externalRuntimePaths, nativeAgentEnvironment, primeLoginShellPath, probeCodexQuota, resolveExternalExecutable, type ExternalDriver, type ExternalDriverContext } from "./external-agent-drivers.js";
import { connectGrok, detectGrok } from "./external-agent-grok.js";
import { connectClaude, probeClaudeQuota } from "./external-agent-claude.js";
import { startExternalAgentMcp, type ExternalAgentMcpInvocation, type ExternalAgentMcpServer } from "./external-agent-mcp.js";
import { isValidQuotaProbeResult, mergeQuotaProbeResults, sanitizeQuotaError } from "./external-agent-quota.js";
import type { ExternalAgentPipeFactory } from "./external-agent-rpc.js";
import { SAFE_HOST_GIT_ARGS, applyStagedChanges, cloneStagedWorkspace, computeStagedDiff, safeHostGitEnv, type WorkspaceManifest } from "./staged-workspace.js";

export type ExternalAgentToolHandler=(invocation:ExternalAgentMcpInvocation & {envId:string})=>Promise<unknown>;
type RunRequest=Extract<ExternalAgentRequest,{operation:"run"}>;
type DirectReadOnlySnapshot =
  | { kind: "git"; entries: Map<string, string> }
  | { kind: "stat"; files: Map<string, string> }
  | { kind: "skipped" };
interface StoredStagedTask {version:1;taskId:string;projectId?:string;sourceDir:string;stagedDir:string;scratchNotesDir:string;workspaceMode:ExternalWorkspaceMode;baseline:WorkspaceManifest;appliedAt?:number}
interface StoredRun {version:1;managedProcesses?:boolean;fingerprint:string;cwd:string;executionCwd?:string;workspaceMode?:ExternalWorkspaceMode;scratchNotesDir?:string;executable:string;projectId?:string;directoryId?:string;grantRevision?:number;readOnly:boolean;pendingReports?:ExternalAgentPendingReport[];run:ExternalAgentRun}
interface LiveRun {stored:StoredRun;deadline?:number;lastHeartbeatAt?:number;driver?:ExternalDriver;mcp?:ExternalAgentMcpServer;submitted:boolean;launched?:boolean;readOnlyBeforeSnapshot?:DirectReadOnlySnapshot;cleanups?:Array<()=>Promise<boolean>>;terminalWaiters?:Set<()=>void>;timer?:NodeJS.Timeout;permissions:Map<string,{choices:Set<string>;resolve:(value:string)=>void}>}
const WORKER_PHASES = new Set<WorkerExecutionPhase>(["starting", "investigating", "editing", "verifying", "responding", "waiting_permission"]);
const UNCERTAIN_REASONS = new Set<ExternalAgentUncertainReason>(["timeout", "disconnect", "env_restart", "closed"]);
const READ_ONLY_SNAPSHOT_MAX_FILES = 10_000;
const READ_ONLY_IGNORED_DIRS = new Set([".git", ".kulo-env", "node_modules", ".DS_Store", "dist", "coverage", "target", ".next", ".nuxt", ".turbo", ".parcel-cache", ".vite", ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__", ".venv"]);
const READ_ONLY_IGNORED_SUFFIXES = [".tsbuildinfo", ".pyc", ".pyo"];
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==="object"&&!Array.isArray(value);}
function id(value:unknown):value is string{return typeof value==="string"&&/^[a-zA-Z0-9:_.-]{1,200}$/.test(value)&&!["__proto__","constructor","prototype"].includes(value);}
function optionalString(value:unknown,max=8192):boolean{return value===undefined||typeof value==="string"&&value.length>0&&value.length<=max&&!/[\x00]/.test(value);}
function binding(value:unknown):value is ExternalAgentBinding{
  if(!object(value)||!EXTERNAL_AGENT_KINDS.includes(value.kind as ExternalAgentKind)||!id(value.envId)||!optionalString(value.executable)||!optionalString(value.agentRef)||!optionalString(value.cdpUrl))return false;
  if(value.acpArgs!==undefined){
    if(value.kind!=="acp")return false;
    if(!validateCustomAcpArgs(value.acpArgs).ok)return false;
  }
  return true;
}
function validPathList(value:unknown,maxItems=5000,maxLen=4096):boolean{
  return Array.isArray(value)&&value.length<=maxItems&&value.every(item=>typeof item==="string"&&item.length>0&&item.length<=maxLen);
}
function validDiffSummary(value:unknown):value is StagedWorkspaceDiffSummary{
  if(!object(value)||typeof value.hasChanges!=="boolean"||typeof value.truncated!=="boolean"||typeof value.unifiedPreview!=="string"||value.unifiedPreview.length>64_000)return false;
  if(!["added","modified","deleted","conflictFiles"].every(key=>validPathList(value[key])))return false;
  return ["emptyDirsAdded","emptyDirsDeleted","modeChanged","sensitivePaths"].every(key=>value[key]===undefined||validPathList(value[key]));
}
function validReadOnlyViolation(value:unknown):value is ReadOnlyViolationSummary{
  return object(value)&&validPathList(value.mutatedPaths,50,4096)&&typeof value.totalCount==="number"&&Number.isSafeInteger(value.totalCount)&&value.totalCount>=1&&typeof value.discardedFromClone==="boolean";
}
function validPendingReportFile(value:unknown):value is ExternalAgentPendingReportFile{
  return object(value)&&typeof value.originalPath==="string"&&value.originalPath.length>0&&value.originalPath.length<=4096&&typeof value.snapshotPath==="string"&&value.snapshotPath.length>0&&value.snapshotPath.length<=4096&&optionalString(value.name,240)&&optionalString(value.mimeType,120)&&optionalString(value.caption,500)&&typeof value.size==="number"&&Number.isSafeInteger(value.size)&&value.size>=0&&value.size<=25*1024*1024&&typeof value.sha256==="string"&&/^[a-f0-9]{64}$/.test(value.sha256);
}
function validPendingReport(value:unknown):value is ExternalAgentPendingReport{
  return object(value)&&id(value.reportId)&&["progress","blocked","ready","failed"].includes(String(value.state))&&typeof value.summary==="string"&&value.summary.length>0&&value.summary.length<=4000&&(value.deliverable===undefined||typeof value.deliverable==="string"&&value.deliverable.length<=60_000)&&(value.question===undefined||typeof value.question==="string"&&value.question.length<=2000)&&(value.files===undefined||Array.isArray(value.files)&&value.files.length<=16&&value.files.every(validPendingReportFile))&&typeof value.at==="number"&&Number.isFinite(value.at);
}
function isIgnoredReadOnlyPath(relPosix:string,scratchRel?:string):boolean{
  if(scratchRel&&(relPosix===scratchRel||relPosix.startsWith(`${scratchRel}/`)))return true;
  const parts=relPosix.split("/");
  if(parts.some(seg=>READ_ONLY_IGNORED_DIRS.has(seg)))return true;
  const base=parts[parts.length-1]??"";
  return READ_ONLY_IGNORED_SUFFIXES.some(suffix=>base.endsWith(suffix));
}
function scratchRelativeToCwd(cwd:string,scratchNotesDir?:string):string|undefined{
  if(!scratchNotesDir)return undefined;
  try{
    const root=fs.existsSync(cwd)?fs.realpathSync(cwd):path.resolve(cwd);
    const scratch=fs.existsSync(scratchNotesDir)?fs.realpathSync(scratchNotesDir):path.resolve(scratchNotesDir);
    const rel=path.relative(root,scratch);
    if(!rel||rel===".."||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))return undefined;
    return rel.split(path.sep).join("/");
  }catch{return undefined;}
}
function parseGitPorcelainStatus(stdout:string,scratchRel?:string):Map<string,string>{
  const map=new Map<string,string>();
  for(const rawLine of stdout.split(/\r?\n/)){
    if(rawLine.length<4)continue;
    const status=rawLine.slice(0,2);
    let filePath=rawLine.slice(3).trim();
    const renameIdx=filePath.lastIndexOf(" -> ");
    if(renameIdx>=0)filePath=filePath.slice(renameIdx+4);
    if(filePath.startsWith('"')&&filePath.endsWith('"'))filePath=filePath.slice(1,-1);
    const relPosix=filePath.replace(/\\/g,"/");
    if(!relPosix||isIgnoredReadOnlyPath(relPosix,scratchRel))continue;
    map.set(relPosix,status);
  }
  return map;
}
function captureDirectReadOnlySnapshot(cwd:string,scratchNotesDir?:string):DirectReadOnlySnapshot{
  const scratchRel=scratchRelativeToCwd(cwd,scratchNotesDir);
  if(fs.existsSync(path.join(cwd,".git"))){
    const res=spawnSync("git",[...SAFE_HOST_GIT_ARGS,"-C",cwd,"status","--porcelain=v1","-uall"],{encoding:"utf8",env:safeHostGitEnv(),timeout:10_000,maxBuffer:4*1024*1024});
    if(!res.error&&res.status===0){
      return{kind:"git",entries:parseGitPorcelainStatus(res.stdout,scratchRel)};
    }
  }
  const files=new Map<string,string>();
  let exceeded=false;
  const walk=(dir:string,relDir:string)=>{
    if(exceeded)return;
    let entries:fs.Dirent[];
    try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const entry of entries){
      if(exceeded)return;
      const rel=relDir?`${relDir}/${entry.name}`:entry.name;
      if(isIgnoredReadOnlyPath(rel,scratchRel))continue;
      const full=path.join(dir,entry.name);
      let stat:fs.Stats;
      try{stat=fs.lstatSync(full);}catch{continue;}
      if(stat.isDirectory()&&!stat.isSymbolicLink()){
        walk(full,rel);
      }else if(stat.isFile()||stat.isSymbolicLink()){
        if(files.size>=READ_ONLY_SNAPSHOT_MAX_FILES){exceeded=true;return;}
        files.set(rel,stat.isSymbolicLink()?`symlink:${fs.readlinkSync(full)}`:`${stat.size}:${Math.trunc(stat.mtimeMs)}`);
      }
    }
  };
  walk(cwd,"");
  return exceeded?{kind:"skipped"}:{kind:"stat",files};
}
function diffDirectReadOnlySnapshot(before:DirectReadOnlySnapshot,cwd:string,scratchNotesDir?:string):string[]{
  if(before.kind==="skipped")return[];
  const after=captureDirectReadOnlySnapshot(cwd,scratchNotesDir);
  if(after.kind!==before.kind)return[];
  const mutated:string[]=[];
  if(before.kind==="git"&&after.kind==="git"){
    const keys=new Set([...before.entries.keys(),...after.entries.keys()]);
    for(const key of keys){
      if(before.entries.get(key)!==after.entries.get(key))mutated.push(key);
    }
  }else if(before.kind==="stat"&&after.kind==="stat"){
    const keys=new Set([...before.files.keys(),...after.files.keys()]);
    for(const key of keys){
      if(before.files.get(key)!==after.files.get(key))mutated.push(key);
    }
  }
  return mutated.sort();
}
function inferPhaseFromEvent(type:ExternalAgentRun["events"][number]["type"],text:string,hasPendingPermissions:boolean,current?:WorkerExecutionPhase):WorkerExecutionPhase{
  if(hasPendingPermissions||type==="permission")return"waiting_permission";
  if(type==="message")return"responding";
  if(type==="tool"){
    if(/\b(test|vitest|jest|pytest|lint|eslint|build|typecheck|tsc|cargo\s+test|go\s+test|npm\s+test|pnpm\s+(?:test|build|typecheck|lint))\b/i.test(text))return"verifying";
    if(/\b(write|edit|patch|apply_patch|replace|create_file|write_file|delete_file|write_to_file|multi_replace|sed\s+-i|mv\s+|rm\s+)\b/i.test(text))return"editing";
    return"investigating";
  }
  return current??"starting";
}
function recordTouchedFiles(run:ExternalAgentRun,text:string,cwd:string):void{
  const existing=new Set(run.touchedFiles??[]);
  const normalizedCwd=cwd.replace(/\\/g,"/").replace(/\/+$/,"");
  const matches=text.matchAll(/(?:^|[\s"'`(])((?:\/[^\s"'`),;:]+)|(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12}))/g);
  for(const match of matches){
    const raw=match[1]?.trim();
    if(!raw||raw.includes("://")||raw.startsWith("//"))continue;
    let candidate=raw.replace(/[.,;:]+$/,"");
    if(normalizedCwd&&candidate.startsWith(`${normalizedCwd}/`)){
      candidate=candidate.slice(normalizedCwd.length+1);
    }else if(candidate.startsWith("/")){
      continue;
    }
    if(!candidate||candidate.length>240||candidate.startsWith("..")||candidate.startsWith(".git/"))continue;
    if(!existing.has(candidate)){
      if(existing.size>=25)break;
      existing.add(candidate);
    }
  }
  if(existing.size>0)run.touchedFiles=[...existing];
}
export function isExternalAgentRequest(value:unknown):value is ExternalAgentRequest{
  if(!object(value))return false;
  const fields:Record<string,string[]>={detect:["operation","kind","executable"],probe:["operation","binding","modelId"],quota:["operation","binding"],run:["operation","binding","taskId","runEpoch","requestId","prompt","cwd","workspaceMode","modelId","thinkingLevel","serviceTier","sessionId","readOnly","allowSubagents","taskTools","hasConnections","memoryEnabled","projectId","directoryId","grantRevision","timeoutMs","mcpServers"],inspect:["operation","runId","afterSequence","compact","ackReportIds"],diff:["operation","taskId","filePath"],apply:["operation","taskId","projectId","directoryId","grantRevision","paths","allowConflicts"],cancel:["operation","runId"],respond:["operation","runId","permissionId","choiceId"],close:["operation","runId","discardStaged"]};
  const allowed=fields[String(value.operation)];if(!allowed||Object.keys(value).some(key=>!allowed.includes(key)))return false;
  if(value.operation==="detect")return EXTERNAL_AGENT_KINDS.includes(value.kind as ExternalAgentKind)&&optionalString(value.executable);
  if(value.operation==="probe")return binding(value.binding)&&optionalString(value.modelId,512);
  if(value.operation==="quota")return binding(value.binding);
  if(value.operation==="diff")return id(value.taskId)&&optionalString(value.filePath,4096);
  if(value.operation==="apply")return id(value.taskId)&&id(value.projectId)&&(value.directoryId===undefined||id(value.directoryId))&&(value.grantRevision===undefined||Number.isSafeInteger(value.grantRevision)&&Number(value.grantRevision)>=1)&&(value.allowConflicts===undefined||typeof value.allowConflicts==="boolean")&&(value.paths===undefined||Array.isArray(value.paths)&&value.paths.length<=2000&&value.paths.every(p=>typeof p==="string"&&p.length>0&&p.length<=4096&&!/[\x00]/.test(p)));
  if(["inspect","cancel","close"].includes(String(value.operation)))return id(value.runId)&&(value.afterSequence===undefined||Number.isSafeInteger(value.afterSequence)&&Number(value.afterSequence)>=0)&&(value.compact===undefined||typeof value.compact==="boolean")&&(value.ackReportIds===undefined||Array.isArray(value.ackReportIds)&&value.ackReportIds.length<=32&&value.ackReportIds.every(item=>id(item)))&&(value.discardStaged===undefined||typeof value.discardStaged==="boolean");
  if(value.operation==="respond")return id(value.runId)&&id(value.permissionId)&&optionalString(value.choiceId,200)&&typeof value.choiceId==="string";
  if(value.operation!=="run"||!binding(value.binding)||!id(value.taskId)||!id(value.requestId)||!Number.isSafeInteger(value.runEpoch)||Number(value.runEpoch)<0||typeof value.prompt!=="string"||value.prompt.length>256_000||typeof value.cwd!=="string"||!path.isAbsolute(value.cwd)||value.cwd.length>8192||/[\x00-\x1f\x7f]/.test(value.cwd)||typeof value.readOnly!=="boolean"||typeof value.allowSubagents!=="boolean"||!Number.isSafeInteger(value.timeoutMs)||Number(value.timeoutMs)<1000||Number(value.timeoutMs)>86_400_000)return false;
  if(value.taskTools!==undefined&&typeof value.taskTools!=="boolean"||value.hasConnections!==undefined&&typeof value.hasConnections!=="boolean"||value.memoryEnabled!==undefined&&typeof value.memoryEnabled!=="boolean")return false;
  if(value.workspaceMode!==undefined&&!["staged","direct","read_only"].includes(String(value.workspaceMode)))return false;
  if(!optionalString(value.modelId,512)||!optionalString(value.thinkingLevel,512)||!optionalString(value.serviceTier,128)||!optionalString(value.sessionId,512)||value.projectId!==undefined&&!id(value.projectId)||value.directoryId!==undefined&&!id(value.directoryId)||value.grantRevision!==undefined&&(!Number.isSafeInteger(value.grantRevision)||Number(value.grantRevision)<1))return false;
  // Only Env creates task-scoped MCP endpoints; arbitrary URLs/credentials are not accepted from control messages.
  return value.mcpServers===undefined||Array.isArray(value.mcpServers)&&value.mcpServers.length===0;
}
export function isExternalAgentResponse(value:unknown):value is ExternalAgentResponse{
  if(!object(value))return false;
  if(value.type==="detection"){
    const detection=value.detection;if(!object(detection)||!EXTERNAL_AGENT_KINDS.includes(detection.kind as ExternalAgentKind)||typeof detection.installed!=="boolean"||(detection.desktopAppInstalled!==undefined&&typeof detection.desktopAppInstalled!=="boolean")||detection.authenticated!==null&&typeof detection.authenticated!=="boolean"||!Array.isArray(detection.models)||detection.models.length>1000||!optionalString(detection.executable)||!optionalString(detection.version,200)||!optionalString(detection.error,4000))return false;
    const capabilities=detection.capabilities;if(!object(capabilities)||!["resume","cancel","models","permissions","collaboration"].every(key=>typeof capabilities[key]==="boolean")||!["native","observed","none"].includes(String(capabilities.terminalEvidence)))return false;
    return detection.models.every(model=>object(model)&&typeof model.id==="string"&&model.id.length>0&&model.id.length<=4096&&typeof model.name==="string"&&model.name.length<=4096&&(model.isDefault===undefined||typeof model.isDefault==="boolean")&&(model.defaultServiceTier===undefined||typeof model.defaultServiceTier==="string"&&model.defaultServiceTier.length>0&&model.defaultServiceTier.length<=128)&&(model.efforts===undefined||Array.isArray(model.efforts)&&model.efforts.length<=32&&model.efforts.every(effort=>typeof effort==="string"&&effort.length>0&&effort.length<=64))&&(model.serviceTiers===undefined||Array.isArray(model.serviceTiers)&&model.serviceTiers.length<=32&&model.serviceTiers.every(tier=>object(tier)&&typeof tier.id==="string"&&tier.id.length>0&&tier.id.length<=64&&(tier.name===undefined||typeof tier.name==="string"&&tier.name.length<=128)&&(tier.description===undefined||typeof tier.description==="string"&&tier.description.length<=512))));
  }
  if(value.type==="quota"){
    if(Object.keys(value).some(key=>key!=="type"&&key!=="quota"))return false;
    return isValidQuotaProbeResult(value.quota);
  }
  if(value.type==="diff"){
    const d=value.diff;
    return object(d)&&typeof d.diff==="string"&&d.diff.length<=256_000&&optionalString(d.filteredPath,4096)&&validDiffSummary(d);
  }
  if(value.type==="apply"){
    const applied=value.applied;
    return object(applied)&&typeof applied.cleanedUp==="boolean"&&["appliedAdded","appliedModified","appliedDeleted"].every(key=>Array.isArray(applied[key])&&(applied[key] as unknown[]).length<=5000&&(applied[key] as unknown[]).every(item=>typeof item==="string"&&item.length>0&&item.length<=4096));
  }
  if(value.type!=="run"||!object(value.run))return false;const run=value.run;
  if(!id(run.id)||!id(run.taskId)||!Number.isSafeInteger(run.runEpoch)||Number(run.runEpoch)<0||!EXTERNAL_AGENT_KINDS.includes(run.kind as ExternalAgentKind)||!["starting","running","waiting","completed","failed","cancelled","uncertain"].includes(String(run.state))||typeof run.text!=="string"||run.text.length>256_000||!Array.isArray(run.events)||run.events.length>401||!Array.isArray(run.permissions)||run.permissions.length>64||!Number.isSafeInteger(run.nextSequence)||Number(run.nextSequence)<1||run.quiescent!==undefined&&typeof run.quiescent!=="boolean"||!optionalString(run.sessionId,512)||!optionalString(run.stagedCwd,8192)||!optionalString(run.scratchNotesDir,8192)||(run.stagedDiff!==undefined&&!validDiffSummary(run.stagedDiff))||(run.uncertainReason!==undefined&&!UNCERTAIN_REASONS.has(run.uncertainReason as ExternalAgentUncertainReason))||(run.phase!==undefined&&!WORKER_PHASES.has(run.phase as WorkerExecutionPhase))||(run.touchedFiles!==undefined&&!validPathList(run.touchedFiles,25,1024))||(run.readOnlyViolation!==undefined&&!validReadOnlyViolation(run.readOnlyViolation))||(run.pendingReports!==undefined&&(!Array.isArray(run.pendingReports)||run.pendingReports.length>16||!run.pendingReports.every(validPendingReport)))||(run.latestQuota!==undefined&&!isValidQuotaProbeResult(run.latestQuota))||!optionalString(run.error,4000))return false;
  let previous=0;for(const event of run.events){if(!object(event)||!Number.isSafeInteger(event.sequence)||Number(event.sequence)<=previous||Number(event.sequence)>=Number(run.nextSequence)||!Number.isFinite(event.at)||!["message","tool","permission","state","error"].includes(String(event.type))||typeof event.text!=="string"||event.text.length>16_000)return false;previous=Number(event.sequence);}
  return run.permissions.every(permission=>object(permission)&&id(permission.id)&&typeof permission.title==="string"&&permission.title.length<=4000&&Array.isArray(permission.choices)&&permission.choices.length>0&&permission.choices.length<=20&&permission.choices.every(choice=>object(choice)&&typeof choice.id==="string"&&choice.id.length>0&&choice.id.length<=200&&typeof choice.label==="string"&&choice.label.length<=500));
}
function within(candidate:string,root:string):boolean{const rel=path.relative(root,candidate);return rel===""||rel!==".."&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);}
function terminal(state:ExternalAgentRun["state"]):boolean{return["completed","failed","cancelled","uncertain"].includes(state);}
function hash(value:string):string{return createHash("sha256").update(value).digest("hex");}
async function executableOutput(executable:string,args:string[],timeout=10_000):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{env:{HOME:os.homedir(),PATH:augmentedNativePath(process.env.PATH??"")},stdio:["ignore","pipe","pipe"],windowsHide:true});let output="";
    const collect=(data:Buffer)=>{output+=data.toString("utf8");if(output.length>64_000){child.kill();reject(new Error("Agent information response exceeds its limit"));}};
    child.stdout.on("data",collect);child.stderr.on("data",collect);
    const timer=setTimeout(()=>{child.kill();reject(new Error("Local agent information request timed out"));},timeout);timer.unref();
    child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("exit",code=>{clearTimeout(timer);if(code===0)resolve(output.trim());else reject(new Error(`Local agent information request failed (${code??"signal"})`));});
  });
}
function detectMacDesktopApp(appBundleName:string):{installed:boolean;version?:string}{
  if(process.platform!=="darwin")return{installed:false};
  const candidates=[
    path.join("/Applications",appBundleName),
    path.join(os.homedir(),"Applications",appBundleName),
  ];
  for(const bundle of candidates){
    try{
      if(!fs.statSync(bundle).isDirectory())continue;
      const plistPath=path.join(bundle,"Contents","Info.plist");
      let version:string|undefined;
      try{
        const raw=fs.readFileSync(plistPath,"utf8");
        const match=raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,64})<\/string>/);
        const parsed=match?.[1]?.trim();
        if(parsed&&!/[\x00-\x1f\x7f]/.test(parsed))version=parsed;
      }catch{/* binary or unreadable plist: still report installed */}
      return{installed:true,...(version?{version}:{})};
    }catch{/* not present */}
  }
  return{installed:false};
}
function hasClaudeExternalAuthConfig():boolean{
  if(process.env.ANTHROPIC_API_KEY||process.env.ANTHROPIC_AUTH_TOKEN||process.env.CLAUDE_CODE_USE_BEDROCK||process.env.CLAUDE_CODE_USE_VERTEX||process.env.CLAUDE_CODE_USE_FOUNDRY)return true;
  try{
    const settingsFile=path.join(os.homedir(),".claude","settings.json");
    if(!fs.existsSync(settingsFile))return false;
    const raw=JSON.parse(fs.readFileSync(settingsFile,"utf8")) as Record<string,unknown>;
    if(typeof raw.apiKeyHelper==="string"&&raw.apiKeyHelper.trim().length>0)return true;
    const envBlock=raw.env&&typeof raw.env==="object"&&!Array.isArray(raw.env)?raw.env as Record<string,unknown>:undefined;
    if(envBlock&&(envBlock.ANTHROPIC_API_KEY||envBlock.ANTHROPIC_AUTH_TOKEN||envBlock.CLAUDE_CODE_USE_BEDROCK||envBlock.CLAUDE_CODE_USE_VERTEX||envBlock.CLAUDE_CODE_USE_FOUNDRY))return true;
  }catch{/* ignore unreadable settings */}
  return false;
}
export interface ClaudeAuthStatusProbe {
  loggedIn: boolean | null;
  authMethod?: string;
  apiProvider?: string;
}
async function detectClaudeAuthStatus(executable:string,signal?:AbortSignal):Promise<ClaudeAuthStatusProbe>{
  return new Promise(resolve=>{
    if(signal?.aborted)return resolve({loggedIn:null});
    let stdout="";
    let settled=false;
    const finish=(value:ClaudeAuthStatusProbe)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",onAbort);resolve(value);};
    const child=spawn(executable,["auth","status","--json"],{env:nativeAgentEnvironment("claude-code"),stdio:["ignore","pipe","ignore"],windowsHide:true});
    const onAbort=()=>{try{child.kill();}catch{/* ignore */}finish({loggedIn:null});};
    signal?.addEventListener("abort",onAbort,{once:true});
    const timer=setTimeout(()=>{try{child.kill();}catch{/* ignore */}finish({loggedIn:null});},5_000);timer.unref();
    child.stdout.on("data",(data:Buffer)=>{stdout+=data.toString("utf8");if(stdout.length>32_000){try{child.kill();}catch{/* ignore */}finish({loggedIn:null});}});
    child.once("error",()=>finish({loggedIn:null}));
    child.once("exit",()=>{
      try{
        const parsed=JSON.parse(stdout.trim()) as Record<string,unknown>;
        const authMethod=typeof parsed.authMethod==="string"&&parsed.authMethod.trim()?parsed.authMethod.trim():undefined;
        const apiProvider=typeof parsed.apiProvider==="string"&&parsed.apiProvider.trim()?parsed.apiProvider.trim():undefined;
        if(typeof parsed.loggedIn==="boolean"){
          return finish({loggedIn:parsed.loggedIn,...(authMethod?{authMethod}:{}),...(apiProvider?{apiProvider}:{})});
        }
      }catch{/* older claude CLI or non-JSON output */}
      finish({loggedIn:null});
    });
  });
}
async function detectClaudeAuthenticated(executable:string):Promise<boolean|null>{
  const status=await detectClaudeAuthStatus(executable);
  if(status.loggedIn===true)return true;
  if(status.loggedIn===false)return hasClaudeExternalAuthConfig()?null:false;
  return null;
}
export interface ExternalAgentServiceOptions {
  envId:string;rootDir:string;projectRegistry:ProjectDirectoryRegistry;
  toolHandler?:ExternalAgentToolHandler;pipeFactory?:ExternalAgentPipeFactory;
  claudeAuthStatus?:(executable:string,signal?:AbortSignal)=>Promise<ClaudeAuthStatusProbe>;
  claudeQuotaProbe?:typeof probeClaudeQuota;
  grokQuotaRunner?:GrokQuotaCliRunner;
}
export class ExternalAgentService {
  readonly rootDir:string;
  readonly #options:ExternalAgentServiceOptions;
  readonly #runs=new Map<string,StoredRun>();
  readonly #staged=new Map<string,StoredStagedTask>();
  readonly #live=new Map<string,LiveRun>();
  readonly #activeQuotas=new Set<AbortController>();
  readonly #ephemeralSecrets=new Set<string>();
  readonly #background=new Set<Promise<unknown>>();
  #backgroundError?:Error;
  #handler?:ExternalAgentToolHandler;
  #closed=false;
  #recovery?:Promise<void>;
  get hasActiveRuns(): boolean {
    return [...this.#live.values()].some(({ stored }) => !terminal(stored.run.state));
  }
  constructor(options:ExternalAgentServiceOptions){
    this.#options=options;this.#handler=options.toolHandler;this.rootDir=path.join(options.projectRegistry.privateDirectory,"external-agents");
    fs.mkdirSync(this.rootDir,{recursive:true,mode:0o700});fs.chmodSync(this.rootDir,0o700);
    for(const name of fs.readdirSync(this.rootDir)){
      if(/^staged-[a-f0-9]{64}\.json$/.test(name)){
        const staged=JSON.parse(fs.readFileSync(path.join(this.rootDir,name),"utf8")) as StoredStagedTask;
        if(staged.version===1&&id(staged.taskId)&&path.isAbsolute(staged.sourceDir)&&path.isAbsolute(staged.stagedDir))this.#staged.set(staged.taskId,staged);
        continue;
      }
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const stored=JSON.parse(fs.readFileSync(path.join(this.rootDir,name),"utf8")) as StoredRun;
      if(stored.version!==1||!id(stored.run?.id)||!id(stored.run.taskId)||typeof stored.fingerprint!=="string"||!path.isAbsolute(stored.cwd))throw new Error("Invalid external agent execution receipt");
      stored.run.permissions=[];
      if(stored.run.latestQuota!==undefined&&!isValidQuotaProbeResult(stored.run.latestQuota)){delete stored.run.latestQuota;}
      if(!terminal(stored.run.state)){stored.run.state="uncertain";stored.run.uncertainReason="env_restart";stored.run.quiescent=false;stored.run.error="Env restarted before the native terminal result was recorded; this task was not resubmitted";}
      this.#runs.set(stored.run.id,stored);this.#persist(stored);
    }
  }
  async recover():Promise<void>{return this.#recovery??=(async()=>{
    await primeLoginShellPath();
    const control=path.join(this.#options.projectRegistry.privateDirectory,"external-executions");
    for(const stored of this.#runs.values())if(stored.managedProcesses&&stored.run.quiescent!==true){
      const dirs=[...new Set([stored.cwd,...(stored.executionCwd?[stored.executionCwd]:[])])];
      let pending=false;
      for(const dir of dirs){
        const dirPending=await cleanupRecordedExecutions(control,{workspaceDir:dir});
        if(dirPending||hasOrphanedExecution(control,dir))pending=true;
      }
      if(!pending){stored.run.quiescent=true;this.#persist(stored);}
    }
  })();}
  setToolHandler(handler:ExternalAgentToolHandler|undefined):void{this.#handler=handler;}
  async request(request:ExternalAgentRequest,signal?:AbortSignal):Promise<ExternalAgentResponse>{
    await this.recover();
    if(this.#closed)throw new Error("External agent runtime is closed");if(!isExternalAgentRequest(request))throw new Error("Invalid external agent request");if(signal?.aborted)throw new Error("External agent request was aborted");
    if(request.operation==="detect")return{type:"detection",detection:await this.#detect(request.kind,request.executable)};
    if(request.operation==="probe"){this.#bindingEnv(request.binding);return{type:"detection",detection:await this.#probe(request.binding,request.modelId)};}
    if(request.operation==="quota"){this.#bindingEnv(request.binding);return{type:"quota",quota:await this.#quota(request.binding,signal)};}
    if(request.operation==="run")return{type:"run",run:this.#start(request)};
    if(request.operation==="diff")return{type:"diff",diff:this.#diff(request.taskId,request.filePath)};
    if(request.operation==="apply")return{type:"apply",applied:this.#apply(request)};
    const stored=this.#runs.get(request.runId);if(!stored)throw new Error("External agent run was not found on this device");const live=this.#live.get(request.runId);
    if(request.operation==="respond"){
      const pending=live?.permissions.get(request.permissionId);if(!pending||!pending.choices.has(request.choiceId))throw new Error("External agent permission is no longer active");
      live!.permissions.delete(request.permissionId);pending.resolve(request.choiceId);stored.run.permissions=stored.run.permissions.filter(item=>item.id!==request.permissionId);if(!stored.run.permissions.length&&!terminal(stored.run.state)){stored.run.state="running";stored.run.phase="investigating";}this.#persist(stored);
    }
    if(request.operation==="cancel"){
      if(live?.driver&&!terminal(stored.run.state)){await live.driver.cancel();this.#event(live,"state","Cancellation requested; waiting for the local client's terminal result");
        if(!terminal(stored.run.state))await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);live.terminalWaiters?.delete(done);resolve();};const timer=setTimeout(done,2000);timer.unref();(live.terminalWaiters??=new Set()).add(done);});
        if(terminal(stored.run.state))await this.#settle(live);
      }
      else if(live&&!live.submitted&&!terminal(stored.run.state))this.#finish(live,"cancelled","Cancelled before native submission");
      else if(!terminal(stored.run.state))throw new Error("Native agent has not acknowledged a cancellable session yet");
    }
    if(request.operation==="close"){
      if(live){live.driver?.close();this.#finish(live,"uncertain","Native connection closed before a terminal result was recorded","closed");await this.#settle(live);}
      if(request.discardStaged&&stored.run.quiescent===true){
        const staged=this.#staged.get(stored.run.taskId);
        if(staged&&!staged.appliedAt&&fs.existsSync(staged.stagedDir)){fs.rmSync(staged.stagedDir,{recursive:true,force:true});}
        if(stored.run.taskId.startsWith("agent-setup-")){
          const tableRoot=canonicalExecutionPath(path.join(this.#options.rootDir,"table"));
          const runCwd=canonicalExecutionPath(stored.cwd);
          if(runCwd!==tableRoot&&within(runCwd,tableRoot)&&fs.existsSync(runCwd)){
            try{fs.rmSync(runCwd,{recursive:true,force:true});}catch{/* ignore cleanup race */}
          }
        }
      }
    }
    if(request.operation==="inspect"&&request.ackReportIds?.length&&stored.pendingReports?.length){
      const ackSet=new Set(request.ackReportIds);
      const remaining:ExternalAgentPendingReport[]=[];
      let changed=false;
      for(const pending of stored.pendingReports){
        if(ackSet.has(pending.reportId)){
          changed=true;
          for(const file of pending.files??[]){
            try{fs.rmSync(file.snapshotPath,{force:true});}catch{/* ignore cleanup race */}
          }
        }else{
          remaining.push(pending);
        }
      }
      if(changed){
        if(remaining.length)stored.pendingReports=remaining;else delete stored.pendingReports;
        this.#persist(stored);
      }
    }
    return{type:"run",run:this.#snapshot(stored,request.operation==="inspect"?request.afterSequence:undefined,request.operation==="inspect"?request.compact:undefined)};
  }
  #bindingEnv(value:ExternalAgentBinding):void{if(value.envId!==this.#options.envId)throw new Error("External agent binding belongs to another device");}
  #protected():string[]{return this.#options.projectRegistry.protectedPaths().map(canonicalExecutionPath);}
  #overlapsProtected(candidate:string):boolean{
    const managedRoot=canonicalExecutionPath(this.#options.rootDir);
    return this.#protected().some(protectedPath=>within(candidate,protectedPath)&&!(protectedPath!==managedRoot&&within(managedRoot,protectedPath)&&within(candidate,managedRoot)));
  }
  #workspace(request:RunRequest):string{
    const actual=canonicalExecutionPath(request.cwd);
    if(request.projectId){const grant=this.#options.projectRegistry.validate(request.projectId,actual,request.grantRevision);if(request.directoryId&&grant.directoryId!==request.directoryId)throw new Error("External agent directory grant changed");}
    else{if(!within(actual,canonicalExecutionPath(this.#options.rootDir)))throw new Error("External agent workspace requires a current project directory grant");this.#options.projectRegistry.assertUnregistered(actual);}
    if(actual===path.parse(actual).root||actual===canonicalExecutionPath(os.homedir())||this.#overlapsProtected(actual))throw new Error("External agent workspace overlaps protected data");
    // Create only a validated Env child or granted project child, then verify its physical destination again.
    if(!fs.existsSync(actual))fs.mkdirSync(actual,{recursive:true,mode:0o700});
    if(canonicalExecutionPath(request.cwd)!==actual||!fs.statSync(actual).isDirectory())throw new Error("External agent workspace changed during preparation");
    if(request.projectId)this.#options.projectRegistry.validate(request.projectId,actual,request.grantRevision);
    return actual;
  }
  #persistStaged(staged:StoredStagedTask):void{
    const file=path.join(this.rootDir,`staged-${hash(staged.taskId)}.json`);
    const temp=file+`.${randomUUID()}.tmp`;
    fs.writeFileSync(temp,JSON.stringify(staged),{mode:0o600});
    fs.renameSync(temp,file);
  }
  #diff(taskId:string,filePath?:string){
    const staged=this.#staged.get(taskId);
    if(!staged||staged.workspaceMode!=="staged")throw new Error("No staged workspace is recorded for this task");
    if(staged.appliedAt)throw new Error("Staged workspace changes were already merged");
    if(!fs.existsSync(staged.stagedDir))throw new Error("Staged workspace directory is no longer available");
    const detail=computeStagedDiff({sourceDir:staged.sourceDir,stagedDir:staged.stagedDir,baseline:staged.baseline,filePath,maxPreviewBytes:128*1024});
    return{...detail,unifiedPreview:this.#redact(detail.unifiedPreview).slice(0,24*1024),diff:this.#redact(detail.diff).slice(0,128*1024)};
  }
  #apply(request:Extract<ExternalAgentRequest,{operation:"apply"}>){
    const staged=this.#staged.get(request.taskId);
    if(!staged||staged.workspaceMode!=="staged")throw new Error("No staged workspace is recorded for this task");
    if(staged.appliedAt)return{appliedAdded:[],appliedModified:[],appliedDeleted:[],cleanedUp:true};
    if([...this.#runs.values()].some(item=>item.run.taskId===request.taskId&&item.run.quiescent!==true))throw new Error("Wait for the external agent run to finish before applying staged changes");
    const grant=this.#options.projectRegistry.validate(request.projectId,staged.sourceDir,request.grantRevision);
    if(request.directoryId&&grant.directoryId!==request.directoryId)throw new Error("Project directory identity changed before staged merge");
    if(!fs.existsSync(staged.stagedDir))throw new Error("Staged workspace directory is no longer available");
    const applied=applyStagedChanges({sourceDir:staged.sourceDir,stagedDir:staged.stagedDir,baseline:staged.baseline,paths:request.paths,allowConflicts:request.allowConflicts});
    if(applied.cleanedUp)staged.appliedAt=Date.now();
    this.#persistStaged(staged);
    return applied;
  }
  #prepareExecutionWorkspace(request:RunRequest,sourceCwd:string):{executionCwd:string;scratchNotesDir?:string;workspaceMode?:ExternalWorkspaceMode}{
    const mode=request.workspaceMode;
    if(request.runEpoch<=0)return{executionCwd:sourceCwd};
    const taskScratch=path.join(this.#options.projectRegistry.scratchRoot,request.taskId.replace(/[^A-Za-z0-9._-]/g,"_"));
    const scratchNotesDir=path.join(taskScratch,"notes");
    fs.mkdirSync(scratchNotesDir,{recursive:true,mode:0o700});
    this.#options.projectRegistry.validateScratch(scratchNotesDir);
    if(!request.projectId||!mode||mode==="direct")return{executionCwd:sourceCwd,scratchNotesDir,workspaceMode:mode};
    const stagedDir=path.join(taskScratch,"staged");
    const prior=this.#staged.get(request.taskId);
    if(prior&&!prior.appliedAt&&prior.sourceDir===sourceCwd&&prior.workspaceMode===mode&&fs.existsSync(stagedDir)){
      this.#options.projectRegistry.validateScratch(stagedDir);
      return{executionCwd:stagedDir,scratchNotesDir,workspaceMode:mode};
    }
    const baseline=cloneStagedWorkspace(sourceCwd,stagedDir);
    this.#options.projectRegistry.validateScratch(stagedDir);
    const record:StoredStagedTask={version:1,taskId:request.taskId,projectId:request.projectId,sourceDir:sourceCwd,stagedDir,scratchNotesDir,workspaceMode:mode,baseline};
    this.#staged.set(request.taskId,record);
    this.#persistStaged(record);
    return{executionCwd:stagedDir,scratchNotesDir,workspaceMode:mode};
  }
  #start(request:RunRequest):ExternalAgentRun{
    this.#bindingEnv(request.binding);const cwd=this.#workspace(request);
    const existing=this.#runs.get(request.requestId);
    let executable=existing?.executable??"",startupError:Error|undefined;
    if(!existing){
      try{executable=resolveExternalExecutable(request.binding.kind,request.binding.executable)??"";}
      catch(error){executable=request.binding.executable??"";startupError=new Error(`Local ${request.binding.kind} client could not start: ${error instanceof Error?error.message:"Agent executable is unavailable on this device"}. No task was submitted.`);}
    }
    const fingerprint=hash(JSON.stringify({...request,binding:{...request.binding,verifiedAt:undefined,capabilities:undefined},cwd,executable}));
    if(existing){if(existing.fingerprint!==fingerprint)throw new Error("External agent request ID was reused with a different task");return this.#snapshot(existing);}
    if([...this.#runs.values()].some(item=>item.run.taskId===request.taskId&&item.run.runEpoch===request.runEpoch))throw new Error("This task epoch already has an external execution receipt; inspect it before dispatching again");
    const requestIsolatedReadOnly=Boolean(request.projectId)&&request.workspaceMode==="read_only"&&request.runEpoch>0;
    const isIsolatedReadOnly=(entry:StoredRun)=>entry.workspaceMode==="read_only"&&Boolean(entry.executionCwd)&&entry.executionCwd!==entry.cwd;
    if([...this.#runs.values()].some(stored=>{
      if(stored.run.quiescent===true)return false;
      if(!(within(cwd,stored.cwd)||within(stored.cwd,cwd)))return false;
      if(requestIsolatedReadOnly&&isIsolatedReadOnly(stored)&&stored.run.taskId!==request.taskId)return false;
      return true;
    }))throw new Error("Previous external execution cleanup is pending for this workspace");
    if([...this.#live.values()].some(item=>{
      if(terminal(item.stored.run.state))return false;
      if(!(within(cwd,item.stored.cwd)||within(item.stored.cwd,cwd)))return false;
      if(requestIsolatedReadOnly&&isIsolatedReadOnly(item.stored)&&item.stored.run.taskId!==request.taskId)return false;
      return true;
    }))throw new Error("Another external task owns write access to this workspace");
    if(request.sessionId&&!startupError&&!this.#ownedSession(request,cwd,executable))throw new Error("Native session does not belong to this Kulo task and workspace");
    const prepared=startupError?{executionCwd:cwd}:this.#prepareExecutionWorkspace(request,cwd);
    const readOnlyBeforeSnapshot=!startupError&&request.readOnly&&prepared.executionCwd===cwd?captureDirectReadOnlySnapshot(cwd,prepared.scratchNotesDir):undefined;
    const stored:StoredRun={version:1,managedProcesses:request.binding.kind!=="grok-bot",fingerprint,cwd,executionCwd:prepared.executionCwd,workspaceMode:prepared.workspaceMode,scratchNotesDir:prepared.scratchNotesDir,executable,projectId:request.projectId,directoryId:request.directoryId,grantRevision:request.grantRevision,readOnly:request.readOnly,run:{id:request.requestId,taskId:request.taskId,runEpoch:request.runEpoch,kind:request.binding.kind,sessionId:startupError?undefined:request.sessionId,state:"starting",phase:"starting",text:"",events:[],permissions:[],nextSequence:1,quiescent:false,...(prepared.executionCwd!==cwd?{stagedCwd:prepared.executionCwd}:{}),...(prepared.scratchNotesDir?{scratchNotesDir:prepared.scratchNotesDir}:{})}};
    const live:LiveRun={stored,deadline:Date.now()+request.timeoutMs,submitted:false,readOnlyBeforeSnapshot,permissions:new Map()};this.#runs.set(stored.run.id,stored);this.#live.set(stored.run.id,live);this.#persist(stored);
    // A proven preflight rejection needs a receipt too; otherwise a lost acknowledgement hides its cause.
    if(startupError){this.#finish(live,"failed",startupError.message);return this.#snapshot(stored);}
    live.timer=setTimeout(()=>{live.driver?.close();this.#finish(live,"uncertain","External agent deadline expired before a terminal result was recorded","timeout");},request.timeoutMs);live.timer.unref();
    // Intent is durable before creating a process or sending the prompt. Lost acks are inspected, never replayed.
    this.#track(this.#launch(live,request).catch(async(error:unknown)=>{
      const safeBeforeSubmission=!live.submitted&&((live.cleanups?.length? (await Promise.all(live.cleanups.map(cleanup=>cleanup().catch(()=>false)))).every(Boolean):false)||(error as {externalAgentQuiescent?:boolean})?.externalAgentQuiescent===true);
      this.#finish(live,live.submitted?"uncertain":"failed",error instanceof Error?error.message:"External agent startup failed",live.submitted?"disconnect":undefined);
      if(safeBeforeSubmission){live.stored.run.quiescent=true;this.#persist(live.stored);this.#live.delete(live.stored.run.id);}
    }));
    return this.#snapshot(stored);
  }
  #ownedSession(request:RunRequest,cwd:string,executable:string):boolean{return[...this.#runs.values()].some(item=>item.run.sessionId===request.sessionId&&item.run.taskId===request.taskId&&item.run.kind===request.binding.kind&&item.run.quiescent===true&&item.projectId===request.projectId&&item.directoryId===request.directoryId&&item.cwd===cwd&&item.executable===executable&&terminal(item.run.state));}
  async #launch(live:LiveRun,request:RunRequest):Promise<void>{
    const kind=request.binding.kind;
    if(["dots","muse"].includes(kind))throw new Error(`${kind} is reserved; no supported local task-control interface is configured`);
    if(kind!=="grok-bot"&&!live.stored.executable)throw new Error("Local agent client is not installed or its executable is unavailable");
    if((request.taskTools||request.allowSubagents||request.hasConnections||request.memoryEnabled)&&this.#handler&&request.runEpoch>=1){
      live.mcp=await startExternalAgentMcp({runId:live.stored.run.id,taskId:request.taskId,runEpoch:request.runEpoch,cwd:live.stored.cwd,allowSubagents:Boolean(request.allowSubagents),hasConnections:Boolean(request.hasConnections),memoryEnabled:Boolean(request.memoryEnabled),redact:value=>this.#redact(value),handler:async invocation=>{
        if(this.#closed||this.#live.get(live.stored.run.id)!==live||terminal(live.stored.run.state))throw new Error("External collaboration scope has expired");
        this.#workspace(request);
        try{
          return await this.#handler!({...invocation,envId:this.#options.envId});
        }catch(error){
          const msg=error instanceof Error?error.message:String(error);
          if(invocation.name==="kulo_task_report"&&/Hub is offline|Hub disconnected|not sent|timed out/i.test(msg)){
            return this.#recordOfflineTaskReport(live,invocation.args);
          }
          throw error;
        }
      }});
      for(const header of live.mcp.server.headers){this.#ephemeralSecrets.add(header.value);if(header.value.startsWith("Bearer "))this.#ephemeralSecrets.add(header.value.slice(7));}
    }
    if(terminal(live.stored.run.state)){await live.mcp?.close();return;}
    const context=this.#context(live,request);
    live.launched=true;
    const result=kind==="codex"?await connectCodex(context):kind==="claude-code"?await connectClaude(context):kind==="grok-bot"?await this.#grok(context):await connectAcp(context);
    live.driver=result.driver;
    if(terminal(live.stored.run.state)){live.driver.close();await this.#settle(live);}
  }
  async #grok(context:ExternalDriverContext):Promise<{driver:ExternalDriver}>{return {driver:await connectGrok(context)};}
  #context(live:LiveRun,request:RunRequest):ExternalDriverContext{
    const executionCwd=live.stored.executionCwd??live.stored.cwd;
    return{
    binding:request.binding,executable:live.stored.executable,cwd:executionCwd,workspaceMode:live.stored.workspaceMode,scratchNotesDir:live.stored.scratchNotesDir,controlRoot:path.join(this.#options.projectRegistry.privateDirectory,"external-executions"),projectId:request.projectId,readOnly:request.readOnly,
    prompt:[request.prompt,request.readOnly&&!/Workspace Mode:\s*read_only/i.test(request.prompt)?"Read-only mode: inspect and analyze only; never modify files or perform write operations.":"",live.mcp?"Use the attached `kulo-task` MCP tools to report progress/outcomes, request collaboration or decisions from Kulo, or query/update shared project memory.":""].filter(Boolean).join("\n\n"),
    modelId:request.modelId,thinkingLevel:request.thinkingLevel,serviceTier:request.serviceTier,sessionId:request.sessionId,timeoutMs:request.timeoutMs,servers:live.mcp?[live.mcp.server]:[],
    pipe:async spec=>{
      const factory=this.#options.pipeFactory??createExternalPipeFactory({controlRoot:path.join(this.#options.projectRegistry.privateDirectory,"external-executions"),projectId:request.projectId,kind:request.binding.kind});
      const pipe=await factory(spec);const cleanup=async()=>{pipe.close();return pipe.cleanup?.()??pipe.exited.then(()=>true,()=>false);};
      (live.cleanups??=[]).push(cleanup);
      if(terminal(live.stored.run.state)||this.#closed){const quiescent=await cleanup();throw Object.assign(new Error("External agent scope expired during process launch"),{externalAgentQuiescent:quiescent});}
      return pipe;
    },
    registerCleanup:cleanup=>{(live.cleanups??=[]).push(cleanup);},
    event:(type,value)=>this.#event(live,type,value),activity:label=>this.#activity(live,label),quota:snapshot=>this.#recordPassiveQuota(live,snapshot),session:sessionId=>{if(typeof sessionId!=="string"||!sessionId||sessionId.length>512)throw new Error("Invalid native agent session ID");live.stored.run.sessionId=sessionId;this.#persist(live.stored);},
    submitted:()=>{if(terminal(live.stored.run.state)||Date.now()>=(live.deadline??Infinity))throw new Error("External agent run has expired");live.submitted=true;live.stored.run.state="running";if(!live.stored.run.phase||live.stored.run.phase==="starting")live.stored.run.phase="investigating";this.#event(live,"state","Task accepted by local agent protocol");},complete:(state,error)=>this.#finish(live,state,error,state==="uncertain"?"disconnect":undefined),
    permission:async(permissionId,title,choices)=>{
      if(terminal(live.stored.run.state))throw new Error("External agent permission scope expired");
      if(live.permissions.has(permissionId))throw new Error("Duplicate native permission request");
      return new Promise<string>(resolve=>{live.permissions.set(permissionId,{choices:new Set(choices.map(choice=>choice.id)),resolve});live.stored.run.state="waiting";live.stored.run.phase="waiting_permission";live.stored.run.permissions.push({id:permissionId,title:this.#redact(title).slice(0,4000),choices:choices.map(choice=>({id:choice.id,label:this.#redact(choice.label).slice(0,500)}))});this.#event(live,"permission",title);});
    },

  };}
  #redact(value:string):string{
    let safe=redactSensitiveText(value);
    for(const secret of this.#ephemeralSecrets)safe=safe.split(secret).join("[REDACTED]");
    for(const [name,secret] of Object.entries(process.env))if(secret&&secret.length>=4&&/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTHORIZATION)/i.test(name))safe=safe.split(secret).join("[REDACTED]");
    return safe;
  }
  #recordPassiveQuota(live:LiveRun,snapshot:ExternalAgentQuotaProbeResult):void{
    if(live.stored.fingerprint==="probe"||snapshot.kind!==live.stored.run.kind)return;
    const merged=mergeQuotaProbeResults(live.stored.run.latestQuota,snapshot);
    if(!isValidQuotaProbeResult(merged))return;
    live.stored.run.latestQuota=merged;
    this.#persist(live.stored);
  }
  #activity(live:LiveRun,label?:string):void{
    if(terminal(live.stored.run.state))return;
    const now=Date.now();
    if(now-(live.lastHeartbeatAt??0)<10_000)return;
    live.lastHeartbeatAt=now;
    this.#event(live,"state",label||"Working...");
  }
  #event(live:LiveRun,type:ExternalAgentRun["events"][number]["type"],value:string):void{
    if(terminal(live.stored.run.state))return;const text=this.#redact(value).slice(0,16_000);if(!text)return;
    const run=live.stored.run;run.events.push({sequence:run.nextSequence++,at:Date.now(),type,text});if(run.events.length>400)run.events.splice(0,run.events.length-400);while(Buffer.byteLength(JSON.stringify(run.events))>512_000)run.events.shift();
    if(type==="message")run.text=(run.text+text).slice(-256_000);
    run.phase=inferPhaseFromEvent(type,text,run.permissions.length>0,run.phase);
    if(type==="tool")recordTouchedFiles(run,text,live.stored.executionCwd??live.stored.cwd);
    this.#persist(live.stored);
  }
  #finish(live:LiveRun,state:"completed"|"failed"|"cancelled"|"uncertain",error?:string,uncertainReason?:ExternalAgentUncertainReason):void{
    if(terminal(live.stored.run.state))return;const run=live.stored.run;run.state=state;if(state==="uncertain"&&uncertainReason)run.uncertainReason=uncertainReason;run.quiescent=!live.launched;for(const resolve of live.terminalWaiters??[])resolve();live.terminalWaiters?.clear();run.error=error?this.#redact(error).slice(0,4000):undefined;run.permissions=[];
    for(const pending of live.permissions.values())pending.resolve("");live.permissions.clear();if(live.timer)clearTimeout(live.timer);
    if(live.stored.workspaceMode==="staged"){
      const staged=this.#staged.get(run.taskId);
      if(staged&&!staged.appliedAt&&fs.existsSync(staged.stagedDir)){
        try{
          const detail=computeStagedDiff({sourceDir:staged.sourceDir,stagedDir:staged.stagedDir,baseline:staged.baseline,maxPreviewBytes:24*1024,extraIgnoredPaths:live.stored.scratchNotesDir?[live.stored.scratchNotesDir]:undefined});
          run.stagedDiff={
            hasChanges:detail.hasChanges,
            added:detail.added,
            modified:detail.modified,
            deleted:detail.deleted,
            ...(detail.emptyDirsAdded?.length?{emptyDirsAdded:detail.emptyDirsAdded}:{}),
            ...(detail.emptyDirsDeleted?.length?{emptyDirsDeleted:detail.emptyDirsDeleted}:{}),
            ...(detail.modeChanged?.length?{modeChanged:detail.modeChanged}:{}),
            ...(detail.sensitivePaths?.length?{sensitivePaths:detail.sensitivePaths}:{}),
            conflictFiles:detail.conflictFiles,
            unifiedPreview:this.#redact(detail.unifiedPreview).slice(0,24*1024),
            truncated:detail.truncated,
          };
        }catch{/* Keep terminal receipt durable even if diff inspection fails */}
      }
    }else if(live.stored.workspaceMode==="read_only"&&live.stored.executionCwd&&live.stored.executionCwd!==live.stored.cwd){
      const staged=this.#staged.get(run.taskId);
      if(staged&&fs.existsSync(staged.stagedDir)){
        try{
          const detail=computeStagedDiff({sourceDir:staged.sourceDir,stagedDir:staged.stagedDir,baseline:staged.baseline,maxPreviewBytes:4096,extraIgnoredPaths:live.stored.scratchNotesDir?[live.stored.scratchNotesDir]:undefined});
          const mutated=[...new Set([...detail.added,...detail.modified,...detail.deleted,...(detail.emptyDirsAdded??[]),...(detail.emptyDirsDeleted??[])])].sort();
          if(mutated.length>0){
            run.readOnlyViolation={mutatedPaths:mutated.slice(0,50),totalCount:mutated.length,discardedFromClone:true};
          }
        }catch{/* Never fail terminal settlement on read-only audit */}
      }
    }else if(live.stored.readOnly&&live.readOnlyBeforeSnapshot&&live.readOnlyBeforeSnapshot.kind!=="skipped"){
      try{
        const mutated=diffDirectReadOnlySnapshot(live.readOnlyBeforeSnapshot,live.stored.cwd,live.stored.scratchNotesDir);
        if(mutated.length>0){
          run.readOnlyViolation={mutatedPaths:mutated.slice(0,50),totalCount:mutated.length,discardedFromClone:false};
        }
      }catch{/* Never fail terminal settlement on read-only audit */}
    }
    run.events.push({sequence:run.nextSequence++,at:Date.now(),type:state==="failed"||state==="uncertain"?"error":"state",text:run.error??state});this.#persist(live.stored);
    if(run.quiescent)this.#live.delete(run.id);else this.#track(this.#settle(live));
    if(live.mcp)this.#track(live.mcp.close());
  }
  async #settle(live:LiveRun):Promise<boolean>{
    if(live.stored.run.quiescent===true)return true;
    if(!terminal(live.stored.run.state))return false;
    if(!live.driver){
      if(!live.cleanups?.length)return false;
      const quiescent=(await Promise.all(live.cleanups.map(cleanup=>cleanup().catch(()=>false)))).every(Boolean)&&live.stored.run.kind!=="grok-bot";
      if(quiescent&&live.stored.workspaceMode==="read_only"&&live.stored.executionCwd&&live.stored.executionCwd!==live.stored.cwd){fs.rmSync(live.stored.executionCwd,{recursive:true,force:true});}
      live.stored.run.quiescent=quiescent;this.#persist(live.stored);if(quiescent)this.#live.delete(live.stored.run.id);return quiescent;
    }
    live.driver.close();
    const reaped=await live.driver.cleanup?.().catch(()=>false)??false;
    const quiescent=reaped&&live.stored.run.kind!=="grok-bot";
    if(quiescent&&live.stored.workspaceMode==="read_only"&&live.stored.executionCwd&&live.stored.executionCwd!==live.stored.cwd){fs.rmSync(live.stored.executionCwd,{recursive:true,force:true});}
    live.stored.run.quiescent=quiescent;this.#persist(live.stored);
    if(quiescent)this.#live.delete(live.stored.run.id);
    return quiescent;
  }
  #track(task:Promise<unknown>):void{this.#background.add(task);void task.then(()=>this.#background.delete(task),(error:unknown)=>{this.#background.delete(task);this.#backgroundError=error instanceof Error?error:new Error("External runtime cleanup failed");});}
  #persist(stored:StoredRun):void{if(stored.fingerprint==="probe")return;const file=path.join(this.rootDir,hash(stored.run.id)+".json");const temp=file+`.${randomUUID()}.tmp`;fs.writeFileSync(temp,JSON.stringify(stored),{mode:0o600});fs.renameSync(temp,file);}
  #recordOfflineTaskReport(live:LiveRun,rawArgs:Record<string,unknown>):{recorded:true;queuedOffline:true;reportId:string;pendingNativeCompletion:true}{
    const existing=live.stored.pendingReports??[];
    if(existing.length>=16)throw new Error("Offline report outbox limit reached");
    const state=String(rawArgs.state);
    if(!["progress","blocked","ready","failed"].includes(state))throw new Error("Invalid task report state");
    const summaryRaw=typeof rawArgs.summary==="string"?rawArgs.summary.trim():"";
    if(!summaryRaw||summaryRaw.length>4000||summaryRaw.includes("\0"))throw new Error("Invalid task report summary");
    const deliverableRaw=rawArgs.deliverable===undefined?undefined:typeof rawArgs.deliverable==="string"&&rawArgs.deliverable.trim()&&rawArgs.deliverable.length<=60_000&&!rawArgs.deliverable.includes("\0")?rawArgs.deliverable.trim():(()=>{throw new Error("Invalid task report deliverable");})();
    const questionRaw=rawArgs.question===undefined?undefined:typeof rawArgs.question==="string"&&rawArgs.question.trim()&&rawArgs.question.length<=2000&&!rawArgs.question.includes("\0")?rawArgs.question.trim():(()=>{throw new Error("Invalid task report question");})();

    const reportId=`outbox-${randomUUID().replace(/-/g,"").slice(0,20)}`;
    const snappedFiles:ExternalAgentPendingReportFile[]=[];
    if(rawArgs.files!==undefined){
      if(!Array.isArray(rawArgs.files)||rawArgs.files.length>16)throw new Error("Invalid task report files");
      const baseRoot=canonicalExecutionPath(live.stored.executionCwd??live.stored.cwd);
      const scratchRoot=live.stored.scratchNotesDir?canonicalExecutionPath(live.stored.scratchNotesDir):undefined;
      const outboxDir=path.join(this.rootDir,"outbox",hash(live.stored.run.id));
      fs.mkdirSync(outboxDir,{recursive:true,mode:0o700});
      let totalBytes=0;
      const MAX_SINGLE_FILE=25*1024*1024;
      const MAX_TOTAL_BYTES=50*1024*1024;
      for(const [index,rawItem] of rawArgs.files.entries()){
        if(!object(rawItem)||typeof rawItem.path!=="string"||!rawItem.path.trim()||rawItem.path.length>4096||rawItem.path.includes("\0"))throw new Error("Invalid offline report file path");
        const rawPath=rawItem.path.trim();
        const candidate=path.isAbsolute(rawPath)?rawPath:path.resolve(baseRoot,rawPath);
        const canonicalCandidate=canonicalExecutionPath(candidate);
        const allowed=within(canonicalCandidate,baseRoot)||(scratchRoot?within(canonicalCandidate,scratchRoot):false);
        if(!allowed||this.#overlapsProtected(canonicalCandidate)){
          throw new Error(`Offline report file escapes authorized task workspace: ${rawPath}`);
        }
        const stat=fs.lstatSync(canonicalCandidate);
        if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`Offline report file must be a regular file: ${rawPath}`);
        if(stat.size<=0||stat.size>MAX_SINGLE_FILE||totalBytes+stat.size>MAX_TOTAL_BYTES){
          throw new Error(`Offline report file exceeds snapshot size limit: ${rawPath}`);
        }
        totalBytes+=stat.size;
        const safeBase=path.basename(canonicalCandidate).replace(/[^A-Za-z0-9._-]/g,"_").slice(0,80)||"file";
        const snapshotPath=path.join(outboxDir,`${reportId}-${index}-${safeBase}`);
        const bytes=fs.readFileSync(canonicalCandidate);
        const sha256=createHash("sha256").update(bytes).digest("hex");
        fs.writeFileSync(snapshotPath,bytes,{mode:0o600});
        snappedFiles.push({
          originalPath:rawPath,
          snapshotPath,
          ...(typeof rawItem.name==="string"&&rawItem.name.trim()?{name:rawItem.name.trim().slice(0,180)}:{}),
          ...(typeof rawItem.mime_type==="string"&&rawItem.mime_type.trim()?{mimeType:rawItem.mime_type.trim().slice(0,120)}:{}),
          ...(typeof rawItem.caption==="string"&&rawItem.caption.trim()?{caption:rawItem.caption.trim().slice(0,500)}:{}),
          size:bytes.byteLength,
          sha256,
        });
      }
    }

    const entry:ExternalAgentPendingReport={
      reportId,
      state:state as ExternalAgentPendingReport["state"],
      summary:this.#redact(summaryRaw),
      ...(deliverableRaw?{deliverable:this.#redact(deliverableRaw)}:{}),
      ...(questionRaw?{question:this.#redact(questionRaw)}:{}),
      ...(snappedFiles.length?{files:snappedFiles}:{}),
      at:Date.now(),
    };
    live.stored.pendingReports=[...existing,entry];
    this.#persist(live.stored);
    return{recorded:true,queuedOffline:true,reportId,pendingNativeCompletion:true};
  }
  #snapshot(stored:StoredRun,after?:number,compact?:boolean):ExternalAgentRun{
    const filteredEvents=stored.run.events.filter(event=>after===undefined||event.sequence>after);
    if(compact){
      const {latestQuota:_omittedQuota,...compactRun}=stored.run;
      return structuredClone({
        ...compactRun,
        text:stored.run.text.slice(-1600),
        events:filteredEvents.slice(-15),
      });
    }
    const pending=stored.pendingReports;
    if(pending?.length){
      // Anti-race iron rule: withhold terminal state until Hub consumes & ACKs every buffered offline report.
      return structuredClone({
        ...stored.run,
        state:terminal(stored.run.state)?"running":stored.run.state,
        pendingReports:pending,
        events:filteredEvents,
      });
    }
    return structuredClone({...stored.run,events:filteredEvents});
  }
  async #detect(kind:ExternalAgentKind,requested?:string):Promise<ExternalAgentDetection>{
    await primeLoginShellPath();
    if(isPersonalExternalAgentKind(kind)){
      if(kind==="grok-bot"){
        const appInfo=detectMacDesktopApp("Grok Bot.app");
        return{kind,installed:false,...(appInfo.installed?{desktopAppInstalled:true}:{}),...(appInfo.version?{version:appInfo.version}:{}),authenticated:null,models:[],capabilities:externalCapabilities(kind),error:"Experimental: specify an existing local CDP endpoint and a dedicated Bot"};
      }
      return{kind,installed:false,authenticated:null,models:[],capabilities:externalCapabilities(kind),error:"Reserved local adapter"};
    }
    let executable:string|undefined;
    try{
      executable=resolveExternalExecutable(kind,requested);
    }catch(error){
      return{kind,installed:false,authenticated:null,models:[],capabilities:externalCapabilities(kind),error:this.#redact(error instanceof Error?error.message:"Local client executable is unavailable")};
    }
    if(!executable)return{kind,installed:false,authenticated:null,models:[],capabilities:externalCapabilities(kind),error:kind==="acp"?"Custom ACP client requires an absolute native executable path":"Local client executable was not found"};
    const flavor=getAcpFlavor(kind);
    let version:string|undefined;
    try{version=this.#redact(await executableOutput(executable,[...(flavor?.versionArgs??["--version"])])).slice(0,200);}catch{/* Protocol probe reports executable readiness separately. */}
    const authenticated=kind==="claude-code"
      ? await detectClaudeAuthenticated(executable)
      : flavor?.detectAuth
        ? await flavor.detectAuth(executable,augmentedNativePath(process.env.PATH??""))
        : null;
    return{kind,installed:true,executable,version,authenticated,models:[],capabilities:externalCapabilities(kind)};
  }
  async #probe(value:ExternalAgentBinding,modelId?:string):Promise<ExternalAgentDetection>{
    if(value.kind==="grok-bot")return detectGrok(value);
    if(value.kind==="acp"&&value.acpArgs!==undefined){
      const validated=validateCustomAcpArgs(value.acpArgs);
      if(!validated.ok)return{kind:value.kind,installed:false,authenticated:null,models:[],capabilities:externalCapabilities(value.kind),error:validated.error};
    }
    const detection=await this.#detect(value.kind,value.executable);
    if(!detection.installed||detection.authenticated===false)return detection;
    const cwd=path.join(this.#options.rootDir,"external-agent-check");fs.mkdirSync(cwd,{recursive:true,mode:0o700});
    const request:RunRequest={operation:"run",binding:value,taskId:`probe:${randomUUID()}`,runEpoch:0,requestId:`probe:${randomUUID()}`,prompt:"",cwd,readOnly:true,allowSubagents:false,timeoutMs:30_000,modelId};this.#workspace(request);
    const stored:StoredRun={version:1,fingerprint:"probe",cwd,executable:detection.executable!,readOnly:true,run:{id:request.requestId,taskId:request.taskId,runEpoch:0,kind:value.kind,state:"starting",text:"",events:[],permissions:[],nextSequence:1,quiescent:false}};
    const live:LiveRun={stored,submitted:false,permissions:new Map()};const context=this.#context(live,request);
    // No prompt and no provider request: successful initialize is connectivity, not an authentication claim.
    let driver:ExternalDriver|undefined;try{
      const result=value.kind==="codex"?await connectCodex(context,true):value.kind==="claude-code"?await connectClaude(context,true):await connectAcp(context,true);driver=result.driver;detection.models=result.models;detection.authenticated="authenticated" in result&&typeof result.authenticated==="boolean"?result.authenticated:detection.authenticated;
    }catch(error){detection.error=this.#redact(error instanceof Error?error.message:"Local agent protocol probe failed");}finally{driver?.close();const cleanup=await Promise.all((live.cleanups??[]).map(close=>close().catch(()=>false)));if(cleanup.some(value=>!value))detection.error=detection.error??"Local protocol process cleanup is pending";}
    return detection;
  }
  async #quota(value:ExternalAgentBinding,externalSignal?:AbortSignal):Promise<ExternalAgentQuotaProbeResult>{
    await primeLoginShellPath();
    if(!isQuotaSupportedExternalAgentKind(value.kind)){
      return{kind:value.kind,status:"unsupported",source:"live",fetchedAt:Date.now(),windows:[]};
    }
    let executable:string|undefined;
    try{
      executable=resolveExternalExecutable(value.kind,value.executable);
    }catch(error){
      return{kind:value.kind,status:"unavailable",source:"live",fetchedAt:Date.now(),windows:[],error:sanitizeQuotaError(error instanceof Error?error.message:"Local client executable is unavailable",v=>this.#redact(v))};
    }
    if(!executable){
      return{kind:value.kind,status:"unavailable",source:"live",fetchedAt:Date.now(),windows:[],error:"Local client executable was not found"};
    }
    const controller=new AbortController();
    const onExternalAbort=()=>controller.abort();
    if(externalSignal?.aborted)controller.abort();
    else externalSignal?.addEventListener("abort",onExternalAbort,{once:true});
    this.#activeQuotas.add(controller);
    const controlRoot=path.join(this.#options.projectRegistry.privateDirectory,"external-executions");
    const cwd=path.join(this.#options.rootDir,"external-agent-quota");
    fs.mkdirSync(cwd,{recursive:true,mode:0o700});
    const runProbe=(async():Promise<ExternalAgentQuotaProbeResult>=>{
      if(value.kind==="codex"){
        return probeCodexQuota({
          executable,
          cwd,
          controlRoot,
          pipeFactory:this.#options.pipeFactory,
          signal:controller.signal,
          redact:v=>this.#redact(v),
        });
      }
      if(value.kind==="claude-code"){
        const authProbe=await (this.#options.claudeAuthStatus??detectClaudeAuthStatus)(executable,controller.signal);
        if(authProbe.loggedIn===false){
          return{kind:"claude-code",status:hasClaudeExternalAuthConfig()?"api_key_billing":"unauthenticated",source:"live",fetchedAt:Date.now(),windows:[]};
        }
        if(authProbe.loggedIn===true){
          const nonFirstParty=Boolean(authProbe.apiProvider&&authProbe.apiProvider!=="firstParty");
          const nonSubscriptionMethod=Boolean(authProbe.authMethod&&authProbe.authMethod!=="claude.ai"&&authProbe.authMethod!=="oauth");
          if(nonFirstParty||nonSubscriptionMethod){
            return{kind:"claude-code",status:"api_key_billing",source:"live",fetchedAt:Date.now(),windows:[]};
          }
        }
        const claudeProbe=this.#options.claudeQuotaProbe??probeClaudeQuota;
        return claudeProbe({
          executable,
          cwd,
          controlRoot,
          signal:controller.signal,
          redact:v=>this.#redact(v),
        });
      }
      const grokPipeFactory=this.#options.pipeFactory??createExternalPipeFactory({controlRoot,kind:"grok"});
      return probeGrokQuota({
        executable,
        cwd,
        pathEnv:augmentedNativePath(process.env.PATH??""),
        pipeFactory:grokPipeFactory,
        runtimePaths:externalRuntimePaths(executable),
        runner:this.#options.grokQuotaRunner,
        signal:controller.signal,
        redact:v=>this.#redact(v),
      });
    })().finally(()=>{
      externalSignal?.removeEventListener("abort",onExternalAbort);
      this.#activeQuotas.delete(controller);
    });
    this.#track(runProbe.then(()=>undefined,()=>undefined));
    const result=await runProbe;
    if(!isValidQuotaProbeResult(result)){
      return{kind:value.kind,status:"unavailable",source:"live",fetchedAt:Date.now(),windows:[],error:"Quota snapshot failed validation"};
    }
    return result;
  }
  async stopProject(projectId:string):Promise<boolean>{const pending=await this.#stopMatching(item=>item.stored.projectId===projectId,"Project directory grant was revoked");return pending||[...this.#runs.values()].some(item=>item.projectId===projectId&&item.run.quiescent!==true);}
  async stopWorkspace(cwd:string):Promise<boolean>{const actual=canonicalExecutionPath(cwd);const pending=await this.#stopMatching(item=>within(item.stored.cwd,actual)||within(actual,item.stored.cwd),"Task workspace cleanup requested");return pending||[...this.#runs.values()].some(item=>item.run.quiescent!==true&&(within(item.cwd,actual)||within(actual,item.cwd)));}
  async #stopMatching(match:(live:LiveRun)=>boolean,message:string):Promise<boolean>{let pending=false;for(const live of[...this.#live.values()])if(match(live)){if(!live.driver)for(const cleanup of live.cleanups??[])await cleanup().catch(()=>false);live.driver?.close();this.#finish(live,"uncertain",message,"closed");if(!await this.#settle(live))pending=true;}return pending;}
  async close():Promise<void>{this.#closed=true;for(const controller of this.#activeQuotas)controller.abort();await this.#stopMatching(()=>true,"Env runtime stopped before native completion");while(this.#background.size)await Promise.allSettled([...this.#background]);if(this.#backgroundError)throw this.#backgroundError;}
}
