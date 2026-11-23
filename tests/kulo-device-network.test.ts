import type os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createDeviceIpCollector, fallbackNetworkInterfaces, parseDarwinNetworkInterfaces, parseLinuxNetworkInterfaces, parseWindowsNetworkInterfaces, selectDeviceNetworkIps } from "../packages/env/src/device-network.js";

const darwin = `en0: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
  inet 10.0.0.10 netmask 0xffffff00
  inet6 fe80::123%en0 prefixlen 64 secured
  inet6 2001:db8:10:1::99 prefixlen 64 autoconf temporary
  inet6 2001:db8:10:1::98 prefixlen 64 dynamic
  inet6 2001:db8:10:1::10 prefixlen 64 autoconf secured
  inet6 fd00:db8:1::10 prefixlen 64 autoconf secured
  inet6 2001:db8:10:2::10 prefixlen 64 deprecated
  inet6 2001:db8:10:3::10 prefixlen 64 tentative
  status: active
en8: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
  inet 10.0.0.20 netmask 0xffffff00
  inet6 2001:db8:10:1::20 prefixlen 64 autoconf secured
  status: active
en9: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
  inet 192.168.9.10 netmask 0xffffff00
  status: inactive
awdl0: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
  inet6 fd00:db8:1::40 prefixlen 64
  status: active
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 4000
  inet 198.18.0.1 --> 198.18.0.1 netmask 0xfffe0000
  inet6 fd00:6152::1 prefixlen 64
utun5: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
  inet 100.100.1.10 --> 100.100.1.10 netmask 0xffffffff
  inet6 fd7a:115c:a1e0::10 prefixlen 48
  inet6 fe80::5%utun5 prefixlen 64
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
  inet 100.70.1.9 --> 100.70.1.9 netmask 0xffffffff
`;

