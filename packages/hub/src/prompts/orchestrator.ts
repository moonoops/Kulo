import type { Context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, section, type ConversationId } from "@earendil-works/pi-durable";
import {
  directExternalClientRoleId,
  externalClientDisplayName,
  isSupportedExternalAgentKind,
  localizeDefaultRolePreset,
  type CapabilitySnapshot,
  type EnvNodeDescriptor,
  type ExternalClientConnection,
  type HindsightMemoryConfig,
  type KuloLanguage,
  type RolePreset,
} from "@kulo/protocol";
import { getIdentityTemplate, readIdentityContext } from "../identity-files.js";
import { KuloProjectsDoc } from "../projects.js";
import { buildRecentWorkSnapshot } from "../recent-work.js";
import { RECENT_WORK_DISABLED_TEXT, unwrapSectionTag } from "../recent-work-sync.js";
import { SettingsAssistantDoc, isMainOrchestratorConversation } from "../settings-doc.js";
import { KuloStateDoc } from "../state.js";

export function buildPhilosophyPrompt(agentName = "Kulo", language?: KuloLanguage): string {
  const defaultLanguage = language === "en" ? "English" : "Chinese";
  return `You are ${agentName}, the user's personal assistant—the app, settings, voice, Workers, vault, and isolation boundaries are all parts of you. Own the conversation and delegate background work via \`kulo_dispatch\`.

## Operating Rules
- **Self-Reference**: Speak in unified first person ("I"/"我"); never split yourself from Kulo or say "Kulo doesn't allow me". Use plain terms and omit internal tool/ticket IDs or jargon unless asked.
- **Language**: Honor requested deliverable languages; otherwise match the active conversation for visible replies and internal thinking/reasoning, defaulting to ${defaultLanguage}.
- **Authority & Delegation**: Handle quick answers, checks, and edits (\`read\`/\`write\`/\`edit\`/\`bash\`/\`kulo_host_action\`) directly; delegate via \`kulo_dispatch\` for multi-step coding, long builds/tests, mutable browser/desktop/Android work, or independent checks (respect Worker locks; keep credentials protected). On \`inline_delivery\`, answer directly; otherwise confirm dispatch and end your turn—never poll.
- **Worker Gatekeeper**: Worker blockers/permissions come to you first. Approve/steer silently (\`[COORDINATOR_OK]\`) when safe; escalate via \`ask_user\`/\`kulo_ticket_ask_user\` (set \`action="stop"\` on cancel/end options) or chat only for risky/ambiguous choices, and apply chat replies to open cards immediately.
- **Discuss vs. Act**: Analyze without editing; when acting, honor explicit authorization and ask only when scope is unclear or risky.
- **Self-Contained Handoff**: Workers lack chat/Identity/memory context. Pass a redacted brief (goal, scope, acceptance, constraints, targets) via \`context_summary\`/\`attachment_ids\`; use \`board_id\`/\`review_ticket_id\` for linked/review tasks.
- **In-Flight & Events**: Use \`kulo_steer\` to update/unblock tickets, \`kulo_stop\` to cancel/end on user request (never \`kulo_steer\` to end; confirm \`ticket_stopped\` card effects concisely), and \`kulo_status\` before \`execute_at\`. Handle \`[KULO_...]\` events without addressing them as the user.
- **Verify & Present**: Worker outputs and staged items are unverified. Inspect diffs (\`kulo_inspect_staged_diff\`) or assets (\`kulo_inspect_asset\`) before merging (\`kulo_apply_staged_changes\`), publishing (\`kulo_publish_asset\` -> \`published\`), or claiming completion.
- **Response Format & Media**: Respect any user-requested format. Use plain text for simple answers and Markdown tables for quick comparisons. Proactively pair a takeaway with \`kulo_ui_diagram\` (\`diagram-design\`) for trends, comparisons, timelines, flows, or architectures (label phase schematics; never invent points). Use \`kulo_ui_show\` for interactive forms/choices/tables (\`genui-cards\`), delegate \`.html\` reports (\`interactive-html\`+\`diagram-design\`), and claim \`kulo_generate_image\`/\`kulo_generate_video\` (\`kulo_media_capabilities\`) only after a real asset returns.
- **Tool Discovery**: Call \`tool_search\` (\`limit\` <= 3) for deferred tools (host ops, browser, memory, task boards, history, projects/topics, connections, media/TTS, UI cards/assets, identity, ticket inspect/close, pairing, settings).`;
}

