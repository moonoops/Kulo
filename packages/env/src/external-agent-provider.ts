import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";


export interface ExternalProviderProxy {
  port:number;
  env:Record<string,string>;
  close():Promise<void>;
}
interface ProviderOptions {
  kind:"dsh"|"antigravity";
  timeoutMs:number;
  /** Internal test seam; no control-plane request can select an upstream or inject a real key. */
  upstream?:string;
  key?:string;
}
const same=(actual:unknown,expected:string):boolean=>{if(typeof actual!=="string")return false;const value=Buffer.from(actual),token=Buffer.from(expected);return value.length===token.length&&timingSafeEqual(value,token);};
/** The provider credential stays in Env. Native tools inherit only an expiring task capability. */
export async function startExternalProviderProxy(options:ProviderOptions):Promise<ExternalProviderProxy>{
  const {EnvHttpProxyAgent,fetch:proxyFetch}=await import("undici");
  const gemini=options.kind==="antigravity";
  const key=options.key??process.env[gemini?"GEMINI_API_KEY":"DEEPSEEK_API_KEY"];
  if(!key)throw new Error(`${gemini?"GEMINI_API_KEY":"DEEPSEEK_API_KEY"} must be configured in this Env before running the isolated local client`);
  const upstream=new URL(options.upstream??(gemini?"https://generativelanguage.googleapis.com":"https://api.deepseek.com/anthropic"));
  const transport=new EnvHttpProxyAgent();
  const token=randomBytes(32).toString("hex");let closed=false;let requests=0;let active=0;
  const controllers=new Set<AbortController>();
  const files=new Set<string>();
  const server=http.createServer(async(request,response)=>{
    const deny=(status:number,message:string)=>{response.writeHead(status,{"content-type":"application/json"});response.end(JSON.stringify({error:{message}}));};
    if(closed||request.headers.host!==`127.0.0.1:${(server.address() as {port:number})?.port}`||request.headers.origin){deny(403,"Provider task scope is unavailable");return;}
    const url=new URL(request.url??"/","http://127.0.0.1");
    const auth=request.headers.authorization;const supplied=typeof auth==="string"&&auth.startsWith("Bearer ")?auth.slice(7):request.headers[gemini?"x-goog-api-key":"x-api-key"]??url.searchParams.get("key");
    if(!same(supplied,token)){deny(401,"Invalid provider task capability");return;}
    const pathname=url.pathname;
    const pathAllowed=gemini?/^\/(?:v1|v1beta)\/models(?:\/[a-zA-Z0-9._-]+(?::(?:generateContent|streamGenerateContent|countTokens))?)?$/.test(pathname):pathname==="/v1/messages"||pathname==="/v1/messages/count_tokens"||pathname==="/v1/files"&&request.method==="POST"||/^\/v1\/files\/[a-zA-Z0-9_-]+(?:\/content)?$/.test(pathname)&&files.has(pathname.split("/")[3]!);
    if(!pathAllowed||!["GET","POST","DELETE"].includes(request.method??"")||++requests>256||active>=4){deny(403,"Provider operation is outside this task capability");return;}
    if(gemini&&request.method==="DELETE"||!gemini&&pathname.startsWith("/v1/messages")&&request.method!=="POST"){deny(403,"Provider method is unavailable");return;}
    const queryKeys=gemini?new Set(["alt","key"]):new Set<string>();if([...url.searchParams.keys()].some(name=>!queryKeys.has(name))){deny(400,"Unsupported provider query");return;}
    active++;const controller=new AbortController();controllers.add(controller);
    const abort=()=>controller.abort();request.once("aborted",abort);response.once("close",abort);
    try{
      const chunks:Buffer[]=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>16*1024*1024)throw new Error("Provider request exceeds task limit");chunks.push(Buffer.from(chunk));}
      const target=new URL(upstream.href.replace(/\/$/,"")+pathname);url.searchParams.delete("key");target.search=url.search;
      const headers:Record<string,string>={"content-type":String(request.headers["content-type"]??"application/json")};
      if(gemini)headers["x-goog-api-key"]=key;else{headers["x-api-key"]=key;headers.authorization=`Bearer ${key}`;if(typeof request.headers["anthropic-version"]==="string")headers["anthropic-version"]=request.headers["anthropic-version"];if(typeof request.headers["anthropic-beta"]==="string"&&request.headers["anthropic-beta"].length<2000)headers["anthropic-beta"]=request.headers["anthropic-beta"];}
      const result=await proxyFetch(target,{method:request.method,headers,body:request.method==="GET"?undefined:Buffer.concat(chunks),signal:controller.signal,redirect:"manual",dispatcher:transport});
      if(!result.ok){await result.body?.cancel();deny(result.status>=300&&result.status<400?502:result.status,"Provider request failed; check this task's provider readiness");return;}
      response.writeHead(result.status,{"content-type":result.headers.get("content-type")??"application/json","cache-control":"no-store"});
      if(!gemini&&pathname==="/v1/files"&&request.method==="POST"){
        const body=await result.text();if(body.length>128_000)throw new Error("Provider file receipt exceeds task limit");const value=JSON.parse(body) as {id?:unknown};if(typeof value.id==="string"&&/^[a-zA-Z0-9_-]{1,200}$/.test(value.id))files.add(value.id);response.end(body);
      }else if(result.body){for await(const part of result.body){if(!response.write(part))await new Promise<void>(resolve=>response.once("drain",resolve));}response.end();}else response.end();
    }catch{if(!response.headersSent)deny(502,"Provider task transport failed");else response.destroy();}
    finally{active--;controllers.delete(controller);request.off("aborted",abort);response.off("close",abort);}
  });
  server.requestTimeout=Math.min(options.timeoutMs,120_000);server.headersTimeout=10_000;server.maxHeadersCount=32;
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const port=(server.address() as {port:number}).port;
  const timer=setTimeout(()=>{void close();},options.timeoutMs);timer.unref();
  async function close():Promise<void>{if(closed)return;closed=true;clearTimeout(timer);for(const controller of controllers)controller.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await transport.close();}
  const base=`http://127.0.0.1:${port}`;
  return{port,env:gemini?{GEMINI_API_KEY:token,GOOGLE_GEMINI_BASE_URL:base}:{DEEPSEEK_API_KEY:token,DEEPSEEK_BASE_URL:base},close};
}