function nodeAddress(address: string): os.NetworkInterfaceInfo {
  return { address, netmask: "", family: address.includes(":") ? "IPv6" : "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/${address.includes(":") ? 64 : 24}`, ...(address.includes(":") ? { scopeid: 0 } : {}) } as os.NetworkInterfaceInfo;
}

describe("device network address collection", () => {
  it("keeps active Darwin LAN and Tailscale addresses without helper/proxy or temporary addresses", () => {
    expect(selectDeviceNetworkIps(parseDarwinNetworkInterfaces(darwin))).toEqual([
      "10.0.0.10", "2001:db8:10:1::10", "fd00:db8:1::10", "10.0.0.20", "2001:db8:10:1::20", "100.100.1.10", "fd7a:115c:a1e0::10",
    ]);
  });

  it("supports stable IPv6-only LAN interfaces and excludes detached/duplicated addresses", () => {
    const output = `en0: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
      inet6 2001:db8:1::1 prefixlen 64 secured
      inet6 2001:db8:2::1 prefixlen 64 detached
      inet6 2001:db8:3::1 prefixlen 64 duplicated
      status: active`;
    expect(selectDeviceNetworkIps(parseDarwinNetworkInterfaces(output))).toEqual(["2001:db8:1::1"]);
  });

  it("only treats Darwin bridges with an active LAN member as LAN adapters", () => {
    const output = `en0: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
      status: active
bridge0: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
      member: en0 flags=3<LEARNING,DISCOVER>
      inet 192.168.20.1 netmask 0xffffff00
      status: active
bridge100: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
      member: vmenet0 flags=3<LEARNING,DISCOVER>
      inet 192.168.64.1 netmask 0xffffff00
      status: active`;
    expect(selectDeviceNetworkIps(parseDarwinNetworkInterfaces(output))).toEqual(["192.168.20.1"]);
  });

  it("retains one usable temporary IPv6 when a prefix has no stable address", () => {
    const output = `en0: flags=8863<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
      inet6 2001:db8:1::1 prefixlen 64 autoconf temporary
      inet6 2001:db8:1::2 prefixlen 64 autoconf temporary
      inet6 2001:db8:1::3 prefixlen 64 autoconf secured deprecated
      status: active`;
    expect(selectDeviceNetworkIps(parseDarwinNetworkInterfaces(output))).toEqual(["2001:db8:1::1"]);
    const windows = JSON.stringify({ adapters: [{ name: "Ethernet", index: 1, physical: true, up: true }], addresses: [
      { index: 1, address: "2001:db8:1::1", prefixLength: 64, state: "Preferred", suffixOrigin: "Random", skipAsSource: false },
      { index: 1, address: "2001:db8:1::2", prefixLength: 64, state: "Preferred", suffixOrigin: "Random", skipAsSource: false },
    ] });
    expect(selectDeviceNetworkIps(parseWindowsNetworkInterfaces(windows))).toEqual(["2001:db8:1::1"]);
  });

  it("recognizes Linux JSON address flags without treating mngtmpaddr or stable-privacy as temporary", () => {
    const output = JSON.stringify([
      { ifname: "enp2s0", ifindex: 2, link_type: "ether", flags: ["UP", "LOWER_UP"], operstate: "UP", addr_info: [
        { local: "192.168.1.4", prefixlen: 24 },
        { local: "2001:db8:1::4", prefixlen: 64, mngtmpaddr: true, flags: ["mngtmpaddr", "stable-privacy"] },
        { local: "2001:db8:1::5", prefixlen: 64, temporary: true },
        { local: "2001:db8:2::4", prefixlen: 64, deprecated: true },
        { local: "2001:db8:3::4", prefixlen: 64, preferred_life_time: 0 },
        { local: "2001:db8:4::4", prefixlen: 64, tentative: true },
        { local: "2001:db8:5::4", prefixlen: 64, dadfailed: true },
        { local: "fd00:db8::4", prefixlen: 64 },
      ] },
      { ifname: "docker0", link_type: "ether", flags: ["UP"], addr_info: [{ local: "172.17.0.1", prefixlen: 16 }] },
      { ifname: "veth123", link_type: "ether", flags: ["UP"], linkinfo: { info_kind: "veth" }, addr_info: [{ local: "10.1.0.2", prefixlen: 24 }] },
      { ifname: "wg0", link_type: "none", flags: ["UP"], linkinfo: { info_kind: "wireguard" }, addr_info: [{ local: "10.50.0.2", prefixlen: 24 }] },
      { ifname: "tailscale0", link_type: "none", flags: ["UP", "POINTOPOINT"], operstate: "UNKNOWN", addr_info: [{ local: "100.100.1.4", prefixlen: 32 }, { local: "fd7a:115c:a1e0::4", prefixlen: 128 }] },
      { ifname: "eth9", link_type: "ether", flags: ["UP"], operstate: "DOWN", addr_info: [{ local: "10.99.0.2", prefixlen: 24 }] },
    ]);
    expect(selectDeviceNetworkIps(parseLinuxNetworkInterfaces(output))).toEqual(["192.168.1.4", "2001:db8:1::4", "fd00:db8::4", "100.100.1.4", "fd7a:115c:a1e0::4"]);
  });

  it("keeps a Linux LAN bridge with a physical member and excludes unconnected virtual bridges", () => {
    const output = JSON.stringify([
      { ifname: "br0", ifindex: 5, flags: ["UP"], link_type: "ether", linkinfo: { info_kind: "bridge" }, addr_info: [{ local: "192.168.20.1", prefixlen: 24 }] },
      { ifname: "enp3s0", flags: ["UP"], link_type: "ether", master: "br0" },
      { ifname: "br1", flags: ["UP"], link_type: "ether", linkinfo: { info_kind: "bridge" }, addr_info: [{ local: "192.168.30.1", prefixlen: 24 }] },
    ]);
    expect(selectDeviceNetworkIps(parseLinuxNetworkInterfaces(output))).toEqual(["192.168.20.1"]);
  });

  it("retains the ordinary eth0 network inside a Linux container while excluding host-side veth peers", () => {
    const output = JSON.stringify([
      { ifname: "eth0", link_type: "ether", flags: ["UP", "LOWER_UP"], operstate: "UP", linkinfo: { info_kind: "veth" }, addr_info: [{ local: "172.20.0.2", prefixlen: 16 }] },
      { ifname: "veth123", link_type: "ether", flags: ["UP", "LOWER_UP"], operstate: "UP", linkinfo: { info_kind: "veth" }, addr_info: [{ local: "172.20.0.1", prefixlen: 16 }] },
    ]);
    expect(selectDeviceNetworkIps(parseLinuxNetworkInterfaces(output))).toEqual(["172.20.0.2"]);
  });

  it("excludes a VM bridge when its physical LAN member is disconnected", () => {
    const output = JSON.stringify([
      { ifname: "br0", ifindex: 5, flags: ["UP", "LOWER_UP"], operstate: "UP", link_type: "ether", linkinfo: { info_kind: "bridge" }, addr_info: [{ local: "192.168.64.1", prefixlen: 24 }] },
      { ifname: "enp3s0", flags: ["UP"], operstate: "DOWN", link_type: "ether", master: "br0" },
      { ifname: "tap0", flags: ["UP", "LOWER_UP"], operstate: "UP", link_type: "ether", master: "br0", linkinfo: { info_kind: "tun" } },
      { ifname: "veth123", flags: ["UP", "LOWER_UP"], operstate: "UP", link_type: "ether", master: "br0", linkinfo: { info_kind: "veth" } },
    ]);
    expect(selectDeviceNetworkIps(parseLinuxNetworkInterfaces(output))).toEqual([]);
  });

  it("keeps physical Windows adapters and Tailscale while excluding transient and virtual adapter addresses", () => {
    const output = JSON.stringify({ adapters: [
      { name: "Wi-Fi", index: 5, physical: true, up: true },
      { name: "Ethernet 2", index: 6, physical: true, up: false },
      { name: "vEthernet (Default Switch)", index: 7, physical: false, up: true },
      { name: "Tailscale", description: "Tailscale Tunnel", index: 8, physical: false, up: true },
    ], addresses: [
      { index: 5, address: "192.168.1.5", prefixLength: 24, state: "Preferred", suffixOrigin: "Dhcp", skipAsSource: false },
      { index: 5, address: "2001:db8:1::5", prefixLength: 64, state: "Preferred", suffixOrigin: "Link", skipAsSource: false },
      { index: 5, address: "2001:db8:1::6", prefixLength: 64, state: "Preferred", suffixOrigin: "Random", skipAsSource: false },
      { index: 5, address: "fd00::5", prefixLength: 64, state: "Deprecated", suffixOrigin: "Manual", skipAsSource: false },
      { index: 5, address: "fd01::5", prefixLength: 64, state: "Preferred", suffixOrigin: "Manual", skipAsSource: true },
      { index: 6, address: "10.0.0.6", prefixLength: 24, state: "Preferred", suffixOrigin: "Dhcp", skipAsSource: false },
      { index: 7, address: "172.20.0.1", prefixLength: 24, state: "Preferred", suffixOrigin: "Manual", skipAsSource: false },
      { index: 8, address: "100.100.1.5", prefixLength: 32, state: "Preferred", suffixOrigin: "Manual", skipAsSource: false },
      { index: 8, address: "fd7a:115c:a1e0::5", prefixLength: 128, state: "Preferred", suffixOrigin: "Manual", skipAsSource: false },
    ] });
    expect(selectDeviceNetworkIps(parseWindowsNetworkInterfaces(output))).toEqual(["192.168.1.5", "2001:db8:1::5", "100.100.1.5", "fd7a:115c:a1e0::5"]);
  });

  it("uses a conservative interface fallback when native metadata is unavailable", () => {
    const snapshot = { en0: [nodeAddress("10.0.0.5"), nodeAddress("fe80::1"), nodeAddress("2001:db8:1::5"), nodeAddress("2001:db8:1::6")], awdl0: [nodeAddress("fd00::5")], utun4: [nodeAddress("198.18.0.1")], utun5: [nodeAddress("100.100.1.5"), nodeAddress("fd7a:115c:a1e0::5")], utun6: [nodeAddress("100.70.1.5")] };
    const run = vi.fn(() => { throw Object.assign(new Error("tool unavailable"), { code: "ENOENT" }); });
    const collector = createDeviceIpCollector({ platform: "darwin", interfaces: () => snapshot, run });
    expect(collector()).toEqual(["10.0.0.5", "2001:db8:1::5", "100.100.1.5", "fd7a:115c:a1e0::5"]);
    expect(selectDeviceNetworkIps(fallbackNetworkInterfaces("linux", { eth0: [nodeAddress("10.0.0.2")], docker0: [nodeAddress("172.17.0.1")], tun0: [nodeAddress("10.50.0.2")] }))).toEqual(["10.0.0.2"]);
  });

  it("caches native metadata for polling but refreshes after network changes or expiry", () => {
    let snapshot = { en0: [nodeAddress("10.0.0.10")] };
    let time = 1_000;
    const run = vi.fn(() => darwin);
    const collector = createDeviceIpCollector({ platform: "darwin", interfaces: () => snapshot, run, now: () => time });
    const first = collector();
    first.push("bad-caller-mutation");
    expect(collector()).not.toContain("bad-caller-mutation");
    expect(run).toHaveBeenCalledTimes(1);
    snapshot = { en0: [nodeAddress("10.0.0.11")] };
    collector();
    expect(run).toHaveBeenCalledTimes(2);
    time += 15_001;
    collector();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("falls back for native timeouts and surfaces malformed metadata instead of hiding parser failures", () => {
    const collector = createDeviceIpCollector({ platform: "linux", interfaces: () => ({}), run: () => "not json" });
    expect(() => collector()).toThrow(SyntaxError);
    const timeout = createDeviceIpCollector({ platform: "linux", interfaces: () => ({ eth0: [nodeAddress("10.0.0.2")] }), run: () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); } });
    expect(timeout()).toEqual(["10.0.0.2"]);
  });
});
