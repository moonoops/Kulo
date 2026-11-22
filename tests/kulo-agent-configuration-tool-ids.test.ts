import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigurationDraft, EnvNodeDescriptor, ExternalAgentDetection, KuloSettingsView, SettingsAssistantContext } from "@kulo/protocol";
import { AgentConfigurationDoc, KuloAgentConfiguration, type AgentConfigurationOptions, type AgentConfigurationSaveResult } from "../packages/hub/src/agent-configuration.js";
import { createAgentConfigurationToolsExtension, type AgentConfigurationToolsOptions } from "../packages/hub/src/tools-agent-configuration.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const context: SettingsAssistantContext = { module: "workers", active: true, pageGeneration: 1, appearance: "light", hasUnsavedChanges: false, clientId: "window-a" };

function tools(service: AgentConfigurationToolsOptions["service"]) {
  const extension = createAgentConfigurationToolsExtension({ service, context: async () => context });
  return async <T>(name: string, args: Record<string, unknown>, callId: string): Promise<T> => {
    const tool = extension.tools!.find(item => item.name === `kulo_agent_configuration_${name}`)!;
    const result = await tool.execute(args as never, { conversationId: 1, callId } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
    return JSON.parse(result.output.filter(item => item.type === "text").map(item => item.text).join("\n")) as T;
  };
}

async function fixture() {
  const models = createModels(); models.setProvider(fauxProvider({ provider: "setup", models: [{ id: "chat" }] }).provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "setup", modelId: "chat" } } });
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const settings = { blocks: { roles: { revision: 1, value: {} } } } as KuloSettingsView;
  const env: EnvNodeDescriptor = { id: "local", name: "Mac", kind: "local", online: true, platform: "darwin", arch: "arm64", rootDir: "/tmp/work", capabilities: ["external-agents"], connectedAt: 1, lastSeenAt: 1 };
  const detection: ExternalAgentDetection = { kind: "antigravity", installed: true, executable: "/tmp/agy", authenticated: null, models: [], capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" } };
  const verifyRoundtrip = vi.fn<NonNullable<AgentConfigurationOptions["verifyRoundtrip"]>>(async () => ({ sessionId: "native-session" }));
  const saveRole = vi.fn<AgentConfigurationOptions["saveRole"]>(async input => {
    await harness.commit(async tx => {
      const doc = await tx.doc(AgentConfigurationDoc);
      if (doc.commits[input.operationKey]) return;
      expect(settings.blocks.roles.revision).toBe(input.expectedRevision);
      settings.blocks.roles.value[input.role.id] = structuredClone(input.role);
      settings.blocks.roles.revision += 1;
      doc.commits[input.operationKey] = input.commit;
    }, BACKGROUND_CONTEXT);
    return structuredClone(settings);
  });
  const saveClient = vi.fn<NonNullable<AgentConfigurationOptions["saveClient"]>>(async input => {
    await harness.commit(async tx => {
      const doc = await tx.doc(AgentConfigurationDoc);
      doc.clientCommits ??= {};
      if (doc.clientCommits[input.operationKey]) return;
      settings.externalClients = {
        ...(settings.externalClients ?? {}),
        [input.client.id]: structuredClone(input.client),
      };
      settings.blocks.roles.revision += 1;
      doc.clientCommits[input.operationKey] = input.commit;
    }, BACKGROUND_CONTEXT);
    return structuredClone(settings);
  });
  const removeRole = vi.fn<NonNullable<AgentConfigurationOptions["removeRole"]>>(async input => {
    await harness.commit(async tx => {
      const doc = await tx.doc(AgentConfigurationDoc);
      doc.removals ??= {};
      if (doc.removals[input.operationKey]) return;
      expect(settings.blocks.roles.revision).toBe(input.expectedRevision);
      delete settings.blocks.roles.value[input.agentId];
      settings.blocks.roles.revision += 1;
      doc.removals[input.operationKey] = input.commit;
    }, BACKGROUND_CONTEXT);
    return structuredClone(settings);
  });
  const service = new KuloAgentConfiguration({ harness, settings: () => settings, envs: () => [env],
    request: async () => ({ type: "detection", detection }), verifyRoundtrip, saveRole, saveClient, removeRole, assertContext: async () => {},
  });
  return { service, invoke: tools(service), verifyRoundtrip, saveRole, saveClient, removeRole, settings };
}

