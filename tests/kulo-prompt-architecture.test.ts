import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  HISTORICAL_DEFAULT_ROLE_TEXTS,
  defaultRolePresets,
  resolveRolePresetFromPool,
} from "@kulo/protocol";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { KULO_IDENTITY_TEMPLATES, KULO_IDENTITY_TEMPLATES_ZH } from "../packages/hub/src/identity-files.js";
import {
  DEFAULT_COMPACTION_FOCUS_INSTRUCTIONS,
  VOICE_FALLBACK_INSTRUCTIONS,
  buildPhilosophyPrompt,
  buildSettingsAssistantPrompt,
  buildVoiceCallInstructions,
} from "../packages/hub/src/prompts.js";
import { buildRecentWorkSnapshot } from "../packages/hub/src/recent-work.js";
import {
  hydrateSettingsFromConfig,
  rollbackSettingsToSnapshot,
  type KuloDurableSettings,
} from "../packages/hub/src/settings.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    path.basename(String(file)) === ".env" ? false : exists(file),
  );
});

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function extractSections(request: TranscriptContext): Record<string, string> {
  return Object.assign(
    {},
    ...request.messages.flatMap((m) => (m.role === "system" ? [m.sections ?? {}] : [])),
  );
}

function extractSectionOrder(request: TranscriptContext): string[] {
  return request.messages.flatMap((m) =>
    m.role === "system" && m.sections ? Object.keys(m.sections) : [],
  );
}

function systemTextLength(request: TranscriptContext): number {
  return request.messages
    .filter((m) => m.role === "system")
    .reduce((sum, m) => {
      const instructionsLen = typeof m.instructions === "string" ? m.instructions.length : 0;
      const sectionsLen = Object.values(m.sections ?? {}).reduce((acc, text) => acc + text.length, 0);
      return sum + instructionsLen + sectionsLen;
    }, 0);
}

function offeredToolObjects(request: TranscriptContext): unknown[] {
  const byName = new Map<string, unknown>();
  for (const tool of request.tools ?? []) byName.set(tool.name, tool);
  for (const m of request.messages) {
    if (m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded)) {
      for (const tool of m.toolsAdded) byName.set(tool.name, tool);
    }
  }
  return [...byName.values()];
}

function offeredToolNames(request: TranscriptContext): string[] {
  return (offeredToolObjects(request) as Array<{ name: string }>).map((t) => t.name);
}

