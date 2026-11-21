import type { DiagramMotionMode } from "./diagram-validator.js";

export const DIAGRAM_SEMANTIC_TOKEN_NAMES = [
  "--d-paper",
  "--d-paper-2",
  "--d-ink",
  "--d-muted",
  "--d-soft",
  "--d-rule",
  "--d-rule-solid",
  "--d-accent",
  "--d-accent-tint",
  "--d-link",
  "--d-success",
  "--d-warning",
  "--d-danger",
] as const;

export type DiagramSemanticTokenName = (typeof DIAGRAM_SEMANTIC_TOKEN_NAMES)[number];

export const DIAGRAM_DEFAULT_LIGHT_VARS: Record<DiagramSemanticTokenName, string> = {
  "--d-paper": "#ffffff",
  "--d-paper-2": "#f4f4f5",
  "--d-ink": "#18181b",
  "--d-muted": "#52525b",
  "--d-soft": "#71717a",
  "--d-rule": "rgba(24, 24, 27, 0.14)",
  "--d-rule-solid": "#d4d4d8",
  "--d-accent": "#2563eb",
  "--d-accent-tint": "rgba(37, 99, 235, 0.09)",
  "--d-link": "#1d4ed8",
  "--d-success": "#15803d",
  "--d-warning": "#b45309",
  "--d-danger": "#b91c1c",
};

export const DIAGRAM_DEFAULT_DARK_VARS: Record<DiagramSemanticTokenName, string> = {
  "--d-paper": "#18181b",
  "--d-paper-2": "#27272a",
  "--d-ink": "#f4f4f5",
  "--d-muted": "#a1a1aa",
  "--d-soft": "#8f8f99",
  "--d-rule": "rgba(244, 244, 245, 0.15)",
  "--d-rule-solid": "#3f3f46",
  "--d-accent": "#60a5fa",
  "--d-accent-tint": "rgba(96, 165, 250, 0.14)",
  "--d-link": "#93c5fd",
  "--d-success": "#4ade80",
  "--d-warning": "#fbbf24",
  "--d-danger": "#f87171",
};

/** Pure-JS synchronous SHA-256 -> Base64 so @kulo/protocol remains 100% browser-safe. */
function sha256Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0; H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0; H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0;
  }
  const digest = new Uint8Array(32);
  const dv = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, H[i]!, false);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < digest.length; i += 3) {
    const n = (digest[i]! << 16) | ((digest[i + 1] ?? 0) << 8) | (digest[i + 2] ?? 0);
    out += alphabet[(n >>> 18) & 63]! + alphabet[(n >>> 12) & 63]! +
      (i + 1 < digest.length ? alphabet[(n >>> 6) & 63]! : "=") +
      (i + 2 < digest.length ? alphabet[n & 63]! : "=");
  }
  return out;
}

/**
 * Single audited bridge + optional step-playback controller pinned by Base64 SHA-256 CSP.
 * Never add extra whitespace inside <script>...</script> around this constant.
 */
