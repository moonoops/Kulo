import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeviceName, DevicePresence, formatDeviceLabel, orderDevices } from "./device-identity";

describe("device identity helpers", () => {
  it("orders the current device first, then online devices, then offline devices", () => {
    const list = [
      { id: "local", name: "Macmini.local", online: true },
      { id: "studio", name: "Office-Studio.local", online: false },
      { id: "macbook", name: "iKoomas-Macboom-Pro.local", online: true },
      { id: "mini-2", name: "Lab-Mini.local", online: true },
    ];
    expect(orderDevices(list, { currentDeviceId: "macbook" }).map((d) => d.id)).toEqual([
      "macbook",
      "local",
      "mini-2",
      "studio",
    ]);
    expect(orderDevices(list).map((d) => d.id)).toEqual([
      "local",
      "macbook",
      "mini-2",
      "studio",
    ]);
    expect(orderDevices(list, { currentDeviceId: "studio" }).map((d) => d.id)).toEqual([
      "studio",
      "local",
      "macbook",
      "mini-2",
    ]);
  });

  it("places the local tag before the device name and formats plain-text labels with a leading marker", () => {
    expect(formatDeviceLabel("iKoomas-Macboom-Pro.local", true)).toBe("本机 · iKoomas-Macboom-Pro.local");
    expect(formatDeviceLabel("Macmini.local", false)).toBe("Macmini.local");

    const currentHtml = renderToStaticMarkup(<DeviceName name="iKoomas-Macboom-Pro.local" isCurrent singleLine />);
    expect(currentHtml).toContain("kulo-device-local-tag");
    expect(currentHtml.indexOf("本机")).toBeLessThan(currentHtml.indexOf("iKoomas-Macboom-Pro.local"));
    expect(currentHtml).not.toContain("（本机）");

    const remoteHtml = renderToStaticMarkup(<DeviceName name="Macmini.local" isCurrent={false} />);
    expect(remoteHtml).not.toContain("kulo-device-local-tag");
    expect(remoteHtml).toContain("Macmini.local");
  });

  it("renders green online and muted offline presence dots with accessible text", () => {
    const onlineMenu = renderToStaticMarkup(<DevicePresence online />);
    expect(onlineMenu).toContain('data-online="true"');
    expect(onlineMenu).toContain("<span>在线</span>");

    const offlineMenu = renderToStaticMarkup(<DevicePresence online={false} />);
    expect(offlineMenu).toContain('data-online="false"');
    expect(offlineMenu).toContain("<span>离线</span>");

    const onlineTrigger = renderToStaticMarkup(<DevicePresence online showOnlineText={false} />);
    expect(onlineTrigger).toContain('data-online="true"');
    expect(onlineTrigger).toContain('<span class="sr-only">在线</span>');

    const offlineTrigger = renderToStaticMarkup(<DevicePresence online={false} showOnlineText={false} />);
    expect(offlineTrigger).toContain('data-online="false"');
    expect(offlineTrigger).toContain("<span>离线</span>");
  });
});
