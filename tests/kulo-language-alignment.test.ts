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
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  areInternalRolesAtDefaults,
  defaultRolePresets,
  localizeDefaultRolePreset,
  type IdentityRead,
  type RolePreset,
} from "@kulo/protocol";
import {
  KULO_IDENTITY_TEMPLATES,
  KULO_IDENTITY_TEMPLATES_ZH,
  startKuloHubServer,
} from "@kulo/hub";
import { buildPhilosophyPrompt } from "../packages/hub/src/prompts/orchestrator.js";
import { composeSubagentInstructions, composeWorkerInstructions } from "../packages/hub/src/prompts/worker.js";
import { applySettingsBlockUpdate, hydrateSettingsFromConfig } from "../packages/hub/src/settings.js";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN, fetchWithHubAuth } from "./helpers/hub-auth.js";

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

describe("Bilingual prompts, roles, identity templates, and Hub language preference", () => {
  it("instructs orchestrator, worker, and subagent prompts to match conversation language for thinking/reasoning", () => {
    const zhOrch = buildPhilosophyPrompt("Kulo", "zh-CN");
    const enOrch = buildPhilosophyPrompt("Kulo", "en");
    expect(zhOrch).toContain("internal thinking/reasoning");
    expect(zhOrch).toContain("defaulting to Chinese");
    expect(enOrch).toContain("internal thinking/reasoning");
    expect(enOrch).toContain("defaulting to English");

    const roles = defaultRolePresets("en");
    const ticket = {
      id: "T-1",
      title: "Check module",
      goal: "Inspect implementation",
      scope: "packages/hub",
      envId: "local",
      workspaceDir: "/tmp/workspace",
      scratchDir: "/tmp/scratch",
    };
    const workerZh = composeWorkerInstructions(ticket, roles.scout, { roles, language: "zh-CN" });
    const workerEn = composeWorkerInstructions(ticket, roles.scout, { roles, language: "en" });
    expect(workerZh).toContain("internal thinking/reasoning");
    expect(workerZh).toContain("defaulting to Chinese");
    expect(workerZh).toContain("侦察员");
    expect(workerZh).toContain("专注于快速、高信噪比的代码侦察与事实核查");
    expect(workerEn).toContain("defaulting to English");
    expect(workerEn).toContain("Scout");
    expect(workerEn).toContain("Focus on fast, high-signal reconnaissance");

    const customScout: RolePreset = {
      ...roles.scout!,
      label: "My Custom Scout",
      prompt: "Always inspect SQL schemas first.",
    };
    const workerCustomZh = composeWorkerInstructions(ticket, customScout, { roles, language: "zh-CN" });
    expect(workerCustomZh).toContain("My Custom Scout");
    expect(workerCustomZh).toContain("Always inspect SQL schemas first.");

    const subZh = composeSubagentInstructions({
      parentTicket: ticket,
      subagentId: "s-1",
      subagentName: "scout-1",
      rolePreset: roles.scout,
      roleId: "scout",
      effectiveReadOnly: true,
      language: "zh-CN",
    });
    expect(subZh).toContain("internal thinking/reasoning");
    expect(subZh).toContain("侦察员");
  });

  it("supports bilingual built-in role presets while preserving user customizations and default detection", () => {
    const enDefaults = defaultRolePresets("en");
    const zhDefaults = defaultRolePresets("zh-CN");
    expect(Object.keys(zhDefaults)).toEqual(Object.keys(enDefaults));
    expect(areInternalRolesAtDefaults(enDefaults)).toBe(true);
    expect(areInternalRolesAtDefaults(zhDefaults)).toBe(true);

    const mixedUnmodified = {
      ...enDefaults,
      scout: zhDefaults.scout!,
      coder: { ...enDefaults.coder!, label: zhDefaults.coder!.label },
    };
    expect(areInternalRolesAtDefaults(mixedUnmodified)).toBe(true);

    const customRole = { ...enDefaults.coder!, prompt: "Custom TDD instructions." };
    expect(areInternalRolesAtDefaults({ ...enDefaults, coder: customRole })).toBe(false);

    const localized = localizeDefaultRolePreset(customRole, "zh-CN");
    expect(localized.label).toBe("开发者");
    expect(localized.whenToUse).toBe(zhDefaults.coder!.whenToUse);
    expect(localized.prompt).toBe("Custom TDD instructions.");
  });

  it("persists presentation.language, preserves it across agentName edits, and rejects invalid values", () => {
    const config = resolveHubConfig({});
    const doc = {
      initialized: false,
      globalRevision: 1,
      revisions: { presentation: 1, executor: 1, roles: 1, model: 1, identity: 1, memory: 1 },
      presentation: { agentName: "Kulo", workbenchName: "Kulo's table" },
      executor: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 },
      roles: {},
      model: config.model,
      identity: { directory: "", directoryRevision: 1 },
      memory: config.memory,
      expression: null,
      snapshots: [],
    };
    hydrateSettingsFromConfig(doc, config);

    applySettingsBlockUpdate(doc, "presentation", 1, {
      agentName: "Kulo",
      workbenchName: "Kulo's table",
      language: "zh-CN",
    });
    expect(doc.presentation.language).toBe("zh-CN");

    // Updating agentName without sending language must preserve the stored language.
    applySettingsBlockUpdate(doc, "presentation", 2, {
      agentName: "Kulo Pro",
      workbenchName: "Kulo's table",
    });
    expect(doc.presentation).toEqual({
      agentName: "Kulo Pro",
      workbenchName: "Kulo's table",
      language: "zh-CN",
    });

    expect(() =>
      applySettingsBlockUpdate(doc, "presentation", 3, {
        agentName: "Kulo Pro",
        workbenchName: "Kulo's table",
        language: "fr",
      }),
    ).toThrow();
  });

  it("serves localized default identity/relationship templates over HTTP and adapts live Hub prompts while keeping saved user docs intact", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-lang-hub-"));
    cleanups.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));

    const requests: TranscriptContext[] = [];
    const provider = fauxProvider({ provider: "lang-test", models: [{ id: "test" }] });
    provider.setResponses(
      Array.from({ length: 10 }, () => (req: TranscriptContext) => {
        requests.push(JSON.parse(JSON.stringify(req)) as TranscriptContext);
        return fauxAssistantMessage([fauxText("OK")]);
      }),
    );
    const models = createModels();
    models.setProvider(provider.provider);

    const hub = await openTestHub({
      models,
      providerId: "lang-test",
      config: {
        stateDir,
        authToken: HUB_TEST_ADMIN_TOKEN,
        identityDir: path.join(stateDir, "identity"),
        enableLocalEnv: false,
        watchdogMinutes: 0,
        memory: { enabled: false },
        presentation: { agentName: "Kulo", workbenchName: "Kulo's table", language: "zh-CN" },
        model: { defaultProvider: "lang-test", defaultModel: "test", thinkingLevel: "off" },
      },
    });
    cleanups.push(() => hub.close());
    const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
    cleanups.push(() => server.close());

    const getJson = async <T>(route: string) => {
      const res = await fetchWithHubAuth(`${server.url}${route}`);
      return { status: res.status, data: (await res.json()) as T };
    };

    // Default unsaved identity & relationship templates follow `?lang=`
    const zhIdentity = await getJson<IdentityRead>("/api/personality/identity?lang=zh-CN");
    const enIdentity = await getJson<IdentityRead>("/api/personality/identity?lang=en");
    expect(zhIdentity.status).toBe(200);
    expect(zhIdentity.data.exists).toBe(false);
    expect(zhIdentity.data.content).toBe(KULO_IDENTITY_TEMPLATES_ZH["identity-agreement.md"]);
    expect(enIdentity.data.content).toBe(KULO_IDENTITY_TEMPLATES["identity-agreement.md"]);

    const zhRel = await getJson<IdentityRead>("/api/identity/file?file=relationship.md&lang=zh-CN");
    const enRel = await getJson<IdentityRead>("/api/identity/file?file=relationship.md&lang=en");
    expect(zhRel.data.content).toBe(KULO_IDENTITY_TEMPLATES_ZH["relationship.md"]);
    expect(enRel.data.content).toBe(KULO_IDENTITY_TEMPLATES["relationship.md"]);

    const zhPreset = await getJson<{ content: string }>("/api/personality/identity/preset?lang=zh-CN");
    const enPreset = await getJson<{ content: string }>("/api/personality/identity/preset?lang=en");
    expect(zhPreset.data.content).toBe(KULO_IDENTITY_TEMPLATES_ZH["identity-agreement.md"]);
    expect(enPreset.data.content).toBe(KULO_IDENTITY_TEMPLATES["identity-agreement.md"]);

    // Live Hub prompts reflect presentation.language = "zh-CN"
    await (await hub.sendUserMessage("你好")).wait(BACKGROUND_CONTEXT);
    const firstSections = extractSections(requests.at(-1)!);
    expect(firstSections.kulo_identity).toContain("# 身份约定");
    expect(firstSections.kulo_orchestrator).toContain("internal thinking/reasoning");
    expect(firstSections.kulo_orchestrator).toContain("defaulting to Chinese");
    expect(firstSections.kulo_roles).toContain("侦察员");

    // Switching presentation.language to "en" updates subsequent system sections cleanly
    const currentSettings = hub.getSettingsView();
    await hub.updateSettingsBlock("presentation", currentSettings.blocks.presentation.revision, {
      ...currentSettings.blocks.presentation.value,
      language: "en",
    });
    await (await hub.sendUserMessage("Hello")).wait(BACKGROUND_CONTEXT);
    const secondSections = extractSections(requests.at(-1)!);
    expect(secondSections.kulo_identity).toContain("# Identity Agreement");
    expect(secondSections.kulo_orchestrator).toContain("defaulting to English");
    expect(secondSections.kulo_roles).toContain("Scout");

    // Once user saves custom identity-agreement.md, neither language overrides it
    const customDoc = "# Custom Identity\nKeep my own exact wording.\n";
    await hub.identityFiles.save({
      file: "identity-agreement.md",
      expected: zhIdentity.data.version,
      content: customDoc,
      summary: "Save custom identity",
      dualSignConfirmed: true,
    });
    expect((await getJson<IdentityRead>("/api/personality/identity?lang=zh-CN")).data.content).toBe(customDoc);
    expect((await getJson<IdentityRead>("/api/personality/identity?lang=en")).data.content).toBe(customDoc);
  });
});
