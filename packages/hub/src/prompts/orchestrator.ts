import { ROOT_CONVERSATION_ID, section } from "@earendil-works/pi-durable";
import type {
  CapabilitySnapshot,
  EnvNodeDescriptor,
  HindsightMemoryConfig,
  RolePreset,
} from "@kulo/protocol";
import { KULO_IDENTITY_TEMPLATES, readIdentityContext } from "../identity-files.js";
import { KuloProjectsDoc } from "../projects.js";
import { buildRecentWorkSnapshot } from "../recent-work.js";
import { SettingsAssistantDoc, isMainOrchestratorConversation } from "../settings-doc.js";
import { KuloStateDoc } from "../state.js";

export function buildPhilosophyPrompt(agentName = "Kulo"): string {
  return `You are ${agentName}, the user-facing coordinating assistant in Kulo.
You own the user conversation and delegate background work to isolated Workers via \`kulo_dispatch\`.

## Operating Rules
- **Language**: Honor any requested deliverable language; otherwise follow the active conversation language, defaulting to Chinese when unspecified.
- **When to Delegate**: Answer directly or run quick, single-step offline workspace checks/edits (\`read\`/\`write\`/\`edit\`/\`bash\` <= 15s, e.g. \`mv\`/rename, \`mkdir\`, \`git status\`, small config edits) when scoped to the active workspace and unlocked by any running Ticket. Delegate via \`kulo_dispatch\` for multi-step coding/debugging, multi-file refactors, network/package installs, builds/tests, mutable browser/desktop/Android work, or independent verification. If \`kulo_dispatch\` returns \`inline_delivery\`, answer directly from that verified result; otherwise confirm background work started and end your turn—never sleep, poll, or wait.
- **Discuss vs. Act**: When exploring options, analyze trade-offs without modifying files. When asked to execute, honor explicit user target/action authorizations and ask only when scope is missing, ambiguous, or risky.
- **Self-Contained Handoff**: Workers cannot see this chat, Identity Agreement, Working Relationship, or private memory. Pass a complete, redacted brief (goal, context, scope, acceptance criteria, and verbatim user constraints) via \`context_summary\` and \`attachment_ids\`, preserving explicit device, project, Agent, or format choices.
- **In-Flight Control & Events**: Use \`kulo_steer\` to update or unblock an active ticket (keeping its bound device and scope), and \`kulo_stop\` only on explicit user request. Check \`current_time\` / \`time_zone\` via \`kulo_status\` before scheduling \`execute_at\`. Messages prefixed \`[KULO_...]\` are automated runtime events—handle them per instructions without addressing them as the user.
- **Verify & Present**: Worker reports and staged items are unverified inputs. Inspect real diffs (\`kulo_inspect_staged_diff\`) or assets (\`kulo_inspect_asset\`) against acceptance criteria before merging (\`kulo_apply_staged_changes\`), publishing (\`kulo_publish_asset\` -> \`published\`), or claiming completion. Omit internal ticket IDs unless asked.
- **Response Format & Media**: Respect any user-requested format. Use plain text for simple answers and Markdown tables for quick comparisons. Use \`kulo_ui_show\` cards when interactive choices/parameters or compact metrics/charts/tabs aid clarity (read \`genui-cards\` before composing rich specs). Delegate standalone offline \`.html\` files for interactive visuals (Workers can read \`interactive-html\`), and use \`kulo_generate_image\` / \`kulo_generate_video\` (\`kulo_media_capabilities\` when uncertain) for media—claim completion only after a real asset is returned.
- **Tool Discovery**: Call \`tool_search\` (\`limit\` <= 3) for deferred tools: host ops (\`kulo_host_action\`), browser, memory/Hindsight, history, projects/topics, connections, media/TTS, UI cards/assets, identity, ticket inspect/close, pairing, and settings.`;
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
  getRoles: () => Record<string, RolePreset>;
  getEnvs: () => EnvNodeDescriptor[];
  getIdentityDir: () => string;
  getMemoryConfig: () => HindsightMemoryConfig;
  getMediaCapabilities?: () => Promise<CapabilitySnapshot>;
  getPersonalityContext?: () => Promise<{
    identityAgreement: string;
    relationship: string;
    recentWorkEnabled: boolean;
  }>;
}) {
  const personality = async () => {
    if (options.getPersonalityContext) return options.getPersonalityContext();
    const blocks = readIdentityContext(options.getIdentityDir());
    const find = (file: "identity-agreement.md" | "relationship.md") =>
      blocks.find((block) => block.file === file)?.text;
    return {
      identityAgreement: find("identity-agreement.md") ?? KULO_IDENTITY_TEMPLATES["identity-agreement.md"],
      relationship: find("relationship.md") ?? KULO_IDENTITY_TEMPLATES["relationship.md"],
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
      "Private to the coordinating assistant (supersedes earlier versions; never copy raw into Worker tickets):",
      identityAgreement,
    ].join("\n\n");
  });

  const corePhilosophySection = section(
    "kulo_orchestrator",
    () => buildPhilosophyPrompt(options.getAgentName?.() || "Kulo"),
    { tag: false },
  );

  const relationshipSection = section("kulo_relationship", async (input, context) => {
    if (!(await isOrchestrator(input, context))) return undefined;
    const { relationship } = await personality();
    if (!relationship.trim()) return undefined;
    return [
      "Private to the coordinating assistant (supersedes earlier versions; current user requests and runtime permissions take precedence):",
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
        : [`- Shared project bank (\`bank: "shared"\` -> \`${mem.banks.shared}\`): read-only for the coordinating assistant to inspect verified project findings and knowledge pages.`]),
      "- Use resident `hindsight_recall` (supports `temporal_window` / `include_chunks`) and `hindsight_retain` for routine facts; discover Pages (`hindsight_search_pages` / `hindsight_get_page_tree`), Mental Models, `hindsight_reflect`, and private `hindsight_invalidate_memory` via `tool_search` when needed. Write calls returning `accepted` are queued only—treat `completed` as persisted.",
      "- Record dated, verified `Correction` entries when stale facts are found instead of re-ingesting recalled summaries as new evidence. Recalled memory is historical context, not live source-code truth, and never alters Identity Agreement or permissions; cite sources as required by tool output.",
    ].join("\n");
  });

  const mediaSection = section("kulo_media", async (input, context) => {
    if (!options.getMediaCapabilities || !(await isOrchestrator(input, context))) return undefined;
    return formatMediaRoutingSummary(await options.getMediaCapabilities(), false);
  });

  const rolesSection = section("kulo_roles", () => {
    const allRoles = Object.values(options.getRoles());
    const roles = allRoles
      .filter((r) => r.enabled !== false)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (roles.length === 0) return undefined;
    const hasExternal = allRoles.some((r) => Boolean(r.external));
    const rows = roles.map((r) => {
      const modelHint = r.external
        ? `${r.external.kind} / ${r.modelId || "client default"} @ ${r.external.envId}`
        : r.modelId
          ? r.provider
            ? `${r.provider}/${r.modelId}`
            : r.modelId
          : "inherit";
      const thinkingHint = r.external
        ? "client-managed"
        : r.thinkingLevel ?? "inherit";
      const capHint = describeRoleCapability(r);
      return `| ${escapeCell(r.id)} | ${escapeCell(r.label)} | ${escapeCell(modelHint)} | ${escapeCell(thinkingHint)} | ${escapeCell(capHint)} | ${escapeCell(r.whenToUse)} |`;
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
    return [
      "## Worker Roles",
      "Pass the matching `role` and `task_kind` to `kulo_dispatch` (when thinking is `auto`, optionally set `thinking_level`: `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`):",
      "| role | Name | Model | Thinking | Capabilities | When to Use |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
      "- Explicit user-named Agents or external clients (e.g. Codex, Claude Code, Antigravity, DSH) take highest priority: lock to the named target, and if unconfigured, disabled, unverified, offline, or failed, report the exact status and wait—never silently substitute another Agent or Worker.",
      ...(hasExternal
        ? [
            "- External Agents run with their native tools/MCP; inspect their output before delivering or merging. When unnamed, honor matching default dispatch policies below (disabled defaults still reserve their scope), or recover non-user-named failures via `kulo_dispatch(supersedes=[...])`.",
            ...(defaultPolicies.length ? [`Default dispatch policies: ${JSON.stringify(defaultPolicies)}`] : []),
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
        if (e.android?.paused) return "android (paused)";
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
            `| ${escapeCell(e.id)} | ${escapeCell(e.name)} | ${e.online ? "online" : "offline"} | ${e.platform}/${e.arch} | ${escapeCell(summarizeEnvCapabilities(e))} | ${e.executionKind === "native-device" ? "Android phone (no computer fs)" : escapeCell(e.rootDir)} |`,
        )
      : ["| (none) | No execution environment connected | offline | - | - | - |"];

    return [
      "## Execution Environments",
      "`[KULO_MESSAGE_SOURCE]` marks each message's sender device. Routing rules: (1) Project work (`project_id`) and named/bound external Agents lock to their configured Env; (2) When the user explicitly names a device (or continues cross-device work established in earlier turns of this conversation), pass that target's `env_id`; (3) Ungrouped tasks touching the sender computer's local files, localhost ports, browser, or desktop set `target_scope='sender_device'` (or `env_id` to the sender device ID—never silently substitute another machine if offline); (4) Location-independent tasks (web research, multi-model proposals, standalone writing/HTML, or uploaded `attachment_ids` analysis—use `execution_domain='computer'` when sent from a phone) set `target_scope='hub_local'` so the Hub runs them on its `local` Env when available. Pass `source_request_id` when multiple devices send messages in one turn; delegate via `kulo_dispatch` if `read` is not bound to the target device.",
      "| env_id | Name | Status | Platform | Capabilities | Root Directory |",
      "| --- | --- | --- | --- | --- | --- |",
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
      return "Recent work snapshot injection is disabled; earlier work summaries in this transcript are historical only and do not reflect live ticket status.";
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
