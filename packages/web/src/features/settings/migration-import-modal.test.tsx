import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectionWorkspaceSnapshot,
  MigrationScanResult,
  MigrationStdioPrefill,
  SkillSnapshot,
} from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { ConnectionsModule, mcpConnectionStatus } from "./connections-module";
import { AddAppModal, createDraftFromStdioPrefill } from "./mcp-add-modal";
import {
  isHighRiskStdioFlag,
  MigrationImportBody,
  MigrationImportModal,
  stdioRiskLabel,
} from "./migration-import-modal";
import { SkillsModule } from "./skills-module";

const SAMPLE_SCAN: MigrationScanResult = {
  scanId: "mig-scan-test-1",
  scannedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_600_000,
  localNodeId: "node-local-1",
  currentConnectionCount: 3,
  maxConnections: 256,
  httpMcpCandidates: [
    {
      candidateId: "mig-mcp-http-1",
      source: "antigravity",
      sourceLabel: "Antigravity",
      sourcePath: "~/.gemini/config/mcp_config.json",
      name: "linear-mcp",
      transport: "http",
      hostSummary: "mcp.linear.app",
      inferredAuthMode: "bearer",
      disabledInSource: true,
      importable: true,
      alreadyImported: false,
      hadSecretsStripped: true,
      descriptionSummary: "Linear MCP (credential stripped)",
      pendingItems: [
        { kind: "source_disabled", message: "原配置为禁用状态，导入后将保持禁用，可在连接页手动启用。" },
        { kind: "multiple_auth_headers", message: "原配置包含多个自定义请求头，Kulo 仅支持单个认证请求头，其余需人工核对。", detail: "X-Workspace" },
        { kind: "tool_filters", message: "原配置包含工具过滤规则（allow/deny），Kulo 暂未等价转换，请在导入后核对。", detail: "disabledTools(1: delete_issue)" },
      ],
      riskFlags: ["inline_secret_stripped"],
    },
  ],
  stdioMcpCandidates: [
    {
      candidateId: "mig-mcp-stdio-1",
      source: "claude-code",
      sourceLabel: "Claude Code",
      sourcePath: "~/.claude.json",
      name: "shell-helper",
      transport: "stdio",
      commandSummary: "bash",
      disabledInSource: false,
      importable: false,
      alreadyImported: false,
      hadSecretsStripped: true,
      requiredEnvKeys: ["API_KEY"],
      pendingItems: [],
      riskFlags: ["shell_exec", "pipe_download", "inline_secret_stripped"],
    },
    {
      candidateId: "mig-mcp-stdio-2",
      source: "cursor",
      sourceLabel: "Cursor",
      sourcePath: "~/.cursor/mcp.json",
      name: "npx-runner",
      transport: "stdio",
      commandSummary: "npx",
      disabledInSource: false,
      importable: false,
      alreadyImported: false,
      hadSecretsStripped: false,
      pendingItems: [],
      riskFlags: ["ephemeral_runner"],
    },
  ],
  skillCandidates: [
    {
      candidateId: "mig-skill-1",
      source: "agents-shared",
      sourceLabel: "共享技能 (~/.agents)",
      sourcePath: "~/.agents/skills/generative_ui",
      sourceDevice: "local",
      originalName: "generative_ui",
      normalizedName: "generative-ui",
      nameNormalized: true,
      descriptionSummary: "Interactive UI widgets",
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      fileCount: 3,
      totalBytes: 2048,
      skippedDotfiles: [".gitkeep"],
      conflictWithManaged: false,
      importable: true,
    },
    {
      candidateId: "mig-skill-2",
      source: "codex",
      sourceLabel: "Codex",
      sourcePath: "~/.codex/skills/existing-skill",
      sourceDevice: "local",
      originalName: "existing-skill",
      normalizedName: "existing-skill",
      nameNormalized: false,
      descriptionSummary: "Conflicting skill",
      sha256: "1111111111111111111111111111111111111111111111111111111111111111",
      fileCount: 1,
      totalBytes: 512,
      skippedDotfiles: [],
      conflictWithManaged: true,
      existingSkillId: "existing-skill",
      importable: false,
      blockedReason: "已存在同名 Kulo 托管技能，将保留现有托管版本。",
    },
  ],
  manualNotices: [
    {
      source: "codex",
      sourceLabel: "Codex",
      sourcePath: "~/.codex/config.toml",
      code: "codex_toml_manual",
      message: "检测到 Codex TOML 配置，请参考清单手工添加。",
    },
  ],
};

