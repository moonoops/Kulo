export const PEER_RUNTIME_DEPS = [
  "undici@8.12.4",
  "@anthropic-ai/claude-agent-sdk@0.3.326",
  "@earendil-works/pi-env@1.5.2",
  "ws@8.22.2",
  "agent-browser@0.43.0",
  "agent-desktop@1.3.1",
] as const;

export const INSTALL_STAGE_MARKER = "KULO-INSTALL-STAGE:";

const PRIMARY_NPM_REGISTRY = "https://registry.npmjs.org";
const FALLBACK_NPM_REGISTRY = "https://registry.npmmirror.com";
const DEFAULT_PROBE_PATH = "undici/-/undici-8.12.4.tgz";
const DEFAULT_PROBE_MIN_BYTES = 100_000;
const DEFAULT_PROBE_TIMEOUT_MS = 6_000;
const DEFAULT_ATTEMPT_TIMEOUTS_MS: readonly [number, number] = [120_000, 150_000];

const DEFAULT_OPTIONAL_PLATFORM_DEPS: Record<string, readonly string[]> = {
  "linux-x64-glibc": [
    "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.326",
    "@agent-browser/cli-linux-x64-gnu@0.43.0",
  ],
  "linux-arm64-glibc": [
    "@anthropic-ai/claude-agent-sdk-linux-arm64@0.3.326",
    "@agent-browser/cli-linux-arm64-gnu@0.43.0",
  ],
  "linux-x64-musl": [
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.326",
    "@agent-browser/cli-linux-x64-musl@0.43.0",
  ],
  "linux-arm64-musl": [
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.326",
    "@agent-browser/cli-linux-arm64-musl@0.43.0",
  ],
  "darwin-x64": [
    "@anthropic-ai/claude-agent-sdk-darwin-x64@0.3.326",
    "@agent-browser/cli-darwin-x64@0.43.0",
  ],
  "darwin-arm64": [
    "@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.326",
    "@agent-browser/cli-darwin-arm64@0.43.0",
  ],
  "win32-x64": [
    "@anthropic-ai/claude-agent-sdk-win32-x64@0.3.326",
    "@agent-browser/cli-win32-x64-msvc@0.43.0",
  ],
  "win32-arm64": [
    "@anthropic-ai/claude-agent-sdk-win32-arm64@0.3.326",
  ],
};

export interface PeerInstallerRenderOptions {
  deps?: readonly string[];
  optionalPlatformDeps?: Record<string, readonly string[]>;
  registries?: readonly [string, string];
  attemptTimeoutsMs?: readonly [number, number];
  probePath?: string;
  probeMinBytes?: number;
  probeTimeoutMs?: number;
}

