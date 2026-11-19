import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type EnvNodeDescriptor, type ExternalClientConnection, type RolePreset } from "@kulo/protocol";
import { ExternalAgentsList } from "./external-agents-list";
import { deriveExternalClients, internalAgentPresets, withExternalAgentPresets } from "./external-agents-view";
import { advanceSettingsAssistantPageScope } from "./settings-assistant-page-scope";
import { getSettingsAssistantShortcuts } from "./settings-assistant-actions";

const external: RolePreset = {
  id: "codex-architect", label: "Codex 架构师", whenToUse: "负责复杂架构拆解与设计", prompt: "遵循项目规范给出架构方案。", enabled: true,
  modelId: "astra", thinkingLevel: "high", externalClientId: "codex:mac",
  external: { kind: "codex", envId: "mac", version: "1.0", verifiedAt: 123 },
};
const externalTester: RolePreset = {
  id: "codex-tester", label: "Codex 测试员", whenToUse: "负责编写回归测试与边界排查", prompt: "运行并验证测试。", enabled: true,
  modelId: "sol", thinkingLevel: "medium", externalClientId: "codex:mac",
  external: { kind: "codex", envId: "mac", version: "1.0", verifiedAt: 123 },
};
const codexClient: ExternalClientConnection = {
  id: "codex:mac",
  kind: "codex",
  envId: "mac",
  version: "1.0",
  verifiedAt: 123,
  models: [
    { id: "astra", name: "Astra", efforts: ["low", "medium", "high"], isDefault: true },
    { id: "sol", name: "Sol", efforts: ["low", "medium"] },
  ],
  updatedAt: 123,
};
const device = { id: "mac", name: "开发电脑", online: true } as EnvNodeDescriptor;

describe("external agents in settings", () => {
  it.each([true, false])("offers page-scoped connection introductions with model availability %s", (hasModel) => {
    const shortcuts = getSettingsAssistantShortcuts("workers", hasModel, "dark");
    expect(shortcuts.map((item) => item.label)).toEqual(["连接 Agent 客户端", "连接 Personal Agent"]);
    const client = shortcuts.find((item) => item.kind === "agent" && item.action === "client");
    const personal = shortcuts.find((item) => item.kind === "agent" && item.action === "personal");
    expect(client?.kind).toBe("agent");
    if (client?.kind !== "agent" || personal?.kind !== "agent") throw new Error("Connection shortcuts missing");
    for (const name of ["Codex", "Claude Code", "Antigravity", "DeepSeek Harness"]) expect(client.introduction).toContain(name);
    for (const name of ["Grok Bot", "ChatGPT Dots", "Meta Muse"]) expect(personal.introduction).toContain(name);
    for (const page of ["models", "appearance", "connections", "capabilities"] as const) {
      expect(getSettingsAssistantShortcuts(page, hasModel, "dark").some((item) => item.kind === "agent")).toBe(false);
    }
  });

  it("groups multiple external agent personas under one connected client with streamlined 5-field editors", () => {
    const html = renderToStaticMarkup(
      <ExternalAgentsList
        agents={[external, externalTester, ...Object.values(defaultRolePresets())]}
        externalClients={{ [codexClient.id]: codexClient }}
        envs={[device]}
        openRole={external.id}
        onRoleChange={vi.fn()}
        onToggleEnabled={vi.fn()}
        onCreateRole={vi.fn(async () => true)}
        onDeleteRole={vi.fn()}
        onRefreshClient={vi.fn()}
      />,
    );
    for (const value of ["Codex · 开发电脑", "连接已验证", "刷新模型", "新建智能体", "Codex 架构师", "astra", "Codex 测试员", "sol", "委派时机", "交给该智能体的任务要求"]) {
      expect(html).toContain(value);
    }
    // Redundant toggles removed for product restraint
    expect(html).not.toContain("仅点名");
    expect(html).not.toContain("Hub 协作");
    expect(html).not.toContain("允许子智能体");
    expect(html).not.toContain("只读模式");
    expect(renderToStaticMarkup(<ExternalAgentsList agents={Object.values(defaultRolePresets())} />)).toBe("");
  });

  it("keeps connected client section visible when all its personas were removed and exposes connection removal", () => {
    const html = renderToStaticMarkup(
      <ExternalAgentsList
        agents={Object.values(defaultRolePresets())}
        externalClients={{ [codexClient.id]: codexClient }}
        envs={[device]}
        onCreateRole={vi.fn(async () => true)}
        onRemoveClient={vi.fn()}
      />,
    );
    expect(html).toContain("Codex · 开发电脑");
    expect(html).toContain("新建智能体");
    expect(html).toContain('aria-label="Codex · 开发电脑连接操作"');
    expect(html).toContain("暂无智能体");
  });

  it("keeps experimental, offline and reserved status distinct from verified connections", () => {
    const cases: Array<{ role: RolePreset; envs?: EnvNodeDescriptor[]; status: string }> = [
      { role: { ...external, external: { ...external.external!, verifiedAt: undefined } }, status: "待验证" },
      { role: { ...external, enabled: false }, status: "已停用" },
      { role: external, envs: [{ ...device, online: false }], status: "设备离线" },
      { role: { ...external, externalClientId: undefined, external: { ...external.external!, kind: "grok-bot", experimental: true } }, status: "实验" },
      { role: { ...external, externalClientId: undefined, external: { ...external.external!, kind: "dots" } }, status: "待支持" },
      { role: { ...external, externalClientId: undefined, external: { ...external.external!, kind: "muse" } }, status: "待支持" },
    ];
    for (const { role, envs, status } of cases) expect(renderToStaticMarkup(<ExternalAgentsList agents={[role]} envs={envs} />)).toContain(status);
  });

  it("preserves current external configurations when internal settings are edited or reset", () => {
    const defaults = defaultRolePresets();
    const combined = { ...defaults, [external.id]: external, [externalTester.id]: externalTester };
    expect(internalAgentPresets(combined)).toEqual(defaults);
    expect(deriveExternalClients(combined)).toHaveLength(1);
    const edited = { ...defaults, coder: { ...defaults.coder!, label: "新的开发者" } };
    const merged = withExternalAgentPresets(edited, combined);
    expect(merged[external.id]).toBe(external);
    expect(merged[externalTester.id]).toBe(externalTester);
    expect(merged.coder?.label).toBe("新的开发者");
  });
});

describe("settings assistant page authority", () => {
  it("revokes a page scope on close and gives reopening a different generation", () => {
    const current = { active: true, module: "workers" as const, generation: 20 };
    const unchanged = advanceSettingsAssistantPageScope(current, true, "workers");
    expect(unchanged).toBe(current);
    const closed = advanceSettingsAssistantPageScope(current, false, "workers");
    expect(closed).toEqual({ active: false, module: "workers", generation: 21 });
    const reopened = advanceSettingsAssistantPageScope(closed, true, "workers");
    expect(reopened).toEqual({ active: true, module: "workers", generation: 22 });
    const moved = advanceSettingsAssistantPageScope(reopened, true, "models");
    expect(moved).toEqual({ active: true, module: "models", generation: 23 });
  });
});