const EMPTY_CONN_SNAPSHOT: ConnectionWorkspaceSnapshot = {
  connections: [],
  inputs: [],
  requests: [],
  vault: { available: true },
  localHost: true,
};

const EMPTY_SKILL_SNAPSHOT: SkillSnapshot = {
  revision: 1,
  skills: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MigrationImportModal and local discovery entry points", () => {
  it("renders distinct HTTP MCP, Skills snapshot, read-only stdio checklist, and Codex TOML manual notice sections", () => {
    // Modal portal mounts cleanly without throwing
    expect(() =>
      renderToStaticMarkup(
        <MigrationImportModal
          open
          connected
          localHost
          initialScan={SAMPLE_SCAN}
          onPrefillStdio={() => {}}
          onClose={() => {}}
        />,
      ),
    ).not.toThrow();

    const html = renderToStaticMarkup(
      <MigrationImportBody
        localHost
        error={null}
        scanning={false}
        outcomes={null}
        scan={SAMPLE_SCAN}
        initialSection="mcp"
        busy={false}
        selectedMcp={new Set()}
        selectedSkills={new Set()}
        skillAudiences={["worker"]}
        canPrefill
        onToggleMcp={() => {}}
        onToggleSkill={() => {}}
        onChangeSkillAudiences={() => {}}
        onPrefillStdio={() => {}}
      />,
    );

    // 1. HTTP MCP section shows Antigravity disabled state & pending items, with selectable checkbox
    expect(html).toContain("HTTP MCP（无凭据导入）");
    expect(html).toContain("3/256");
    expect(html).toContain("linear-mcp");
    expect(html).toContain("mcp.linear.app");
    expect(html).toContain("原已禁用");
    expect(html).toContain("凭据已剥离");
    expect(html).toContain("X-Workspace");
    expect(html).toContain("disabledTools(1: delete_issue)");
    expect(html).toContain('aria-label="选择导入 linear-mcp"');

    // 2. Skills section defaults to worker audience only (chat unchecked), shows normalized name + sourcePath + sha256
    expect(html).toContain("Skills 快照（默认停用）");
    expect(html).toContain("generative-ui");
    expect(html).toContain("generative_ui → generative-ui");
    expect(html).toContain("~/.agents/skills/generative_ui");
    expect(html).toContain("sha256:abcdef012345");
    expect(html).toContain("后台任务（默认）");
    expect(html).toContain("主聊天（需手动勾选）");
    expect(html).toContain("保留 Kulo 托管版");

    // 3. Local stdio section is strictly read-only: NO selection checkboxes for stdio items, red danger chips, prefill button only
    expect(html).toContain("本地命令 stdio（只读清单 · 不自动执行）");
    expect(html).not.toContain('aria-label="选择导入 shell-helper"');
    expect(html).not.toContain('aria-label="选择导入 npx-runner"');
    expect(html).toContain("高风险 Shell 执行");
    expect(html).toContain("高风险管道下载执行");
    expect(html).toContain("临时包执行 (npx -y / uvx)");
    expect(html).toContain("chip--danger");
    expect(html).toContain('aria-label="预填 shell-helper 手动表单"');
    expect(html).toContain("需手动补填环境变量：API_KEY");

    // 4. Codex TOML manual notice
    expect(html).toContain("~/.codex/config.toml");
    expect(html).toContain("检测到 Codex TOML 配置，请参考清单手工添加。");

    // Risk flag classification helper assertions
    expect(isHighRiskStdioFlag("shell_exec")).toBe(true);
    expect(isHighRiskStdioFlag("pipe_download")).toBe(true);
    expect(isHighRiskStdioFlag("ephemeral_runner")).toBe(true);
    expect(isHighRiskStdioFlag("relative_command")).toBe(true);
    expect(isHighRiskStdioFlag("inline_secret_stripped")).toBe(false);
    expect(stdioRiskLabel("ephemeral_runner")).toContain("npx -y");
  });

  it("exposes secondary entry points only when localHost is true and hides them on remote clients", () => {
    const localConnHtml = renderToStaticMarkup(
      <ConnectionsModule
        snapshot={{ ...EMPTY_CONN_SNAPSHOT, localHost: true }}
        loading={false}
        error={null}
        connected
        onPrepare={async () => {}}
        onRefresh={() => {}}
      />,
    );
    expect(localConnHtml).toContain("从本机导入");

    const remoteConnHtml = renderToStaticMarkup(
      <ConnectionsModule
        snapshot={{ ...EMPTY_CONN_SNAPSHOT, localHost: false }}
        loading={false}
        error={null}
        connected
        onPrepare={async () => {}}
        onRefresh={() => {}}
      />,
    );
    expect(remoteConnHtml).not.toContain("从本机导入");

    const localSkillsHtml = renderToStaticMarkup(
      <SkillsModule
        snapshot={EMPTY_SKILL_SNAPSHOT}
        connected
        localHost
        onRequest={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(localSkillsHtml).toContain("扫描本机技能");

    const remoteSkillsHtml = renderToStaticMarkup(
      <SkillsModule
        snapshot={EMPTY_SKILL_SNAPSHOT}
        connected
        localHost={false}
        onRequest={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(remoteSkillsHtml).not.toContain("扫描本机技能");
  });

  it("displays preserved disabled status for imported HTTP MCP connections", () => {
    const status = mcpConnectionStatus({
      id: "conn-disabled",
      name: "linear-mcp",
      kind: "mcp",
      category: "app",
      mcpTransport: "http",
      url: "https://mcp.linear.app/sse",
      mcpAuthMode: "bearer",
      mcpDisabled: true,
      status: "incomplete",
      hasCredential: false,
      secretFields: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(status.label).toBe("已禁用");
    expect(status.color).toBe("default");
  });

  it("prefills AddAppModal in manual custom stdio mode with boundNodeId and empty env values", () => {
    const prefill: MigrationStdioPrefill = {
      candidateId: "mig-mcp-stdio-1",
      name: "local-tool",
      mcpTransport: "stdio",
      mcpCommand: "node",
      mcpArgs: ["server.js", "--mode=readonly"],
      mcpCwd: "/Users/demo/tools",
      envKeys: ["TOOL_API_KEY"],
      boundNodeId: "node-local-1",
      riskFlags: ["inline_secret_stripped"],
      warnings: ["已剥离原配置中的环境变量值，请在下方手动填写所需凭据。"],
    };

    const draft = createDraftFromStdioPrefill(prefill);
    expect(draft).toMatchObject({
      mcpTransport: "stdio",
      name: "local-tool",
      mcpCommand: "node",
      mcpArgsText: "server.js\n--mode=readonly",
      mcpCwd: "/Users/demo/tools",
      credentialFields: [{ key: "env_0_TOOL_API_KEY", label: "TOOL_API_KEY", value: "" }],
    });

    expect(() =>
      renderToStaticMarkup(
        <AddAppModal
          open
          applications={[]}
          presets={[]}
          existingConnections={[]}
          connected
          vaultAvailable
          localHost
          initialStdioPrefill={prefill}
          onSelectApplication={() => {}}
          onSavedMcp={() => {}}
          onStartOAuth={() => {}}
          onSelectComposio={() => {}}
          onClose={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  it("routes migration REST helpers to POST /api/migration/scan and /api/migration/import", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          url === "/api/migration/scan"
            ? SAMPLE_SCAN
            : { scanId: SAMPLE_SCAN.scanId, importedAt: 1, results: [], summary: { imported: 0, skipped: 0, failed: 0 } },
        ),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const scanRes = await kuloRest.scanLocalMigration();
    expect(scanRes.scanId).toBe(SAMPLE_SCAN.scanId);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/migration/scan",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );

    const importReq = {
      scanId: SAMPLE_SCAN.scanId,
      commandId: "cmd-1",
      mcpCandidateIds: ["mig-mcp-http-1"],
      skillCandidateIds: ["mig-skill-1"],
      skillAudiences: ["worker" as const],
    };
    await kuloRest.importLocalMigration(importReq);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/migration/import",
      expect.objectContaining({ method: "POST", body: JSON.stringify(importReq) }),
    );
  });
});
