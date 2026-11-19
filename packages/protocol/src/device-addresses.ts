/** Canonical unicast addresses that can be shared without an interface zone. */
export function normalizeDeviceIp(value: string): string | undefined {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return;
    const [first = 0, second = 0] = octets;
    if (first === 0 || first === 127 || first >= 224 || (first === 169 && second === 254) ||
        (first === 198 && (second === 18 || second === 19))) return;
    return octets.join(".");
  }
  if (!value.includes(":") || !/^[\da-f:]+$/i.test(value)) return;
  let address: string;
  try {
    address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch (error) {
    if (error instanceof TypeError) return;
    throw error;
  }
  const prefix = Number.parseInt(address.split(":")[0] ?? "", 16);
  // LAN adapters can carry global IPv6 as well as unique-local IPv6.
  if ((prefix & 0xe000) !== 0x2000 && (prefix & 0xfe00) !== 0xfc00) return;
  return address;
}

export function filterDeviceIps(addresses: readonly string[]): string[] {
  return [...new Set(addresses.flatMap((address) => {
    const normalized = normalizeDeviceIp(address);
    return normalized ? [normalized] : [];
  }))];
}
