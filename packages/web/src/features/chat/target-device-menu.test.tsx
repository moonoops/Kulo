import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EnvNodeDescriptor } from "@kulo/protocol";
import { ChatTargetDeviceMenu, sortTargetDevices } from "./target-device-menu";

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

  it("sorts Hub local first, then online peers, then offline peers", () => {
    expect(sortTargetDevices([macbookOffline, studioOnline, local]).map((d) => d.id)).toEqual([
      "local",
      "device-studio",
      "device-macbook",
    ]);
  });

  it("renders concise Auto label by default when multiple devices exist", () => {
    const html = renderToStaticMarkup(
      <ChatTargetDeviceMenu envs={[local, macbookOffline]} selectedDeviceId="" onSelect={vi.fn()} />,
    );
    expect(html).toContain("自动");
    expect(html).toContain('aria-label="执行设备"');
  });

  it("shows the selected device name and offline badge when a bound device is offline", () => {
    const selectedOnline = renderToStaticMarkup(
      <ChatTargetDeviceMenu envs={[local, macbookOffline]} selectedDeviceId="local" onSelect={vi.fn()} />,
    );
    expect(selectedOnline).toContain("Macmini.local");
    expect(selectedOnline).not.toContain("离线");

    const selectedOffline = renderToStaticMarkup(
      <ChatTargetDeviceMenu envs={[local, macbookOffline]} selectedDeviceId="device-macbook" onSelect={vi.fn()} />,
    );
    expect(selectedOffline).toContain("iKoomas-Macboom-Pro.local");
    expect(selectedOffline).toContain("离线");
  });
});
