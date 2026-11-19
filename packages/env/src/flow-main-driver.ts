import type { BrowserResult } from "@moco/protocol";
import type { FlowBrowserDriver, FlowJobState, FlowSubmitInput } from "./browser.js";
import { MainChromeFlowSession } from "./main-chrome.js";

export type FlowNativeQuote = NonNullable<BrowserResult["quote"]>;

export interface FlowNativeConfirmation {
  ownerJobId?: string;
  text: string;
  context: string;
  approveIndex: number;
  checked: boolean;
  disabled: boolean;
  alwaysApproved?: boolean;
  rejected?: boolean;
  rejectDisabled?: boolean;
}

export interface FlowMainPageState {
  url: string;
  promptCount: number;
  promptEnabled: boolean;
  promptValue: string;
  alwaysConfirm: boolean;
  requestMarkers: string[];
  confirmations: FlowNativeConfirmation[];
  media: Array<{ url: string; ownerJobId?: string; durationSeconds?: number }>;
}

export type FlowMainSession = Pick<MainChromeFlowSession, "open" | "check" | "run" | "evaluate" | "close" | "runProjectNavigation" | "navigateProject" | "download">;
type PreparedResult = BrowserResult;

const PROJECT_PATH = /^\/(?:fx\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?tools\/flow\/)?project\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
const EDITOR_SUFFIX = /\/edit\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
const DEFAULT_MODELS = new Set(["", "auto", "flow", "default", "flowdefault", "flow网页默认"]);
const normalizeModel = (value: string) => value.toLowerCase().replace(/[\s-]+/g, "");
const marker = (id: string) => `[Moco job:${id}]`;
const canonicalMedia = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && url.hostname === "flow-content.google" && /^\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(url.pathname)) return url.origin + url.pathname;
  } catch { /* An unavailable media element has no selectable resource. */ }
  return undefined;
};
export function flowProjectUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && ["flow.google.com", "labs.google"].includes(url.hostname) && PROJECT_PATH.test(url.pathname)) return url.origin + url.pathname;
  } catch { /* The driver never leaves the selected Flow project. */ }
  return undefined;
}
const projectRoot = (value: string): string | undefined => {
  try { const url = new URL(value); url.pathname = url.pathname.replace(EDITOR_SUFFIX, ""); return flowProjectUrl(url.href); }
  catch { return undefined; }
};

/** A natural-language estimate is not a native approval quote. */
export function parseFlowNativeQuote(text: string): FlowNativeQuote | undefined {
  const quotes = [...text.matchAll(/要消耗\s*(\d+)\s*个点数\s*[，,]\s*开始生成这\s*(\d+)\s*个视频吗\s*[？?]/g)];
  if (quotes.length !== 1) return undefined;
  const credits = Number(quotes[0]![1]); const outputs = Number(quotes[0]![2]);
  if (!Number.isSafeInteger(credits) || credits < 0 || !Number.isSafeInteger(outputs) || outputs < 1) return undefined;
  return { credits, outputs };
}

