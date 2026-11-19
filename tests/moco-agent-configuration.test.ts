import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvNodeDescriptor, ExternalAgentDetection, MocoSettingsView } from "@moco/protocol";
import { AgentConfigurationDoc, MocoAgentConfiguration, type AgentConfigurationOptions } from "../packages/hub/src/agent-configuration";
import { SettingsAssistant, SettingsAssistantDoc } from "../packages/hub/src/settings-assistant";

const cleanup: Array<() => Promise<void>> = [];
const secret = "test-only-native-secret-42";
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const models = createModels(); models.setProvider(fauxProvider({ provider: "setup", models: [{ id: "chat" }] }).provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "setup", modelId: "chat" } } });
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const state = { active: true, committed: 0, failAfterCommit: false, settings: { blocks: { roles: { revision: 1, value: {} } } } as MocoSettingsView };
  const env: EnvNodeDescriptor = { id: "local", name: "Work Mac", kind: "local", online: true, platform: "darwin", arch: "arm64", rootDir: "/tmp/work", capabilities: ["fs", "bash"], connectedAt: 1, lastSeenAt: 1 };
  const projects = [{ id: "project-local", name: "Local project", envId: "local" }, { id: "project-remote", name: "Other computer project", envId: "other-computer" }];
  const listProjects = vi.fn<NonNullable<AgentConfigurationOptions["projects"]>>(async () => structuredClone(projects));
  const detection: ExternalAgentDetection = { kind: "codex", installed: true, executable: "/usr/local/bin/codex", version: "1.0.0", authenticated: null, models: [], capabilities: { resume: true, cancel: true, models: true, permissions: true, collaboration: true, terminalEvidence: "native" } };
  const request = vi.fn<AgentConfigurationOptions["request"]>(async (_envId, input) => ({ type: "detection", detection: { ...detection, kind: input.operation === "detect" ? input.kind : input.operation === "probe" ? input.binding.kind : "codex" } }));
  const verifyRoundtrip = vi.fn<NonNullable<AgentConfigurationOptions["verifyRoundtrip"]>>(async () => ({ sessionId: "native-session", version: "1.0.0" }));
  const saveRole = vi.fn<AgentConfigurationOptions["saveRole"]>(async (input) => {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(AgentConfigurationDoc); if (doc.commits[input.operationKey]) return;
      if (state.settings.blocks.roles.revision !== input.expectedRevision) throw new Error("stale roles");
      state.settings.blocks.roles.value[input.role.id] = structuredClone(input.role);
      state.settings.blocks.roles.revision += 1; state.committed += 1;
      doc.commits[input.operationKey] = input.commit;
    }, BACKGROUND_CONTEXT);
    if (state.failAfterCommit) { state.failAfterCommit = false; throw new Error("apply failed after durable commit"); }
    return structuredClone(state.settings);
  });
  const removeRole = vi.fn<NonNullable<AgentConfigurationOptions["removeRole"]>>(async (input) => {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(AgentConfigurationDoc); doc.removals ??= {}; if (doc.removals[input.operationKey]) return;
      if (state.settings.blocks.roles.revision !== input.expectedRevision) throw new Error("stale roles");
      delete state.settings.blocks.roles.value[input.agentId]; state.settings.blocks.roles.revision += 1; doc.removals[input.operationKey] = input.commit;
    }, BACKGROUND_CONTEXT);
    if (state.failAfterCommit) { state.failAfterCommit = false; throw new Error("remove apply failed after durable commit"); }
    return structuredClone(state.settings);
  });
  const options: AgentConfigurationOptions = { harness, settings: () => state.settings, envs: () => [env], projects: listProjects, request, verifyRoundtrip, saveRole, removeRole, assertContext: async () => { if (!state.active) throw new Error("inactive page"); }, redact: (value) => value.split(secret).join("[hidden]") };
  const service = new MocoAgentConfiguration(options);
  const prepare = () => service.prepare({ clientId: "window-a", kind: "codex", envId: "local" });
  const probed = async () => { const draft = await prepare(); return service.probe(draft.clientId, draft.revision); };
  return { harness, state, options, service, env, projects, listProjects, detection, request, verifyRoundtrip, saveRole, removeRole, prepare, probed };
}

