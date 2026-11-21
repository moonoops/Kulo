import {
  isBlockedCustomAcpExecutableName,
  isValidCustomAcpAgentRef,
  validateCustomAcpArgs,
  type AcpRegistryTemplate,
} from "@kulo/protocol";

const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_TEMPLATES = 120;

const BUILTIN_REGISTRY_IDS = new Set([
  "codex-acp",
  "claude-acp",
  "antigravity-acp",
  "grok-build",
  "cursor",
  "opencode",
  "opencode-v2",
  "gemini",
  "kiro",
  "github-copilot-cli",
]);

interface RegistryCache {
  fetchedAt: number;
  templates: AcpRegistryTemplate[];
}

let cachedRegistry: RegistryCache | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cleanText(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return undefined;
  return trimmed.slice(0, maxLen);
}

function extractBinaryBasename(cmd: string): string | undefined {
  const normalized = cmd.trim().replace(/\\/g, "/");
  if (!normalized || /[\x00-\x1f\x7f]/.test(normalized)) return undefined;
  const base = normalized.split("/").filter(Boolean).at(-1);
  if (!base || base === "." || base === ".." || !/^[A-Za-z0-9._-]{1,128}$/.test(base)) return undefined;
  if (isBlockedCustomAcpExecutableName(base)) return undefined;
  return base;
}

function platformBinaryKey(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  return `${os}-${arch}`;
}

export function parseAcpRegistryPayload(raw: unknown): AcpRegistryTemplate[] {
  const root = asRecord(raw);
  const agents = Array.isArray(root?.agents) ? root.agents : [];
  const platformKey = platformBinaryKey();
  const seen = new Set<string>();
  const templates: AcpRegistryTemplate[] = [];

  for (const item of agents) {
    if (templates.length >= MAX_TEMPLATES) break;
    const entry = asRecord(item);
    if (!entry) continue;
    const id = cleanText(entry.id, 64)?.toLowerCase();
    const name = cleanText(entry.name, 120);
    const version = cleanText(entry.version, 64);
    if (!id || !name || !version || seen.has(id) || BUILTIN_REGISTRY_IDS.has(id) || !isValidCustomAcpAgentRef(id)) {
      continue;
    }
    const description = cleanText(entry.description, 240);
    const distribution = asRecord(entry.distribution);
    if (!distribution) continue;

    const binaryMap = asRecord(distribution.binary);
    const binaryTarget = asRecord(binaryMap?.[platformKey]) ?? (binaryMap ? asRecord(Object.values(binaryMap)[0]) : undefined);
    const npxTarget = asRecord(distribution.npx);
    const uvxTarget = asRecord(distribution.uvx);

    let rawArgs: unknown = [];
    let suggestedBinary: string | undefined;
    let requiresLocalInstall = true;

    if (binaryTarget) {
      rawArgs = Array.isArray(binaryTarget.args) ? binaryTarget.args : [];
      if (typeof binaryTarget.cmd !== "string") continue;
      suggestedBinary = extractBinaryBasename(binaryTarget.cmd);
      if (!suggestedBinary) continue;
      requiresLocalInstall = false;
    } else if (npxTarget) {
      rawArgs = Array.isArray(npxTarget.args) ? npxTarget.args : [];
      suggestedBinary = id;
      requiresLocalInstall = true;
    } else if (uvxTarget) {
      rawArgs = Array.isArray(uvxTarget.args) ? uvxTarget.args : [];
      suggestedBinary = id;
      requiresLocalInstall = true;
    } else {
      continue;
    }

    const validatedArgs = validateCustomAcpArgs(rawArgs);
    if (!validatedArgs.ok) continue;

    seen.add(id);
    templates.push({
      id,
      name,
      version,
      ...(description ? { description } : {}),
      suggestedArgs: validatedArgs.value,
      ...(suggestedBinary ? { suggestedBinary } : {}),
      requiresLocalInstall,
    });
  }

  return templates.sort((left, right) => left.name.localeCompare(right.name));
}

async function readBoundedText(response: Response, limitBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limitBytes) {
      throw new Error("ACP registry payload exceeds size limit");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("ACP registry payload exceeds size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function fetchAcpRegistryTemplates(options?: {
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ templates: AcpRegistryTemplate[]; fetchedAt: number }> {
  const now = Date.now();
  if (!options?.forceRefresh && cachedRegistry && now - cachedRegistry.fetchedAt < CACHE_TTL_MS) {
    return {
      templates: cachedRegistry.templates.map((item) => ({ ...item, suggestedArgs: [...item.suggestedArgs] })),
      fetchedAt: cachedRegistry.fetchedAt,
    };
  }
  const fetchFn = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetchFn(ACP_REGISTRY_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return { templates: cachedRegistry?.templates ?? [], fetchedAt: cachedRegistry?.fetchedAt ?? 0 };
    const text = await readBoundedText(response, MAX_REGISTRY_BYTES);
    const parsed = parseAcpRegistryPayload(JSON.parse(text));
    cachedRegistry = { fetchedAt: now, templates: parsed };
    return {
      templates: parsed.map((item) => ({ ...item, suggestedArgs: [...item.suggestedArgs] })),
      fetchedAt: now,
    };
  } catch {
    return { templates: cachedRegistry?.templates ?? [], fetchedAt: cachedRegistry?.fetchedAt ?? 0 };
  } finally {
    clearTimeout(timer);
  }
}

export function resetAcpRegistryCacheForTest(): void {
  cachedRegistry = undefined;
}
