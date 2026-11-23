import os from "node:os";
import { execFileSync } from "node:child_process";
import { normalizeDeviceIp } from "@kulo/protocol";

interface NetworkAddress {
  address: string;
  prefixLength: number;
  unusable?: boolean;
  temporary?: boolean;
  priority?: number;
}

export interface DeviceNetworkInterface {
  name: string;
  active: boolean;
  lan: boolean;
  tailscale?: boolean;
  addresses: NetworkAddress[];
}

function tailscaleV6(address: string): boolean {
  return normalizeDeviceIp(address)?.startsWith("fd7a:115c:a1e0:") ?? false;
}

function tailscaleV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

function isTailscale(network: DeviceNetworkInterface, confirmedTailscaleIps?: ReadonlySet<string>): boolean {
  return !!network.tailscale ||
    /^tailscale(?:\b|\d)/i.test(network.name) ||
    network.addresses.some((entry) => tailscaleV6(entry.address) || Boolean(confirmedTailscaleIps?.has(normalizeDeviceIp(entry.address) ?? "")));
}

function ipv6Network(address: string, prefixLength: number): string {
  const sides = address.split("::");
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  const words = sides.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  let bits = Math.max(0, Math.min(128, prefixLength));
  return words.map((word) => {
    const count = Math.min(bits, 16);
    bits -= count;
    return (parseInt(word, 16) & (count ? (0xffff << (16 - count)) : 0)).toString(16);
  }).join(":") + `/${prefixLength}`;
}

export function selectDeviceNetworkIps(networks: DeviceNetworkInterface[], confirmedTailscaleIps?: ReadonlySet<string>): string[] {
  const ips = new Set<string>();
  for (const network of networks) {
    if (!network.active) continue;
    const tail = isTailscale(network, confirmedTailscaleIps);
    if (!network.lan && !tail) continue;
    const ipv6 = new Map<string, { address: string; priority: number }>();
    for (const entry of network.addresses) {
      if (entry.unusable) continue;
      const address = normalizeDeviceIp(entry.address);
      if (!address || (tail && !tailscaleV4(address) && !tailscaleV6(address))) continue;
      if (!address.includes(":")) { ips.add(address); continue; }
      const prefix = ipv6Network(address, entry.prefixLength);
      const previous = ipv6.get(prefix);
      // A temporary address remains usable when the host has no stable address for this prefix.
      const priority = (entry.temporary ? 100 : 0) + (entry.priority ?? 1);
      if (!previous || priority < previous.priority) ipv6.set(prefix, { address, priority });
    }
    for (const entry of ipv6.values()) ips.add(entry.address);
  }
  return [...ips];
}

export function parseDarwinNetworkInterfaces(output: string): DeviceNetworkInterface[] {
  const result: DeviceNetworkInterface[] = [];
  const bridgeMembers = new Map<string, string[]>();
  let current: DeviceNetworkInterface | undefined;
  for (const line of output.split(/\r?\n/)) {
    const header = /^([^\s:]+):\s+flags=[\da-f]+<([^>]+)>/i.exec(line);
    if (header) {
      const flags = header[2]!.split(",");
      current = { name: header[1]!, active: flags.includes("UP"), lan: /^(?:en\d+|bridge\d+)$/.test(header[1]!) && !flags.includes("POINTOPOINT") && !flags.includes("LOOPBACK"), addresses: [] };
      result.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\s+status:\s+inactive\b/.test(line)) current.active = false;
    const member = /^\s+member:\s+(\S+)/.exec(line);
    if (member) bridgeMembers.set(current.name, [...(bridgeMembers.get(current.name) ?? []), member[1]!]);
    const address = /^\s+(inet6?)\s+([^\s%]+)(?:%\S+)?\s+(.*)$/.exec(line);
    if (!address) continue;
    const suffix = address[3]!;
    current.addresses.push({ address: address[2]!, prefixLength: address[1] === "inet6" ? Number(/\bprefixlen\s+(\d+)/.exec(suffix)?.[1] ?? 64) : 32,
      temporary: /\btemporary\b/.test(suffix), unusable: /\b(?:deprecated|tentative|duplicated|detached)\b/.test(suffix), priority: /\bsecured\b/.test(suffix) ? 0 : 1 });
  }
  for (const network of result) if (/^bridge\d+$/.test(network.name)) {
    network.lan = network.lan && (bridgeMembers.get(network.name) ?? []).some((name) => result.some((member) => member.name === name && member.lan && member.active));
  }
  return result;
}

