import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRolePresets,
  type ExtensionRecord,
  type ExtensionWorkspaceSnapshot,
  type KuloSettingsView,
  type SkillRecord,
} from "@kulo/protocol";
import { KuloApiError } from "../../kulo-api";
import { setLanguage } from "../../kulo-i18n";
import {
  ADD_IMAGE_PROMPT,
  ADD_IMAGE_PROMPT_EN,
  IMAGE_ROUTING_PROMPT,
  IMAGE_ROUTING_PROMPT_EN,
  getAddImagePrompt,
  getImageRoutingPrompt,
  isAddImagePrompt,
  isImageRoutingPrompt,
} from "./capability-views";
import { syncPresentationLanguage } from "./language-sync";
import {
  OtherExtensionsModule,
  extensionDisplayName,
  extensionJobStageLabel,
} from "./other-extensions-module";
import { SkillsModule, localizedSkillDescription } from "./skills-module";
import { roleMutationValue } from "./worker-role-settings";
import { WorkersModule } from "./workers-module";

afterEach(() => {
  setLanguage("zh-CN");
  vi.restoreAllMocks();
});

function makeSettings(overrides?: {
  language?: "zh-CN" | "en";
  roles?: KuloSettingsView["blocks"]["roles"]["value"];
}): KuloSettingsView {
  return {
    globalRevision: 1,
    blocks: {
      presentation: {
        revision: 1,
        value: {
          agentName: "Kulo",
          workbenchName: "Kulo's table",
          ...(overrides?.language ? { language: overrides.language } : {}),
        },
      },
      executor: {
        revision: 1,
        value: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 },
      },
      roles: { revision: 1, value: overrides?.roles ?? defaultRolePresets("en") },
      model: {
        revision: 1,
        hasApiKey: false,
        value: {
          baseUrl: "https://api.openai.com/v1",
          apiMode: "openai-completions",
          defaultModel: "gpt-test",
          thinkingLevel: "off",
          customProviders: [],
        },
      },
      identity: {
        revision: 1,
        directoryRevision: 1,
        effectiveDirectory: "/tmp/identity",
        value: { directory: "" },
      },
      memory: {
        revision: 1,
        hasRouterApiKey: false,
        hasWorkerApiKey: false,
        value: {
          enabled: false,
          endpoint: "http://127.0.0.1:8888",
          endpoints: [],
          caCertPem: "",
          routerApiKeyEnv: "KULO_HINDSIGHT_ROUTER_API_KEY",
          workerApiKeyEnv: "KULO_HINDSIGHT_WORKER_API_KEY",
          authFile: "",
          autoAttachTopLevelRouters: true,
          banks: { private: "kulo-core", shared: "kulo-shared" },
        },
      },
    },
    history: [],
  };
}

