import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { ExternalAgentKind, ExternalAgentModelInfo } from "@kulo/protocol";
import type { RpcValue } from "./external-agent-rpc.js";

export interface AcpFlavorSpec {
  readonly kind: ExternalAgentKind;
  readonly binary: string;
  readonly acpArgs: readonly string[];
  /** Controlled launch args used when `ctx.readOnly === true`. */
  readonly readOnlyArgs?: readonly string[];
  readonly probeArgs?: readonly string[];
  readonly versionArgs?: readonly string[];
  readonly macAppPaths?: (home: string) => readonly string[];
  readonly extraToolDirs?: (home: string) => readonly string[];
  readonly approvedEnvKeys?: readonly string[];
  /** Relative subdirectories under `$HOME` where this client may read its own public skills/rules via ACP `fs/read_text_file`. */
  readonly readableSkillSubdirs?: readonly string[];
  readonly initializeMeta?: Record<string, unknown>;
  readonly cancelMeta?: Record<string, unknown>;
  readonly initializeTimeoutMs?: number;
  readonly modelAdvertisementGraceMs?: number;
  /** Prefer models returned by `initialize` during probe and skip `session/new` when non-empty. */
  readonly probeInitializeOnly?: boolean;
  /** Prefer `session/set_model` (with `_meta.reasoningEffort`) over `session/set_config_option`. */
  readonly preferSetSessionModel?: boolean;
  /** Handle xAI `x.ai/session/prompt_complete` extension notifications as prompt finality fallback. */
  readonly xaiPromptCompletionFallback?: boolean;
  /** Treat `session/load` replay going idle as ready for agents whose `session/load` may not reply. */
  readonly sessionLoadReplayIdleReadiness?: boolean;
  /** Side-effect-free native auth probe (never launches browser login or workspace MCP servers). */
  readonly detectAuth?: (executable: string, pathEnv: string) => Promise<boolean | null>;
}

const CANONICAL_EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function sortEffortTokens(efforts: readonly string[]): string[] {
  const deduped: string[] = [];
  for (const raw of efforts) {
    const token = raw.trim();
    if (token && !deduped.includes(token)) deduped.push(token);
  }
  const rank = (token: string) => CANONICAL_EFFORT_RANK.indexOf(token.toLowerCase() as typeof CANONICAL_EFFORT_RANK[number]);
  if (deduped.length > 1 && deduped.every((token) => rank(token) >= 0)) {
    return [...deduped].sort((left, right) => rank(left) - rank(right));
  }
  return deduped;
}

function asRecord(value: unknown): RpcValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RpcValue) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Grok CLI `grok models` always exits with code 0; only output text reports login state.
 */
export function parseGrokModelsOutput(output: string): {
  authenticated: boolean | null;
  models: ExternalAgentModelInfo[];
} {
  const authenticated = /you are logged in/i.test(output)
    ? true
    : /not authenticated|not logged in/i.test(output)
      ? false
      : null;

  const seen = new Set<string>();
  const models: ExternalAgentModelInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[*-]\s+(\S+)(.*)$/);
    const id = match?.[1]?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = id
      .split(/[-_]/g)
      .map((part) => (part.toLowerCase() === "grok" ? "Grok" : part))
      .join(" ");
    models.push({
      id,
      name,
      ...(/\(default\)/i.test(match?.[2] ?? "") ? { isDefault: true } : {}),
    });
  }
  return { authenticated, models };
}

function runQuickProbeCommand(executable: string, args: readonly string[], pathEnv: string, timeoutMs = 10_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: { HOME: os.homedir(), PATH: pathEnv, ...(process.env.XAI_API_KEY ? { XAI_API_KEY: process.env.XAI_API_KEY } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const finish = (value: { code: number | null; output: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 64_000) {
        try { child.kill(); } catch { /* ignore */ }
        finish({ code: null, output });
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error("Probe command timed out"));
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish({ code, output }));
  });
}

export async function detectGrokAuthenticated(
  executable: string,
  pathEnv: string,
  runner: (executable: string, args: readonly string[], pathEnv: string, timeoutMs?: number) => Promise<{ code: number | null; output: string }> = runQuickProbeCommand,
): Promise<boolean | null> {
  if (process.env.XAI_API_KEY?.trim()) return true;
  try {
    const result = await runner(executable, ["models"], pathEnv, 10_000);
    if (result.code !== 0) return null;
    return parseGrokModelsOutput(result.output).authenticated;
  } catch {
    return null;
  }
}

