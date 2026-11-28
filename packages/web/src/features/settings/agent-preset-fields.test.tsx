import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExternalClientConnection, KuloSettingsView, RolePreset } from "@kulo/protocol";
import { AgentPresetFields, applyExternalModelChange } from "./agent-preset-fields";
import { SETTINGS_MODULES, toProviderModelItem, type ProviderModelGroup } from "./settings-helpers";

const defaultModel: KuloSettingsView["blocks"]["model"]["value"] = {
  baseUrl: "http://127.0.0.1:9/v1",
  apiMode: "openai-responses",
  defaultProvider: "api-demo",
  defaultModel: "demo-model",
  thinkingLevel: "careful",
  customProviders: [],
};
const groups: ProviderModelGroup[] = [{
  providerId: "api-demo",
  label: "Demo",
  models: [toProviderModelItem({ id: "demo-model", thinkingLevels: [{ id: "careful", label: "仔细思考", value: "high" }] })],
}];
const agent: RolePreset = {
  id: "analyst", label: "数据分析师", readOnly: true, allowSubagents: true,
  whenToUse: "核实统计分析与数据质量。", prompt: "先核实数据来源，再完成分析。",
  thinkingLevel: "auto", enabled: true,
};

function renderFields({ value = agent, availableGroups = groups, isCreating = false, isDisabled = false }: {
  value?: RolePreset;
  availableGroups?: ProviderModelGroup[];
  isCreating?: boolean;
  isDisabled?: boolean;
} = {}) {
  return renderToStaticMarkup(<AgentPresetFields value={value} onChange={() => {}}
    groups={availableGroups} defaultModel={defaultModel} isCreating={isCreating} isDisabled={isDisabled} />);
}

describe("agent settings fields", () => {
  it("offers the same complete configuration when creating and editing an agent", () => {
    const edit = renderFields();
    const create = renderFields({ isCreating: true });
    for (const html of [edit, create]) {
      for (const label of ["智能体名称", "只读模式", "允许子智能体", "智能体模型", "默认思考强度", "负责任务", "智能体系统提示词"]) {
        expect(html).toContain(label);
      }
      expect(html).toContain(agent.label);
      expect(html).toContain(agent.whenToUse);
      expect(html).toContain(agent.prompt);
      expect(html.match(/role="switch"/g)).toHaveLength(2);
      expect(html.match(/aria-haspopup="listbox"/g)).toHaveLength(2);
      expect(html).not.toContain('role="radio');
    }
    expect(create).toContain("智能体标识");
    expect(edit).not.toContain("智能体标识");
  });

  it.each([
    { thinkingLevel: "auto", expectedLabel: "自动" },
    { thinkingLevel: "careful", expectedLabel: "仔细思考" },
  ])("displays the selected $thinkingLevel effort using its model label", ({ thinkingLevel, expectedLabel }) => {
    const html = renderFields({ value: { ...agent, thinkingLevel } });
    expect(html).toContain(expectedLabel);
    expect(html).not.toContain('role="radio');
  });

  it("keeps a saved model and effort visible when the model catalog is unavailable", () => {
    const html = renderFields({
      value: { ...agent, provider: "api-missing", modelId: "saved-model", thinkingLevel: "saved-effort" },
      availableGroups: [],
    });
    expect(html).toContain("saved-model");
    expect(html).toContain("saved-effort");
  });

  it("counts Chinese characters and emoji without limiting task or prompt input", () => {
    const html = renderFields({ value: { ...agent, whenToUse: "中文😀", prompt: "测试代码🚀完成" } });
    expect(html).toMatch(/3\s*字/);
    expect(html).toMatch(/7\s*字/);
    const textareas = html.match(/<textarea\b[^>]*>/g) ?? [];
    expect(textareas).toHaveLength(2);
    for (const textarea of textareas) {
      expect(textarea).not.toMatch(/maxlength=/i);
    }
  });

  it("disables every group while configuration is being saved", () => {
    const html = renderFields({ isDisabled: true });
    expect(html.match(/<fieldset\b[^>]*disabled=""/g)).toHaveLength(3);
  });

  it("provides one combined agent settings navigation entry", () => {
    const titles = SETTINGS_MODULES.map((module) => module.title);
    expect(titles.filter((title) => title === "智能体")).toHaveLength(1);
    expect(titles).not.toContain("并发与运行");
    expect(titles).not.toContain("Worker 配置");
  });

  it("hides thinking effort selector for unsupported external models like Orchestrator (Neon) and clears stale thinkingLevel on switch", () => {
    const agyClient: ExternalClientConnection = {
      id: "antigravity:local",
      kind: "antigravity",
      envId: "local",
      verifiedAt: 100,
      updatedAt: 100,
      models: [
        { id: "claude-opus", name: "Claude Opus", efforts: ["low", "medium", "high", "xhigh"], effortCapability: "supported", isDefault: true },
        { id: "orchestrator-neon", name: "Orchestrator (Neon)", effortCapability: "unsupported" },
      ],
    };
    const agyRole: RolePreset = {
      ...agent,
      id: "agy-worker",
      externalClientId: agyClient.id,
      external: { kind: "antigravity", envId: "local", verifiedAt: 100 },
      modelId: "claude-opus",
      thinkingLevel: "xhigh",
    };

    const supportedHtml = renderToStaticMarkup(
      <AgentPresetFields value={agyRole} onChange={() => {}} externalClient={agyClient} />,
    );
    expect(supportedHtml).toContain("默认思考强度");

    // Switching into Orchestrator (Neon) automatically clears stale thinkingLevel
    const switched = applyExternalModelChange(agyRole, "orchestrator-neon", agyClient.models, "antigravity");
    expect(switched.modelId).toBe("orchestrator-neon");
    expect(switched.thinkingLevel).toBe("auto");

    // Rendering an unsupported model hides the thinking effort selector (no unionExternalEfforts fallback)
    const unsupportedHtml = renderToStaticMarkup(
      <AgentPresetFields value={switched} onChange={() => {}} externalClient={agyClient} />,
    );
    expect(unsupportedHtml).not.toContain("默认思考强度");

    // Switching back to a model with narrower efforts clears unsupported xhigh
    const narrowerModels = [
      { id: "flash", name: "Flash", efforts: ["low", "medium"], effortCapability: "supported" as const },
    ];
    const narrowed = applyExternalModelChange(agyRole, "flash", narrowerModels, "antigravity");
    expect(narrowed.thinkingLevel).toBe("auto");

    // Unknown model catalog falls back to antigravity efforts including xhigh
    const unknownClient: ExternalClientConnection = { ...agyClient, models: [] };
    const unknownHtml = renderToStaticMarkup(
      <AgentPresetFields value={{ ...agyRole, modelId: undefined, thinkingLevel: "xhigh" }} onChange={() => {}} externalClient={unknownClient} />,
    );
    expect(unknownHtml).toContain("默认思考强度");
  });
});
