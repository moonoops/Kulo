import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MainChromeFlowSession, openMainChromeAgentBrowser, downloadFlowMedia, type MainChromeAgentBrowserConnection } from "../packages/env/src/main-chrome.js";
import type { AgentCliRunner } from "../packages/env/src/agent-cli.js";

const directories: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function directory(): string { const value = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', "kulo-main-")); directories.push(value); return value; }
function browserFixture() {
  let disconnected = false; let sequence = 0;
  const makePage = (initialUrl: string) => {
    let url = initialUrl;
    const location = { get origin() { return new URL(url).origin; }, get pathname() { return new URL(url).pathname; }, get href() { return url; }, set href(value: string) { url = value; } };
    const marker = vi.fn(() => "visible-flow-control");
    const fetch = vi.fn(async (_source?: unknown, _options?: unknown) => new Response('unavailable', { status: 404 }));
    const context = vm.createContext({ location, marker, URL, Blob, Uint8Array, fetch, btoa: (value: string) => Buffer.from(value, 'binary').toString('base64') });
    return { targetId: 'TARGET_' + ++sequence, url: () => url, location, context, fetch, setUrl: (value: string) => { url = value; }, marker };
  };
  let pages = [makePage("https://flow.google.com/project/one")]; let active = pages[0]!;
  const connection: MainChromeAgentBrowserConnection = {
    request: vi.fn(async (command) => {
      if (disconnected) throw new Error("Disconnected: secret-account@example.com");
      if (command.action === 'tab_list') return { tabs: pages.map(page => ({ targetId: page.targetId, url: page.url(), title: 'private-account@example.com' })) };
      if (command.action === 'tab_switch') {
        const target = pages.find(page => page.targetId === command.tabId); if (!target) throw new Error('tab_gone'); active = target;
        return { targetId: target.targetId, url: target.url() };
      }
      if (command.action === 'evaluate') return { result: await vm.runInContext(String(command.script), active.context) };
      if (command.action === 'navigate') { active.setUrl(String(command.url)); return { url: active.url() }; }
      if (command.action === 'url') return { url: active.url() };
      throw new Error('Unexpected browser action');
    }),
    close: vi.fn(async () => {}),
  };
  return { connection, makePage, get pages() { return pages; }, setPages: (value: typeof pages) => { pages = value; active = pages[0]!; }, disconnect: () => { disconnected = true; } };
}
async function connected(fixture = browserFixture()) {
  const factory = vi.fn(async () => fixture.connection);
  const session = new MainChromeFlowSession({ rootDir: directory(), connectionFactory: factory });
  expect(await session.open()).toMatchObject({ status: "needs_connection" });
  await vi.waitFor(async () => { expect((await session.check()).status).toBe("ready"); });
  return { fixture, factory, session, tabs: (await session.check()).tabs };
}

describe("main Chrome Flow agent-browser boundary", () => {
  it("only attaches after explicit open and deduplicates an opening connection", async () => {
    const fixture = browserFixture(); let release!: () => void;
    const factory = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return fixture.connection; });
    const root = directory(); const session = new MainChromeFlowSession({ rootDir: root, connectionFactory: factory });
    expect(await session.check()).toMatchObject({ status: 'needs_connection', tabs: [] }); expect(factory).not.toHaveBeenCalled();
    await session.open(); await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce()); await session.open(); expect(factory).toHaveBeenCalledOnce();
    release(); await vi.waitFor(async () => expect((await session.check()).status).toBe('ready'));
    expect(fs.statSync(root).mode & 0o777).toBe(0o700); await session.close();
  });

  it("exposes Flow URLs without titles, query strings or unrelated browser tabs", async () => {
    const fixture = browserFixture(); fixture.setPages([
      fixture.makePage('https://mail.google.com/inbox'), fixture.makePage('https://flow.google.com/project/one?secret=hidden'),
      fixture.makePage('https://labs.google/fx/tools/flow/project/two'), fixture.makePage('https://labs.google/fx/tools/whisk'),
      fixture.makePage('https://flow.google.com.evil.example/project/three'), fixture.makePage('http://flow.google.com/project/four'), fixture.makePage('https://flow.google.com:8443/project/five'),
    ]);
    const { session, tabs } = await connected(fixture);
    expect(tabs.map(tab => tab.url)).toEqual(['https://flow.google.com/project/one', 'https://labs.google/fx/tools/flow/project/two']);
    expect(JSON.stringify(await session.check())).not.toMatch(/secret|mail|whisk|evil|private-account/);
    await expect(session.run(999, '() => marker()')).rejects.toThrow('not authorized');
    expect(await session.run(tabs[0]!.id, '() => marker()')).toBe('visible-flow-control');
    expect(fixture.pages[0]!.marker).not.toHaveBeenCalled(); await session.close();
  });

  it("passes request content as JSON instead of interpolating executable input", async () => {
    const { session, tabs } = await connected(); const prompt = "'); throw new Error('injected'); //\n${process.env.SECRET}";
    expect(await session.run(tabs[0]!.id, '(input) => input.prompt', { prompt })).toBe(prompt);
    expect(await session.evaluate(tabs[0]!.id, 'input => ({value:input.value})', { value: 'visible label' })).toEqual({ value: 'visible label' });
    await expect(session.run(tabs[0]!.id, '() => 1', 'x'.repeat(2 * 1024 * 1024 + 1))).rejects.toThrow('limit'); await session.close();
  });

  it("checks stable target identity and exact URL before any fixed action", async () => {
    const fixture = browserFixture(); const { session, tabs } = await connected(fixture);
    fixture.pages[0]!.setUrl('https://accounts.google.com/');
    await expect(session.run(tabs[0]!.id, '() => marker()')).rejects.toThrow('outside the authorized scope');
    expect(fixture.pages[0]!.marker).not.toHaveBeenCalled();
    fixture.setPages([fixture.makePage('https://flow.google.com/project/one')]);
    expect((await session.check()).status).toBe('ready'); await expect(session.run(tabs[0]!.id, '() => marker()')).rejects.toThrow('not authorized');
    expect(fixture.pages[0]!.marker).not.toHaveBeenCalled(); await session.close();
  });

  it("detects navigation after a fixed DOM action", async () => {
    const { session, tabs } = await connected();
    await expect(session.run(tabs[0]!.id, "() => { location.href='https://flow.google.com/project/another'; return true; }")).rejects.toThrow('outside the authorized scope');
    expect((await session.check()).status).toBe('ready'); await session.close();
  });

  it("never reconnects or replays after a lost operation receipt", async () => {
    const fixture = browserFixture(); const { session, factory, tabs } = await connected(fixture);
    const original = vi.mocked(fixture.connection.request).getMockImplementation()!;
    vi.mocked(fixture.connection.request).mockImplementation(async (...args) => { const result = await original(...args); if (args[0].action === 'evaluate') throw new Error('receipt lost: secret-account@example.com'); return result; });
    await expect(session.run(tabs[0]!.id, '() => marker()')).rejects.toThrow('not confirmed');
    expect(fixture.pages[0]!.marker).toHaveBeenCalledOnce();
    expect(await session.check()).toMatchObject({ status: 'needs_connection', tabs: [] });
    await expect(session.run(tabs[0]!.id, '() => marker()')).rejects.toThrow('not authorized');
    expect(factory).toHaveBeenCalledOnce(); expect(fixture.pages[0]!.marker).toHaveBeenCalledOnce();
    expect(JSON.stringify(await session.check())).not.toContain('secret-account'); expect(fixture.connection.close).toHaveBeenCalledOnce(); await session.close();
  });

  it("rejects a forged DOM receipt nonce", async () => {
    const fixture = browserFixture(); const { session, tabs } = await connected(fixture);
    const original = vi.mocked(fixture.connection.request).getMockImplementation()!;
    vi.mocked(fixture.connection.request).mockImplementation(async (...args) => args[0].action === 'evaluate' ? { result: { nonce: 'forged', status: 'ok', value: true } } : original(...args));
    await expect(session.run(tabs[0]!.id, '() => true')).rejects.toThrow('invalid Flow receipt');
    expect(await session.check()).toMatchObject({ status: 'needs_connection' }); await session.close();
  });

  it("closes a late attachment after its owner has closed", async () => {
    const fixture = browserFixture(); let release!: () => void;
    const session = new MainChromeFlowSession({ rootDir: directory(), connectionFactory: async () => { await new Promise<void>(resolve => { release = resolve; }); return fixture.connection; } });
    await session.open(); await vi.waitFor(() => expect(release).toBeTypeOf('function')); await session.close(); release();
    await vi.waitFor(() => expect(fixture.connection.close).toHaveBeenCalledOnce()); expect(fixture.connection.request).not.toHaveBeenCalled();
  });

  it("keeps a failed explicit connection pending without repeated attach attempts", async () => {
    const factory = vi.fn(async () => { throw new Error('Missing Chrome: private-account@example.com'); });
    const session = new MainChromeFlowSession({ rootDir: directory(), connectionFactory: factory });
    await session.open(); await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce()); await new Promise(resolve => setTimeout(resolve,0));
    expect(await session.check()).toMatchObject({ status: 'needs_connection' }); await session.check(); expect(factory).toHaveBeenCalledOnce();
    expect(JSON.stringify(await session.check())).not.toContain('private-account'); await session.close();
  });

  it("allows editor navigation only within the selected project", async () => {
    const fixture = browserFixture(); const root = 'https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71'; const editor = root + '/edit/1170a548-c3b3-4f43-bdf6-7d6c55ad3002';
    fixture.setPages([fixture.makePage(root)]); const { session, tabs } = await connected(fixture); const id = tabs[0]!.id;
    expect(await session.runProjectNavigation(id, root, '(input) => { location.href=input.url; return {clicked:true}; }', { url: editor })).toEqual({ url: editor, value: { clicked: true } });
    expect((await session.check()).tabs).toEqual([{id,url:editor}]); expect(await session.run(id, '() => marker()')).toBe('visible-flow-control');
    expect(await session.navigateProject(id,root)).toEqual({url:root}); await session.close();
  });

  it.each([
    'https://flow.google.com/project/11111111-1111-1111-1111-111111111111/edit/1170a548-c3b3-4f43-bdf6-7d6c55ad3002',
    'https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71/edit/not-a-scene',
    'https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71/settings', 'https://accounts.google.com/',
  ])('refuses an editor action outside the project: %s', async target => {
    const fixture = browserFixture(); const root = 'https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71';
    fixture.setPages([fixture.makePage(root)]); const { session, tabs } = await connected(fixture);
    await expect(session.runProjectNavigation(tabs[0]!.id, root, '(input) => { location.href=input.url; return true; }', { url:target })).rejects.toThrow('outside the authorized scope');
    await expect(session.run(tabs[0]!.id,'() => marker()')).rejects.toThrow('not authorized'); await session.close();
  });

  it("rejects a different project before sending any native action", async () => {
    const fixture = browserFixture(); fixture.setPages([fixture.makePage('https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71')]);
    const {session,tabs}=await connected(fixture); const count=vi.mocked(fixture.connection.request).mock.calls.length;
    await expect(session.runProjectNavigation(tabs[0]!.id,'https://flow.google.com/project/11111111-1111-1111-1111-111111111111','() => marker()')).rejects.toThrow('not authorized');
    expect(fixture.connection.request).toHaveBeenCalledTimes(count); await session.close();
  });

  it("hands one original download to attached Chrome without trusting reported paths or replaying clicks", async () => {
    const {fixture,session,tabs}=await connected(); const output=path.join(directory(),'output.mp4');
    expect(await session.download(tabs[0]!.id,'() => marker()',output)).toMatchObject({status:'pending',message:expect.stringContaining('未重新生成')});
    expect(await session.download(tabs[0]!.id,'() => marker()',output)).toMatchObject({status:'pending'});
    expect(fixture.pages[0]!.marker).toHaveBeenCalledOnce(); expect(fs.existsSync(output)).toBe(false); await session.close();
  });
  it('retrieves a same-origin blob in bounded chunks and validates the MP4 before publishing',async()=>{
    const {fixture,session,tabs}=await connected(); const bytes=Buffer.alloc(1024*1024+17,17);bytes.write('ftyp',4);
    fixture.pages[0]!.fetch.mockImplementation(async()=>new Response(bytes,{headers:{'content-type':'video/mp4'}}));
    const output=path.join(directory(),'output.mp4');const source='blob:https://flow.google.com/1170a548-c3b3-4f43-bdf6-7d6c55ad3002';
    const code='(input) => { marker(); return {delivered:true,source:input.source}; }';
    const result=await session.download(tabs[0]!.id,code,output,{source});
    expect(result).toMatchObject({status:'completed',file:{size:bytes.length,mimeType:'video/mp4',sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}});
    expect(fs.readFileSync(output)).toEqual(bytes);expect(fs.statSync(output).mode&0o777).toBe(0o600);
    const chunks=vi.mocked(fixture.connection.request).mock.calls.filter(([command])=>String(command.script).includes('state.blob.slice'));
    expect(chunks).toHaveLength(3);expect(fixture.pages[0]!.fetch).toHaveBeenCalledWith(source,{credentials:'omit',redirect:'error',cache:'no-store'});
    await session.download(tabs[0]!.id,code,output,{source});expect(fixture.pages[0]!.marker).toHaveBeenCalledOnce();await session.close();
  });
  it.each(['file:///private/secret.mp4','javascript:secret()','http://flow.google.com/file.mp4','blob:https://evil.example/private','https://evil.example/private.mp4'])('refuses an untrusted native download source: %s',async source=>{
    const {fixture,session,tabs}=await connected();const output=path.join(directory(),'output.mp4');
    expect(await session.download(tabs[0]!.id,'input => ({delivered:true,source:input.source})',output,{source})).toMatchObject({status:'pending'});
    expect(fixture.pages[0]!.fetch).not.toHaveBeenCalled();expect(fs.existsSync(output)).toBe(false);await session.close();
  });
  it.each(['magic','mime','size','offset'])('does not publish an unverified blob transfer: %s',async failure=>{
    const {fixture,session,tabs}=await connected();const bytes=Buffer.alloc(32);if(failure!=='magic')bytes.write('ftyp',4);
    fixture.pages[0]!.fetch.mockImplementation(async()=>new Response(bytes,{headers:{'content-type':failure==='mime'?'text/html':'video/mp4',...(failure==='size'?{'content-length':String(250*1024*1024+1)}:{})}}));
    if(failure==='offset'){
      const original=vi.mocked(fixture.connection.request).getMockImplementation()!;
      vi.mocked(fixture.connection.request).mockImplementation(async(...args)=>{
        const result=await original(...args);if(String(args[0].script).includes('state.blob.slice'))(result as {result:{value:{offset:number}}}).result.value.offset++;return result;
      });
    }
    const root=directory();expect(await session.download(tabs[0]!.id,'() => ({delivered:true,source:"blob:https://flow.google.com/safe"})',path.join(root,'output.mp4'))).toMatchObject({status:'pending'});
    expect(fs.readdirSync(root)).toEqual([]);await session.close();
  });

});