export function extractModelsFromAcpModelState(modelState: RpcValue): {
  models: ExternalAgentModelInfo[];
  currentModelId?: string;
} {
  const rawCurrent = asString(modelState.currentModelId).trim();
  const currentModelId = rawCurrent ? rawCurrent.split("?")[0] || undefined : undefined;
  const listed: Array<{ id: string; name: string }> = [];
  const perModelEfforts = new Map<string, string[]>();

  if (Array.isArray(modelState.availableModels)) {
    for (const rawEntry of modelState.availableModels) {
      const entry = asRecord(rawEntry);
      const rawId = asString(entry.modelId).trim() || asString(entry.id).trim();
      if (!rawId) continue;
      const qIndex = rawId.indexOf("?");
      const baseId = qIndex >= 0 ? rawId.slice(0, qIndex) : rawId;
      if (!baseId) continue;
      if (!listed.some((item) => item.id === baseId)) {
        listed.push({ id: baseId, name: asString(entry.name).trim() || baseId });
      }
      const efforts = perModelEfforts.get(baseId) ?? [];
      if (!perModelEfforts.has(baseId)) perModelEfforts.set(baseId, efforts);

      if (qIndex >= 0) {
        const query = new URLSearchParams(rawId.slice(qIndex + 1));
        const effortVal =
          query.get("thinkingLevel") ??
          query.get("thoughtLevel") ??
          query.get("effort") ??
          query.get("reasoningEffort");
        if (effortVal && !efforts.includes(effortVal)) efforts.push(effortVal);
      }

      const explicitEfforts = Array.isArray(entry.efforts)
        ? entry.efforts
        : Array.isArray(entry.supportedEfforts)
          ? entry.supportedEfforts
          : [];
      for (const item of explicitEfforts) {
        if (typeof item === "string" && item.trim() && !efforts.includes(item.trim())) {
          efforts.push(item.trim());
        }
      }

      const meta = asRecord(entry._meta);
      if (meta.supportsReasoningEffort !== false && Array.isArray(meta.reasoningEfforts)) {
        for (const rawLevel of meta.reasoningEfforts) {
          if (typeof rawLevel === "string") {
            const token = rawLevel.trim();
            if (token && !efforts.includes(token)) efforts.push(token);
            continue;
          }
          const level = asRecord(rawLevel);
          const token = asString(level.value).trim() || asString(level.id).trim();
          if (token && !efforts.includes(token)) efforts.push(token);
        }
      }
    }
  }

  const models: ExternalAgentModelInfo[] = listed.map((item) => {
    const rawEfforts = perModelEfforts.get(item.id) ?? [];
    const sorted = rawEfforts.length ? sortEffortTokens(rawEfforts) : [];
    return {
      ...item,
      ...(sorted.length ? { efforts: sorted } : {}),
      ...(currentModelId && item.id === currentModelId ? { isDefault: true } : {}),
    };
  });
  return { models, currentModelId };
}

export function extractModelsFromAcpInitialize(init: RpcValue): {
  models: ExternalAgentModelInfo[];
  currentModelId?: string;
} {
  const meta = asRecord(init._meta);
  const modelState = asRecord(meta.modelState);
  if (!Array.isArray(modelState.availableModels)) return { models: [] };
  return extractModelsFromAcpModelState(modelState);
}

const SENSITIVE_CREDENTIAL_EXACT_FILENAMES = new Set([
  "config.toml",
  "hosts.yml",
  "hosts.yaml",
  "mcp.json",
  "settings.json",
  "credentials",
  "auth",
  "oauth",
  "token",
  "tokens",
  "secret",
  "secrets",
  "cookies",
  "binarycookies",
]);

const SENSITIVE_CREDENTIAL_FILENAME_PATTERN =
  /^(?:\.env(?:\.[^/]+)?|\.[^/]*credentials[^/]*|(?:auth|credentials?|oauth|tokens?|secrets?)(?:[._-][a-z0-9_-]+)?\.(?:json|ya?ml|toml|txt|ini|conf|enc|dat|bin|key|pem)|.*\.(?:env|pem|key|p12|pfx|sqlite3?|db|cookies)(?:-(?:wal|shm))?)$/i;

/**
 * Checks only the final filename (basename) so public skill paths such as
 * `~/.gemini/config/skills/oauth-setup/SKILL.md` or `skills/state-machine/SKILL.md`
 * are never falsely rejected while credential/config/database files are strictly blocked.
 */