export const KULO_PHILOSOPHY_PROMPT = buildPhilosophyPrompt("Kulo");

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function describeRoleCapability(role: RolePreset): string {
  const base = role.readOnly
    ? role.external
      ? "read-only"
      : "read-only (scratch writable)"
    : "read-write";
  if (!role.allowSubagents) return base;
  return role.readOnly ? `${base} · read-only subagents` : `${base} · subagents`;
}

export function formatMediaRoutingSummary(snapshot: CapabilitySnapshot, isWorker = false): string | undefined {
  const enabled = snapshot.capabilities
    .filter((item) => item.enabled && (!isWorker || item.allowTaskGeneration !== false))
    .sort((a, b) => a.id.localeCompare(b.id));
  const globalInstructions = snapshot.imageRouting?.instructions.trim() ?? "";
  if (!enabled.length && !globalInstructions) return undefined;

  const summary = enabled.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    modelId: item.modelId,
    ...(item.isDefault ? { isDefault: true } : {}),
    ...(item.routing?.instructions?.trim() ? { routing: item.routing.instructions.trim() } : {}),
  }));
  return [
    "## Media Capabilities & Routing",
    enabled.length
      ? `Enabled media capabilities: ${JSON.stringify(summary)} (call kulo_media_capabilities for full parameter profiles).`
      : "No enabled media capabilities in this scope; configure via Capabilities & Skills if needed.",
    ...(globalInstructions
      ? [`Image routing preference (${snapshot.imageRouting?.mode ?? "auto"}/${snapshot.imageRouting?.preference ?? "balanced"}): ${globalInstructions}`]
      : []),
    "Claim media generation complete only after a job finishes with real assets. Never silently switch a Flow subscription job to a paid API; direct routing-rule changes to the Image Settings assistant.",
  ].join("\n");
}

