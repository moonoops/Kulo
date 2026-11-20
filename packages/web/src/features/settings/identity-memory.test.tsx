import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultRolePresets, type KuloSettingsView } from "@kulo/protocol";
import { IdentityModule } from "./identity-module";
import { RelationshipUpdateControls, type PersonalityControls } from "./personality-controls";

function memorySettings(hasRouterApiKey: boolean, hasWorkerApiKey: boolean): KuloSettingsView {
  return {
    globalRevision: 1,
    blocks: {
      presentation: { revision: 1, value: { agentName: "Kulo", workbenchName: "Kulo's table" } },
      executor: { revision: 1, value: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 } },
      roles: { revision: 1, value: defaultRolePresets() },
      model: { revision: 1, hasApiKey: false, value: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "test-model", thinkingLevel: "off", customProviders: [] } },
      identity: { revision: 1, directoryRevision: 1, effectiveDirectory: "/tmp/identity", value: { directory: "/tmp/identity" } },
      memory: {
        revision: 1,
        hasRouterApiKey,
        hasWorkerApiKey,
        value: {
          enabled: false,
          endpoint: "http://127.0.0.1:9",
          endpoints: [],
          caCertPem: "",
          routerApiKeyEnv: "KULO_HINDSIGHT_ROUTER_API_KEY",
          workerApiKeyEnv: "KULO_HINDSIGHT_WORKER_API_KEY",
          authFile: "",
          autoAttachTopLevelRouters: false,
          banks: { private: "private", shared: "shared" },
        },
      },
    },
    history: [],
  };
}

