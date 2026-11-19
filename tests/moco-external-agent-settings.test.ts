import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalAgentBinding, RolePreset } from "@moco/protocol";
import type { MocoModelConfig } from "../packages/hub/src/config";
import { MOCO_GATEWAY_PROVIDER_ID, MOCO_PROVIDER_ID, syncOpenAICompatibleModels } from "../packages/hub/src/models";
import { MocoProviderManager } from "../packages/hub/src/providers";
import { MocoSettingsDoc, SettingsUpdateError, applySettingsBlockUpdate, rollbackSettingsToSnapshot, syncExternalClientsInSettings } from "../packages/hub/src/settings";

const agentId = "external-local-codex";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function nativeRole(): RolePreset {
  return { id: "coder", label: "Coder", whenToUse: "Implementation", prompt: "Work within the task scope.", enabled: true, readOnly: false, allowSubagents: false, thinkingLevel: "auto" };
}

function externalRole(binding: Partial<ExternalAgentBinding> = {}): RolePreset {
  return { ...nativeRole(), id: agentId, label: "Local Codex", external: { kind: "codex", envId: "local", verifiedAt: 1, ...binding } };
}

function settings(external?: RolePreset) {
  const doc = MocoSettingsDoc.definition.initial();
  doc.roles = { coder: nativeRole(), ...(external ? { [agentId]: external } : {}) };
  return doc;
}

function modelConfig(): MocoModelConfig {
  return { baseUrl: "http://127.0.0.1/v1", apiMode: "openai-completions", apiKey: "", defaultProvider: MOCO_GATEWAY_PROVIDER_ID, defaultModel: "pi-main-control", thinkingLevel: "off", contextWindow: 32_000,
    compaction: { enabled: false, reserveTokens: 4_000, keepRecentTokens: 8_000, backgroundTokens: 12_000 }, customProviders: [] };
}

function providerManager() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-external-model-isolation-")); directories.push(stateDir);
  return new MocoProviderManager({ stateDir });
}