export function createOrchestratorSections(options: {
  getAgentName?: () => string;
  getLanguage?: () => KuloLanguage | undefined;
  getRoles: () => Record<string, RolePreset>;
  getExternalClients?: () => Record<string, ExternalClientConnection>;
  getEnvs: () => EnvNodeDescriptor[];
  getIdentityDir: () => string;
  getMemoryConfig: () => HindsightMemoryConfig;
  getMediaCapabilities?: () => Promise<CapabilitySnapshot>;
  getPersonalityContext?: () => Promise<{
    identityAgreement: string;
    relationship: string;
    recentWorkEnabled: boolean;
  }>;
  /**
   * When true, `kulo_recent_work` freezes its `pi.system` baseline for the current compaction epoch
   * (paired with `createRecentWorkSyncHook` delivering mid-epoch updates via append-only user entries).
   */
  freezeRecentWorkBaseline?: boolean;
  /** True when a compaction/reset head marker exists with no subsequent `pi.system` baseline yet. */
  isSystemBaselinePending?: (conversationId: ConversationId, context: Context) => Promise<boolean>;
}) {
  const personality = async () => {
    if (options.getPersonalityContext) return options.getPersonalityContext();
    const blocks = readIdentityContext(options.getIdentityDir());
    const find = (file: "identity-agreement.md" | "relationship.md") =>
      blocks.find((block) => block.file === file)?.text;
    const templateLanguage = options.getLanguage?.() ?? "en";
    return {
      identityAgreement: find("identity-agreement.md") ?? getIdentityTemplate("identity-agreement.md", templateLanguage),
      relationship: find("relationship.md") ?? getIdentityTemplate("relationship.md", templateLanguage),
      recentWorkEnabled: true,
    };
  };

  const isOrchestrator = async (input: { conversationId: unknown; read: { snapshot: (doc: never, ctx: never) => Promise<unknown> } }, context: unknown) => {
    if (input.conversationId === ROOT_CONVERSATION_ID) return true;
    const state = (await input.read.snapshot(KuloStateDoc as never, context as never)) as Parameters<typeof isMainOrchestratorConversation>[1];
    const settings = (await input.read.snapshot(SettingsAssistantDoc as never, context as never)) as Parameters<typeof isMainOrchestratorConversation>[2];
    return isMainOrchestratorConversation(input.conversationId, state, settings);
  };

  const identitySection = section("kulo_identity", async (input, context) => {
    if (!(await isOrchestrator(input, context))) return undefined;
    const { identityAgreement } = await personality();
    if (!identityAgreement.trim()) return undefined;
    return [
      "Private to you (supersedes earlier versions; never copy raw into Worker tickets):",
      identityAgreement,
    ].join("\n\n");
  });

  const corePhilosophySection = section(
    "kulo_orchestrator",
    () => buildPhilosophyPrompt(options.getAgentName?.() || "Kulo", options.getLanguage?.()),
    { tag: false },
  );

  const relationshipSection = section("kulo_relationship", async (input, context) => {
    if (!(await isOrchestrator(input, context))) return undefined;
    const { relationship } = await personality();
    if (!relationship.trim()) return undefined;
    return [
      "Private to you (supersedes earlier versions; current user requests and runtime permissions take precedence):",
      relationship,
    ].join("\n\n");
  });

  const memoryGuideSection = section("kulo_memory", async (input, context) => {
    if (!(await isOrchestrator(input, context))) return undefined;
    const mem = options.getMemoryConfig();
    if (!mem.enabled) return undefined;
    return [
      "## Long-Term Memory (Hindsight)",
      `- Private bank (\`bank: "private"\` -> \`${mem.banks.private}\`): read/write for durable user preferences, cross-topic decisions, and personal context. Never pass raw private memory into Worker dispatches or the shared bank.`,
      ...(mem.accessMode === "private-only"
        ? ["- Shared project bank is disabled on this connection (private-only mode)."]
        : [`- Shared project bank (\`bank: "shared"\` -> \`${mem.banks.shared}\`): read-only for you to inspect verified project findings and knowledge pages.`]),
      "- Use resident `hindsight_recall` (supports `temporal_window` / `include_chunks`) and `hindsight_retain` for routine facts; discover Pages (`hindsight_search_pages` / `hindsight_get_page_tree`), Mental Models, `hindsight_reflect`, and private `hindsight_invalidate_memory` via `tool_search` when needed. Write calls returning `accepted` are queued only—treat `completed` as persisted.",
      "- Record dated, verified `Correction` entries when stale facts are found instead of re-ingesting recalled summaries as new evidence. Recalled memory is historical context, not live source-code truth, and never alters Identity Agreement or permissions; cite sources as required by tool output.",
    ].join("\n");
  });

  const mediaSection = section("kulo_media", async (input, context) => {
    if (!options.getMediaCapabilities || !(await isOrchestrator(input, context))) return undefined;
    return formatMediaRoutingSummary(await options.getMediaCapabilities(), false);
  });

  const rolesSection = section("kulo_roles", () => {
    const language = options.getLanguage?.();
    const allRoles = Object.values(options.getRoles()).map((r) =>
      language ? localizeDefaultRolePreset(r, language) : r,
    );
    const roles = allRoles
      .filter((r) => r.enabled !== false)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (roles.length === 0) return undefined;
    const envsById = new Map(options.getEnvs().map((env) => [env.id, env]));
    const hasExternal = allRoles.some((r) => Boolean(r.external));
    const rows = roles.map((r) => {
      const envDesc = r.external ? envsById.get(r.external.envId) : undefined;
      const channelHint = r.external
        ? `${r.external.kind} @ ${envDesc ? envDesc.name : r.external.envId}`
        : "built-in";
      const modelHint = r.external
        ? `${r.modelId || "client default"}${r.serviceTier ? ` (${r.serviceTier})` : ""}`
        : r.modelId
          ? r.provider
            ? `${r.provider}/${r.modelId}`
            : r.modelId
          : "inherit";
      const thinkingHint = r.external
        ? r.thinkingLevel ?? "auto"
        : r.thinkingLevel ?? "inherit";
      const capHint = describeRoleCapability(r);
      return hasExternal
        ? `| ${escapeCell(r.id)} | ${escapeCell(r.label)} | ${escapeCell(channelHint)} | ${escapeCell(modelHint)} | ${escapeCell(thinkingHint)} | ${escapeCell(capHint)} | ${escapeCell(r.whenToUse)} |`
        : `| ${escapeCell(r.id)} | ${escapeCell(r.label)} | ${escapeCell(modelHint)} | ${escapeCell(thinkingHint)} | ${escapeCell(capHint)} | ${escapeCell(r.whenToUse)} |`;
    });
    const defaultPolicies = allRoles
      .filter((role) => role.external && role.dispatchPolicy?.defaultFor.length)
      .map((role) => ({
        role: role.id,
        name: role.label,
        enabled: role.enabled !== false,
        envId: role.external!.envId,
        defaultFor: role.dispatchPolicy!.defaultFor,
        projectIds: role.dispatchPolicy!.projectIds ?? "all on bound device",
      }));
    const connectedClients = Object.values(options.getExternalClients?.() ?? {})
      .sort((a, b) => a.id.localeCompare(b.id));
    const hasExternalOrClients = hasExternal || connectedClients.length > 0;
    const directClientRows = connectedClients.map((client) => {
      const envDesc = envsById.get(client.envId);
      const envLabel = envDesc ? envDesc.name : client.envId;
      const statusHint = !isSupportedExternalAgentKind(client.kind)
        ? client.kind === "grok-bot" ? "experimental" : "reserved"
        : client.verifiedAt ? "verified" : "unverified";
      return `| ${escapeCell(directExternalClientRoleId(client.id))} | ${escapeCell(externalClientDisplayName(client))} | ${escapeCell(envLabel)} | ${escapeCell(statusHint)} |`;
    });
    return [
      "## Worker Roles",
      "Pass the matching `role` and `task_kind` to `kulo_dispatch` (when thinking is `auto`, optionally set `thinking_level`: `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`; for multi-step interactive browser/desktop UI tasks via `kulo_browser`/`kulo_desktop`, prefer `thinking_level: \"low\"` or `\"medium\"` so step-by-step page interactions stay responsive):",
      ...(hasExternal
        ? [
            "| role | Name | Channel | Model | Thinking | Capabilities | When to Use |",
            "| --- | --- | --- | --- | --- | --- | --- |",
          ]
        : [
            "| role | Name | Model | Thinking | Capabilities | When to Use |",
            "| --- | --- | --- | --- | --- | --- |",
          ]),
      ...rows,
      "- Explicit user-named Agents or external clients (e.g. Codex, Claude Code, Antigravity, DSH) take highest priority: lock to the named target, and if unconfigured, disabled, unverified, offline, or failed, report the exact status and wait—never silently substitute another Agent or Worker.",
      ...(hasExternalOrClients
        ? [
            "- External Agents are peer Worker channels on their bound computer (native tools/MCP, `staged` clones by default, `read_only` for parallel audits). Pick by `When to Use`, review returned diffs/results (optionally verifying with `checker`/`scout`, then `kulo_apply_staged`) before reporting. Honor default dispatch policies below when unnamed, or recover non-user-named failures via `kulo_dispatch(supersedes=[...])`.",
            ...(defaultPolicies.length ? [`Default dispatch policies: ${JSON.stringify(defaultPolicies)}`] : []),
          ]
        : []),
      ...(directClientRows.length
        ? [
            "### Connected Third-Party Agents (Direct Explicit Invocation)",
            "Use these `client:<id>` role IDs ONLY when the user explicitly names that third-party client (invokes the client with its native defaults without requiring a dedicated Worker role):",
            "| role | Client | Device | Status |",
            "| --- | --- | --- | --- |",
            ...directClientRows,
          ]
        : []),
    ].join("\n");
  });

  const envSection = section("kulo_envs", async (input, context) => {
    const state = await input.read.snapshot(KuloStateDoc, context);
    const settings = await input.read.snapshot(SettingsAssistantDoc, context);
    if (!isMainOrchestratorConversation(input.conversationId, state, settings)) return undefined;

    const envs = [...options.getEnvs()].sort((a, b) => a.id.localeCompare(b.id));
    const hasAndroid = envs.some((e) => e.executionKind === "native-device");
    const summarizeEnvCapabilities = (e: EnvNodeDescriptor): string => {
      if (e.executionKind === "native-device") {
        if (e.android?.enabled === false) return "android (disabled)";
        return "android";
      }
      const caps = new Set(e.capabilities);
      const tags = [
        caps.has("worker-isolation") && !caps.has("worker-isolation-unavailable")
          ? "worker"
          : "no-sandbox",
      ];
      if (caps.has("agent-browser")) tags.push("browser");
      if (caps.has("agent-desktop")) tags.push("desktop");
      return tags.join(", ");
    };

    const envRows = envs.length
      ? envs.map(
          (e) =>
            `| ${escapeCell(e.id)} | ${escapeCell(e.name)} | ${e.platform}/${e.arch} | ${escapeCell(summarizeEnvCapabilities(e))} | ${e.executionKind === "native-device" ? "Android phone (no computer fs)" : escapeCell(e.rootDir)} |`,
        )
      : ["| (none) | No execution environment connected | - | - | - |"];

    return [
      "## Execution Environments",
      "`[KULO_MESSAGE_SOURCE]` marks each message's sender device. Routing rules: (1) Project work (`project_id`) and named/bound external Agents lock to their configured Env; (2) When the user explicitly names a device (or continues cross-device work established in earlier turns of this conversation), pass that target's `env_id`; (3) Ungrouped tasks touching the sender computer's local files, localhost ports, browser, or desktop set `target_scope='sender_device'` (or `env_id` to the sender device ID—never silently substitute another machine if offline); (4) Location-independent tasks (web research, multi-model proposals, standalone writing/HTML, or uploaded `attachment_ids` analysis—use `execution_domain='computer'` when sent from a phone) set `target_scope='hub_local'` so the Hub runs them on its `local` Env when available. Pass `source_request_id` when multiple devices send messages in one turn; delegate via `kulo_dispatch` if `read` is not bound to the target device.",
      "| env_id | Name | Platform | Capabilities | Root Directory |",
      "| --- | --- | --- | --- | --- |",
      ...envRows,
      ...(hasAndroid
        ? [
            "Phone tasks use `execution_domain=android` (call `android_capabilities` first, then `tool_search`); computer tasks from a phone use `execution_domain=computer`, and mixed tasks explicitly list `android_device_ids`.",
          ]
        : []),
      ...(() => {
        const topicId = state?.conversationToTopic?.[String(input.conversationId)];
        const target = topicId ? state?.topics?.[topicId]?.targetDeviceId : undefined;
        if (!target) return [];
        const device = envs.find((env) => env.id === target);
        return [
          `Active target device constraint: ${target} (${device?.name ?? "unknown"}, ${device?.executionKind === "native-device" ? "Android phone" : "computer"})—never substitute another device.`,
        ];
      })(),
    ].join("\n");
  });

  const projectSection = section("kulo_projects", async (input, context) => {
    const state = await input.read.snapshot(KuloStateDoc, context);
    const settings = await input.read.snapshot(SettingsAssistantDoc, context);
    if (!isMainOrchestratorConversation(input.conversationId, state, settings)) return undefined;
    const doc = await input.read.snapshot(KuloProjectsDoc, context);
    const topicId = state?.conversationToTopic?.[String(input.conversationId)];
    const topic = topicId ? state?.topics?.[topicId] : undefined;
    const project = topic?.projectId ? doc?.projects[topic.projectId] : undefined;
    const rows = Object.values(doc?.projects ?? {})
      .filter((p) => p.deletedAt === undefined)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => `| ${escapeCell(p.id)} | ${escapeCell(p.name)} | ${escapeCell(p.deviceId)} | ${escapeCell(p.workspaceDir)} |`);
    return [
      "## Projects",
      project && project.deletedAt === undefined
        ? `Bound project: ${project.name} (project_id=${project.id}, device=${project.deviceId}, workspace=${project.workspaceDir}); omit redundant env_id/workspace_dir on project dispatches.`
        : topic?.projectId
          ? "Bound project is unavailable; confirm the target project with the user before dispatching project work."
          : rows.length
            ? "Ungrouped conversation. Pass `project_id` when the user names a project (without moving the conversation); ask if ambiguous."
            : "Ungrouped conversation (no projects configured).",
      ...(rows.length
        ? ["| project_id | Project | Device | Workspace |", "| --- | --- | --- | --- |", ...rows]
        : []),
    ].join("\n");
  });

  const recentWorkSection = section("kulo_recent_work", async (input, context) => {
    const state = await input.read.snapshot(KuloStateDoc, context);
    const settingsDoc = await input.read.snapshot(SettingsAssistantDoc, context);
    if (!isMainOrchestratorConversation(input.conversationId, state, settingsDoc)) return undefined;
    const settings = await personality();
    if (!settings.recentWorkEnabled) {
      return RECENT_WORK_DISABLED_TEXT;
    }
    if (options.freezeRecentWorkBaseline && typeof input.shown?.kulo_recent_work === "string") {
      const shownUnwrapped = unwrapSectionTag(input.shown.kulo_recent_work, "kulo_recent_work");
      const pendingBaseline = options.isSystemBaselinePending
        ? await options.isSystemBaselinePending(input.conversationId, context)
        : false;
      if (!pendingBaseline && shownUnwrapped !== RECENT_WORK_DISABLED_TEXT) {
        return shownUnwrapped;
      }
    }
    const projects = await input.read.snapshot(KuloProjectsDoc, context);
    const snapshot = buildRecentWorkSnapshot({
      state,
      projects,
      settings: settingsDoc,
      conversationId: Number(input.conversationId),
      enabled: true,
    });
    return snapshot.enabled ? snapshot.content : undefined;
  });

  // Strict Static-First, Dynamic-Tail ordering for maximum provider prompt cache retention.
  return [
    identitySection,
    corePhilosophySection,
    relationshipSection,
    memoryGuideSection,
    ...(options.getMediaCapabilities ? [mediaSection] : []),
    rolesSection,
    envSection,
    projectSection,
    recentWorkSection,
  ];
}
