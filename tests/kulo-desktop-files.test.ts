import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HTML_ARTIFACT_BROWSER_CSP, HTML_DIAGRAM_BROWSER_CSP } from "@kulo/protocol";
import { createDesktopFileActions, isTrustedFileActionSender, type DesktopFileConnection } from "../packages/desktop/src/file-actions.js";
import { shouldAuthorizeDesktopRequest } from "../packages/desktop/src/desktop-config.js";

const directories: string[] = [];
const actions: ReturnType<typeof createDesktopFileActions>[] = [];
const id = "att_pub_0123456789012345678901234567890123456789";

async function fixture(name = "季度计划.pptx", mimeType = "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kulo desktop files "));
  directories.push(directory);
  let connection: DesktopFileConnection | undefined = { url: "http://127.0.0.1:12345", token: "private-desktop-credential" };
  const bytes = Buffer.from(name.endsWith(".html") ? '<h1>报告</h1><button id="run" onclick="this.textContent=2">1</button>' : "presentation bytes");
  const metadata = { id, name, mimeType, size: bytes.length, kind: "file" };
  const request = vi.fn<typeof fetch>(async (url) => new URL(String(url)).pathname.endsWith("/meta")
    ? new Response(JSON.stringify({ attachment: metadata }), { headers: { "content-type": "application/json" } })
    : new Response(bytes, { headers: { "content-length": String(bytes.length) } }));
  const openPath = vi.fn<(file: string) => Promise<string>>(async () => "");
  const openExternal = vi.fn<(url: string) => Promise<void>>(async () => {});
  const chooseSavePath = vi.fn<(name: string) => Promise<string | undefined>>(async () => undefined);
  const service = createDesktopFileActions({ dataDir: directory, connection: () => connection, fetch: request, openPath, openExternal, chooseSavePath });
  actions.push(service);
  return { directory, bytes, metadata, request, openPath, openExternal, chooseSavePath, service, changeConnection: (value?: DesktopFileConnection) => { connection = value; } };
}