// These are application-owned programs. Request content is passed separately as JSON.
// Read only visible controls and media; account details, cookies and storage are never collected.
const READ_PAGE = String.raw`(input) => {
  const visible = (node) => {
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  };
  const text = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  const name = (node) => {
    const labelled = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => text(document.getElementById(id))).join(' ');
    return (node.getAttribute('aria-label') || labelled || Array.from(node.labels || []).map(text).join(' ') || text(node)).trim();
  };
  const markers = (value) => [...value.matchAll(/\[Moco job:([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\]/g)].map((match) => match[1]);
  const uniqueOwner = (node) => { const ids = [...new Set(markers(text(node)))]; return ids.length === 1 ? ids[0] : undefined; };
  const owner = (node) => {
    const turn = node.closest('div.agent-row.message-row');
    if (!turn?.parentElement?.matches('div.messages-list')) return undefined;
    const previous = turn.previousElementSibling;
    return previous?.matches('div.message-row.user-row') ? uniqueOwner(previous) : undefined;
  };
  const radios = Array.from(document.querySelectorAll('input[type="radio"],[role="radio"]')).filter(visible);
  const approvals = radios.filter((node) => name(node) === '批准');
  const confirmations = [];
  for (const card of Array.from(document.querySelectorAll('flow-permission-message')).filter(visible)) {
    const titles = card.querySelectorAll('p.title');
    const groups = card.querySelectorAll('div[role="radiogroup"][aria-label="权限选项"]');
    if (titles.length !== 1 || groups.length !== 1) continue;
    const choices = Array.from(groups[0].querySelectorAll('[role="radio"],input[type="radio"]')).filter(visible);
    const labels = choices.map(name);
    if (choices.length !== 3 || labels.filter((value) => value === '批准').length !== 1 || !labels.includes('在项目中一律批准') || !labels.includes('拒绝')) continue;
    const approve = choices[labels.indexOf('批准')];
    const always = choices[labels.indexOf('在项目中一律批准')];
    const reject = choices[labels.indexOf('拒绝')];
    const index = approvals.indexOf(approve); if (index < 0) continue;
    confirmations.push({ ownerJobId: owner(card), text: text(titles[0]), context: text(card), approveIndex: index,
      checked: approve.checked === true || approve.getAttribute('aria-checked') === 'true',
      disabled: approve.disabled === true || approve.getAttribute('aria-disabled') === 'true',
      alwaysApproved: always.checked === true || always.getAttribute('aria-checked') === 'true',
      rejected: reject.checked === true || reject.getAttribute('aria-checked') === 'true',
      rejectDisabled: reject.disabled === true || reject.getAttribute('aria-disabled') === 'true' });
  }
  const fields = Array.from(document.querySelectorAll('textarea,input,[role="textbox"],[contenteditable="true"]')).filter((node) => visible(node) && name(node) === '您希望创作什么？');
  const field = fields.length === 1 ? fields[0] : undefined;
  const confirmControls = Array.from(document.querySelectorAll('[role="radio"],input[type="radio"]')).filter((node) => visible(node) && name(node) === '始终 智能体将在生成媒体内容之前征求确认。');
  const alwaysConfirm = confirmControls.some((node) => node.checked === true || node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-pressed') === 'true' || node.getAttribute('data-state') === 'checked');
  const requestMarkers = Array.from(document.querySelectorAll('div.messages-list > div.message-row.user-row')).filter(visible).flatMap((node) => markers(text(node)));
  const media = Array.from(document.querySelectorAll('flow-a2ui-video-option')).filter(visible).flatMap((option) => {
    if (!option.parentElement?.matches('div[role="group"][aria-label="媒体选项库"]') || !option.parentElement.parentElement?.matches('flow-a2ui-multiple-choice')) return [];
    const buttons = option.querySelectorAll('div.video-container.clickable[role="button"][aria-label="在编辑器中打开视频"]');
    const images = option.querySelectorAll('img.video-thumbnail');
    if (buttons.length !== 1 || images.length !== 1) return [];
    try {
      const url = new URL(images[0].src, location.href);
      if (url.protocol !== 'https:' || url.hostname !== 'flow-content.google' || url.username || url.password || url.port && url.port !== '443' || !/^\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(url.pathname)) return [];
      return [{ url: url.origin + url.pathname, ownerJobId: owner(option) }];
    }
    catch { return []; }
  });
  return { url: location.origin + location.pathname, promptCount: fields.length, promptEnabled: Boolean(field && !field.disabled && field.getAttribute('aria-disabled') !== 'true' && (field.matches('input,textarea') || field.isContentEditable)), promptValue: field?.value ?? field?.innerText ?? field?.textContent ?? '', alwaysConfirm, requestMarkers, confirmations, media };
}`;