describe("memory credential fields", () => {
  it("does not expose the retired workbench-name setting", () => {
    const html = renderToStaticMarkup(<IdentityModule settings={memorySettings(false, false)} onSettingsUpdated={() => {}} />);
    expect(html).not.toContain("工作台名称");
    expect(html).not.toContain("Kulo&#x27;s table");
    expect(html).not.toContain("Kulo's table");
  });

  it("keeps persisted credentials out of the left connection form", () => {
    const settings = memorySettings(true, true);
    Object.assign(settings.blocks.memory.value, {
      routerApiKey: "router-credential-sentinel",
      workerApiKey: "worker-credential-sentinel",
      sharedReadApiKey: "reader-credential-sentinel",
    });
    const html = renderToStaticMarkup(<IdentityModule settings={settings} onSettingsUpdated={() => {}} />);
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain("公开目录密钥");
    expect(html).not.toContain("主脑密钥");
    expect(html).not.toContain("Worker 密钥");
    expect(html).toContain("已保存");
    for (const secret of ["router-credential-sentinel", "worker-credential-sentinel", "reader-credential-sentinel"]) expect(html).not.toContain(secret);
    expect(html).toContain("Hindsight 地址");
    expect(html).toContain("测试连接");
  });

  it("offers setup before a connection is configured", () => {
    const html = renderToStaticMarkup(<IdentityModule settings={memorySettings(false, false)} onSettingsUpdated={() => {}} />);
    expect(html).toContain("在本机配置 Hindsight");
    expect(html).toContain("Hindsight 地址");
    expect(html).not.toContain("断开连接");
    expect(html).not.toContain("卸载本机服务");
  });

  it("keeps four modules mounted and hides the interval while relationship maintenance is off", () => {
    const html = renderToStaticMarkup(<IdentityModule settings={memorySettings(false, false)} onSettingsUpdated={() => {}} />);
    for (const label of ["身份约定", "协作关系", "长期记忆", "近期工作"]) expect(html).toContain(label);
    expect(html).toContain('aria-label="记忆视图"');
    expect(html.match(/data-inert="true"/g)).toHaveLength(3);
    const switches = html.match(/<(?:input|button)\b[^>]*role="switch"[^>]*>/g) ?? [];
    const relationship = switches.find((input) => input.includes('aria-label="自动更新协作关系"'));
    expect(relationship).toBeDefined();
    expect(relationship).not.toContain('aria-checked="true"');
    expect(relationship).not.toContain('checked=""');
    const interval = (html.match(/<input\b[^>]*>/g) ?? []).find((input) => input.includes('inputMode="numeric"'));
    expect(interval).toBeUndefined();
    expect(html).not.toContain("更新间隔");
    expect(html).not.toContain('aria-label="未保存的更改"');
    expect(html).toContain('value="Kulo"');
    expect(html).not.toContain("执行时间");
    expect(html).not.toContain('type="time"');
    expect(html).not.toContain("未检查");
    expect(html).toContain('aria-label="近期工作摘要"');
    expect(html).toContain('readOnly=""');
    expect(html).not.toContain("当前重心");
  });

  it("keeps primary and backup connection addresses editable in the left form", () => {
    const settings = memorySettings(true, true);
    settings.blocks.memory.value.endpoints = ["https://backup-one.example", "https://backup-two.example"];
    const html = renderToStaticMarkup(<IdentityModule settings={settings} onSettingsUpdated={() => {}} />);
    const connectionFormHtml = html.match(/<form\b[^>]*aria-label="长期记忆连接设置"[\s\S]*?<\/form>/)?.[0] ?? "";
    for (const label of ["Hindsight 地址", "主地址", "备用地址 1", "备用地址 2", "隐私记忆库名", "共享记忆库名"]) expect(connectionFormHtml).toContain(label);
    expect(connectionFormHtml.match(/type="url"/g)).toHaveLength(3);
    expect(html).not.toContain("高级连接设置");
    expect(html).not.toContain("CA 证书");
    expect(html.indexOf("https://backup-two.example")).toBeLessThan(html.indexOf("公开目录密钥"));
    expect(html.indexOf("http://127.0.0.1:9")).toBeLessThan(html.indexOf("https://backup-one.example"));
    expect(html.indexOf("https://backup-one.example")).toBeLessThan(html.indexOf("https://backup-two.example"));
    expect(html).toContain('type="url"');
    expect(html).not.toContain("连接已有服务");
    expect(html).not.toContain("测试已保存配置");
    expect(html).not.toContain('name="routerApiKey"');
  });

  it("keeps update history metadata out of the relationship settings even after a completed check", () => {
    const noop = () => {};
    const asyncNoop = async () => {};
    const asyncSaved = async () => true;
    const controls: PersonalityControls = {
      snapshot: {
        revision: 2,
        settings: { relationshipUpdate: { enabled: true, intervalDays: 1 }, recentWorkEnabled: true },
        relationshipStatus: { lastCheckedAt: 1_700_000_000_000, lastUpdatedAt: 1_700_000_000_000, nextRunAt: 1_700_086_400_000, lastResult: "unchanged" },
        identityProposal: null,
      },
      schedule: { enabled: true, intervalDays: 1 },
      setSchedule: noop,
      loading: false, error: undefined, conflict: false, saving: false, savingField: null, dirty: false,
      recent: null, recentLoading: false, recentError: undefined,
      refresh: asyncNoop, loadRecent: asyncNoop, saveSchedule: asyncSaved, setRelationshipEnabled: asyncSaved, setRecentEnabled: asyncSaved,
      retryRelationship: asyncSaved, retryRecent: asyncSaved, dismissProposal: asyncNoop, discard: noop, reload: asyncNoop,
    };
    const html = renderToStaticMarkup(<RelationshipUpdateControls controls={controls} />);
    expect(html).toContain("自动更新");
    expect(html).toContain("更新间隔");
    expect(html).toContain("天");
    expect(html.match(/inputMode="numeric"/g)).toHaveLength(1);
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="未保存的更改"');
    for (const text of ["执行时间", "未检查", "无需更新", "下次", "UTC", "Asia/Shanghai"]) expect(html).not.toContain(text);
    expect(html).not.toContain('role="status"');
  });
});