afterEach(async () => {
  await Promise.all(actions.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("desktop chat document actions", () => {
  it("retrieves a snapshot from the runtime and opens a private local PPT copy with the default application", async () => {
    const f = await fixture();
    await f.service.openFile(id, "default");
    expect(f.request.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:12345/api/uploads/${id}/meta`, `http://127.0.0.1:12345/api/uploads/${id}`,
    ]);
    for (const [, init] of f.request.mock.calls) {
      expect(init?.headers).toEqual({ Authorization: "Bearer private-desktop-credential" });
      expect(init?.redirect).toBe("error");
    }
    const file = f.openPath.mock.calls[0]![0];
    expect(path.basename(file)).toBe("季度计划.pptx");
    expect(file.startsWith(path.join(f.directory, "artifacts") + path.sep)).toBe(true);
    expect(await fs.readFile(file)).toEqual(f.bytes);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(f.openExternal).not.toHaveBeenCalled();
    await fs.writeFile(file, "user's edits");
    await f.service.openFile(id, "default");
    expect(f.openPath.mock.calls[1]![0]).not.toBe(file);
    expect(await fs.readFile(file, "utf8")).toBe("user's edits");
    expect(await fs.readFile(f.openPath.mock.calls[1]![0])).toEqual(f.bytes);
  });

  it("saves the original file atomically and treats a canceled download as cancellation", async () => {
    const f = await fixture();
    await expect(f.service.saveFile(id)).resolves.toBe("canceled");
    expect(await fs.readdir(f.directory)).toEqual([]);
    const target = path.join(f.directory, "saved.pptx");
    await fs.writeFile(target, "old content");
    f.chooseSavePath.mockResolvedValue(target);
    await expect(f.service.saveFile(id)).resolves.toBe("saved");
    expect(await fs.readFile(target)).toEqual(f.bytes);
    expect(await fs.readdir(f.directory)).toEqual(["saved.pptx"]);
    expect(f.openPath).not.toHaveBeenCalled();
  });

  it("keeps symlink save targets and cache redirects outside the file action boundary", async () => {
    const f = await fixture();
    const target = path.join(f.directory, "original");
    const link = path.join(f.directory, "saved.pptx");
    await fs.writeFile(target, "preserved");
    await fs.symlink(target, link);
    f.chooseSavePath.mockResolvedValue(link);
    await expect(f.service.saveFile(id)).rejects.toThrow("普通文件");
    expect(await fs.readFile(target, "utf8")).toBe("preserved");
    await fs.symlink(f.directory, path.join(f.directory, "artifacts"));
    await expect(f.service.openFile(id, "default")).rejects.toThrow("缓存目录");
    expect(f.openPath).not.toHaveBeenCalled();
  });

  it("opens interactive HTML at an isolated read-only browser URL without forwarding desktop authentication", async () => {
    const f = await fixture("交互报告.html", "text/html");
    await f.service.openFile(id, "browser");
    const url = f.openExternal.mock.calls[0]![0];
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect(new URL(url).port).not.toBe("12345");
    expect(url).not.toContain("private-desktop-credential");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(HTML_ARTIFACT_BROWSER_CSP);
    const html = await response.text();
    expect(html).toContain('<iframe ');
    expect(html).toContain('sandbox="allow-scripts allow-forms"');
    expect(html).toContain('srcdoc="');
    expect(html).toContain('this.textContent=2');
    expect(html).not.toContain('<button ');
    expect(html).not.toContain("private-desktop-credential");
    const unavailable = await fetch(new URL("/api/settings", url));
    expect(await unavailable.text()).toBe("");
    expect(unavailable.status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url, { headers: { Host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.once("error", reject); request.end();
    });
    expect(wrongHost).toBe(404);
    expect(f.openPath).not.toHaveBeenCalled();
    await f.service.close();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("uses pinned HTML_DIAGRAM_BROWSER_CSP without allow-forms when opening diagram artifacts in a browser", async () => {
    const f = await fixture("系统架构图.html", "text/html");
    (f.metadata as { presentation?: string }).presentation = "diagram";
    await f.service.openFile(id, "browser");
    const url = f.openExternal.mock.calls[0]![0];
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(HTML_DIAGRAM_BROWSER_CSP);
    const html = await response.text();
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-forms");
    expect(html).toContain("color-scheme:light dark");
  });

  it("rejects paths and executable documents instead of giving the renderer a generic native launcher", async () => {
    const f = await fixture("installer.command", "text/plain");
    for (const value of ["/etc/passwd", "../report.pptx", "https://example.com/file", { id }]) {
      await expect(f.service.openFile(value, "default")).rejects.toThrow("文件标识");
    }
    expect(f.request).not.toHaveBeenCalled();
    await expect(f.service.openFile(id, "shell")).rejects.toThrow("打开方式");
    await expect(f.service.openFile(id, "default")).rejects.toThrow("先下载");
    expect(f.openPath).not.toHaveBeenCalled();
    const document = await fixture();
    await expect(document.service.openFile(id, "browser")).rejects.toThrow("先下载");
    expect(document.openExternal).not.toHaveBeenCalled();
  });

  it("surfaces missing default applications, changed files and disconnected runtimes", async () => {
    const f = await fixture();
    f.openPath.mockResolvedValue("No application is registered");
    await expect(f.service.openFile(id, "default")).rejects.toThrow("默认应用");
    f.openPath.mockClear();
    f.metadata.size++;
    await expect(f.service.openFile(id, "default")).rejects.toThrow("文件已变化");
    expect(f.openPath).not.toHaveBeenCalled();
    f.changeConnection();
    await expect(f.service.openFile(id, "default")).rejects.toThrow("后台尚未就绪");
  });

  it("does not launch a stale request after runtime replacement and validates returned metadata", async () => {
    const f = await fixture();
    f.request.mockImplementationOnce(async () => {
      f.changeConnection({ url: "http://127.0.0.1:12346", token: "replacement" });
      return new Response(JSON.stringify({ attachment: f.metadata }));
    });
    await expect(f.service.openFile(id, "default")).rejects.toThrow("后台连接已变化");
    expect(f.openPath).not.toHaveBeenCalled();
    f.metadata.id = "att_pub_wrong_file";
    await expect(f.service.openFile(id, "default")).rejects.toThrow("文件信息无效");
    f.metadata.id = id;
    f.metadata.size = 26 * 1024 * 1024;
    await expect(f.service.openFile(id, "default")).rejects.toThrow("文件信息无效");
  });
});

describe("desktop artifact frame boundaries", () => {
  it("only grants native actions to the current trusted main frame", () => {
    const origin = "http://127.0.0.1:12345";
    const mainFrame = { origin };
    const webContents = { mainFrame, isDestroyed: () => false };
    const owner = { webContents, isDestroyed: () => false };
    expect(isTrustedFileActionSender({ sender: webContents, senderFrame: mainFrame }, owner, origin)).toBe(true);
    for (const sender of [
      { sender: webContents, senderFrame: { origin } },
      { sender: webContents, senderFrame: { origin: "null" } },
      { sender: webContents, senderFrame: null },
      { sender: {}, senderFrame: mainFrame },
    ]) expect(isTrustedFileActionSender(sender, owner, origin)).toBe(false);
    expect(isTrustedFileActionSender({ sender: webContents, senderFrame: mainFrame }, owner, "https://other.example")).toBe(false);
  });

  it("does not attach desktop credentials to a sandbox's arbitrary API requests", () => {
    const origin = "http://127.0.0.1:12345";
    const mainFrame = { origin };
    const childFrame = { origin: "null" };
    const request = { webContentsId: 7, frame: mainFrame, url: `${origin}/api/settings`, resourceType: "xhr", method: "GET" };
    expect(shouldAuthorizeDesktopRequest(request, origin, 7, mainFrame)).toBe(true);
    expect(shouldAuthorizeDesktopRequest({ ...request, frame: childFrame }, origin, 7, mainFrame)).toBe(false);
    expect(shouldAuthorizeDesktopRequest({ ...request, frame: { origin } }, origin, 7, mainFrame)).toBe(false);
    expect(shouldAuthorizeDesktopRequest({ ...request, frame: null }, origin, 7, mainFrame)).toBe(false);
    const preview = { ...request, frame: childFrame, resourceType: "subFrame", url: `${origin}/api/uploads/${id}/preview` };
    expect(shouldAuthorizeDesktopRequest(preview, origin, 7, mainFrame)).toBe(true);
    expect(shouldAuthorizeDesktopRequest({ ...preview, url: `${preview.url}?redirect=elsewhere` }, origin, 7, mainFrame)).toBe(false);
    expect(shouldAuthorizeDesktopRequest({ ...preview, method: "POST" }, origin, 7, mainFrame)).toBe(false);
    const websocket = { ...request, frame: null, resourceType: "webSocket", initiatorOrigin: origin, url: "ws://127.0.0.1:12345/ws/client" };
    expect(shouldAuthorizeDesktopRequest(websocket, origin, 7, mainFrame)).toBe(true);
    expect(shouldAuthorizeDesktopRequest({ ...websocket, initiatorOrigin: "null" }, origin, 7, mainFrame)).toBe(false);
  });
});
