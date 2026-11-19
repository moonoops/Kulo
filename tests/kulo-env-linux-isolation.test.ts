import { describe, expect, it } from "vitest";
import {
  buildLinuxSandboxArguments,
  buildLinuxSeccompFilter,
  isRestrictedLinuxProxyAddress,
} from "../packages/env/src/isolation-linux.js";

function decide(filter: Buffer, architecture: number, syscall: number, cloneFlags = 0): number {
  const input = Buffer.alloc(64);
  input.writeUInt32LE(syscall >>> 0, 0); input.writeUInt32LE(architecture >>> 0, 4); input.writeUInt32LE(cloneFlags >>> 0, 16);
  let accumulator = 0;
  for (let instruction = 0; instruction < filter.length / 8; instruction++) {
    const offset = instruction * 8;
    const code = filter.readUInt16LE(offset), yes = filter[offset + 2]!, no = filter[offset + 3]!, value = filter.readUInt32LE(offset + 4);
    if (code === 0x20) accumulator = input.readUInt32LE(value);
    else if (code === 0x15) instruction += accumulator === value ? yes : no;
    else if (code === 0x45) instruction += accumulator & value ? yes : no;
    else if (code === 0x06) return value;
    else throw new Error(`Unexpected BPF instruction ${code}`);
  }
  throw new Error("Seccomp filter did not return a decision");
}

describe("Linux native seccomp policy", () => {
  it.each([
    { architecture: "x64", audit: 0xc000003e, clone: 56, ordinary: 1, sensitive: [101, 165, 166, 155, 272, 308, 321, 298, 310, 311, 250, 248, 249, 304] },
    { architecture: "arm64", audit: 0xc00000b7, clone: 220, ordinary: 64, sensitive: [117, 40, 39, 41, 97, 268, 280, 241, 270, 271, 219, 217, 218, 265] },
  ])("rejects namespace and host-process escape syscalls on $architecture while allowing normal process creation", ({ architecture, audit, clone, ordinary, sensitive }) => {
    const filter = buildLinuxSeccompFilter(architecture);
    for (const syscall of sensitive) expect(decide(filter, audit, syscall)).toBe(0x00050001);
    expect(decide(filter, audit, ordinary)).toBe(0x7fff0000);
    expect(decide(filter, audit, clone, 0x00000100)).toBe(0x7fff0000);
    for (const namespace of [0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000]) expect(decide(filter, audit, clone, namespace)).toBe(0x00050001);
    expect(decide(filter, audit, 435)).toBe(0x00050026);
    expect(decide(filter, 0x40000003, ordinary)).toBe(0x80000000);
  });

  it("closes the x32 ABI bypass and rejects unsupported host architectures", () => {
    expect(decide(buildLinuxSeccompFilter("x64"), 0xc000003e, 0x40000000 | 165)).toBe(0x00050001);
    expect(() => buildLinuxSeccompFilter("ia32")).toThrow("x64 and arm64");
  });

  it("omits network proxy socket mount and proxy env vars when offline is enabled", () => {
    const common = {
      workspaceDir: "/tmp/kulo-ws",
      workspaceRoot: "/tmp/kulo-ws",
      controlRoot: "/tmp/kulo-ctl",
      temporaryDir: "/tmp/kulo-tmp",
      executable: "/usr/bin/node",
      port: 18080,
    };
    const offlineArgs = buildLinuxSandboxArguments({ ...common, network: { offline: true } });
    expect(offlineArgs).not.toContain("/run/kulo-network");
    expect(offlineArgs).not.toContain("HTTP_PROXY");
    expect(offlineArgs).not.toContain("HTTPS_PROXY");

    const onlineArgs = buildLinuxSandboxArguments({ ...common, network: { offline: false } });
    expect(onlineArgs).toContain("/run/kulo-network");
    expect(onlineArgs).toContain("HTTP_PROXY");
  });

  it("blocks RFC1918 LAN, Tailscale CGNAT, link-local, loopback, and IPv6 ULA proxy destinations", () => {
    for (const blocked of [
      "127.0.0.1", "::1", "0.0.0.0", "::",
      "10.0.0.1", "172.16.0.5", "172.31.255.1", "192.168.1.10",
      "100.64.0.1", "100.100.100.100", "169.254.169.254",
      "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:192.168.0.1",
    ]) {
      expect(isRestrictedLinuxProxyAddress(blocked), blocked).toBe(true);
    }
    for (const allowed of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"]) {
      expect(isRestrictedLinuxProxyAddress(allowed), allowed).toBe(false);
    }
  });
});
