import { renderToStaticMarkup } from "react-dom/server";
import { Select } from "@heroui/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvNodeDescriptor, KuloSettingsView, MemoryServiceSnapshot } from "@kulo/protocol";
import { defaultRolePresets } from "@kulo/protocol";
import { SystemPermissionsModule } from "./system-permissions-module";
import { MemoryConnectionForm, memoryConnectionEditor } from "./memory-service-panel";
import { readMicrophonePermission } from "../system-permissions/system-permissions";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("frontend cross-platform capability convergence", () => {
  it("shows only microphone without macOS warning banner for a local Linux or Windows device", () => {
    vi.spyOn(Select, "Popover").mockImplementation(({ children }) => <>{children}</>);
    const localLinux: EnvNodeDescriptor = {
      id: "linux-local",
      name: "LocalStation",
      kind: "local",
      online: true,
      platform: "linux",
      arch: "x64",
      rootDir: "/home/alice/Kulo",
      capabilities: ["fs", "bash", "worker-isolation"],
      connectedAt: 1,
      lastSeenAt: 1,
    };
    const remoteWin: EnvNodeDescriptor = {
      id: "win-remote",
      name: "WinPC",
      kind: "reverse-ws",
      online: true,
      platform: "win32",
      arch: "x64",
      rootDir: "C:\\Users\\alice\\Kulo",
      capabilities: ["fs", "bash", "worker-isolation-basic"],
      connectedAt: 1,
      lastSeenAt: 1,
    };
    const html = renderToStaticMarkup(
      <SystemPermissionsModule envs={[localLinux, remoteWin]} currentDeviceId="linux-local" />,
    );
    const tableSlice = html.slice(html.indexOf('aria-label="系统权限列表"'));
    expect(tableSlice).toContain("麦克风");
    expect(tableSlice).not.toContain("辅助功能");
    expect(tableSlice).not.toContain("屏幕录制");
    expect(html).not.toContain("不支持 macOS 系统权限检查");
    // Remote non-macOS device has no applicable system permissions, so it is omitted from the selector.
    expect(html).not.toContain("WinPC");
  });

  it("hides the local managed Hindsight section on Windows when not installed, while keeping connection settings", () => {
    const connection = {
      enabled: false,
      endpoint: "http://127.0.0.1:8888",
      endpoints: [],
      caCertPem: "",
      routerApiKeyEnv: "",
      workerApiKeyEnv: "",
      authFile: "",
      autoAttachTopLevelRouters: false,
      banks: { private: "kulo-private", shared: "kulo-shared" },
    };
    const settings: KuloSettingsView = {
      globalRevision: 1,
      blocks: {
        presentation: { revision: 1, value: { agentName: "Kulo", workbenchName: "工作台" } },
        executor: { revision: 1, value: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 } },
        roles: { revision: 1, value: defaultRolePresets() },
        model: { revision: 1, hasApiKey: false, value: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "", thinkingLevel: "off", customProviders: [] } },
        identity: { revision: 1, directoryRevision: 1, effectiveDirectory: "/tmp/identity", value: { directory: "/tmp/identity" } },
        memory: { revision: 1, hasRouterApiKey: false, hasWorkerApiKey: false, value: connection },
      },
      history: [],
    };
    const editor = memoryConnectionEditor(settings.blocks.memory);
    const baseProps = {
      settings,
      editor,
      onChange: vi.fn(),
      onSave: vi.fn(),
      onEnabledChange: vi.fn(),
      onProbe: vi.fn(),
      onDiscard: vi.fn(),
      onReload: vi.fn(),
    };

    const winSnapshot: MemoryServiceSnapshot = {
      revision: 1,
      deviceName: "WinPC",
      platform: "win32",
      installed: false,
      running: false,
      connection,
      jobs: [],
      inputs: [],
    };
    const winHtml = renderToStaticMarkup(<MemoryConnectionForm {...baseProps} snapshot={winSnapshot} />);
    expect(winHtml).toContain("连接配置");
    expect(winHtml).not.toContain("本机服务");
    expect(winHtml).not.toContain("在本机配置 Hindsight");

    const linuxSnapshot: MemoryServiceSnapshot = { ...winSnapshot, deviceName: "LocalStation", platform: "linux" };
    const linuxHtml = renderToStaticMarkup(<MemoryConnectionForm {...baseProps} snapshot={linuxSnapshot} />);
    expect(linuxHtml).toContain("本机服务");
    expect(linuxHtml).toContain("在本机配置 Hindsight");
  });

  it("falls through to Chromium media permissions when desktop bridge reports unsupported on Windows/Linux", async () => {
    const query = vi.fn().mockResolvedValue({ state: "prompt" });
    vi.stubGlobal("window", {
      isSecureContext: true,
      kuloDesktop: {
        systemPermissions: {
          status: vi.fn().mockResolvedValue({ platform: "linux", permissions: [{ kind: "microphone", state: "unsupported" }] }),
          requestMicrophone: vi.fn(),
          openSettings: vi.fn(),
        },
      },
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn() },
      permissions: { query },
    });
    expect(await readMicrophonePermission()).toEqual({ kind: "microphone", state: "not-determined" });
    expect(query).toHaveBeenCalledOnce();
  });
});
