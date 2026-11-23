export const MANAGED_NODE_VERSION = "22.23.5";
export const PREPARE_MARKER = "KULO-PREPARE-JSON:";
export const NO_NODE_MARKER = "KULO-NO-NODE:";
export const BOOTSTRAP_ERR_MARKER = "KULO-BOOTSTRAP-ERR:";

export type ManagedNodeTargetKey =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-arm64"
  | "darwin-x64"
  | "win-x64"
  | "win-arm64";

export interface ManagedNodeTarget {
  readonly key: ManagedNodeTargetKey;
  readonly version: string;
  readonly platform: "posix" | "win32";
  readonly folder: string;
  readonly archive: string;
  readonly sha256: string;
  readonly binRelPath: string;
}

export interface RemoteHostProbe {
  readonly os: "linux" | "darwin" | "win32" | string;
  readonly arch: string;
  readonly libc: "glibc" | "musl" | "msvc" | string;
}

// Official SHA-256 checksums from https://nodejs.org/dist/v22.23.5/SHASUMS256.txt
export const MANAGED_NODE_TARGETS: Record<ManagedNodeTargetKey, ManagedNodeTarget> = {
  "linux-x64": {
    key: "linux-x64",
    version: MANAGED_NODE_VERSION,
    platform: "posix",
    folder: `node-v${MANAGED_NODE_VERSION}-linux-x64`,
    archive: `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`,
    sha256: "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1",
    binRelPath: "bin/node",
  },
  "linux-arm64": {
    key: "linux-arm64",
    version: MANAGED_NODE_VERSION,
    platform: "posix",
    folder: `node-v${MANAGED_NODE_VERSION}-linux-arm64`,
    archive: `node-v${MANAGED_NODE_VERSION}-linux-arm64.tar.gz`,
    sha256: "8bd3dc69eee8f3f226315a80d7d1d4faccf217a4c8fae500168ac2e38f3bdba3",
    binRelPath: "bin/node",
  },
  "darwin-arm64": {
    key: "darwin-arm64",
    version: MANAGED_NODE_VERSION,
    platform: "posix",
    folder: `node-v${MANAGED_NODE_VERSION}-darwin-arm64`,
    archive: `node-v${MANAGED_NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d",
    binRelPath: "bin/node",
  },
  "darwin-x64": {
    key: "darwin-x64",
    version: MANAGED_NODE_VERSION,
    platform: "posix",
    folder: `node-v${MANAGED_NODE_VERSION}-darwin-x64`,
    archive: `node-v${MANAGED_NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: "c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422",
    binRelPath: "bin/node",
  },
  "win-x64": {
    key: "win-x64",
    version: MANAGED_NODE_VERSION,
    platform: "win32",
    folder: `node-v${MANAGED_NODE_VERSION}-win-x64`,
    archive: `node-v${MANAGED_NODE_VERSION}-win-x64.zip`,
    sha256: "4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3",
    binRelPath: "node.exe",
  },
  "win-arm64": {
    key: "win-arm64",
    version: MANAGED_NODE_VERSION,
    platform: "win32",
    folder: `node-v${MANAGED_NODE_VERSION}-win-arm64`,
    archive: `node-v${MANAGED_NODE_VERSION}-win-arm64.zip`,
    sha256: "c1856817f611738c77534efbff8a5a17990593eab24046bc8d2c23a77a160d13",
    binRelPath: "node.exe",
  },
};

// Every mirror download is cryptographically verified against the hardcoded official SHA-256 above.
export const NODE_DIST_MIRRORS: readonly string[] = [
  "https://nodejs.org/dist",
  "https://npmmirror.com/mirrors/node",
];

export const PREPARE_REMOTE = `
const net=require('node:net');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<19)){console.error('接入设备需要 Node.js 22.19 或更新版本。');process.exit(1);}
const s=net.createServer();
s.once('error',e=>{console.error(e.message);process.exit(1);});
s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log('${PREPARE_MARKER}'+JSON.stringify({port:p,nodePath:process.execPath,platform:process.platform})));});
`.trim();

const PREPARE_REMOTE_HEX = Buffer.from(PREPARE_REMOTE, "utf8").toString("hex");
const REMOTE_NODE_EVAL_EXPR = `eval(Buffer.from(/${PREPARE_REMOTE_HEX}/.source,/hex/.source).toString())`;

export function powershellEncodedCommand(script: string): string {
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/**
 * Pure POSIX `sh -c '...'` probe with zero nested single quotes.
 * Validates each discovered `node` binary is >= 22.19 (skipping older system Node like apt v18/v20),
 * checks Kulo's managed runtime and common version managers, and otherwise emits `KULO-NO-NODE:<os>|<arch>|<libc>`.
 */
export const POSIX_PREPARE_COMMAND = [
  "sh -c '",
  'ok() { [ -x "$1" ] || return 1; V=$("$1" -v 2>/dev/null || true); case "$V" in v*) V=${V#v};; *) return 1;; esac; MAJ=${V%%.*}; REST=${V#*.}; MIN=${REST%%.*}; case "$MAJ$MIN" in ""|*[!0-9]*) return 1;; esac; [ "$MAJ" -gt 22 ] || { [ "$MAJ" -eq 22 ] && [ "$MIN" -ge 19 ]; }; }; ',
  'N=""; ',
  'P=$(command -v node 2>/dev/null || true); if [ -n "$P" ] && ok "$P"; then N="$P"; fi; ',
  `if [ -z "$N" ]; then for p in "$HOME/.kulo/node/current/bin/node" "$HOME/.kulo/node/v${MANAGED_NODE_VERSION}/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /home/linuxbrew/.linuxbrew/bin/node "$HOME/.volta/bin/node" "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" "$HOME/.fnm/aliases/default/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/.nvm/current/bin/node" "$HOME/.local/bin/node"; do if ok "$p"; then N="$p"; break; fi; done; fi; `,
  'if [ -z "$N" ]; then for p in "$HOME"/.nvm/versions/node/v*/bin/node; do if ok "$p"; then N="$p"; fi; done; fi; ',
  'if [ -z "$N" ] && [ -n "${SHELL:-}" ] && [ -x "$SHELL" ]; then P=$("$SHELL" -l -c "command -v node" </dev/null 2>/dev/null | tail -n 1 || true); if [ -n "$P" ] && ok "$P"; then N="$P"; fi; fi; ',
  'if [ -z "$N" ]; then OS=$(uname -s 2>/dev/null | tr "A-Z" "a-z" || echo unknown); ARCH=$(uname -m 2>/dev/null || echo unknown); LIBC=glibc; if [ "$OS" = linux ] && ldd --version 2>&1 | grep -qi musl; then LIBC=musl; fi; echo "KULO-NO-NODE:$OS|$ARCH|$LIBC" >&2; exit 127; fi; ',
  `exec "$N" -e "${REMOTE_NODE_EVAL_EXPR}"'`,
].join("");

export const WINDOWS_PREPARE_COMMAND = powershellEncodedCommand([
  "$ErrorActionPreference = 'Stop'",
  "$candidates = @()",
  "$cmd = Get-Command node -ErrorAction SilentlyContinue",
  "if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }",
  `$candidates += (Join-Path $HOME '.kulo\\node\\v${MANAGED_NODE_VERSION}\\node.exe')`,
  "$candidates += (Join-Path $HOME '.kulo\\node\\current\\node.exe')",
  "if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\\node.exe') }",
  "if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\\nodejs\\node.exe') }",
  "$found = $null",
  "foreach ($c in $candidates) {",
  "  if (-not $c -or -not (Test-Path -LiteralPath $c)) { continue }",
  "  try {",
  "    $v = (& $c -v 2>$null).Trim()",
  "    if ($v -match '^v(\\d+)\\.(\\d+)\\.') {",
  "      $maj = [int]$Matches[1]; $min = [int]$Matches[2]",
  "      if ($maj -gt 22 -or ($maj -eq 22 -and $min -ge 19)) { $found = $c; break }",
  "    }",
  "  } catch {}",
  "}",
  "if (-not $found) {",
  "  $arch = $env:PROCESSOR_ARCHITECTURE",
  "  try { $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch {}",
  "  [Console]::Error.WriteLine(('KULO-NO-NODE:win32|' + $arch.ToLowerInvariant() + '|msvc'))",
  "  exit 127",
  "}",
  `& $found -e "${REMOTE_NODE_EVAL_EXPR}"`,
  "exit $LASTEXITCODE",
].join("\n"));

function normalizeOs(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === "linux") return "linux";
  if (lower === "darwin") return "darwin";
  if (lower === "win32" || lower.startsWith("mingw") || lower.startsWith("msys") || lower.startsWith("cygwin")) {
    return "win32";
  }
  return lower || "unknown";
}

function normalizeArch(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === "x86_64" || lower === "amd64" || lower === "x64") return "x64";
  if (lower === "aarch64" || lower === "arm64") return "arm64";
  return lower || "unknown";
}

