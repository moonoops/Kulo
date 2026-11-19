import { describe, expect, it } from "vitest";
import { buildDeviceSshRequest, isShareableHubUrl } from "./device-api";

describe("device invitation address boundary", () => {
  it.each([
    "http://192.168.1.10:7788",
    "https://kulo.example.com",
    "http://mac-mini.tailnet.ts.net:7788/",
    "http://[fd7a:115c:a1e0::1]:7788",
  ])("accepts an HTTP origin a peer can be configured to use: %s", (url) => {
    expect(isShareableHubUrl(url)).toBe(true);
  });

  it.each([
    "http://localhost:7788", "http://localhost.:7788", "http://peer.localhost:7788",
    "http://127.0.0.1:7788", "http://127.10.1.2:7788", "http://2130706433:7788",
    "http://0.0.0.0:7788", "http://[::]:7788", "http://[::1]:7788",
    "http://[::ffff:127.0.0.1]:7788", "http://device:0",
    "ws://device:7788", "file:///tmp/kulo", "http://device:7788/path",
    "http://user:password@device:7788", "http://device:7788/?token=credential",
    "http://device:7788/#credential", "", "device:7788",
  ])("rejects a loopback, wildcard or credential-bearing invitation address: %s", (url) => {
    expect(isShareableHubUrl(url)).toBe(false);
  });
});

describe("SSH onboarding before a reverse tunnel exists", () => {
  const fields = { host: " workstation ", port: "22", user: " me ", name: " Workstation ", rootDir: " ~/Kulo " };

  it.each(["http://localhost:7788", "http://127.0.0.1:7788", "http://[::1]:7788"])("uses the current Hub origin without requiring a shareable command address: %s", (hubOrigin) => {
    expect(isShareableHubUrl(hubOrigin)).toBe(false);
    expect(buildDeviceSshRequest(fields, hubOrigin)).toEqual({
      host: "workstation", port: 22, user: "me", name: "Workstation", rootDir: "~/Kulo", hubUrl: hubOrigin,
    });
  });

  it.each(["", "0", "65536", "22.5", "ssh"])("rejects an invalid SSH port: %s", (port) => {
    expect(() => buildDeviceSshRequest({ ...fields, port }, "http://127.0.0.1:7788")).toThrow("SSH 端口");
  });
});
