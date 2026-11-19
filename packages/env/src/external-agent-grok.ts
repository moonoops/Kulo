import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ExternalAgentBinding, ExternalAgentCapabilities, ExternalAgentDetection } from "@kulo/protocol";
import type { ExternalDriver, ExternalDriverContext } from "./external-agent-drivers.js";

const capabilities: ExternalAgentCapabilities = {
  resume: false, cancel: false, models: false, permissions: false, collaboration: false,
  terminalEvidence: "observed",
};
const maxBytes = 1024 * 1024;
const uncertainResult = "Grok Bot result observed without a native task terminal signal; main Agent acceptance is required";

function endpoint(binding: ExternalAgentBinding): URL {
  if (binding.kind !== "grok-bot" || binding.experimental !== true) {
    throw new Error("Grok Bot requires an explicitly enabled experimental binding");
  }
  // Checking the literal authority also rejects URL's alternative numeric IPv4 spellings.
  if (!binding.cdpUrl || !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/.test(binding.cdpUrl)) {
    throw new Error("Grok Bot requires an explicit loopback HTTP CDP origin without credentials, paths or query parameters");
  }
  const value = new URL(binding.cdpUrl);
  if (value.port === "0") throw new Error("Invalid Grok Bot CDP port");
  return value;
}

function botId(binding: ExternalAgentBinding): string {
  const id = binding.agentRef;
  if (!id || id.trim() !== id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) {
    throw new Error("Grok Bot requires an exact Bot ID, not a name or partial match");
  }
  return id;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function target(origin: URL): Promise<string> {
  const response = await fetch(new URL("/json/list", origin), { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body) throw new Error("Grok Bot local CDP metadata is unavailable");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("Grok Bot CDP metadata exceeds the size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const listing: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(listing)) throw new Error("Invalid Grok Bot CDP metadata");
  const pages = listing.map(record).filter(page => {
    const url = typeof page.url === "string" ? page.url : "";
    const title = typeof page.title === "string" ? page.title : "";
    return page.type === "page" && /^file:\/\//.test(url) && /app\.asar|\/renderer\/index\.html/.test(url)
      && /grok(?:[ -]|%20)*bot/i.test(`${url} ${title}`);
  });
  if (pages.length !== 1) throw new Error("Exactly one Grok Bot desktop renderer must be available on the configured CDP endpoint");
  const raw = pages[0]!.webSocketDebuggerUrl;
  if (typeof raw !== "string" || !/^ws:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/devtools\/page\/[^/?#]+$/.test(raw)) {
    throw new Error("Grok Bot CDP must advertise a loopback page websocket without credentials or query parameters");
  }
  const socket = new URL(raw);
  if (socket.hostname !== origin.hostname || (socket.port || "80") !== (origin.port || "80")) {
    throw new Error("Grok Bot CDP websocket must use the explicitly configured loopback origin");
  }
  return socket.href;
}

class GrokCdp {
  private nextId = 0;
  private closed = false;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  private constructor(private socket: WebSocket) {
    socket.on("message", data => {
      let value: Record<string, unknown>;
      try { value = record(JSON.parse(data.toString())); }
      catch { this.fail(new Error("Grok Bot CDP returned invalid JSON")); return; }
      if (typeof value.id !== "number") return;
      const call = this.pending.get(value.id);
      if (!call) return;
      this.pending.delete(value.id);
      clearTimeout(call.timer);
      if (value.error) call.reject(new Error("Grok Bot CDP rejected the operation"));
      else call.resolve(value.result);
    });
    socket.on("error", () => this.fail(new Error("Grok Bot CDP connection failed")));
    socket.on("close", () => this.fail(new Error("Grok Bot CDP connection closed")));
  }

  static async open(url: string): Promise<GrokCdp> {
    const socket = new WebSocket(url, { maxPayload: maxBytes, handshakeTimeout: 5000, followRedirects: false });
    const cdp = new GrokCdp(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new Error("Cannot connect to the configured Grok Bot CDP endpoint")));
      socket.once("close", () => reject(new Error("Grok Bot CDP closed during handshake")));
    });
    return cdp;
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Grok Bot CDP is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Grok Bot CDP operation timed out; delivery may be uncertain"));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("Grok Bot CDP request could not be delivered"));
      });
    });
  }

  async evaluate(expression: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const reply = record(await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, timeoutMs));
    if (reply.exceptionDetails) throw new Error("The installed Grok Bot client interface has changed or is unavailable");
    return record(record(reply.result).value);
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
  }

  close(): void {
    this.fail(new Error("Grok Bot CDP observation stopped"));
    this.socket.close();
  }
}

