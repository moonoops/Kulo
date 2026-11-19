import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { AGENT_TASK_KINDS, EXTERNAL_AGENT_KINDS, type SettingsAssistantContext } from "@kulo/protocol";
import type { AgentConfigurationPatch, KuloAgentConfiguration } from "./agent-configuration.js";

export interface AgentConfigurationToolsOptions {
  service: Pick<KuloAgentConfiguration, "workspace" | "readGuide" | "prepare" | "updateDraft" | "detect" | "probe" | "authenticate" | "verify" | "save" | "remove" | "discard">;
  context: (expectedConversationId?: number) => Promise<SettingsAssistantContext>;
}

function configurationCommandId(callId: string): string {
  // Provider call IDs are opaque; preserve existing public IDs so their durable receipts still replay.
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(callId) && !["constructor", "prototype", "__proto__"].includes(callId)
    ? callId : `agent-call-${createHash("sha256").update(callId).digest("hex")}`;
}

export function createAgentConfigurationToolsExtension(options: AgentConfigurationToolsOptions) {
  const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const scope = async (expectedConversationId?: number) => {
    const captured = await options.context(expectedConversationId);
    if (captured.module !== "workers" || captured.active !== true || !Number.isSafeInteger(captured.pageGeneration) || captured.pageGeneration! < 1) throw new Error("请在智能体设置页面发起外部 Agent 配置。");
    return { clientId: captured.clientId, guard: async () => {
      const current = await options.context(expectedConversationId);
      if (current.clientId !== captured.clientId || current.module !== "workers" || current.active !== true || current.pageGeneration !== captured.pageGeneration || current.target?.kind !== captured.target?.kind || current.target?.id !== captured.target?.id) throw new Error("智能体设置页面或配置目标已切换，请重新发起操作。");
    } };
  };
  return defineExtension({
    name: "kulo-agent-configuration",
    sections: [section("kulo_agent_configuration", async () => { await scope(); return options.service.readGuide(); }, { tag: false })],
    tools: [
      defineTool({ name: "kulo_agent_configuration_read", description: "Read the current window's external Agent draft, connected devices, projects, and saved Agent default dispatch scopes; pass optional `client_kind` to also read that client's bundled local integration guide (Agents Settings page only; never returns credentials).", parameters: obj({ client_kind: opt(oneOf(EXTERNAL_AGENT_KINDS)) }), replay: "safe", execute: async ({ client_kind }, api) => { const s = await scope(Number(api.conversationId)); const workspace = await options.service.workspace(s.clientId, s.guard); return result(client_kind ? { ...workspace, guide: await options.service.readGuide(client_kind) } : workspace); } }),
      defineTool({ name: "kulo_agent_configuration_prepare", description: "Create or resume the current window's external Agent draft on a connected computer (`env_id`); pass `agent_id` when editing a saved external Agent.", parameters: obj({ client_kind: oneOf(EXTERNAL_AGENT_KINDS), env_id: str(), agent_id: opt(str()) }), execute: async (args, api) => { const s = await scope(Number(api.conversationId)); return result(await options.service.prepare({ clientId: s.clientId, kind: args.client_kind, envId: args.env_id, agentId: args.agent_id === "" ? undefined : args.agent_id, commandId: configurationCommandId(api.callId) }, s.guard)); } }),
      defineTool({ name: "kulo_agent_configuration_update", description: "Update an external Agent draft's label, role instructions, default dispatch scope (`default_for: []` = explicit naming only; `project_ids: []` = all projects & ungrouped tasks on bound device), optional `model_id`/`thinking_level` (empty or `auto` uses native client default), and `allow_subagents` (Hub collaboration only; native tools/MCP/permissions remain client-managed; never accepts secrets or arbitrary commands).", parameters: obj({ expected_revision: num(), label: opt(str()), when_to_use: opt(str()), prompt: opt(str()), model_id: opt(str()), thinking_level: opt(str()), allow_subagents: opt(bool()), client_kind: opt(oneOf(EXTERNAL_AGENT_KINDS)), env_id: opt(str()), executable: opt(str()), agent_ref: opt(str()), cdp_url: opt(str()), experimental: opt(bool()), default_for: opt(arr(oneOf(AGENT_TASK_KINDS), { maxItems: AGENT_TASK_KINDS.length })), project_ids: opt(arr(str(), { maxItems: 200 })) }), execute: async (args, api) => {
        const s = await scope(Number(api.conversationId)); const patch: AgentConfigurationPatch = {};
        for (const [source, target] of [["label", "label"], ["when_to_use", "whenToUse"], ["prompt", "prompt"], ["model_id", "modelId"], ["thinking_level", "thinkingLevel"], ["allow_subagents", "allowSubagents"], ["client_kind", "kind"], ["env_id", "envId"], ["executable", "executable"], ["agent_ref", "agentRef"], ["cdp_url", "cdpUrl"], ["experimental", "experimental"]] as const) if (args[source] !== undefined) Object.assign(patch, { [target]: args[source] });
        if (args.default_for !== undefined || args.project_ids !== undefined) patch.dispatchPolicy = { ...(args.default_for !== undefined ? { defaultFor: args.default_for } : {}), ...(args.project_ids !== undefined ? { projectIds: args.project_ids } : {}) };
        return result(await options.service.updateDraft({ clientId: s.clientId, expectedRevision: args.expected_revision, patch }, s.guard));
      } }),
      defineTool({ name: "kulo_agent_configuration_detect", description: "Detect external client installation, version, and public auth status on the bound device after reading the latest draft revision (runs no generation).", parameters: obj({ expected_revision: num() }), replay: "safe", execute: async ({ expected_revision }, api) => { const s = await scope(Number(api.conversationId)); return result(await options.service.detect(s.clientId, expected_revision, s.guard)); } }),
      defineTool({ name: "kulo_agent_configuration_probe", description: "Probe native protocol handshake and declared capabilities without sending a model generation request (protocol success does not prove roundtrip execution).", parameters: obj({ expected_revision: num() }), execute: async ({ expected_revision }, api) => { const s = await scope(Number(api.conversationId)); return result(await options.service.probe(s.clientId, expected_revision, s.guard)); } }),
      defineTool({ name: "kulo_agent_configuration_authenticate", description: "Return device-side native sign-in instructions for the selected client without reading or modifying credentials.", parameters: obj({}), execute: async (_args, api) => { const s = await scope(Number(api.conversationId)); return result(await options.service.authenticate(s.clientId, s.guard)); } }),
      defineTool({ name: "kulo_agent_configuration_verify", description: "With explicit user consent (`run_test: true`), run one minimal live roundtrip nonce check (may consume client quota; verifies message I/O only, not individual native tools).", parameters: obj({ expected_revision: num(), run_test: bool() }), execute: async ({ expected_revision, run_test }, api) => {
        const s = await scope(Number(api.conversationId)); if (!run_test) throw new Error("真实收发测试需要用户明确同意；只检查协议请使用 probe。");
        return result(await options.service.verify({ clientId: s.clientId, expectedRevision: expected_revision, commandId: configurationCommandId(api.callId), runTest: true }, s.guard));
      } }),
      defineTool({ name: "kulo_agent_configuration_save", description: "Save a detected and protocol-probed external Agent (enabled by default only for roundtrip-verified supported drivers; protocol-only or experimental configs save disabled).", parameters: obj({ expected_revision: num() }), execute: async ({ expected_revision }, api) => { const s = await scope(Number(api.conversationId)); return result(await options.service.save({ clientId: s.clientId, expectedRevision: expected_revision, commandId: configurationCommandId(api.callId) }, s.guard)); } }),
      defineTool({ name: "kulo_agent_configuration_remove", description: "Remove a saved external Agent entry on explicit user request (`expected_revision` from `roles` block; leaves native client, sessions, and accounts untouched).", parameters: obj({ agent_id: str(), expected_revision: num() }), execute: async ({ agent_id, expected_revision }, api) => { const s = await scope(Number(api.conversationId)); return result(await options.service.remove({ clientId: s.clientId, agentId: agent_id, expectedRevision: expected_revision, commandId: configurationCommandId(api.callId) }, s.guard)); } }),
      defineTool({ name: "kulo_agent_configuration_cancel", description: "Discard the current window's external Agent configuration draft.", parameters: obj({ expected_revision: num() }), execute: async ({ expected_revision }, api) => { const s = await scope(Number(api.conversationId)); await options.service.discard(s.clientId, expected_revision, s.guard); return result({ discarded: true }); } }),
    ],
  });
}
