import { describe, expect, it } from "vitest";
import { deviceAddresses } from "./device-addresses";

describe("device address overview", () => {
  it("prioritizes LAN addresses and retains every unique IPv4 and IPv6 address", () => {
    const addresses = ["fe80::1", "198.18.0.1", "2001:db8::1", "100.100.1.10", "10.0.1.10", "192.168.1.2", "10.0.1.10"];
    const result = deviceAddresses(addresses);
    expect(result.preview).toEqual(["10.0.1.10", "192.168.1.2"]);
    expect(result.ipv4).toEqual(["10.0.1.10", "192.168.1.2", "100.100.1.10", "198.18.0.1"]);
    expect(result.ipv6).toEqual(["2001:db8::1", "fe80::1"]);
    expect(new Set(result.all)).toEqual(new Set(addresses));
  });

  it("supports IPv6-only devices and preserves unrecognized addresses", () => {
    const result = deviceAddresses(["fe80::2", "fd7a:115c::1", "::1", "unknown-interface"]);
    expect(result.preview).toEqual(["fd7a:115c::1", "fe80::2"]);
    expect(result.other).toEqual(["unknown-interface"]);
    expect(deviceAddresses([]).preview).toEqual([]);
  });
});
