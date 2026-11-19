function ipv4Parts(address: string): number[] | undefined {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return;
  const parts = address.split(".").map(Number);
  return parts.every((part) => part <= 255) ? parts : undefined;
}

function addressPriority(address: string): number {
  const parts = ipv4Parts(address);
  if (parts) {
    const [first, second] = parts;
    if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return 0;
    if (first === 100 && second >= 64 && second <= 127) return 1;
    if (first === 127 || first === 0 || (first === 169 && second === 254) || (first === 198 && (second === 18 || second === 19))) return 4;
    return 2;
  }
  if (address.includes(":")) return /^(fe[89ab]|::1$)/i.test(address) ? 4 : 3;
  return 5;
}

export function deviceAddresses(addresses: readonly string[]) {
  // Keep every address available while moving LAN addresses ahead of virtual interfaces.
  const all = [...new Set(addresses)].sort((left, right) => addressPriority(left) - addressPriority(right));
  return {
    all,
    preview: all.slice(0, 2),
    ipv4: all.filter((address) => ipv4Parts(address)),
    ipv6: all.filter((address) => !ipv4Parts(address) && address.includes(":")),
    other: all.filter((address) => !ipv4Parts(address) && !address.includes(":")),
  };
}
