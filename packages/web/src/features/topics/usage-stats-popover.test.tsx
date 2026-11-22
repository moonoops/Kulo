import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnvNodeDescriptor, ExternalClientQuotasView, KuloSettingsView } from "@kulo/protocol";
import { describe, expect, it, vi } from "vitest";
import { ExternalQuotasPanel, UsageStatsPopover } from "./usage-stats-popover";

const { forceOpenPopover } = vi.hoisted(() => ({ forceOpenPopover: { current: false } }));

vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const Popover = Object.assign(
    (props: ComponentProps<typeof actual.Popover>) => (
      <div data-mock-popover>{props.children}</div>
    ),
    {
      ...actual.Popover,
      Content: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
        forceOpenPopover.current ? <div data-mock-popover-content className={className}>{children}</div> : null,
      Dialog: ({ children, className, "aria-label": ariaLabel }: { children?: React.ReactNode; className?: string; "aria-label"?: string }) =>
        <div role="dialog" aria-label={ariaLabel} className={className}>{children}</div>,
      Heading: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
        <h2 className={className}>{children}</h2>,
    },
  );
  return { ...actual, Popover };
});

function makeSettings(patch: {
  externalClients?: KuloSettingsView["externalClients"];
  roles?: KuloSettingsView["blocks"]["roles"]["value"];
} = {}): KuloSettingsView {
  return {
    globalRevision: 1,
    ...(patch.externalClients ? { externalClients: patch.externalClients } : {}),
    blocks: {
      presentation: { revision: 1, value: { language: "zh-CN", theme: "dark", showExecutionProcess: false, fontSize: "medium" } as never },
      executor: { revision: 1, value: { maxConcurrentWorkers: 2, maxSubagentsPerTicket: 2 } as never },
      roles: { revision: 1, value: patch.roles ?? {} },
      model: { revision: 1, value: { defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6" } as never, hasApiKey: true },
      identity: { revision: 1, value: { directory: "/tmp" }, effectiveDirectory: "/tmp", directoryRevision: 1 },
      memory: { revision: 1, value: {} as never, hasRouterApiKey: false, hasWorkerApiKey: false },
    },
    history: [],
  };
}

const localEnv: EnvNodeDescriptor = {
  id: "local",
  name: "MacBook Pro",
  kind: "local",
  online: true,
  platform: "darwin",
  arch: "arm64",
  rootDir: "/tmp",
  capabilities: ["external-agents", "external-agent-quota"],
  connectedAt: 1,
  lastSeenAt: 1,
};

describe("UsageStatsPopover (Scheme A)", () => {
  it("keeps the existing single-view layout when no external clients are connected", () => {
    forceOpenPopover.current = true;
    const html = renderToStaticMarkup(
      <UsageStatsPopover settings={makeSettings()} envs={[localEnv]} messagesCount={0} />,
    );
    expect(html).toContain('aria-label="使用统计"');
    expect(html).toContain("使用统计");
    expect(html).not.toContain("外部额度");
    expect(html).toContain("今天");
    expect(html).toContain("7 天");
    expect(html).toContain("30 天");
  });

  it("renders top-level Usage / External quotas tabs when clients exist in externalClients or roles[id].external", () => {
    forceOpenPopover.current = true;
    const viaClients = renderToStaticMarkup(
      <UsageStatsPopover
        settings={makeSettings({
          externalClients: {
            "codex:local": { id: "codex:local", kind: "codex", envId: "local", models: [], updatedAt: 1 },
          },
        })}
        envs={[localEnv]}
        messagesCount={0}
      />,
    );
    expect(viaClients).toContain('role="dialog"');
    expect(viaClients).toContain('aria-label="使用统计"');
    expect(viaClients).toContain("用量");
    expect(viaClients).toContain("外部额度");

    const viaLegacyRole = renderToStaticMarkup(
      <UsageStatsPopover
        settings={makeSettings({
          roles: {
            codex: {
              id: "codex",
              label: "Codex",
              whenToUse: "coding",
              prompt: "code",
              external: { kind: "codex", envId: "local" },
            },
          },
        })}
        envs={[localEnv]}
        messagesCount={0}
      />,
    );
    expect(viaLegacyRole).toContain("外部额度");
  });

  it("keeps trigger aria-label unique when closed", () => {
    forceOpenPopover.current = false;
    const html = renderToStaticMarkup(
      <UsageStatsPopover
        settings={makeSettings({
          externalClients: {
            "codex:local": { id: "codex:local", kind: "codex", envId: "local", models: [], updatedAt: 1 },
          },
        })}
        envs={[localEnv]}
        messagesCount={0}
      />,
    );
    expect(html.match(/aria-label="使用统计"/g)).toHaveLength(1);
  });

  it("renders true 0% ProgressBar, neutral/warning/exhausted chips, degraded states and foreground Disclosure for unsupported ACP clients", () => {
    const now = 1_760_000_000_000;
    const view: ExternalClientQuotasView = {
      serverTime: now,
      softTtlMs: 120_000,
      minRefreshCooldownMs: 15_000,
      items: [
        {
          clientId: "codex:local",
          kind: "codex",
          label: "Codex",
          envId: "local",
          envName: "MacBook Pro",
          deviceOnline: true,
          canRefresh: true,
          status: "ok",
          source: "live",
          fetchedAt: now - 60_000,
          stale: false,
          planLabel: "Plus",
          windows: [
            { id: "codex:primary", label: "5h", usedPercent: 0, windowMinutes: 300, resetsAt: now + 3_600_000, severity: "normal" },
            { id: "codex:secondary", label: "7d", usedPercent: 96, windowMinutes: 10080, resetsAt: now + 86_400_000 * 3, severity: "exhausted" },
          ],
          credits: { hasCredits: true, balanceText: "$12.50" },
        },
        {
          clientId: "claude-code:local",
          kind: "claude-code",
          label: "Claude Code",
          envId: "local",
          envName: "MacBook Pro",
          deviceOnline: true,
          canRefresh: true,
          status: "api_key_billing",
          stale: false,
          windows: [],
        },
        {
          clientId: "grok:remote",
          kind: "grok",
          label: "Grok Build",
          envId: "remote",
          envName: "Mac mini",
          deviceOnline: false,
          canRefresh: false,
          status: "device_offline",
          stale: false,
          windows: [],
        },
        {
          clientId: "antigravity:local",
          kind: "antigravity",
          label: "Antigravity",
          envId: "local",
          envName: "MacBook Pro",
          deviceOnline: true,
          canRefresh: false,
          status: "unsupported",
          stale: false,
          windows: [],
        },
      ],
    };

    const singleDeviceHtml = renderToStaticMarkup(
      <ExternalQuotasPanel
        quotaView={view}
        clockOffsetMs={0}
        loading={false}
        refreshing={false}
        error={null}
        showDeviceName={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(singleDeviceHtml).toContain("Codex");
    expect(singleDeviceHtml).toContain("Plus");
    expect(singleDeviceHtml).toContain('aria-valuenow="0"');
    expect(singleDeviceHtml).toContain('aria-valuenow="96"');
    expect(singleDeviceHtml).toContain("progress-bar--danger");
    expect(singleDeviceHtml).toContain("Credits $12.50");
    expect(singleDeviceHtml).toContain("API 按量");
    expect(singleDeviceHtml).toContain("设备离线");
    expect(singleDeviceHtml).toContain("其他已连接 (1)");
    expect(singleDeviceHtml).toContain("未提供额度接口");
    expect(singleDeviceHtml).not.toContain("MacBook Pro");

    const multiDeviceHtml = renderToStaticMarkup(
      <ExternalQuotasPanel
        quotaView={view}
        clockOffsetMs={0}
        loading={false}
        refreshing={true}
        error={null}
        showDeviceName={true}
        onRefresh={vi.fn()}
      />,
    );
    expect(multiDeviceHtml).toContain("MacBook Pro");
    expect(multiDeviceHtml).toContain("Mac mini");
    expect(multiDeviceHtml).toContain('aria-busy="true"');
    expect(multiDeviceHtml).toContain('data-pending="true"');
    expect(multiDeviceHtml).toContain('aria-disabled="true"');
    expect(multiDeviceHtml).not.toContain('disabled=""');
    expect(multiDeviceHtml).toContain("正在刷新…");
  });
});
