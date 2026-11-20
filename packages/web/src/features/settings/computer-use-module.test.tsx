import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvNodeDescriptor } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { acceptComputerUseState, ComputerUseModule, type ComputerUseSnapshotState } from "./computer-use-module";

const mac: EnvNodeDescriptor = {
  id: "local",
  name: "本机 Mac",
  kind: "local",
  online: true,
  platform: "darwin",
  arch: "arm64",
  rootDir: "/workspace",
  capabilities: ["agent-browser", "agent-desktop"],
  connectedAt: 1,
  lastSeenAt: 1,
};

const phone: EnvNodeDescriptor = {
  id: "phone-1",
  name: "测试手机",
  kind: "reverse-ws",
  online: true,
  platform: "android",
  arch: "arm64",
  rootDir: "",
  executionKind: "native-device",
  capabilities: ["android-device"],
  connectedAt: 1,
  lastSeenAt: 1,
};

const state: ComputerUseSnapshotState = {
  revision: 3,
  computerUse: { browserEnabled: true, desktopEnabled: false },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ComputerUseModule", () => {
  it("renders independent browser/desktop switches and computer-only device readiness", () => {
    const html = renderToStaticMarkup(
      <ComputerUseModule state={state} envs={[mac, phone]} connected onRefresh={vi.fn()} />,
    );
    expect(html).toContain("浏览器操控");
    expect(html).toContain("桌面操控");
    const browserSwitch = html.match(/<input\b[^>]*aria-label="启用浏览器操控"[^>]*>/)?.[0];
    const desktopSwitch = html.match(/<input\b[^>]*aria-label="启用桌面操控"[^>]*>/)?.[0];
    expect(browserSwitch).toContain("checked");
    expect(browserSwitch).not.toContain("disabled");
    expect(desktopSwitch).not.toContain("checked");
    expect(desktopSwitch).not.toContain("disabled");
    expect(html).toContain("可用");
    expect(html).toContain("已停用");
    expect(html).toContain("本机 Mac");
    expect(html).toContain("macOS");
    expect(html).not.toContain("测试手机");
  });

  it("shows loading state when unloaded and disables switches offline", () => {
    const loading = renderToStaticMarkup(
      <ComputerUseModule state={null} envs={[mac]} connected onRefresh={vi.fn()} />,
    );
    expect(loading).toContain('aria-label="加载电脑操控设置"');
    const offline = renderToStaticMarkup(
      <ComputerUseModule state={state} envs={[mac]} connected={false} onRefresh={vi.fn()} />,
    );
    expect(offline.match(/<input\b[^>]*aria-label="启用浏览器操控"[^>]*>/)?.[0]).toContain("disabled");
    expect(offline.match(/<input\b[^>]*aria-label="启用桌面操控"[^>]*>/)?.[0]).toContain("disabled");
  });

  it("keeps monotonic revisions and posts updates to /api/capabilities/computer-use", async () => {
    const newer: ComputerUseSnapshotState = { revision: 4, computerUse: { browserEnabled: false, desktopEnabled: false } };
    expect(acceptComputerUseState(newer, state)).toBe(newer);
    expect(acceptComputerUseState(state, newer)).toBe(newer);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify(newer), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = { browserEnabled: false, desktopEnabled: false, expectedRevision: 3, commandId: "cu-1" };
    expect(await kuloRest.updateComputerUse(payload)).toEqual(newer);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/capabilities/computer-use", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify(payload),
    }));
  });
});
