import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EnvNodeDescriptor } from "@kulo/protocol";
import { permissionCanBeRequested, SystemPermissionsModule } from "./system-permissions-module";
import { SETTINGS_MODULES, settingsModuleTitle } from "./settings-helpers";

const env: EnvNodeDescriptor = { id: "remote", name: "办公室 Mac", kind: "reverse-ws", online: true, platform: "darwin", arch: "arm64", rootDir: "/workspace", capabilities: ["agent-desktop"], connectedAt: 1, lastSeenAt: 1 };

describe("system permission settings", () => {
  it("registers the settings module and its English title", () => {
    expect(SETTINGS_MODULES.find((module) => module.id === "permissions")).toMatchObject({ title: "系统权限", icon: "shield" });
    expect(settingsModuleTitle("permissions", "en")).toBe("System permissions");
  });

  it("keeps all three permissions and execution-device scope in a scrollable settings table", () => {
    const html = renderToStaticMarkup(<SystemPermissionsModule envs={[env]} />);
    expect(html).toContain("麦克风");
    expect(html).toContain("辅助功能");
    expect(html).toContain("屏幕录制");
    expect(html).toContain("当前客户端");
    expect(html).toContain("办公室 Mac");
    expect(html).toContain("kulo-settings-table-scroll");
    expect(html).toContain('aria-label="系统权限列表"');
    expect(html).toContain("检查权限");
    expect(html).toContain("开始授权");
    expect(html).not.toContain("未保存");
  });

  it("uses a consistent local device label across selector and all three permission rows when on the local machine", () => {
    const local: EnvNodeDescriptor = { id: "local", name: "MacBook-Pro.local", kind: "local", online: true, platform: "darwin", arch: "arm64", rootDir: "/workspace", capabilities: ["agent-desktop"], connectedAt: 1, lastSeenAt: 1 };
    const html = renderToStaticMarkup(<SystemPermissionsModule envs={[local, env]} currentDeviceId="local" />);
    expect(html.split("MacBook-Pro.local（本机）").length - 1).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("当前客户端");
  });

  it("allows recovery only for known requestable states", () => {
    expect(["granted", "restricted", "unsupported", undefined].map((state) => permissionCanBeRequested(state as Parameters<typeof permissionCanBeRequested>[0]))).toEqual([false, false, false, false]);
    expect(["not-determined", "denied", "unknown"].map((state) => permissionCanBeRequested(state as Parameters<typeof permissionCanBeRequested>[0]))).toEqual([true, true, true]);
  });
});
