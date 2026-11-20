import { describe, expect, it, vi } from "vitest";
import { runAgentCli } from "../packages/env/src/agent-cli.js";
import { MainChromeFlowSession } from "../packages/env/src/main-chrome.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flowBrowserExecutable, type FlowJobState, type FlowSubmitInput } from "../packages/env/src/browser.js";
import { MainChromeFlowDriver, flowProjectUrl, parseFlowNativeQuote, type FlowMainPageState, type FlowMainSession, type FlowNativeQuote } from "../packages/env/src/flow-main-driver.js";

const project = "https://flow.google.com/project/99b1008e-f835-474c-b3d6-2008cf6a5d71";
const media = "https://flow-content.google/image/633fe37f-3310-4111-8888-123456789012";
const editor = `${project}/edit/633fe37f-3310-4111-8888-123456789013`;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type PreparedJob = FlowJobState & { preparedAt?: number; quote?: FlowNativeQuote };

function fixture() {
  const job: PreparedJob = { id: "kulo-job-one", profileRef: "main-chrome", fingerprint: "fixture", status: "prepared", baselineUrls: [], updatedAt: 1, uploads: {} };
  const state: FlowMainPageState = { url: project, promptCount: 1, promptEnabled: true, promptValue: "", alwaysConfirm: true, requestMarkers: [], confirmations: [], media: [] };
  const calls: Array<{ kind: string; code?: string; input?: unknown }> = [];
  let sending = 0; let approvals = 0; let rejections = 0;
  let settingsOpen = false; let settingsAvailable = true;
  let beforeSend: (() => void) | undefined;
  let beforeApprove: (() => void) | undefined;
  const settings = () => {
    if (!settingsAvailable) return false;
    calls.push({ kind: 'click:设置' });
    if (!state.alwaysConfirm) { state.alwaysConfirm = true; calls.push({ kind: 'click:始终 智能体将在生成媒体内容之前征求确认。' }); }
    calls.push({ kind: 'click:保存' }); return true;
  };
  const session = {
    open: vi.fn(async () => ({ status: "ready", tabs: [{ id: 7, url: project }] })),
    check: vi.fn(async () => ({ status: "ready", tabs: [{ id: 7, url: project }] })),
    evaluate: vi.fn(async (_id, code, input) => { calls.push({ kind: "read", code, input }); return copy(state); }),
    run: vi.fn(async (_id, code: string, raw) => {
      calls.push({ kind: "run", code, input: raw });
      const input = raw as Record<string, unknown> | undefined;
      const action = code.match(/kulo-flow:(\w+)/)?.[1];
      if (action === 'settings') return settings();
      if (action === 'wait') return true;
      if (action === 'send') {
        if (state.url !== input!.url || state.promptCount !== 1 || !state.promptEnabled || state.promptValue.trim() || state.requestMarkers.includes(String(input!.jobId)) || state.confirmations.some(card => !card.disabled) || !settings()) return { sent: false };
        beforeSend?.(); calls.push({ kind: "fill", input: input!.prompt }); state.promptValue = String(input!.prompt);
        if (state.url !== input!.url || state.promptCount !== 1 || !state.promptEnabled || state.requestMarkers.includes(String(input!.jobId)) || state.confirmations.some(card => !card.disabled)) return { sent: false };
        calls.push({ kind: "click:开始生成" }); sending++; state.promptValue = '';
        state.requestMarkers.push(String(input!.jobId));
        state.confirmations.push({ ownerJobId: String(input!.jobId), text: "要消耗 5 个点数，开始生成这 1 个视频吗？", context: "要消耗 5 个点数，开始生成这 1 个视频吗？批准 在项目中一律批准 拒绝", approveIndex: state.confirmations.length, checked: false, disabled: false });
        return { sent: true };
      }
      const cards = state.confirmations.filter(card => card.ownerJobId === input?.jobId);
      if (action === 'approve' || action === 'reject') {
        const valid = state.url === input!.url && cards.length === 1 && state.requestMarkers.filter(id => id === input!.jobId).length === 1;
        if (!valid) return action === 'approve' ? { clicked: false } : { rejected: false };
        const card = cards[0]!;
        if (action === 'reject') {
          if ((card.checked || card.alwaysApproved) && card.disabled) return { rejected: false, accepted: true };
          if (card.rejected && card.rejectDisabled) return { rejected: true };
          if (card.disabled || card.rejectDisabled || card.checked || card.alwaysApproved || card.rejected) return { rejected: false };
          rejections++; calls.push({ kind: 'click:拒绝' }); card.rejected = true; card.rejectDisabled = true; card.disabled = true; return { rejected: true };
        }
        if (card.text !== input!.text || card.context !== input!.context || card.approveIndex !== input!.approveIndex || card.disabled || card.checked) return { clicked: false };
        beforeApprove?.(); approvals++; calls.push({ kind: 'click:批准' }); card.checked = true; card.disabled = true; card.rejectDisabled = true;
        return { clicked: true, confirmed: true };
      }
      throw new Error('Unknown fixed DOM action');
    }),
    navigateProject: vi.fn(async (_id, url) => ({ url })),
    runProjectNavigation: vi.fn(async (_id, _project, code, input) => { calls.push({ kind: "navigate", code, input }); return { url: editor, value: { opened: true } }; }),
    download: vi.fn(async (_id: number, _code: string, _destination: string) => ({ status: "completed" as const, file: { name: "output.mp4", mimeType: "video/mp4" as const, size: 128 } })),
    close: vi.fn(async () => {}),
  };
  const download = session.download;
  const driver = new MainChromeFlowDriver(session as unknown as FlowMainSession);
  const input: FlowSubmitInput = { job, prompt: "A green leaf in a gentle breeze", modelId: "auto", referencePaths: [] };
  const beforePrepare = vi.fn((remoteUrl: string, baseline: string[]) => { calls.push({ kind: "durable:prepare" }); job.preparedAt = 10; job.remoteUrl = remoteUrl; job.baselineUrls = baseline; });
  const beforeSubmit = vi.fn(() => { calls.push({ kind: "durable:submit" }); job.submittedAt = 20; });
  return { job, state, calls, session, driver, input, download, beforePrepare, beforeSubmit,
    sent: () => sending, approved: () => approvals, rejected: () => rejections,
    settingsAvailable: (value: boolean) => { settingsAvailable = value; },
    onFill: (callback: () => void) => { beforeSend = callback; }, onApprove: (callback: () => void) => { beforeApprove = callback; } };
}

