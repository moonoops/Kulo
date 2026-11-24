import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ExternalAgentModelInfo, ExternalAgentQuotaProbeResult } from "@kulo/protocol";
import { managedNativeProcess, nativeAgentEnvironment, type ExternalDriver, type ExternalDriverContext } from "./external-agent-drivers.js";
import { parseClaudeControlUsageResponse, parseClaudeRateLimitEvent, sanitizeQuotaError } from "./external-agent-quota.js";
import { resolveSafeExternalImages, type ResolvedExternalImage } from "./external-agent-validation.js";

const CLAUDE_READ_ONLY_DISALLOWED_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;
const CLAUDE_MAX_IMAGES = 4;
const CLAUDE_MAX_IMAGE_FILE_BYTES = Math.floor(3.5 * 1024 * 1024);
const CLAUDE_MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;

export function claudeThinkingOptions(level?:string):Pick<Options,"effort"|"thinking">{
  if(level===undefined)return{};
  if(level==="none"||level==="disabled")return{thinking:{type:"disabled"}};
  if(level==="adaptive")return{thinking:{type:"adaptive"}};
  if(["low","medium","high","xhigh","max"].includes(level))return{effort:level as Options["effort"]};
  throw new Error("Selected thinking level is not supported by Claude Code");
}
export function claudeServiceTierOptions(tier?:string):Pick<Options,"settings">{
  if(tier===undefined)return{};
  if(tier==="fast")return{settings:{fastMode:true}};
  if(tier==="default"||tier==="standard")return{settings:{fastMode:false}};
  throw new Error("Selected service tier is not supported by Claude Code");
}
export function nativeClaudeOptions(ctx:ExternalDriverContext):Options{
  const isReadOnly=Boolean(ctx.readOnly||ctx.workspaceMode==="read_only");
  const appendedInstructions=ctx.developerInstructions?.trim();
  const systemPrompt:Options["systemPrompt"]=appendedInstructions
    ?{type:"preset",preset:"claude_code",append:appendedInstructions,snapshot:true}
    :{type:"preset",preset:"claude_code"};
  return{
    cwd:ctx.cwd,...(ctx.modelId?{model:ctx.modelId}:{}),...(ctx.sessionId?{resume:ctx.sessionId}:{}),
    settingSources:["user","project","local"],pathToClaudeCodeExecutable:ctx.executable,includePartialMessages:true,env:nativeAgentEnvironment("claude-code",{trustMode:ctx.trustMode,blockedEnvNames:ctx.blockedEnvNames}),
    systemPrompt,...claudeThinkingOptions(ctx.thinkingLevel),...claudeServiceTierOptions(ctx.serviceTier),
    ...(isReadOnly?{disallowedTools:[...CLAUDE_READ_ONLY_DISALLOWED_TOOLS]}:{}),
    ...(ctx.servers.length?{mcpServers:Object.fromEntries(ctx.servers.map(server=>[server.name,{type:"http" as const,url:server.url,headers:Object.fromEntries((server.headers??[]).map(row=>[row.name,row.value]))}]))}:{}),
    canUseTool:async(name,input,request)=>{
      if(isReadOnly&&(CLAUDE_READ_ONLY_DISALLOWED_TOOLS as readonly string[]).includes(name)){
        return{behavior:"deny",message:"Write tools are disabled in read-only mode"};
      }
      const suggestions=request.suggestions??[];
      const choices=[{id:"allow",label:"Allow once"},...(suggestions.length?[{id:"allow-suggested",label:"Allow with client's suggested permissions"}]:[]),{id:"deny",label:"Reject"}];
      const choice=await ctx.permission(`claude:${request.toolUseID}`,`${name}: ${JSON.stringify(input)}`,choices);
      return choice==="allow"||choice==="allow-suggested"?{behavior:"allow",updatedInput:input,...(choice==="allow-suggested"?{updatedPermissions:suggestions}:{})}:{behavior:"deny",message:"Tool request declined"};
    },
    stderr:message=>ctx.event("error",message),
  };
}
export async function connectClaude(ctx:ExternalDriverContext,probe=false):Promise<{driver:ExternalDriver;models:ExternalAgentModelInfo[];authenticated:boolean|null}>{
  const thinkingOptions=claudeThinkingOptions(ctx.thinkingLevel);
  claudeServiceTierOptions(ctx.serviceTier);
  const {query}=await import("@anthropic-ai/claude-agent-sdk");
  const abortController=new AbortController();let release:(value:boolean)=>void=()=>{};let started=false;let cancelRequested=false;let closed=false;
  let child:ChildProcessWithoutNullStreams|undefined;let cleanup:(()=>Promise<boolean>)|undefined;
  let resolvedImages:ResolvedExternalImage[]=[];
  const gate=new Promise<boolean>(resolve=>{release=resolve;});
  async function* prompt():AsyncGenerator<SDKUserMessage>{
    if(!(await gate))return;
    const content:SDKUserMessage["message"]["content"]=resolvedImages.length>0
      ?[
        {type:"text",text:ctx.prompt},
        ...resolvedImages.map(image=>({
          type:"image" as const,
          source:{type:"base64" as const,media_type:image.mimeType,data:image.base64!},
        })),
      ]
      :ctx.prompt;
    yield{type:"user",message:{role:"user",content},parent_tool_use_id:null,session_id:ctx.sessionId??""};
  }
  const options:Options={
    spawnClaudeCodeProcess:spec=>{
      if(!ctx.controlRoot)throw new Error("Claude task process supervision is unavailable");
      const managed=managedNativeProcess({executable:spec.command,args:spec.args,cwd:ctx.cwd,env:spec.env,controlRoot:ctx.controlRoot,projectId:ctx.projectId});child=managed.child;cleanup=managed.cleanup;
      const aborted=()=>{child?.kill();};spec.signal.addEventListener("abort",aborted,{once:true});
      const removeAbort=()=>spec.signal.removeEventListener("abort",aborted);child.once("exit",removeAbort);child.once("error",removeAbort);ctx.registerCleanup?.(managed.cleanup);return child;
    },
    ...nativeClaudeOptions(ctx),abortController,
  };
  const agent=query({prompt:prompt(),options});
  const driver:ExternalDriver={cancel:async()=>{cancelRequested=true;await agent.interrupt();},close:()=>{if(closed)return;closed=true;release(false);abortController.abort();agent.close();},cleanup:async()=>cleanup?cleanup():false};
  try{
    await agent.initializationResult();
    const catalog=await agent.supportedModels();
    const models:ExternalAgentModelInfo[]=catalog.map(model=>{
      const efforts=[...(model.supportsAdaptiveThinking?["adaptive"]:[]),...(model.supportsEffort?model.supportedEffortLevels??[]:[]),"none"];
      const serviceTiers=model.supportsFastMode?[{id:"fast",name:"Fast"}]:undefined;
      return{id:model.value,name:model.displayName,...(efforts.length?{efforts:[...new Set(efforts)]}:{}),...(serviceTiers?{serviceTiers}:{}),...(model.value==="default"?{isDefault:true}:{})};
    });
    const selected=catalog.find(model=>model.value===(ctx.modelId??"default")||ctx.modelId!==undefined&&model.resolvedModel===ctx.modelId);
    if(ctx.modelId&&!selected)throw new Error("Selected model is not advertised by Claude Code");
    if(ctx.thinkingLevel&&thinkingOptions.effort&&(!selected?.supportsEffort||!selected.supportedEffortLevels?.includes(thinkingOptions.effort)))throw new Error("Selected thinking level is not advertised by Claude Code for this model");
    if(ctx.thinkingLevel==="adaptive"&&!selected?.supportsAdaptiveThinking)throw new Error("Adaptive thinking is not advertised by Claude Code for this model");
    if(ctx.serviceTier==="fast"&&!selected?.supportsFastMode)throw new Error("Fast mode is not advertised by Claude Code for this model");
    if(!probe){
      resolvedImages=resolveSafeExternalImages({
        attachments:ctx.attachments,
        expectedInputsDir:ctx.inputsDir,
        overlapsProtected:ctx.overlapsProtected,
        maxCount:CLAUDE_MAX_IMAGES,
        maxFileBytes:CLAUDE_MAX_IMAGE_FILE_BYTES,
        maxTotalBytes:CLAUDE_MAX_IMAGE_TOTAL_BYTES,
        readBytes:true,
        onSkip:reason=>ctx.event("state",reason),
      });
      started=true;ctx.submitted();release(true);
      void(async()=>{
        let resultSeen=false;let streamed=false;const seenToolIds=new Set<string>();
        try{for await(const message of agent){
          if("session_id" in message&&typeof message.session_id==="string")ctx.session(message.session_id);
          if(message.type==="stream_event"){
            const ev=message.event;
            if(ev.type==="content_block_start"&&ev.content_block.type==="tool_use"){
              if(typeof ev.content_block.id==="string")seenToolIds.add(ev.content_block.id);
              ctx.event("tool",ev.content_block.name||"tool_use");
            }else if(ev.type==="content_block_delta"){
              if(ev.delta.type==="text_delta"){streamed=true;ctx.event("message",ev.delta.text);}
              else if(ev.delta.type==="thinking_delta"||ev.delta.type==="input_json_delta"){ctx.activity?.("Thinking...");}
            }
          }
          if(message.type==="tool_progress"){
            ctx.activity?.("Running tool...");
          }
          if(message.type==="assistant"){
            for(const block of message.message.content){
              if(block.type==="text"&&!streamed)ctx.event("message",block.text);
              if(block.type==="tool_use"){
                const inputObj=block.input&&typeof block.input==="object"&&!Array.isArray(block.input)?block.input as Record<string,unknown>:undefined;
                const detail=typeof inputObj?.file_path==="string"?inputObj.file_path:typeof inputObj?.path==="string"?inputObj.path:typeof inputObj?.command==="string"?inputObj.command.slice(0,160):"";
                const alreadySeen=typeof block.id==="string"&&seenToolIds.has(block.id);
                if(!alreadySeen||detail){
                  if(typeof block.id==="string")seenToolIds.add(block.id);
                  ctx.event("tool",detail?`${block.name} ${detail}`:block.name);
                }
              }
            }
          }
          if(message.type==="rate_limit_event"){
            const parsed=parseClaudeRateLimitEvent(message.rate_limit_info);
            if(parsed)ctx.quota?.(parsed);
          }
          if(message.type==="result"){
            resultSeen=true;
            if(message.subtype==="success"&&!message.is_error)ctx.complete(cancelRequested&&message.stop_reason!=="end_turn"?"cancelled":"completed");
            else ctx.complete(cancelRequested?"cancelled":"failed","errors" in message?message.errors.join("\n"):"Claude Code returned an error");
            break;
          }
        }if(!resultSeen&&!closed)ctx.complete("uncertain","Claude Code ended without a terminal result");}
        catch(error){if(!closed)ctx.complete("uncertain",error instanceof Error?error.message:"Claude Code transport failed");}
        finally{driver.close();}
      })();
    }
    return{driver,models,authenticated:null};
  }catch(error){if(started)ctx.complete("uncertain",error instanceof Error?error.message:"Claude initialization failed");driver.close();throw error;}
}

