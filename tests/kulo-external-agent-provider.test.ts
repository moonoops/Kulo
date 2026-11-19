import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startExternalProviderProxy } from "../packages/env/src/external-agent-provider.js";
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function upstream(handler:(request:http.IncomingMessage,response:http.ServerResponse)=>void){const server=http.createServer(handler);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));closes.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
describe("task-scoped provider credential proxy",()=>{
 it("keeps the real key on the host, forwards fixed provider routes, and expires the task capability",async()=>{
  const seen:Array<{url:string;key:string|undefined;auth:string|undefined}>=[];const url=await upstream((request,response)=>{seen.push({url:request.url!,key:request.headers["x-api-key"] as string|undefined,auth:request.headers.authorization});response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({content:[{type:"text",text:"done"}]}));});
  const proxy=await startExternalProviderProxy({kind:"dsh",timeoutMs:10_000,upstream:url+"/anthropic",key:"real-host-provider-key"});closes.push(proxy.close);
  expect(proxy.env.DEEPSEEK_API_KEY).not.toBe("real-host-provider-key");expect(Object.values(proxy.env).join()).not.toContain("real-host-provider-key");
  const response=await fetch(proxy.env.DEEPSEEK_BASE_URL+"/v1/messages",{method:"POST",headers:{"x-api-key":proxy.env.DEEPSEEK_API_KEY!,"content-type":"application/json"},body:JSON.stringify({model:"deepseek-chat",messages:[]})});expect(response.status).toBe(200);expect(seen).toEqual([{url:"/anthropic/v1/messages",key:"real-host-provider-key",auth:"Bearer real-host-provider-key"}]);await proxy.close();await expect(fetch(proxy.env.DEEPSEEK_BASE_URL+"/v1/messages")).rejects.toThrow();
 });
 it("rejects redirects, arbitrary URLs, user file listing, and unowned file handles",async()=>{
  let calls=0;const url=await upstream((_request,response)=>{calls++;response.writeHead(302,{location:"http://evil.invalid"});response.end();});const proxy=await startExternalProviderProxy({kind:"dsh",timeoutMs:10_000,upstream:url,key:"real-host-key"});closes.push(proxy.close);const headers={"x-api-key":proxy.env.DEEPSEEK_API_KEY!};
  for(const route of["/v1/files","/v1/files/private-file","/../../admin","/v1/messages?target=https://evil.invalid"]){const response=await fetch(proxy.env.DEEPSEEK_BASE_URL+route,{headers});expect(response.status).toBeGreaterThanOrEqual(400);}expect(calls).toBe(0);
  const response=await fetch(proxy.env.DEEPSEEK_BASE_URL+"/v1/messages",{method:"POST",headers,body:"{}"});expect(response.status).toBe(502);expect(calls).toBe(1);expect(await response.text()).not.toContain("real-host-key");
 });
 it("binds Gemini query-key auth to public model endpoints and strips the ephemeral query token upstream",async()=>{
  let received="";let real="";const url=await upstream((request,response)=>{received=request.url!;real=String(request.headers["x-goog-api-key"]);response.writeHead(200,{"content-type":"text/event-stream"});response.end("data: {}\n\n");});const proxy=await startExternalProviderProxy({kind:"antigravity",timeoutMs:10_000,upstream:url,key:"gemini-host-key"});closes.push(proxy.close);
  const response=await fetch(proxy.env.GOOGLE_GEMINI_BASE_URL+`/v1beta/models/gemini-flash:streamGenerateContent?alt=sse&key=${proxy.env.GEMINI_API_KEY}`,{method:"POST",body:"{}"});expect(response.status).toBe(200);await response.text();expect(received).toBe("/v1beta/models/gemini-flash:streamGenerateContent?alt=sse");expect(real).toBe("gemini-host-key");expect((await fetch(proxy.env.GOOGLE_GEMINI_BASE_URL+"/v1beta/tunedModels/private",{headers:{"x-goog-api-key":proxy.env.GEMINI_API_KEY!}})).status).toBe(403);
 });
});
