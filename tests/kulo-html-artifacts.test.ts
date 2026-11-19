import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { HTML_ARTIFACT_BROWSER_CSP, HTML_ARTIFACT_CSP, htmlArtifactDocument } from "@kulo/protocol";
import { bundleHtmlArtifact } from "../packages/hub/src/html-bundle.js";
import { publishExecutionAsset } from "../packages/hub/src/content-assets.js";
import { createMediaHttpHandler } from "../packages/hub/src/media-http.js";
import { KuloUploadStore } from "../packages/hub/src/uploads.js";

const { parseHTML } = createRequire(new URL("../packages/hub/package.json", import.meta.url))("linkedom");

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

function directory() {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-html-artifacts-")));
  cleanup.push(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function decode(url: string) { return Buffer.from(url.slice(url.indexOf(",") + 1).split("#", 1)[0]!, "base64").toString("utf8"); }

function fixture() {
  const root = directory();
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const uploads = new KuloUploadStore(path.join(root, "uploads"));
  const env = new NodeExecutionEnv({ cwd: workspace });
  const options = { allowedRoot: workspace, protectedPaths: [] as string[], trustedSandbox: true, ownerId: "owner", scopeId: "conversation:one" };
  const api = { env: env as ExecutionEnv, conversationId: 12, callId: "html-one" };
  const publish = () => publishExecutionAsset({ path: "index.html" }, api as Parameters<typeof publishExecutionAsset>[1], BACKGROUND_CONTEXT, uploads, options);
  return { root, workspace, env, uploads, options, api, publish };
}

describe("portable HTML artifact delivery", () => {
  it("preserves a self-contained interactive document byte for byte", async () => {
    const source = Buffer.from('<!doctype html>\n<html><style>body{background:url(data:image/png;base64,AAAA)}</style><button onclick="this.textContent=Number(this.textContent)+1">0</button><script type="module">document.body.dataset.ready="yes";</script></html>\n');
    const read = vi.fn();
    expect(await bundleHtmlArtifact(source, "/workspace/index.html", read)).toBe(source);
    expect(read).not.toHaveBeenCalled();
  });

  it("bundles scripts, nested CSS, fonts, image candidates and posters into one document", async () => {
    const files = new Map<string, Buffer>([
      ["/work/scripts/calculator.js", Buffer.from('document.querySelector("button").onclick=()=>document.querySelector("output").value="42";')],
      ["/work/styles/main.css", Buffer.from('@import "nested.css" screen;@font-face{font-family:report;src:url("../fonts/report.woff2")}body{background:url(../images/bg.png)}')],
      ["/work/styles/nested.css", Buffer.from('h1{color:green}')],
      ["/work/fonts/report.woff2", Buffer.from("font data")],
      ["/work/images/bg.png", Buffer.from("background image")],
      ["/work/images/chart.png", Buffer.from("chart image")],
      ["/work/images/chart-2x.png", Buffer.from("large chart image")],
    ]);
    const read = vi.fn(async (file: string) => { if (!files.has(file)) throw new Error(`Missing ${file}`); return files.get(file)!; });
    const source = Buffer.from('<!doctype html><html><head><link rel="stylesheet" href="styles/main.css"></head><body><button>计算</button><output></output><img src="images/chart.png" srcset="images/chart.png 1x, images/chart-2x.png 2x"><video poster="images/chart.png"></video><script src="scripts/calculator.js"></script></body></html>');
    const result = await bundleHtmlArtifact(source, "/work/index.html", read);
    const { document } = parseHTML(result.toString());
    expect(decode(document.querySelector("script")!.getAttribute("src")!)).toContain('value="42"');
    const css = decode(document.querySelector("link")!.getAttribute("href")!);
    expect(css).toContain("font/woff2;base64");
    expect(css).toContain("image/png;base64");
    expect(css).toContain("screen;");
    const imported = /@import url\("([^"]+)"\)/.exec(css)![1]!;
    expect(decode(imported)).toBe("h1{color:green}");
    expect(document.querySelector("img")!.getAttribute("srcset")).toMatch(/^data:image\/png;base64,\S+ 1x, data:image\/png;base64,\S+ 2x$/);
    expect(decode(document.querySelector("video")!.getAttribute("poster")!)).toBe("chart image");
    expect(read).toHaveBeenCalledTimes(files.size);
  });

  it("rejects local module imports and CSS cycles", async () => {
    const read = vi.fn(async () => Buffer.from('import /* module dependency */ { chart } from "./chart.js";'));
    await expect(bundleHtmlArtifact(Buffer.from('<script type="module" src="main.js"></script>'), "/work/index.html", read)).rejects.toThrow("包含导入");
    await expect(bundleHtmlArtifact(Buffer.from('<script type="module">import("./chart.js")</script>'), "/work/index.html", read)).rejects.toThrow("包含导入");
    const cyclic = vi.fn(async () => Buffer.from('@import "main.css";'));
    await expect(bundleHtmlArtifact(Buffer.from('<link rel="stylesheet" href="main.css">'), "/work/index.html", cyclic)).rejects.toThrow("依赖循环");
  });

  it.each([
    '<script src="https://cdn.example/chart.js"></script>',
    '<script src="//cdn.example/chart.js"></script>',
    '<link rel="stylesheet" href="https://cdn.example/chart.css">',
    '<style>@import "https://cdn.example/chart.css";</style>',
    '<style>@import url(//cdn.example/chart.css);</style>',
    '<style>@font-face{font-family:report;src:url(https://cdn.example/font.woff2)}</style>',
    '<img src="https://cdn.example/image.png">',
    '<img srcset="data:image/png;base64,AAAA 1x, https://cdn.example/image.png 2x">',
    '<video src="https://cdn.example/video.mp4"></video>',
    '<video poster="https://cdn.example/image.png"></video>',
    '<audio src="//cdn.example/audio.wav"></audio>',
    '<img src="blob:https://kulo.example/temporary">',
  ])("rejects nonportable required resources without fetching or exposing their address: %s", async (source) => {
    const read = vi.fn();
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(bundleHtmlArtifact(Buffer.from(source), "/work/index.html", read)).rejects.toMatchObject({ message: "HTML 依赖外部或临时资源，请将脚本、样式和媒体嵌入后重新生成。" });
    expect(read).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps outbound content anchors, data resources and fragments portable", async () => {
    const source = Buffer.from('<html><a href="https://example.com/report">来源</a><img src="data:image/png;base64,AAAA"><svg><image href="#local"/></svg><script src="data:text/javascript;base64,Y29uc3QgeD0xOw=="></script></html>');
    const read = vi.fn();
    expect(await bundleHtmlArtifact(source, "/work/index.html", read)).toBe(source);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not treat CSS comments or content strings as external dependencies", async () => {
    const source = Buffer.from('<html><style>/* @import "https://example.com/unused.css"; background:url(https://example.com/unused.png) */p:after{content:"url(https://example.com/described.png)"}</style></html>');
    const read = vi.fn();
    expect(await bundleHtmlArtifact(source, "/work/index.html", read)).toBe(source);
    expect(read).not.toHaveBeenCalled();
  });

  it("accepts import words in classic script strings, comments and property methods", async () => {
    const script = 'const label = "import data"; /* import("./comment.js") */\n// import x from "./comment.js";\nconst actions = { import(value) { return value; } }; actions.import(label);';
    const source = Buffer.from('<html><script src="main.js"></script></html>');
    const result = await bundleHtmlArtifact(source, "/work/index.html", async () => Buffer.from(script));
    const { document } = parseHTML(result.toString());
    expect(decode(document.querySelector("script")!.getAttribute("src")!)).toBe(script);
    const inline = Buffer.from(`<script type="module">${script}</script>`);
    expect(await bundleHtmlArtifact(inline, "/work/index.html", vi.fn())).toBe(inline);
  });

  it.each([
    'export { x } from "./x.js";',
    'export * from "./x.js";',
    'export * as values from "./x.js";',
    'const load = () => import /* dependency */ ("./x.js");',
    'const name = "./x.js"; const template = `${import(name)}`;',
  ])("rejects actual module dependencies in %s", async (script) => {
    await expect(bundleHtmlArtifact(Buffer.from(`<script type="module">${script}</script>`), "/work/index.html", vi.fn())).rejects.toThrow("包含导入");
  });

  it("accepts an independent module with exports and an import-like regular expression", async () => {
    const source = Buffer.from('<script type="module">const pattern = /import(\\w+)/; export const value = pattern.test("imported");</script>');
    expect(await bundleHtmlArtifact(source, "/work/index.html", vi.fn())).toBe(source);
  });

  it("reads every dependency through the execution environment and saves a stable snapshot", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.workspace, "index.html"), '<!doctype html><html><script src="main.js"></script><img src="chart.png"></html>');
    fs.writeFileSync(path.join(f.workspace, "main.js"), "Hub bytes must not be delivered");
    fs.writeFileSync(path.join(f.workspace, "chart.png"), "Hub image must not be delivered");
    const originalOpen = f.env.openBinaryReader.bind(f.env);
    const remotelyRead: string[] = [];
    vi.spyOn(f.env, "openBinaryReader").mockImplementation(async (value, options, context) => {
      remotelyRead.push(value);
      if (value.endsWith("index.html")) return originalOpen(value, options, context);
      const bytes = Buffer.from(value.endsWith("main.js") ? 'document.body.dataset.ready="remote";' : "remote image bytes");
      const info = { kind: "file" as const, path: value, name: path.basename(value), size: bytes.length, mtimeMs: 10 };
      return { ok: true as const, value: { info: async () => ({ ok: true as const, value: info }), read: async (offset: number, length: number) => ({ ok: true as const, value: bytes.subarray(offset, offset + length) }), close: async () => {} } as never };
    });
    const asset = await f.publish();
    const { document } = parseHTML(f.uploads.readUploadBytes(f.uploads.getUpload(asset.id)!).toString());
    expect(decode(document.querySelector("script")!.getAttribute("src")!)).toContain('ready="remote"');
    expect(decode(document.querySelector("img")!.getAttribute("src")!)).toBe("remote image bytes");
    expect(remotelyRead).toHaveLength(3);
    expect(f.uploads.getUpload(asset.id)!.record.referenceScopes).toEqual(["conversation:one"]);
    fs.writeFileSync(path.join(f.workspace, "index.html"), "changed original");
    expect((await f.publish()).id).toBe(asset.id);
    expect(remotelyRead).toHaveLength(4);
  });

  it.each(["../private.png", "%2e%2e/private.png", ".env", "credentials.json", "private.key", "linked.png", "protected/chart.png", "missing.png"])("rejects unsafe or missing dependency %s without publishing partial output", async (reference) => {
    const f = fixture();
    fs.writeFileSync(path.join(f.workspace, "index.html"), `<html><img src="${reference}"></html>`);
    fs.writeFileSync(path.join(f.root, "private.png"), "private");
    fs.writeFileSync(path.join(f.workspace, ".env"), "private");
    fs.writeFileSync(path.join(f.workspace, "credentials.json"), "private");
    fs.writeFileSync(path.join(f.workspace, "private.key"), "private");
    fs.symlinkSync(path.join(f.root, "private.png"), path.join(f.workspace, "linked.png"));
    fs.mkdirSync(path.join(f.workspace, "protected"));
    fs.writeFileSync(path.join(f.workspace, "protected/chart.png"), "private");
    f.options.protectedPaths = [path.join(f.workspace, "protected")];
    await expect(f.publish()).rejects.toBeDefined();
    expect(fs.readdirSync(f.uploads.dir)).toEqual([]);
  });

  it("limits dependency counts and closes a cancelled dependency read", async () => {
    const repeated = Array.from({ length: 65 }, (_, index) => `<img src="image-${index}.png">`).join("");
    await expect(bundleHtmlArtifact(Buffer.from(repeated), "/work/index.html", async () => Buffer.from("pixel"))).rejects.toThrow("64 个本地依赖");
    const f = fixture();
    fs.writeFileSync(path.join(f.workspace, "index.html"), '<html><img src="chart.png"></html>');
    fs.writeFileSync(path.join(f.workspace, "chart.png"), "pixel");
    const controller = new AbortController();
    const originalOpen = f.env.openBinaryReader.bind(f.env);
    const closed = vi.fn();
    vi.spyOn(f.env, "openBinaryReader").mockImplementation(async (value, options, context) => {
      const result = await originalOpen(value, options, context);
      if (!result.ok || !value.endsWith("chart.png")) return result;
      const reader = result.value;
      return { ok: true as const, value: { ...reader, info: reader.info.bind(reader), read: async (offset: number, length: number, ctx: typeof context) => { const value = await reader.read(offset, length, ctx); controller.abort(); return value; }, close: async (ctx: typeof context) => { closed(); await reader.close(ctx); } } };
    });
    await expect(publishExecutionAsset({ path: "index.html" }, f.api as Parameters<typeof publishExecutionAsset>[1], withAbortSignal(controller.signal, BACKGROUND_CONTEXT), f.uploads, f.options)).rejects.toMatchObject({ status: 499 });
    expect(closed).toHaveBeenCalledOnce();
    expect(fs.readdirSync(f.uploads.dir)).toEqual([]);
  });

  it("rejects oversized bundled dependencies before persisting an HTML snapshot", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.workspace, "index.html"), '<html><img src="large.png"></html>');
    fs.closeSync(fs.openSync(path.join(f.workspace, "large.png"), "w"));
    fs.truncateSync(path.join(f.workspace, "large.png"), 25 * 1024 * 1024);
    const open = vi.spyOn(f.env, "openBinaryReader");
    await expect(f.publish()).rejects.toMatchObject({ status: 413 });
    expect(fs.readdirSync(f.uploads.dir)).toEqual([]);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("isolated HTML preview HTTP", () => {
  async function serverFixture() {
    const uploads = new KuloUploadStore(directory());
    const active = { owner: true };
    const handler = createMediaHttpHandler({
      uploads,
      authenticate: (req) => req.headers.authorization === "Bearer owner" ? "owner" : req.headers.authorization === "Bearer peer" ? "peer" : undefined,
      canReadScope: (principal, scope) => principal === "owner" && scope === "conversation:one",
      isPrincipalActive: (principal) => principal !== "owner" || active.owner,
    });
    const server = http.createServer(async (req, res) => {
      try { if (!await handler(req, res, new URL(req.url!, `http://${req.headers.host}`))) { res.writeHead(404); res.end(); } }
      catch { res.writeHead(500); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { handler.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { uploads, origin, active };
  }

  it("allows document scripts in isolated inline previews and retains normal downloads", async () => {
    const f = await serverFixture();
    const source = '<!doctype html><html><button onclick="this.textContent=42">计算</button><script>document.body.dataset.ready="yes";</script></html>';
    const asset = f.uploads.saveUpload({ name: "计算器.html", bytes: Buffer.from(source), ownerId: "owner" });
    f.uploads.bindAttachments([asset], "conversation:one", "owner");
    const preview = `${f.origin}${asset.url}/preview`;
    expect((await fetch(preview)).status).toBe(401);
    expect((await fetch(preview, { headers: { authorization: "Bearer peer" } })).status).toBe(403);
    const response = await fetch(preview, { headers: { authorization: "Bearer owner" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(HTML_ARTIFACT_CSP);
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms");
    expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const rendered = await response.text();
    expect(rendered).toContain("onclick=\"this.textContent=42\"");
    expect(rendered).toContain("data-kulo-artifact");
    const head = await fetch(preview, { method: "HEAD", headers: { authorization: "Bearer owner" } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(rendered));
    const raw = await fetch(`${f.origin}${asset.url}`, { headers: { authorization: "Bearer owner" } });
    expect(raw.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(await raw.text()).toBe(source);
    const session = await fetch(`${f.origin}/api/media/session`, { method: "POST", headers: { authorization: "Bearer owner", origin: f.origin } });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(preview, { headers: { cookie } })).status).toBe(200);
    f.active.owner = false;
    expect((await fetch(preview, { headers: { cookie } })).status).toBe(401);
  });

  it("wraps browser views in an encoded sandboxed child with the same authorization boundary", async () => {
    const f = await serverFixture();
    const source = '<!doctype html><html><script>window.location="https://example.com/"</script><p title="&quot;>&">内容</p></html>';
    const asset = f.uploads.saveUpload({ name: "浏览器页面.html", bytes: Buffer.from(source), ownerId: "owner" });
    f.uploads.bindAttachments([asset], "conversation:one", "owner");
    const view = `${f.origin}${asset.url}/view`;
    expect((await fetch(view)).status).toBe(401);
    expect((await fetch(view, { headers: { authorization: "Bearer peer" } })).status).toBe(403);
    const response = await fetch(view, { headers: { authorization: "Bearer owner" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(HTML_ARTIFACT_BROWSER_CSP);
    expect(response.headers.get("content-security-policy")).toContain("frame-src about:");
    expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const rendered = await response.text();
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;");
    const { document } = parseHTML(rendered);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    const child = document.querySelector("iframe")!;
    expect(child.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(child.getAttribute("srcdoc")).toBe(htmlArtifactDocument(source));
    expect(child.getAttribute("title")).toBe(asset.name);
    const navigatedPreview = await fetch(`${f.origin}${asset.url}/preview`, { headers: { authorization: "Bearer owner", "sec-fetch-dest": "document" } });
    expect(navigatedPreview.headers.get("content-security-policy")).toBe(HTML_ARTIFACT_BROWSER_CSP);
    expect(await navigatedPreview.text()).toBe(rendered);
    const embeddedPreview = await fetch(`${f.origin}${asset.url}/preview`, { headers: { authorization: "Bearer owner", "sec-fetch-dest": "iframe" } });
    expect(embeddedPreview.headers.get("content-security-policy")).toBe(HTML_ARTIFACT_CSP);
    expect(await embeddedPreview.text()).toBe(htmlArtifactDocument(source));
    const head = await fetch(view, { method: "HEAD", headers: { authorization: "Bearer owner" } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(rendered));
    const session = await fetch(`${f.origin}/api/media/session`, { method: "POST", headers: { authorization: "Bearer owner", origin: f.origin } });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(view, { headers: { cookie } })).status).toBe(200);
    f.active.owner = false;
    expect((await fetch(view, { headers: { cookie } })).status).toBe(401);
  });

  it("does not serve documents with a non-HTML extension or MIME as executable previews", async () => {
    const f = await serverFixture();
    for (const input of [{ name: "report.txt", mimeType: "text/html", bytes: Buffer.from("<html>hello</html>") }, { name: "report.html", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7") }]) {
      const asset = f.uploads.saveUpload({ ...input, ownerId: "owner" });
      expect((await fetch(`${f.origin}${asset.url}/preview`, { headers: { authorization: "Bearer owner" } })).status).toBe(415);
      expect((await fetch(`${f.origin}${asset.url}/view`, { headers: { authorization: "Bearer owner" } })).status).toBe(415);
    }
  });
});
