import { describe, expect, it } from "vitest";
import { buildLinuxSeccompFilter } from "../packages/env/src/isolation-linux.js";

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
});