// Interface names verified against grokbot-bridge b905584 (MIT). This adapter neither
// imports that bridge nor exposes its account, file, launch, roster-list or stop-all APIs.
const findStores = `
  const found = {};
  const visited = new Set();
  const roots = [document.body, ...Array.from(document.querySelectorAll('[data-agent-id], button')).slice(0, 32)];
  for (const root of roots) {
    if (!root) continue;
    const key = Object.getOwnPropertyNames(root).find(name => name.startsWith('__reactFiber'));
    let node = key ? root[key] : null;
    for (let depth = 0; node && depth < 256 && !visited.has(node); depth++, node = node.return) {
      visited.add(node);
      const value = node.memoizedProps && node.memoizedProps.value;
      if (!value || typeof value !== 'object') continue;
      for (const [name, method] of [['roster', 'createAgent'], ['transcript', 'snapshotsFor'], ['sendJournal', 'sendPrompt']]) {
        if (!found[name] && value[name] && typeof value[name][method] === 'function') found[name] = value[name];
      }
    }
  }
  if (!found.roster || !found.transcript || !found.sendJournal) return {ok:false, code:'interface-unavailable'};
`;

function prepareExpression(key: string, id: string, waitMs: number): string {
  return `(async () => {
    ${findStores}
    const key = ${JSON.stringify(key)}, id = ${JSON.stringify(id)};
    const registryKey = '__kuloGrokExperimentalRunsV1';
    const registry = window[registryKey] || (window[registryKey] = new Map());
    if (!(registry instanceof Map) || registry.has(id)) return {ok:false, code:'already-observing'};
    const row = () => found.roster.snapshots.get().agentsById.get(id);
    const idle = r => r && r.id === id && !r.isGroup && !r.isRunning && !r.isRunningTurn && !r.isComposingMessage
      && !(r.runningSessionIds && r.runningSessionIds.length) && r.awaitingUserResponse == null;
    if (!idle(row())) return {ok:false, code:'bot-missing-or-busy'};
    const state = {id, ...found, row, idle, release:null, nonce:null, before:null};
    registry.set(id, key);
    window[key] = state;
    try {
      state.release = found.transcript.observeEntries(id, () => {});
      if (typeof state.release !== 'function') throw new Error('unsupported-observer');
      const snapshot = () => found.transcript.snapshotsFor(id).get();
      const deadline = Date.now() + ${waitMs};
      if (snapshot().loadState !== 'ready') found.transcript.load(id);
      while (snapshot().loadState !== 'ready') {
        if (snapshot().failure || Date.now() >= deadline) throw new Error('transcript-unavailable');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!idle(row())) throw new Error('bot-became-busy');
      const entries = snapshot().entries;
      if (!Array.isArray(entries)) throw new Error('invalid-transcript');
      state.before = entries.map(entry => entry.id);
      return {ok:true};
    } catch {
      if (typeof state.release === 'function') state.release();
      registry.delete(id);
      delete window[key];
      return {ok:false, code:'transcript-unavailable'};
    }
  })()`;
}

function sendExpression(key: string, prompt: string): string {
  return `(async () => {
    const state = window[${JSON.stringify(key)}];
    if (!state || !state.idle(state.row())) return {ok:false, attempted:false, code:'bot-became-busy'};
    const entries = state.transcript.snapshotsFor(state.id).get().entries;
    if (!Array.isArray(entries) || entries.length !== state.before.length || entries.some((entry, i) => entry.id !== state.before[i]))
      return {ok:false, attempted:false, code:'conversation-changed'};
    if (state.attempted) return {ok:false, attempted:true, code:'already-submitted'};
    state.attempted = true;
    try {
      await state.sendJournal.sendPrompt({agentId:state.id, prompt:${JSON.stringify(prompt)}, attachments:[], onNonceAssigned: value => {
        if (value && typeof value.nonce === 'string' && value.nonce.length && value.nonce.length <= 256 && !state.nonce) state.nonce = value.nonce;
        else state.invalidNonce = true;
      }});
      return {ok:!!state.nonce && !state.invalidNonce, attempted:true, nonce:state.nonce};
    } catch { return {ok:false, attempted:true, nonce:state.nonce, code:'send-outcome-unknown'}; }
  })()`;
}

