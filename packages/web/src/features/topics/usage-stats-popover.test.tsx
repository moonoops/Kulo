import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnvNodeDescriptor, ExternalClientQuotasView, KuloSettingsView } from "@kulo/protocol";
import { describe, expect, it, vi } from "vitest";
import { ExternalQuotasPanel, ExternalQuotasSyncStatus, UsageStatsPopover } from "./usage-stats-popover";

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
    expect(html).not.toContain("外部 Agent");
    expect(html).not.toContain("外部额度");
    expect(html).toContain("今天");
    expect(html).toContain("7 天");
    expect(html).toContain("30 天");
  });

  it("renders top-level Usage / External Agents tabs when clients exist in externalClients or roles[id].external", () => {
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
    expect(viaClients).toContain("外部 Agent");
    expect(viaClients).not.toContain("外部额度");

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
    expect(viaLegacyRole).toContain("外部 Agent");
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

  it("renders unified flat agent rows with explicit used percentages, warnings, buttonless sync status, and trackless --- / --- rows", () => {
    const now = 1_760_000_000_000;
    const view: ExternalClientQuotasView = {
      serverTime: now,
      softTtlMs: 120_000,
      minRefreshCooldownMs: 15_000,
      items: [
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
            { id: "codex:secondary", label: "7d", usedPercent: 86, windowMinutes: 10080, resetsAt: now + 86_400_000 * 3, severity: "warning" },
          ],
          credits: { hasCredits: true, balanceText: "$58134.11" },
        },
        {
          clientId: "claude-code:local",
          kind: "claude-code",
          label: "Claude Code",
          envId: "local",
          envName: "MacBook Pro",
          deviceOnline: true,
          canRefresh: true,
          status: "ok",
          source: "live",
          fetchedAt: now - 30_000,
          stale: false,
          planLabel: "Max",
          windows: [
            { id: "claude:seven_day", label: "7d", usedPercent: 96, windowMinutes: 10080, resetsAt: now + 86_400_000 * 2, severity: "exhausted" },
          ],
          credits: { hasCredits: true, isExtraUsage: true, balanceText: "$3.60 / $20.00", usedPercent: 18 },
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
    expect(singleDeviceHtml).toContain("已用 0%");
    expect(singleDeviceHtml).toContain("已用 86%");
    expect(singleDeviceHtml).toContain("text-warning");
    expect(singleDeviceHtml).toContain("已用 96%");
    expect(singleDeviceHtml).toContain("text-danger");
    expect(singleDeviceHtml).toContain('aria-valuenow="0"');
    expect(singleDeviceHtml).toContain('aria-valuenow="86"');
    expect(singleDeviceHtml).toContain('aria-valuenow="96"');
    expect(singleDeviceHtml).toContain("progress-bar--warning");
    expect(singleDeviceHtml).toContain("progress-bar--danger");
    expect(singleDeviceHtml).toContain("Credits 余额 $58,134.11");
    expect(singleDeviceHtml).toContain("超额已用 $3.60 / $20.00（18%）");
    expect(singleDeviceHtml).toContain("Antigravity");
    expect(singleDeviceHtml).toContain("设备离线");
    expect(singleDeviceHtml).toContain("已用额度");
    expect(singleDeviceHtml).toContain("--- / ---");
    // No Disclosure accordion, no "其他已连接", no "未提供额度接口", no visible refresh button
    expect(singleDeviceHtml).not.toContain("其他已连接");
    expect(singleDeviceHtml).not.toContain("未提供额度接口");
    expect(singleDeviceHtml).not.toContain("disclosure");
    expect(singleDeviceHtml).not.toContain("<button");
    // Only the 3 measurable windows render progressbars (no placeholder track bar for --- / --- rows)
    expect(singleDeviceHtml.match(/role="progressbar"/g)).toHaveLength(3);
    // Ordering: active quota agents first, then unsupported, then offline
    expect(singleDeviceHtml.indexOf("Codex")).toBeLessThan(singleDeviceHtml.indexOf("Antigravity"));
    expect(singleDeviceHtml.indexOf("Antigravity")).toBeLessThan(singleDeviceHtml.indexOf("Grok Build"));
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
    expect(multiDeviceHtml).not.toContain("<button");

    const syncIdleHtml = renderToStaticMarkup(
      <ExternalQuotasSyncStatus
        quotaView={view}
        clockOffsetMs={Date.now() - now}
        loading={false}
        refreshing={false}
      />,
    );
    expect(syncIdleHtml).toContain("刚刚更新");
    expect(syncIdleHtml).not.toContain("<button");

    const syncStaleHtml = renderToStaticMarkup(
      <ExternalQuotasSyncStatus
        quotaView={{ ...view, items: [view.items[1]!] }}
        clockOffsetMs={Date.now() - now}
        loading={false}
        refreshing={false}
      />,
    );
    expect(syncStaleHtml).toContain("1 分钟前");

    const syncRefreshingHtml = renderToStaticMarkup(
      <ExternalQuotasSyncStatus
        quotaView={view}
        clockOffsetMs={0}
        loading={false}
        refreshing={true}
      />,
    );
    expect(syncRefreshingHtml).toContain("更新中…");
    expect(syncRefreshingHtml).toContain("motion-reduce:animate-none");
    expect(syncRefreshingHtml).not.toContain("<button");

    const unsupportedOnlySyncHtml = renderToStaticMarkup(
      <ExternalQuotasSyncStatus
        quotaView={{ ...view, items: [view.items[0]!] }}
        clockOffsetMs={0}
        loading={false}
        refreshing={false}
      />,
    );
    expect(unsupportedOnlySyncHtml).toBe("");

    const initialErrorHtml = renderToStaticMarkup(
      <ExternalQuotasPanel
        quotaView={null}
        clockOffsetMs={0}
        loading={false}
        refreshing={false}
        error="network error"
        showDeviceName={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(initialErrorHtml).toContain("network error");
    expect(initialErrorHtml).toContain("重试");
  });
});