describe("external agent settings boundary", () => {
  it("requires the scoped configuration path to create an external role", () => {
    const doc = settings(); const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: externalRole() }))
      .toThrow("请通过右侧对话连接外部智能体");
    expect(doc).toEqual(before);
  });

  it.each(["edit", "remove", "convert", "enable"])("prevents ordinary role updates from changing an external role: %s", (operation) => {
    const doc = settings({ ...externalRole({ verifiedAt: undefined }), enabled: false }); const before = structuredClone(doc);
    const next: Record<string, RolePreset> = structuredClone(doc.roles);
    if (operation === "remove") delete next[agentId];
    else if (operation === "convert") delete next[agentId]!.external;
    else if (operation === "enable") next[agentId]!.enabled = true;
    else next[agentId]!.label = "Changed outside setup";
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, next)).toThrow("外部智能体请通过智能体页面右侧对话修改");
    expect(doc).toEqual(before);
  });

  it("allows ordinary native-role edits while preserving the exact external binding", () => {
    const role = externalRole(); const doc = settings(role); const revision = doc.revisions.roles;
    applySettingsBlockUpdate(doc, "roles", revision, { ...doc.roles, coder: { ...doc.roles.coder, label: "Builder" } });
    expect(doc.roles[agentId]).toEqual(role); expect(doc.roles.coder?.label).toBe("Builder");
    expect(doc.revisions.roles).toBe(revision + 1);
  });

  it.each(["codex", "claude-code", "antigravity", "dsh"] as const)("saves verified %s bindings through the scoped path with native models", (kind) => {
    const doc = settings(); const opaqueModel = '["native-provider","gpt-image-1"]';
    const role = { ...externalRole({ kind }), provider: "unconfigured-pi-provider", modelId: opaqueModel, thinkingLevel: "auto" as const };
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: role }, { externalAgents: true });
    expect(doc.roles[agentId]).toMatchObject({ enabled: true, external: { kind, envId: "local", verifiedAt: 1 }, modelId: opaqueModel });
    expect(doc.roles[agentId]?.provider).toBeUndefined();
    expect(doc.roles[agentId]?.allowSubagents).toBe(false);
  });

  it.each([undefined, null, "now", Number.NaN, Number.POSITIVE_INFINITY])("rejects enabled connections without finite roundtrip evidence: %s", (verifiedAt) => {
    const doc = settings(); const before = structuredClone(doc);
    const role = externalRole({ verifiedAt: verifiedAt as number });
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: role }, { externalAgents: true }))
      .toThrow(SettingsUpdateError);
    expect(doc).toEqual(before);
  });

  it("can store a protocol-only connection disabled without removing the enabled native worker", () => {
    const doc = settings(); const role = { ...externalRole({ verifiedAt: undefined }), enabled: false };
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: role }, { externalAgents: true });
    expect(doc.roles[agentId]).toMatchObject({ enabled: false, external: { kind: "codex", envId: "local" } });
    expect(doc.roles[agentId]?.external?.verifiedAt).toBeUndefined(); expect(doc.roles.coder?.enabled).toBe(true);
  });

  it.each(["grok-bot", "dots", "muse"] as const)("cannot enable %s even with a verification timestamp", (kind) => {
    const doc = settings(); const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: externalRole({ kind, experimental: true }) }, { externalAgents: true }))
      .toThrow("不能启用自动派发");
    expect(doc).toEqual(before);
  });

  it.each([
    { kind: "cloud-agent" },
    { envId: "" },
    { envId: " " },
    { envId: 1 },
    { envId: "x".repeat(201) },
    { apiKey: "unaccepted-field" },
    { command: "codex --unsafe" },
    { executable: "codex --unsafe" },
    { executable: "/usr/local/bin/codex\n--unsafe" },
    { executable: "" },
    { executable: 0 },
    { experimental: "yes" },
    { agentRef: 1 },
    { agentRef: " " },
    { agentRef: "x".repeat(201) },
    { agentRef: "bot\nother-command" },
    { version: {} },
    { version: "x".repeat(201) },
    { version: "1.0\nextra-data" },
    { verifiedAt: 0 },
    { verifiedAt: -1 },
    { capabilities: null },
    { capabilities: [] },
    { capabilities: {} },
    { capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native", apiKey: "unaccepted-field" } },
    { capabilities: { resume: "yes", cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" } },
    { capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "complete" } },
  ])("rejects malformed or out-of-contract connection fields: %j", (binding) => {
    const doc = settings(); const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: externalRole(binding as Partial<ExternalAgentBinding>) }, { externalAgents: true }))
      .toThrow(SettingsUpdateError);
    expect(doc).toEqual(before);
  });

  it.each([
    "http://remote.example:9333/",
    "http://127.0.0.1:9333/private",
    "http://user:password@127.0.0.1:9333/",
    "http://127.0.0.1:9333/?token=must-not-persist",
    "http://127.0.0.1:9333/#fragment",
    "https://127.0.0.1:9333/",
    "ws://127.0.0.1:9333/",
    "http://localhost:9333/",
  ])("rejects a CDP endpoint outside the literal loopback HTTP origin contract: %s", (cdpUrl) => {
    const doc = settings(); const before = structuredClone(doc);
    const role = { ...externalRole({ kind: "grok-bot", experimental: true, cdpUrl }), enabled: false };
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: role }, { externalAgents: true }))
      .toThrow(SettingsUpdateError);
    expect(doc).toEqual(before);
  });

  it("allows CDP only on the Grok experimental binding", () => {
    const doc = settings(); const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: externalRole({ cdpUrl: "http://127.0.0.1:9333/" }) }, { externalAgents: true }))
      .toThrow(SettingsUpdateError);
    expect(doc).toEqual(before);
  });

  it.each(["http://127.0.0.1:9333/", "http://[::1]:9333/"])("stores an explicitly disabled experimental Grok origin: %s", (cdpUrl) => {
    const doc = settings();
    const role = { ...externalRole({ kind: "grok-bot", verifiedAt: undefined, experimental: true, cdpUrl, agentRef: "moco-dedicated-bot" }), enabled: false };
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: role }, { externalAgents: true });
    expect(doc.roles[agentId]).toMatchObject({ enabled: false, external: { cdpUrl, agentRef: "moco-dedicated-bot", experimental: true } });
  });

  it("preserves exactly typed capabilities advertised by the native driver", () => {
    const doc = settings();
    const capabilities = { resume: true, cancel: true, models: false, permissions: true, collaboration: false, terminalEvidence: "observed" as const };
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: externalRole({ capabilities }) }, { externalAgents: true });
    expect(doc.roles[agentId]?.external?.capabilities).toEqual(capabilities);
  });

  it.each(["/usr/local/bin/codex", "C:\\Apps\\Codex\\codex.exe"])("accepts a fixed absolute executable path: %s", (executable) => {
    const doc = settings();
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: externalRole({ executable }) }, { externalAgents: true });
    expect(doc.roles[agentId]?.external?.executable).toBe(executable);
  });

  it("keeps role CAS and the enabled-worker invariant on scoped external writes", () => {
    const doc = settings(); const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles - 1, { ...doc.roles, [agentId]: externalRole() }, { externalAgents: true }))
      .toThrow("已被其他操作更新");
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { [agentId]: { ...externalRole(), enabled: false } }, { externalAgents: true }))
      .toThrow("至少需要保留一个启用状态的 Worker");
    expect(doc).toEqual(before);
  });

  it("allows the scoped path to remove a configured external role", () => {
    const doc = settings(externalRole());
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { coder: doc.roles.coder }, { externalAgents: true });
    expect(doc.roles[agentId]).toBeUndefined(); expect(doc.roles.coder?.enabled).toBe(true);
  });

  it("preserves and normalizes external default metadata through the trusted settings path", () => {
    const doc = settings();
    const role = { ...externalRole(), dispatchPolicy: { defaultFor: ["coding", "review", "coding"], projectIds: ["project-b", "project-a", "project-b"] } };
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: role }, { externalAgents: true });
    expect(doc.roles[agentId]?.dispatchPolicy).toEqual({ defaultFor: ["coding", "review"], projectIds: ["project-a", "project-b"] });
    expect(doc.roles[agentId]?.external?.verifiedAt).toBe(1);
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: { ...doc.roles[agentId], dispatchPolicy: { defaultFor: [] } } }, { externalAgents: true });
    expect(doc.roles[agentId]?.dispatchPolicy).toBeUndefined(); expect(doc.roles[agentId]?.enabled).toBe(true);
  });

  it("does not let generic role updates modify the saved default policy", () => {
    const role = { ...externalRole(), dispatchPolicy: { defaultFor: ["coding"] as const } };
    const doc = settings(role as RolePreset); const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: { ...doc.roles[agentId], dispatchPolicy: { defaultFor: ["review"] } } }))
      .toThrow("外部智能体请通过智能体页面右侧对话修改");
    expect(doc).toEqual(before);
  });

  it.each([{ defaultFor: [] }, { defaultFor: ["coding"] }])("rejects default metadata on internal workers: %j", (dispatchPolicy) => {
    const doc = settings(); const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { coder: { ...doc.roles.coder, dispatchPolicy } }, { externalAgents: true }))
      .toThrow("仅适用于外部智能体");
    expect(doc).toEqual(before);
  });

  it.each([null, [], {}, { defaultFor: "coding" }, { defaultFor: ["unknown-task"] }, { defaultFor: ["coding"], projectIds: ["../untrusted"] }, { defaultFor: ["coding"], overwrite: true }])("rejects malformed default policies atomically: %j", (dispatchPolicy) => {
    const doc = settings(); const before = structuredClone(doc);
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, [agentId]: { ...externalRole(), dispatchPolicy } }, { externalAgents: true }))
      .toThrow(SettingsUpdateError);
    expect(doc).toEqual(before);
  });

  it.each([undefined, ["project-a"]])("rejects equally specific duplicate defaults including disabled agents: %j", (projectIds) => {
    const policy = { defaultFor: ["coding"], ...(projectIds ? { projectIds } : {}) };
    const first = { ...externalRole({ verifiedAt: undefined }), enabled: false, dispatchPolicy: policy };
    const doc = settings(first as RolePreset); const before = structuredClone(doc);
    const second = { ...externalRole({ kind: "claude-code" }), dispatchPolicy: policy };
    expect(() => applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles, "external-second": second }, { externalAgents: true }))
      .toThrow(SettingsUpdateError);
    expect(doc).toEqual(before);
  });

  it("allows project-specific overrides and defaults on other devices without changing the original policy", () => {
    const doc = settings({ ...externalRole(), dispatchPolicy: { defaultFor: ["coding"] } });
    const original = structuredClone(doc.roles[agentId]);
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { ...doc.roles,
      "external-project": { ...externalRole(), dispatchPolicy: { defaultFor: ["coding"], projectIds: ["project-a"] } },
      "external-other": { ...externalRole({ envId: "other-computer" }), dispatchPolicy: { defaultFor: ["coding"] } },
    }, { externalAgents: true });
    expect(doc.roles[agentId]).toEqual(original);
    expect(doc.roles["external-project"]?.dispatchPolicy?.projectIds).toEqual(["project-a"]);
    expect(doc.roles["external-other"]?.external?.envId).toBe("other-computer");
  });

  it("excludes native external model IDs when syncing the gateway provider", () => {
    const manager = providerManager(); const nativeModel = '["dsh-provider","native-model-not-in-pi"]';
    manager.syncProviders(modelConfig(), { coder: { ...nativeRole(), modelId: "pi-worker-control" }, [agentId]: { ...externalRole({ kind: "dsh" }), modelId: nativeModel } });
    const ids = manager.models.getModels(MOCO_GATEWAY_PROVIDER_ID).map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining(["pi-main-control", "pi-worker-control"]));
    expect(ids).not.toContain(nativeModel);
  });

  it("does not mark a builtin model configured solely because an external role uses the same native identifier", async () => {
    const manager = providerManager(); const id = manager.models.getModels("anthropic")[0]!.id;
    manager.syncProviders(modelConfig(), { coder: { ...nativeRole(), provider: "anthropic", modelId: id } });
    expect((await manager.getProviderCatalogItem("anthropic")).configuredModels?.map((model) => model.id)).toContain(id);
    manager.syncProviders(modelConfig(), { [agentId]: { ...externalRole(), provider: "anthropic", modelId: id } });
    const catalog = await manager.getProviderCatalogItem("anthropic");
    expect(catalog.configuredModels).toEqual([]); expect(catalog.models).toEqual([]);
  });

  it("keeps external native models outside the legacy OpenAI-compatible registry", () => {
    const models = createModels(); const nativeModel = '["dsh-provider","native-model-not-in-pi"]';
    const roles = { coder: { ...nativeRole(), modelId: "pi-worker-control" }, [agentId]: { ...externalRole({ kind: "dsh" }), modelId: nativeModel } };
    syncOpenAICompatibleModels(models, modelConfig, () => roles);
    const ids = models.getModels(MOCO_PROVIDER_ID).map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining(["pi-main-control", "pi-worker-control"]));
    expect(ids).not.toContain(nativeModel);
  });

  it("supports creating, editing, toggling and deleting multiple agent personas under a connected external client without re-verifying", () => {
    const doc = settings(externalRole({ executable: "/usr/local/bin/codex", verifiedAt: 42 }));
    syncExternalClientsInSettings(doc, {
      "codex:local": [
        { id: "astra", name: "Astra", efforts: ["low", "medium", "high"], isDefault: true },
        { id: "sol", name: "Sol", efforts: ["low", "medium"] },
      ],
    });
    expect(doc.externalClients?.["codex:local"]?.models).toHaveLength(2);

    const architect: RolePreset = {
      id: "codex-architect",
      label: "架构师",
      whenToUse: "负责模块架构拆解与技术方案评审",
      prompt: "输出清晰的架构边界与演进步骤。",
      enabled: true,
      modelId: "astra",
      thinkingLevel: "high",
      externalClientId: "codex:local",
    };
    const tester: RolePreset = {
      id: "codex-tester",
      label: "测试员",
      whenToUse: "负责编写回归单测与边界用例验证",
      prompt: "补充高价值测试并验证通过。",
      enabled: true,
      modelId: "sol",
      thinkingLevel: "medium",
      externalClientId: "codex:local",
    };

    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, {
      ...doc.roles,
      [architect.id]: architect,
      [tester.id]: tester,
    });
    expect(doc.roles["codex-architect"]).toMatchObject({
      label: "架构师",
      modelId: "astra",
      thinkingLevel: "high",
      externalClientId: "codex:local",
      external: { kind: "codex", envId: "local", executable: "/usr/local/bin/codex", verifiedAt: 42 },
    });
    expect(doc.roles["codex-tester"]).toMatchObject({
      label: "测试员",
      modelId: "sol",
      thinkingLevel: "medium",
      externalClientId: "codex:local",
      external: { kind: "codex", envId: "local", executable: "/usr/local/bin/codex", verifiedAt: 42 },
    });

    // Deleting all external personas keeps the underlying ExternalClientConnection registered
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, { coder: doc.roles.coder });
    expect(doc.roles["codex-architect"]).toBeUndefined();
    expect(doc.roles["codex-tester"]).toBeUndefined();
    expect(doc.externalClients?.["codex:local"]?.verifiedAt).toBe(42);

    // Explicit client disconnection removes the ExternalClientConnection and supports snapshot rollback
    const revBeforeDisconnect = doc.globalRevision;
    applySettingsBlockUpdate(doc, "roles", doc.revisions.roles, {
      coder: { ...doc.roles.coder!, thinkingLevel: "" },
    }, { externalAgents: true, removeClientIds: ["codex:local"] });
    expect(doc.externalClients).toBeUndefined();
    expect(doc.roles.coder?.thinkingLevel).toBe("auto");

    rollbackSettingsToSnapshot(doc, revBeforeDisconnect, doc.globalRevision);
    expect(doc.externalClients?.["codex:local"]?.verifiedAt).toBe(42);
  });
});
