import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { WorkerNetworkPolicy, WorkerSandboxOptions } from "./isolation.js";
import { standaloneFunctionSource } from "./worker-supervisor.js";

function bubblewrap(): string | undefined {
  return ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find((candidate) => fs.existsSync(candidate));
}

let isolationAvailable: boolean | undefined;
export function linuxSandboxAvailable(): boolean {
  if (isolationAvailable !== undefined) return isolationAvailable;
  const executable = bubblewrap();
  if (!executable || !["x64", "arm64"].includes(process.arch)) return isolationAvailable = false;
  // Presence alone does not establish that the host allows the required namespaces and seccomp.
  const result = spawnSync(executable, ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/", "/", "--seccomp", "0", "--", "/bin/true"], { input: buildLinuxSeccompFilter(process.arch), timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] });
  return isolationAvailable = !result.error && result.status === 0;
}

/** The filter is installed after bubblewrap has created its namespaces. */
export function buildLinuxSeccompFilter(architecture: string): Buffer {
  const arm = architecture === "arm64";
  if (!arm && architecture !== "x64") throw new Error("Linux Worker isolation supports x64 and arm64");
  const instructions: Array<[number, number, number, number]> = [];
  const emit = (code: number, jt: number, jf: number, k: number) => instructions.push([code, jt, jf, k]);
  emit(0x20, 0, 0, 4);
  emit(0x15, 1, 0, arm ? 0xc00000b7 : 0xc000003e);
  emit(0x06, 0, 0, 0x80000000);
  emit(0x20, 0, 0, 0);
  if (!arm) { emit(0x45, 0, 1, 0x40000000); emit(0x06, 0, 0, 0x00050001); }
  // Returning ENOSYS lets libc use its ordinary clone fallback without permitting clone3 namespaces.
  emit(0x15, 0, 1, 435); emit(0x06, 0, 0, 0x00050026);
  emit(0x15, 0, 4, arm ? 220 : 56);
  emit(0x20, 0, 0, 16);
  emit(0x45, 0, 1, 0x7e020000);
  emit(0x06, 0, 0, 0x00050001);
  emit(0x06, 0, 0, 0x7fff0000);
  emit(0x20, 0, 0, 0);
  const denied = arm ? [117, 40, 39, 41, 97, 268, 280, 241, 270, 271, 219, 217, 218, 265] : [101, 165, 166, 155, 272, 308, 321, 298, 310, 311, 250, 248, 249, 304];
  for (const syscall of denied) { emit(0x15, 0, 1, syscall); emit(0x06, 0, 0, 0x00050001); }
  emit(0x06, 0, 0, 0x7fff0000);
  const filter = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    filter.writeUInt16LE(code, index * 8); filter[index * 8 + 2] = jt; filter[index * 8 + 3] = jf; filter.writeUInt32LE(k >>> 0, index * 8 + 4);
  });
  return filter;
}

