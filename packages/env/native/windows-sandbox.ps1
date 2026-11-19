$ErrorActionPreference = 'Stop'
if ($args.Length -lt 1) { throw 'Missing Windows sandbox policy.' }
$setup = [string]$args[0] -eq '--setup'
$cleanup = [string]$args[0] -eq '--cleanup'
if (-not $setup -and -not $cleanup) {
  $policy = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$args[0])) | ConvertFrom-Json
  if ($policy.version -ne 1 -or $policy.network.backend -ne 'wfp') { throw 'Unsupported Windows sandbox policy.' }
}
$childArguments = @()
if ($args.Length -gt 1) { $childArguments = [string[]]$args[1..($args.Length - 1)] }

# This host retains the Job Object handle; the restricted child receives only its three stdio handles.
Add-Type -Language CSharp -ReferencedAssemblies 'System.Web.Extensions' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace MocoSandbox {
  public sealed class Policy {
    public int version { get; set; }
    public string workspaceDir { get; set; }
    public string workspaceRoot { get; set; }
    public string managedScratchRoot { get; set; }
    public string scratchDir { get; set; }
    public string temporaryDir { get; set; }
    public string executable { get; set; }
    public bool readOnly { get; set; }
    public string[] runtimePaths { get; set; }
    public string[] protectedPaths { get; set; }
    public string[] writeDeniedPaths { get; set; }
    public int port { get; set; }
    public NetworkPolicy network { get; set; }
    public string controlDirectory { get; set; }
  }

  public sealed class NetworkPolicy {
    public string backend { get; set; }
    public int[] localConnectPorts { get; set; }
    public int[] localListenPorts { get; set; }
  }

  // Values and layouts follow fwpmtypes.h/fwptypes.h. This controller is never inherited by the LPAC.
  public sealed class NetworkLease : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct DISPLAY { public string name, description; }
    [StructLayout(LayoutKind.Sequential)] struct BLOB { public uint size; public IntPtr data; }
    [StructLayout(LayoutKind.Sequential)] struct SESSION {
      public Guid key; public DISPLAY display; public uint flags, timeout, pid;
      public IntPtr sid, username; public int kernelMode;
    }
    [StructLayout(LayoutKind.Sequential)] struct SUBLAYER {
      public Guid key; public DISPLAY display; public uint flags; public IntPtr provider; public BLOB data; public ushort weight;
    }
    [StructLayout(LayoutKind.Explicit, Size = 16)] struct VALUE {
      [FieldOffset(0)] public uint type;
      [FieldOffset(8)] public byte u8;
      [FieldOffset(8)] public ushort u16;
      [FieldOffset(8)] public uint u32;
      [FieldOffset(8)] public IntPtr pointer;
    }
    [StructLayout(LayoutKind.Sequential)] struct CONDITION { public Guid key; public uint match; public VALUE value; }
    [StructLayout(LayoutKind.Sequential)] struct ACTION { public uint type; public Guid key; }
    [StructLayout(LayoutKind.Explicit, Size = 16)] struct CONTEXT { [FieldOffset(0)] public ulong raw; }
    [StructLayout(LayoutKind.Sequential)] struct FILTER {
      public Guid key; public DISPLAY display; public uint flags; public IntPtr provider; public BLOB data;
      public Guid layer, sublayer; public VALUE weight; public uint count; public IntPtr conditions;
      public ACTION action; public CONTEXT context; public IntPtr reserved; public ulong id; public VALUE effectiveWeight;
    }
    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)] static extern uint FwpmEngineOpen0(string server, uint authn, IntPtr identity, ref SESSION session, out IntPtr engine);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr engine, ref SUBLAYER sublayer, IntPtr descriptor);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionBegin0(IntPtr engine, uint flags);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionCommit0(IntPtr engine);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionAbort0(IntPtr engine);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engine, ref FILTER filter, IntPtr descriptor, out ulong id);
    static readonly Guid Package = new Guid("71bc78fa-f17c-4997-a602-6abb261f351c");
    static readonly Guid Flags = new Guid("632ce23b-5167-435c-86d7-e903684aa80c");
    static readonly Guid LocalAddress = new Guid("d9ee00de-c1ef-4617-bfe3-ffd8f5a08957");
    static readonly Guid RemoteAddress = new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045");
    static readonly Guid Protocol = new Guid("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7");
    static readonly Guid LocalPort = new Guid("0c1ba1af-5765-453f-af22-a8f791ac775b");
    static readonly Guid RemotePort = new Guid("c35a604d-d22b-4e1a-91b4-68f674ee674b");
    static readonly Guid[] Connect = { new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82"), new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4") };
    static readonly Guid[] Listen = { new Guid("88bb5dad-76d7-4227-9c71-df0a3ed7be7e"), new Guid("7ac9de24-17dd-4814-b4bd-a9fbc95a321b") };
    static readonly Guid[] Receive = { new Guid("e1cd9fe7-f4b5-4273-96c0-592e487b8650"), new Guid("a3b42c97-9f04-4672-b87e-cee9c483257f") };
    readonly List<IntPtr> allocations = new List<IntPtr>();
    IntPtr engine;
    Guid sublayer;

    static void Check(uint status, string operation) {
      if (status != 0) throw new InvalidOperationException(operation + " failed (0x" + status.ToString("x8") + "). Native Windows isolation requires the Base Filtering Engine and a trusted Env controller with WFP management permission; run the explicit Windows sandbox setup check. No host fallback is available.");
    }
    IntPtr Allocate(int size) { IntPtr memory = Marshal.AllocHGlobal(size); allocations.Add(memory); return memory; }
    CONDITION Scalar(Guid field, uint type, uint value, uint match) { return new CONDITION { key = field, match = match, value = new VALUE { type = type, u32 = value } }; }
    CONDITION Address(Guid field, IPAddress address, int prefix) {
      byte[] bytes = address.GetAddressBytes();
      if (bytes.Length == 4) {
        IntPtr mask = Allocate(8);
        uint value = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
        Marshal.WriteInt32(mask, unchecked((int)value)); Marshal.WriteInt32(mask, 4, prefix == 0 ? 0 : unchecked((int)(UInt32.MaxValue << (32 - prefix))));
        return new CONDITION { key = field, value = new VALUE { type = 256, pointer = mask } };
      }
      IntPtr network = Allocate(17); Marshal.Copy(bytes, 0, network, 16); Marshal.WriteByte(network, 16, (byte)prefix);
      return new CONDITION { key = field, value = new VALUE { type = 257, pointer = network } };
    }
    void Add(Guid layer, IntPtr sid, bool permit, byte priority, params CONDITION[] extra) {
      int size = Marshal.SizeOf(typeof(CONDITION)); IntPtr conditions = Marshal.AllocHGlobal(size * (extra.Length + 1));
      try {
        Marshal.StructureToPtr(new CONDITION { key = Package, value = new VALUE { type = 13, pointer = sid } }, conditions, false);
        for (int index = 0; index < extra.Length; index++) Marshal.StructureToPtr(extra[index], IntPtr.Add(conditions, size * (index + 1)), false);
        FILTER filter = new FILTER {
          key = Guid.NewGuid(), display = new DISPLAY { name = "Moco isolated Worker", description = "Per-AppContainer network policy" },
          flags = permit ? 8U : 0U, layer = layer, sublayer = sublayer, weight = new VALUE { type = 1, u8 = priority },
          count = (uint)(extra.Length + 1), conditions = conditions, action = new ACTION { type = permit ? 0x1002U : 0x1001U }
        };
        ulong id; Check(FwpmFilterAdd0(engine, ref filter, IntPtr.Zero, out id), "Install isolated network filter");
      } finally { Marshal.FreeHGlobal(conditions); }
    }

    public NetworkLease(IntPtr sid, NetworkPolicy policy) {
      try {
        if (IntPtr.Size != 8) throw new PlatformNotSupportedException("Native Windows isolation requires a 64-bit controller.");
        if (Marshal.SizeOf(typeof(FILTER)) != 200 || Marshal.SizeOf(typeof(CONDITION)) != 40) throw new InvalidOperationException("Unsupported WFP ABI layout.");
        SESSION session = new SESSION { key = Guid.NewGuid(), flags = 1, timeout = 5000, display = new DISPLAY { name = "Moco Worker network" } };
        Check(FwpmEngineOpen0(null, 10, IntPtr.Zero, ref session, out engine), "Open Windows Filtering Platform");
        Check(FwpmTransactionBegin0(engine, 0), "Begin isolated network transaction");
        bool committed = false;
        try {
          sublayer = Guid.NewGuid(); SUBLAYER sub = new SUBLAYER { key = sublayer, display = new DISPLAY { name = "Moco per-Worker isolation" }, weight = UInt16.MaxValue - 1 };
          Check(FwpmSubLayerAdd0(engine, ref sub, IntPtr.Zero), "Create isolated network sublayer");
          for (int family = 0; family < 2; family++) {
            IPAddress loopback = family == 0 ? IPAddress.Loopback : IPAddress.IPv6Loopback;
            int prefix = family == 0 ? 32 : 128;
            foreach (int port in policy.localConnectPorts ?? new int[0]) {
              ValidatePort(port);
              Add(Connect[family], sid, true, 15, Address(RemoteAddress, loopback, prefix), Scalar(Protocol, 1, 6, 0), Scalar(RemotePort, 2, (uint)port, 0));
            }
            // IS_LOOPBACK also catches host interface addresses added after this policy was installed.
            Add(Connect[family], sid, false, 14, Scalar(Flags, 3, 1, 6));
            Add(Connect[family], sid, false, 14, Address(RemoteAddress, family == 0 ? IPAddress.Parse("127.0.0.0") : IPAddress.IPv6Loopback, family == 0 ? 8 : 128));
            Add(Connect[family], sid, false, 14, Address(RemoteAddress, family == 0 ? IPAddress.Any : IPAddress.IPv6Any, prefix));
            if (family == 1) Add(Connect[family], sid, false, 14, Address(RemoteAddress, IPAddress.Parse("::ffff:127.0.0.0"), 104));
            foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces()) foreach (UnicastIPAddressInformation item in nic.GetIPProperties().UnicastAddresses) {
              if ((family == 0) == (item.Address.AddressFamily == AddressFamily.InterNetwork)) Add(Connect[family], sid, false, 14, Address(RemoteAddress, item.Address, prefix));
            }
            foreach (int port in policy.localListenPorts ?? new int[0]) {
              ValidatePort(port);
              // ALE_AUTH_LISTEN only sees TCP and has no IP_PROTOCOL condition.
              Add(Listen[family], sid, true, 15, Address(LocalAddress, loopback, prefix), Scalar(LocalPort, 2, (uint)port, 0));
              Add(Receive[family], sid, true, 15, Address(LocalAddress, loopback, prefix), Scalar(Flags, 3, 1, 6), Scalar(Protocol, 1, 6, 0), Scalar(LocalPort, 2, (uint)port, 0));
            }
            Add(Listen[family], sid, false, 14);
            // Established outbound TCP/UDP replies use ALE state; unsolicited inbound receives are denied.
            Add(Receive[family], sid, false, 14);
          }
          Check(FwpmTransactionCommit0(engine), "Commit isolated network policy"); committed = true;
        } finally { if (!committed) FwpmTransactionAbort0(engine); }
      } catch { Dispose(); throw; }
    }
    public static void ValidatePort(int port) { if (port < 1 || port > 65535) throw new InvalidOperationException("Invalid isolated TCP port."); }
    public void Dispose() {
      if (engine != IntPtr.Zero) { uint result = FwpmEngineClose0(engine); engine = IntPtr.Zero; Check(result, "Close isolated network policy"); }
      foreach (IntPtr allocation in allocations) Marshal.FreeHGlobal(allocation); allocations.Clear();
    }
  }

  public sealed class Lease {
    public string Profile { get; set; }
    public string Sid { get; set; }
    public string JobName { get; set; }
    public int OwnerPid { get; set; }
    public long OwnerStarted { get; set; }
    public List<string> Paths { get; set; }
  }

  public static class Launcher {
    const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    const int PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY = 0x0002000F;
    const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    const uint PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT = 0x1;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint HANDLE_FLAG_INHERIT = 0x1;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    const int JobObjectExtendedLimitInformation = 9;
    const int JobObjectBasicAccountingInformation = 1;
    const uint JOB_OBJECT_QUERY = 0x4;
    const uint JOB_OBJECT_TERMINATE = 0x8;
    const int ERROR_FILE_NOT_FOUND = 2;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Mutex AclMutex = new Mutex(false, "Global\\Moco.Worker.DirectoryPermissions");

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES {
      public IntPtr AppContainerSid, Capabilities;
      public uint CapabilityCount, Reserved;
    }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
      public int cb;
      public string lpReserved, lpDesktop, lpTitle;
      public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public ushort wShowWindow, cbReserved2;
      public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
      public BASIC_LIMIT BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
      public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint capabilityCount, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr capabilities, out uint capabilityCount);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref EXTENDED_LIMIT information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out ACCOUNTING information, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }

    static string Normalize(string value) {
      if (String.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0 || value.StartsWith("\\\\", StringComparison.Ordinal)) throw new InvalidOperationException("Only local drive paths can be authorized.");
      string full = Path.GetFullPath(value).TrimEnd('\\');
      if (full.Length <= 3 || !Char.IsLetter(full[0]) || full[1] != ':') throw new InvalidOperationException("A drive root cannot be authorized.");
      return full;
    }

    static string NormalizePrivate(string value) {
      if (String.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0 || value.StartsWith("\\\\?\\", StringComparison.Ordinal) || value.StartsWith("\\\\.\\", StringComparison.Ordinal)) throw new InvalidOperationException("Invalid private resource path.");
      return Path.GetFullPath(value).TrimEnd('\\');
    }

    static IntPtr Capabilities(List<IntPtr> sids) {
      foreach (string name in new string[] { "internetClient", "privateNetworkClientServer", "registryRead" }) {
        IntPtr groups = IntPtr.Zero, capabilities = IntPtr.Zero; uint groupCount = 0, capabilityCount = 0;
        try {
          Check(DeriveCapabilitySidsFromName(name, out groups, out groupCount, out capabilities, out capabilityCount), "Derive restricted process capability");
          if (capabilityCount != 1) throw new InvalidOperationException("Unsupported Windows capability result.");
          sids.Add(Marshal.ReadIntPtr(capabilities));
        } finally {
          if (groups != IntPtr.Zero) { for (int index = 0; index < groupCount; index++) LocalFree(Marshal.ReadIntPtr(groups, index * IntPtr.Size)); LocalFree(groups); }
          if (capabilities != IntPtr.Zero) LocalFree(capabilities);
        }
      }
      int size = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)); IntPtr result = Marshal.AllocHGlobal(size * sids.Count);
      for (int index = 0; index < sids.Count; index++) Marshal.StructureToPtr(new SID_AND_ATTRIBUTES { Sid = sids[index], Attributes = 4 }, IntPtr.Add(result, index * size), false);
      return result;
    }

    static bool Inside(string candidate, string directory) {
      return String.Equals(candidate, directory, StringComparison.OrdinalIgnoreCase) || candidate.StartsWith(directory.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    static void RejectReparseAncestors(string value) {
      for (string current = value; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
        if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Sandbox roots must be resolved before authorization.");
      }
    }

    static void ChangeRule(string value, SecurityIdentifier sid, FileSystemRights rights, AccessControlType type, bool remove, bool inherit) {
      // GetAccessControl/SetAccessControl is a read-modify-write pair. Serialize controllers so one
      // Worker cannot overwrite another Worker's private-path deny ACE while adding its own SID.
      bool locked = false;
      try {
        try { locked = AclMutex.WaitOne(30000); } catch (AbandonedMutexException) { locked = true; }
        if (!locked) throw new TimeoutException("Sandbox directory permissions are busy.");
        if (Directory.Exists(value)) {
          DirectoryInfo directory = new DirectoryInfo(value);
          DirectorySecurity acl = directory.GetAccessControl(AccessControlSections.Access);
          FileSystemAccessRule rule = new FileSystemAccessRule(sid, rights, inherit ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None, PropagationFlags.None, type);
          if (remove) acl.RemoveAccessRuleAll(rule); else acl.AddAccessRule(rule);
          directory.SetAccessControl(acl);
        } else if (File.Exists(value)) {
          FileInfo file = new FileInfo(value);
          FileSecurity acl = file.GetAccessControl(AccessControlSections.Access);
          FileSystemAccessRule rule = new FileSystemAccessRule(sid, rights, type);
          if (remove) acl.RemoveAccessRuleAll(rule); else acl.AddAccessRule(rule);
          file.SetAccessControl(acl);
        } else if (!remove) throw new DirectoryNotFoundException("A sandbox resource no longer exists.");
      } finally { if (locked) AclMutex.ReleaseMutex(); }
    }

    static void SaveLease(string file, Lease lease) {
      string temporary = file + ".new";
      byte[] contents = new UTF8Encoding(false).GetBytes(Json.Serialize(lease));
      using (FileStream stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) {
        stream.Write(contents, 0, contents.Length); stream.Flush(true);
      }
      if (File.Exists(file)) File.Replace(temporary, file, null);
      else File.Move(temporary, file);
    }

    static void Grant(string value, SecurityIdentifier sid, FileSystemRights rights, AccessControlType type, Lease lease, string journal, bool inherit = true) {
      if (!File.Exists(value) && !Directory.Exists(value)) return;
      // Journal first so an abrupt host termination can remove the dedicated SID ACE later.
      if (!lease.Paths.Contains(value)) { lease.Paths.Add(value); SaveLease(journal, lease); }
      ChangeRule(value, sid, rights, type, false, inherit);
    }

    static bool DrainJob(IntPtr job) {
      if (job == IntPtr.Zero) return true;
      Check(TerminateJobObject(job, 1), "Terminate sandbox process tree");
      for (int attempt = 0; attempt < 100; attempt++) {
        ACCOUNTING info;
        Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero), "Query sandbox process tree");
        if (info.ActiveProcesses == 0) return true;
        Thread.Sleep(50);
      }
      return false;
    }

    static void RemoveLease(string file, Lease lease) {
      SecurityIdentifier sid = new SecurityIdentifier(lease.Sid);
      IntPtr expected = IntPtr.Zero;
      try {
        int derived = DeriveAppContainerSidFromAppContainerName(lease.Profile, out expected);
        if (derived < 0) Marshal.ThrowExceptionForHR(derived);
        if (!sid.Equals(new SecurityIdentifier(expected))) throw new InvalidOperationException("Invalid sandbox cleanup identity.");
      } finally { if (expected != IntPtr.Zero) FreeSid(expected); }
      List<Exception> errors = new List<Exception>();
      foreach (string value in lease.Paths) {
        try {
          ChangeRule(value, sid, FileSystemRights.FullControl, AccessControlType.Allow, true, true);
          ChangeRule(value, sid, FileSystemRights.FullControl, AccessControlType.Deny, true, true);
        } catch (Exception ex) { errors.Add(ex); }
      }
      if (errors.Count != 0) throw new AggregateException("Sandbox directory permissions require cleanup.", errors);
      int removed = DeleteAppContainerProfile(lease.Profile);
      if (removed < 0 && removed != unchecked((int)0x80070002) && removed != unchecked((int)0x80070490)) Marshal.ThrowExceptionForHR(removed);
      File.Delete(file);
    }

    static void ReapLeases(string directory) {
      foreach (string file in Directory.GetFiles(directory, "*.json")) {
        Lease lease = Json.Deserialize<Lease>(File.ReadAllText(file));
        Guid identifier;
        if (lease == null || lease.Profile == null || !lease.Profile.StartsWith("Moco.Worker.", StringComparison.Ordinal) || !Guid.TryParseExact(lease.Profile.Substring(12), "N", out identifier) || lease.Paths == null || lease.JobName != "Local\\" + lease.Profile) throw new InvalidOperationException("Invalid sandbox cleanup record.");
        bool ownerAlive = false;
        try { Process owner = Process.GetProcessById(lease.OwnerPid); ownerAlive = !owner.HasExited && owner.StartTime.ToUniversalTime().Ticks == lease.OwnerStarted; }
        catch (ArgumentException) { }
        if (ownerAlive) continue;
        IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, lease.JobName);
        if (job == IntPtr.Zero && Marshal.GetLastWin32Error() != ERROR_FILE_NOT_FOUND) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open abandoned sandbox process tree");
        try { if (!DrainJob(job)) throw new InvalidOperationException("Abandoned sandbox process cleanup is still pending."); }
        finally { if (job != IntPtr.Zero) CloseHandle(job); }
        RemoveLease(file, lease);
      }
    }

    static string Quote(string value) {
      if (value.IndexOf('\0') >= 0) throw new InvalidOperationException("Invalid child argument.");
      if (value.Length != 0 && value.IndexOfAny(new char[] { ' ', '\t', '\r', '\n', '"' }) < 0) return value;
      StringBuilder result = new StringBuilder("\"");
      int slashes = 0;
      foreach (char item in value) {
        if (item == '\\') { slashes++; continue; }
        if (item == '"') { result.Append('\\', slashes * 2 + 1); result.Append(item); slashes = 0; continue; }
        result.Append('\\', slashes); slashes = 0; result.Append(item);
      }
      result.Append('\\', slashes * 2); result.Append('"');
      return result.ToString();
    }

    static List<string> ToolchainDirectories() {
      List<string> result = new List<string>();
      foreach (string root in new string[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) }) {
        if (String.IsNullOrEmpty(root) || !Directory.Exists(root)) continue;
        foreach (string name in new string[] { "Git", "nodejs", "dotnet", "PowerShell" }) {
          string directory = Path.Combine(root, name);
          if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) == 0 && !result.Contains(directory)) result.Add(directory);
        }
      }
      return result;
    }

    static IntPtr EnvironmentBlock(Policy policy) {
      string system = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      string home = Path.Combine(policy.temporaryDir, "home"), temporary = Path.Combine(policy.temporaryDir, "tmp");
      Directory.CreateDirectory(home); Directory.CreateDirectory(temporary);
      SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      values["SystemRoot"] = system; values["WINDIR"] = system;
      values["ComSpec"] = Path.Combine(system, "System32", "cmd.exe");
      values["PATH"] = Path.Combine(system, "System32") + ";" + system + ";" + Path.GetDirectoryName(policy.executable);
      foreach (string directory in ToolchainDirectories()) {
        values["PATH"] += ";" + directory;
        foreach (string sub in new string[] { "bin", "cmd", "mingw64\\bin" }) if (Directory.Exists(Path.Combine(directory, sub))) values["PATH"] += ";" + Path.Combine(directory, sub);
      }
      values["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
      values["HOME"] = home; values["USERPROFILE"] = home;
      values["APPDATA"] = Path.Combine(home, "AppData", "Roaming");
      values["LOCALAPPDATA"] = Path.Combine(home, "AppData", "Local");
      values["TEMP"] = temporary; values["TMP"] = temporary; values["PORT"] = policy.port.ToString(System.Globalization.CultureInfo.InvariantCulture);
      Directory.CreateDirectory(values["APPDATA"]); Directory.CreateDirectory(values["LOCALAPPDATA"]);
      StringBuilder block = new StringBuilder();
      foreach (KeyValuePair<string, string> item in values) block.Append(item.Key).Append('=').Append(item.Value).Append('\0');
      block.Append('\0');
      return Marshal.StringToHGlobalUni(block.ToString());
    }

    public static void Setup() {
      Cleanup();
      IntPtr list = IntPtr.Zero, policy = IntPtr.Zero, job = IntPtr.Zero;
      bool initialized = false;
      try {
        IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        list = Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(list, 1, 0, ref size), "Probe restricted process attributes"); initialized = true;
        policy = Marshal.AllocHGlobal(sizeof(uint)); Marshal.WriteInt32(policy, (int)PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT);
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY), policy, new IntPtr(sizeof(uint)), IntPtr.Zero, IntPtr.Zero), "Probe LPAC policy support");
        job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "Probe native process tree control");
        EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "Probe native process cleanup");
      } finally {
        if (job != IntPtr.Zero) CloseHandle(job);
        if (initialized) DeleteProcThreadAttributeList(list);
        if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
        if (policy != IntPtr.Zero) Marshal.FreeHGlobal(policy);
      }
      // No persistent firewall change or broad loopback exemption: test the actual dynamic WFP path.
      IntPtr memory = IntPtr.Zero;
      try {
        int derived = DeriveAppContainerSidFromAppContainerName("Moco.Setup." + Guid.NewGuid().ToString("N"), out memory);
        if (derived < 0) Marshal.ThrowExceptionForHR(derived);
        using (NetworkLease lease = new NetworkLease(memory, new NetworkPolicy { backend = "wfp", localConnectPorts = new int[0], localListenPorts = new int[0] })) { }
      } finally { if (memory != IntPtr.Zero) FreeSid(memory); }
    }

    public static void Cleanup() {
      string journals = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Moco", "SandboxLeases");
      Directory.CreateDirectory(journals); ReapLeases(journals);
    }

    public static int Run(string json, string[] arguments) {
      Policy policy = Json.Deserialize<Policy>(json);
      if (policy == null || policy.version != 1 || policy.network == null || policy.network.backend != "wfp" || policy.port < 1 || policy.port > 65535) throw new InvalidOperationException("Invalid Windows sandbox policy.");
      policy.workspaceDir = Normalize(policy.workspaceDir); policy.temporaryDir = Normalize(policy.temporaryDir); policy.executable = Normalize(policy.executable);
      if (!String.IsNullOrEmpty(policy.scratchDir)) policy.scratchDir = Normalize(policy.scratchDir);
      if (!String.IsNullOrEmpty(policy.workspaceRoot)) policy.workspaceRoot = Normalize(policy.workspaceRoot);
      if (!String.IsNullOrEmpty(policy.managedScratchRoot)) policy.managedScratchRoot = Normalize(policy.managedScratchRoot);
      RejectReparseAncestors(policy.workspaceDir); RejectReparseAncestors(policy.temporaryDir); RejectReparseAncestors(policy.executable);
      if (!String.IsNullOrEmpty(policy.scratchDir)) RejectReparseAncestors(policy.scratchDir);
      if (!Directory.Exists(policy.workspaceDir) || !Directory.Exists(policy.temporaryDir) || !File.Exists(policy.executable)) throw new InvalidOperationException("Sandbox resources must exist before launch.");
      if (String.Equals(policy.workspaceDir, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The entire user profile cannot be a Worker project.");
      string journals = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Moco", "SandboxLeases");
      List<string> privatePaths = new List<string>(policy.protectedPaths ?? new string[0]);
      string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      foreach (string name in new string[] { ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".moco", ".codex", ".config\\gcloud" }) privatePaths.Add(Path.Combine(userProfile, name));
      privatePaths.Add(Normalize(policy.controlDirectory));
      // Every Worker protects the journal's authorized ancestors before it can execute, including
      // when another controller later creates a lease beneath an already-authorized LocalAppData.
      privatePaths.Add(journals);
      policy.protectedPaths = privatePaths.ToArray();
      foreach (string writable in new string[] { policy.workspaceDir, policy.scratchDir, policy.temporaryDir }) if (!String.IsNullOrEmpty(writable)) {
        foreach (string raw in policy.protectedPaths ?? new string[0]) {
          string protectedPath = NormalizePrivate(raw);
          bool scopedException = false;
          foreach (string root in new string[] { policy.workspaceRoot, policy.managedScratchRoot }) if (!String.IsNullOrEmpty(root) && !String.Equals(root, protectedPath, StringComparison.OrdinalIgnoreCase) && Inside(root, protectedPath) && Inside(writable, root)) scopedException = true;
          if (Inside(writable, protectedPath) && !scopedException) throw new InvalidOperationException("Worker project overlaps private host resources.");
          if (Inside(protectedPath, writable) && !File.Exists(protectedPath) && !Directory.Exists(protectedPath)) throw new InvalidOperationException("Windows cannot reserve a nonexistent private entry inside an authorized project. Select a narrower project directory.");
        }
      }

      Directory.CreateDirectory(journals); ReapLeases(journals);
      string profile = "Moco.Worker." + Guid.NewGuid().ToString("N");
      string journal = Path.Combine(journals, profile.Substring(12) + ".json");
      IntPtr sidPointer = IntPtr.Zero, jobHandle = IntPtr.Zero, list = IntPtr.Zero, environment = IntPtr.Zero;
      IntPtr capabilitiesMemory = IntPtr.Zero, lpacMemory = IntPtr.Zero, handlesMemory = IntPtr.Zero;
      IntPtr capabilityArray = IntPtr.Zero;
      List<IntPtr> capabilitySids = new List<IntPtr>();
      NetworkLease network = null;
      PROCESS_INFORMATION process = new PROCESS_INFORMATION();
      Lease lease = null;
      bool processAssigned = false, attributeListInitialized = false;
      int result = 1;
      try {
        int created = CreateAppContainerProfile(profile, "Moco Worker", "Isolated Moco task", IntPtr.Zero, 0, out sidPointer);
        if (created < 0) Marshal.ThrowExceptionForHR(created);
        SecurityIdentifier sid = new SecurityIdentifier(sidPointer);
        Process owner = Process.GetCurrentProcess();
        lease = new Lease { Profile = profile, Sid = sid.Value, JobName = "Local\\" + profile, OwnerPid = owner.Id, OwnerStarted = owner.StartTime.ToUniversalTime().Ticks, Paths = new List<string>() };
        SaveLease(journal, lease);
        Grant(policy.workspaceDir, sid, policy.readOnly ? FileSystemRights.ReadAndExecute : FileSystemRights.Modify, AccessControlType.Allow, lease, journal);
        if (!String.IsNullOrEmpty(policy.scratchDir)) Grant(policy.scratchDir, sid, FileSystemRights.Modify, AccessControlType.Allow, lease, journal);
        Grant(policy.temporaryDir, sid, FileSystemRights.Modify, AccessControlType.Allow, lease, journal);
        foreach (string raw in policy.protectedPaths ?? new string[0]) {
          string privatePath = NormalizePrivate(raw);
          Grant(privatePath, sid, FileSystemRights.FullControl, AccessControlType.Deny, lease, journal);
          // Keep protected entries anchored: renaming an authorized ancestor must not evade the next run's deny path.
          for (string ancestor = Path.GetDirectoryName(privatePath); !String.IsNullOrEmpty(ancestor); ancestor = Path.GetDirectoryName(ancestor)) {
            bool authorizedAncestor = Inside(ancestor, policy.workspaceDir) || (!String.IsNullOrEmpty(policy.scratchDir) && Inside(ancestor, policy.scratchDir)) || Inside(ancestor, policy.temporaryDir);
            if (!authorizedAncestor) continue;
            Grant(ancestor, sid, FileSystemRights.Delete, AccessControlType.Deny, lease, journal, false);
          }
        }
        // A legacy workspace may sit within a protected state root. Its explicit ACE precedes inherited denial.
        Grant(policy.workspaceDir, sid, policy.readOnly ? FileSystemRights.ReadAndExecute : FileSystemRights.Modify, AccessControlType.Allow, lease, journal);
        if (!String.IsNullOrEmpty(policy.scratchDir)) Grant(policy.scratchDir, sid, FileSystemRights.Modify, AccessControlType.Allow, lease, journal);
        Grant(policy.temporaryDir, sid, FileSystemRights.Modify, AccessControlType.Allow, lease, journal);
        foreach (string raw in policy.writeDeniedPaths ?? new string[0]) {
          string writeDeniedPath = NormalizePrivate(raw);
          if (!File.Exists(writeDeniedPath) && !Directory.Exists(writeDeniedPath)) continue;
          FileSystemRights denyWriteRights = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
          if (Directory.Exists(writeDeniedPath)) denyWriteRights |= FileSystemRights.DeleteSubdirectoriesAndFiles;
          Grant(writeDeniedPath, sid, denyWriteRights, AccessControlType.Deny, lease, journal);
          for (string ancestor = Path.GetDirectoryName(writeDeniedPath); !String.IsNullOrEmpty(ancestor); ancestor = Path.GetDirectoryName(ancestor)) {
            bool authorizedAncestor = Inside(ancestor, policy.workspaceDir) || (!String.IsNullOrEmpty(policy.scratchDir) && Inside(ancestor, policy.scratchDir)) || Inside(ancestor, policy.temporaryDir);
            if (!authorizedAncestor) continue;
            Grant(ancestor, sid, FileSystemRights.Delete, AccessControlType.Deny, lease, journal, false);
          }
        }
        Grant(policy.executable, sid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, lease, journal);
        foreach (string runtimePath in policy.runtimePaths ?? new string[0]) {
          string runtime = Normalize(runtimePath);
          RejectReparseAncestors(runtime);
          Grant(runtime, sid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, lease, journal);
        }
        foreach (string directory in ToolchainDirectories()) Grant(directory, sid, FileSystemRights.ReadAndExecute, AccessControlType.Allow, lease, journal);
        network = new NetworkLease(sidPointer, policy.network);

        jobHandle = CreateJobObject(IntPtr.Zero, lease.JobName);
        Check(jobHandle != IntPtr.Zero, "Create sandbox process tree");
        EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        Check(SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "Configure sandbox process tree");

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 3, 0, ref size);
        list = Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(list, 3, 0, ref size), "Create restricted process attributes"); attributeListInitialized = true;
        capabilityArray = Capabilities(capabilitySids);
        SECURITY_CAPABILITIES capabilities = new SECURITY_CAPABILITIES { AppContainerSid = sidPointer, Capabilities = capabilityArray, CapabilityCount = (uint)capabilitySids.Count, Reserved = 0 };
        capabilitiesMemory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
        Marshal.StructureToPtr(capabilities, capabilitiesMemory, false);
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilitiesMemory, new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero), "Apply AppContainer identity");
        lpacMemory = Marshal.AllocHGlobal(sizeof(uint)); Marshal.WriteInt32(lpacMemory, (int)PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT);
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY), lpacMemory, new IntPtr(sizeof(uint)), IntPtr.Zero, IntPtr.Zero), "Apply less-privileged AppContainer policy");

        STARTUPINFOEX startup = new STARTUPINFOEX(); startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.AttributeList = list;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = GetStdHandle(-10); startup.StartupInfo.hStdOutput = GetStdHandle(-11); startup.StartupInfo.hStdError = GetStdHandle(-12);
        IntPtr[] handles = new IntPtr[] { startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError };
        handlesMemory = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
        for (int index = 0; index < handles.Length; index++) {
          Check(handles[index] != IntPtr.Zero && handles[index] != new IntPtr(-1), "Open sandbox standard I/O");
          Check(SetHandleInformation(handles[index], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "Prepare sandbox standard I/O");
          Marshal.WriteIntPtr(handlesMemory, index * IntPtr.Size, handles[index]);
        }
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handlesMemory, new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero), "Restrict inherited handles");
        environment = EnvironmentBlock(policy);
        StringBuilder command = new StringBuilder(Quote(policy.executable));
        foreach (string argument in arguments ?? new string[0]) command.Append(' ').Append(Quote(argument));
        Check(CreateProcess(policy.executable, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, environment, policy.workspaceDir, ref startup, out process), "Start isolated Worker process");
        Check(AssignProcessToJobObject(jobHandle, process.hProcess), "Attach isolated Worker process tree"); processAssigned = true;
        Check(ResumeThread(process.hThread) != UInt32.MaxValue, "Resume isolated Worker process");
        uint status;
        do { status = WaitForSingleObject(process.hProcess, 250); } while (status == WAIT_TIMEOUT);
        Check(status == WAIT_OBJECT_0, "Wait for isolated Worker process");
        uint exitCode; Check(GetExitCodeProcess(process.hProcess, out exitCode), "Read isolated Worker result"); result = unchecked((int)exitCode);
      } finally {
        bool drained = true;
        try {
          if (process.hProcess != IntPtr.Zero && !processAssigned) Check(TerminateProcess(process.hProcess, 1), "Stop unassigned restricted process");
          if (jobHandle != IntPtr.Zero) drained = DrainJob(jobHandle);
        } finally {
          if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
          if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
          if (jobHandle != IntPtr.Zero) CloseHandle(jobHandle);
          if (attributeListInitialized) DeleteProcThreadAttributeList(list);
          if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
          if (capabilitiesMemory != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesMemory);
          if (lpacMemory != IntPtr.Zero) Marshal.FreeHGlobal(lpacMemory);
          if (handlesMemory != IntPtr.Zero) Marshal.FreeHGlobal(handlesMemory);
          if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
          if (capabilityArray != IntPtr.Zero) Marshal.FreeHGlobal(capabilityArray);
          foreach (IntPtr capabilitySid in capabilitySids) LocalFree(capabilitySid);
          if (sidPointer != IntPtr.Zero) FreeSid(sidPointer);
        }
        if (!drained) throw new InvalidOperationException("Sandbox process cleanup is still pending; directory authorization was retained for verified cleanup.");
        if (network != null) network.Dispose();
        if (lease != null) RemoveLease(journal, lease);
      }
      return result;
    }
  }
}
'@

if ($cleanup) { [MocoSandbox.Launcher]::Cleanup(); exit 0 }
if ($setup) {
  [MocoSandbox.Launcher]::Setup()
  [Console]::Out.WriteLine('Windows AppContainer controller prerequisites are ready. Each Worker still validates its own WFP and LPAC launch.')
  exit 0
}
$policy | Add-Member -NotePropertyName controlDirectory -NotePropertyValue $PSScriptRoot
$json = $policy | ConvertTo-Json -Depth 8 -Compress
exit [MocoSandbox.Launcher]::Run($json, $childArguments)