const auxiliaryInterface = /^(?:lo\d*|docker\d*|veth|virbr|br-[\da-f]+|cni|flannel|kube|utun|tun\d*|tap\d*|wg\d*|awdl|llw|nan|anpi|ap\d)/i;
const tunnelKinds = new Set(["veth", "tun", "wireguard", "dummy", "gre", "gretap", "ipip", "sit", "ip6tnl", "vxlan"]);

interface LinuxInterface {
  ifname: string;
  flags?: string[];
  operstate?: string;
  link_type?: string;
  master?: string | number;
  ifindex?: number;
  linkinfo?: { info_kind?: string };
  addr_info?: Array<{ local: string; prefixlen: number; temporary?: boolean; deprecated?: boolean; tentative?: boolean; dadfailed?: boolean; preferred_life_time?: number; flags?: string[] }>;
}

export function parseLinuxNetworkInterfaces(output: string): DeviceNetworkInterface[] {
  const records = JSON.parse(output) as LinuxInterface[];
  if (!Array.isArray(records)) throw new Error("Unexpected Linux network interface response");
  const physical = (entry: LinuxInterface) => entry.link_type === "ether" && !auxiliaryInterface.test(entry.ifname) &&
    (!tunnelKinds.has(entry.linkinfo?.info_kind ?? "") || (entry.linkinfo?.info_kind === "veth" && /^(?:eth\w*|en\w*|em\d+)$/.test(entry.ifname)));
  const active = (entry: LinuxInterface) => !!entry.flags?.includes("UP") && !["DOWN", "LOWERLAYERDOWN", "NOTPRESENT"].includes(entry.operstate ?? "");
  return records.map((entry) => {
    const kind = entry.linkinfo?.info_kind;
    const lan = physical(entry) && !entry.flags?.includes("POINTOPOINT") && (kind !== "bridge" || records.some((member) => (member.master === entry.ifname || member.master === entry.ifindex) && physical(member) && active(member) && member.linkinfo?.info_kind !== "bridge"));
    return { name: entry.ifname, active: active(entry), lan,
      addresses: (entry.addr_info ?? []).map((address) => ({ address: address.local, prefixLength: address.prefixlen, temporary: address.temporary || address.flags?.includes("temporary"),
        unusable: address.deprecated || address.tentative || address.dadfailed || address.preferred_life_time === 0 || address.flags?.some((flag) => ["deprecated", "tentative", "dadfailed"].includes(flag)) })) };
  });
}

interface WindowsNetworks {
  adapters: Array<{ name: string; index: number; description?: string; physical: boolean; up: boolean }>;
  addresses: Array<{ index: number; address: string; prefixLength: number; state: string; suffixOrigin: string; skipAsSource: boolean }>;
}

export function parseWindowsNetworkInterfaces(output: string): DeviceNetworkInterface[] {
  const result = JSON.parse(output.replace(/^\uFEFF/, "")) as WindowsNetworks;
  if (!Array.isArray(result.adapters) || !Array.isArray(result.addresses)) throw new Error("Unexpected Windows network interface response");
  return result.adapters.map((adapter) => ({ name: adapter.name, active: adapter.up, lan: adapter.physical, tailscale: /\btailscale\b/i.test(`${adapter.name} ${adapter.description ?? ""}`),
    addresses: result.addresses.filter((entry) => entry.index === adapter.index).map((entry) => ({ address: entry.address, prefixLength: entry.prefixLength,
      unusable: entry.state !== "Preferred" || entry.skipAsSource, temporary: entry.address.includes(":") && entry.suffixOrigin === "Random" })) }));
}

export function fallbackNetworkInterfaces(platform: string, snapshot: NodeJS.Dict<os.NetworkInterfaceInfo[]>): DeviceNetworkInterface[] {
  return Object.entries(snapshot).map(([name, addresses]) => ({ name, active: true,
    lan: platform === "darwin" ? /^en\d+$/.test(name) : platform === "win32" ? /^(?:Ethernet|Wi-Fi|WLAN|以太网|本地连接)(?:[ -]?\d+)?$/i.test(name) : /^(?:eth\w*|en\w*|em\d+|wl\w*|bond\d+|team\d+)$/.test(name),
    addresses: (addresses ?? []).filter((entry) => !entry.internal).map((entry) => ({ address: entry.address, prefixLength: Number(entry.cidr?.split("/")[1] ?? (entry.family === "IPv6" ? 64 : 32)) })) }));
}

