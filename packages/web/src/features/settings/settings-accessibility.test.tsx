import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultRolePresets, type MocoSettingsView } from "@moco/protocol";
import { WorkersModule } from "./workers-module";
import { ConcurrencyModule } from "./concurrency-module";
import { IdentityModule } from "./identity-module";
import { WorkbenchShell } from "../shell/workbench-shell";
import { SettingsSection } from "./settings-layout";
import { AppearanceModule } from "./appearance-module";

const settings: MocoSettingsView = {
  globalRevision: 1,
  blocks: {
    presentation: { revision: 1, value: { agentName: "Moco", workbenchName: "Moco's table" } },
    executor: { revision: 1, value: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 } },
    roles: { revision: 1, value: defaultRolePresets() },
    model: { revision: 1, hasApiKey: false, value: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "test-model", thinkingLevel: "off", customProviders: [] } },
    identity: { revision: 1, directoryRevision: 1, effectiveDirectory: "/tmp/identity", value: { directory: "/tmp/identity" } },
    memory: { revision: 1, hasRouterApiKey: false, hasWorkerApiKey: false, value: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "private", shared: "shared" } } },
  },
  history: [],
};
const update = () => {};

describe("settings controls and layout", () => {
  it("uses compact font and language pickers with the saved default selected", () => {
    const html = renderToStaticMarkup(<AppearanceModule />);
    expect(html).toContain("对话字号");
    expect(html.match(/aria-haspopup="listbox"/g)).toHaveLength(2);
    expect(html).toContain("中 · 14 px");
    expect(html).toContain("中文");
    expect(html).toContain('aria-label="外观偏好"');
    expect(html.match(/class="[^"]*\bmoco-settings-row\b/g)).toHaveLength(4);
    expect(html).toContain('aria-label="自动切换形象"');
    expect(html).toContain('aria-label="动态"');
    expect(html).not.toContain("grid-cols-4");
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain("对话字号预览");
    expect(html).not.toContain("保存");
    expect(html).toContain('aria-label="明暗模式"');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
  });

  it("names each settings section from its own heading", () => {
    const html = renderToStaticMarkup(<><SettingsSection title="模型连接"><span>连接列表</span></SettingsSection><SettingsSection title="运行策略"><span>策略设置</span></SettingsSection></>);
    const sectionNames = [...html.matchAll(/<section\b[^>]*aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
    expect(sectionNames).toHaveLength(2);
    expect(new Set(sectionNames).size).toBe(2);
    for (const id of sectionNames) expect(html).toContain(`<h2 id="${id}"`);
  });

  it("renders every role enable control as an operable switch", () => {
    const html = renderToStaticMarkup(<WorkersModule settings={settings} onSettingsUpdated={update} />);
    const switches = (html.match(/<input\b(?=[^>]*role="switch")(?=[^>]*tabindex="0")[^>]*>/g) ?? [])
      .filter((input) => input.includes('aria-label="启用'));
    expect(switches).toHaveLength(Object.keys(settings.blocks.roles.value).length);
    for (const zhLabel of ["侦察员", "架构师", "开发者", "检验员", "设计师", "写作者"]) {
      expect(html).toContain("启用" + zhLabel);
    }
  });

  it("groups external agents under labeled client sections with operable switches separate from internal role forms", () => {
    const next: MocoSettingsView = { ...settings, blocks: { ...settings.blocks, roles: { revision: 2, value: {
      ...settings.blocks.roles.value,
      "external-codex": { id: "external-codex", label: "本机 Codex", whenToUse: "代码任务", prompt: "外部执行指令", enabled: true,
        external: { kind: "codex", envId: "local", verifiedAt: 123 } },
    } } } };
    const html = renderToStaticMarkup(<WorkersModule settings={next} onSettingsUpdated={update} />);
    expect(html).toContain("Codex · local");
    expect(html).toContain("本机 Codex");
    expect(html).toContain('aria-label="启用本机 Codex"');
    expect(html).toContain("外部执行指令");
    expect(html.match(/aria-label="启用/g)).toHaveLength(Object.keys(settings.blocks.roles.value).length + 1);
    const internalForm = html.slice(html.indexOf('aria-label="智能体配置"'));
    expect(internalForm).not.toContain("本机 Codex");
  });

  it("exposes task acceptance and memory enable controls as switches", () => {
    const concurrency = renderToStaticMarkup(<ConcurrencyModule settings={settings} onSettingsUpdated={update} />);
    const identity = renderToStaticMarkup(<IdentityModule settings={settings} onSettingsUpdated={update} />);
    expect(concurrency).toMatch(/<input\b[^>]*role="switch"/);
    expect(concurrency).toContain("接收新任务");
    expect(identity).toMatch(/<input\b[^>]*role="switch"/);
    expect(identity).toContain("启用长期记忆");
    expect(identity.match(/data-inert="true"/g)).toHaveLength(3);
  });

  it("offers direct numeric runtime inputs without steppers or radio options", () => {
    const html = renderToStaticMarkup(<ConcurrencyModule settings={settings} onSettingsUpdated={update} />);
    expect(html.match(/<input\b[^>]*inputMode="numeric"[^>]*>/gi)).toHaveLength(4);
    for (const label of ["并发智能体上限", "并发子智能体上限", "超时检查", "自动归档", "未活动超过"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain('role="radio');
    expect(html.match(/<button\b/g)).toHaveLength(2);
    expect(html).toContain('aria-label="超时检查说明"');
    expect(html).toContain("已完成任务显示时长");
    expect(html.indexOf("已完成任务显示时长")).toBeGreaterThan(html.indexOf("超时检查"));
    expect(html).not.toContain("安全护栏");
    expect(html).not.toContain("moco-settings-savebar");
    expect(html).not.toContain('aria-invalid="true"');
  });

  it.each([
    { enabled: undefined, days: undefined, expectedEnabled: true, expectedDays: 7 },
    { enabled: true, days: 14, expectedEnabled: true, expectedDays: 14 },
    { enabled: false, days: 30, expectedEnabled: false, expectedDays: 30 },
  ])("retains auto-archive settings $enabled / $days with legacy defaults", ({ enabled, days, expectedEnabled, expectedDays }) => {
    const executor = { ...settings.blocks.executor, value: { ...settings.blocks.executor.value, autoArchiveEnabled: enabled, autoArchiveDays: days } };
    const html = renderToStaticMarkup(<ConcurrencyModule settings={{ ...settings, blocks: { ...settings.blocks, executor } }} onSettingsUpdated={update} />);
    const switches = html.match(/<input\b[^>]*role="switch"[^>]*>/g) ?? [];
    expect(switches).toHaveLength(2);
    expect(switches[1]?.includes('checked=""')).toBe(expectedEnabled);
    const numericInputs = html.match(/<input\b[^>]*inputMode="numeric"[^>]*>/gi) ?? [];
    expect(numericInputs).toHaveLength(expectedEnabled ? 4 : 3);
    if (expectedEnabled) {
      expect(numericInputs.at(-1)).toContain(`value="${expectedDays}"`);
      expect(numericInputs.at(-1)).not.toContain('disabled=""');
    } else {
      expect(html).not.toContain("未活动超过");
    }
  });

  it.each([
    { hours: undefined, expectedLabel: "3 小时" },
    { hours: 1 as const, expectedLabel: "1 小时" },
    { hours: 6 as const, expectedLabel: "6 小时" },
    { hours: null, expectedLabel: "一直显示" },
  ])("keeps completed-task display selection $expectedLabel", ({ hours, expectedLabel }) => {
    const next: MocoSettingsView = {
      ...settings,
      blocks: {
        ...settings.blocks,
        executor: { ...settings.blocks.executor, value: { ...settings.blocks.executor.value, completedTaskDisplayHours: hours } },
      },
    };
    const html = renderToStaticMarkup(<ConcurrencyModule settings={next} onSettingsUpdated={update} />);
    const trigger = html.match(/<button\b[^>]*aria-haspopup="listbox"[^>]*>([\s\S]*?)<\/button>/);
    expect(trigger?.[1]).toContain(expectedLabel);
  });

  it.each([
    { watchdogMinutes: undefined, expectedMinutes: "5" },
    { watchdogMinutes: 0, expectedMinutes: "0" },
  ])("keeps the timeout value $expectedMinutes with a missing or disabled setting", ({ watchdogMinutes, expectedMinutes }) => {
    const executor = { ...settings.blocks.executor.value };
    if (watchdogMinutes === undefined) {
      // Older persisted executor settings can omit this field.
      delete (executor as Partial<typeof executor>).watchdogMinutes;
    } else {
      executor.watchdogMinutes = watchdogMinutes;
    }
    const next: MocoSettingsView = {
      ...settings,
      blocks: {
        ...settings.blocks,
        executor: { ...settings.blocks.executor, value: executor },
      },
    };
    const html = renderToStaticMarkup(<ConcurrencyModule settings={next} onSettingsUpdated={update} />);
    const inputs = html.match(/<input\b[^>]*inputMode="numeric"[^>]*>/gi) ?? [];
    expect(inputs).toHaveLength(4);
    expect(inputs[2]).toContain(`value="${expectedMinutes}"`);
  });

  it("shows the settings assistant beside the desktop form and keeps collapse independent of its contents", () => {
    const props = {
      sizeClass: "expanded" as const, leftCollapsed: false, rightCollapsed: false,
      sheet: undefined, onCloseSheet: update, leftLabel: "导航", rightLabel: "辅助",
      leftControl: <span>navigation-toggle</span>, titlebarContent: <h1>设置</h1>,
      rightControl: <span>auxiliary-toggle</span>,
      leftContent: <span>navigation-content</span>, centerContent: <span>main-content</span>,
      rightContent: <span>auxiliary-content</span>,
    };
    const conversation = renderToStaticMarkup(<WorkbenchShell {...props} />);
    const preferences = renderToStaticMarkup(<WorkbenchShell {...props} settingsMode />);
    expect(conversation).toContain("auxiliary-content");
    expect(preferences).toContain("auxiliary-content");
    expect(preferences).toContain("moco-workbench-settings-rail");
    const collapsed = renderToStaticMarkup(<WorkbenchShell {...props} settingsMode rightCollapsed />);
    expect(collapsed).toContain("auxiliary-content");
    const collapsedRail = collapsed.match(/<aside\b[^>]*class="moco-workbench-rail moco-workbench-settings-rail"[^>]*>/)?.[0];
    expect(collapsedRail).toContain('aria-hidden="true"');
    expect(collapsedRail).toContain('inert=""');
    expect(collapsedRail).toContain('data-collapsed="true"');
    const narrow = renderToStaticMarkup(<WorkbenchShell {...props} settingsMode sizeClass="compact" />);
    expect(narrow).not.toContain("auxiliary-content");
    expect(preferences).toContain('data-layout="settings"');
    expect(preferences).toContain("main-content");
  });
});
