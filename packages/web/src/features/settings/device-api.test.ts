import { describe, expect, it } from "vitest";
import type { ConnectionRecordView } from "@kulo/protocol";
import { buildDeviceSshAddRequest, isShareableHubUrl } from "./device-api";
import { classifySshCredentialsForDevice } from "./add-device-modal";

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

describe("SSH credential-bound device request and strict 1B filtering", () => {
  const verifiedId = "connection-11111111-2222-3333-4444-555555555555";
  const unverifiedId = "connection-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const boundId = "connection-99999999-8888-7777-6666-555555555555";

  it("builds a trimmed credential-bound SSH add request and rejects invalid IDs", () => {
    expect(buildDeviceSshAddRequest({ connectionId: ` ${verifiedId} `, name: " Workstation ", rootDir: " ~/Kulo " })).toEqual({
      connectionId: verifiedId,
      name: "Workstation",
      rootDir: "~/Kulo",
    });
    expect(() => buildDeviceSshAddRequest({ connectionId: "", name: "", rootDir: "" })).toThrow("已验证的 SSH 凭据");
    expect(() => buildDeviceSshAddRequest({ connectionId: "bad-id", name: "", rootDir: "" })).toThrow("已验证的 SSH 凭据");
  });

  it("allows only verified, unbound SSH credentials with a trusted fingerprint", () => {
    const base = {
      kind: "ssh" as const,
      category: "credential" as const,
      host: "192.0.2.50",
      port: 22,
      username: "demo",
      hasCredential: true,
      secretFields: ["password"],
      hostFingerprint: "ssh-ed25519 SHA256:abc",
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    const list: ConnectionRecordView[] = [
      { ...base, id: verifiedId, name: "Verified", status: "verified" },
      { ...base, id: unverifiedId, name: "Saved Only", status: "saved" },
      { ...base, id: boundId, name: "Already Bound", status: "verified" },
      { ...base, id: "connection-00000000-0000-0000-0000-000000000000", name: "Not SSH", kind: "account", status: "verified" },
    ];
    const classified = classifySshCredentialsForDevice(list, new Set([boundId]));
    expect(classified.all.map((item) => item.id)).toEqual([verifiedId, unverifiedId, boundId]);
    expect(classified.eligible.map((item) => item.id)).toEqual([verifiedId]);
    expect(classified.disabledKeys).toEqual([unverifiedId, boundId]);
    expect(classified.unverifiedCount).toBe(1);
  });
});
