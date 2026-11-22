import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectAcp, connectCodex, nativeAgentEnvironment, type ExternalDriverContext } from "../packages/env/src/external-agent-drivers.js";
import { claudeServiceTierOptions, claudeThinkingOptions, nativeClaudeOptions } from "../packages/env/src/external-agent-claude.js";
import type { ExternalAgentPipeOptions } from "../packages/env/src/external-agent-rpc.js";
const roots:string[]=[];afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(kind:"codex"|"dsh"="codex"){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"kulo-native-driver-"));roots.push(root);const cwd=path.join(root,"work");fs.mkdirSync(cwd);
 const sent:any[]=[],responses=new Map<number,any>();let spec:ExternalAgentPipeOptions;
 const reply=(id:number,result:unknown)=>spec.onStdout(Buffer.from(JSON.stringify({id,result})+"\n"));
 const ctx:ExternalDriverContext={binding:{kind,envId:"local"},executable:process.execPath,cwd,prompt:"native task",timeoutMs:10_000,readOnly:false,controlRoot:path.join(root,"control"),servers:[],event:vi.fn(),session:vi.fn(),submitted:vi.fn(),complete:vi.fn(),permission:vi.fn(async()=>"0"),pipe:async value=>{spec=value;return{exited:new Promise(()=>{}),close:vi.fn(),cleanup:async()=>true,write:raw=>{const message=JSON.parse(raw);sent.push(message);if(!message.method){responses.set(message.id,message);return;}const {id,method}=message;if(id===undefined)return;
 if(method==="initialize")reply(id,kind==="codex"?{}:{agentCapabilities:{mcpCapabilities:{http:true}}});
 else if(method==="model/list")reply(id,{data:[{id:"native-alias",model:"native-model",displayName:"Native",isDefault:true,supportedReasoningEfforts:[{reasoningEffort:"high"}],serviceTiers:[{id:"fast",name:"Fast",description:"Faster responses"},{id:"ultrafast",name:"Ultra Fast",description:"Fastest responses"}],defaultServiceTier:"default"}]});
 else if(method==="account/read")reply(id,{account:{type:"chatgpt"}});
 else if(method==="thread/start"||method==="thread/resume")reply(id,{thread:{id:"thread-native"},model:"native-model"});
 else if(method==="turn/start")reply(id,{turn:{id:"turn-native"}});
 else if(method==="session/new")reply(id,{sessionId:"acp-native",configOptions:[{id:"model",category:"model",options:[{value:"native-model",name:"Native"}]},{id:"thinking",category:"thought_level",options:[{value:"high",name:"High"}]}]});
 else if(method==="session/set_config_option")reply(id,{});
 else if(method==="session/prompt")reply(id,{stopReason:"end_turn"});
 else throw new Error("Unexpected native call "+method);
 }};}};
 return{ctx,sent,responses,root,get spec(){return spec;},async request(id:number,method:string,params:unknown){spec.onStdout(Buffer.from(JSON.stringify({id,method,params})+"\n"));await vi.waitFor(()=>expect(responses.has(id)).toBe(true));return responses.get(id);}};
}
describe("native external client ownership",()=>{
 it("launches Codex with native settings and omits unspecified model, thinking, and permission overrides",async()=>{
  const f=fixture();const result=await connectCodex(f.ctx);expect(f.spec.args).toEqual(["app-server"]);expect(f.spec.isolated).toBe(false);expect(f.spec.env).toEqual({});
  expect(f.sent.find(value=>value.method==="thread/start").params).toEqual({cwd:f.ctx.cwd});
  expect(f.sent.find(value=>value.method==="turn/start").params).toEqual({threadId:"thread-native",cwd:f.ctx.cwd,input:[{type:"text",text:"native task",text_elements:[]}]});
  expect(f.sent.some(value=>["permissionProfile/list","config/read"].includes(value.method))).toBe(false);result.driver.close();
 });
 it("passes advertised model, effort, and serviceTier (fast/ultrafast) to Codex and rejects unsupported serviceTiers",async()=>{
  const f=fixture();f.ctx.modelId="native-model";f.ctx.thinkingLevel="high";f.ctx.serviceTier="ultrafast";const decisions=["decline",{acceptWithExecpolicyAmendment:{execpolicyAmendment:["node"]}}];f.ctx.permission=vi.fn(async()=>"1");const result=await connectCodex(f.ctx);
  expect(result.models[0]).toMatchObject({id:"native-model",defaultServiceTier:"default",serviceTiers:[{id:"fast",name:"Fast",description:"Faster responses"},{id:"ultrafast",name:"Ultra Fast",description:"Fastest responses"}]});
  expect(f.sent.find(value=>value.method==="thread/start").params).toMatchObject({model:"native-model",serviceTier:"ultrafast"});
  expect(f.sent.find(value=>value.method==="turn/start").params).toMatchObject({model:"native-model",effort:"high",serviceTier:"ultrafast"});
  expect(await f.request(700,"item/commandExecution/requestApproval",{threadId:"thread-native",command:"node build.js",availableDecisions:decisions})).toMatchObject({result:{decision:decisions[1]}});result.driver.close();

  const bad=fixture();bad.ctx.modelId="native-model";bad.ctx.serviceTier="turbo-invalid";
  await expect(connectCodex(bad.ctx)).rejects.toThrow("service tier");
  expect(bad.ctx.submitted).not.toHaveBeenCalled();
 });
 it("rejects explicit unsupported effort before submitting a prompt and appends only the voluntary collaboration MCP",async()=>{
  const f=fixture();f.ctx.thinkingLevel="unsupported";await expect(connectCodex(f.ctx)).rejects.toThrow("thinking level");expect(f.ctx.submitted).not.toHaveBeenCalled();
  const g=fixture();g.ctx.servers=[{name:"kulo-task",url:"http://127.0.0.1:12345"}];const result=await connectCodex(g.ctx);const config=g.sent.find(value=>value.method==="thread/start").params.config;expect(Object.values(config.mcp_servers)).toEqual([{enabled:true,url:"http://127.0.0.1:12345",http_headers:{}}]);expect(Object.keys(config)).toEqual(["mcp_servers"]);result.driver.close();
 });
 it("adapts advertised ACP file and terminal capabilities without a worker sandbox or fixed provider",async()=>{
  const f=fixture("dsh");f.ctx.thinkingLevel="high";const result=await connectAcp(f.ctx,true);expect(f.spec.args).toEqual(["--profile","acp"]);expect(f.spec.isolated).toBe(false);expect(f.spec.env).toEqual({});expect(f.sent.find(value=>value.method==="initialize").params.clientCapabilities).toEqual({fs:{readTextFile:true,writeTextFile:true},terminal:true});
  const file=path.join(f.root,"native-outside-workspace.txt");expect(await f.request(701,"fs/write_text_file",{sessionId:"acp-native",path:file,content:"first\nsecond"})).toMatchObject({result:{}});expect(await f.request(702,"fs/read_text_file",{sessionId:"acp-native",path:file,line:2,limit:1})).toMatchObject({result:{content:"second"}});
  const created=await f.request(703,"terminal/create",{sessionId:"acp-native",command:process.execPath,args:["-e","process.stdout.write('native-result')"]});const terminalId=created.result.terminalId;expect(await f.request(704,"terminal/wait_for_exit",{sessionId:"acp-native",terminalId})).toMatchObject({result:{exitCode:0}});expect(await f.request(705,"terminal/output",{sessionId:"acp-native",terminalId})).toMatchObject({result:{output:"native-result",truncated:false}});expect(await result.driver.cleanup!()).toBe(true);
 });
 it("restores Claude native tools, settings and default permissions while bridging requested permission suggestions",async()=>{
  const f=fixture();f.ctx.binding.kind="claude-code";f.ctx.permission=vi.fn(async()=>"allow-suggested");const options=nativeClaudeOptions(f.ctx);
  for(const key of["tools","disallowedTools","hooks","sandbox","permissionMode","strictMcpConfig","mcpServers","effort","thinking"])expect(options).not.toHaveProperty(key);
  expect(options.settingSources).toEqual(["user","project","local"]);const suggestions=[{type:"setMode",mode:"acceptEdits",destination:"session"}];expect(await options.canUseTool!("Bash",{command:"native build"},{toolUseID:"native-permission",suggestions,signal:new AbortController().signal})).toEqual({behavior:"allow",updatedInput:{command:"native build"},updatedPermissions:suggestions});
  expect(claudeThinkingOptions("high")).toEqual({effort:"high"});expect(claudeThinkingOptions("none")).toEqual({thinking:{type:"disabled"}});expect(()=>claudeThinkingOptions("minimal")).toThrow("not supported");
  expect(claudeServiceTierOptions("fast")).toEqual({settings:{fastMode:true}});expect(claudeServiceTierOptions("default")).toEqual({settings:{fastMode:false}});expect(()=>claudeServiceTierOptions("unknown")).toThrow("not supported");
  expect(nativeClaudeOptions({...f.ctx,serviceTier:"fast"}).settings).toEqual({fastMode:true});
 });
 it("enforces ACP protected path, staged containment, and read-only terminal guards",async()=>{
  const f=fixture("dsh");f.ctx.workspaceMode="staged";f.ctx.scratchNotesDir=path.join(f.root,"notes");fs.mkdirSync(f.ctx.scratchNotesDir);
  const result=await connectAcp(f.ctx,true);
  const outside=path.join(f.root,"outside-staged.txt");
  expect((await f.request(801,"fs/write_text_file",{sessionId:"acp-native",path:outside,content:"nope"})).error).toBeDefined();
  expect(fs.existsSync(outside)).toBe(false);
  const gitHook=path.join(f.ctx.cwd,".git/hooks/pre-commit");fs.mkdirSync(path.dirname(gitHook),{recursive:true});
  expect((await f.request(802,"fs/write_text_file",{sessionId:"acp-native",path:gitHook,content:"#!/bin/sh\n"})).error).toBeDefined();
  expect(fs.existsSync(gitHook)).toBe(false);
  const inside=path.join(f.ctx.cwd,"ok.txt");
  expect(await f.request(803,"fs/write_text_file",{sessionId:"acp-native",path:inside,content:"staged ok"})).toMatchObject({result:{}});
  expect(await f.request(804,"fs/read_text_file",{sessionId:"acp-native",path:inside})).toMatchObject({result:{content:"staged ok"}});
  const devicesFile=path.join(f.ctx.cwd,"devices.json");fs.writeFileSync(devicesFile,"{}");
  expect((await f.request(805,"fs/read_text_file",{sessionId:"acp-native",path:devicesFile})).error).toBeDefined();
  result.driver.close();

  const ro=fixture("dsh");ro.ctx.workspaceMode="read_only";ro.ctx.readOnly=true;ro.ctx.scratchNotesDir=path.join(ro.root,"notes");fs.mkdirSync(ro.ctx.scratchNotesDir);
  const roResult=await connectAcp(ro.ctx,true);
  expect((await ro.request(806,"terminal/create",{sessionId:"acp-native",command:process.execPath,args:["-v"]})).error).toBeDefined();
  const escapeTarget=path.join(ro.root,"escaped.txt");const escapeLink=path.join(ro.ctx.scratchNotesDir,"link.txt");fs.symlinkSync(escapeTarget,escapeLink);
  expect((await ro.request(807,"fs/write_text_file",{sessionId:"acp-native",path:escapeLink,content:"escape"})).error).toBeDefined();
  expect(fs.existsSync(escapeTarget)).toBe(false);
  roResult.driver.close();
 });
 it("keeps client authentication and proxy settings while excluding Kulo management credentials",()=>{
  vi.stubEnv("KULO_AUTH_TOKEN","kulo-private");vi.stubEnv("KULO_ENV_PEER_CONFIG","private-peer");vi.stubEnv("ANTHROPIC_API_KEY","native-client-key");vi.stubEnv("HTTPS_PROXY","http://native-proxy.invalid");const env=nativeAgentEnvironment();expect(env.KULO_AUTH_TOKEN).toBeUndefined();expect(env.KULO_ENV_PEER_CONFIG).toBeUndefined();expect(env.ANTHROPIC_API_KEY).toBe("native-client-key");expect(env.HTTPS_PROXY).toBe("http://native-proxy.invalid");
 });
});