/**
 * Isolated read-only SDK options strictly for active quota probes:
 * disables project/local settings, user stdio MCP servers, built-in tools, and all shell Hooks
 * so quota refreshes never launch user MCPs or trigger SessionStart hooks.
 */
export function quotaClaudeOptions(executable: string, cwd: string, blockedEnvNames?: Iterable<string>): Options {
  return {
    cwd,
    settingSources: ["user"],
    pathToClaudeCodeExecutable: executable,
    env: nativeAgentEnvironment("claude-code", { blockedEnvNames }),
    strictMcpConfig: true,
    mcpServers: {},
    tools: [],
    settings: { disableAllHooks: true },
    canUseTool: async () => ({ behavior: "deny", message: "Quota probe is read-only" }),
  };
}

type ClaudeSdkQueryFn = typeof import("@anthropic-ai/claude-agent-sdk")["query"];

export async function probeClaudeQuota(options: {
  executable: string;
  cwd: string;
  controlRoot: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  redact?: (value: string) => string;
  queryFn?: ClaudeSdkQueryFn;
  blockedEnvNames?: Iterable<string>;
}): Promise<ExternalAgentQuotaProbeResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (options.signal?.aborted) {
    return { kind: "claude-code", status: "unavailable", source: "live", fetchedAt: Date.now(), windows: [], error: "Quota check aborted" };
  }
  const queryFn = options.queryFn ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
  const abortController = new AbortController();
  let release: (value: boolean) => void = () => {};
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    if (await gate) {
      yield { type: "user", message: { role: "user", content: "" }, parent_tool_use_id: null, session_id: "" };
    }
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let cleanup: (() => Promise<boolean>) | undefined;
  const sdkOptions: Options = {
    spawnClaudeCodeProcess: (spec) => {
      const managed = managedNativeProcess({
        executable: spec.command,
        args: spec.args,
        cwd: options.cwd,
        env: spec.env,
        controlRoot: options.controlRoot,
      });
      child = managed.child;
      cleanup = managed.cleanup;
      const aborted = () => { child?.kill(); };
      spec.signal.addEventListener("abort", aborted, { once: true });
      const removeAbort = () => spec.signal.removeEventListener("abort", aborted);
      child.once("exit", removeAbort);
      child.once("error", removeAbort);
      return child;
    },
    ...quotaClaudeOptions(options.executable, options.cwd, options.blockedEnvNames),
    abortController,
  };
  const agent = queryFn({ prompt: prompt(), options: sdkOptions });
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    release(false);
    abortController.abort();
    try { agent.close(); } catch { /* ignore */ }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const deadlinePromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      onAbort();
      reject(new Error("Claude Code quota request timed out"));
    }, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([agent.initializationResult(), deadlinePromise]);
    const usageFn = (agent as unknown as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof usageFn !== "function") {
      return {
        kind: "claude-code",
        status: "unavailable",
        source: "live",
        fetchedAt: Date.now(),
        windows: [],
        error: "Installed Claude SDK does not expose active usage API",
      };
    }
    const response = await Promise.race([
      (usageFn as (opts?: { skipBehaviors?: boolean }) => Promise<unknown>).call(agent, { skipBehaviors: true }),
      deadlinePromise,
    ]);
    return parseClaudeControlUsageResponse(response, Date.now());
  } catch (error) {
    const rawMsg = timedOut ? "Claude Code quota request timed out" : (error instanceof Error ? error.message : "Claude Code quota query failed");
    return {
      kind: "claude-code",
      status: "unavailable",
      source: "live",
      fetchedAt: Date.now(),
      windows: [],
      error: sanitizeQuotaError(rawMsg, options.redact),
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    release(false);
    abortController.abort();
    try { agent.close(); } catch { /* ignore */ }
    if (cleanup) await cleanup().catch(() => false);
  }
}