function buildDepsInstallerScript(options: PeerInstallerRenderOptions = {}): string {
  const config = {
    deps: [...(options.deps ?? PEER_RUNTIME_DEPS)],
    optionalPlatformDeps: options.optionalPlatformDeps ?? DEFAULT_OPTIONAL_PLATFORM_DEPS,
    registries: [...(options.registries ?? [PRIMARY_NPM_REGISTRY, FALLBACK_NPM_REGISTRY])],
    attemptTimeoutsMs: [...(options.attemptTimeoutsMs ?? DEFAULT_ATTEMPT_TIMEOUTS_MS)],
    probePath: options.probePath ?? DEFAULT_PROBE_PATH,
    probeMinBytes: options.probeMinBytes ?? DEFAULT_PROBE_MIN_BYTES,
    probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  };

  return `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const CFG = ${JSON.stringify(config)};
const runtime = process.argv[1];
if (!runtime) { console.error("Missing runtime directory."); process.exit(1); }

const win = process.platform === "win32";
const lockPath = path.join(runtime, ".install.lock");
const markerPath = path.join(runtime, ".kulo-deps.json");
let lockHeld = false;
let cancelled = false;
let activeChild = null;
let activeKillTimer = null;

function platformKey() {
  if (process.platform === "linux") {
    let glibc = true;
    try {
      const report = process.report && typeof process.report.getReport === "function" ? process.report.getReport() : null;
      glibc = Boolean(report && report.header && report.header.glibcVersionRuntime);
    } catch {}
    return "linux-" + process.arch + "-" + (glibc ? "glibc" : "musl");
  }
  return process.platform + "-" + process.arch;
}

function parseSpec(spec) {
  const idx = spec.lastIndexOf("@");
  if (idx <= 0) return { name: spec, version: "" };
  return { name: spec.slice(0, idx), version: spec.slice(idx + 1) };
}

function requiredSpecs() {
  const opt = CFG.optionalPlatformDeps[platformKey()] || [];
  return [...CFG.deps, ...opt];
}

function verifyInstalled(specs) {
  const nm = path.join(runtime, "node_modules");
  for (const spec of specs) {
    const { name, version } = parseSpec(spec);
    const pj = path.join(nm, ...name.split("/"), "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(pj, "utf8"));
      if (!parsed || parsed.version !== version) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function markerMatches(specs) {
  try {
    const data = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return Boolean(
      data &&
      data.platform === platformKey() &&
      Array.isArray(data.deps) &&
      JSON.stringify(data.deps) === JSON.stringify(specs)
    );
  } catch {
    return false;
  }
}

function writeMarkerAtomic(specs) {
  const tmp = markerPath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ platform: platformKey(), deps: specs, updatedAt: Date.now() }), { mode: 0o600 });
  fs.renameSync(tmp, markerPath);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
}

async function acquireLock() {
  const deadline = Date.now() + 15_000;
  while (true) {
    if (cancelled) throw new Error("Kulo runtime dependency installation cancelled.");
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
      lockHeld = true;
      return;
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
      let stale = true;
      try {
        const cur = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        const age = typeof cur.at === "number" ? Date.now() - cur.at : Number.POSITIVE_INFINITY;
        if (pidAlive(cur.pid) && age >= 0 && age < 600_000) stale = false;
      } catch {}
      if (stale) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Another Kulo runtime dependency installation is still in progress.");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    const cur = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (cur && cur.pid === process.pid) fs.unlinkSync(lockPath);
  } catch {}
}

function cleanStaleArtifacts() {
  try { fs.unlinkSync(path.join(runtime, "package-lock.json")); } catch {}
  const nm = path.join(runtime, "node_modules");
  let entries;
  try { entries = fs.readdirSync(nm, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(nm, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      let subs;
      try { subs = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const sub of subs) {
        if (sub.name.startsWith(".") && sub.name.includes("-")) {
          try { fs.rmSync(path.join(full, sub.name), { recursive: true, force: true }); } catch {}
        }
      }
    } else if (entry.name.startsWith(".") && entry.name !== ".bin" && entry.name !== ".package-lock.json" && entry.name.includes("-")) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
    }
  }
}

function normalizeRegistry(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/^["']|["']$/g, "").replace(/\\/+$/, "");
  return /^https?:\\/\\//i.test(trimmed) ? trimmed : "";
}

function discoverCustomRegistry() {
  const fromKulo = normalizeRegistry(process.env.KULO_NPM_REGISTRY);
  if (fromKulo) return fromKulo;
  const envKey = Object.keys(process.env).find((k) => k.toLowerCase() === "npm_config_registry");
  const fromEnv = envKey ? normalizeRegistry(process.env[envKey]) : "";
  if (fromEnv) return fromEnv;
  for (const rcPath of [path.join(runtime, ".npmrc"), path.join(os.homedir(), ".npmrc")]) {
    try {
      const content = fs.readFileSync(rcPath, "utf8");
      const m = content.match(/^\\s*registry\\s*=\\s*([^\\s#]+)/m);
      const parsed = m ? normalizeRegistry(m[1]) : "";
      if (parsed) return parsed;
    } catch {}
  }
  return "";
}

async function probeRegistries(candidates) {
  if (candidates.length < 2 || !CFG.probePath) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CFG.probeTimeoutMs);
  timer.unref();
  try {
    const probes = candidates.map((reg) => (async () => {
      const url = reg.replace(/\\/+$/, "") + "/" + CFG.probePath.replace(/^\\/+/, "");
      const res = await fetch(url, { redirect: "follow", signal: ac.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength < CFG.probeMinBytes || buf[0] !== 0x1f || buf[1] !== 0x8b) {
        throw new Error("Invalid tarball probe");
      }
      ac.abort();
      return reg;
    })());
    return await Promise.any(probes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

function resolveNpmSpawn(npmArgs) {
  const execDir = path.dirname(process.execPath);
  const bundledCli = win
    ? path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js")
    : path.join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(bundledCli)) {
    return { cmd: process.execPath, args: [bundledCli, ...npmArgs], opts: {} };
  }
  if (win) {
    const quoteCmd = (arg) => /[\\s"&|<>^()%]/.test(arg) ? '"' + arg.replace(/"/g, '""') + '"' : arg;
    const line = "npm.cmd " + npmArgs.map(quoteCmd).join(" ");
    return { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", '"' + line + '"'], opts: { windowsVerbatimArguments: true } };
  }
  return { cmd: "npm", args: npmArgs, opts: {} };
}

function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (win) {
    const root = process.env.SystemRoot || process.env.windir;
    const tk = root ? path.join(root, "System32", "taskkill.exe") : "taskkill.exe";
    const killer = cp.spawn(tk, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => { try { child.kill(); } catch {} });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  activeKillTimer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }, 400);
  activeKillTimer.unref();
}

function runNpmAttempt(registry, timeoutMs) {
  return new Promise((resolve) => {
    const npmArgs = [
      "install",
      "--prefix", runtime,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefer-offline",
      "--fetch-retries=1",
      "--fetch-retry-mintimeout=2000",
      "--fetch-retry-maxtimeout=10000",
      "--fetch-timeout=20000",
      ...(registry ? ["--registry=" + registry] : []),
      ...CFG.deps,
    ];
    const spec = resolveNpmSpawn(npmArgs);
    const child = cp.spawn(spec.cmd, spec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: !win,
      windowsHide: true,
      ...spec.opts,
    });
    activeChild = child;
    let timedOut = false;
    let settled = false;
    let errTail = "";
    const appendErr = (chunk) => {
      errTail = (errTail + chunk.toString("utf8")).slice(-2048);
      process.stderr.write(chunk);
    };
    child.stdout.on("data", appendErr);
    child.stderr.on("data", appendErr);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref();
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeKillTimer) { clearTimeout(activeKillTimer); activeKillTimer = null; }
      if (activeChild === child) activeChild = null;
      resolve({ ok: !timedOut && !cancelled && code === 0, timedOut, code, errTail });
    };
    child.once("error", (err) => {
      errTail = err && err.message ? err.message : String(err);
      finish(1);
    });
    child.once("close", (code) => finish(code === null ? 1 : code));
    if (cancelled) killTree(child);
  });
}

function onSignal() {
  if (cancelled) return;
  cancelled = true;
  if (activeChild) {
    const child = activeChild;
    killTree(child);
    const exitTimer = setTimeout(() => { releaseLock(); process.exit(143); }, 600);
    exitTimer.unref();
    child.once("close", () => { clearTimeout(exitTimer); releaseLock(); process.exit(143); });
  } else {
    releaseLock();
    process.exit(143);
  }
}

process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);
process.on("SIGHUP", onSignal);

(async () => {
  const specs = requiredSpecs();
  if (markerMatches(specs) && verifyInstalled(specs)) return;
  await acquireLock();
  try {
    if (markerMatches(specs) && verifyInstalled(specs)) return;
    const custom = discoverCustomRegistry();
    const baseRegs = CFG.registries.map(normalizeRegistry).filter(Boolean);
    const winner = custom ? null : await probeRegistries(baseRegs);
    let plan;
    if (custom) {
      plan = [custom, ...baseRegs.filter((r) => r !== custom)];
    } else if (winner) {
      plan = [winner, ...baseRegs.filter((r) => r !== winner)];
    } else {
      plan = [undefined, baseRegs[1] || baseRegs[0]].filter((v, idx, arr) => idx === 0 || v !== arr[0]);
    }
    let lastReason = "Kulo runtime dependency installation failed.";
    for (let i = 0; i < plan.length; i++) {
      if (cancelled) process.exit(143);
      cleanStaleArtifacts();
      const timeoutMs = CFG.attemptTimeoutsMs[Math.min(i, CFG.attemptTimeoutsMs.length - 1)] || 150_000;
      const result = await runNpmAttempt(plan[i], timeoutMs);
      if (cancelled) process.exit(143);
      if (result.ok && verifyInstalled(specs)) {
        writeMarkerAtomic(specs);
        return;
      }
      if (result.timedOut) {
        lastReason = "npm install timed out after " + Math.round(timeoutMs / 1000) + "s";
      } else if (result.ok) {
        lastReason = "npm install completed without required platform binary packages.";
      } else {
        lastReason = "npm install exited with code " + result.code;
      }
    }
    throw new Error(lastReason);
  } finally {
    releaseLock();
  }
})().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exitCode = 1;
});`;
}