export const CANONICAL_DIAGRAM_BRIDGE_SCRIPT = `(function(){
"use strict";
var ALLOWED_VARS={"--d-paper":1,"--d-paper-2":1,"--d-ink":1,"--d-muted":1,"--d-soft":1,"--d-rule":1,"--d-rule-solid":1,"--d-accent":1,"--d-accent-tint":1,"--d-link":1,"--d-success":1,"--d-warning":1,"--d-danger":1};
var COLOR_RE=/^(?:#[0-9a-f]{6}|rgba?\\(\\d{1,3},\\s*\\d{1,3},\\s*\\d{1,3}(?:,\\s*(?:0|1|0?\\.\\d+))?\\))$/i;
var docEl=document.documentElement;
var root=document.getElementById("kulo-diagram-root");
var lastHeight=0;
var readySent=false;
var expanded=false;
var locale="zh";
var motionSync=null;
function measureHeight(){
  if(!root)return 0;
  return Math.ceil(root.getBoundingClientRect().height);
}
function postHeight(forceReady){
  if(!window.parent||window.parent===window)return;
  if(expanded&&!forceReady)return;
  var h=measureHeight();
  if(h<=0)return;
  if(forceReady||!readySent){
    readySent=true;
    lastHeight=h;
    window.parent.postMessage({type:"kulo:diagram-ready",height:h},"*");
    return;
  }
  if(Math.abs(h-lastHeight)>=2){
    lastHeight=h;
    window.parent.postMessage({type:"kulo:diagram-height",height:h},"*");
  }
}
if(root&&typeof ResizeObserver!=="undefined"){
  new ResizeObserver(function(){postHeight(false);}).observe(root);
}
window.addEventListener("message",function(ev){
  if(ev.source!==window.parent)return;
  var d=ev.data;
  if(!d||d.type!=="kulo:diagram-theme")return;
  if(d.theme==="light"||d.theme==="dark")docEl.dataset.theme=d.theme;
  if(typeof d.reduceMotion==="boolean")docEl.dataset.reduceMotion=d.reduceMotion?"true":"false";
  if(typeof d.expanded==="boolean"){
    expanded=d.expanded;
    docEl.dataset.expanded=expanded?"true":"false";
    if(!expanded)lastHeight=0;
  }
  if(d.locale==="en"||d.locale==="zh")locale=d.locale;
  if(d.vars&&typeof d.vars==="object"){
    var keys=Object.keys(d.vars);
    for(var i=0;i<keys.length;i++){
      var k=keys[i],v=d.vars[k];
      if(ALLOWED_VARS[k]&&typeof v==="string"&&COLOR_RE.test(v.trim())){
        docEl.style.setProperty(k,v.trim());
      }
    }
  }
  if(motionSync)motionSync();
  requestAnimationFrame(function(){postHeight(true);});
});
(function initMotion(){
  if(!root)return;
  var mode=root.dataset.motionMode||"none";
  var controls=root.querySelector("[data-motion-controls]");
  if(mode==="none"||!controls)return;
  var items=Array.prototype.slice.call(root.querySelectorAll("[data-motion-item]"));
  var maxStep=0;
  for(var i=0;i<items.length;i++){
    var s=parseInt(items[i].getAttribute("data-step")||"0",10);
    if(s>maxStep)maxStep=s;
  }
  if(maxStep<=0){controls.hidden=true;return;}
  var step=maxStep,playing=false,timer=null;
  var mql=window.matchMedia?window.matchMedia("(prefers-reduced-motion: reduce)"):null;
  var statusEl=controls.querySelector("[data-motion-status]");
  var labels={
    zh:{play:"播放",pause:"暂停",replay:"重播",prev:"上一步",next:"下一步"},
    en:{play:"Play",pause:"Pause",replay:"Replay",prev:"Prev",next:"Next"}
  };
  function isReduced(){return docEl.dataset.reduceMotion==="true"||Boolean(mql&&mql.matches);}
  function applyLocale(){
    var map=labels[locale]||labels.zh;
    var btns=controls.querySelectorAll("[data-motion-action]");
    for(var j=0;j<btns.length;j++){
      var act=btns[j].getAttribute("data-motion-action");
      if(act&&map[act])btns[j].textContent=map[act];
    }
    updateStatus();
  }
  function updateStatus(){
    if(!statusEl)return;
    statusEl.textContent=locale==="en"?("Step "+step+" / "+maxStep):("第 "+step+" / "+maxStep+" 步");
  }
  function pause(){
    playing=false;
    if(timer){clearTimeout(timer);timer=null;}
    var p=controls.querySelector('[data-motion-action="play"]');
    if(p)p.setAttribute("aria-pressed","false");
  }
  function render(next){
    step=Math.max(0,Math.min(maxStep,next));
    for(var j=0;j<items.length;j++){
      var s=parseInt(items[j].getAttribute("data-step")||"1",10);
      items[j].setAttribute("data-motion-visible",s<=step?"true":"false");
    }
    var prevBtn=controls.querySelector('[data-motion-action="prev"]');
    var nextBtn=controls.querySelector('[data-motion-action="next"]');
    if(prevBtn)prevBtn.disabled=step<=0;
    if(nextBtn)nextBtn.disabled=step>=maxStep;
    updateStatus();
  }
  function tick(){
    if(!playing)return;
    if(step>=maxStep){pause();return;}
    render(step+1);
    if(step<maxStep)timer=setTimeout(tick,720);else pause();
  }
  function play(fromStart){
    if(isReduced())return;
    pause();
    if(fromStart||step>=maxStep)render(0);
    playing=true;
    var p=controls.querySelector('[data-motion-action="play"]');
    if(p)p.setAttribute("aria-pressed","true");
    timer=setTimeout(tick,480);
  }
  function syncReduced(){
    applyLocale();
    if(isReduced()){
      pause();
      controls.hidden=true;
      render(maxStep);
      root.classList.remove("motion-ready");
      return;
    }
    controls.hidden=false;
    root.classList.add("motion-ready");
  }
  controls.addEventListener("click",function(ev){
    var btn=ev.target&&ev.target.closest?ev.target.closest("[data-motion-action]"):null;
    if(!btn)return;
    var act=btn.getAttribute("data-motion-action");
    if(act==="play")play(false);
    else if(act==="pause")pause();
    else if(act==="replay")play(true);
    else if(act==="prev"){pause();render(step-1);}
    else if(act==="next"){pause();render(step+1);}
  });
  root.addEventListener("keydown",function(ev){
    if(isReduced())return;
    if(ev.key==="ArrowLeft"){ev.preventDefault();pause();render(step-1);}
    else if(ev.key==="ArrowRight"){ev.preventDefault();pause();render(step+1);}
    else if(ev.key==="Home"){ev.preventDefault();pause();render(0);}
    else if(ev.key==="End"){ev.preventDefault();pause();render(maxStep);}
    else if(ev.code==="Space"&&(!ev.target||!ev.target.closest("button"))){ev.preventDefault();playing?pause():play(false);}
    else if(!ev.ctrlKey&&!ev.metaKey&&!ev.altKey&&ev.key.toLowerCase()==="r"){ev.preventDefault();play(true);}
  });
  if(mql&&mql.addEventListener)mql.addEventListener("change",syncReduced);
  motionSync=syncReduced;
  if(isReduced()){
    syncReduced();
  }else{
    root.classList.add("motion-ready");
    applyLocale();
    if(mode==="reveal"){render(0);play(false);}else{render(maxStep);}
  }
})();
requestAnimationFrame(function(){postHeight(false);});
})();`;