describe("built-in skills, roles, extensions, and prompts localization", () => {
  it("localizes built-in skill descriptions while preserving third-party skill descriptions", () => {
    const genui: SkillRecord = {
      id: "genui-cards",
      name: "genui-cards",
      description: "Component specification and layout rules for kulo_ui_show.",
      source: "builtin",
      version: "v1",
      enabled: true,
      audiences: ["chat", "settings"],
      dependencies: [],
      diagnostics: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const htmlSkill: SkillRecord = {
      ...genui,
      id: "interactive-html",
      name: "interactive-html",
      description: "Design and deliver self-contained offline interactive HTML deliverables.",
    };
    const thirdParty: SkillRecord = {
      ...genui,
      id: "custom-skill",
      name: "custom-skill",
      description: "User-authored custom workflow description.",
      source: "local",
    };

    setLanguage("zh-CN");
    const zhHtml = renderToStaticMarkup(
      <SkillsModule snapshot={{ revision: 1, skills: [genui, htmlSkill, thirdParty] }} connected onRequest={vi.fn()} onRefresh={vi.fn()} />,
    );
    expect(zhHtml).toContain("genui-cards");
    expect(zhHtml).toContain("交互式结构化卡片");
    expect(zhHtml).toContain("离线自包含的交互式 HTML 作品");
    expect(zhHtml).toContain("User-authored custom workflow description.");

    setLanguage("en");
    const enHtml = renderToStaticMarkup(
      <SkillsModule snapshot={{ revision: 1, skills: [genui, htmlSkill, thirdParty] }} connected onRequest={vi.fn()} onRefresh={vi.fn()} />,
    );
    expect(enHtml).toContain("interactive structured HeroUI v3 cards");
    expect(enHtml).toContain("self-contained offline interactive HTML deliverables");
    expect(enHtml).toContain("User-authored custom workflow description.");
    expect(localizedSkillDescription(thirdParty, "zh-CN")).toBe("User-authored custom workflow description.");
  });

  it("localizes unmodified built-in agent roles in WorkersModule and restores defaults in the active language", () => {
    const customCoder = {
      ...defaultRolePresets("en").coder!,
      label: "My Coder",
      prompt: "Always run custom lint.",
    };
    const settings = makeSettings({
      roles: { ...defaultRolePresets("en"), coder: customCoder },
    });

    setLanguage("zh-CN");
    const zhHtml = renderToStaticMarkup(
      <WorkersModule settings={settings} onSettingsUpdated={vi.fn()} />,
    );
    expect(zhHtml).toContain("侦察员");
    expect(zhHtml).toContain("快速检索代码、追踪调用链与联网核实一手资料。");
    expect(zhHtml).toContain("My Coder");

    setLanguage("en");
    const enHtml = renderToStaticMarkup(
      <WorkersModule settings={settings} onSettingsUpdated={vi.fn()} />,
    );
    expect(enHtml).toContain("Scout");
    expect(enHtml).toContain("Fast codebase reconnaissance");
    expect(enHtml).toContain("My Coder");

    const restoredZh = roleMutationValue(settings.blocks.roles.value, { kind: "restore", language: "zh-CN" });
    expect(restoredZh.scout?.label).toBe("侦察员");
    expect(restoredZh.scout?.prompt).toContain("专注于快速、高信噪比的代码侦察");

    const restoredEn = roleMutationValue(settings.blocks.roles.value, { kind: "restore", language: "en" });
    expect(restoredEn.scout?.label).toBe("Scout");
    expect(restoredEn.scout?.prompt).toContain("Focus on fast, high-signal reconnaissance");
  });

  it("localizes built-in extension name, job stages, and capability prompts across zh-CN and en", () => {
    const extension: ExtensionRecord = {
      id: "billion-context",
      name: "Billion Context 上下文压缩",
      sourceUrl: "npm:acp-kernel",
      packageName: "acp-kernel",
      availableVersion: "0.0.101",
      adapterVersion: "1",
      enabled: false,
      status: "installing",
      revision: 1,
      updatedAt: 1,
    };
    const snapshot: ExtensionWorkspaceSnapshot = {
      revision: 1,
      items: [extension],
      jobs: [{
        id: "job-1",
        extensionId: "billion-context",
        clientId: "c1",
        operation: "install",
        status: "running",
        stage: "等待执行",
        createdAt: 1,
        updatedAt: 1,
      }],
    };

    setLanguage("zh-CN");
    expect(extensionDisplayName(extension)).toBe("Billion Context 上下文压缩");
    expect(extensionJobStageLabel("等待执行")).toBe("等待执行");
    expect(getAddImagePrompt()).toBe(ADD_IMAGE_PROMPT);
    expect(getImageRoutingPrompt()).toBe(IMAGE_ROUTING_PROMPT);

    setLanguage("en");
    const enExtHtml = renderToStaticMarkup(
      <OtherExtensionsModule snapshot={snapshot} connected onRequest={vi.fn()} onRefresh={vi.fn()} />,
    );
    expect(enExtHtml).toContain("Billion Context Compaction");
    expect(enExtHtml).toContain("Waiting to run");
    expect(enExtHtml).not.toContain("上下文压缩");
    expect(enExtHtml).not.toContain("等待执行");

    expect(getAddImagePrompt()).toBe(ADD_IMAGE_PROMPT_EN);
    expect(getImageRoutingPrompt()).toBe(IMAGE_ROUTING_PROMPT_EN);
    expect(isAddImagePrompt(ADD_IMAGE_PROMPT)).toBe(true);
    expect(isAddImagePrompt(ADD_IMAGE_PROMPT_EN)).toBe(true);
    expect(isImageRoutingPrompt(IMAGE_ROUTING_PROMPT)).toBe(true);
    expect(isImageRoutingPrompt(IMAGE_ROUTING_PROMPT_EN)).toBe(true);
  });

  it("syncs interface language to Hub presentation settings and retries cleanly on 409 conflict", async () => {
    const initial = makeSettings();
    const updated = makeSettings({ language: "en" });
    updated.blocks.presentation.revision = 2;

    const save = vi.fn().mockResolvedValue({ settings: updated });
    const getSettings = vi.fn();
    const onUpdated = vi.fn();

    await syncPresentationLanguage(initial, "en", onUpdated, { getSettings, saveSettingsBlock: save });
    expect(save).toHaveBeenCalledWith("presentation", 1, {
      agentName: "Kulo",
      workbenchName: "Kulo's table",
      language: "en",
    });
    expect(onUpdated).toHaveBeenCalledWith(updated);

    // No-op when Hub already has the same language
    save.mockClear();
    await syncPresentationLanguage(updated, "en", onUpdated, { getSettings, saveSettingsBlock: save });
    expect(save).not.toHaveBeenCalled();

    // Retries once on 409 conflict while preserving concurrent agentName change
    const latestFromServer = makeSettings();
    latestFromServer.blocks.presentation.revision = 5;
    latestFromServer.blocks.presentation.value.agentName = "Renamed Kulo";
    const resolved = makeSettings({ language: "zh-CN" });
    resolved.blocks.presentation.revision = 6;
    resolved.blocks.presentation.value.agentName = "Renamed Kulo";

    const conflictSave = vi
      .fn()
      .mockRejectedValueOnce(new KuloApiError(409, "conflict"))
      .mockResolvedValueOnce({ settings: resolved });
    getSettings.mockResolvedValue(latestFromServer);

    await syncPresentationLanguage(initial, "zh-CN", onUpdated, {
      getSettings,
      saveSettingsBlock: conflictSave,
    });
    expect(conflictSave).toHaveBeenLastCalledWith("presentation", 5, {
      agentName: "Renamed Kulo",
      workbenchName: "Kulo's table",
      language: "zh-CN",
    });
  });
});