const windowsNetworkScript = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @{adapters=@(Get-NetAdapter -IncludeHidden | Select-Object @{n='name';e={$_.Name}},@{n='index';e={$_.ifIndex}},@{n='description';e={$_.InterfaceDescription}},@{n='physical';e={$_.HardwareInterface}},@{n='up';e={$_.Status -eq 'Up'}}); addresses=@(Get-NetIPAddress | Select-Object @{n='index';e={$_.InterfaceIndex}},@{n='address';e={$_.IPAddress}},@{n='prefixLength';e={$_.PrefixLength}},@{n='state';e={$_.AddressState.ToString()}},@{n='suffixOrigin';e={$_.SuffixOrigin.ToString()}},@{n='skipAsSource';e={$_.SkipAsSource}})} | ConvertTo-Json -Depth 4 -Compress";

function runNetworkCommand(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function unavailableCommand(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as NodeJS.ErrnoException & { status?: number | null; signal?: string | null };
  return ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS"].includes(failure.code ?? "") || typeof failure.status === "number" || failure.signal === "SIGTERM";
}

function discoverSystemTailscaleIps(platform: string, run: (file: string, args: string[]) => string): Set<string> | undefined {
  const commands = platform === "darwin"
    ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]
    : platform === "win32"
      ? [`${process.env.ProgramFiles ?? "C:\\Program Files"}\\Tailscale\\tailscale.exe`, "tailscale.exe", "tailscale"]
      : ["tailscale"];
  for (const command of commands) {
    try {
      const output = run(command, ["status", "--json"]);
      const parsed = JSON.parse(output) as { BackendState?: unknown; TailscaleIPs?: unknown };
      if (parsed?.BackendState !== "Running" || !Array.isArray(parsed.TailscaleIPs)) return undefined;
      const result = new Set<string>();
      for (const raw of parsed.TailscaleIPs) {
        if (typeof raw !== "string") continue;
        const normalized = normalizeDeviceIp(raw);
        if (normalized && (tailscaleV4(normalized) || tailscaleV6(normalized))) result.add(normalized);
      }
      return result.size > 0 ? result : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function createDeviceIpCollector(options: {
  platform?: string;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  run?: (file: string, args: string[]) => string;
  now?: () => number;
  discoverTailscale?: () => ReadonlySet<string> | undefined;
} = {}): () => string[] {
  const platform = options.platform ?? os.platform();
  const interfaces = options.interfaces ?? os.networkInterfaces;
  const run = options.run ?? runNetworkCommand;
  const now = options.now ?? Date.now;
  // Default discovery only runs when using the real system runner (never consumes mocked `run` calls in tests).
  const discoverTailscale = options.discoverTailscale ?? (options.run ? () => undefined : () => discoverSystemTailscaleIps(platform, runNetworkCommand));
  let cache: { key: string; expiresAt: number; ips: string[] } | undefined;
  return () => {
    const snapshot = interfaces();
    const key = JSON.stringify(snapshot);
    const time = now();
    if (cache && cache.key === key && cache.expiresAt > time) return [...cache.ips];
    let networks: DeviceNetworkInterface[];
    try {
      if (platform === "darwin") networks = parseDarwinNetworkInterfaces(run("/sbin/ifconfig", ["-aL"]));
      else if (platform === "linux") networks = parseLinuxNetworkInterfaces(run("ip", ["-j", "-d", "address", "show"]));
      else if (platform === "win32") networks = parseWindowsNetworkInterfaces(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsNetworkScript]));
      else networks = fallbackNetworkInterfaces(platform, snapshot);
    } catch (error) {
      if (!unavailableCommand(error)) throw error;
      // Minimal Linux images and restricted hosts may not expose native metadata tools.
      networks = fallbackNetworkInterfaces(platform, snapshot);
    }
    const confirmedTailscale = networks.some((entry) => /^utun\d+$/i.test(entry.name) && entry.active && !isTailscale(entry) && entry.addresses.some((addr) => !addr.unusable && tailscaleV4(addr.address)))
      ? discoverTailscale()
      : undefined;
    const ips = selectDeviceNetworkIps(networks, confirmedTailscale);
    cache = { key, expiresAt: time + 15_000, ips };
    return [...ips];
  };
}

export const collectDeviceIps = createDeviceIpCollector();
