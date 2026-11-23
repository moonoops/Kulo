import type { ExternalAgentKind } from "@kulo/protocol";
import { getAcpFlavor } from "./external-agent-acp.js";

export interface NativeAgentEnvOptions {
  /** Sub-commands launched via ACP `terminal/create` should not inherit host LLM keys by default. */
  terminal?: boolean;
}

const KULO_OR_MEMORY_SECRET_RE =
  /^(?:KULO|HINDSIGHT)_.*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|PEER.*CONFIG)/i;

const HOST_PRODUCTION_SECRET_EXACT = new Set([
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PASSWORD",
  "MYSQL_PASSWORD",
  "MONGODB_URI",
  "REDIS_URL",
  "REDIS_PASSWORD",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_APP_TOKEN",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "PYPI_API_TOKEN",
  "TWINE_PASSWORD",
  "CARGO_REGISTRY_TOKEN",
  "SENTRY_AUTH_TOKEN",
  "VERCEL_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "NETLIFY_AUTH_TOKEN",
  "DIGITALOCEAN_ACCESS_TOKEN",
  "FLY_API_TOKEN",
  "RENDER_API_KEY",
  "SENDGRID_API_KEY",
  "RESEND_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "MAILGUN_API_KEY",
]);

const HOST_PRODUCTION_SECRET_RE = /^STRIPE_(?:SECRET_KEY|WEBHOOK_SECRET|API_KEY|RESTRICTED_KEY)$/i;

const KNOWN_LLM_API_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "KIRO_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "PERPLEXITY_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "DASHSCOPE_API_KEY",
  "ZHIPU_API_KEY",
  "MINIMAX_API_KEY",
  "VOLCENGINE_API_KEY",
  "ARK_API_KEY",
]);

const MULTI_VENDOR_AGENT_KINDS = new Set<ExternalAgentKind>(["opencode", "cursor", "acp"]);

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const norm = value.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}

function isAllowedLlmKeyForKind(
  name: string,
  kind: ExternalAgentKind,
): boolean {
  const upper = name.toUpperCase();
  if (kind === "claude-code") {
    return upper.startsWith("ANTHROPIC_") || upper.startsWith("CLAUDE_");
  }
  if (kind === "codex") {
    return upper.startsWith("OPENAI_") || upper.startsWith("CODEX_");
  }
  if (kind === "copilot") {
    return upper.startsWith("COPILOT_");
  }
  if (kind === "gemini-cli" || kind === "antigravity") {
    return upper === "GEMINI_API_KEY" || upper === "GOOGLE_API_KEY";
  }
  const approved = getAcpFlavor(kind)?.approvedEnvKeys ?? [];
  return approved.some((key) => key.toUpperCase() === upper);
}

/**
 * Pure Layer-1 environment filter for native external agent processes.
 *
 * - Always strips Kulo/Hindsight secrets and common non-model host production secrets
 *   (databases, Stripe, Slack, npm, cloud deploy tokens).
 * - Strips AWS/GCP host credentials unless explicitly required by Bedrock/Vertex/Kiro/Gemini modes.
 * - When `options.terminal === true`, strips all known LLM API keys from default sub-terminal env.
 * - When `kind` is provided for a single-vendor CLI (`claude-code`, `codex`, `grok`, `gemini-cli`,
 *   `antigravity`, `dsh`, `kiro`, `copilot`), strips cross-vendor LLM API keys while preserving
 *   multi-vendor CLIs (`opencode`, `cursor`, `acp`) and no-arg callers (`kind === undefined`).
 */
export function filterNativeAgentEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  kind?: ExternalAgentKind,
  options?: NativeAgentEnvOptions,
): NodeJS.ProcessEnv {
  const allowAwsForBedrock =
    (kind === "claude-code" && isTruthyEnvFlag(sourceEnv.CLAUDE_CODE_USE_BEDROCK)) ||
    kind === "kiro";
  const allowGcpForVertex =
    (kind === "claude-code" && isTruthyEnvFlag(sourceEnv.CLAUDE_CODE_USE_VERTEX)) ||
    kind === "gemini-cli" ||
    kind === "antigravity";

  const terminalMode = options?.terminal === true;
  const isolateVendorKeys = !terminalMode && kind !== undefined && !MULTI_VENDOR_AGENT_KINDS.has(kind);
  // Desktop GUI runtimes launched via `open -a` from SSH inherit stale SSH session markers that
  // cause local CLIs (e.g. Antigravity `agy`) to skip the unlocked OS keychain.
  const stripStaleDesktopSshSession = Boolean(sourceEnv.KULO_DESKTOP_DATA_DIR);

  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();

    if (KULO_OR_MEMORY_SECRET_RE.test(name)) continue;
    if (HOST_PRODUCTION_SECRET_EXACT.has(upper) || HOST_PRODUCTION_SECRET_RE.test(name)) continue;
    if (
      stripStaleDesktopSshSession &&
      (upper === "SSH_CLIENT" || upper === "SSH_CONNECTION" || upper === "SSH_TTY")
    ) {
      continue;
    }

    if ((upper === "AWS_SECRET_ACCESS_KEY" || upper === "AWS_SESSION_TOKEN") && !allowAwsForBedrock) {
      continue;
    }
    if (upper === "GOOGLE_APPLICATION_CREDENTIALS" && !allowGcpForVertex) {
      continue;
    }

    if (KNOWN_LLM_API_KEYS.has(upper)) {
      if (terminalMode) continue;
      if (isolateVendorKeys && !isAllowedLlmKeyForKind(name, kind)) continue;
    }

    filtered[name] = value;
  }

  return filtered;
}