export function isSensitiveCredentialFilename(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (!base) return true;
  if (SENSITIVE_CREDENTIAL_EXACT_FILENAMES.has(base)) return true;
  return SENSITIVE_CREDENTIAL_FILENAME_PATTERN.test(base);
}

export const ACP_FLAVORS: Partial<Record<ExternalAgentKind, AcpFlavorSpec>> = {
  antigravity: {
    kind: "antigravity",
    binary: "agy",
    acpArgs: ["acp", "--process-per-session"],
    approvedEnvKeys: ["GEMINI_API_KEY"],
    macAppPaths: (home) => [
      "/Applications/Gemini.app/Contents/Helpers/agy",
      "/Applications/Antigravity.app/Contents/Resources/app/bin/agy",
      "/Applications/Antigravity.app/Contents/Resources/bin/agy",
      "/Applications/Antigravity.app/Contents/Helpers/agy",
      path.join(home, "Applications", "Gemini.app", "Contents", "Helpers", "agy"),
      path.join(home, "Applications", "Antigravity.app", "Contents", "Resources", "app", "bin", "agy"),
      path.join(home, ".gemini", "antigravity", "bin", "agy"),
      path.join(home, "Library", "Application Support", "Antigravity", "bin", "agy"),
    ],
    extraToolDirs: (home) => [
      path.join(home, ".gemini", "antigravity", "bin"),
      path.join(home, "Library", "Application Support", "Antigravity", "bin"),
    ],
    readableSkillSubdirs: [
      ".gemini/antigravity/builtin/skills",
      ".gemini/config/skills",
      ".gemini/skills",
    ],
  },
  grok: {
    kind: "grok",
    binary: "grok",
    acpArgs: ["agent", "stdio"],
    readOnlyArgs: ["--permission-mode", "default", "agent", "stdio"],
    probeArgs: ["agent", "stdio"],
    approvedEnvKeys: ["XAI_API_KEY"],
    extraToolDirs: (home) => [path.join(home, ".grok", "bin")],
    readableSkillSubdirs: [".grok/skills", ".grok/rules"],
    initializeMeta: { clientType: "extension" },
    cancelMeta: { cancelTrigger: "ctrl_c" },
    initializeTimeoutMs: 25_000,
    probeInitializeOnly: true,
    preferSetSessionModel: true,
    xaiPromptCompletionFallback: true,
    sessionLoadReplayIdleReadiness: true,
    detectAuth: detectGrokAuthenticated,
  },
  cursor: {
    kind: "cursor",
    binary: "cursor-agent",
    acpArgs: ["acp"],
    extraToolDirs: (home) => [path.join(home, ".cursor", "bin")],
    readableSkillSubdirs: [".cursor/rules", ".cursor/skills"],
  },
  opencode: {
    kind: "opencode",
    binary: "opencode",
    acpArgs: ["acp"],
    extraToolDirs: (home) => [path.join(home, ".opencode", "bin")],
    modelAdvertisementGraceMs: 2_500,
    readableSkillSubdirs: [".opencode/skills", ".config/opencode/skills"],
  },
  "gemini-cli": {
    kind: "gemini-cli",
    binary: "gemini",
    acpArgs: ["--acp"],
    approvedEnvKeys: ["GEMINI_API_KEY"],
    readableSkillSubdirs: [".gemini/skills"],
  },
  kiro: {
    kind: "kiro",
    binary: "kiro-cli",
    acpArgs: ["acp", "--agent-engine=v3", "--auth-method=cli"],
    approvedEnvKeys: ["KIRO_API_KEY"],
    extraToolDirs: (home) => [path.join(home, ".kiro", "bin")],
    readableSkillSubdirs: [".kiro/steering", ".kiro/skills"],
  },
  copilot: {
    kind: "copilot",
    binary: "copilot",
    acpArgs: ["--acp"],
  },
  dsh: {
    kind: "dsh",
    binary: "dsh",
    acpArgs: ["--profile", "acp"],
    approvedEnvKeys: ["DEEPSEEK_API_KEY"],
  },
};

export function getAcpFlavor(kind: ExternalAgentKind): AcpFlavorSpec | undefined {
  return ACP_FLAVORS[kind];
}

export function acpReadableSkillSubdirs(kind: ExternalAgentKind): readonly string[] {
  return ACP_FLAVORS[kind]?.readableSkillSubdirs ?? [];
}
