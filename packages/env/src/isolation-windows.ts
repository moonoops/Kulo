import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

declare const MOCO_WINDOWS_SANDBOX_SOURCE: string | undefined;

export interface WindowsSandboxOptions {
  workspaceDir: string;
  workspaceRoot?: string;
  managedScratchRoot?: string;
  scratchDir?: string;
  temporaryDir: string;
  executable: string;
  readOnly?: boolean;
  runtimePaths?: readonly string[];
  protectedPaths: readonly string[];
  writeDeniedPaths?: readonly string[];
  port: number;
  network?: { localConnectPorts?: readonly number[]; localListenPorts?: readonly number[]; offline?: boolean };
}

export interface WindowsSandboxPolicy {
  version: 1;
  workspaceDir: string;
  workspaceRoot?: string;
  managedScratchRoot?: string;
  scratchDir?: string;
  temporaryDir: string;
  executable: string;
  readOnly: boolean;
  runtimePaths?: string[];
  protectedPaths: string[];
  writeDeniedPaths?: string[];
  port: number;
  network: { backend: "wfp"; localConnectPorts: number[]; localListenPorts: number[]; offline?: boolean };
}

const controlDirectories = new Map<string, string>();
const localDrivePath = /^[a-zA-Z]:[\\/]/;
const uncPath = /^\\\\[^\\/?]+\\[^\\/?]+/;

function localWindowsPath(value: string): string {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || !localDrivePath.test(value)) {
    throw new Error("Windows sandbox requires an absolute local drive path");
  }
  if (value.slice(2).includes(":")) throw new Error("Windows sandbox cannot authorize an alternate data stream");
  const normalized = path.win32.normalize(value);
  if (normalized === path.win32.parse(normalized).root) {
    throw new Error("Windows sandbox cannot authorize a drive root");
  }
  return normalized;
}

function windowsProtectedPaths(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => localDrivePath.test(value) || uncPath.test(value)).map((value) => {
    if (/[\x00-\x1f\x7f]/.test(value) || /^\\\\[?.]\\/.test(value)) throw new Error("Invalid Windows private resource path");
    return path.win32.normalize(value);
  }))];
}

function ports(values: readonly number[]): number[] {
  if (values.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Worker network capabilities require explicit TCP ports from 1 to 65535");
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function buildWindowsSandboxPolicy(options: WindowsSandboxOptions): WindowsSandboxPolicy {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid Worker development port");
  return {
    version: 1,
    workspaceDir: localWindowsPath(options.workspaceDir),
    ...(options.workspaceRoot ? { workspaceRoot: localWindowsPath(options.workspaceRoot) } : {}),
    ...(options.managedScratchRoot ? { managedScratchRoot: localWindowsPath(options.managedScratchRoot) } : {}),
    ...(options.scratchDir ? { scratchDir: localWindowsPath(options.scratchDir) } : {}),
    temporaryDir: localWindowsPath(options.temporaryDir),
    executable: localWindowsPath(options.executable),
    readOnly: Boolean(options.readOnly),
    ...(options.runtimePaths?.length ? { runtimePaths: options.runtimePaths.map(localWindowsPath) } : {}),
    protectedPaths: windowsProtectedPaths(options.protectedPaths),
    ...(options.writeDeniedPaths?.length ? { writeDeniedPaths: windowsProtectedPaths(options.writeDeniedPaths) } : {}),
    port: options.port,
    network: {
      backend: "wfp",
      localConnectPorts: ports(options.network?.localConnectPorts ?? []),
      localListenPorts: ports([options.port, ...(options.network?.localListenPorts ?? [])]),
      ...(options.network?.offline ? { offline: true } : {}),
    },
  };
}

function nativePowerShell(): string {
  const systemRoot = process.platform === "win32" ? process.env.SystemRoot ?? "C:\\Windows" : "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function privateControlDirectory(): string {
  if (process.platform !== "win32") return fs.mkdtempSync(path.join(os.tmpdir(), "moco-windows-control-"));
  const directory = localWindowsPath(path.join(os.tmpdir(), `moco-windows-control-${randomUUID()}`));
  const encodedPath = Buffer.from(directory, "utf8").toString("base64");
  // Windows ignores mkdir's POSIX mode. Create with a protected DACL atomically, before writing code;
  // a previous Worker may already have Modify access to the surrounding temporary directory.
  const source = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MocoPrivateControlDirectory {
  [StructLayout(LayoutKind.Sequential)] public struct Attributes { public int Length; public IntPtr Descriptor; public int Inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateDirectory(string path, ref Attributes attributes);
}
'@
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$security=New-Object Security.AccessControl.DirectorySecurity
$security.SetSecurityDescriptorSddlForm('O:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)')
$bytes=$security.GetSecurityDescriptorBinaryForm()
$memory=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes,0,$memory,$bytes.Length)
  $attributes=New-Object MocoPrivateControlDirectory+Attributes
  $attributes.Length=[Runtime.InteropServices.Marshal]::SizeOf($attributes)
  $attributes.Descriptor=$memory
  $directory=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
  if(-not [MocoPrivateControlDirectory]::CreateDirectory($directory,[ref]$attributes)) { throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error())) }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($memory) }
`;
  const result = spawnSync(nativePowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Cannot create a protected Windows sandbox launcher directory");
  return directory;
}

function launcherCommand(policyArgument: string): readonly string[] {
  const source = typeof MOCO_WINDOWS_SANDBOX_SOURCE === "string"
    ? MOCO_WINDOWS_SANDBOX_SOURCE
    : fs.readFileSync(fileURLToPath(new URL("../native/windows-sandbox.ps1", import.meta.url)), "utf8");
  const directory = privateControlDirectory();
  const script = path.join(directory, "windows-sandbox.ps1");
  try {
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(script, source, { flag: "wx", mode: 0o400 });
    controlDirectories.set(script, directory);
    // The helper is outside Worker-writable temp and denies its control directory to every launched SID.
    // Host ExecutionPolicy remains in force. The child receives only an explicit environment whitelist.
    return [nativePowerShell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, policyArgument];
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function createWindowsSandboxCommand(options: WindowsSandboxOptions): readonly string[] {
  const policy = Buffer.from(JSON.stringify(buildWindowsSandboxPolicy(options)), "utf8").toString("base64");
  if (policy.length > 24_000) throw new Error("Windows sandbox policy exceeds the process command line limit");
  return launcherCommand(policy);
}

/** Runs the native prerequisites check; the caller must report its exit status and output. */
export function createWindowsSandboxSetupCommand(): readonly string[] {
  return launcherCommand("--setup");
}

/** Call only after the trusted launcher has exited, including failed startup. */
export function cleanupWindowsSandboxCommand(command: readonly string[]): void {
  const script = command[5];
  if (!script) return;
  const directory = controlDirectories.get(script);
  if (!directory) return;
  if (process.platform === "win32") {
    const result = spawnSync(command[0]!, [...command.slice(1, 6), "--cleanup"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error("Windows sandbox permissions cleanup is pending; retained the native cleanup helper for retry");
  }
  fs.rmSync(directory, { recursive: true, force: true });
  controlDirectories.delete(script);
}
