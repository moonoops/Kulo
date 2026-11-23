import { describe, expect, it } from "vitest";
import { filterDeviceIps, normalizeDeviceIp } from "@kulo/protocol";

describe("shareable device IP addresses", () => {
  it("retains LAN and Tailscale IPv4 and both global and unique-local IPv6", () => {
    for (const address of ["10.0.0.10", "172.16.3.4", "192.168.1.2", "100.100.1.10", "2001:db8:10:1::1", "fd00:db8:1::1", "fd7a:115c:a1e0::10"]) {
      expect(normalizeDeviceIp(address)).toBe(address);
    }
  });

  it.each(["127.0.0.1", "0.0.0.0", "169.254.1.2", "198.18.0.1", "198.19.255.1", "224.0.0.1", "255.255.255.255", "256.1.1.1", "::", "::1", "fe80::1", "fe90::1", "febf::1", "ff02::1", "fec0::1", "fe80::1%en0", "::ffff:127.0.0.1", "not-an-ip", "fd00:::1", "fd00::1/path"]) (
    "excludes non-shareable address %s", (address) => expect(normalizeDeviceIp(address)).toBeUndefined(),
  );

  it("deduplicates equivalent IPv6 spellings", () => {
    expect(filterDeviceIps(["FD7A:115C:A1E0:0000:0000:0000:0000:0010", "fd7a:115c:a1e0::10", "10.0.0.10", "10.0.0.10", "fe80::1"])).toEqual(["fd7a:115c:a1e0::10", "10.0.0.10"]);
  });
});