const DOM_ACTIONS = String.raw`
  const scope = location.origin + location.pathname;
  const visible = (node) => node instanceof Element && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0;
  const text = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  const name = (node) => (node.getAttribute('aria-label') || (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => text(document.getElementById(id))).join(' ') || Array.from(node.labels || []).map(text).join(' ') || text(node)).trim();
  const checked = (node) => Boolean(node && (node.checked === true || node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-pressed') === 'true' || node.getAttribute('data-state') === 'checked'));
  const enabled = (node) => Boolean(node && node.isConnected && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
  const role = (kind, label) => {
    const selectors = { button: 'button,[role="button"],input[type="button"],input[type="submit"]', radio: '[role="radio"],input[type="radio"]', heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]', textbox: 'textarea,input,[role="textbox"],[contenteditable="true"]', menuitem: '[role="menuitem"]' };
    return Array.from(document.querySelectorAll(selectors[kind])).filter((node) => visible(node) && name(node) === label);
  };
  const wait = async (predicate, timeout = 5000) => {
    const until = Date.now() + timeout;
    do { if (location.origin + location.pathname !== scope) return false; if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); } while (Date.now() < until);
    return false;
  };
  const click = (node) => {
    if (location.origin + location.pathname !== scope || !visible(node) || !enabled(node)) return false;
    const rect = node.getBoundingClientRect();
    const x = Math.max(0, rect.left) + Math.min(rect.width, innerWidth - Math.max(0, rect.left)) / 2;
    const y = Math.max(0, rect.top) + Math.min(rect.height, innerHeight - Math.max(0, rect.top)) / 2;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    if (hit !== node && !node.contains(hit)) return false;
    node.click(); return true;
  };
  const owner = (node) => {
    const row = node.closest('div.agent-row.message-row'); const user = row?.previousElementSibling;
    const owners = [...text(user).matchAll(/\[Moco job:([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\]/g)].map((entry) => entry[1]);
    return row?.parentElement?.matches('div.messages-list') && user?.matches('div.message-row.user-row') && owners.length === 1 ? owners[0] : undefined;
  };
`;

const REJECT_ONCE = String.raw`async (input) => { /* moco-flow:reject */
  ${DOM_ACTIONS}
  const current = (${READ_PAGE})(null);
  const cards = current.confirmations.filter((card) => card.ownerJobId === input.jobId);
  if (current.url !== input.url || cards.length !== 1 || current.requestMarkers.filter((id) => id === input.jobId).length !== 1) return { rejected: false };
  const card = cards[0];
  if ((card.checked || card.alwaysApproved) && card.disabled) return { rejected: false, accepted: true };
  if (card.rejected && card.rejectDisabled) return { rejected: true };
  if (card.disabled || card.rejectDisabled || card.checked || card.alwaysApproved || card.rejected) return { rejected: false };
  const choices = role('radio', '拒绝'); if (choices.length !== current.confirmations.length) return { rejected: false };
  const node = choices[card.approveIndex]; const permission = node?.closest('flow-permission-message');
  if (!node || owner(node) !== input.jobId || text(permission?.querySelector('p.title')) !== card.text || text(permission) !== card.context || checked(node) || !click(node)) return { rejected: false };
  return { rejected: await wait(() => checked(node) && !enabled(node)) };
}`;

const KEEP_CONFIRMATION = String.raw`async () => { /* moco-flow:settings */
  ${DOM_ACTIONS}
  const settings = role('button', '设置');
  if (settings.length !== 1 || !click(settings[0])) return false;
  if (!await wait(() => role('heading', '智能体设置').length === 1)) return false;
  const always = role('radio', '始终 智能体将在生成媒体内容之前征求确认。');
  const never = role('radio', '永不 智能体将自动生成媒体内容并消耗点数。');
  const save = role('button', '保存');
  if (always.length !== 1 || never.length !== 1 || save.length !== 1) return false;
  if (!checked(always[0]) && !click(always[0])) return false;
  if (!await wait(() => checked(always[0]) && !checked(never[0]))) return false;
  return click(save[0]);
}`;

