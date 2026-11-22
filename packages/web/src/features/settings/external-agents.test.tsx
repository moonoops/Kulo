import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type EnvNodeDescriptor, type ExternalAgentScanResult, type ExternalClientConnection, type KuloSettingsView, type RolePreset } from "@kulo/protocol";
import { AgentsModule } from "./agents-module";
import { AgentPresetFields } from "./agent-preset-fields";
import { ExternalClientsList, ExternalClientsModule } from "./external-agents-list";
import {
  ExternalAgentConnectCard,
  formatMissingExternalAgentLabels,
  parseAcpArgsInput,
  partitionExternalAgentScan,
} from "./external-agent-connect-card";
import { deriveExternalClients, internalAgentPresets, switchRoleEngine, withExternalAgentPresets } from "./external-agents-view";
import { advanceSettingsAssistantPageScope } from "./settings-assistant-page-scope";
import { getSettingsAssistantShortcuts } from "./settings-assistant-actions";
import { WorkersModule } from "./workers-module";

const external: RolePreset = {
  id: "codex-architect", label: "Codex 架构师", whenToUse: "负责复杂架构拆解与设计", prompt: "遵循项目规范给出架构方案。", enabled: true,
  modelId: "astra", thinkingLevel: "high", serviceTier: "ultrafast", externalClientId: "codex:mac",
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
    {
      id: "astra",
      name: "Astra",
      efforts: ["low", "medium", "high"],
      serviceTiers: [
        { id: "fast", name: "Fast" },
        { id: "ultrafast", name: "Ultra Fast" },
      ],
      isDefault: true,
    },
    { id: "sol", name: "Sol", efforts: ["low", "medium"] },
  ],
  updatedAt: 123,
};
const device = { id: "mac", name: "开发电脑", online: true } as EnvNodeDescriptor;

