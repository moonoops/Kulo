import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWindowsSandboxPolicy,
  ensureHostRuntimeToken,
  hasWorkerBasicOrFullIsolation,
  hasWorkerStrictNetworkIsolation,
  HUB_STATE_LOCK_FILES,
  KULO_RUNTIME_INSTANCE_FILES,
  preserveWindowsCoreEnv,
  quoteWindowsCmdArg,
  readExistingHostRuntimeToken,
  readHostRuntimePort,
  removeReadonlyTreeSync,
  renderPeerInstaller,
  resolveCrossPlatformSpawn,
  resolveDefaultHostDataDir,
  resolveKuloHostLayout,
  resolveSystemTarExecutable,
  saveHostRuntimePort,
} from "@kulo/env";
import { supervisedCommand } from "../packages/env/src/worker-supervisor.js";
import { LinuxConnectionKeyStore } from "../packages/hub/src/linux-keystore.js";
import { hasWorkerIsolation } from "../packages/hub/src/env-routing-policy.js";
import {
  resolveDesktopTrayIconChoice,
  resolvePackagedNodePath,
  resolvePackagedRescuePath,
  resolveWindowIconPath,
} from "../packages/desktop/src/desktop-config.js";
import { tryAttachExternalHostRuntime } from "../packages/desktop/src/attach-runtime.js";
import { createDesktopTrayController, type ManagedTray } from "../packages/desktop/src/desktop-tray.js";
import {
  materializeWindowsNodeModules,
  prepareAgentClis,
  preserveConnectorBroker,
  renderLinuxCliWrapper,
  renderLinuxRuntimeHostWrapper,
} from "../packages/desktop/scripts/package.mjs";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kulo-xplat-${prefix}-`)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0).reverse()) {
    removeReadonlyTreeSync(dir);
  }
});

describe("LinuxConnectionKeyStore 3-tier fallback & vault protection", () => {
  const ns = "a".repeat(64);
  const ns2 = "b".repeat(64);

  function fakeExecutable(dir: string, name: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return file;
  }

  it("uses secret-service (Tier 1) when available", async () => {
    const stateDir = makeTempDir("linux-ks-t1");
    const binDir = makeTempDir("linux-ks-bin1");
    const secretTool = fakeExecutable(binDir, "secret-tool");
    const secrets = new Map<string, string>();
    const store = new LinuxConnectionKeyStore({
      stateDir,
      env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
      secretToolPaths: [secretTool],
      systemdCredsPaths: [],
      runProcess: async (_cmd, args, input) => {
        if (args[0] === "lookup") {
          const val = secrets.get(args[args.length - 1]!);
          return val ? { status: 0, output: Buffer.from(val, "utf8") } : { status: 1, output: Buffer.alloc(0) };
        }
        if (args[0] === "store") {
          secrets.set(args[args.length - 1]!, String(input ?? ""));
          return { status: 0, output: Buffer.alloc(0) };
        }
        if (args[0] === "clear") {
          secrets.delete(args[args.length - 1]!);
          return { status: 0, output: Buffer.alloc(0) };
        }
        return { status: 1, output: Buffer.alloc(0) };
      },
    });
    await expect(store.checkAvailability()).resolves.toBeUndefined();
    const k1 = await store.getOrCreateKey(ns, true);
    expect(k1.length).toBe(32);
    expect(store.readPinnedBackendForDiagnostics()).toBe("secret-service");
    const k2 = await store.getOrCreateKey(ns, false);
    expect(k2.equals(k1)).toBe(true);
  });

  it("falls back to systemd-creds --user --with-key=host (Tier 2) on headless systemd hosts", async () => {
    const stateDir = makeTempDir("linux-ks-t2");
    const binDir = makeTempDir("linux-ks-bin2");
    const systemdCreds = fakeExecutable(binDir, "systemd-creds");
    const calls: string[][] = [];
    const store = new LinuxConnectionKeyStore({
      stateDir,
      secretToolPaths: [],
      systemdCredsPaths: [systemdCreds],
      runProcess: async (_cmd, args, input) => {
        calls.push(args);
        if (args[0] === "encrypt") {
          expect(args).toContain("--user");
          expect(args).toContain("--with-key=host");
          const raw = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
          return { status: 0, output: Buffer.from(`SEALED:${raw.toString("base64")}`, "utf8") };
        }
        if (args[0] === "decrypt") {
          expect(args).toContain("--user");
          const raw = (Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8")).toString("utf8");
          if (!raw.startsWith("SEALED:")) return { status: 1, output: Buffer.alloc(0) };
          return { status: 0, output: Buffer.from(raw.slice("SEALED:".length), "base64") };
        }
        return { status: 1, output: Buffer.alloc(0) };
      },
    });
    await expect(store.checkAvailability()).resolves.toBeUndefined();
    const k1 = await store.getOrCreateKey(ns, true);
    expect(k1.length).toBe(32);
    expect(store.readPinnedBackendForDiagnostics()).toBe("systemd-creds-user");
    const k2 = await store.getOrCreateKey(ns, false);
    expect(k2.equals(k1)).toBe(true);
    expect(calls.some((c) => c[0] === "encrypt" && c.includes("--with-key=host"))).toBe(true);
  });

  it("falls back to sealed-file (Tier 3) and remains immune to /etc/machine-id appearing later", async () => {
    const stateDir = makeTempDir("linux-ks-t3");
    const idDir = makeTempDir("linux-ks-ids");
    const etcMachineId = path.join(idDir, "etc-machine-id");
    const dbusMachineId = path.join(idDir, "dbus-machine-id");
    fs.writeFileSync(etcMachineId, "11111111111111111111111111111111\n");
    const store = new LinuxConnectionKeyStore({
      stateDir,
      secretToolPaths: [],
      systemdCredsPaths: [],
      machineIdPaths: { etc: etcMachineId, dbus: dbusMachineId },
    });
    await expect(store.checkAvailability()).resolves.toBeUndefined();
    const k1 = await store.getOrCreateKey(ns, true);
    expect(k1.length).toBe(32);
    expect(store.readPinnedBackendForDiagnostics()).toBe("sealed-file");
    const k2 = await new LinuxConnectionKeyStore({
      stateDir,
      secretToolPaths: [],
      systemdCredsPaths: [],
      machineIdPaths: { etc: etcMachineId, dbus: dbusMachineId },
    }).getOrCreateKey(ns, false);
    expect(k2.equals(k1)).toBe(true);

    // Minimal container with no machine-id at creation time: later appearing machine-id must NOT break decryption!
    const containerDir = makeTempDir("linux-ks-container");
    const containerEtc = path.join(idDir, "container-etc-machine-id");
    const containerDbus = path.join(idDir, "container-dbus-machine-id");
    const ck1 = await new LinuxConnectionKeyStore({
      stateDir: containerDir,
      secretToolPaths: [],
      systemdCredsPaths: [],
      machineIdPaths: { etc: containerEtc, dbus: containerDbus },
    }).getOrCreateKey(ns, true);
    fs.writeFileSync(containerEtc, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    const ck2 = await new LinuxConnectionKeyStore({
      stateDir: containerDir,
      secretToolPaths: [],
      systemdCredsPaths: [],
      machineIdPaths: { etc: containerEtc, dbus: containerDbus },
    }).getOrCreateKey(ns, false);
    expect(ck2.equals(ck1)).toBe(true);
  });

  it("refuses silent downgrade to sealed-file when an existing legacy vault exists (prevents bricking)", async () => {
    const stateDir = makeTempDir("linux-ks-legacy");
    fs.writeFileSync(path.join(stateDir, "connection-vault.json"), JSON.stringify({ formatVersion: 1, entries: { a: {} } }));
    const store = new LinuxConnectionKeyStore({
      stateDir,
      secretToolPaths: [],
      systemdCredsPaths: [],
    });
    await expect(store.checkAvailability()).rejects.toMatchObject({ code: "connection_vault_locked" });
    await expect(store.getOrCreateKey(ns, false)).rejects.toMatchObject({ code: "connection_vault_locked" });
  });

  it("supports re-entrant runExclusive without deadlock", async () => {
    const stateDir = makeTempDir("linux-ks-lock");
    const store = new LinuxConnectionKeyStore({
      stateDir,
      secretToolPaths: [],
      systemdCredsPaths: [],
    });
    const result = await store.runExclusive(async () => {
      return await store.runExclusive(async () => {
        const key = await store.getOrCreateKey(ns2, true);
        return key.length;
      });
    });
    expect(result).toBe(32);
  });
});

describe("Cross-platform fs, process, host layout & authoritative lock preservation", () => {
  it("preserves Windows core env variables and resolves .cmd shims safely (CVE-2024-27980)", () => {
    const preserved = preserveWindowsCoreEnv(
      { PATH: "C:\\Tools" },
      { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", TEMP: "C:\\Temp", TMP: "C:\\Temp", SECRET_TOKEN: "must-not-copy" },
      "win32",
    );
    expect(preserved.SystemRoot).toBe("C:\\Windows");
    expect(preserved.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(preserved.SECRET_TOKEN).toBeUndefined();

    const shimDir = makeTempDir("cmd-shim");
    fs.mkdirSync(path.join(shimDir, "node_modules", "pnpm", "bin"), { recursive: true });
    const targetScript = path.join(shimDir, "node_modules", "pnpm", "bin", "pnpm.mjs");
    fs.writeFileSync(targetScript, "console.log('ok');\n");
    const cmdFile = path.join(shimDir, "pnpm.cmd");
    fs.writeFileSync(cmdFile, '@ECHO off\r\n"%dp0%\\node_modules\\pnpm\\bin\\pnpm.mjs" %*\r\n');
    const resolved = resolveCrossPlatformSpawn(cmdFile, ["--version"], { platform: "win32", execPath: "/fake/node.exe" });
    expect(resolved.command).toBe("/fake/node.exe");
    expect(resolved.args[0]).toBe(targetScript);
    expect(resolved.args[1]).toBe("--version");

    // %~dp0 (without trailing %) and bare command name lookup via Windows `;`-delimited PATH
    const dp0Dir = makeTempDir("cmd-dp0-shim");
    fs.mkdirSync(path.join(dp0Dir, "recovery"), { recursive: true });
    const dp0Target = path.join(dp0Dir, "recovery", "bin.js");
    fs.writeFileSync(dp0Target, "console.log('dp0');\n");
    fs.writeFileSync(path.join(dp0Dir, "kulo-tool.cmd"), '@ECHO off\r\n"%~dp0recovery\\bin.js" %*\r\n');
    const resolvedViaPath = resolveCrossPlatformSpawn("kulo-tool.cmd", ["check"], {
      platform: "win32",
      execPath: "/fake/node.exe",
      env: { PATH: `/nonexistent;${dp0Dir}` },
    });
    expect(resolvedViaPath.command).toBe("/fake/node.exe");
    expect(resolvedViaPath.args).toEqual([dp0Target, "check"]);

    // Fallback cmd.exe uses /v:off, quotes !, fixes trailing backslashes, and blocks CR/LF/%VAR%/%~
    const rawBat = path.join(dp0Dir, "plain.bat");
    fs.writeFileSync(rawBat, "@ECHO off\r\necho hi\r\n");
    const batSpawn = resolveCrossPlatformSpawn(rawBat, ["C:\\My Dir\\", "hello!world"], { platform: "win32" });
    expect(batSpawn.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(batSpawn.windowsVerbatimArguments).toBe(true);
    expect(quoteWindowsCmdArg("C:\\My Dir\\")).toBe('"C:\\My Dir\\\\"');
    expect(quoteWindowsCmdArg("a!b")).toBe('"a!b"');
    expect(() => quoteWindowsCmdArg("bad\narg")).toThrow(/newline/i);
    expect(() => quoteWindowsCmdArg("%PATH%")).toThrow(/variable expansion/i);
    expect(() => quoteWindowsCmdArg("%~dp0")).toThrow(/variable expansion/i);

    // supervisedCommand preserves argv positions while passing windowsVerbatimArguments to inner spawn
    const supervised = supervisedCommand([batSpawn.command, ...batSpawn.args], dp0Dir, undefined, {
      windowsVerbatimArguments: true,
    });
    expect(JSON.parse(supervised[5]!)).toEqual({
      command: [batSpawn.command, ...batSpawn.args],
      windowsVerbatimArguments: true,
    });

    // POSIX peer bootstrap script normalizes trailing slashes on KULO_PEER_HUB_URL
    const shScript = renderPeerInstaller("posix");
    expect(shScript).toContain('KULO_PEER_HUB_URL=${KULO_PEER_HUB_URL%/}');

    // Non-existent SystemRoot falls back to tar.exe; POSIX resolves to tar.
    expect(resolveSystemTarExecutable("win32", { SystemRoot: "C:\\NonExistentWindows" })).toBe("tar.exe");
    expect(resolveSystemTarExecutable("linux", {})).toBe("tar");
  });

  it("resolves unified host data dirs and persists runtime-token & runtime-port atomically", () => {
    expect(resolveDefaultHostDataDir({ platform: "darwin", homeDir: "/Users/alice", channel: "release" }))
      .toBe("/Users/alice/Library/Application Support/Kulo");
    expect(resolveDefaultHostDataDir({ platform: "win32", homeDir: "C:\\Users\\alice", env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, channel: "release" }))
      .toBe(path.win32.join("C:\\Users\\alice\\AppData\\Roaming", "Kulo"));
    expect(resolveDefaultHostDataDir({ platform: "linux", homeDir: "/home/alice", env: { XDG_CONFIG_HOME: "/srv/xdg" }, channel: "release" }))
      .toBe("/srv/xdg/Kulo");
    expect(resolveDefaultHostDataDir({ platform: "linux", homeDir: "/home/alice", env: {}, channel: "dev" }))
      .toBe("/home/alice/.config/Kulo Dev");

    const dataDir = makeTempDir("host-layout");
    const layout = resolveKuloHostLayout(dataDir);
    expect(readExistingHostRuntimeToken(layout.tokenPath)).toBeUndefined();
    const token = ensureHostRuntimeToken(layout);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(readExistingHostRuntimeToken(layout.tokenPath)).toBe(token);
    expect(readHostRuntimePort(layout)).toBe(0);
    saveHostRuntimePort(layout, 18442);
    expect(readHostRuntimePort(layout)).toBe(18442);
    // Re-saving same port is idempotent; conflicting port throws
    saveHostRuntimePort(layout, 18442);
    expect(() => saveHostRuntimePort(layout, 18443)).toThrow("不一致");
  });

  it("exports canonical kulo-runtime and hub lock file names", () => {
    expect(KULO_RUNTIME_INSTANCE_FILES).toContain("kulo-runtime-owner.sqlite");
    expect(KULO_RUNTIME_INSTANCE_FILES).toContain("kulo-runtime-owner.sqlite-wal");
    expect(KULO_RUNTIME_INSTANCE_FILES).toContain("kulo-runtime-endpoint.json");
    expect(HUB_STATE_LOCK_FILES).toContain("hub-owner.sqlite");
  });

  it("removes readonly trees cleanly", () => {
    const root = makeTempDir("ro-tree");
    const nested = path.join(root, "sub");
    fs.mkdirSync(nested);
    const file = path.join(nested, "locked.txt");
    fs.writeFileSync(file, "readonly");
    fs.chmodSync(file, 0o444);
    fs.chmodSync(nested, 0o555);
    removeReadonlyTreeSync(root);
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe("Windows granular isolation policy & capability routing", () => {
  it("allows ordinary tasks on Windows basic LPAC isolation and fails closed on strict network policies", () => {
    const basicPolicy = buildWindowsSandboxPolicy({
      workspaceDir: "C:\\Users\\alice\\project",
      temporaryDir: "C:\\Users\\alice\\AppData\\Local\\Temp\\kulo-tmp",
      executable: "C:\\Users\\alice\\AppData\\Local\\Programs\\Kulo\\resources\\runtime\\node.exe",
      protectedPaths: ["C:\\Users\\alice\\.ssh"],
      port: 3000,
      networkBackend: "basic",
    });
    expect(basicPolicy.network.backend).toBe("basic");
    expect(basicPolicy.network.localConnectPorts).toEqual([]);
    expect(basicPolicy.network.localListenPorts).toEqual([]);

    expect(() =>
      buildWindowsSandboxPolicy({
        workspaceDir: "C:\\Users\\alice\\project",
        temporaryDir: "C:\\Users\\alice\\AppData\\Local\\Temp\\kulo-tmp",
        executable: "C:\\Users\\alice\\AppData\\Local\\Programs\\Kulo\\resources\\runtime\\node.exe",
        protectedPaths: [],
        port: 3000,
        networkBackend: "basic",
        network: { offline: true },
      }),
    ).toThrow(/WFP/i);

    expect(() =>
      buildWindowsSandboxPolicy({
        workspaceDir: "C:\\Users\\alice\\project",
        temporaryDir: "C:\\Users\\alice\\AppData\\Local\\Temp\\kulo-tmp",
        executable: "C:\\Users\\alice\\AppData\\Local\\Programs\\Kulo\\resources\\runtime\\node.exe",
        protectedPaths: [],
        port: 3000,
        networkBackend: "basic",
        network: { localConnectPorts: [5432] },
      }),
    ).toThrow(/WFP/i);

    const wfpPolicy = buildWindowsSandboxPolicy({
      workspaceDir: "C:\\Users\\alice\\project",
      temporaryDir: "C:\\Users\\alice\\AppData\\Local\\Temp\\kulo-tmp",
      executable: "C:\\Users\\alice\\AppData\\Local\\Programs\\Kulo\\resources\\runtime\\node.exe",
      protectedPaths: [],
      port: 3000,
      networkBackend: "wfp",
      network: { offline: true, localConnectPorts: [5432] },
    });
    expect(wfpPolicy.network.backend).toBe("wfp");
    expect(wfpPolicy.network.offline).toBe(true);
    expect(wfpPolicy.network.localConnectPorts).toEqual([5432]);
  });

  it("distinguishes basic vs strict worker isolation capabilities cleanly", () => {
    const basicCaps = ["fs", "bash", "worker-isolation-basic", "worker-wfp-setup-required"];
    const fullCaps = ["fs", "bash", "worker-isolation", "worker-wfp-network"];
    const brokenCaps = ["fs", "bash", "worker-isolation-unavailable"];
    expect(hasWorkerBasicOrFullIsolation(basicCaps)).toBe(true);
    expect(hasWorkerStrictNetworkIsolation(basicCaps)).toBe(false);
    expect(hasWorkerBasicOrFullIsolation(fullCaps)).toBe(true);
    expect(hasWorkerStrictNetworkIsolation(fullCaps)).toBe(true);
    expect(hasWorkerBasicOrFullIsolation(brokenCaps)).toBe(false);

    expect(hasWorkerIsolation({ id: "w1", name: "WinPC", kind: "reverse-ws", online: true, platform: "win32", arch: "x64", rootDir: "C:\\Work", capabilities: basicCaps, connectedAt: 1, lastSeenAt: 1 })).toBe(true);
    expect(hasWorkerIsolation({ id: "w2", name: "BrokenPC", kind: "reverse-ws", online: true, platform: "win32", arch: "x64", rootDir: "C:\\Work", capabilities: brokenCaps, connectedAt: 1, lastSeenAt: 1 })).toBe(false);
  });
});

describe("Desktop shell cross-platform helpers, Attach Mode & packaging", () => {
  it("resolves cross-platform node, rescue, window icon, and tray icon paths", () => {
    const assetsDir = fileURLToPath(new URL("../packages/desktop/assets", import.meta.url));
    expect(resolvePackagedNodePath("/res", "win32")).toBe(path.join("/res", "runtime", "node.exe"));
    expect(resolvePackagedNodePath("/res", "linux")).toBe(path.join("/res", "runtime", "node"));
    expect(resolvePackagedRescuePath("/res", "win32")).toBe(path.join("/res", "runtime", "kulo-rescue.cmd"));
    expect(resolvePackagedRescuePath("/res", "darwin")).toBe(path.join("/res", "runtime", "kulo-rescue"));
    expect(resolveWindowIconPath(assetsDir, "darwin")).toBeUndefined();
    expect(resolveWindowIconPath(assetsDir, "win32")).toBe(path.join(assetsDir, "kulo.ico"));
    expect(resolveWindowIconPath(assetsDir, "linux")).toBe(path.join(assetsDir, "kulo-icon.png"));

    expect(resolveDesktopTrayIconChoice(assetsDir, "darwin", false, true)).toEqual({
      iconPath: path.join(assetsDir, "kulo-trayTemplate.png"),
      template: true,
    });
    expect(resolveDesktopTrayIconChoice(assetsDir, "win32", false, true)).toEqual({
      iconPath: path.join(assetsDir, "kulo-tray-dark.png"),
      template: false,
    });
    expect(resolveDesktopTrayIconChoice(assetsDir, "linux", false, false)).toEqual({
      iconPath: path.join(assetsDir, "kulo-tray-light.png"),
      template: false,
    });
  });

  it("refreshes non-macOS tray icon on theme change even when badgeCount is 0", () => {
    let dark = false;
    const setImage = vi.fn();
    const tray: ManagedTray = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      setImage,
      on: vi.fn(),
      destroy: vi.fn(),
      isDestroyed: () => false,
    };
    const controller = createDesktopTrayController({
      appName: "Kulo",
      platform: "win32",
      createTray: () => tray,
      resolveIcon: (badge) => `${badge ? "badge" : "plain"}-${dark ? "dark" : "light"}`,
      buildMenu: (t) => t,
      onFocusWindow: vi.fn(),
      onNewTopic: vi.fn(),
      onOpenSettings: vi.fn(),
      onQuit: vi.fn(),
    });
    controller.sync(true);
    expect(setImage).toHaveBeenLastCalledWith("plain-light");
    dark = true;
    controller.refreshTheme();
    expect(setImage).toHaveBeenLastCalledWith("plain-dark");
    controller.dispose();
  });

  it("attaches to an already-running external host runtime when token and endpoint match", async () => {
    const dataDir = makeTempDir("attach-mode");
    const token = "a".repeat(64);
    const attached = await tryAttachExternalHostRuntime(dataDir, {
      readToken: () => token,
      discover: async () => ({ url: new URL("http://127.0.0.1:7799/") }),
    });
    expect(attached).toEqual({ url: "http://127.0.0.1:7799", token });

    const missing = await tryAttachExternalHostRuntime(dataDir, {
      readToken: () => undefined,
      discover: vi.fn(),
    });
    expect(missing).toBeUndefined();
  });

  it("ships valid Windows kulo.ico and light/dark non-template tray PNG assets", () => {
    const assetsDir = fileURLToPath(new URL("../packages/desktop/assets", import.meta.url));
    const ico = fs.readFileSync(path.join(assetsDir, "kulo.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(7); // 16..256 frames
    for (const [name, size] of [
      ["kulo-tray-light.png", 22],
      ["kulo-tray-light@2x.png", 44],
      ["kulo-tray-dark.png", 22],
      ["kulo-tray-dark@2x.png", 44],
    ] as const) {
      const png = fs.readFileSync(path.join(assetsDir, name));
      expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });

  it("materializes Windows node_modules without symlinks and breaks hoisted self-link safely", async () => {
    const stage = makeTempDir("win-materialize");
    const storePkg = path.join(stage, "node_modules/.pnpm/demo@1.0.0/node_modules/demo");
    await fsp.mkdir(storePkg, { recursive: true });
    await fsp.writeFile(path.join(storePkg, "index.js"), "export const ok = 1;\n");
    await fsp.mkdir(path.join(stage, "node_modules/.pnpm/node_modules/@kulo"), { recursive: true });
    // Hoisted self-link pointing back to stage root (must be removed, not copied recursively!)
    await fsp.symlink(stage, path.join(stage, "node_modules/.pnpm/node_modules/@kulo/desktop"), "dir");
    // Normal internal dependency symlink
    await fsp.symlink(".pnpm/demo@1.0.0/node_modules/demo", path.join(stage, "node_modules/demo"), "dir");

    await materializeWindowsNodeModules(stage, stage);
    expect(fs.existsSync(path.join(stage, "node_modules/.pnpm/node_modules/@kulo/desktop"))).toBe(false);
    const demoStat = await fsp.lstat(path.join(stage, "node_modules/demo"));
    expect(demoStat.isDirectory()).toBe(true);
    expect(demoStat.isSymbolicLink()).toBe(false);
    expect(await fsp.readFile(path.join(stage, "node_modules/demo/index.js"), "utf8")).toContain("ok = 1");
  });

  it("prepares Linux agent-desktop clipboard owner binary at exact unsuffixed path", async () => {
    const root = makeTempDir("linux-agent-cli");
    await fsp.writeFile(path.join(root, "package.json"), '{"name":"env-fixture"}');
    const browser = path.join(root, "node_modules/agent-browser");
    const desktop = path.join(root, "node_modules/agent-desktop");
    const platformBrowser = path.join(root, "node_modules/@agent-browser/cli-linux-x64");
    await Promise.all([
      path.join(browser, "bin"),
      path.join(browser, "scripts"),
      path.join(desktop, "bin"),
      path.join(platformBrowser, "bin"),
    ].map((d) => fsp.mkdir(d, { recursive: true })));
    await fsp.writeFile(path.join(browser, "package.json"), JSON.stringify({ name: "agent-browser", type: "module", bin: { "agent-browser": "bin/agent-browser.js" } }));
    await fsp.writeFile(path.join(browser, "scripts/native.js"), `export function nativeTarget(p, a) { return p + "-" + a; } export function findNativeBinary(dir, target) { return dir + "/../@agent-browser/cli-" + target + "/bin/agent-browser"; }\n`);
    await fsp.writeFile(path.join(platformBrowser, "bin/agent-browser"), "linux-browser-bin");
    await fsp.writeFile(path.join(desktop, "package.json"), JSON.stringify({ name: "agent-desktop", bin: { "agent-desktop": "bin/agent-desktop" } }));
    await fsp.writeFile(path.join(desktop, "bin/agent-desktop-linux-x64"), "linux-desktop-bin");
    await fsp.writeFile(path.join(desktop, "bin/agent-desktop-linux-clipboard-owner-linux-x64"), "linux-clip-helper");

    await prepareAgentClis(root, { platform: "linux", arch: "x64" });
    expect(await fsp.readFile(path.join(desktop, "bin/agent-desktop-linux-clipboard-owner"), "utf8")).toBe("linux-clip-helper");
    const desktopManifest = JSON.parse(await fsp.readFile(path.join(desktop, "package.json"), "utf8"));
    expect(desktopManifest.bin["agent-desktop"]).toBe("./bin/agent-desktop-linux-x64");
  });

  it("enforces required connector broker & SHA-256 verification when requested", async () => {
    const root = makeTempDir("connector-strict");
    const source = path.join(root, "source");
    const payload = path.join(root, "payload");
    const hub = path.join(payload, "node_modules/@kulo/hub");
    await fsp.mkdir(path.join(source, "packages/hub/native"), { recursive: true });
    await fsp.mkdir(path.join(hub, "dist"), { recursive: true });
    await fsp.writeFile(path.join(payload, "package.json"), '{"name":"p","type":"module"}');
    await fsp.writeFile(path.join(hub, "package.json"), '{"name":"@kulo/hub","type":"module","main":"dist/index.js"}');
    await fsp.writeFile(path.join(hub, "dist/index.js"), "export {};\n");

    await expect(
      preserveConnectorBroker(payload, { workspaceRoot: source, platform: "linux", arch: "x64", required: true }),
    ).rejects.toThrow("缺少必需的手机连接模块");

    const brokerBytes = Buffer.from("fake-linux-broker");
    const brokerPath = path.join(source, "packages/hub/native/kulo-connector-linux-x64");
    await fsp.writeFile(brokerPath, brokerBytes);
    await fsp.chmod(brokerPath, 0o755);
    const manifestPath = path.join(root, "manifest.json");
    await fsp.writeFile(manifestPath, JSON.stringify({
      formatVersion: 1,
      binaries: { "linux-x64": { filename: "kulo-connector-linux-x64", sha256: "0".repeat(64) } },
    }));

    await expect(
      preserveConnectorBroker(payload, {
        workspaceRoot: source,
        platform: "linux",
        arch: "x64",
        required: true,
        verifyManifest: true,
        connectorManifestPath: manifestPath,
      }),
    ).rejects.toThrow("SHA-256 校验失败");

    // Matching digest passes
    const goodDigest = createHash("sha256").update(brokerBytes).digest("hex");
    await fsp.writeFile(manifestPath, JSON.stringify({
      formatVersion: 1,
      binaries: { "linux-x64": { filename: "kulo-connector-linux-x64", sha256: goodDigest } },
    }));
    await expect(
      preserveConnectorBroker(payload, {
        workspaceRoot: source,
        platform: "linux",
        arch: "x64",
        required: true,
        verifyManifest: true,
        connectorManifestPath: manifestPath,
      }),
    ).resolves.toBeUndefined();
  });

  it("renders Linux CLI and headless runtime wrappers accurately", () => {
    const cli = renderLinuxCliWrapper("/opt/Kulo", "Kulo");
    expect(cli).toContain("host|hub|dev|open|join|env|chat");
    expect(cli).toContain('exec "$KULO_NODE" "$KULO_CLI" "$@"');
    expect(cli).toContain('exec "$KULO_INSTALL_DIR/Kulo" "$@"');

    const host = renderLinuxRuntimeHostWrapper();
    expect(host).toContain("headless-host.js");
  });
});