export function parseNoNodeMarker(stderr: string): RemoteHostProbe | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(NO_NODE_MARKER)) continue;
    const payload = trimmed.slice(NO_NODE_MARKER.length);
    const [rawOs = "", rawArch = "", rawLibc = ""] = payload.split("|");
    return {
      os: normalizeOs(rawOs),
      arch: normalizeArch(rawArch),
      libc: rawLibc.trim().toLowerCase() || "unknown",
    };
  }
  return undefined;
}

export function extractBootstrapError(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(BOOTSTRAP_ERR_MARKER)) {
      const msg = trimmed.slice(BOOTSTRAP_ERR_MARKER.length).trim();
      if (msg) return msg;
    }
  }
  return undefined;
}

export function resolveManagedNodeTarget(probe: RemoteHostProbe): ManagedNodeTarget {
  const os = normalizeOs(probe.os);
  const arch = normalizeArch(probe.arch);
  if (os === "linux" && probe.libc === "musl") {
    throw Object.assign(
      new Error("远端主机使用 musl libc（如 Alpine Linux），暂不支持自动安装官方 Node.js，请先手动安装 Node.js 22.19 或更新版本。"),
      { code: "device_ssh_node_unsupported", status: 400 },
    );
  }
  const key =
    os === "linux" && arch === "x64"
      ? "linux-x64"
      : os === "linux" && arch === "arm64"
        ? "linux-arm64"
        : os === "darwin" && arch === "arm64"
          ? "darwin-arm64"
          : os === "darwin" && arch === "x64"
            ? "darwin-x64"
            : os === "win32" && arch === "x64"
              ? "win-x64"
              : os === "win32" && arch === "arm64"
                ? "win-arm64"
                : undefined;
  if (!key) {
    throw Object.assign(
      new Error(`远端主机系统架构（${os}/${arch}）暂不支持自动安装 Node.js，请先手动安装 Node.js 22.19 或更新版本。`),
      { code: "device_ssh_node_unsupported", status: 400 },
    );
  }
  return MANAGED_NODE_TARGETS[key];
}