async function prepare(f: ReturnType<typeof fixture>) {
  const result = await f.driver.prepare(f.input, f.beforePrepare);
  expect(result).toMatchObject({ status: "ready", prepared: true, quote: { credits: 5, outputs: 1 } });
  f.job.quote = result.quote!;
  return result;
}

describe("main Chrome Flow native quote", () => {
  it("accepts only the cost and count actually present in the native confirmation", () => {
    expect(parseFlowNativeQuote("要消耗 5 个点数，开始生成这 1 个视频吗？")).toEqual({ credits: 5, outputs: 1 });
    expect(parseFlowNativeQuote("要消耗 0 个点数，开始生成这 1 个视频吗？")).toEqual({ credits: 0, outputs: 1 });
  });

  it("rejects estimates and ambiguous native cards instead of inferring a charge", () => {
    expect(parseFlowNativeQuote("大概需要5点数，4秒视频")).toBeUndefined();
    expect(parseFlowNativeQuote("要消耗 5 个点数，开始生成这 1 个视频吗？要消耗 8 个点数，开始生成这 1 个视频吗？")).toBeUndefined();
  });

  it("accepts only an HTTPS Flow project and never a marketing or unrelated origin", () => {
    expect(flowProjectUrl(project + "?source=fixture")).toBe(project);
    for (const url of ["https://flow.google.com/about", "https://flow.google.com.evil.example/project/99b1008e-f835-474c-b3d6-2008cf6a5d71", project.replace("https:", "http:"), project.replace("https://", "https://account:secret@"), project.replace("/project/", ":444/project/")]) expect(flowProjectUrl(url)).toBeUndefined();
  });
});