describe("external agent configuration", () => {
  it("keeps separate durable drafts and defaults collaboration off and native model unset", async () => {
    const f = await fixture(); const draft = await f.prepare();
    expect(draft).toMatchObject({ label: "Codex · Work Mac", allowSubagents: false, binding: { kind: "codex", envId: "local" } });
    expect(draft.modelId).toBeUndefined();
    expect(draft.thinkingLevel).toBeUndefined();
    expect(draft.dispatchPolicy).toBeUndefined();
    expect((await f.service.workspace("window-b")).draft).toBeUndefined();
    expect((await new MocoAgentConfiguration(f.options).workspace("window-a")).draft).toEqual(draft);
    expect(await f.prepare()).toEqual(draft);
    await expect(f.service.prepare({ clientId: "window-a", kind: "claude-code", envId: "local" })).rejects.toMatchObject({ code: "agent_draft_exists" });
  });

  it("uses native model identifiers without Pi provider validation and invalidates launch evidence", async () => {
    const f = await fixture(); let draft = await f.probed();
    expect(draft.verification?.level).toBe("protocol");
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { modelId: '["deepseek-route","native-model"]', allowSubagents: true } });
    expect(draft.modelId).toBe('["deepseek-route","native-model"]'); expect(draft.verification).toBeUndefined(); expect(draft.detection).toBeUndefined();
    await expect(f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision - 1, patch: { label: "stale" } })).rejects.toMatchObject({ code: "agent_configuration_conflict" });
  });

  it.each(["", "auto", " auto "])("omits native-default model and thinking fields from saved roles: %j", async (thinkingLevel) => {
    const f = await fixture(); let draft = await f.probed();
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { modelId: "", thinkingLevel } });
    expect(draft.modelId).toBeUndefined(); expect(draft.thinkingLevel).toBeUndefined(); expect(draft.verification?.level).toBe("protocol");
    const saved = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "native-default-save" });
    const role = f.state.settings.blocks.roles.value[saved.agentId]!;
    expect(Object.hasOwn(role, "modelId")).toBe(false); expect(Object.hasOwn(role, "thinkingLevel")).toBe(false);
    expect(f.verifyRoundtrip).not.toHaveBeenCalled();
  });

  it("persists public native thinking identifiers and includes the choice in I/O verification", async () => {
    const f = await fixture(); let draft = await f.prepare();
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { thinkingLevel: "native.high:2" } });
    draft = await f.service.probe(draft.clientId, draft.revision);
    draft = await f.service.verify({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "native-thinking-test", runTest: true });
    expect(f.verifyRoundtrip.mock.calls[0]?.[0].thinkingLevel).toBe("native.high:2");
    const saved = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "native-thinking-save" });
    expect(f.state.settings.blocks.roles.value[saved.agentId]?.thinkingLevel).toBe("native.high:2");
    draft = await f.service.prepare({ clientId: draft.clientId, agentId: saved.agentId, kind: "codex", envId: "local" });
    expect(draft.thinkingLevel).toBe("native.high:2");
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { thinkingLevel: "auto" } });
    expect(draft.thinkingLevel).toBeUndefined(); expect(draft.verification).toBeUndefined();
    expect(f.verifyRoundtrip).toHaveBeenCalledTimes(1);
  });

  it.each([null, false, "high --unsafe", "../high", "high\nother", "a".repeat(65)])("rejects non-public thinking options without changing the draft: %j", async (thinkingLevel) => {
    const f = await fixture(); const draft = await f.prepare();
    await expect(f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { thinkingLevel: thinkingLevel as never } })).rejects.toMatchObject({ status: 400 });
    expect((await f.service.workspace(draft.clientId)).draft).toEqual(draft);
  });

  it("keeps I/O evidence when task instructions and Hub collaboration metadata change", async () => {
    const f = await fixture(); let draft = await f.probed();
    draft = await f.service.verify({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "metadata-io-test", runTest: true });
    const before = structuredClone(draft.verification); const binding = structuredClone(draft.binding);
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { whenToUse: "Only the specified project", prompt: "Please inspect only; retain your native tools and configuration.", readOnly: true, allowSubagents: true, dispatchPolicy: { defaultFor: ["review"] } } });
    expect(draft.verification).toEqual(before); expect(draft.binding).toEqual(binding); expect(draft.detection?.installed).toBe(true);
    const saved = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "metadata-save" });
    expect(saved.enabled).toBe(true); expect(f.state.settings.blocks.roles.value[saved.agentId]).toMatchObject({ readOnly: true, allowSubagents: true });
    expect(f.verifyRoundtrip).toHaveBeenCalledTimes(1); expect(f.request.mock.calls.map(([, request]) => request.operation)).toEqual(["probe"]);
  });

  it("returns project metadata and saves default scopes without repeating paid verification", async () => {
    const f = await fixture(); expect((await f.service.workspace("window-a")).projects).toEqual(f.projects);
    let draft = await f.probed(); draft = await f.service.verify({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "policy-test", runTest: true });
    const verification = structuredClone(draft.verification);
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { dispatchPolicy: { defaultFor: ["coding", "review"], projectIds: ["project-local"] } } });
    expect(draft.verification).toEqual(verification); expect(draft.detection?.installed).toBe(true);
    const saved = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "policy-save" });
    expect(f.state.settings.blocks.roles.value[saved.agentId]?.dispatchPolicy).toEqual({ defaultFor: ["coding", "review"], projectIds: ["project-local"] });
    expect((await f.service.workspace(draft.clientId)).agents.find((agent) => agent.id === saved.agentId)?.dispatchPolicy).toEqual(draft.dispatchPolicy);
    draft = await f.service.prepare({ clientId: draft.clientId, agentId: saved.agentId, kind: "codex", envId: "local" });
    expect(draft.dispatchPolicy?.projectIds).toEqual(["project-local"]);
    draft = await f.service.detect(draft.clientId, draft.revision);
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { dispatchPolicy: { projectIds: [] } } });
    expect(draft.dispatchPolicy).toEqual({ defaultFor: ["coding", "review"] }); expect(draft.verification?.level).toBe("roundtrip");
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { dispatchPolicy: { defaultFor: [] } } });
    expect(draft.dispatchPolicy).toBeUndefined(); expect(draft.verification?.level).toBe("roundtrip");
    const cleared = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "policy-clear" });
    expect(cleared.enabled).toBe(true); expect(f.state.settings.blocks.roles.value[saved.agentId]?.dispatchPolicy).toBeUndefined();
    expect(f.verifyRoundtrip).toHaveBeenCalledTimes(1); expect(f.request.mock.calls.map(([, request]) => request.operation)).toEqual(["probe", "detect"]);
  });

  it.each([
    ["missing-project", "agent_default_project_not_found"],
    ["project-remote", "agent_default_project_device_mismatch"],
  ])("rejects unavailable or cross-device default projects: %s", async (projectId, code) => {
    const f = await fixture(); const draft = await f.prepare();
    await expect(f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { dispatchPolicy: { defaultFor: ["coding"], projectIds: [projectId] } } })).rejects.toMatchObject({ code });
    expect((await f.service.workspace(draft.clientId)).draft).toEqual(draft);
  });

  it("rechecks selected projects when saving a default policy", async () => {
    const f = await fixture(); let draft = await f.probed();
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { dispatchPolicy: { defaultFor: ["review"], projectIds: ["project-local"] } } });
    f.projects.splice(0, 1);
    await expect(f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "deleted-project-save" })).rejects.toMatchObject({ code: "agent_default_project_not_found" });
    expect(f.saveRole).not.toHaveBeenCalled(); expect((await f.service.workspace(draft.clientId)).draft).toEqual(draft);
  });

  it("rejects duplicate defaults including disabled agents while allowing a project-specific override", async () => {
    const f = await fixture(); const draft = await f.prepare();
    f.state.settings.blocks.roles.value["external-existing"] = { id: "external-existing", label: "Existing default", whenToUse: "Coding", prompt: "Task scope", enabled: false,
      external: { kind: "claude-code", envId: "local" }, dispatchPolicy: { defaultFor: ["coding"] } };
    await expect(f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { dispatchPolicy: { defaultFor: ["coding"] } } })).rejects.toMatchObject({ status: 409 });
    expect((await f.service.workspace(draft.clientId)).draft).toEqual(draft);
    const specific = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { dispatchPolicy: { defaultFor: ["coding"], projectIds: ["project-local"] } } });
    expect(specific.dispatchPolicy).toEqual({ defaultFor: ["coding"], projectIds: ["project-local"] });
  });

  it("revokes a policy change if the settings page leaves during project lookup", async () => {
    const f = await fixture(); const draft = await f.prepare(); let release!: (value: typeof f.projects) => void;
    f.listProjects.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const updating = f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { dispatchPolicy: { defaultFor: ["research"], projectIds: ["project-local"] } } });
    await vi.waitFor(() => expect(f.listProjects).toHaveBeenCalledTimes(1)); f.state.active = false; release(f.projects);
    await expect(updating).rejects.toThrow("inactive page"); f.state.active = true;
    expect((await f.service.workspace(draft.clientId)).draft).toEqual(draft);
  });

  it.each([null, [], { defaultFor: ["unsupported-task"] }, { defaultFor: ["coding"], hidden: "unexpected" }])("rejects malformed default metadata without changing the draft: %j", async (policy) => {
    const f = await fixture(); const draft = await f.prepare();
    await expect(f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { dispatchPolicy: policy as never } })).rejects.toMatchObject({ status: 400 });
    expect((await f.service.workspace(draft.clientId)).draft).toEqual(draft);
  });

  it("rejects secret arguments, unsafe executable paths and invalid switches", async () => {
    const f = await fixture(); const draft = await f.prepare();
    const update = (patch: unknown) => f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: patch as never });
    await expect(update({ apiKey: secret })).rejects.toMatchObject({ code: "invalid_agent_configuration_field" });
    await expect(update({ prompt: `credential ${secret}` })).rejects.toMatchObject({ code: "agent_configuration_contains_secret" });
    await expect(update({ executable: "codex --dangerous" })).rejects.toMatchObject({ code: "invalid_agent_executable" });
    await expect(update({ allowSubagents: "yes" })).rejects.toMatchObject({ code: "invalid_agent_configuration" });
    expect(JSON.stringify(await f.harness.snapshot(AgentConfigurationDoc, BACKGROUND_CONTEXT))).not.toContain(secret);
  });

  it("never calls a reserved or unconsented experimental adapter", async () => {
    const f = await fixture();
    for (const clientKind of ["dots", "muse", "grok-bot"] as const) {
      const draft = await f.service.prepare({ clientId: `window-${clientKind}`, kind: clientKind, envId: "local" });
      await expect(f.service.probe(draft.clientId, draft.revision)).rejects.toMatchObject({ code: clientKind === "grok-bot" ? "agent_experimental_opt_in" : "agent_adapter_reserved" });
      await expect(f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "save" })).rejects.toBeDefined();
    }
    expect(f.request).not.toHaveBeenCalled(); expect(f.state.committed).toBe(0);
  });

  it("requires protocol evidence before save and leaves protocol-only connections disabled", async () => {
    const f = await fixture(); const initial = await f.prepare();
    await expect(f.service.save({ clientId: initial.clientId, expectedRevision: initial.revision, commandId: "not-ready" })).rejects.toMatchObject({ code: "agent_connection_not_verified" });
    const draft = await f.service.probe(initial.clientId, initial.revision);
    const result = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "save-protocol" });
    expect(result.enabled).toBe(false); expect(f.state.settings.blocks.roles.value[result.agentId]?.external?.verifiedAt).toBeUndefined();
    expect(f.verifyRoundtrip).not.toHaveBeenCalled();
  });

  it("performs a consented nonce test once and enables a formally supported verified connection", async () => {
    const f = await fixture(); let draft = await f.probed();
    await expect(f.service.verify({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "test-no-consent", runTest: false as true })).rejects.toMatchObject({ code: "agent_test_consent_required" });
    const testInput = { clientId: draft.clientId, expectedRevision: draft.revision, commandId: "test-once", runTest: true as const };
    draft = await f.service.verify(testInput); expect(await f.service.verify(testInput)).toEqual(draft);
    expect(f.verifyRoundtrip).toHaveBeenCalledTimes(1); expect(f.verifyRoundtrip.mock.calls[0]?.[1]).toMatch(/^MOCO_AGENT_VERIFY_[a-f0-9]{24}$/);
    const save = { clientId: draft.clientId, expectedRevision: draft.revision, commandId: "save-once" };
    const first = await f.service.save(save); expect(await f.service.save(save)).toEqual(first);
    expect(first.enabled).toBe(true); expect(f.state.committed).toBe(1); expect((await f.service.workspace(draft.clientId)).draft).toBeUndefined();
  });

  it("persists ambiguous test submission and does not replay it after a service restart", async () => {
    const f = await fixture(); const draft = await f.probed(); f.verifyRoundtrip.mockRejectedValueOnce(new Error("connection lost"));
    const input = { clientId: draft.clientId, expectedRevision: draft.revision, commandId: "ambiguous-test", runTest: true as const };
    await expect(f.service.verify(input)).rejects.toThrow("connection lost");
    await expect(new MocoAgentConfiguration(f.options).verify(input)).rejects.toMatchObject({ code: "agent_test_unconfirmed" });
    expect(f.verifyRoundtrip).toHaveBeenCalledTimes(1);
  });

  it("rejects leaving the page during a probe before persisting its result", async () => {
    const f = await fixture(); const draft = await f.prepare();
    f.request.mockImplementationOnce(async () => { f.state.active = false; return { type: "detection", detection: f.detection }; });
    await expect(f.service.probe(draft.clientId, draft.revision)).rejects.toThrow("inactive page");
    f.state.active = true; const current = (await f.service.workspace(draft.clientId)).draft;
    expect(current?.revision).toBe(draft.revision); expect(current?.detection).toBeUndefined();
  });

  it("resumes a saved commit after live apply failure without duplicating the role", async () => {
    const f = await fixture(); const draft = await f.probed(); f.state.failAfterCommit = true;
    const input = { clientId: draft.clientId, expectedRevision: draft.revision, commandId: "recover-save" };
    await expect(f.service.save(input)).rejects.toThrow("apply failed");
    const resumed = new MocoAgentConfiguration(f.options); const result = await resumed.save(input);
    expect(result.agentId).toMatch(/^external-/); expect(f.state.committed).toBe(1); expect(Object.values(f.state.settings.blocks.roles.value)).toHaveLength(1);
  });

  it("refuses concurrent settings changes and offline execution devices", async () => {
    const f = await fixture(); const draft = await f.probed(); f.state.settings.blocks.roles.revision += 1;
    await expect(f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "stale-settings" })).rejects.toMatchObject({ code: "agent_settings_changed" });
    f.env.online = false; await expect(f.service.detect(draft.clientId, draft.revision)).rejects.toMatchObject({ code: "agent_device_offline" });
  });

  it("loads only allowlisted bundled manuals and distinguishes consumer products", async () => {
    const f = await fixture();
    expect(await f.service.readGuide()).toContain("Only for the active Settings -> Agents assistant");
    expect(await f.service.readGuide("dsh")).toContain("returning success does not prove");
    expect(await f.service.readGuide("grok-bot")).toContain("without sending");
    expect(await f.service.readGuide("muse")).toContain("distinct from Muse Code");
    await expect(f.service.readGuide("../../secrets" as never)).rejects.toMatchObject({ code: "unknown_external_agent" });
  });

  it("keeps opted-in Grok protocol-only until stable I/O verification is supported", async () => {
    const f = await fixture(); let draft = await f.service.prepare({ clientId: "window-grok", kind: "grok-bot", envId: "local" });
    await expect(f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { cdpUrl: "http://remote.example:9333" } })).rejects.toMatchObject({ code: "invalid_agent_debug_endpoint" });
    await expect(f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { cdpUrl: "http://127.0.0.1:9333?mode=inspect" } })).rejects.toMatchObject({ code: "invalid_agent_debug_endpoint" });
    for (const cdpUrl of ["http://localhost:9333", "ws://127.0.0.1:9333", "https://127.0.0.1:9333", "http://127.0.0.1:9333/private"]) {
      await expect(f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { cdpUrl } })).rejects.toMatchObject({ code: "invalid_agent_debug_endpoint" });
    }
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { experimental: true, cdpUrl: "http://127.0.0.1:9333", agentRef: "dedicated-moco-bot" } });
    draft = await f.service.probe(draft.clientId, draft.revision);
    const test = { clientId: draft.clientId, expectedRevision: draft.revision, commandId: "grok-test", runTest: true as const };
    await expect(f.service.verify(test)).rejects.toMatchObject({ code: "agent_roundtrip_unsupported" });
    await expect(new MocoAgentConfiguration(f.options).verify(test)).rejects.toMatchObject({ code: "agent_roundtrip_unsupported" });
    expect(f.verifyRoundtrip).not.toHaveBeenCalled();
    expect((await f.service.workspace(draft.clientId)).draft).toEqual(draft);
    expect(draft.verification?.level).toBe("protocol");
    expect((await f.harness.snapshot(AgentConfigurationDoc, BACKGROUND_CONTEXT))?.receipts).toEqual({});
    const saved = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "grok-save" });
    expect(saved.enabled).toBe(false); expect(f.state.settings.blocks.roles.value[saved.agentId]?.external?.experimental).toBe(true);
    expect(f.state.settings.blocks.roles.value[saved.agentId]?.external?.verifiedAt).toBeUndefined();
    f.state.settings.blocks.roles.value[saved.agentId]!.external!.verifiedAt = 1;
    const reopened = await f.service.prepare({ clientId: draft.clientId, agentId: saved.agentId, kind: "grok-bot", envId: "local" });
    expect(reopened.verification).toBeUndefined(); expect(reopened.binding.verifiedAt).toBeUndefined();
  });

  it("retains verified native communication for metadata edits after a matching fresh detection", async () => {
    const f = await fixture(); let draft = await f.probed();
    draft = await f.service.verify({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "initial-test", runTest: true });
    const initial = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "initial-save" });
    draft = await f.service.prepare({ clientId: draft.clientId, agentId: initial.agentId, kind: "codex", envId: "local" });
    draft = await f.service.updateDraft({ clientId: draft.clientId, expectedRevision: draft.revision, patch: { label: "Code reviewer", whenToUse: "Review changes on this machine." } });
    draft = await f.service.detect(draft.clientId, draft.revision);
    const edited = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "metadata-save" });
    expect(edited.agentId).toBe(initial.agentId); expect(edited.enabled).toBe(true); expect(f.verifyRoundtrip).toHaveBeenCalledTimes(1);
  });

  it("replays a completed removal after apply failure without losing its receipt", async () => {
    const f = await fixture(); const draft = await f.probed(); const saved = await f.service.save({ clientId: draft.clientId, expectedRevision: draft.revision, commandId: "to-remove" });
    f.state.failAfterCommit = true; const input = { clientId: draft.clientId, agentId: saved.agentId, expectedRevision: f.state.settings.blocks.roles.revision, commandId: "remove-once" };
    await expect(f.service.remove(input)).rejects.toThrow("remove apply failed");
    const resumed = new MocoAgentConfiguration(f.options); const result = await resumed.remove(input); expect(result.removed).toBe(true);
    expect(await resumed.remove(input)).toEqual(result); expect(f.state.settings.blocks.roles.value[saved.agentId]).toBeUndefined();
    expect(f.removeRole).toHaveBeenCalledTimes(2);
  });

  it("binds agent setup authority to active page generation, conversation and selected target", async () => {
    const f = await fixture(); const context = { module: "workers" as const, active: true, pageGeneration: 1, clientId: "page-client", appearance: "light" as const, hasUnsavedChanges: false };
    const assistant = new SettingsAssistant({ harness: f.harness } as ConstructorParameters<typeof SettingsAssistant>[0]);
    await f.harness.commit(async (tx) => { const doc = await tx.doc(SettingsAssistantDoc); doc.conversationId = 7; doc.turnContext = context; }, BACKGROUND_CONTEXT);
    assistant.updateContext(context); expect((await assistant.configurationContext("workers", 7)).clientId).toBe(context.clientId);
    assistant.updateContext({ ...context, active: false }); await expect(assistant.configurationContext("workers", 7)).rejects.toThrow("已切换");
    assistant.updateContext({ ...context, pageGeneration: 2 }); await expect(assistant.configurationContext("workers", 7)).rejects.toThrow("已切换");
    assistant.updateContext({ ...context, target: { kind: "external-agent", id: "another-agent" } }); await expect(assistant.configurationContext("workers", 7)).rejects.toThrow("已切换");
    assistant.updateContext(context); await expect(assistant.configurationContext("workers", 8)).rejects.toThrow("已切换");
    await assistant.close();
  });
});