describe("external Agent configuration tool call identities", () => {
  it.each(["prepare", "verify", "save", "remove"] as const)("adapts opaque %s call IDs stably while preserving existing plain IDs", async method => {
    const capture = vi.fn(async (_input: { commandId: string }) => ({}));
    const invoke = tools({ [method]: capture } as unknown as AgentConfigurationToolsOptions["service"]);
    const args = { client_kind: "antigravity", env_id: "local", agent_id: "external-test", expected_revision: 1, run_test: true };
    await invoke(method, args, "call_legacy-1:plain");
    await invoke(method, args, "call_shared|fc_first");
    await invoke(method, args, "call_shared|fc_first");
    await invoke(method, args, "call_shared|fc_second");
    const ids = capture.mock.calls.map(([input]) => input.commandId);
    expect(ids[0]).toBe("call_legacy-1:plain");
    expect(ids[1]).toMatch(/^agent-call-[a-f0-9]{64}$/);
    expect(ids[2]).toBe(ids[1]);
    expect(ids[3]).not.toBe(ids[1]);
  });

  it("uses composite IDs through actual service validation and replays paid verification, saving and removal exactly once", async () => {
    const f = await fixture();
    const prepared = await f.invoke<AgentConfigurationDraft>("prepare", { client_kind: "antigravity", env_id: "local", agent_id: "" }, "call_prepare|fc_001");
    expect(await f.invoke("prepare", { client_kind: "antigravity", env_id: "local", agent_id: "" }, "call_prepare|fc_001")).toEqual(prepared);
    const probed = await f.invoke<AgentConfigurationDraft>("probe", { expected_revision: prepared.revision }, "call_probe|fc_002");
    const verifyArgs = { expected_revision: probed.revision, run_test: true };
    const verified = await f.invoke<AgentConfigurationDraft>("verify", verifyArgs, "call_verify|fc_003");
    expect(await f.invoke("verify", verifyArgs, "call_verify|fc_003")).toEqual(verified);
    expect(f.verifyRoundtrip).toHaveBeenCalledTimes(1);
    const saveArgs = { expected_revision: verified.revision };
    const saved = await f.invoke<AgentConfigurationSaveResult>("save", saveArgs, "call_save|fc_004");
    expect(saved.enabled).toBe(true);
    expect(await f.invoke("save", saveArgs, "call_save|fc_004")).toEqual(saved);
    expect(f.saveRole).toHaveBeenCalledTimes(1);
    const removeArgs = { agent_id: saved.agentId, expected_revision: f.settings.blocks.roles.revision };
    const removed = await f.invoke("remove", removeArgs, "call_remove|fc_005");
    expect(await f.invoke("remove", removeArgs, "call_remove|fc_005")).toEqual(removed);
    expect(f.removeRole).toHaveBeenCalledTimes(1);
    expect(f.settings.blocks.roles.value[saved.agentId]).toBeUndefined();
  });

  it("replays one-step connect with opaque call IDs without double-running verification or save", async () => {
    const f = await fixture();
    const scan = await f.invoke<{ candidates: Array<{ kind: string; installed: boolean; alreadyConnected: boolean }> }>("scan", {}, "call_scan|fc_200");
    expect(scan.candidates.some((item) => item.kind === "antigravity" && item.installed && !item.alreadyConnected)).toBe(true);
    const args = { client_kind: "antigravity", env_id: "local", run_test: true };
    const first = await f.invoke<{ clientId: string; agentId?: string; enabled: boolean; verificationLevel: string }>("connect", args, "call_connect|fc_201");
    expect(first).toMatchObject({ clientId: "antigravity:local", enabled: true, verificationLevel: "roundtrip" });
    expect(first.agentId).toBeUndefined();
    expect(await f.invoke("connect", args, "call_connect|fc_201")).toEqual(first);
    expect(f.verifyRoundtrip).toHaveBeenCalledTimes(1);
    expect(f.saveClient).toHaveBeenCalledTimes(1);
    expect(f.saveRole).not.toHaveBeenCalled();
    const afterScan = await f.invoke<{ candidates: Array<{ kind: string; installed: boolean; alreadyConnected: boolean; connectedVerified?: boolean }> }>("scan", {}, "call_scan|fc_202");
    expect(afterScan.candidates.find((item) => item.kind === "antigravity")).toMatchObject({ alreadyConnected: true, connectedVerified: true });
  });

  it("retains strict public client, device and Agent identifier validation", async () => {
    const f = await fixture();
    await expect(f.service.prepare({ clientId: "window|opaque", kind: "antigravity", envId: "local", commandId: "safe-call" })).rejects.toMatchObject({ code: "invalid_agent_configuration_id" });
    await expect(f.invoke("prepare", { client_kind: "antigravity", env_id: "local|device" }, "call_prepare|fc_101")).rejects.toMatchObject({ code: "invalid_agent_configuration_id" });
    await expect(f.invoke("remove", { agent_id: "external|agent", expected_revision: 1 }, "call_remove|fc_102")).rejects.toMatchObject({ code: "invalid_agent_configuration_id" });
    expect(f.verifyRoundtrip).not.toHaveBeenCalled();
  });
});
