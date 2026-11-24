# Avoid param([Parameter(...)]) so PowerShell never activates [CmdletBinding()] prefix parameter binding
# that would otherwise intercept child flags like -e, -c, -v, -d, or -w.
if ($args.Count -lt 1 -or [string]::IsNullOrWhiteSpace([string]$args[0])) {
  [Console]::Error.WriteLine("windows-job-runner.ps1 requires an executable path")
  exit 2
}
$Executable = [string]$args[0]
[string[]]$ChildArgs = if ($args.Count -gt 1) { [string[]]($args[1..($args.Count - 1)]) } else { [string[]]@() }

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class KuloNativeJobRunner {
  private const int JobObjectExtendedLimitInformation = 9;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  private const uint CREATE_SUSPENDED = 0x00000004;
  private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  private const uint STARTF_USESTDHANDLES = 0x00000100;
  private const uint WAIT_TIMEOUT = 0x00000102;
  private const uint WAIT_OBJECT_0 = 0x00000000;

  [StructLayout(LayoutKind.Sequential)]
  private struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct EXTENDED_LIMIT {
    public BASIC_LIMIT BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public uint dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref EXTENDED_LIMIT info, uint cbInfo);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr GetStdHandle(int nStdHandle);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcess(
    string lpApplicationName,
    StringBuilder lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr hThread);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr hObject);

  private static string Quote(string arg) {
    if (string.IsNullOrEmpty(arg)) return "\"\"";
    if (arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
    var sb = new StringBuilder();
    sb.Append('"');
    int backslashes = 0;
    foreach (char c in arg) {
      if (c == '\\') { backslashes++; continue; }
      if (c == '"') {
        sb.Append('\\', backslashes * 2 + 1);
        sb.Append('"');
        backslashes = 0;
        continue;
      }
      if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
      sb.Append(c);
    }
    if (backslashes > 0) sb.Append('\\', backslashes * 2);
    sb.Append('"');
    return sb.ToString();
  }

  public static int Run(string executable, string[] args) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    PROCESS_INFORMATION proc = new PROCESS_INFORMATION();
    bool assigned = false;
    try {
      EXTENDED_LIMIT limits = new EXTENDED_LIMIT();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      STARTUPINFO startup = new STARTUPINFO();
      startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      startup.dwFlags = STARTF_USESTDHANDLES;
      startup.hStdInput = GetStdHandle(-10);
      startup.hStdOutput = GetStdHandle(-11);
      startup.hStdError = GetStdHandle(-12);

      var cmd = new StringBuilder(Quote(executable));
      if (args != null) {
        foreach (string a in args) cmd.Append(' ').Append(Quote(a));
      }
      if (!CreateProcess(executable, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref startup, out proc)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      if (!AssignProcessToJobObject(job, proc.hProcess)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      assigned = true;
      if (ResumeThread(proc.hThread) == UInt32.MaxValue) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      uint wait;
      do { wait = WaitForSingleObject(proc.hProcess, 250); } while (wait == WAIT_TIMEOUT);
      if (wait != WAIT_OBJECT_0) return 1;
      uint exitCode;
      if (!GetExitCodeProcess(proc.hProcess, out exitCode)) return 1;
      return unchecked((int)exitCode);
    } finally {
      if (proc.hProcess != IntPtr.Zero && !assigned) TerminateProcess(proc.hProcess, 1);
      TerminateJobObject(job, 1);
      if (proc.hThread != IntPtr.Zero) CloseHandle(proc.hThread);
      if (proc.hProcess != IntPtr.Zero) CloseHandle(proc.hProcess);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
"@

$code = [KuloNativeJobRunner]::Run($Executable, $ChildArgs)
exit $code