describe("Prompt architecture, section ordering, budgets, and audience pruning", () => {
  it("enforces static-first section order, 13 resident baseline tools + deferred pool, and character budgets on a blank Hub", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-prompt-arch-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    const requests: TranscriptContext[] = [];
    const provider = fauxProvider({ provider: "prompt-arch", models: [{ id: "test" }] });
    provider.setResponses(
      Array.from({ length: 20 }, () => (req: TranscriptContext) => {
        requests.push(JSON.parse(JSON.stringify(req)) as TranscriptContext);
        return fauxAssistantMessage([fauxText("Hello!")]);
      }),
    );
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "prompt-arch",
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "prompt-arch", defaultModel: "test", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub.close());

    const sub = await hub.sendUserMessage("你好");
    await sub.wait(BACKGROUND_CONTEXT);

    const first = requests.find((r) => Boolean(extractSections(r).kulo_orchestrator))!;
    expect(first).toBeDefined();

    const order = extractSectionOrder(first);
    expect(order).toEqual([
      "kulo_identity",
      "kulo_orchestrator",
      "kulo_relationship",
      "kulo_roles",
      "kulo_skills",
      "kulo_envs",
      "kulo_projects",
      "kulo_recent_work",
    ]);

    const sec = extractSections(first);
    for (const removed of [
      "kulo_memory",
      "kulo_media",
      "kulo_content",
      "kulo_voice",
      "kulo_history",
      "kulo_customization",
      "kulo_connections",
    ]) {
      expect(sec[removed]).toBeUndefined();
    }

    // Ghost tool references must never appear in Orchestrator prompt
    const joinedSystem = Object.values(sec).join("\n");
    expect(joinedSystem).not.toContain("kulo_board");
    expect(joinedSystem).not.toContain("kulo_wait");
    expect(sec.kulo_skills).toContain("genui-cards");

    const tools = offeredToolNames(first);
    expect(tools).toHaveLength(14);
    expect(tools).toEqual(
      expect.arrayContaining([
        "kulo_dispatch",
        "kulo_steer",
        "kulo_stop",
        "kulo_status",
        "web_fetch",
        "web_search",
        "read",
        "write",
        "edit",
        "bash",
        "tool_search",
        "kulo_ui_show",
        "kulo_ui_diagram",
        "kulo_skill_read",
      ]),
    );
    const rootAgent = await hub.rootConversation.agent(BACKGROUND_CONTEXT);
    const callableNames = rootAgent.callable.map((t) => t.name);
    expect(callableNames).not.toContain("kulo_skill_materialize");
    expect(callableNames).not.toContain("kulo_device_invite");
    expect(callableNames).not.toContain("kulo_synthesize_speech");
    expect(callableNames.some((t) => t.startsWith("hindsight_"))).toBe(false);

    // Budget gates (down from 11,800 Chinese system chars [~7.8k tok] and 53 tools / 29,898 mixed-Chinese schema chars [~10k tok] on blank Hub)
    const sysChars = systemTextLength(first);
    const schemaChars = JSON.stringify(offeredToolObjects(first)).length;
    expect(sysChars).toBeGreaterThan(2_000);
    expect(sysChars).toBeLessThan(11_000);
    expect(schemaChars).toBeGreaterThan(3_000);
    expect(schemaChars).toBeLessThan(12_000);
    expect(sysChars + schemaChars).toBeLessThan(23_000);
  });

  it("enforces unified first-person self-reference across main chat, settings, voice, and default identity templates", () => {
    const mainDefault = buildPhilosophyPrompt("Kulo", "zh-CN");
    const mainRenamed = buildPhilosophyPrompt("小墨", "zh-CN");
    const settingsConn = buildSettingsAssistantPrompt({ promptContext: "activeModule=connections", module: "connections" });
    const voice = buildVoiceCallInstructions({
      agentName: "Kulo",
      personaSections: [],
      recalledMemory: "none",
    });

    for (const surface of [mainDefault, mainRenamed, settingsConn, voice, VOICE_FALLBACK_INSTRUCTIONS]) {
      expect(surface).not.toMatch(/assistant in Kulo|voice interface of Kulo|operating in Kulo's/i);
      expect(surface).toMatch(/unified first person|unified first-person/i);
    }
    expect(mainDefault).toContain("You are Kulo, the user's personal assistant");
    expect(mainDefault).toMatch(/never split yourself from Kulo/i);
    expect(mainRenamed).toContain("You are 小墨, the user's personal assistant");
    expect(settingsConn).toContain("kulo_assistant_read");
    expect(KULO_IDENTITY_TEMPLATES_ZH["identity-agreement.md"]).toContain("统一身份表述");
    expect(KULO_IDENTITY_TEMPLATES["identity-agreement.md"]).toContain("Unified self-reference");
  });

  it("prunes cross-audience tools on Workers/Subagents, places kulo_worker_mandate first, and respects legacy instructions", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-prompt-worker-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    const requests: TranscriptContext[] = [];
    let architectSpawned = false;
    const provider = fauxProvider({ provider: "worker-arch", models: [{ id: "test" }] });
    provider.setResponses(
      Array.from({ length: 30 }, () => (req: TranscriptContext) => {
        requests.push(JSON.parse(JSON.stringify(req)) as TranscriptContext);
        const tools = offeredToolNames(req);
        if (tools.includes("kulo_subagent") && !architectSpawned) {
          architectSpawned = true;
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_subagent", {
                tasks: [
                  {
                    name: "auth-scout",
                    role: "临时工",
                    goal: "Inspect auth boundary",
                    scope: "packages/protocol only",
                  },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (tools.includes("kulo_report")) {
          return fauxAssistantMessage(
            [fauxToolCall("kulo_report", { state: "ready", summary: "Completed check." })],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("Subagent reconnaissance complete.")]);
      }),
    );
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "worker-arch",
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "worker-arch", defaultModel: "test", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub.close());

    const ticket = await hub.dispatchTicket({
      commandId: "arch-mandate-check",
      title: "Architecture check",
      goal: "Verify subagent mandate and tool boundaries",
      scope: "packages/protocol and packages/hub",
      acceptance: "All checks verified",
      role: "architect",
    });

    await vi.waitFor(
      async () => {
        const board = await hub.getBoardSnapshot(BACKGROUND_CONTEXT);
        const current = board.tickets.find((t) => t.id === ticket.id);
        expect(current?.status, JSON.stringify(current)).toBe("ready");
      },
      { timeout: 10_000, interval: 25 },
    );

    const workerReq = requests.find((r) => offeredToolNames(r).includes("kulo_report"))!;
    expect(workerReq).toBeDefined();
    expect(extractSectionOrder(workerReq)[0]).toBe("kulo_worker_mandate");
    expect(extractSections(workerReq).kulo_worker_mandate).toContain("All checks verified");
    expect(extractSections(workerReq).kulo_skills).toBeDefined();
    expect(extractSections(workerReq).kulo_skills).not.toContain("genui-cards");
    expect(extractSections(workerReq).instructions).toBeUndefined();

    const workerTools = offeredToolNames(workerReq);
    expect(workerTools).toContain("tool_search");
    const stateBeforeLegacy = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    const initialWorkerConv = (await hub.harness.conversation(
      stateBeforeLegacy.tickets[ticket.id]!.workerConversationId as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    const workerAgent = await initialWorkerConv.agent(BACKGROUND_CONTEXT);
    const workerDeferred = workerAgent.deferred.map((t) => t.name);
    const workerCallable = workerAgent.callable.map((t) => t.name);
    expect(workerDeferred).toContain("kulo_skill_materialize");
    expect(workerDeferred).toContain("kulo_publish_asset");
    for (const forbidden of ["kulo_ui_show", "kulo_ui_update", "kulo_ui_diagram", "kulo_inspect_asset", "kulo_synthesize_speech"]) {
      expect(workerTools).not.toContain(forbidden);
      expect(workerCallable).not.toContain(forbidden);
    }

    const subReq = requests.find(
      (r) => !offeredToolNames(r).includes("kulo_report") && Boolean(extractSections(r).kulo_worker_mandate),
    )!;
    expect(subReq).toBeDefined();
    const subMandate = extractSections(subReq).kulo_worker_mandate!;
    expect(subMandate).toContain("Subagent Mandate");
    expect(subMandate).toContain("Scout");
    expect(subMandate).toContain("Sub-task Narrowed Scope: packages/protocol only");
    expect(subMandate).not.toContain("kulo_subagent");
    expect(subMandate).not.toContain("kulo_report");

    const subTools = offeredToolNames(subReq);
    for (const forbidden of [
      "kulo_report",
      "kulo_subagent",
      "kulo_wait",
      "kulo_ui_show",
      "kulo_ui_update",
      "kulo_ui_diagram",
      "kulo_inspect_asset",
    ]) {
      expect(subTools).not.toContain(forbidden);
    }

    // Pre-upgrade legacy fallback: if `agent.instructions` was already populated, `kulo_worker_mandate` yields cleanly.
    const state = (await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT))!;
    const workerConv = (await hub.harness.conversation(
      state.tickets[ticket.id]!.workerConversationId as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    await workerConv.configure({ instructions: "LEGACY_PRE_UPGRADE_MANDATE" }, BACKGROUND_CONTEXT);
    const resolved = await workerConv.agent(BACKGROUND_CONTEXT);
    const rendered = await resolved.sections
      .find((s) => s.key === "kulo_worker_mandate")!
      .render(
        { conversationId: workerConv.id, agent: resolved, env: undefined, shown: {}, read: hub.harness },
        BACKGROUND_CONTEXT,
      );
    expect(rendered).toBeUndefined();
  });

  it("dynamically toggles TTS and Hindsight tools across live reconfiguration and appends native compaction focus", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-prompt-live-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    const requests: TranscriptContext[] = [];
    const provider = fauxProvider({ provider: "live-toggle", models: [{ id: "test", contextWindow: 8_000 }] });
    provider.setResponses(
      Array.from({ length: 20 }, () => (req: TranscriptContext) => {
        requests.push(JSON.parse(JSON.stringify(req)) as TranscriptContext);
        const sys = req.messages[0];
        if (
          sys?.role === "system" &&
          typeof sys.content === "string" &&
          sys.content.startsWith("You are a context summarization assistant.")
        ) {
          return fauxAssistantMessage([
            fauxText(
              "## Goal\nTest\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] Setup\n\n## Key Decisions\n- None\n\n## Next Steps\n1. Continue\n\n## Critical Context\n- (none)",
            ),
          ]);
        }
        return fauxAssistantMessage([fauxText("Ack " + "detail ".repeat(400))]);
      }),
    );
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "live-toggle",
      config: {
        stateDir,
        identityDir: path.join(stateDir, "identity"),
        enableLocalEnv: false,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: { defaultProvider: "live-toggle", defaultModel: "test", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub.close());

    await (await hub.sendUserMessage("Initial check")).wait(BACKGROUND_CONTEXT);
    expect(offeredToolNames(requests.at(-1)!)).not.toContain("kulo_synthesize_speech");
    expect((await hub.rootConversation.agent(BACKGROUND_CONTEXT)).callable.map((t) => t.name)).not.toContain(
      "kulo_synthesize_speech",
    );

    // Enable TTS at runtime -> rootConversation immediately exposes kulo_synthesize_speech in deferred pool
    const voiceSnap = await hub.voice.snapshot();
    await hub.voice.configure({
      expectedRevision: voiceSnap.revision,
      tts: {
        enabled: true,
        provider: "minimax-cn",
        modelId: "speech-2.8-turbo",
        voice: "male-qn-qingse",
        speed: voiceSnap.tts.speed,
        apiKey: "sk-tts-live-key-1234567890",
      },
    });
    await (await hub.sendUserMessage("Second check after TTS enabled")).wait(BACKGROUND_CONTEXT);
    expect((await hub.rootConversation.agent(BACKGROUND_CONTEXT)).deferred.map((t) => t.name)).toContain(
      "kulo_synthesize_speech",
    );

    // Trigger native compaction without explicit instructions -> verifies DEFAULT_COMPACTION_FOCUS_INSTRUCTIONS is appended
    for (let i = 0; i < 10; i++) {
      await (await hub.sendUserMessage(`Conversation turn ${i}: ${"context ".repeat(600)}`)).wait(
        BACKGROUND_CONTEXT,
      );
    }
    const taskId = await hub.rootConversation.compact(undefined, BACKGROUND_CONTEXT);
    const compacted = await hub.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    expect(compacted.state.outcome.status).toBe("completed");
    const compactionReq = requests.find(
      (r) =>
        r.messages[0]?.role === "system" &&
        typeof r.messages[0].content === "string" &&
        r.messages[0].content.startsWith("You are a context summarization assistant."),
    );
    expect(compactionReq).toBeDefined();
    expect(JSON.stringify(compactionReq!.messages[1])).toContain(DEFAULT_COMPACTION_FOCUS_INSTRUCTIONS);
  });
});

describe("Recent-work scope isolation and V4 role migration invariants", () => {
  it("isolates ordinary non-project topics while keeping global overview on root/settings and warning on deleted projects", () => {
    const state = {
      conversationToTicket: {},
      conversationToSubagent: {},
      conversationToTopic: {
        "1": "root",
        "10": "topic-ordinary-a",
        "11": "topic-ordinary-b",
        "20": "topic-proj-1",
        "30": "topic-deleted-proj",
      },
      topics: {
        root: { id: "root", conversationId: 1, title: "Kulo", master: true, createdAt: 1, updatedAt: 1 },
        "topic-ordinary-a": { id: "topic-ordinary-a", conversationId: 10, title: "Topic A", createdAt: 1, updatedAt: 1 },
        "topic-ordinary-b": { id: "topic-ordinary-b", conversationId: 11, title: "Topic B", createdAt: 1, updatedAt: 1 },
        "topic-proj-1": { id: "topic-proj-1", conversationId: 20, title: "Proj Topic", projectId: "p1", createdAt: 1, updatedAt: 1 },
        "topic-deleted-proj": { id: "topic-deleted-proj", conversationId: 30, title: "Orphan Topic", projectId: "p-deleted", createdAt: 1, updatedAt: 1 },
      },
      tickets: {
        "T-A": {
          id: "T-A", commandId: "c1", title: "Topic A Ticket", goal: "Goal A", scope: "s",
          status: "running" as const, role: "coder", envId: "local", workspaceDir: "/a",
          workerConversationId: 100, originTopicId: "topic-ordinary-a", originConversationId: 10,
          runEpoch: 1, createdAt: 1, updatedAt: 1,
        },
        "T-P1": {
          id: "T-P1", commandId: "c2", title: "Project P1 Ticket", goal: "Goal P1", scope: "s",
          status: "running" as const, role: "coder", envId: "local", workspaceDir: "/p1",
          projectId: "p1", workerConversationId: 101, originTopicId: "topic-proj-1", originConversationId: 20,
          runEpoch: 1, createdAt: 2, updatedAt: 2,
        },
      },
      slots: { holders: [], max: 3 },
    };
    const projects = {
      projects: {
        p1: { id: "p1", name: "Alpha", deviceId: "local", workspaceDir: "/p1", directoryId: "d1", grantRevision: 1, revision: 1, createdAt: 1, updatedAt: 1 },
        "p-deleted": { id: "p-deleted", name: "Removed", deviceId: "local", workspaceDir: "/del", directoryId: "d2", grantRevision: 1, revision: 2, createdAt: 1, updatedAt: 2, deletedAt: 99 },
      },
      cancellations: {},
    };
    const settings = {
      conversationId: 50,
      conversations: { "50": { view: { topicId: "settings-50", title: "Settings", createdAt: 1, updatedAt: 1 }, actions: [], turnContext: null, observedRevisions: {} } },
      actions: [],
      turnContext: null,
      observedRevisions: {},
    };

    // 1. Root & Settings see cross-project overview
    const rootSnap = buildRecentWorkSnapshot({ state: state as never, projects: projects as never, settings: settings as never, conversationId: 1 });
    expect(rootSnap.content).toContain("T-A");
    expect(rootSnap.content).toContain("T-P1");
    expect(rootSnap.content).not.toContain("kulo_board");

    const settingsSnap = buildRecentWorkSnapshot({ state: state as never, projects: projects as never, settings: settings as never, conversationId: 50 });
    expect(settingsSnap.content).toContain("T-A");
    expect(settingsSnap.content).toContain("T-P1");

    // 2. Ordinary topic A sees ONLY its own ticket (not Project P1); ordinary topic B sees none
    const ordinaryASnap = buildRecentWorkSnapshot({ state: state as never, projects: projects as never, settings: settings as never, conversationId: 10 });
    expect(ordinaryASnap.content).toContain("T-A");
    expect(ordinaryASnap.content).not.toContain("T-P1");

    const ordinaryBSnap = buildRecentWorkSnapshot({ state: state as never, projects: projects as never, settings: settings as never, conversationId: 11 });
    expect(ordinaryBSnap.content).not.toContain("T-A");
    expect(ordinaryBSnap.content).not.toContain("T-P1");
    expect(ordinaryBSnap.content).toContain("No active or recent tickets in scope.");

    // 3. Project topic sees only P1
    const projSnap = buildRecentWorkSnapshot({ state: state as never, projects: projects as never, settings: settings as never, conversationId: 20 });
    expect(projSnap.content).toContain("T-P1");
    expect(projSnap.content).not.toContain("T-A");

    // 4. Deleted project topic warns and does NOT leak other tickets
    const orphanSnap = buildRecentWorkSnapshot({ state: state as never, projects: projects as never, settings: settings as never, conversationId: 30 });
    expect(orphanSnap.content).toContain("project linked to this conversation is unavailable");
    expect(orphanSnap.content).not.toContain("T-A");
    expect(orphanSnap.content).not.toContain("T-P1");
  });

  it("migrates unmodified V1-V3 role texts to V4 (including snapshots) while preserving custom edits, permissions, and 临时工 routing", () => {
    const config = resolveHubConfig({});
    const fresh = defaultRolePresets();
    expect(fresh.writer!.readOnly).toBe(false);
    expect(resolveRolePresetFromPool(fresh, "临时工").roleId).toBe("scout");
    expect(resolveRolePresetFromPool(fresh, "检验员").roleId).toBe("checker");

    const legacyScout = {
      id: "scout",
      label: HISTORICAL_DEFAULT_ROLE_TEXTS.scout!.labels[0]!,
      whenToUse: HISTORICAL_DEFAULT_ROLE_TEXTS.scout!.whenToUse[0]!,
      prompt: HISTORICAL_DEFAULT_ROLE_TEXTS.scout!.prompts[0]!,
      enabled: false,
      readOnly: false, // user explicitly flipped readOnly to false!
      allowSubagents: true, // user explicitly flipped allowSubagents to true!
      provider: "openai",
      modelId: "gpt-custom",
      thinkingLevel: "high" as const,
    };
    const customCoder = {
      ...fresh.coder!,
      label: "我的专属开发",
      whenToUse: HISTORICAL_DEFAULT_ROLE_TEXTS.coder!.whenToUse[0]!,
      prompt: "始终使用 TDD 并写中文注释。",
      readOnly: true,
    };

    const persisted: KuloDurableSettings = {
      initialized: true,
      rolesMigratedV2: true,
      rolesMigratedV3: true,
      globalRevision: 2,
      revisions: { presentation: 1, executor: 1, roles: 2, model: 1, identity: 1, memory: 1 },
      presentation: { agentName: "Kulo", workbenchName: "Kulo's table" },
      executor: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 },
      roles: {
        ...fresh,
        scout: legacyScout,
        coder: customCoder,
      },
      model: config.model,
      identity: { directory: "", directoryRevision: 1 },
      memory: config.memory,
      expression: null,
      snapshots: [
        {
          revision: 2,
          block: "roles",
          summary: "prior snapshot",
          savedAt: 1,
          previousState: {
            presentation: { agentName: "Kulo", workbenchName: "Kulo's table" },
            executor: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 },
            roles: { ...fresh, scout: { ...legacyScout }, coder: { ...customCoder } },
            model: config.model,
            identityDirectory: "",
            memory: config.memory,
          },
        },
      ],
    };

    hydrateSettingsFromConfig(persisted, config);
    expect(persisted.rolesMigratedV4).toBe(true);

    // Unmodified V3 factory text fields on scout upgraded to V4 English, while ALL permissions/bindings stayed untouched!
    expect(persisted.roles.scout!.label).toBe(fresh.scout!.label);
    expect(persisted.roles.scout!.whenToUse).toBe(fresh.scout!.whenToUse);
    expect(persisted.roles.scout!.prompt).toBe(fresh.scout!.prompt);
    expect(persisted.roles.scout!.enabled).toBe(false);
    expect(persisted.roles.scout!.readOnly).toBe(false);
    expect(persisted.roles.scout!.allowSubagents).toBe(true);
    expect(persisted.roles.scout!.provider).toBe("openai");
    expect(persisted.roles.scout!.modelId).toBe("gpt-custom");
    expect(persisted.roles.scout!.thinkingLevel).toBe("high");

    // User-customized coder label and prompt stayed untouched while historical whenToUse upgraded!
    expect(persisted.roles.coder!.label).toBe("我的专属开发");
    expect(persisted.roles.coder!.prompt).toBe("始终使用 TDD 并写中文注释。");
    expect(persisted.roles.coder!.whenToUse).toBe(fresh.coder!.whenToUse);
    expect(persisted.roles.coder!.readOnly).toBe(true);

    // Rolling back snapshot preserves V4 upgraded texts AND user customizations/permissions!
    rollbackSettingsToSnapshot(persisted, 2, 2, config.memory);
    expect(persisted.roles.scout!.prompt).toBe(fresh.scout!.prompt);
    expect(persisted.roles.scout!.readOnly).toBe(false);
    expect(persisted.roles.coder!.prompt).toBe("始终使用 TDD 并写中文注释。");
  });
});