const SEND_REQUEST = String.raw`async (input) => { /* moco-flow:send */
  ${DOM_ACTIONS}
  const current = (${READ_PAGE})(null);
  if (current.url !== input.url || current.promptCount !== 1 || !current.promptEnabled || current.promptValue.trim() || current.requestMarkers.includes(input.jobId) || current.confirmations.some((card) => !card.disabled)) return { sent: false };
  const prompts = role('textbox', '您希望创作什么？'); const sends = role('button', '开始生成');
  if (prompts.length !== 1 || sends.length !== 1 || !await (${KEEP_CONFIRMATION})()) return { sent: false };
  const prompt = prompts[0]; if (!enabled(prompt) || location.origin + location.pathname !== scope) return { sent: false };
  prompt.focus();
  if (prompt instanceof HTMLInputElement || prompt instanceof HTMLTextAreaElement) {
    const prototype = prompt instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(prompt, input.prompt);
    prompt.dispatchEvent(new Event('input', { bubbles: true })); prompt.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (prompt.isContentEditable) {
    const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(prompt); selection.removeAllRanges(); selection.addRange(range);
    if (!document.execCommand('insertText', false, input.prompt)) return { sent: false };
  } else return { sent: false };
  const filled = (${READ_PAGE})(null);
  if (filled.url !== input.url || filled.promptCount !== 1 || !filled.promptEnabled || filled.requestMarkers.includes(input.jobId) || filled.confirmations.some((card) => !card.disabled) || filled.promptValue.replace(/\s+/g, ' ').trim() !== input.prompt.replace(/\s+/g, ' ').trim()) return { sent: false };
  return { sent: click(sends[0]) };
}`;

const WAIT_CONFIRMATION = String.raw`async (input) => { /* moco-flow:wait */
  ${DOM_ACTIONS}
  return wait(() => (${READ_PAGE})(null).confirmations.some((card) => card.ownerJobId === input.jobId), 30000);
}`;

const APPROVE_ONCE = String.raw`async (input) => { /* moco-flow:approve */
  ${DOM_ACTIONS}
  const current = (${READ_PAGE})(null);
  const cards = current.confirmations.filter((card) => card.ownerJobId === input.jobId);
  if (current.url !== input.url || cards.length !== 1 || current.requestMarkers.filter((id) => id === input.jobId).length !== 1) return { clicked: false };
  const card = cards[0];
  if (card.text !== input.text || card.context !== input.context || card.approveIndex !== input.approveIndex || card.disabled || card.checked) return { clicked: false };
  const choices = role('radio', '批准'); const node = choices[card.approveIndex]; const permission = node?.closest('flow-permission-message');
  if (choices.length !== current.confirmations.length || !node || owner(node) !== input.jobId || text(permission?.querySelector('p.title')) !== input.text || text(permission) !== input.context || checked(node)) return { clicked: false };
  // Validate and click the same live DOM object in one evaluate; no ref lookup can select another card.
  if (!click(node)) return { clicked: false };
  return { clicked: true, confirmed: await wait(() => checked(node) && !enabled(node)) };
}`;