/**
 * Builds a zero-sudo POSIX `sh -c '...'` bootstrap command (zero nested single quotes) that:
 * 1. Downloads the official Node.js LTS `.tar.gz` (with mirror fallback),
 * 2. Cryptographically verifies SHA-256 against the pinned official checksum before extraction,
 * 3. Smoke-tests the extracted binary and atomically installs it into `$HOME/.kulo/node/v22.23.5`,
 * 4. Executes `PREPARE_REMOTE` in the same SSH round-trip to return `KULO-PREPARE-JSON:...`.
 */
export function buildPosixNodeBootstrapCommand(
  target: ManagedNodeTarget,
  mirrors: readonly string[] = NODE_DIST_MIRRORS,
): string {
  if (target.platform !== "posix") {
    throw new Error("内部错误：POSIX 自动安装仅支持 Linux/macOS 目标。");
  }
  const lastIdx = Math.max(mirrors.length - 1, 0);
  const mirrorEntries = mirrors.map((base, idx) => `"${idx === lastIdx ? "1" : "0"}|${base.replace(/\/+$/, "")}/v${target.version}/${target.archive}"`).join(" ");
  if (mirrorEntries.includes("'")) throw new Error("Node.js 下载地址包含不受支持的字符。");

  return [
    "sh -c '",
    "set -eu; umask 077; ",
    'ROOT="$HOME/.kulo/node"; ',
    `DEST="$ROOT/v${target.version}"; `,
    'CUR="$ROOT/current"; ',
    'mkdir -p "$ROOT"; chmod 700 "$HOME/.kulo" "$ROOT"; ',
    'DL=""; if command -v curl >/dev/null 2>&1; then DL=curl; elif command -v wget >/dev/null 2>&1; then DL=wget; else echo "KULO-BOOTSTRAP-ERR:远端主机未安装 curl 或 wget，无法自动下载 Node.js。" >&2; exit 1; fi; ',
    'command -v tar >/dev/null 2>&1 || { echo "KULO-BOOTSTRAP-ERR:远端主机未安装 tar，无法自动解压 Node.js。" >&2; exit 1; }; ',
    'HASH=""; if command -v sha256sum >/dev/null 2>&1; then HASH=sha256sum; elif command -v shasum >/dev/null 2>&1; then HASH=shasum; elif command -v openssl >/dev/null 2>&1; then HASH=openssl; else echo "KULO-BOOTSTRAP-ERR:远端主机缺少 SHA-256 校验工具，已取消自动安装 Node.js。" >&2; exit 1; fi; ',
    'dl() { if [ "$DL" = curl ]; then if [ "$3" = "1" ]; then curl -fSL --connect-timeout 15 --speed-limit 20480 --speed-time 20 --max-time 165 -o "$2" "$1"; else curl -fSL --connect-timeout 15 --speed-limit 102400 --speed-time 12 --max-time 90 -o "$2" "$1"; fi; else wget -q --timeout=15 --tries=1 -O "$2" "$1"; fi; }; ',
    'sha() { if [ "$HASH" = sha256sum ]; then sha256sum "$1" | cut -d " " -f 1; elif [ "$HASH" = shasum ]; then shasum -a 256 "$1" | cut -d " " -f 1; else openssl dgst -sha256 "$1" | sed "s/^.* //"; fi; }; ',
    'if [ ! -x "$DEST/bin/node" ] || ! "$DEST/bin/node" -v >/dev/null 2>&1; then ',
    '  TMP=$(mktemp -d "$ROOT/.install-XXXXXX"); ',
    '  trap "rm -rf \\"\\$TMP\\"" EXIT; ',
    '  trap "rm -rf \\"\\$TMP\\"; exit 143" INT TERM HUP; ',
    '  OK=0; ',
    `  for E in ${mirrorEntries}; do `,
    '    IS_LAST=${E%%|*}; U=${E#*|}; ',
    '    rm -f "$TMP/node.tgz"; ',
    '    if dl "$U" "$TMP/node.tgz" "$IS_LAST" 2>/dev/null; then ',
    '      GOT=$(sha "$TMP/node.tgz" 2>/dev/null | tr "A-Z" "a-z" || true); ',
    `      if [ "$GOT" = "${target.sha256}" ]; then OK=1; break; fi; `,
    "    fi; ",
    "  done; ",
    `  if [ "$OK" != 1 ]; then echo "KULO-BOOTSTRAP-ERR:自动下载或校验 Node.js v${target.version} 失败，请检查远端主机网络连接后重试。" >&2; exit 1; fi; `,
    '  mkdir -p "$TMP/x"; ',
    '  tar -xzf "$TMP/node.tgz" -C "$TMP/x"; ',
    `  EXT="$TMP/x/${target.folder}"; `,
    '  if [ ! -x "$EXT/bin/node" ]; then echo "KULO-BOOTSTRAP-ERR:解压 Node.js 失败，未找到可执行文件。" >&2; exit 1; fi; ',
    '  if ! "$EXT/bin/node" -v >/dev/null 2>&1; then echo "KULO-BOOTSTRAP-ERR:远端主机无法运行官方 Node.js（可能缺少 glibc 兼容版本），请先手动安装 Node.js 22.19 或更新版本。" >&2; exit 1; fi; ',
    '  rm -rf "$DEST.old"; ',
    '  if [ -e "$DEST" ]; then mv "$DEST" "$DEST.old"; fi; ',
    '  mv "$EXT" "$DEST"; ',
    '  rm -rf "$DEST.old"; ',
    '  rm -rf "$TMP"; ',
    "  trap - EXIT INT TERM HUP; ",
    "fi; ",
    'ln -sfn "$DEST" "$CUR"; ',
    `exec "$DEST/bin/node" -e "${REMOTE_NODE_EVAL_EXPR}"'`,
  ].join("");
}