describe("main Chrome Flow fixed driver", () => {
  it("reconnects only after an explicit open, while ordinary checks remain passive", async () => {
    const f = fixture();
    f.session.check.mockResolvedValue({ status: "needs_connection", tabs: [] });
    expect(await f.driver.check()).toMatchObject({ status: "needs_login" });
    expect(f.session.open).not.toHaveBeenCalled();
    f.session.open.mockImplementation(async () => {
      f.session.check.mockResolvedValue({ status: "ready", tabs: [{ id: 7, url: project }] });
      return { status: "ready", tabs: [{ id: 7, url: project }] };
    });
    expect(await f.driver.open()).toMatchObject({ status: "ready" });
    f.session.check.mockResolvedValue({ status: "needs_connection", tabs: [] });
    expect(await f.driver.check()).toMatchObject({ status: "needs_login" });
    expect(f.session.open).toHaveBeenCalledOnce();
    expect(await f.driver.open()).toMatchObject({ status: "ready" });
    expect(f.session.open).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!flowBrowserExecutable())("runs the observed native DOM through agent-browser with intercepted network", async () => {
    const directory = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'kulo-flow-dom-'));
    const downloads = path.join(directory, 'downloads'); fs.mkdirSync(downloads, { recursive: true });
    const mp4 = Buffer.alloc(32); mp4.write("ftyp", 4);
    const config = path.join(directory, 'config.json'); fs.writeFileSync(config, '{}');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
      SystemRoot: process.env.SystemRoot, AGENT_BROWSER_SOCKET_DIR: directory, AGENT_BROWSER_DOWNLOAD_PATH: downloads, AGENT_BROWSER_NO_VERSION_CHECK: '1' };
    const cli = async (args: string[], input?: string): Promise<Record<string, unknown>> => {
      const result = await runAgentCli({ tool: 'agent-browser', args: ['--json', '--session', 'fixture', '--config', config, ...args], cwd: directory, env, input, timeoutMs: 20_000 }) as { success: boolean; data: Record<string, unknown>; error?: string };
      if (!result.success) throw new Error('Fixture CLI failed: ' + result.error);
      return result.data;
    };
    let observer: { session: MainChromeFlowSession; id: number } | undefined;
    const evalCode = async (code: string, input?: unknown): Promise<unknown> => observer ? observer.session.evaluate(observer.id,code,input) : (await cli(['eval', '--stdin'], `(async () => { const input = ${JSON.stringify(input ?? null)}; return await (${code})(input); })()`)).result;
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
        <input aria-label="项目标题"><input aria-label="搜索">
        <div class="messages-list"></div>
        <flow-creative-agent-prompt-box><flow-base-prompt-box><div class="base-prompt-box"><div class="prompt-top-row"><flow-rich-text-editor class="prompt-input"><div class="ProseMirror" role="textbox" contenteditable="true" aria-label="您希望创作什么？"></div></flow-rich-text-editor></div></div></flow-base-prompt-box></flow-creative-agent-prompt-box>
        <button id="settings" aria-label="设置">设置</button><button id="send">开始生成</button>
        <section id="dialog" style="display:none"><h2>智能体设置</h2>
          <div id="always" role="radio" aria-label="始终 智能体将在生成媒体内容之前征求确认。" aria-checked="false">始终</div>
          <div id="never" role="radio" aria-label="永不 智能体将自动生成媒体内容并消耗点数。" aria-checked="true">永不</div><button id="save">保存</button>
        </section>
        <style>flow-permission-message, flow-chat-bubble, flow-rich-text-editor, .ProseMirror, [role=radio] {display:block;min-height:24px}</style>
        <script>
          const byId = (id) => document.getElementById(id);
          window.approvals = 0;
          byId('settings').onclick = () => byId('dialog').style.display = 'block';
          byId('always').onclick = () => { byId('always').setAttribute('aria-checked','true'); byId('never').setAttribute('aria-checked','false'); };
          byId('save').onclick = () => byId('dialog').style.display = 'none';
          byId('send').onclick = () => {
            const user = document.createElement('div'); user.className = 'message-row user-row'; user.textContent = document.querySelector('.ProseMirror').innerText;
            const agent = document.createElement('div'); agent.className = 'agent-row message-row';
            agent.innerHTML = '<flow-chat-bubble><div class="agent-bubble"><div class="agent-message-content"><p>我将使用Veo 3.1 Lite生成4秒视频。</p><flow-permission-message><p class="title">要消耗 5 个点数，开始生成这 1 个视频吗？</p><div role="radiogroup" aria-label="权限选项"><div role="radio" aria-label="批准" aria-checked="false" aria-disabled="false">批准</div><div role="radio" aria-label="在项目中一律批准" aria-checked="false" aria-disabled="false">在项目中一律批准</div><div role="radio" aria-label="拒绝" aria-checked="false" aria-disabled="false">拒绝</div></div></flow-permission-message></div></div></flow-chat-bubble>';
            document.querySelector('.messages-list').append(user, agent);
            document.querySelector('.ProseMirror').textContent = '';
            for (const radio of agent.querySelectorAll('[role=radio]')) radio.onclick = () => {
              const choice = radio.getAttribute('aria-label');
              if (choice !== '批准' && choice !== '拒绝') throw new Error('Unexpected permission');
              radio.setAttribute('aria-checked','true');
              for (const choice of agent.querySelectorAll('[role=radio]')) choice.setAttribute('aria-disabled','true');
              if (choice === '拒绝') { window.rejections = (window.rejections || 0) + 1; return; }
              window.approvals++;
              const library = document.createElement('flow-a2ui-multiple-choice');
              library.innerHTML = '<div role="group" aria-label="媒体选项库"><flow-a2ui-video-option><div class="video-container clickable" role="button" aria-label="在编辑器中打开视频"><img class="video-thumbnail" width="64" height="64" src="${media}?fixture-signature=private"></div></flow-a2ui-video-option></div>';
              agent.querySelector('.agent-message-content').append(library);
              library.querySelector('[role=button]').onclick = () => {
                history.pushState({}, '', '${editor}');
                document.body.innerHTML = '<p>总时长：00:04:00</p><canvas width="100" height="100"></canvas><button aria-label="下载媒体内容" aria-haspopup="menu">下载媒体内容</button><div role="menu" hidden><flow-menu-item><button role="menuitem"><span class="item-text">720p 原始尺寸</span></button></flow-menu-item><flow-menu-item><button role="menuitem"><span class="item-text">4K 已高清重塑 · 消耗50个点数</span></button></flow-menu-item></div>';
                document.querySelector('[aria-label="下载媒体内容"]').onclick = () => document.querySelector('[role=menu]').hidden = false;
                const items = document.querySelectorAll('[role=menuitem]');
                items[0].onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([new Uint8Array(${JSON.stringify([...mp4])})], {type:'video/mp4'})); a.download = 'owned-result.mp4'; document.body.append(a); a.click(); };
                items[1].onclick = () => { window.paidUpscales = (window.paidUpscales || 0) + 1; };
              };
            };
          };
        </script></body></html>`;
    try {
      await cli(['--executable-path', flowBrowserExecutable()!, '--download-path', downloads, 'open']);
      // Fulfil every request locally before opening the HTTPS fixture origin.
      await cli(['network', 'route', '*', '--body', '{}']);
      await cli(['open', project]);
      await evalCode('(html) => { document.open(); document.write(html); document.close(); return true; }', html);
      const cdpUrl = String((await cli(['get', 'cdp-url'])).cdpUrl);
      expect(cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
      // Attach the production Flow adapter to this disposable browser, never the user's Chrome.
      const session = new MainChromeFlowSession({ rootDir: directory, runner: async invocation => {
        const args = [...invocation.args]; const attach = args.indexOf('--auto-connect');
        if(attach>=0)args.splice(attach, 1, '--cdp', cdpUrl);
        return runAgentCli({ ...invocation, args, env: { ...invocation.env, HOME: directory, USERPROFILE: directory } });
      } });
      await session.open(); await vi.waitFor(async () => expect((await session.check()).status).toBe('ready'));
      observer={session,id:(await session.check()).tabs[0]!.id};
      expect((await cli(['tab','list'])).tabs).toHaveLength(1);
      const stopped = fixture(); stopped.job.id = 'kulo-stopped-job';
      const f = fixture(); const driver = new MainChromeFlowDriver(session);
      expect(await driver.check()).toMatchObject({ status: 'ready' });
      expect(await driver.prepare(stopped.input, stopped.beforePrepare)).toMatchObject({ status: 'ready', prepared: true });
      stopped.job.status = 'stopped';
      expect(await driver.stop(stopped.job)).toMatchObject({ status: 'stopped', submitted: false });
      expect(await driver.stop(stopped.job)).toMatchObject({ status: 'stopped', submitted: false });
      expect(await evalCode('() => window.rejections')).toBe(1);
      const prepared = await driver.prepare(f.input, f.beforePrepare);
      expect(prepared).toMatchObject({ status: 'ready', prepared: true, quote: { credits: 5, outputs: 1 } });
      f.job.quote = prepared.quote;
      expect(await driver.submit(f.input, f.beforeSubmit)).toMatchObject({ status: 'running' });
      expect(await driver.submit(f.input, f.beforeSubmit)).toMatchObject({ status: 'running' });
      expect(await evalCode('() => window.approvals')).toBe(1); expect(f.beforeSubmit).toHaveBeenCalledOnce();
      expect(await driver.poll(f.job)).toMatchObject({ status: 'completed', mediaUrl: media });
      const originalUser = await evalCode('() => { const rows = document.querySelectorAll(".user-row"); return rows[rows.length - 1].innerText; }');
      await evalCode('() => { const rows = document.querySelectorAll(".user-row"); rows[rows.length - 1].textContent = "An unrelated manual request"; }');
      expect(await driver.poll(f.job)).toMatchObject({ status: 'needs_review' });
      await evalCode('(text) => { const rows = document.querySelectorAll(".user-row"); rows[rows.length - 1].textContent = text; }', originalUser);
      f.job.mediaUrl = media;
      const destination = path.join(directory, 'output.mp4');
      expect(await driver.download(f.job, destination)).toMatchObject({name:`flow-${f.job.id}.mp4`,mimeType:'video/mp4',size:mp4.length});
      expect(fs.readFileSync(destination)).toEqual(mp4);
      expect(await evalCode('() => window.paidUpscales || 0')).toBe(0); expect(await evalCode('() => window.approvals')).toBe(1);
      await driver.close(); observer=undefined; expect((await cli(['tab','list'])).tabs).toEqual(expect.arrayContaining([expect.objectContaining({url:editor})]));
    } finally { await cli(['close']); fs.rmSync(directory, { recursive: true, force: true }); }
  }, 60_000);

  it("persists preparation before sending, leaves the native card unpaid and keeps request data out of code", async () => {
    const f = fixture();
    f.state.media.push({ url: media });
    f.onFill(() => expect(f.beforePrepare).toHaveBeenCalledTimes(1));
    await prepare(f);
    expect(f.job.baselineUrls).toEqual([media.split("?")[0]]);
    expect(f.sent()).toBe(1); expect(f.approved()).toBe(0);
    expect(f.beforeSubmit).not.toHaveBeenCalled();
    const request = f.calls.find((item) => item.kind === "fill")!.input as string;
    expect(request).toContain(`[Kulo job:${f.job.id}]`);
    expect(request).toContain("仅为本任务生成 1 个视频");
    for (const operation of f.calls.filter((item) => item.code)) {
      expect(operation.code).not.toContain(f.input.prompt);
      expect(operation.code).not.toContain(f.job.id);
    }
  });

  it("prepares the same persisted request without sending a second intent", async () => {
    const f = fixture(); await prepare(f);
    f.beforePrepare.mockClear();
    await prepare(f);
    expect(f.beforePrepare).not.toHaveBeenCalled(); expect(f.sent()).toBe(1); expect(f.approved()).toBe(0);
    f.state.requestMarkers = []; f.state.confirmations = [];
    expect(await f.driver.prepare(f.input, f.beforePrepare)).toMatchObject({ status: "needs_review" });
    expect(f.sent()).toBe(1);
  });

  it.each(["unknown-settings", "draft", "multiple-prompts", "existing-card", "references", "explicit-model", "explicit-duration"])("does not send when the page is unsafe: %s", async (condition) => {
    const f = fixture();
    if (condition === "unknown-settings") f.settingsAvailable(false);
    if (condition === "draft") f.state.promptValue = "A user draft";
    if (condition === "multiple-prompts") f.state.promptCount = 2;
    if (condition === "existing-card") f.state.confirmations = [{ text: "要消耗 5 个点数，开始生成这 1 个视频吗？", context: "", approveIndex: 0, checked: false, disabled: false }];
    if (condition === "references") f.input.referencePaths = ["/private/reference.png"];
    if (condition === "explicit-model") f.input.modelId = "Veo 3.1 Lite";
    if (condition === "explicit-duration") f.input.durationSeconds = 4;
    expect(await f.driver.prepare(f.input, f.beforePrepare)).toMatchObject({ status: "needs_review" });
    expect(f.beforePrepare).toHaveBeenCalledTimes(condition === "unknown-settings" ? 1 : 0); expect(f.sent()).toBe(0); expect(f.approved()).toBe(0);
  });

  it("approves only the verified original one-video card after a second durable boundary", async () => {
    const f = fixture(); await prepare(f);
    f.onApprove(() => expect(f.beforeSubmit).toHaveBeenCalledTimes(1));
    expect(await f.driver.submit(f.input, f.beforeSubmit)).toMatchObject({ status: "running", submitted: true });
    expect(f.sent()).toBe(1); expect(f.approved()).toBe(1);
    expect(f.calls.filter((item) => ["click:开始生成", "click:批准", "click:在项目中一律批准"].includes(item.kind))).toEqual([{ kind: "click:开始生成" }, { kind: "click:批准" }]);
    expect(f.calls.slice(f.calls.findIndex((item) => item.kind === "durable:submit")).filter((item) => item.kind.startsWith("click:"))).toEqual([{ kind: "click:批准" }]);
    f.beforeSubmit.mockClear();
    expect(await f.driver.submit(f.input, f.beforeSubmit)).toMatchObject({ status: "running" });
    expect(f.beforeSubmit).not.toHaveBeenCalled(); expect(f.approved()).toBe(1);
  });

  it.each(["owner", "outputs", "credits", "duration", "model", "multiple-cards", "duplicate-request"])("does not approve a changed or unverified native card: %s", async (condition) => {
    const f = fixture(); await prepare(f);
    const card = f.state.confirmations[0]!;
    if (condition === "owner") card.ownerJobId = "different-job";
    if (condition === "outputs") card.text = "要消耗 5 个点数，开始生成这 2 个视频吗？";
    if (condition === "credits") card.text = "要消耗 10 个点数，开始生成这 1 个视频吗？";
    if (condition === "duration") f.input.durationSeconds = 4;
    if (condition === "model") f.input.modelId = "veo-3.1-lite";
    if (condition === "multiple-cards") f.state.confirmations.push(copy(card));
    if (condition === "duplicate-request") f.state.requestMarkers.push(f.job.id);
    expect(await f.driver.submit(f.input, f.beforeSubmit)).toMatchObject({ status: "needs_review" });
    expect(f.beforeSubmit).not.toHaveBeenCalled(); expect(f.approved()).toBe(0);
  });

  it("keeps the native always-confirm setting before sending and approving", async () => {
    const f = fixture(); f.state.alwaysConfirm = false;
    await prepare(f);
    expect(f.state.alwaysConfirm).toBe(true);
    f.state.alwaysConfirm = false;
    expect(await f.driver.submit(f.input, f.beforeSubmit)).toMatchObject({ status: "running" });
    expect(f.state.alwaysConfirm).toBe(true); expect(f.approved()).toBe(1);
    expect(f.calls.filter((item) => item.kind.startsWith("click:始终 "))).toHaveLength(2);
  });

  it("does not pay when the exact native settings cannot be verified after preparation", async () => {
    const f = fixture(); await prepare(f); f.settingsAvailable(false);
    expect(await f.driver.submit(f.input, f.beforeSubmit)).toMatchObject({ status: "needs_review" });
    expect(f.approved()).toBe(0);
  });

  it("rechecks the original native card after the durable submission boundary", async () => {
    const f = fixture(); await prepare(f);
    const before = vi.fn(() => { f.job.submittedAt = 20; f.state.confirmations[0]!.text = "要消耗 20 个点数，开始生成这 1 个视频吗？"; });
    expect(await f.driver.submit(f.input, before)).toMatchObject({ status: "needs_review" });
    expect(before).toHaveBeenCalledOnce(); expect(f.approved()).toBe(0);
    expect(await f.driver.submit(f.input, before)).toMatchObject({ status: "needs_review" });
    expect(before).toHaveBeenCalledOnce(); expect(f.sent()).toBe(1);
  });

  it("does not approve when permission is revoked at the durable submission boundary", async () => {
    const f = fixture(); await prepare(f);
    await expect(f.driver.submit(f.input, () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
    expect(f.approved()).toBe(0);
  });

  it("keeps an uncertain send on its original persisted request after reconnection", async () => {
    const f = fixture(); const execute = f.session.run.getMockImplementation()!;
    f.session.run.mockImplementationOnce(async (...args) => { await execute(...args); throw new Error("connection lost after send"); });
    await expect(f.driver.prepare(f.input, f.beforePrepare)).rejects.toThrow("connection lost after send");
    expect(f.job.preparedAt).toBeDefined(); expect(f.sent()).toBe(1);
    const resumed = new MainChromeFlowDriver(f.session as unknown as FlowMainSession);
    expect(await resumed.prepare(f.input, f.beforePrepare)).toMatchObject({ status: "ready", prepared: true });
    expect(f.sent()).toBe(1); expect(f.approved()).toBe(0); expect(f.beforePrepare).toHaveBeenCalledOnce();
  });

  it("allows the ledger to release only a confirmed unsent reservation and then send the same job once", async () => {
    const f = fixture(); f.settingsAvailable(false);
    expect(await f.driver.prepare(f.input, f.beforePrepare)).toMatchObject({ status: "needs_review", preparationSent: false });
    expect(f.sent()).toBe(0); expect(f.job.preparedAt).toBeDefined();
    delete f.job.preparedAt; delete f.job.quote;
    f.settingsAvailable(true);
    await prepare(f);
    expect(await f.driver.submit(f.input, f.beforeSubmit)).toMatchObject({ status: "running" });
    expect(f.sent()).toBe(1); expect(f.approved()).toBe(1);
  });

  it("preserves an unknown RPC failure before sending and never manufactures an unsent receipt", async () => {
    const f = fixture(); f.session.run.mockRejectedValueOnce(new Error("unknown RPC failure"));
    await expect(f.driver.prepare(f.input, f.beforePrepare)).rejects.toThrow("unknown RPC failure");
    expect(f.job.preparedAt).toBeDefined(); expect(f.sent()).toBe(0);
    const resumed = new MainChromeFlowDriver(f.session as unknown as FlowMainSession);
    const result = await resumed.prepare(f.input, f.beforePrepare);
    expect(result).toMatchObject({ status: "needs_review" });
    expect(result.preparationSent).toBeUndefined(); expect(f.sent()).toBe(0);
  });

  it("observes the original already-approved card during preparation without sending or approving again", async () => {
    const f = fixture(); await prepare(f);
    f.state.confirmations[0]!.checked = true; f.state.confirmations[0]!.disabled = true;
    f.session.run.mockClear(); f.beforePrepare.mockClear();
    expect(await f.driver.prepare(f.input, f.beforePrepare)).toMatchObject({ status: "running", submitted: true, quote: { credits: 5, outputs: 1 } });
    expect(f.session.run).not.toHaveBeenCalled(); expect(f.beforePrepare).not.toHaveBeenCalled(); expect(f.approved()).toBe(0); expect(f.sent()).toBe(1);
  });

  it("reconciles an uncertain approval without clicking or opening settings again", async () => {
    const f = fixture(); await prepare(f); const execute = f.session.run.getMockImplementation()!;
    f.session.run.mockImplementationOnce(execute).mockImplementationOnce(async (...args) => { await execute(...args); throw new Error("connection lost after approval"); });
    await expect(f.driver.submit(f.input, f.beforeSubmit)).rejects.toThrow("connection lost after approval");
    expect(f.job.submittedAt).toBeDefined(); expect(f.approved()).toBe(1);
    f.session.run.mockClear();
    const resumed = new MainChromeFlowDriver(f.session as unknown as FlowMainSession);
    expect(await resumed.submit(f.input, f.beforeSubmit)).toMatchObject({ status: "running" });
    expect(f.session.run).not.toHaveBeenCalled(); expect(f.approved()).toBe(1); expect(f.beforeSubmit).toHaveBeenCalledOnce();
  });

  it("does not send or approve a stopped job", async () => {
    const f = fixture(); await prepare(f); f.job.status = "stopped";
    expect(await f.driver.prepare(f.input, f.beforePrepare)).toMatchObject({ status: "needs_review" });
    expect(await f.driver.submit(f.input, f.beforeSubmit)).toMatchObject({ status: "needs_review" });
    expect(f.sent()).toBe(1); expect(f.approved()).toBe(0); expect(f.beforeSubmit).not.toHaveBeenCalled();
  });

  it("rejects only the original unpaid card once when stopping", async () => {
    const f = fixture(); await prepare(f); f.job.status = "stopped";
    expect(await f.driver.stop(f.job)).toMatchObject({ status: "stopped", submitted: false, remoteUrl: project });
    expect(f.rejected()).toBe(1); expect(f.approved()).toBe(0); expect(f.sent()).toBe(1);
    f.session.run.mockClear();
    expect(await f.driver.stop(f.job)).toMatchObject({ status: "stopped" });
    expect(f.session.run).not.toHaveBeenCalled(); expect(f.rejected()).toBe(1);
  });

  it.each(["single", "always"])("only observes a previously approved card while stopping: %s", async (choice) => {
    const f = fixture(); await prepare(f);
    if (choice === "single") await f.driver.submit(f.input, f.beforeSubmit);
    else { f.state.confirmations[0]!.alwaysApproved = true; f.state.confirmations[0]!.disabled = true; }
    f.session.run.mockClear();
    expect(await f.driver.stop(f.job)).toMatchObject({ status: "running", submitted: true, remoteUrl: project });
    expect(f.session.run).not.toHaveBeenCalled(); expect(f.rejected()).toBe(0); expect(f.approved()).toBe(choice === "single" ? 1 : 0);
  });

  it("keeps a thinking request unresolved and rejects only when its original native card appears", async () => {
    const f = fixture(); await prepare(f); const original = f.state.confirmations.pop()!;
    f.job.status = "stopped"; f.session.run.mockClear();
    expect(await f.driver.stop(f.job)).toMatchObject({ status: "needs_review" });
    expect(f.session.run).not.toHaveBeenCalled(); expect(f.rejected()).toBe(0);
    f.state.confirmations.push(original);
    expect(await f.driver.stop(f.job)).toMatchObject({ status: "stopped" });
    expect(f.rejected()).toBe(1); expect(f.sent()).toBe(1); expect(f.approved()).toBe(0);
  });

  it.each(["foreign", "multiple", "duplicate-marker"])("does not reject an unproven card when stopping: %s", async (condition) => {
    const f = fixture(); await prepare(f);
    if (condition === "foreign") f.state.confirmations[0]!.ownerJobId = "another-job";
    if (condition === "multiple") f.state.confirmations.push(copy(f.state.confirmations[0]!));
    if (condition === "duplicate-marker") f.state.requestMarkers.push(f.job.id);
    f.session.run.mockClear();
    expect(await f.driver.stop(f.job)).toMatchObject({ status: "needs_review" });
    expect(f.session.run).not.toHaveBeenCalled(); expect(f.rejected()).toBe(0); expect(f.approved()).toBe(0);
  });

  it("rechecks for a concurrent manual approval before rejecting the original card", async () => {
    const f = fixture(); await prepare(f); const execute = f.session.run.getMockImplementation()!;
    f.session.run.mockImplementationOnce(async (...args) => {
      f.state.confirmations[0]!.checked = true; f.state.confirmations[0]!.disabled = true;
      return execute(...args);
    });
    expect(await f.driver.stop(f.job)).toMatchObject({ status: "running", submitted: true });
    expect(f.rejected()).toBe(0); expect(f.approved()).toBe(0);
  });

  it("reconciles a lost rejection receipt by observing the same card without rejecting again", async () => {
    const f = fixture(); await prepare(f); const execute = f.session.run.getMockImplementation()!;
    f.session.run.mockImplementationOnce(async (...args) => { await execute(...args); throw new Error("lost rejection receipt"); });
    await expect(f.driver.stop(f.job)).rejects.toThrow("lost rejection receipt");
    expect(f.rejected()).toBe(1);
    f.session.run.mockClear();
    expect(await f.driver.stop(f.job)).toMatchObject({ status: "stopped" });
    expect(f.session.run).not.toHaveBeenCalled(); expect(f.rejected()).toBe(1); expect(f.sent()).toBe(1);
  });

  it("polls and downloads only the original new media, without any browser action or extra generation", async () => {
    const f = fixture(); await prepare(f); await f.driver.submit(f.input, f.beforeSubmit);
    f.session.run.mockClear();
    f.state.media.push({ url: media, ownerJobId: "another-job" });
    expect(await f.driver.poll(f.job)).toMatchObject({ status: "running" });
    f.state.media[0]!.ownerJobId = f.job.id;
    expect(await f.driver.poll(f.job)).toMatchObject({ status: "completed", mediaUrl: media });
    f.job.mediaUrl = media;
    expect(await f.driver.download(f.job, "/controlled/output.mp4")).toEqual({ name: `flow-${f.job.id}.mp4`, mimeType: "video/mp4", size: 128 });
    expect(f.session.runProjectNavigation).toHaveBeenCalledWith(7, project, expect.any(String), { jobId: f.job.id, projectUrl: project, mediaUrl: media });
    expect(f.download).toHaveBeenCalledWith(7, expect.any(String), "/controlled/output.mp4");
    expect(f.session.run).not.toHaveBeenCalled(); expect(f.sent()).toBe(1); expect(f.approved()).toBe(1);
    f.state.media.push({ url: media.replace("123456789012", "123456789014"), ownerJobId: f.job.id });
    expect(await f.driver.poll(f.job)).toMatchObject({ status: "needs_review" });
  });

  it("preserves download failure for the original asset and only detaches when closed", async () => {
    const f = fixture(); await prepare(f); await f.driver.submit(f.input, f.beforeSubmit);
    f.state.media.push({ url: media, ownerJobId: f.job.id }); f.job.mediaUrl = media;
    f.download.mockResolvedValueOnce({ status: "pending", message: "not ready" } as never);
    expect(await f.driver.download(f.job, "/controlled/output.mp4")).toBeNull();
    expect(f.sent()).toBe(1); expect(f.approved()).toBe(1);
    await f.driver.close(); expect(f.session.close).toHaveBeenCalledOnce();
  });
});