const OPEN_OWNED_EDITOR = String.raw`async (input) => { /* moco-flow:editor */
  ${DOM_ACTIONS}
  const current = (${READ_PAGE})(null);
  const owned = current.media.filter((entry) => entry.ownerJobId === input.jobId && entry.url === input.mediaUrl);
  const approval = current.confirmations.filter((entry) => entry.ownerJobId === input.jobId && (entry.checked || entry.alwaysApproved) && entry.disabled);
  if (current.url !== input.projectUrl || owned.length !== 1 || approval.length !== 1 || current.requestMarkers.filter((id) => id === input.jobId).length !== 1) return { opened: false };
  const matches = Array.from(document.querySelectorAll('flow-a2ui-video-option div.video-container.clickable[role="button"][aria-label="在编辑器中打开视频"]')).filter((node) => {
    const option = node.closest('flow-a2ui-video-option');
    if (!visible(node) || !option?.parentElement?.matches('div[role="group"][aria-label="媒体选项库"]') || !option.parentElement.parentElement?.matches('flow-a2ui-multiple-choice') || owner(option) !== input.jobId) return false;
    const image = option.querySelector('img.video-thumbnail'); if (!image) return false;
    try { const url = new URL(image.src); return url.origin + url.pathname === input.mediaUrl; } catch { return false; }
  });
  if (matches.length !== 1 || !click(matches[0])) return { opened: false };
  const until = Date.now() + 15000;
  do {
    const url = location.origin + location.pathname;
    if (url.startsWith(input.projectUrl + '/edit/') && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(url.slice(input.projectUrl.length + 6))) return { opened: true };
    if (url !== input.projectUrl) return { opened: false };
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < until);
  return { opened: false };
}`;
const DOWNLOAD_ORIGINAL = String.raw`async () => { /* moco-flow:download */
  ${DOM_ACTIONS}
  const download = role('button', '下载媒体内容');
  if (download.length !== 1 || !click(download[0])) throw new Error('Flow original download control is unavailable');
  if (!await wait(() => role('menuitem', '720p 原始尺寸').length === 1)) throw new Error('Flow original option is unavailable');
  const original = role('menuitem', '720p 原始尺寸')[0];
  if (text(original) !== '720p 原始尺寸' || /点数|高清重塑|4K/i.test(text(original))) throw new Error('Flow original option is not a verified free download');
  const sources = [];
  const anchorClick = HTMLAnchorElement.prototype.click;
  // Observe only anchors invoked synchronously by this verified free option.
  // Restore immediately; unrelated user downloads and later tasks are not intercepted.
  const capture = function (...args) { if (this.href) sources.push(this.href); return Reflect.apply(anchorClick, this, args); };
  HTMLAnchorElement.prototype.click = capture;
  try { if (!click(original)) throw new Error('Flow original option is unavailable'); }
  finally { if (HTMLAnchorElement.prototype.click === capture) HTMLAnchorElement.prototype.click = anchorClick; }
  const unique = [...new Set(sources)];
  return { delivered: true, ...(unique.length === 1 ? { source: unique[0] } : {}) };
}`;

const review = (job?: FlowJobState, message = "请在主 Chrome 的原 Flow 项目核对本次请求后继续；未重新生成。"): PreparedResult => ({ status: "needs_review", profileRef: job?.profileRef ?? "", ...(job ? { jobId: job.id, remoteUrl: job.remoteUrl } : {}), message });
const sameQuote = (left: FlowNativeQuote, right: FlowNativeQuote) => left.credits === right.credits && left.outputs === right.outputs && left.durationSeconds === right.durationSeconds && normalizeModel(left.modelId ?? "") === normalizeModel(right.modelId ?? "");
const quoteMatchesRequest = (quote: FlowNativeQuote, input: FlowSubmitInput) => quote.outputs === 1 && (input.durationSeconds === undefined || quote.durationSeconds === input.durationSeconds)
  && (DEFAULT_MODELS.has(normalizeModel(input.modelId ?? "")) || quote.modelId !== undefined && normalizeModel(quote.modelId) === normalizeModel(input.modelId!));