export function renderPeerInstaller(
  platform: "posix" | "powershell",
  options?: PeerInstallerRenderOptions,
): string {
  const depsScript = buildDepsInstallerScript(options);
  if (platform === "powershell") {
    return [
      "param([Parameter(Mandatory=$true)][string]$HubUrl, [string]$InviteToken = $env:KULO_PEER_INVITE)",
      "if (-not $InviteToken) { throw 'Missing invitation' }",
      "$ErrorActionPreference = 'Stop'",
      `function Write-KuloStage([string]$Stage) { if ($env:KULO_INSTALL_PROGRESS -eq '1') { Write-Output ('${INSTALL_STAGE_MARKER}' + $Stage) } }`,
      `& node -e "if(process.versions.node.split('.').map(Number)[0]<22||(process.versions.node.startsWith('22.')&&Number(process.versions.node.split('.')[1])<19))process.exit(1)"`,
      "if ($LASTEXITCODE -ne 0) { throw 'Kulo requires Node.js 22.19 or newer.' }",
      "$Runtime = Join-Path $HOME '.kulo/runtime'",
      "New-Item -ItemType Directory -Force $Runtime | Out-Null",
      "Write-KuloStage 'downloading-peer'",
      "Invoke-WebRequest -MaximumRedirection 0 -Uri ($HubUrl.TrimEnd('/') + '/connect/peer.mjs') -OutFile (Join-Path $Runtime 'peer.mjs.download')",
      "Move-Item -Force (Join-Path $Runtime 'peer.mjs.download') (Join-Path $Runtime 'peer.mjs')",
      "Write-KuloStage 'installing-deps'",
      "$KuloDepsJs = @'",
      depsScript,
      "'@",
      "& node -e $KuloDepsJs $Runtime",
      "if ($LASTEXITCODE -ne 0) { throw 'Kulo runtime dependency installation failed.' }",
      "Write-KuloStage 'pairing'",
      "$env:KULO_PEER_INVITE = $InviteToken",
      "& node (Join-Path $Runtime 'peer.mjs') install --hub $HubUrl",
      "if ($LASTEXITCODE -ne 0) { throw 'Kulo device pairing failed.' }",
      "",
    ].join("\n");
  }
  return [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    "KULO_PEER_HUB_URL=${1:?Missing Hub URL}",
    'while [ "${KULO_PEER_HUB_URL%/}" != "$KULO_PEER_HUB_URL" ]; do KULO_PEER_HUB_URL=${KULO_PEER_HUB_URL%/}; done',
    "KULO_PEER_INVITE=${2:-${KULO_PEER_INVITE:?Missing invitation}}",
    "export KULO_PEER_INVITE",
    `kulo_stage() { if [ "\${KULO_INSTALL_PROGRESS:-}" = "1" ]; then printf '${INSTALL_STAGE_MARKER}%s\\n' "$1"; fi; }`,
    "command -v node >/dev/null 2>&1 || { echo 'Kulo requires Node.js 22.19 or newer.' >&2; exit 1; }",
    `node -e "if(process.versions.node.split('.').map(Number)[0]<22||(process.versions.node.startsWith('22.')&&Number(process.versions.node.split('.')[1])<19))process.exit(1)" || { echo 'Kulo requires Node.js 22.19 or newer.' >&2; exit 1; }`,
    'KULO_PEER_RUNTIME="$HOME/.kulo/runtime"',
    'mkdir -p "$KULO_PEER_RUNTIME"',
    'chmod 700 "$HOME/.kulo" "$KULO_PEER_RUNTIME"',
    "kulo_stage downloading-peer",
    'if command -v curl >/dev/null 2>&1; then',
    '  curl -fsS --connect-timeout 15 --max-time 60 "$KULO_PEER_HUB_URL/connect/peer.mjs" -o "$KULO_PEER_RUNTIME/peer.mjs.download"',
    "else",
    `  node -e "fetch(process.argv[1],{redirect:'error',signal:AbortSignal.timeout(30000)}).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);require('node:fs').writeFileSync(process.argv[2],await r.text());}).catch(e=>{console.error(e.message);process.exit(1);})" "$KULO_PEER_HUB_URL/connect/peer.mjs" "$KULO_PEER_RUNTIME/peer.mjs.download"`,
    "fi",
    'mv "$KULO_PEER_RUNTIME/peer.mjs.download" "$KULO_PEER_RUNTIME/peer.mjs"',
    "kulo_stage installing-deps",
    "KULO_DEPS_JS=$(cat <<'KULO_DEPS_EOF'",
    depsScript,
    "KULO_DEPS_EOF",
    ")",
    'node -e "$KULO_DEPS_JS" "$KULO_PEER_RUNTIME"',
    "kulo_stage pairing",
    'node "$KULO_PEER_RUNTIME/peer.mjs" install --hub "$KULO_PEER_HUB_URL"',
    "",
  ].join("\n");
}
