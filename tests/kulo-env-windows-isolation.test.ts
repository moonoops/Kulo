import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildWindowsSandboxPolicy, cleanupWindowsSandboxCommand, createWindowsSandboxCommand, createWindowsSandboxSetupCommand, type WindowsSandboxOptions } from "../packages/env/src/isolation-windows.js";

const options: WindowsSandboxOptions = {
  workspaceDir: "C:\\Projects\\示例 app",
  scratchDir: "C:\\Kulo\\scratch\\T-1",
  temporaryDir: "C:\\Kulo\\temp\\run-1",
  executable: "C:\\Kulo\\runtime\\pi-env.exe",
  protectedPaths: ["C:\\Kulo\\private", "C:\\Users\\user\\.ssh"],
  port: 43129,
};

describe("Windows Worker isolation policy", () => {
  it("preserves local directory boundaries, read-only mode and the allocated development port", () => {
    const policy = buildWindowsSandboxPolicy({ ...options, readOnly: true });
    expect(policy.workspaceDir).toBe(options.workspaceDir);
    expect(policy.readOnly).toBe(true);
    expect(policy.network).toEqual({ backend: "wfp", localConnectPorts: [], localListenPorts: [options.port] });
    expect(policy.protectedPaths).toEqual(options.protectedPaths);
  });

  it.each(["relative\\repo", "C:\\", "\\\\server\\share\\repo", "\\\\?\\C:\\repo", "C:\\repo\nother"])("rejects non-local or overly broad path %s", (workspaceDir) => {
    expect(() => buildWindowsSandboxPolicy({ ...options, workspaceDir })).toThrow(/absolute local drive|drive root/);
  });

  it("records exact TCP grants and rejects wildcard or invalid ports", () => {
    expect(buildWindowsSandboxPolicy({ ...options, network: { localConnectPorts: [7788, 7788, 443], localListenPorts: [43129, 5001] } }).network)
      .toEqual({ backend: "wfp", localConnectPorts: [443, 7788], localListenPorts: [5001, 43129] });
    expect(() => buildWindowsSandboxPolicy({ ...options, network: { localConnectPorts: [0] } })).toThrow("explicit TCP ports");
    expect(() => buildWindowsSandboxPolicy({ ...options, network: { localListenPorts: [65536] } })).toThrow("explicit TCP ports");
  });

  it("keeps target-native private paths when a macOS Hub also supplies its own paths", () => {
    expect(buildWindowsSandboxPolicy({ ...options, protectedPaths: [...options.protectedPaths, "/Users/hub/.ssh", "\\\\nas\\private\\secrets"] }).protectedPaths)
      .toEqual([...options.protectedPaths, "\\\\nas\\private\\secrets"]);
  });

  it("passes metadata as one encoded argument without PowerShell interpolation or policy bypass", () => {
    const command = createWindowsSandboxCommand({ ...options, workspaceDir: "C:\\Projects\\literal $(Get-Content private) `text`" });
    try {
      expect(command.slice(1, 5)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
      expect(command).not.toContain("-ExecutionPolicy");
      const policy = JSON.parse(Buffer.from(command.at(-1)!, "base64").toString("utf8"));
      expect(policy.workspaceDir).toContain("$(Get-Content private)");
      expect(command.join(" ")).not.toContain("$(Get-Content private)");
      expect(command).not.toContain("serve");
      expect(fs.readFileSync(command[5]!, "utf8")).toBe(fs.readFileSync(new URL("../packages/env/native/windows-sandbox.ps1", import.meta.url), "utf8"));
      expect(path.dirname(command[5]!)).not.toBe(options.temporaryDir);
    } finally { cleanupWindowsSandboxCommand(command); }
    expect(fs.existsSync(command[5]!)).toBe(false);
    expect(() => cleanupWindowsSandboxCommand(command)).not.toThrow();
  });

  it("provides a separate prerequisite check and cleans only module-owned helper directories", () => {
    const command = createWindowsSandboxSetupCommand();
    const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-windows-unrelated-"));
    try {
      expect(command.at(-1)).toBe("--setup");
      cleanupWindowsSandboxCommand(["powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-File", unrelated]);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      cleanupWindowsSandboxCommand(command);
      fs.rmSync(unrelated, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform !== "win32")("runs native commands with project-only access, read-only projects and a clean environment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-windows-isolation-"));
    const workspaceDir = path.join(root, "project");
    const scratchDir = path.join(root, "scratch");
    const outside = path.join(root, "private.txt");
    const protectedDir = path.join(workspaceDir, "private");
    const protectedFile = path.join(protectedDir, "credentials.json");
    fs.mkdirSync(workspaceDir); fs.mkdirSync(scratchDir);
    fs.mkdirSync(protectedDir);
    fs.writeFileSync(outside, "host-private-canary");
    fs.writeFileSync(protectedFile, "nested-private-canary");
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const run = (readOnly: boolean, source: string) => {
      const temporaryDir = fs.mkdtempSync(path.join(root, "run-"));
      const command = createWindowsSandboxCommand({ workspaceDir, scratchDir, temporaryDir, executable: powershell, protectedPaths: [outside, protectedFile], readOnly, port: options.port });
      try {
        return spawnSync(command[0]!, [...command.slice(1), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
          cwd: workspaceDir, encoding: "utf8", timeout: 45_000, env: { ...process.env, KULO_AUTH_TOKEN: "must-not-inherit-canary" },
        });
      } finally { cleanupWindowsSandboxCommand(command); }
    };
    try {
      const writable = run(false, `$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('allowed.txt','ok'); try { [IO.File]::ReadAllText(${psLiteral(outside)}); exit 21 } catch {} ; try { [IO.File]::WriteAllText(${psLiteral(protectedFile)},'overwrite'); exit 22 } catch {} ; if ($env:KULO_AUTH_TOKEN) { exit 23 }; try { [IO.Directory]::Move('private','renamed'); exit 24 } catch {}; [Console]::Out.Write('WINDOWS_ISOLATION_OK')`);
      expect(writable.status, writable.stderr).toBe(0);
      expect(writable.stdout).toContain("WINDOWS_ISOLATION_OK");
      expect(fs.readFileSync(protectedFile, "utf8")).toBe("nested-private-canary");
      const readOnly = run(true, `$ErrorActionPreference='Stop'; try { [IO.File]::WriteAllText('allowed.txt','overwrite'); exit 31 } catch {}; [IO.File]::WriteAllText(${psLiteral(path.join(scratchDir, "notes.txt"))},'scratch'); [Console]::Out.Write('WINDOWS_READ_ONLY_OK')`);
      expect(readOnly.status, readOnly.stderr).toBe(0);
      expect(readOnly.stdout).toContain("WINDOWS_READ_ONLY_OK");
      expect(fs.readFileSync(path.join(workspaceDir, "allowed.txt"), "utf8")).toBe("ok");
      expect(fs.readFileSync(path.join(scratchDir, "notes.txt"), "utf8")).toBe("scratch");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "win32")("enforces exact native host connections and localhost development listeners", async () => {
    const allowed = net.createServer(), blocked = net.createServer(), reservation = net.createServer(), deniedReservation = net.createServer();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-windows-network-"));
    let command: readonly string[] | undefined;
    try {
      for (const server of [allowed, blocked, reservation, deniedReservation]) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
      const serverPort = (server: net.Server) => (server.address() as net.AddressInfo).port;
      const allowedPort = serverPort(allowed), blockedPort = serverPort(blocked), listenPort = serverPort(reservation), deniedListenPort = serverPort(deniedReservation);
      await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => deniedReservation.close((error) => error ? reject(error) : resolve()));
      const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const workspaceDir = path.join(root, "project"), temporaryDir = path.join(root, "temp");
      fs.mkdirSync(workspaceDir); fs.mkdirSync(temporaryDir);
      command = createWindowsSandboxCommand({ workspaceDir, temporaryDir, executable: powershell, protectedPaths: [], port: listenPort, network: { localConnectPorts: [allowedPort] } });
      const source = `$ErrorActionPreference='Stop'; function CanConnect($port) { $c=New-Object Net.Sockets.TcpClient; try { $task=$c.ConnectAsync('127.0.0.1',$port); if(-not $task.Wait(1500)) { return $false }; return $c.Connected } catch { return $false } finally { $c.Dispose() } }; if(-not (CanConnect ${allowedPort})) { exit 41 }; if(CanConnect ${blockedPort}) { exit 42 }; $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,${listenPort}); $listener.Start(); $listener.Stop(); try { $denied=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,${deniedListenPort}); $denied.Start(); $denied.Stop(); exit 43 } catch {}; [Console]::Out.Write('WINDOWS_NETWORK_OK')`;
      const result = spawnSync(command[0]!, [...command.slice(1), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { encoding: "utf8", timeout: 45_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("WINDOWS_NETWORK_OK");
    } finally {
      if (command) cleanupWindowsSandboxCommand(command);
      for (const server of [allowed, blocked, reservation, deniedReservation]) server.close();
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
