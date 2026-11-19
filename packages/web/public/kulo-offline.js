/* Cache only the static application shell; API responses and authentication stay on the network. */
const SHELL_PREFIX = "kulo-offline-shell-v1-";
const ROOT_URL = new URL("/", self.location.origin).href;
const READY_URL = new URL("/.kulo-offline-ready", self.location.origin).href;
const KEEP_SHELLS = 2;
const pendingShells = new Set();
const preparations = new Map();
class InvalidShellError extends Error {}
let latestCommit = 0;

function diagnostic(message, error) {
  console.warn(`[KuloOffline] ${message}`, error);
}

function assetUrl(value) {
  const url = new URL(value, ROOT_URL);
  return url.origin === self.location.origin && !url.search && !url.hash &&
    /^\/assets\/[A-Za-z0-9._-]+\.(?:js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|mp3|wav|m4a|mp4|webm)$/i.test(url.pathname) ? url.href : undefined;
}

async function publicFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(new Request(url, { credentials: "omit", redirect: "error", cache: "no-cache", signal: controller.signal }));
  } finally {
    clearTimeout(timeout);
  }
}

async function completeShells() {
  const names = (await caches.keys()).filter((name) => name.startsWith(SHELL_PREFIX));
  const shells = await Promise.all(names.map(async (name) => {
    const marker = await caches.match(READY_URL, { cacheName: name });
    if (!marker) return undefined;
    const value = await marker.json();
    if (typeof value.committedAt !== "number") throw new Error("Invalid offline shell marker");
    return { name, committedAt: value.committedAt };
  }));
  return shells.filter(Boolean).sort((first, second) => second.committedAt - first.committedAt);
}

async function cachedRoot() {
  for (const shell of await completeShells()) {
    const response = await caches.match(ROOT_URL, { cacheName: shell.name });
    if (response) return response;
  }
  return undefined;
}

async function pruneShells() {
  const keep = new Set((await completeShells()).slice(0, KEEP_SHELLS).map((shell) => shell.name));
  for (const name of await caches.keys()) {
    if (name.startsWith(SHELL_PREFIX) && !keep.has(name) && !pendingShells.has(name)) await caches.delete(name);
  }
}

function entryAssets(html) {
  if (!/<div\b[^>]*\bid=["']root["']/i.test(html)) throw new InvalidShellError("Response is not the Kulo application shell");
  const urls = new Set();
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attributes = match[2];
    if (match[1].toLowerCase() === "link" && !/\brel=["'](?:stylesheet|modulepreload)["']/i.test(attributes)) continue;
    const source = attributes.match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
    if (!source) continue;
    const url = assetUrl(source);
    if (!url || !/\.(?:js|css)$/.test(new URL(url).pathname)) throw new InvalidShellError("Application entry is not a public build asset");
    urls.add(url);
  }
  if (![...urls].some((url) => url.endsWith(".js"))) throw new InvalidShellError("Application shell has no JavaScript entry");
  return [...urls];
}

async function prepareShell(response) {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new InvalidShellError("Application shell is unavailable");
  const html = await response.text();
  const entries = entryAssets(html);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
  const name = SHELL_PREFIX + [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const existing = preparations.get(name);
  if (existing) return existing;
  const prepare = (async () => {
    pendingShells.add(name);
    const wasComplete = Boolean(await caches.match(READY_URL, { cacheName: name }));
    try {
      const cache = await caches.open(name);
      await Promise.all(entries.map(async (url) => {
        if (await cache.match(url)) return;
        const asset = await publicFetch(url);
        if (!asset.ok || asset.headers.get("content-type")?.includes("text/html")) throw new Error("Application entry asset is unavailable");
        await cache.put(url, asset);
      }));
      const headers = new Headers(response.headers);
      for (const key of ["set-cookie", "set-cookie2", "authorization", "proxy-authorization", "www-authenticate", "proxy-authenticate", "authentication-info"]) headers.delete(key);
      await cache.put(ROOT_URL, new Response(html, { headers }));
      latestCommit = Math.max(Date.now(), latestCommit + 1);
      // Readers consider the version usable only after every entry and its HTML have committed.
      await cache.put(READY_URL, new Response(JSON.stringify({ committedAt: latestCommit }), { headers: { "Content-Type": "application/json" } }));
      await pruneShells();
    } catch (error) {
      if (!wasComplete) await caches.delete(name);
      throw error;
    } finally {
      pendingShells.delete(name);
    }
  })();
  preparations.set(name, prepare);
  try { await prepare; } finally { preparations.delete(name); }
}

async function rootNavigation() {
  let response;
  try {
    response = await publicFetch(ROOT_URL);
  } catch (error) {
    const cached = await cachedRoot();
    if (cached) return cached;
    throw error;
  }
  if (response.status >= 500) {
    const cached = await cachedRoot();
    if (cached) return cached;
  }
  if (response.ok) {
    try {
      await prepareShell(response.clone());
    } catch (error) {
      diagnostic("Unable to update the offline shell; keeping the previous complete version", error);
      if (error instanceof InvalidShellError) return response;
      const cached = await cachedRoot();
      if (cached) return cached;
    }
  }
  return response;
}

async function buildAsset(url) {
  const shells = await completeShells();
  for (const shell of shells) {
    const cached = await caches.match(url, { cacheName: shell.name });
    if (cached) return cached;
  }
  const response = await publicFetch(url);
  if (response.ok && !response.headers.get("content-type")?.includes("text/html") && shells[0]) {
    try {
      const cache = await caches.open(shells[0].name);
      await cache.put(url, response.clone());
    } catch (error) {
      diagnostic("Unable to cache a public build asset", error);
    }
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try { await prepareShell(await publicFetch(ROOT_URL)); }
    catch (error) { diagnostic("Unable to prepare the offline shell", error); throw error; }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try { await pruneShells(); }
    catch (error) { diagnostic("Unable to prune old offline shells", error); }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
    event.respondWith(rootNavigation());
  } else if (assetUrl(url.href)) {
    event.respondWith(buildAsset(url.href));
  }
});