describe('pinned native daemon transport',()=>{
  async function nativeFixture(initialTabs: unknown[] = [{targetId:'FLOW_TARGET',url:'https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71'}], connect = true) {
    const commands:Record<string,unknown>[]=[]; let invocation:{socketDirectory:string;session:string}|undefined;
    let reply: ((command: Record<string, unknown>, socket: net.Socket) => void) | undefined;
    const runner:AgentCliRunner=vi.fn(async input=>{
      expect(input.tool).toBe('agent-browser');
      if(invocation){expect(input.args).toContain('--pin-tab');expect(input.args).not.toContain('--auto-connect');return {success:true,data:{targetId:'FLOW_TARGET',url:'https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71'}};}
      expect(input.args).toContain('--auto-connect');expect(input.args).not.toContain('--pin-tab');
      const socketDirectory=input.env!.AGENT_BROWSER_SOCKET_DIR!; const session=input.args[input.args.indexOf('--session')+1]!;
      invocation={socketDirectory,session}; fs.writeFileSync(path.join(socketDirectory,session+'.pid'),String(process.pid)); fs.writeFileSync(path.join(socketDirectory,session+'.version'),'0.43.0');
      const server=net.createServer(socket=>{let data='';socket.on('data',chunk=>{data+=chunk.toString();if(!data.includes('\n'))return;const command=JSON.parse(data);commands.push(command);if (reply) reply(command,socket); else socket.end(JSON.stringify({success:true,data:command.action==='tab_list'?{tabs:[]}:{closed:true}})+'\n');});});servers.push(server);
      await new Promise<void>(resolve=>server.listen(path.join(socketDirectory,session+'.sock'),resolve));
      return {success:true,data:{tabs:initialTabs}};
    });
    const root=directory();const connection=connect?await openMainChromeAgentBrowser(root,undefined,runner):undefined;
    return {connection:connection!,commands,runner,root,setReply:(handler:typeof reply)=>{reply=handler;},get identity(){return invocation!;}};
  }
  it.skipIf(process.platform==='win32')('attaches then pins an existing project without opening a blank tab; later calls use only the socket',async()=>{
    const f=await nativeFixture();expect(await f.connection.request({action:'tab_list'})).toEqual({tabs:[]});
    expect(f.commands).toHaveLength(1);expect(f.commands[0]!.id).toMatch(/^[a-f0-9]{32}$/);expect(f.runner).toHaveBeenCalledTimes(2);
    await f.connection.close();expect(f.commands.map(c=>c.action)).toEqual(['tab_list','close']);expect(fs.existsSync(f.identity.socketDirectory)).toBe(false);
  });
  it.skipIf(process.platform==='win32').each(['missing','ambiguous','invalid-target'])('does not pin or open another page when Flow selection is %s',async mode=>{
    const initial=mode==='missing'?[]:mode==='invalid-target'?[{targetId:'../escape',url:'https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71'}]:[
      {targetId:'FLOW_ONE',url:'https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71'},
      {targetId:'FLOW_TWO',url:'https://flow.google.com/project/11111111-1111-1111-1111-111111111111'},
    ];
    const f=await nativeFixture(initial,false);await expect(openMainChromeAgentBrowser(f.root,undefined,f.runner)).rejects.toThrow('重新连接');
    expect(f.runner).toHaveBeenCalledOnce();expect(f.commands.map(c=>c.action)).toEqual(['close']);expect(fs.existsSync(f.identity.socketDirectory)).toBe(false);
  });

  it.skipIf(process.platform==='win32').each(['version','pid'])('never respawns or sends to a changed daemon %s',async field=>{
    const f=await nativeFixture();fs.writeFileSync(path.join(f.identity.socketDirectory,f.identity.session+'.'+field),field==='version'?'0.0.0':String(process.pid+1));
    await expect(f.connection.request({action:'tab_list'})).rejects.toThrow('connection was lost');expect(f.commands).toEqual([]);expect(f.runner).toHaveBeenCalledTimes(2);await expect(f.connection.close()).rejects.toThrow('identity changed');expect(f.commands).toEqual([]);
    fs.writeFileSync(path.join(f.identity.socketDirectory,f.identity.session+'.'+field),field==='version'?'0.43.0':String(process.pid)); await f.connection.close();
  });
  it.skipIf(process.platform==='win32')('accepts a confirmed close after native daemon sidecars have gone',async()=>{
    const f=await nativeFixture(); f.setReply((command,socket)=>{
      expect(command.action).toBe('close'); fs.rmSync(path.join(f.identity.socketDirectory,f.identity.session+'.pid')); fs.rmSync(path.join(f.identity.socketDirectory,f.identity.session+'.version'));
      socket.end(JSON.stringify({success:true,data:{closed:true}})+'\n');
    });
    await f.connection.close();expect(fs.existsSync(f.identity.socketDirectory)).toBe(false);expect(f.commands).toHaveLength(1);
  });
  it.skipIf(process.platform==='win32')('preserves an uncertain detach so explicit cleanup can retry the same owner',async()=>{
    const f=await nativeFixture(); let attempt=0;f.setReply((_command,socket)=>{if(++attempt===1)socket.destroy();else socket.end(JSON.stringify({success:true,data:{closed:true}})+'\n');});
    await expect(f.connection.close()).rejects.toThrow('could not detach');expect(fs.existsSync(f.identity.socketDirectory)).toBe(true);
    await f.connection.close();expect(fs.existsSync(f.identity.socketDirectory)).toBe(false);expect(f.runner).toHaveBeenCalledTimes(2);expect(f.commands.map(c=>c.action)).toEqual(['close','close']);
  });
  it.skipIf(process.platform==='win32').each(['malformed','extra-line','oversized'])('rejects %s native framing without replaying a command',async mode=>{
    const f=await nativeFixture();f.setReply((_command,socket)=>socket.end(mode==='malformed'?'not json\n':mode==='extra-line'?'{"success":true,"data":{}}\n{}\n':JSON.stringify({success:true,data:{text:'x'.repeat(2*1024*1024)}})+'\n'));
    await expect(f.connection.request({action:'evaluate',script:'1'})).rejects.toThrow(/not confirmed|limit/);expect(f.commands).toHaveLength(1);
    f.setReply(undefined);await f.connection.close();expect(f.commands).toHaveLength(2);expect(f.runner).toHaveBeenCalledTimes(2);
  });

});