function settingsFixture(overrides: Partial<KuloSettingsView> = {}): KuloSettingsView {
  return {
    globalRevision: 1,
    blocks: {
      presentation: { revision: 1, value: { agentName: "Kulo", language: "zh-CN" } },
      executor: { revision: 1, value: { maxConcurrentWorkers: 2, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5, completedTaskDisplayHours: 3, autoArchiveEnabled: true, autoArchiveDays: 7 } },
      roles: { revision: 1, value: defaultRolePresets() },
      model: { revision: 1, value: { baseUrl: "https://api.openai.com/v1", apiMode: "openai-completions", defaultModel: "gpt-5", thinkingLevel: "medium", contextWindow: 128000, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 64000 }, customProviders: [], gatewayDisabled: true }, hasApiKey: false },
      identity: { revision: 1, value: { directory: "" }, effectiveDirectory: "/tmp/identity", directoryRevision: 1 },
      memory: { revision: 1, value: { enabled: false, accessMode: "kulo", endpoint: "http://127.0.0.1:8888", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", sharedReadApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: true, banks: { private: "kulo-core", shared: "kulo-shared" } }, hasRouterApiKey: false, hasWorkerApiKey: false, hasSharedReadApiKey: false },
    },
    history: [],
    ...overrides,
  } as unknown as KuloSettingsView;
}

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

  it("renders three top-level tabs in AgentsModule: Agents, Third-party Agents, and Runtime", () => {
    const html = renderToStaticMarkup(
      <AgentsModule
        settings={settingsFixture({ externalClients: { [codexClient.id]: codexClient } })}
        envs={[device]}
        onSettingsUpdated={vi.fn()}
      />,
    );
    expect(html).toContain("智能体");
    expect(html).toContain("第三方 Agent");
    expect(html).toContain("运行设置");
    expect(html).toContain("Codex @ 开发电脑");
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

  it("renders third-party client connections cleanly without duplicating worker lists and surfaces model/usage summary", () => {
    const html = renderToStaticMarkup(
      <ExternalClientsList
        clients={[codexClient]}
        roles={{ ...defaultRolePresets(), [external.id]: external, [externalTester.id]: externalTester }}
        envs={[device]}
        onRefreshClient={vi.fn()}
        onVerifyClient={vi.fn()}
        onRemoveClient={vi.fn()}
      />,
    );
    for (const value of ["Codex @ 开发电脑", "已连接", "刷新模型", "2 个模型", "2 个智能体使用"]) {
      expect(html).toContain(value);
    }
    expect(html).toContain('aria-label="Codex @ 开发电脑连接操作"');
    expect(renderToStaticMarkup(<ExternalClientsList clients={[]} roles={defaultRolePresets()} />)).toContain("暂无已连接的第三方 Agent");
  });

  it("unifies built-in and external-bound workers in WorkersModule with engine, serviceTier, readOnly/allowSubagents, and unambiguous creation placeholders", () => {
    const base = defaultRolePresets();
    const rolesWithExternal: Record<string, RolePreset> = {
      ...base,
      architect: {
        ...base.architect!,
        modelId: "astra",
        thinkingLevel: "high",
        serviceTier: "ultrafast",
        externalClientId: codexClient.id,
        external: { kind: "codex", envId: "mac", version: "1.0", verifiedAt: 123 },
      },
    };
    const workersHtml = renderToStaticMarkup(
      <WorkersModule
        settings={settingsFixture({
          blocks: { ...settingsFixture().blocks, roles: { revision: 2, value: rolesWithExternal } },
          externalClients: { [codexClient.id]: codexClient },
        })}
        envs={[device]}
        onSettingsUpdated={vi.fn()}
      />,
    );
    expect(workersHtml).toContain("架构师");
    expect(workersHtml).toContain("Codex @ 开发电脑 · astra · 高 · Ultra Fast");
    expect(workersHtml).not.toContain("外部客户端");

    const fieldsHtml = renderToStaticMarkup(
      <AgentPresetFields
        value={rolesWithExternal.architect!}
        onChange={vi.fn()}
        externalClients={[codexClient]}
        envs={[device]}
        isCreating
      />,
    );
    expect(fieldsHtml).toContain("运行引擎");
    expect(fieldsHtml).toContain("服务档位");
    expect(fieldsHtml).toContain("只读模式");
    expect(fieldsHtml).toContain("允许子智能体");
    expect(fieldsHtml).toContain("例如：数据分析师");
    expect(fieldsHtml).toContain("例如：analyst");

    // Switching engines clears incompatible provider/model/serviceTier cleanly
    const toExternal = switchRoleEngine(base.coder!, codexClient);
    expect(toExternal.externalClientId).toBe(codexClient.id);
    expect(toExternal.external?.kind).toBe("codex");
    expect(toExternal.provider).toBeUndefined();
    expect(toExternal.modelId).toBeUndefined();
    const backToBuiltin = switchRoleEngine({ ...toExternal, modelId: "astra", serviceTier: "fast" }, undefined);
    expect(backToBuiltin.external).toBeUndefined();
    expect(backToBuiltin.externalClientId).toBeUndefined();
    expect(backToBuiltin.modelId).toBeUndefined();
    expect(backToBuiltin.serviceTier).toBeUndefined();
    expect(backToBuiltin.thinkingLevel).toBe("auto");
  });

  it("keeps experimental, offline, unverified and reserved client statuses distinct", () => {
    const cases: Array<{ client: ExternalClientConnection; envs?: EnvNodeDescriptor[]; status: string }> = [
      { client: { ...codexClient, verifiedAt: undefined }, status: "待验证" },
      { client: codexClient, envs: [{ ...device, online: false }], status: "设备离线" },
      { client: { ...codexClient, id: "grok-bot:mac", kind: "grok-bot", experimental: true, verifiedAt: undefined }, status: "实验" },
      { client: { ...codexClient, id: "dots:mac", kind: "dots", verifiedAt: undefined }, status: "待支持" },
      { client: { ...codexClient, id: "muse:mac", kind: "muse", verifiedAt: undefined }, status: "待支持" },
    ];
    for (const { client, envs, status } of cases) {
      expect(renderToStaticMarkup(<ExternalClientsList clients={[client]} roles={{}} envs={envs} />)).toContain(status);
    }
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

  it("shows unauthenticated login hints, pending-verify actions, custom path toggle, and connect entry in Third-party Agents tab (U1, U3)", () => {
    const scan: ExternalAgentScanResult = {
      scannedAt: 1,
      devices: [{ id: "mac", name: "MacBook", online: true }],
      candidates: [
        { kind: "claude-code", label: "Claude Code", status: "supported", envId: "mac", envName: "MacBook", online: true, installed: true, authenticated: false, alreadyConnected: false, version: "2.1.0" },
        { kind: "antigravity", label: "Antigravity", status: "supported", envId: "mac", envName: "MacBook", online: true, installed: true, authenticated: null, alreadyConnected: true, connectedClientId: "antigravity:mac", connectedVerified: false, version: "1.5.5" },
      ],
    };
    const partitioned = partitionExternalAgentScan(scan);
    expect(partitioned.connectable.map((c) => c.kind)).toEqual(["antigravity"]);

    const cardHtml = renderToStaticMarkup(
      <ExternalAgentConnectCard mode="client" clientId="tab-u3" connected envs={[device]} initialScan={scan} onClose={vi.fn()} />,
    );
    expect(cardHtml).toContain("未登录");
    expect(cardHtml).toContain("claude auth login");
    expect(cardHtml).toContain("验证并启用");
    expect(cardHtml).toContain("手动指定客户端路径");

    const unverifiedClient: ExternalClientConnection = { ...codexClient, verifiedAt: undefined };
    const listHtml = renderToStaticMarkup(
      <ExternalClientsList
        clients={[unverifiedClient]}
        roles={{}}
        envs={[device]}
        onVerifyClient={vi.fn()}
        onRemoveClient={vi.fn()}
      />,
    );
    expect(listHtml).toContain("验证连接");

    const clientsModuleHtml = renderToStaticMarkup(
      <ExternalClientsModule settings={settingsFixture()} envs={[device]} onSettingsUpdated={vi.fn()} />,
    );
    expect(clientsModuleHtml).toContain("第三方 Agent");
    expect(clientsModuleHtml).toContain("连接客户端");
  });

  it("prioritizes currentDeviceId over remote hub local, collapses >3 missing labels, shows Grok Bot desktopAppInstalled chip, and distinguishes custom ACP clients", () => {
    const scan: ExternalAgentScanResult = {
      scannedAt: 1,
      devices: [
        { id: "local", name: "MacMini", online: true },
        { id: "macbook", name: "Macbook", online: true },
      ],
      candidates: [
        { kind: "codex", label: "Codex", status: "supported", envId: "local", envName: "MacMini", online: true, installed: true, alreadyConnected: false, version: "0.171.0" },
        { kind: "grok", label: "Grok Build", status: "supported", envId: "macbook", envName: "Macbook", online: true, installed: true, authenticated: false, alreadyConnected: false, version: "1.0.92" },
        { kind: "cursor", label: "Cursor Agent", status: "supported", envId: "macbook", envName: "Macbook", online: true, installed: false, alreadyConnected: false },
        { kind: "opencode", label: "OpenCode", status: "supported", envId: "macbook", envName: "Macbook", online: true, installed: false, alreadyConnected: false },
        { kind: "gemini-cli", label: "Gemini CLI", status: "supported", envId: "macbook", envName: "Macbook", online: true, installed: false, alreadyConnected: false },
        { kind: "kiro", label: "Kiro CLI", status: "supported", envId: "macbook", envName: "Macbook", online: true, installed: false, alreadyConnected: false },
      ],
    };
    const partitioned = partitionExternalAgentScan(scan, "macbook");
    expect(partitioned.onlineDevices.map((item) => item.id)).toEqual(["macbook", "local"]);
    expect(partitioned.installed.map((item) => item.kind)).toEqual(["grok", "codex"]);
    expect(partitioned.missingLabels).toEqual(["Cursor Agent", "OpenCode", "Gemini CLI", "Kiro CLI"]);
    expect(formatMissingExternalAgentLabels(partitioned.missingLabels, (zh) => zh)).toBe("Cursor Agent · OpenCode · Gemini CLI 等 4 项");

    const clientHtml = renderToStaticMarkup(
      <ExternalAgentConnectCard
        mode="client"
        clientId="tab-b"
        connected
        currentDeviceId="macbook"
        envs={[
          { id: "local", name: "MacMini", online: true } as EnvNodeDescriptor,
          { id: "macbook", name: "Macbook", online: true } as EnvNodeDescriptor,
        ]}
        initialScan={scan}
        onClose={vi.fn()}
      />,
    );
    expect(clientHtml).toContain("grok login");
    expect(clientHtml).toContain("等 4 项");

    const personalScan: ExternalAgentScanResult = {
      scannedAt: 1,
      devices: [{ id: "macbook", name: "Macbook", online: true }],
      candidates: [
        { kind: "grok-bot", label: "Grok Bot", status: "experimental", envId: "macbook", envName: "Macbook", online: true, installed: false, desktopAppInstalled: true, version: "1.1.0", alreadyConnected: false },
      ],
    };
    const personalHtml = renderToStaticMarkup(
      <ExternalAgentConnectCard
        mode="personal"
        clientId="tab-p"
        connected
        currentDeviceId="macbook"
        envs={[{ id: "macbook", name: "Macbook", online: true } as EnvNodeDescriptor]}
        initialScan={personalScan}
        onClose={vi.fn()}
      />,
    );
    expect(personalHtml).toContain("已安装 1.1.0");

    const kimiRole: RolePreset = {
      id: "kimi-code",
      label: "Kimi Code",
      whenToUse: "代码任务",
      prompt: "执行任务",
      enabled: true,
      externalClientId: "acp:macbook:kimi-code",
      external: { kind: "acp", envId: "macbook", agentRef: "kimi-code", executable: "/usr/local/bin/kimi-code", acpArgs: ["acp"], verifiedAt: 10 },
    };
    const derived = deriveExternalClients({ [kimiRole.id]: kimiRole });
    expect(derived[0]).toMatchObject({ id: "acp:macbook:kimi-code", label: "Kimi Code", acpArgs: ["acp"] });

    const acpListHtml = renderToStaticMarkup(
      <ExternalClientsList
        clients={derived}
        roles={{ [kimiRole.id]: kimiRole }}
        envs={[{ id: "macbook", name: "Macbook", online: true } as EnvNodeDescriptor]}
      />,
    );
    expect(acpListHtml).toContain("Kimi Code @ Macbook");
    expect(parseAcpArgsInput('acp --profile "my profile" --fast')).toEqual(["acp", "--profile", "my profile", "--fast"]);
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