export function buildLinuxSandboxArguments(options: WorkerSandboxOptions & { temporaryDir: string; executable: string; port: number; nodeExecutable?: string; controlDir?: string }): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run"];
  const mounted = new Set<string>();
  const ensureParents = (target: string) => {
    const parents: string[] = [];
    for (let current = path.dirname(target); current !== path.dirname(current); current = path.dirname(current)) parents.unshift(current);
    for (const parent of parents) {
      if (mounted.has(parent)) continue;
      args.push("--dir", parent);
      mounted.add(parent);
    }
  };
  const bind = (source: string, target: string, readOnly: boolean) => {
    ensureParents(target);
    args.push(readOnly ? "--ro-bind" : "--bind", source, target);
    mounted.add(target);
  };
  for (const directory of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) if (fs.existsSync(directory)) bind(directory, directory, true);
  for (const entry of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/ssl", "/etc/ca-certificates"]) if (fs.existsSync(entry)) bind(entry, entry, true);
  bind(options.workspaceDir, options.workspaceDir, Boolean(options.readOnly));
  if (options.scratchDir) bind(options.scratchDir, options.scratchDir, false);
  bind(options.temporaryDir, options.temporaryDir, false);
  for (const directory of options.runtimePaths ?? []) bind(directory, directory, true);
  for (const executable of [options.executable, options.nodeExecutable ?? process.execPath]) {
    if (!["/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/"].some((prefix) => executable.startsWith(prefix)) && !executable.startsWith(`${options.workspaceDir}/`)) bind(executable, executable, true);
  }
  for (const entry of [...(options.protectedPaths ?? []), "/usr/local/etc", "/usr/local/var"]) {
    if (!fs.existsSync(entry)) continue;
    const actual = fs.realpathSync(entry);
    if (actual === options.executable) continue;
    const visible = [options.workspaceDir, options.scratchDir, options.temporaryDir, "/usr", "/bin", "/sbin", "/lib", "/lib64"].some((root) => root && (actual === root || actual.startsWith(`${root}/`)));
    if (!visible) continue;
    if (options.controlDir) args.push("--ro-bind", path.join(options.controlDir, fs.statSync(actual).isDirectory() ? "private-directory" : "private-file"), actual);
    else if (fs.statSync(actual).isDirectory()) args.push("--tmpfs", actual);
    else args.push("--ro-bind", "/dev/null", actual);
  }
  for (const entry of options.writeDeniedPaths ?? []) {
    if (!fs.existsSync(entry)) continue;
    const actual = fs.realpathSync(entry);
    if (actual === options.executable) continue;
    const visible = [options.workspaceDir, options.scratchDir, options.temporaryDir].some((root) => root && (actual === root || actual.startsWith(`${root}/`)));
    if (!visible) continue;
    args.push("--ro-bind", actual, actual);
  }
  const offline = Boolean(options.network?.offline);
  if (!offline) {
    args.push("--bind", path.join(options.temporaryDir, "network"), "/run/kulo-network");
  }
  args.push("--chdir", options.workspaceDir, "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", path.join(options.temporaryDir, "home"), "--setenv", "TMPDIR", path.join(options.temporaryDir, "tmp"), "--setenv", "LANG", "C.UTF-8", "--setenv", "PORT", String(options.port));
  if (!offline) {
    args.push("--setenv", "HTTP_PROXY", "http://127.0.0.1:3128", "--setenv", "HTTPS_PROXY", "http://127.0.0.1:3128", "--setenv", "http_proxy", "http://127.0.0.1:3128", "--setenv", "https_proxy", "http://127.0.0.1:3128", "--setenv", "NO_PROXY", "localhost,127.0.0.1,::1", "--setenv", "NODE_USE_ENV_PROXY", "1");
  }
  args.push("--seccomp", "3");
  return args;
}

export function isRestrictedLinuxProxyAddress(value: string, hostAddresses: ReadonlySet<string> = new Set()): boolean {
  const address = value.toLowerCase().replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  return (
    hostAddresses.has(address) ||
    /^127\./.test(address) ||
    address === "0.0.0.0" ||
    address === "::" ||
    address === "::1" ||
    /^10\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) ||
    /^169\.254\./.test(address) ||
    /^fe[89ab]/.test(address) ||
    /^f[cd]/.test(address) ||
    /^ff/.test(address)
  );
}

async function linuxInside(): Promise<void> {
  const net = await import("node:net");
  const cp = await import("node:child_process");
  const [configuration, ...arguments_] = process.argv.slice(1);
  const config = JSON.parse(configuration!) as { executable: string; port: number; offline?: boolean };
  if (!config.offline) {
    const proxy = net.createServer((client) => {
      const upstream = net.createConnection("/run/kulo-network/proxy.sock");
      client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    const development = net.createServer((client) => {
      const upstream = net.createConnection({ host: "127.0.0.1", port: config.port });
      client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(3128, "127.0.0.1", resolve); }),
      new Promise<void>((resolve, reject) => { development.once("error", reject); development.listen("/run/kulo-network/development.sock", resolve); }),
    ]);
  }
  const child = cp.spawn(config.executable, arguments_, { stdio: "inherit", env: process.env });
  child.once("error", () => process.exit(1));
  child.once("exit", (code) => process.exit(code ?? 1));
}