describe("selected Flow media download", () => {
  const source = "https://storage.googleapis.com/flow-media/one.mp4?signature=private";
  const options = { expectedMediaUrl: "https://storage.googleapis.com/flow-media/one.mp4", allowedHosts: ["storage.googleapis.com"] };
  function mp4() { const bytes = Buffer.alloc(32); bytes.write("ftyp", 4); return bytes; }

  it("downloads the matching signed HTTPS media without cookies, authorization, or browser download settings", async () => {
    const destination = path.join(directory(), "output.mp4");
    const fetch = vi.fn(async () => new Response(mp4()));
    expect(await downloadFlowMedia(source, destination, { ...options, fetch })).toMatchObject({ status: "completed", file: { name: "output.mp4", mimeType: "video/mp4", size: 32 } });
    expect(fs.readFileSync(destination)).toEqual(mp4()); expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual", referrerPolicy: "no-referrer", headers: { Accept: "video/mp4" } });
    expect(JSON.stringify(fetch.mock.calls[0]![1])).not.toMatch(/cookie|authorization/i);
  });

  it.each(["http://storage.googleapis.com/flow-media/one.mp4", "https://storage.googleapis.com/flow-media/other.mp4", "https://evil.example/flow-media/one.mp4", "https://user:password@storage.googleapis.com/flow-media/one.mp4"])("rejects a mismatched or unapproved media URL: %s", async (url) => {
    const fetch = vi.fn(); const root = directory();
    expect(await downloadFlowMedia(url, path.join(root, "output.mp4"), { ...options, fetch })).toMatchObject({ status: "pending" });
    expect(fetch).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([401, 403, 404])("keeps authentication or expired media pending without a paid retry: %s", async (status) => {
    const root = directory(); const fetch = vi.fn(async () => new Response("not available", { status }));
    const result = await downloadFlowMedia(source, path.join(root, "output.mp4"), { ...options, fetch });
    expect(result.status).toBe("pending"); expect(JSON.stringify(result)).not.toContain("signature");
    expect(fetch).toHaveBeenCalledTimes(1); expect(fs.readdirSync(root)).toEqual([]);
  });

  it("does not follow a redirect to another host and removes an unsupported body", async () => {
    const root = directory(); const destination = path.join(root, "output.mp4");
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/one.mp4" } }));
    expect(await downloadFlowMedia(source, destination, { ...options, fetch: redirect })).toMatchObject({ status: "pending" });
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(await downloadFlowMedia(source, destination, { ...options, fetch: vi.fn(async () => new Response("<html>login</html>")) })).toMatchObject({ status: "pending" });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("keeps failed unauthenticated fetches pending and surfaces local storage failures", async () => {
    const root = directory(); const fetch = vi.fn(async () => { throw new TypeError("CORS or unavailable signed URL: private signature"); });
    expect(await downloadFlowMedia(source, path.join(root, "output.mp4"), { ...options, fetch })).toMatchObject({ status: "pending" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(fs.readdirSync(root)).toEqual([]);
    await expect(downloadFlowMedia(source, path.join(root, "missing/output.mp4"), { ...options, fetch })).rejects.toThrow("storage is unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
