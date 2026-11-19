import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilitiesWorkspaceSnapshot, ExtensionRecord, ExtensionWorkspaceSnapshot } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { CapabilitiesModule } from "./capabilities-module";
import { OtherExtensionsModule, extensionVersionLabel } from "./other-extensions-module";

const extension: ExtensionRecord = {
  id: "billion-context", name: "Billion Context 上下文压缩", sourceUrl: "https://github.com/ranxianglei/billion-context",
  packageName: "acp-kernel", availableVersion: "0.0.101", adapterVersion: "1", enabled: false,
  status: "not_installed", revision: 1, updatedAt: 1,
};
const workspace = (item = extension): ExtensionWorkspaceSnapshot => ({ revision: item.revision, items: [item], jobs: [] });
function render(item = extension, connected = true, snapshot = workspace(item)) {
  return renderToStaticMarkup(<OtherExtensionsModule snapshot={snapshot} connected={connected} onRequest={vi.fn()} onRefresh={vi.fn()} />);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("other extensions settings", () => {
  it("keeps the uninstalled extension off and identifies the installable version", () => {
    const html = render();
    expect(html).toContain(extension.name);
    expect(html).toContain("可安装 acp-kernel 0.0.101");
    expect(html).toContain("未安装");
    expect(html).toContain(`aria-label="安装${extension.name}"`);
    expect(html).toMatch(/<table\b(?=[^>]*aria-label="其他扩展列表")/);
    expect(html.match(/role="columnheader"/g)).toHaveLength(5);
    const toggle = html.match(/<input\b(?=[^>]*role="switch")[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('disabled=""');
    expect(toggle).not.toContain('checked=""');
    expect(html).not.toContain(`aria-label="删除${extension.name}"`);
  });

  it("uses the actual installed version and does not present the available update as installed", () => {
    const installed = { ...extension, installedVersion: "0.0.99", status: "stopped" as const };
    expect(extensionVersionLabel(installed)).toBe("acp-kernel 0.0.99");
    const html = render(installed);
    expect(html).toContain("acp-kernel 0.0.99");
    expect(html).not.toContain("0.0.101");
    expect(html).toContain("已停止");
    expect(html).toContain(`aria-label="删除${extension.name}"`);
    expect(html).not.toContain(`aria-label="安装${extension.name}"`);
    const toggle = html.match(/<input\b(?=[^>]*role="switch")[^>]*>/)?.[0];
    expect(toggle).not.toContain('disabled=""');
    expect(toggle).not.toContain('checked=""');
  });

  it("exposes explicit stop and delete controls while running", () => {
    const html = render({ ...extension, installedVersion: "0.0.101", enabled: true, status: "running" });
    expect(html).toContain("运行中");
    expect(html).toContain(`aria-label="停止${extension.name}"`);
    expect(html).toContain(`aria-label="删除${extension.name}"`);
    expect(html.match(/<input\b(?=[^>]*role="switch")[^>]*>/)?.[0]).toContain('checked=""');
  });

  it("keeps the committed running state visible during a stop and shows its real stage", () => {
    const stopping: ExtensionRecord = { ...extension, installedVersion: "0.0.101", enabled: true, status: "stopping" };
    const snapshot = workspace(stopping);
    snapshot.jobs.push({ id: "stop-one", clientId: "settings-page", extensionId: extension.id, operation: "stop", status: "running", stage: "等待当前压缩提交", createdAt: 1, updatedAt: 1 });
    const html = render(stopping, true, snapshot);
    expect(html).toContain("停止中");
    expect(html).toContain("等待当前压缩提交");
    expect(html).not.toContain("已停止");
    const toggle = html.match(/<input\b(?=[^>]*role="switch")[^>]*>/)?.[0];
    expect(toggle).toContain('checked=""');
    expect(toggle).toContain('disabled=""');
  });

  it("keeps errors actionable and redacts credential-shaped diagnostics", () => {
    const html = render({ ...extension, status: "error", error: "安装失败 api_key=synthetic-extension-private-value" });
    expect(html).toContain("安装失败");
    expect(html).toContain("异常");
    expect(html).not.toContain("synthetic-extension-private-value");
    expect(html).toContain(`aria-label="安装${extension.name}"`);
    expect(html).toContain(`aria-label="删除${extension.name}"`);
  });

  it("disables mutations offline while retaining the version and status", () => {
    const html = render({ ...extension, installedVersion: "0.0.101", status: "stopped" }, false);
    expect(html).toContain("acp-kernel 0.0.101");
    expect(html).toContain("已停止");
    expect(html.match(/<input\b(?=[^>]*role="switch")[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html).toMatch(/<button\b(?=[^>]*aria-label="删除Billion Context 上下文压缩")(?=[^>]*disabled="")[^>]*>/);
    expect(html).toMatch(/<button\b(?=[^>]*disabled="")[^>]*>添加扩展<\/button>/);
  });

  it("opens the other tab for an extension target without a separate settings assistant", () => {
    const snapshot: CapabilitiesWorkspaceSnapshot = { revision: 1, capabilities: [], connections: [], skills: [], skillRevision: 1, jobs: [], inputs: [], extensions: workspace() };
    const html = renderToStaticMarkup(<CapabilitiesModule snapshot={snapshot} loading={false} error={null} connected envs={[]} target={{ kind: "extension", id: extension.id }} onRequest={vi.fn()} onRefresh={vi.fn()} />);
    expect(html).toContain(">其他");
    expect(html).toContain("其他扩展列表");
    expect(html).toContain("添加扩展");
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("尚未添加能力");
  });
});

describe("extension management requests", () => {
  it("sends revision and command identity to the scoped operation endpoint", async () => {
    const next = workspace({ ...extension, revision: 2, status: "stopping" });
    const fetch = vi.fn(async () => new Response(JSON.stringify(next), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const body = { operation: "stop" as const, expectedRevision: 1, commandId: "stop-once" };
    expect(await kuloRest.manageExtension("extension/id", body)).toEqual(next);
    expect(fetch).toHaveBeenCalledWith("/api/extensions/extension%2Fid/operations", expect.objectContaining({ method: "POST", body: JSON.stringify(body) }));
  });
});
