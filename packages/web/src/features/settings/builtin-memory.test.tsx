import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultRolePresets, type BuiltinMemoryStateView, type KuloSettingsView } from "@kulo/protocol";
import { BuiltinMemorySection } from "./builtin-memory-section";
import { MemoryServicePanel } from "./memory-service-panel";

function makeSettings(hindsightEnabled: boolean): KuloSettingsView {
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
        hasRouterApiKey: false,
        hasWorkerApiKey: false,
        value: {
          enabled: hindsightEnabled,
          endpoint: "http://127.0.0.1:8888",
          endpoints: [],
          caCertPem: "",
          routerApiKeyEnv: "KULO_HINDSIGHT_ROUTER_API_KEY",
          workerApiKeyEnv: "KULO_HINDSIGHT_WORKER_API_KEY",
          authFile: "",
          autoAttachTopLevelRouters: false,
          banks: { private: "kulo-core", shared: "kulo-shared" },
        },
      },
    },
    history: [],
  };
}

describe("BuiltinMemorySection & minimalist MemoryServicePanel", () => {
  it("renders only the switch and clear button with zero exposed memory contents or extra knobs", () => {
    const state: BuiltinMemoryStateView = {
      enabled: true,
      revision: 1,
      clearTargetEpoch: 0,
      appliedClearEpoch: 0,
      engineEpoch: 1,
      clearedAt: null,
      supersededByHindsight: false,
    };
    const html = renderToStaticMarkup(<BuiltinMemorySection connected initialState={state} />);
    expect(html).toContain("内置记忆");
    expect(html).toContain("启用内置记忆");
    expect(html).toContain("清空内置记忆");
    expect(html).toContain("已启用");
    // Strictly 1 switch and 1 button, zero text/number inputs or memory browser/stats
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('inputMode="numeric"');
    expect(html).not.toContain("条记忆");
    expect(html).not.toContain("阈值");
    expect(html).not.toContain("下载模型");
  });

  it("shows Hindsight takeover badge, disables built-in switch, and keeps clear button available when Hindsight is enabled", () => {
    const state: BuiltinMemoryStateView = {
      enabled: true,
      revision: 2,
      clearTargetEpoch: 0,
      appliedClearEpoch: 0,
      engineEpoch: 2,
      clearedAt: null,
      supersededByHindsight: true,
    };
    const html = renderToStaticMarkup(<BuiltinMemorySection connected hindsightEnabled initialState={state} />);
    expect(html).toContain("由 Hindsight 接管");
    const switchInput = html.match(/<input\b[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(switchInput).toContain("disabled");
    const clearBtn = html.match(/<button\b[^>]*>清空内置记忆<\/button>/)?.[0] ?? "";
    expect(clearBtn).not.toContain("disabled");
  });

  it("collapses Hindsight Disclosure by default when Hindsight is disabled and expands when enabled, without hiding inputs from DOM", () => {
    const collapsedHtml = renderToStaticMarkup(
      <MemoryServicePanel settings={makeSettings(false)} onSettingsUpdated={() => {}} />,
    );
    expect(collapsedHtml).toContain("内置记忆");
    expect(collapsedHtml).toContain("Hindsight 记忆服务（高级）");
    expect(collapsedHtml).not.toContain("高级连接设置");
    expect(collapsedHtml).toContain('aria-expanded="false"');
    // Hindsight fields remain mounted in DOM so accessibility & existing DOM contracts hold
    expect(collapsedHtml).toContain("Hindsight 地址");

    const expandedHtml = renderToStaticMarkup(
      <MemoryServicePanel settings={makeSettings(true)} onSettingsUpdated={() => {}} />,
    );
    expect(expandedHtml).toContain('aria-expanded="true"');
    expect(expandedHtml).toContain("由 Hindsight 接管");
  });

  it("P1-7: keeps built-in memory switch enabled during loopback Hindsight failover when server reports supersededByHindsight=false", () => {
    const failoverState: BuiltinMemoryStateView = {
      enabled: true,
      revision: 3,
      clearTargetEpoch: 0,
      appliedClearEpoch: 0,
      engineEpoch: 3,
      clearedAt: null,
      supersededByHindsight: false,
    };
    const html = renderToStaticMarkup(
      <BuiltinMemorySection connected hindsightEnabled initialState={failoverState} />,
    );
    expect(html).not.toContain("由 Hindsight 接管");
    expect(html).toContain("已启用");
    const switchInput = html.match(/<input\b[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(switchInput).not.toContain("disabled");
  });

  it("F-13 & F-14: avoids optimistic Enabled status before load completes and uses h3 for nested Hindsight headings", () => {
    const loadingHtml = renderToStaticMarkup(<BuiltinMemorySection connected />);
    expect(loadingHtml).not.toContain("已启用");
    const switchInput = loadingHtml.match(/<input\b[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(switchInput).toContain("disabled");
    expect(switchInput).not.toContain("checked");
    const clearBtn = loadingHtml.match(/<button\b[^>]*>清空内置记忆<\/button>/)?.[0] ?? "";
    expect(clearBtn).toContain("disabled");

    const panelHtml = renderToStaticMarkup(
      <MemoryServicePanel settings={makeSettings(true)} onSettingsUpdated={() => {}} />,
    );
    expect(panelHtml).toMatch(/<h3\b[^>]*>长期记忆<\/h3>/);
    expect(panelHtml).toMatch(/<h3\b[^>]*>连接配置<\/h3>/);
  });
});