async function linuxOutside(): Promise<void> {
  const fs = await import("node:fs");
  const http = await import("node:http");
  const net = await import("node:net");
  const os = await import("node:os");
  const dns = await import("node:dns/promises");
  const cp = await import("node:child_process");
  const [configuration, ...arguments_] = process.argv.slice(1);
  const config = JSON.parse(configuration!) as { bwrap: string; args: string[]; inside: string; insideConfig: string; node: string; proxySocket: string; developmentSocket: string; seccomp: string; port: number; allowedPorts: number[]; offline?: boolean };
  let proxy: import("node:http").Server | undefined;
  let development: import("node:net").Server | undefined;
  if (!config.offline) {
    const normalize = (value: string) => value.toLowerCase().replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
    const hostAddresses = new Set(Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((address) => normalize(address.address))));
    const destination = async (hostname: string, port: number) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid proxy destination");
      const addresses = await dns.lookup(hostname, { all: true });
      if (!addresses.length) throw new Error("Proxy destination did not resolve");
      const isHost = (value: string) => {
        const address = normalize(value);
        return hostAddresses.has(address) || /^127\./.test(address) || address === "0.0.0.0" || address === "::" || address === "::1" || /^169\.254\./.test(address) || /^fe[89ab]/.test(address);
      };
      const isPrivateLan = (value: string) => {
        const address = normalize(value);
        return /^10\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^192\.168\./.test(address) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^f[cd]/.test(address) || /^ff/.test(address);
      };
      if (addresses.some((address) => isPrivateLan(address.address))) throw new Error("Private network destination is not authorized");
      if (addresses.some((address) => isHost(address.address)) && !config.allowedPorts.includes(port)) throw new Error("Host network destination is not authorized");
      return addresses[0]!;
    };
    proxy = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url!);
        if (url.protocol !== "http:") throw new Error("Use CONNECT for TLS destinations");
        const port = Number(url.port || 80);
        const address = await destination(url.hostname, port);
        const headers: import("node:http").OutgoingHttpHeaders = { ...request.headers, host: url.host };
        delete headers["proxy-authorization"]; delete headers["proxy-connection"];
        const upstream = http.request({ hostname: address.address, family: address.family, port, path: `${url.pathname}${url.search}`, method: request.method, headers }, (incoming) => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); });
        upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        request.pipe(upstream);
      } catch { response.writeHead(403); response.end("Network destination is not authorized"); }
    });
    proxy.on("connect", async (request, client, head) => {
      try {
        const url = new URL(`http://${request.url}`);
        const port = Number(url.port || 443);
        const address = await destination(url.hostname.replace(/^\[|\]$/g, ""), port);
        const upstream = net.createConnection({ host: address.address, family: address.family, port });
        upstream.once("connect", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client); });
        upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
      } catch { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
    });
    development = net.createServer((client) => {
      const upstream = net.createConnection(config.developmentSocket);
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
      client.pipe(upstream).pipe(client);
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => { proxy!.once("error", reject); proxy!.listen(config.proxySocket, resolve); }),
      new Promise<void>((resolve, reject) => { development!.once("error", reject); development!.listen(config.port, "127.0.0.1", resolve); }),
    ]);
    fs.chmodSync(config.proxySocket, 0o600);
  }
  const child = cp.spawn(config.bwrap, [...config.args, config.node, "--input-type=module", "-e", config.inside, config.insideConfig, ...arguments_], { stdio: ["pipe", "pipe", "pipe", "pipe"], detached: true, env: { PATH: "/usr/bin:/bin" } });
  const seccomp = child.stdio[3] as import("node:stream").Writable;
  seccomp.end(Buffer.from(config.seccomp, "base64"));
  process.stdin.pipe(child.stdin!); child.stdout!.pipe(process.stdout); child.stderr!.pipe(process.stderr);
  const stop = () => {
    if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    proxy?.close(); development?.close();
    const forced = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } }, 300);
    forced.unref();
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop); process.stdin.once("end", stop);
  child.once("error", () => { stop(); process.exit(1); });
  child.once("close", (code) => { stop(); process.exit(code ?? 1); });
}

export function createLinuxSandboxCommand(options: WorkerSandboxOptions & { temporaryDir: string; controlDir: string; executable: string; protectedPaths: readonly string[]; port: number; network?: WorkerNetworkPolicy }): readonly string[] {
  const executable = bubblewrap();
  if (!executable) throw new Error("Linux Worker isolation requires bubblewrap; unrestricted host execution is disabled");
  const offline = Boolean(options.network?.offline);
  const networkDirectory = path.join(options.temporaryDir, "network");
  if (!offline) fs.mkdirSync(networkDirectory, { mode: 0o700 });
  fs.mkdirSync(path.join(options.controlDir, "private-directory"), { mode: 0o000 });
  fs.writeFileSync(path.join(options.controlDir, "private-file"), "", { mode: 0o000 });
  const config = {
    bwrap: executable, args: buildLinuxSandboxArguments(options), inside: standaloneFunctionSource(linuxInside), insideConfig: JSON.stringify({ executable: options.executable, port: options.port, offline }), node: process.execPath,
    proxySocket: path.join(networkDirectory, "proxy.sock"), developmentSocket: path.join(networkDirectory, "development.sock"), seccomp: buildLinuxSeccompFilter(process.arch).toString("base64"), port: options.port,
    allowedPorts: [...new Set([options.port, ...(options.network?.localConnectPorts ?? [])])],
    offline,
  };
  return [process.execPath, "--input-type=module", "-e", standaloneFunctionSource(linuxOutside), JSON.stringify(config)];
}