/** Fixed Flow Agent actions over the user-authorized main Chrome tab. */
export class MainChromeFlowDriver implements FlowBrowserDriver {
  constructor(readonly session: FlowMainSession) {}
  static async open(rootDir: string): Promise<MainChromeFlowDriver> {
    const session = new MainChromeFlowSession({ rootDir });
    return new MainChromeFlowDriver(session);
  }
  async open(): Promise<BrowserResult> {
    await this.session.open();
    return this.check();
  }
  async #page(job?: FlowJobState): Promise<{ id: number; state: FlowMainPageState } | PreparedResult> {
    const connection = await this.session.check();
    if (connection.status !== "ready") return { status: connection.status === "needs_connection" ? "needs_login" : "needs_review", profileRef: job?.profileRef ?? "", jobId: job?.id, message: connection.message };
    const expected = job?.remoteUrl ? flowProjectUrl(job.remoteUrl) : undefined;
    if (job?.remoteUrl && !expected) return review(job);
    const projects = connection.tabs.filter((tab) => projectRoot(tab.url) && (!expected || projectRoot(tab.url) === expected));
    if (projects.length !== 1) return review(job, "请在主 Chrome 授权唯一的本次 Flow 项目后继续。");
    const tab = projects[0]!;
    if (!flowProjectUrl(tab.url)) {
      if (!expected) return review(job, "请在主 Chrome 打开 Flow 项目中的智能体对话后继续。");
      const navigation = await this.session.navigateProject(tab.id, expected);
      if (navigation.url !== expected) return review(job);
    }
    const state = await this.session.evaluate<FlowMainPageState>(tab.id, READ_PAGE);
    if (flowProjectUrl(state.url) !== (expected ?? flowProjectUrl(tab.url))) return review(job);
    return { id: tab.id, state };
  }
  async check(): Promise<BrowserResult> {
    const page = await this.#page(); if (!("state" in page)) return page;
    return page.state.promptCount === 1 && page.state.promptEnabled ? { status: "ready", profileRef: "", remoteUrl: page.state.url }
      : review(undefined, "请在主 Chrome 中打开含 Flow Agent 创作输入框的项目。");
  }
  #confirmation(state: FlowMainPageState, input: FlowSubmitInput): { card: FlowNativeConfirmation; quote: FlowNativeQuote } | undefined {
    const cards = state.confirmations.filter((card) => card.ownerJobId === input.job.id);
    if (cards.length !== 1 || state.requestMarkers.filter((id) => id === input.job.id).length !== 1) return undefined;
    const card = cards[0]!; const quote = parseFlowNativeQuote(card.text);
    return quote && quoteMatchesRequest(quote, input) ? { card, quote } : undefined;
  }
  #accepted(state: FlowMainPageState, job: FlowJobState): BrowserResult | undefined {
    const cards = state.confirmations.filter((card) => card.ownerJobId === job.id);
    if (cards.length !== 1 || state.requestMarkers.filter((id) => id === job.id).length !== 1 || !(cards[0]!.checked || cards[0]!.alwaysApproved) || !cards[0]!.disabled) return undefined;
    const quote = parseFlowNativeQuote(cards[0]!.text);
    if (!quote || quote.outputs !== 1) return undefined;
    return { status: "running", profileRef: job.profileRef, jobId: job.id, remoteUrl: state.url, prepared: true, submitted: true, quote };
  }
  async prepare(input: FlowSubmitInput, beforePrepare: (pageUrl: string, baselineUrls: string[]) => void): Promise<PreparedResult> {
    if (input.job.status === "stopped") return review(input.job);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.job.id) || !input.prompt.trim() || input.prompt.length > 32000) return review(input.job);
    const unsupported = input.referencePaths.length ? "当前 Flow 参考素材上传入口需要人工核对；尚未发送或批准生成。"
      : !DEFAULT_MODELS.has(normalizeModel(input.modelId ?? "")) || input.durationSeconds !== undefined ? "当前 Flow 仅支持网页默认模型且不指定时长；请调整后继续，或在原页面人工处理。" : undefined;
    if (input.job.preparedAt === undefined && unsupported) return review(input.job, unsupported);
    const page = await this.#page(input.job); if (!("state" in page)) return page;
    const job = input.job;
    if (job.preparedAt !== undefined && !job.remoteUrl) return review(job);
    if (job.preparedAt !== undefined) { const accepted = this.#accepted(page.state, job); if (accepted) return accepted; }
    if (unsupported) return review(input.job, unsupported);
    if (job.preparedAt === undefined) {
      if (page.state.promptCount !== 1 || !page.state.promptEnabled || page.state.promptValue.trim() || page.state.confirmations.some((card) => !card.disabled) || page.state.requestMarkers.includes(job.id)) return review(job, "请清空未发送草稿，并处理原有 Flow 确认卡后继续。");
      const baseline = [...new Set(page.state.media.map((entry) => canonicalMedia(entry.url)).filter((value): value is string => Boolean(value)))];
      beforePrepare(page.state.url, baseline);
      const prompt = `${marker(job.id)}\n请仅为本任务生成 1 个视频。${input.modelId && !DEFAULT_MODELS.has(normalizeModel(input.modelId)) ? `模型：${input.modelId}。` : ""}${input.durationSeconds !== undefined ? `时长：${input.durationSeconds} 秒。` : ""}请始终先确认，在原生确认卡说明中保留此任务标记，等待单次批准；不要自动批准，不要生成额外变体。\n创作要求：${input.prompt.trim()}`;
      const sent = await this.session.run<{ sent: boolean }>(page.id, SEND_REQUEST, { url: page.state.url, jobId: job.id, prompt });
      if (sent?.sent === false) return { ...review(job), preparationSent: false };
      if (sent?.sent !== true) return review(job);
      await this.session.run(page.id, WAIT_CONFIRMATION, { jobId: job.id });
      page.state = await this.session.evaluate<FlowMainPageState>(page.id, READ_PAGE);
    } else if (page.state.requestMarkers.includes(job.id) && !page.state.confirmations.some((card) => card.ownerJobId === job.id)) {
      await this.session.run(page.id, WAIT_CONFIRMATION, { jobId: job.id });
      page.state = await this.session.evaluate<FlowMainPageState>(page.id, READ_PAGE);
    }
    const accepted = this.#accepted(page.state, job); if (accepted) return accepted;
    const found = this.#confirmation(page.state, input);
    if (!found || found.card.checked || found.card.disabled) return review(job);
    return { status: "ready", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, prepared: true, quote: found.quote, submitted: false };
  }
  async submit(input: FlowSubmitInput, beforeSubmit: (pageUrl: string, baselineUrls: string[]) => void): Promise<BrowserResult> {
    const job = input.job;
    if (job.status === "stopped" || job.preparedAt === undefined || !job.remoteUrl || !job.quote) return review(job, "请先核对原生 Flow 费用确认卡，再批准本次生成。");
    const page = await this.#page(job); if (!("state" in page)) return page;
    const found = this.#confirmation(page.state, input);
    if (!found || !sameQuote(job.quote, found.quote)) return review(job);
    if (found.card.checked && found.card.disabled) return { status: "running", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, submitted: true };
    if (job.submittedAt !== undefined || found.card.checked || found.card.disabled || input.referencePaths.length) return review(job);
    if (!await this.session.run<boolean>(page.id, KEEP_CONFIRMATION)) return review(job, "请确认 Flow 智能体保持“始终”先确认；尚未批准生成。");
    page.state = await this.session.evaluate<FlowMainPageState>(page.id, READ_PAGE);
    const final = this.#confirmation(page.state, input);
    if (!final || !sameQuote(job.quote, final.quote) || final.card.text !== found.card.text || final.card.context !== found.card.context) return review(job);
    if (final.card.checked && final.card.disabled) return { status: "running", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, submitted: true };
    if (final.card.checked || final.card.disabled) return review(job);
    beforeSubmit(page.state.url, job.baselineUrls);
    const outcome = await this.session.run<{ clicked: boolean; confirmed?: boolean }>(page.id, APPROVE_ONCE, { jobId: job.id, url: page.state.url, ...final.card });
    return outcome.clicked && outcome.confirmed ? { status: "running", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, submitted: true }
      : review(job, "Flow 原确认卡已变化，请核对原任务；未再次批准。");
  }
  async poll(job: FlowJobState): Promise<BrowserResult & { mediaUrl?: string }> {
    if (!job.remoteUrl) return review(job);
    const page = await this.#page(job); if (!("state" in page)) return page;
    if (job.submittedAt === undefined || !page.state.requestMarkers.includes(job.id)) return review(job);
    const cards = page.state.confirmations.filter((card) => card.ownerJobId === job.id);
    if (cards.length !== 1 || !(cards[0]!.checked || cards[0]!.alwaysApproved) || !cards[0]!.disabled) return review(job);
    const matches = page.state.media.filter((entry) => entry.ownerJobId === job.id && canonicalMedia(entry.url) && !job.baselineUrls.includes(canonicalMedia(entry.url)!));
    const unique = [...new Map(matches.map((entry) => [canonicalMedia(entry.url), entry])).values()];
    if (unique.length > 1) return review(job, "Flow 出现多个本次产物，请人工选定原任务结果；未重新生成。");
    if (unique.length === 1) return { status: "completed", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, mediaUrl: canonicalMedia(unique[0]!.url), submitted: true };
    return { status: "running", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, submitted: true };
  }
  async stop(job: FlowJobState): Promise<BrowserResult> {
    const page = await this.#page(job); if (!("state" in page)) return page;
    const cards = page.state.confirmations.filter((card) => card.ownerJobId === job.id);
    if (cards.length !== 1 || page.state.requestMarkers.filter((id) => id === job.id).length !== 1) return review(job, "Flow 原请求尚无可核对的确认卡，将继续核对原任务。");
    const card = cards[0]!;
    if ((card.checked || card.alwaysApproved) && card.disabled) return { status: "running", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, submitted: true };
    if (card.rejected && card.rejectDisabled) return { status: "stopped", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, submitted: false };
    if (job.submittedAt !== undefined || card.disabled || card.rejectDisabled || card.checked || card.alwaysApproved || card.rejected) return review(job);
    const result = await this.session.run<{ rejected: boolean; accepted?: boolean }>(page.id, REJECT_ONCE, { jobId: job.id, url: page.state.url });
    return result.accepted ? { status: "running", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, submitted: true }
      : result.rejected ? { status: "stopped", profileRef: job.profileRef, jobId: job.id, remoteUrl: page.state.url, submitted: false }
      : review(job, "Flow 原确认卡尚未确认拒绝，将继续核对；不会批准生成。");
  }
  async download(job: FlowJobState, destination: string): Promise<{ name: string; mimeType: string; size: number } | null> {
    if (!job.mediaUrl || !canonicalMedia(job.mediaUrl)) return null;
    const selected = await this.poll(job);
    if (selected.status !== "completed" || !selected.mediaUrl || canonicalMedia(selected.mediaUrl) !== canonicalMedia(job.mediaUrl)) return null;
    const connection = await this.session.check();
    const tabs = connection.tabs.filter((tab) => flowProjectUrl(tab.url) === job.remoteUrl);
    if (connection.status !== "ready" || tabs.length !== 1 || !job.remoteUrl) return null;
    const tab = tabs[0]!;
    const navigation = await this.session.runProjectNavigation<{ opened: boolean }>(tab.id, job.remoteUrl, OPEN_OWNED_EDITOR, { jobId: job.id, projectUrl: job.remoteUrl, mediaUrl: selected.mediaUrl });
    if (!navigation.value.opened || projectRoot(navigation.url) !== job.remoteUrl || !EDITOR_SUFFIX.test(new URL(navigation.url).pathname)) return null;
    const result = await this.session.download(tab.id, DOWNLOAD_ORIGINAL, destination);
    return result.status === "completed" ? { ...result.file, name: `flow-${job.id}.mp4` } : null;
  }
  async close(): Promise<void> { await this.session.close(); }
}