function pollExpression(key: string, nonce: string, prompt: string): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    if (!state || state.nonce !== ${JSON.stringify(nonce)} || state.invalidNonce) return {ok:false, code:'correlation-lost'};
    const row = state.row();
    if (!row || row.id !== state.id || row.isGroup || (row.runningSessionIds && row.runningSessionIds.length > 1))
      return {ok:false, code:'bot-missing-or-concurrent'};
    const entries = state.transcript.snapshotsFor(state.id).get().entries;
    if (!Array.isArray(entries)) return {ok:false, code:'invalid-transcript'};
    const indices = [];
    for (let i = 0; i < entries.length; i++) if (entries[i].clientNonce === state.nonce) indices.push(i);
    if (!indices.length) return {ok:true, anchored:false};
    if (indices.length !== 1) return {ok:false, code:'ambiguous-nonce'};
    const anchor = entries[indices[0]];
    if (anchor.kind !== 'message' || anchor.role !== 'user' || anchor.content !== ${JSON.stringify(prompt)} || state.before.includes(anchor.id))
      return {ok:false, code:'invalid-anchor'};
    const after = entries.slice(indices[0] + 1);
    if (after.length > 128 || after.some(entry => entry.kind === 'user-attachment' || (entry.kind === 'message' && entry.role === 'user')))
      return {ok:false, code:'conversation-interleaved'};
    const messages = [];
    let streaming = false, bytes = 0;
    for (const entry of after) {
      streaming = streaming || !!entry.isStreaming;
      const text = entry.kind === 'message' && entry.role === 'assistant' ? entry.content
        : entry.kind === 'send-message' && entry.message && entry.message.type === 'text' ? entry.message.content : null;
      if (typeof text !== 'string') continue;
      bytes += text.length;
      if (typeof entry.id !== 'string' || bytes > 262144) return {ok:false, code:'result-limit'};
      if (!entry.isStreaming && text) messages.push({id:entry.id, text});
    }
    return {ok:true, anchored:true, messages, streaming, busy:!!(row.isRunning || row.isRunningTurn || row.isComposingMessage),
      needsInput:row.awaitingUserResponse != null};
  })()`;
}

function cleanupExpression(key: string): string {
  return `(() => {
    const state = window[${JSON.stringify(key)}];
    if (state) {
      if (typeof state.release === 'function') state.release();
      const registry = window.__kuloGrokExperimentalRunsV1;
      if (registry instanceof Map && registry.get(state.id) === ${JSON.stringify(key)}) registry.delete(state.id);
      delete window[${JSON.stringify(key)}];
    }
    return {ok:true};
  })()`;
}

export async function detectGrok(binding: ExternalAgentBinding): Promise<ExternalAgentDetection> {
  let cdp: GrokCdp | undefined;
  try {
    const origin = endpoint(binding);
    botId(binding);
    cdp = await GrokCdp.open(await target(origin));
    await cdp.call("Runtime.getIsolateId");
    return { kind: "grok-bot", installed: true, authenticated: null, models: [], capabilities: { ...capabilities } };
  } catch (error) {
    return { kind: "grok-bot", installed: false, authenticated: null, models: [], capabilities: { ...capabilities }, error: error instanceof Error ? error.message : "Grok Bot CDP detection failed" };
  } finally { cdp?.close(); }
}

export async function connectGrok(ctx: ExternalDriverContext): Promise<ExternalDriver> {
  const origin = endpoint(ctx.binding), id = botId(ctx.binding);
  if (ctx.sessionId) throw new Error("Grok Bot native session resume is unsupported");
  if (ctx.modelId) throw new Error("Grok Bot model selection must be configured in its own local client");
  if (ctx.thinkingLevel) throw new Error("Grok Bot thinking level selection must be configured in its own local client");
  if (!ctx.prompt.trim() || ctx.prompt.length > 65536) throw new Error("Grok Bot experiment prompt is empty or exceeds the size limit");
  if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0) throw new Error("Invalid Grok Bot experiment timeout");
  const cdp = await GrokCdp.open(await target(origin));
  const key = `__kuloGrokRun_${randomUUID().replaceAll("-", "")}`;
  const prompt = ctx.prompt.trim(), deadline = Date.now() + ctx.timeoutMs;
  let closed = false, submitted = false, finished = false;
  let wake: (() => void) | undefined;
  const remaining = () => Math.max(1, Math.min(10000, deadline - Date.now()));
  const close = () => {
    if (closed) return;
    closed = true;
    wake?.();
    void cdp.evaluate(cleanupExpression(key), 1000).finally(() => cdp.close()).catch(() => {});
  };
  const finish = (state: "failed" | "uncertain", error: string) => {
    if (closed || finished) return;
    finished = true;
    ctx.complete(state, error);
    close();
  };
  const driver: ExternalDriver = {
    cancel: async () => { throw new Error("Grok Bot cancellation is unsupported without a proven Kulo-owned native session; stop the selected run in Grok Bot"); },
    close,
  };
  try {
    const prepared = await cdp.evaluate(prepareExpression(key, id, remaining()), remaining());
    if (prepared.ok !== true) throw new Error(`Grok Bot experiment could not select the exact idle Bot (${String(prepared.code ?? "interface-unavailable")})`);
    ctx.event("state", "Grok Bot experimental observation; native client permissions apply");
    // A lost reply after this point cannot establish that sendPrompt did not run.
    ctx.submitted();
    submitted = true;
    const sent = await cdp.evaluate(sendExpression(key, prompt), remaining());
    if (sent.ok !== true || typeof sent.nonce !== "string") {
      finish(sent.attempted === false ? "failed" : "uncertain", "Grok Bot delivery could not be correlated; the message will not be resent");
      return driver;
    }
    const nonce = sent.nonce;
    void (async () => {
      const seen = new Map<string, string>();
      let settledSince = Date.now(), emittedBytes = 0;
      try {
        while (!closed && Date.now() < deadline) {
          const result = await cdp.evaluate(pollExpression(key, nonce, prompt), remaining());
          if (closed) return;
          if (result.ok !== true) { finish("uncertain", "Grok Bot result correlation was lost or another turn interleaved; no automatic resend is permitted"); return; }
          const messages = Array.isArray(result.messages) ? result.messages.map(record) : [];
          for (const message of messages) {
            if (typeof message.id !== "string" || typeof message.text !== "string") throw new Error("Invalid Grok Bot message shape");
            const previous = seen.get(message.id);
            if (previous !== undefined && previous !== message.text) throw new Error("Grok Bot changed an already observed result");
            if (previous !== undefined) continue;
            emittedBytes += Buffer.byteLength(message.text);
            if (emittedBytes > maxBytes) throw new Error("Grok Bot result exceeds the observation limit");
            seen.set(message.id, message.text);
            ctx.event("message", message.text);
            settledSince = Date.now();
          }
          if (result.needsInput === true) { finish("uncertain", "Grok Bot requires user input or approval in its own local client"); return; }
          if (result.busy === true || result.streaming === true || result.anchored !== true) settledSince = Date.now();
          else if (seen.size && Date.now() - settledSince >= 2000) { finish("uncertain", uncertainResult); return; }
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.min(250, Math.max(1, deadline - Date.now())));
            wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
          });
        }
        finish("uncertain", "Grok Bot observation timed out without a native task terminal signal; do not resend automatically");
      } catch { finish("uncertain", "Grok Bot connection or result correlation failed after submission; do not resend automatically"); }
    })();
    return driver;
  } catch (error) {
    if (submitted) {
      finish("uncertain", "Grok Bot delivery may have occurred before the connection failed; do not resend automatically");
      return driver;
    }
    close();
    throw error;
  }
}
