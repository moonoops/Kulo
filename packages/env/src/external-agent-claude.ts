import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ExternalAgentModelInfo } from "@moco/protocol";
import { managedNativeProcess, nativeAgentEnvironment, type ExternalDriver, type ExternalDriverContext } from "./external-agent-drivers.js";

export function claudeThinkingOptions(level?:string):Pick<Options,"effort"|"thinking">{
  if(level===undefined)return{};
  if(level==="none"||level==="disabled")return{thinking:{type:"disabled"}};
  if(level==="adaptive")return{thinking:{type:"adaptive"}};
  if(["low","medium","high","xhigh","max"].includes(level))return{effort:level as Options["effort"]};
  throw new Error("Selected thinking level is not supported by Claude Code");
}
export function nativeClaudeOptions(ctx:ExternalDriverContext):Options{
  return{
    cwd:ctx.cwd,...(ctx.modelId?{model:ctx.modelId}:{}),...(ctx.sessionId?{resume:ctx.sessionId}:{}),
    settingSources:["user","project","local"],pathToClaudeCodeExecutable:ctx.executable,includePartialMessages:true,env:nativeAgentEnvironment(),
    systemPrompt:{type:"preset",preset:"claude_code"},...claudeThinkingOptions(ctx.thinkingLevel),
    ...(ctx.servers.length?{mcpServers:Object.fromEntries(ctx.servers.map(server=>[`moco-${randomUUID()}-${server.name}`,{type:"http" as const,url:server.url,headers:Object.fromEntries((server.headers??[]).map(row=>[row.name,row.value]))}]))}:{}),
    canUseTool:async(name,input,request)=>{
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
  const {query}=await import("@anthropic-ai/claude-agent-sdk");
  const abortController=new AbortController();let release:(value:boolean)=>void=()=>{};let started=false;let cancelRequested=false;let closed=false;
  let child:ChildProcessWithoutNullStreams|undefined;let cleanup:(()=>Promise<boolean>)|undefined;
  const gate=new Promise<boolean>(resolve=>{release=resolve;});
  async function* prompt():AsyncGenerator<SDKUserMessage>{if(await gate)yield{type:"user",message:{role:"user",content:ctx.prompt},parent_tool_use_id:null,session_id:ctx.sessionId??""};}
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
      return{id:model.value,name:model.displayName,...(efforts.length?{efforts:[...new Set(efforts)]}:{}),...(model.value==="default"?{isDefault:true}:{})};
    });
    const selected=catalog.find(model=>model.value===(ctx.modelId??"default")||ctx.modelId!==undefined&&model.resolvedModel===ctx.modelId);
    if(ctx.modelId&&!selected)throw new Error("Selected model is not advertised by Claude Code");
    if(ctx.thinkingLevel&&thinkingOptions.effort&&(!selected?.supportsEffort||!selected.supportedEffortLevels?.includes(thinkingOptions.effort)))throw new Error("Selected thinking level is not advertised by Claude Code for this model");
    if(ctx.thinkingLevel==="adaptive"&&!selected?.supportsAdaptiveThinking)throw new Error("Adaptive thinking is not advertised by Claude Code for this model");
    if(!probe){
      started=true;ctx.submitted();release(true);
      void(async()=>{
        let resultSeen=false;let streamed=false;
        try{for await(const message of agent){
          if("session_id" in message&&typeof message.session_id==="string")ctx.session(message.session_id);
          if(message.type==="stream_event"&&message.event.type==="content_block_delta"&&message.event.delta.type==="text_delta"){streamed=true;ctx.event("message",message.event.delta.text);}
          if(message.type==="assistant"&&!streamed){for(const block of message.message.content){if(block.type==="text")ctx.event("message",block.text);}}
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
