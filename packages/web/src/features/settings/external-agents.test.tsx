import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type EnvNodeDescriptor, type ExternalAgentScanResult, type ExternalClientConnection, type RolePreset } from "@kulo/protocol";
import { ExternalAgentsList } from "./external-agents-list";
import { ExternalAgentConnectCard, partitionExternalAgentScan } from "./external-agent-connect-card";
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
  it.each([true, false])("offers direct page-scoped agent connection shortcuts without synthetic chat prompts (%s)", (hasModel) => {
    const shortcuts = getSettingsAssistantShortcuts("workers", hasModel, "dark");
    expect(shortcuts.map((item) => item.label)).toEqual(["连接 Agent 客户端", "连接 Personal Agent"]);
    const client = shortcuts.find((item) => item.kind === "agent" && item.action === "client");
    const personal = shortcuts.find((item) => item.kind === "agent" && item.action === "personal");
    expect(client).toEqual({ id: "connect-agent-client", label: "连接 Agent 客户端", kind: "agent", action: "client" });
    expect(personal).toEqual({ id: "connect-personal-agent", label: "连接 Personal Agent", kind: "agent", action: "personal" });
    for (const page of ["models", "appearance", "connections", "capabilities"] as const) {
      expect(getSettingsAssistantShortcuts(page, hasModel, "dark").some((item) => item.kind === "agent")).toBe(false);
    }
  });

  it("renders direct scanned local client candidates with one-click connect and batch connect controls", () => {
    const scan: ExternalAgentScanResult = {
      scannedAt: 1,
      devices: [
        { id: "mac", name: "MacMini", online: true },
        { id: "book", name: "Macbook", online: true },
      ],
      candidates: [
        { kind: "codex", label: "Codex", status: "supported", envId: "mac", envName: "MacMini", online: true, installed: true, alreadyConnected: false, version: "0.9.1" },
        { kind: "claude-code", label: "Claude Code", status: "supported", envId: "book", envName: "Macbook", online: true, installed: true, alreadyConnected: false, version: "1.2.0" },
        { kind: "antigravity", label: "Antigravity", status: "supported", envId: "mac", envName: "MacMini", online: true, installed: true, alreadyConnected: true, connectedClientId: "antigravity:mac", connectedVerified: true, version: "2.0.0" },
        { kind: "dsh", label: "DeepSeek Harness", status: "supported", envId: "mac", envName: "MacMini", online: true, installed: false, alreadyConnected: false },
      ],
    };
    const partitioned = partitionExternalAgentScan(scan);
    expect(partitioned.multiDevice).toBe(true);
    expect(partitioned.connectable.map((item) => item.kind)).toEqual(["codex", "claude-code"]);
    expect(partitioned.missingLabels).toEqual(["DeepSeek Harness"]);

    const html = renderToStaticMarkup(
      <ExternalAgentConnectCard mode="client" clientId="tab-a" connected envs={[device]} initialScan={scan} onClose={vi.fn()} />,
    );
    expect(html).toContain("连接 Agent 客户端");
    expect(html).toContain("Codex");
    expect(html).toContain("MacMini · 0.9.1");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Macbook · 1.2.0");
    expect(html).toContain("Antigravity");
    expect(html).toContain("已连接");
    expect(html).toContain("全部连接（2）");
    expect(html).toContain("未检测到：");
    expect(html).toContain("DeepSeek Harness");
  });

  it("renders the direct personal agent card with experimental Grok Bot fields and reserved statuses", () => {
    const html = renderToStaticMarkup(
      <ExternalAgentConnectCard mode="personal" clientId="tab-a" connected envs={[device]} onClose={vi.fn()} />,
    );
    expect(html).toContain("连接 Personal Agent");
    expect(html).toContain("Grok Bot");
    expect(html).toContain("实验");
    expect(html).toContain("本机调试地址");
    expect(html).toContain("Bot 名称");
    expect(html).toContain("检查并保存");
    expect(html).toContain("ChatGPT Dots");
    expect(html).toContain("Meta Muse");
    expect(html).toContain("暂未开放");
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