export const CANONICAL_DIAGRAM_BRIDGE_SCRIPT_SHA256 = sha256Base64(CANONICAL_DIAGRAM_BRIDGE_SCRIPT);

/** Strictly pins inline diagram execution to Kulo's single audited bridge script (no unsafe-inline, no forms). */
export const HTML_DIAGRAM_CSP = [
  "default-src 'none'",
  "sandbox allow-scripts",
  `script-src 'sha256-${CANONICAL_DIAGRAM_BRIDGE_SCRIPT_SHA256}'`,
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export const HTML_DIAGRAM_BROWSER_CSP = HTML_DIAGRAM_CSP.replace("frame-src 'none'", "frame-src about:");

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cssVarsBlock(vars: Record<DiagramSemanticTokenName, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");
}

/** Preserve multilingual readable title while guaranteeing `.html` extension survives 180-char filename sanitization. */
export function diagramDisplayName(title: string): string {
  const cleaned = title
    .replace(/[/\\\x00-\x1f\x7f<>:"|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.html?$/i, "")
    .trim();
  const base = Array.from(cleaned).slice(0, 120).join("").trim() || "diagram";
  return `${base}.html`;
}

export function diagramTitleFromName(name: string): string {
  return name.replace(/\.html?$/i, "").trim() || name;
}

export function wrapInlineDiagramDocument(input: {
  title: string;
  svg: string;
  motion?: DiagramMotionMode;
}): string {
  const motion: DiagramMotionMode = input.motion ?? "none";
  const controlsMarkup = motion === "none"
    ? ""
    : `<div class="kulo-diagram-controls" data-motion-controls role="group" aria-label="演示控制"><button type="button" data-motion-action="prev">上一步</button><button type="button" data-motion-action="play" aria-pressed="false">播放</button><button type="button" data-motion-action="pause">暂停</button><button type="button" data-motion-action="next">下一步</button><button type="button" data-motion-action="replay">重播</button><span class="kulo-diagram-status" data-motion-status aria-live="polite"></span></div>`;

  const styles = [
    `*,*::before,*::after{box-sizing:border-box}`,
    `:root{${cssVarsBlock(DIAGRAM_DEFAULT_LIGHT_VARS)};--d-font-sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;--d-font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;color-scheme:light dark}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${cssVarsBlock(DIAGRAM_DEFAULT_DARK_VARS)}}}`,
    `:root[data-theme="dark"]{${cssVarsBlock(DIAGRAM_DEFAULT_DARK_VARS)};color-scheme:dark}`,
    `:root[data-theme="light"]{color-scheme:light}`,
    `html,body{margin:0;padding:0;height:auto;min-height:0;overflow-x:auto;overflow-y:hidden;background:var(--d-paper);color:var(--d-ink);font-family:var(--d-font-sans);scrollbar-width:thin;scrollbar-color:var(--d-soft) transparent}`,
    `::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{border-radius:3px;background:var(--d-soft)}`,
    `#kulo-diagram-root{width:100%;padding:16px;display:flex;flex-direction:column;align-items:center;gap:12px}`,
    `#kulo-diagram-root svg{width:100%;height:auto;max-height:520px;display:block}`,
    `:root[data-expanded="true"],:root[data-expanded="true"] body{height:100%;overflow:auto}`,
    `:root[data-expanded="true"] #kulo-diagram-root{min-height:100%;justify-content:center;padding:24px}`,
    `:root[data-expanded="true"] #kulo-diagram-root svg{width:auto;height:auto;max-width:100%;max-height:calc(100vh - 72px);margin:0 auto}`,
    `.motion-ready [data-motion-item]{transition:opacity 240ms ease-out}`,
    `.motion-ready [data-motion-item][data-motion-visible="false"]{opacity:0.08}`,
    `.kulo-diagram-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;width:100%}`,
    `.kulo-diagram-controls[hidden]{display:none}`,
    `.kulo-diagram-controls button{appearance:none;border:1px solid var(--d-rule-solid);background:var(--d-paper-2);color:var(--d-ink);border-radius:8px;padding:4px 10px;min-height:28px;font:500 12px/18px var(--d-font-sans);cursor:pointer}`,
    `.kulo-diagram-controls button:hover:not(:disabled){border-color:var(--d-muted)}`,
    `.kulo-diagram-controls button:disabled{opacity:.42;cursor:default}`,
    `.kulo-diagram-controls button:focus-visible{outline:2px solid var(--d-accent);outline-offset:1px}`,
    `.kulo-diagram-status{font:400 12px/18px var(--d-font-sans);color:var(--d-muted);margin-inline-start:6px;font-variant-numeric:tabular-nums}`,
    `@media (prefers-reduced-motion:reduce){.motion-ready [data-motion-item]{transition:none;opacity:1!important}[data-motion-controls]{display:none!important}}`,
    `:root[data-reduce-motion="true"] .motion-ready [data-motion-item]{transition:none;opacity:1!important}`,
    `:root[data-reduce-motion="true"] [data-motion-controls]{display:none!important}`,
    `@media print{#kulo-diagram-root{padding:8px}#kulo-diagram-root svg{max-height:none}[data-motion-controls]{display:none!important}}`,
  ].join("");

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtmlText(input.title)}</title><style>${styles}</style></head><body><div id="kulo-diagram-root" data-motion-mode="${motion}">${input.svg}${controlsMarkup}</div><script>${CANONICAL_DIAGRAM_BRIDGE_SCRIPT}</script></body></html>`;
}

/** Standalone outer isolation frame for opening a diagram in a browser tab (no double DOCTYPE, no allow-forms). */
export function htmlDiagramBrowserDocument(html: string, name = "Diagram"): string {
  const title = diagramTitleFromName(name);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtmlAttr(title)}</title><style>html,body{margin:0;width:100%;height:100%;color-scheme:light dark;background:Canvas}iframe{display:block;border:0;width:100%;height:100%;color-scheme:light dark;background:Canvas}</style></head><body><iframe title="${escapeHtmlAttr(title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtmlAttr(html)}"></iframe></body></html>`;
}