/**
 * Builds a zero-admin PowerShell `-EncodedCommand` bootstrap script that downloads, SHA-256 verifies,
 * extracts into `$HOME\.kulo\node\v22.23.5`, and executes `PREPARE_REMOTE` in one SSH round-trip.
 */
export function buildWindowsNodeBootstrapCommand(
  target: ManagedNodeTarget,
  mirrors: readonly string[] = NODE_DIST_MIRRORS,
): string {
  if (target.platform !== "win32") {
    throw new Error("内部错误：Windows 自动安装仅支持 Windows 目标。");
  }
  const urlList = mirrors
    .map((base) => `'${`${base.replace(/\/+$/, "")}/v${target.version}/${target.archive}`.replaceAll("'", "''")}'`)
    .join(", ");

  return powershellEncodedCommand([
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}",
    "$NodeRoot = Join-Path $HOME '.kulo\\node'",
    `$Dest = Join-Path $NodeRoot 'v${target.version}'`,
    "$NodeExe = Join-Path $Dest 'node.exe'",
    "New-Item -ItemType Directory -Force -Path $NodeRoot | Out-Null",
    "$needInstall = $true",
    "if (Test-Path -LiteralPath $NodeExe) { try { & $NodeExe -v *> $null; if ($LASTEXITCODE -eq 0) { $needInstall = $false } } catch {} }",
    "if ($needInstall) {",
    "  $Tmp = Join-Path $NodeRoot ('.install-' + [Guid]::NewGuid().ToString('N'))",
    "  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null",
    "  try {",
    "    $Zip = Join-Path $Tmp 'node.zip'",
    "    $ok = $false",
    `    foreach ($u in @(${urlList})) {`,
    "      if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }",
    "      try {",
    "        Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $Zip -TimeoutSec 180",
    "        $got = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()",
    `        if ($got -eq '${target.sha256}') { $ok = $true; break }`,
    "      } catch {}",
    "    }",
    `    if (-not $ok) { [Console]::Error.WriteLine('KULO-BOOTSTRAP-ERR:自动下载或校验 Node.js v${target.version} 失败，请检查远端主机网络连接后重试。'); exit 1 }`,
    "    $Extract = Join-Path $Tmp 'x'",
    "    Expand-Archive -LiteralPath $Zip -DestinationPath $Extract -Force",
    `    $ExtDir = Join-Path $Extract '${target.folder}'`,
    "    $ExtNode = Join-Path $ExtDir 'node.exe'",
    "    if (-not (Test-Path -LiteralPath $ExtNode)) { [Console]::Error.WriteLine('KULO-BOOTSTRAP-ERR:解压 Node.js 失败，未找到可执行文件。'); exit 1 }",
    "    & $ExtNode -v *> $null",
    "    if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('KULO-BOOTSTRAP-ERR:远端主机无法运行官方 Node.js，请先手动安装 Node.js 22.19 或更新版本。'); exit 1 }",
    "    if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }",
    "    Move-Item -LiteralPath $ExtDir -Destination $Dest",
    "  } finally {",
    "    if (Test-Path -LiteralPath $Tmp) { Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue }",
    "  }",
    "}",
    `& $NodeExe -e "${REMOTE_NODE_EVAL_EXPR}"`,
    "exit $LASTEXITCODE",
  ].join("\n"));
}
