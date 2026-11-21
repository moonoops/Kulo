import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type EnvNodeDescriptor, type ExternalAgentScanResult, type ExternalClientConnection, type KuloSettingsView, type RolePreset } from "@kulo/protocol";
import { ExternalAgentsList } from "./external-agents-list";
import {
  ExternalAgentConnectCard,
  formatMissingExternalAgentLabels,
  parseAcpArgsInput,
  partitionExternalAgentScan,
} from "./external-agent-connect-card";
import { deriveExternalClients, internalAgentPresets, withExternalAgentPresets } from "./external-agents-view";
import { advanceSettingsAssistantPageScope } from "./settings-assistant-page-scope";
import { getSettingsAssistantShortcuts } from "./settings-assistant-actions";
import { WorkersModule } from "./workers-module";

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

  it("shows unauthenticated login hints, pending-verify actions, custom path toggle, and left-panel connect entry (U1, U3)", () => {
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
    const unverifiedRole: RolePreset = { ...external, enabled: false, external: { ...external.external!, verifiedAt: undefined } };
    const listHtml = renderToStaticMarkup(
      <ExternalAgentsList
        agents={[unverifiedRole]}
        externalClients={{ [unverifiedClient.id]: unverifiedClient }}
        envs={[device]}
        onVerifyClient={vi.fn()}
        onRemoveClient={vi.fn()}
      />,
    );
    expect(listHtml).toContain("验证连接");

    const emptySettings = {
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
    } as unknown as KuloSettingsView;
    const workersHtml = renderToStaticMarkup(
      <WorkersModule settings={emptySettings} envs={[device]} onSettingsUpdated={vi.fn()} />,
    );
    expect(workersHtml).toContain("外部客户端");
    expect(workersHtml).toContain("连接客户端");
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
      <ExternalAgentsList
        agents={[kimiRole]}
        envs={[{ id: "macbook", name: "Macbook", online: true } as EnvNodeDescriptor]}
      />,
    );
    expect(acpListHtml).toContain("Kimi Code · Macbook");
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
