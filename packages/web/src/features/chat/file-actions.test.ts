import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "@moco/protocol";
import { downloadFileAsset, fileAssetUrl, openFileInDefaultApp, openHtmlInBrowser, prepareHtmlPreview, readFileAsset } from "./file-actions";

const api = vi.hoisted(() => ({ ensureMediaSession: vi.fn(), getAuthTokenFromUrl: vi.fn(() => "qa-session") }));
vi.mock("../../moco-api", () => api);
const asset: ChatAttachment = { id: "att_pub_0123456789abcdef0123456789abcdef01234567", kind: "file", name: "方案.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 3, url: "https://untrusted.example/document" };

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("chat file actions", () => {
  it("reads only the local asset endpoint and keeps authentication out of URLs", async () => {
    const request = vi.fn().mockResolvedValue(new Response("file"));
    vi.stubGlobal("fetch", request);
    await readFileAsset(asset.id);
    expect(request).toHaveBeenCalledWith(`/api/uploads/${asset.id}`, expect.objectContaining({ headers: { Authorization: "Bearer qa-session" }, credentials: "same-origin", redirect: "error" }));
    for (const id of ["../settings", "a?token=x", "a/b", "https://host/a"]) expect(() => fileAssetUrl(id)).toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it("checks an authenticated preview before loading an iframe", async () => {
    api.ensureMediaSession.mockResolvedValue({});
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", request);
    await expect(prepareHtmlPreview(asset.id)).resolves.toBe(`/api/uploads/${asset.id}/preview`);
    expect(api.ensureMediaSession).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(`/api/uploads/${asset.id}/preview`, expect.objectContaining({ method: "HEAD" }));
  });

  it("surfaces permission and missing-file errors rather than downloading an error page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "无权读取此文件" }), { status: 403 })));
    await expect(readFileAsset(asset.id)).rejects.toThrow("无权读取此文件");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(prepareHtmlPreview(asset.id)).rejects.toThrow("404");
  });

  it("uses the native save dialog and respects cancellation without a second browser download", async () => {
    const saveFile = vi.fn().mockResolvedValue("canceled");
    const request = vi.fn();
    vi.stubGlobal("window", { mocoDesktop: { saveFile } });
    vi.stubGlobal("fetch", request);
    await downloadFileAsset(asset);
    expect(saveFile).toHaveBeenCalledWith(asset.id);
    expect(request).not.toHaveBeenCalled();
  });

  it("saves browser downloads with the actual filename and releases the blob URL", async () => {
    vi.useFakeTimers();
    const anchor = { href: "", download: "", click: vi.fn() };
    const createObjectURL = vi.fn((_blob: Blob) => "blob:qa-download");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ppt")));
    await downloadFileAsset(asset);
    expect(anchor.download).toBe("方案.pptx");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:qa-download");
  });

  it("reserves a browser tab during the gesture, severs its opener, then navigates to the isolated preview", async () => {
    const tab = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => tab);
    api.ensureMediaSession.mockResolvedValue({});
    vi.stubGlobal("window", { open });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
    const opening = openHtmlInBrowser(asset.id);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    await opening;
    expect(tab.location.replace).toHaveBeenCalledWith(`/api/uploads/${asset.id}/view`);
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("closes the reserved tab when preparation fails and reports popup blocking", async () => {
    const tab = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => tab });
    api.ensureMediaSession.mockRejectedValueOnce(new Error("会话已失效"));
    await expect(openHtmlInBrowser(asset.id)).rejects.toThrow("会话已失效");
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.replace).not.toHaveBeenCalled();
    vi.stubGlobal("window", { open: () => null });
    await expect(openHtmlInBrowser(asset.id)).rejects.toThrow("弹出窗口");
  });

  it("opens desktop HTML by resource ID without exposing a URL or token", async () => {
    const openFile = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { mocoDesktop: { openFile } });
    await openHtmlInBrowser(asset.id);
    expect(openFile).toHaveBeenCalledWith(asset.id, "browser");
    expect(api.ensureMediaSession).not.toHaveBeenCalled();
  });

  it("opens every desktop file through the default application instead of the browser target", async () => {
    const openFile = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { mocoDesktop: { openFile } });
    await openFileInDefaultApp(asset.id);
    expect(openFile).toHaveBeenCalledWith(asset.id, "default");
    expect(api.ensureMediaSession).not.toHaveBeenCalled();
    await expect(openFileInDefaultApp("../invalid")).rejects.toThrow("文件编号无效");
    expect(openFile).toHaveBeenCalledOnce();
  });

  it("does not pretend a browser can open a local default application", async () => {
    vi.stubGlobal("window", {});
    await expect(openFileInDefaultApp(asset.id)).rejects.toThrow("请下载文件");
  });
});
