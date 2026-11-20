import { renderToStaticMarkup } from "react-dom/server";
import { Dropdown } from "@heroui/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvNodeDescriptor } from "@kulo/protocol";
import { ChatTargetDeviceMenu, sortTargetDevices } from "./target-device-menu";

afterEach(() => { vi.restoreAllMocks(); });

function makeEnv(overrides: Partial<EnvNodeDescriptor> & { id: string; name: string }): EnvNodeDescriptor {
  return {
    kind: "reverse-ws",
    online: true,
    platform: "darwin",
    arch: "arm64",
    rootDir: "/workspace",
    capabilities: ["fs", "bash", "worker-isolation"],
    connectedAt: 1,
    lastSeenAt: 1,
    ...overrides,
  };
}

describe("ChatTargetDeviceMenu", () => {
  const local = makeEnv({ id: "local", name: "Macmini.local", kind: "local", online: true });
  const macbookOffline = makeEnv({ id: "device-macbook", name: "iKoomas-Macboom-Pro.local", online: false });
  const studioOnline = makeEnv({ id: "device-studio", name: "Alpha Studio", online: true });

  it("hides itself when there is only one device and no target is selected", () => {
    const html = renderToStaticMarkup(
      <ChatTargetDeviceMenu envs={[local]} selectedDeviceId="" onSelect={vi.fn()} />,
    );
    expect(html).toBe("");
  });

  it("sorts current device first when known, otherwise Hub local first, then online peers, then offline peers", () => {
    expect(sortTargetDevices([macbookOffline, studioOnline, local]).map((d) => d.id)).toEqual([
      "local",
      "device-studio",
      "device-macbook",
    ]);
    expect(sortTargetDevices([macbookOffline, studioOnline, local], "device-studio").map((d) => d.id)).toEqual([
      "device-studio",
      "local",
      "device-macbook",
    ]);
  });

  it("renders concise Auto label by default when multiple devices exist", () => {
    const html = renderToStaticMarkup(
      <ChatTargetDeviceMenu envs={[local, macbookOffline]} selectedDeviceId="" onSelect={vi.fn()} />,
    );
    expect(html).toContain("自动");
    expect(html).toContain('aria-label="执行设备"');
    expect(html).not.toContain("kulo-device-presence-dot");
  });

  it("shows status dots, leading local tag, and current-first ordering in trigger and dropdown", () => {
    vi.spyOn(Dropdown, "Popover").mockImplementation(({ children }) => <>{children}</>);
    const selectedOnline = renderToStaticMarkup(
      <ChatTargetDeviceMenu envs={[local, macbookOffline, studioOnline]} currentDeviceId="device-studio" selectedDeviceId="device-studio" onSelect={vi.fn()} />,
    );
    expect(selectedOnline).toContain('title="本机 · Alpha Studio · 在线"');
    expect(selectedOnline).toContain('<span class="kulo-device-local-tag">本机</span>');
    expect(selectedOnline.indexOf('<span class="kulo-device-local-tag">本机</span>')).toBeLessThan(selectedOnline.indexOf(">Alpha Studio</span>"));
    expect(selectedOnline).toContain('data-online="true"');
    expect(selectedOnline).toContain('data-online="false"');

    const menuSlice = selectedOnline.slice(selectedOnline.indexOf('role="menu"'));
    expect(menuSlice.indexOf("Alpha Studio")).toBeLessThan(menuSlice.indexOf("Macmini.local"));
    expect(menuSlice.indexOf("Macmini.local")).toBeLessThan(menuSlice.indexOf("iKoomas-Macboom-Pro.local"));
    expect(menuSlice.indexOf('<span class="kulo-device-local-tag">本机</span>')).toBeLessThan(menuSlice.indexOf(">Alpha Studio</span>"));
  });

  it("shows the selected device name and offline badge when a bound device is offline", () => {
    const selectedOnline = renderToStaticMarkup(
      <ChatTargetDeviceMenu envs={[local, macbookOffline]} selectedDeviceId="local" onSelect={vi.fn()} />,
    );
    expect(selectedOnline).toContain("Macmini.local");
    expect(selectedOnline).toContain('data-online="true"');
    expect(selectedOnline).not.toContain("离线");

    const selectedOffline = renderToStaticMarkup(
      <ChatTargetDeviceMenu envs={[local, macbookOffline]} selectedDeviceId="device-macbook" onSelect={vi.fn()} />,
    );
    expect(selectedOffline).toContain("iKoomas-Macboom-Pro.local");
    expect(selectedOffline).toContain('data-online="false"');
    expect(selectedOffline).toContain("离线");
  });
});
