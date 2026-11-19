import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool, section, type Harness } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { IMAGE_MODEL_PRESETS, type CapabilityConfigurationInput, type CapabilityRecord, type CapabilitiesWorkspaceSnapshot, type EnvNodeDescriptor, type ImageCapabilityConfiguration, type ImageRoutingSettings, type ProjectView, type ProviderCatalogItem, type SkillAudience } from "@kulo/protocol";
import type { KuloCapabilities } from "./capabilities.js";
import type { KuloImageConfiguration } from "./image-configuration.js";
import type { KuloSkills } from "./skills.js";
import type { KuloMediaJobs } from "./media-jobs.js";
import { SettingsAssistantDoc, type SettingsAssistant, type WorkspaceUndoSupport } from "./settings-assistant.js";
import { resolveDeferredAddTools } from "./tool-surface.js";

interface SetupHost {
  harness: Harness;
  capabilities: KuloCapabilities;
  imageConfiguration: KuloImageConfiguration;
  skills: KuloSkills;
  mediaJobs: KuloMediaJobs;
  settingsAssistant: SettingsAssistant;
  projects: { list(): Promise<ProjectView[]> };
  envManager: { listEnvs(): EnvNodeDescriptor[] };
  getCapabilitiesSnapshot(clientId?: string): Promise<CapabilitiesWorkspaceSnapshot>;
  listProviders(): Promise<ProviderCatalogItem[]>;
}
const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
const CONFIG_KEYS = new Set(["id", "name", "adapter", "baseUrl", "modelId", "browserEnvId", "profileRef", "credentialProviderId", "enabled", "isDefault", "allowTaskGeneration", "maxOutputs", "imageProfile", "defaults", "routing", "customAdapter"]);
const preferences = (capability: Pick<CapabilityRecord, "name" | "enabled" | "allowTaskGeneration" | "maxOutputs">) => ({ name: capability.name, enabled: capability.enabled, allowTaskGeneration: capability.allowTaskGeneration, maxOutputs: capability.maxOutputs });
const defaults = (capabilities: CapabilityRecord[]) => Object.fromEntries([...capabilities].sort((a, b) => a.id.localeCompare(b.id)).map((capability) => [capability.id, capability.isDefault]));
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function createCapabilitySetupExtension(get: () => SetupHost) {
  const context = () => get().settingsAssistant.capabilityContext();
  const observed = async () => {
    const state = await get().harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT);
    if (!state?.observedWorkspace) throw new Error("请先读取能力与技能目录再修改。");
    return state.observedWorkspace;
  };
  const capabilityUndo = async (id: string, expectedRevision: number, commandId: string): Promise<WorkspaceUndoSupport> => {
    const remembered = (await get().harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))?.actions.find((item) => item.view.id === commandId)?.workspaceUndoBefore;
    const snapshot = await get().capabilities.snapshot();
    const capability = snapshot.capabilities.find((item) => item.id === id);
    if (!(remembered?.kind === "capability" && remembered.capability.id === id) && (!capability || capability.revision !== expectedRevision)) throw new Error("能力已更新，请重新读取后修改。");
    return {
      before: remembered?.kind === "capability" && remembered.capability.id === id ? remembered : { kind: "capability", capability: { id, revision: capability!.revision, connectionId: capability!.connectionId, modelId: capability!.modelId, kind: capability!.kind, isDefault: capability!.isDefault, ...preferences(capability!) }, defaults: defaults(snapshot.capabilities) },
      complete: async (before, value) => {
        if (before.kind !== "capability" || !value || typeof value !== "object") return undefined;
        const returned = ("capability" in value ? value.capability : value) as CapabilityRecord;
        const current = await get().capabilities.snapshot();
        const saved = current.capabilities.find((item) => item.id === before.capability.id);
        if (!saved || returned.id !== saved.id || saved.revision !== returned.revision || saved.revision !== before.capability.revision + 1 || saved.connectionId !== before.capability.connectionId || saved.modelId !== before.capability.modelId || !equal(defaults(current.capabilities), before.defaults) || equal(preferences(saved), preferences(before.capability))) return undefined;
        return { kind: "capability-restore", id: saved.id, commandId: "", expectedRevision: saved.revision, expectedWorkspaceRevision: current.revision, connectionId: saved.connectionId, modelId: saved.modelId, values: preferences(before.capability) };
      },
    };
  };
  const skillUndo = async (id: string, expectedRevision: number, commandId: string): Promise<WorkspaceUndoSupport> => {
    const remembered = (await get().harness.snapshot(SettingsAssistantDoc, BACKGROUND_CONTEXT))?.actions.find((item) => item.view.id === commandId)?.workspaceUndoBefore;
    const snapshot = await get().skills.snapshot();
    const skill = snapshot.skills.find((item) => item.id === id);
    if (!(remembered?.kind === "skill" && remembered.id === id) && (!skill || snapshot.revision !== expectedRevision)) throw new Error("Skill 目录已更新，请重新读取后修改。");
    return {
      before: remembered?.kind === "skill" && remembered.id === id ? remembered : { kind: "skill", id, enabled: skill!.enabled, version: skill!.version, audiences: [...skill!.audiences], catalogRevision: snapshot.revision },
      complete: async (before, value) => {
        if (before.kind !== "skill" || !value || typeof value !== "object" || !("revision" in value) || value.revision !== before.catalogRevision + 1) return undefined;
        const current = await get().skills.snapshot();
        const saved = current.skills.find((item) => item.id === before.id);
        if (!saved || current.revision !== value.revision || saved.version !== before.version || !equal(saved.audiences, before.audiences) || saved.enabled === before.enabled) return undefined;
        return { kind: "skill-enabled", id: saved.id, commandId: "", expectedRevision: current.revision, enabled: before.enabled };
      },
    };
  };
  const read = async () => {
    const client = await context();
    const snapshot = await get().getCapabilitiesSnapshot(client.clientId);
    await get().harness.commit(async (tx) => { (await tx.doc(SettingsAssistantDoc)).observedWorkspace = {
      capabilityRevision: snapshot.revision, skillRevision: snapshot.skillRevision,
      capabilities: Object.fromEntries(snapshot.capabilities.map((item) => [item.id, item.revision])),
      imageDraftRevision: snapshot.imageSetup?.draft?.revision ?? 0,
    }; }, BACKGROUND_CONTEXT);
    const recoveryConnections = await Promise.all(snapshot.jobs.filter((job) => ["needs_user", "needs_reconciliation"].includes(job.status)).map(async (job) => ({ jobId: job.id, connection: await get().mediaJobs.recoveryConnection(job.id) })));
    const credentialProviders = (await get().listProviders()).filter((provider) => provider.authenticated && provider.authType === "api_key" &&
      (!provider.builtin || provider.isGateway) && provider.baseUrl).map(({ id, name, baseUrl, api }) => ({ id, name, baseUrl, api }));
    return { ...snapshot, imagePresets: IMAGE_MODEL_PRESETS,
      customImageInterface: { adapter: "custom-image", imageProfile: { formats: ["png"], supportsEdit: false, maxReferences: 0, parameters: [{ key: "steps", label: "Steps", type: "number", minimum: 1, maximum: 100, default: 20 }] },
        defaults: { format: "png", count: 1, custom: { steps: 20 } },
        customAdapter: { auth: { type: "bearer" }, generate: { path: "images/generations", body: { model: "{{model}}", prompt: "{{prompt}}", steps: "{{parameters.custom.steps}}" } }, response: { imagesPath: "data", base64Path: "b64_json" } },
        placeholders: ["{{model}}", "{{prompt}}", "{{references}}", "{{parameters.field}}", "{{parameters.custom.field}}"],
        asyncPoll: { path: "jobs/{{jobId}}", idPath: "id", statusPath: "status", completeValues: ["completed"], failedValues: ["failed"], intervalMs: 5000 },
        outputOrigins: "Optional HTTPS origins for output CDNs (downloads never forward API credentials; all requests stay bound to the saved service origin)." },
      recoveryConnections, devices: get().envManager.listEnvs().map(({ id, name, online, capabilities }) => ({ id, name, online, capabilities })),
      credentialProviders,
      projects: (await get().projects.list()).map(({ id, name, deviceId, workspaceDir, availability }) => ({ id, name, deviceId, workspaceDir, availability })),
      adapters: [
        { id: "openai-image", baseUrl: "https://api.openai.com/v1", input: "text, reference images", output: "image (allowed formats follow capability `formats`; verify upstream support)" },
        { id: "gemini-image", baseUrl: "https://generativelanguage.googleapis.com/v1beta", input: "text, reference images", output: "image" },
        { id: "flow-browser", modelId: "auto", input: "text (web default model)", output: "subscription web video", billing: "existing Flow membership credits only; never switch to paid API" },
      ] };
  };
  return defineExtension({
    name: "kulo-capability-setup",
    sections: [section("kulo_capability_setup", async () => {
      await context();
      return get().skills.read("capability-setup", "SKILL.md", "settings");
    }, { tag: false })],
    tools: [
      defineTool({ name: "kulo_capabilities_read", description: "Read configured media capabilities, service connections, Skills, active browser/secret input requests, connected devices, projects, and reusable API-key `credentialProviders` (never returns secrets; call before modifying).", parameters: obj({}), replay: "safe", execute: async (_args, api, ctx) => {
        const value = await read();
        const addTools = await resolveDeferredAddTools(api, ctx, [
          "kulo_capability_manage",
          "kulo_capability_input",
          "kulo_skill_manage",
          "kulo_image_models_discover",
          "kulo_image_models_import",
          "kulo_image_routing",
        ]);
        return { ...result(value), ...(addTools.length ? { control: { addTools } } : {}) };
      } }),
      defineTool({ name: "kulo_capability_configure", description: "Add or update an image/video capability (`config` JSON with `name`/`adapter`/`modelId` and optional `id`/`baseUrl`/`browserEnvId`/`profileRef`/`credentialProviderId`/`enabled`/`isDefault`/`allowTaskGeneration`/`maxOutputs`). Pass a same-origin API-key `credentialProviderId` to reuse a model key, `null` to request a dedicated secret input, or omit to keep current source—never include raw keys, cookies, or headers.", parameters: obj({ config: str() }), replay: "safe", execute: async ({ config }, api) => {
        await context();
        if (config.length > 48_000) throw new Error("配置过长。");
        const value = JSON.parse(config) as Record<string, unknown>;
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !CONFIG_KEYS.has(key))) throw new Error("配置字段无效；凭证必须使用专用输入。");
        const previous = await observed();
        const id = typeof value.id === "string" ? value.id : undefined;
        if (id && previous.capabilities[id] === undefined) throw new Error("请先读取目标能力。");
        const undo = id ? await capabilityUndo(id, previous.capabilities[id]!, api.callId) : undefined;
        const expectedRevision = undo?.before.kind === "capability" ? undo.before.capability.revision : id ? previous.capabilities[id] : undefined;
        const response = await get().settingsAssistant.workspaceAction(api.callId, id ? "更新能力" : "添加能力", [String(value.name ?? "能力")], async () => {
          if (value.adapter !== "flow-browser") {
            const client = await context();
            const draft = await get().imageConfiguration.updateDraft({ clientId: client.clientId,
              config: { ...value, ...(id ? { expectedRevision } : {}) } as unknown as ImageCapabilityConfiguration,
              expectedRevision: previous.imageDraftRevision ?? 0 });
            return get().imageConfiguration.saveDraft({ clientId: client.clientId, expectedRevision: draft.revision, commandId: api.callId });
          }
          const saved = await get().capabilities.configure({ ...value, commandId: api.callId,
            ...(id ? { expectedRevision } : {}) } as CapabilityConfigurationInput);
          const client = await context();
          const connection = await get().capabilities.connection(saved.connectionId);
          const needsInput = connection.adapter === "flow-browser" ? saved.status !== "ready" : !connection.hasCredential;
          const input = needsInput ? await get().capabilities.requestInput(saved.id, connection.adapter === "flow-browser" ? "browser" : "secret", client.clientId) : undefined;
          return { capability: saved, ...(input ? { input } : {}) };
        }, undefined, undo);
        return result(response);
      } }),
      defineTool({ name: "kulo_image_models_discover", description: "Discover candidate image models from reusable API connections (`provider_ids` optional) and render an interactive multi-select card in the right-hand panel (read-only, unbilled, isolated from chat models). 关键词：探测图像模型 发现画图模型列表", parameters: obj({ provider_ids: opt(arr(str())) }), deferred: true, replay: "safe", execute: async ({ provider_ids }, api, ctx) => {
        const client = await context();
        const addTools = await resolveDeferredAddTools(api, ctx, ["kulo_image_models_import"]);
        return { ...result(await get().imageConfiguration.discover(client.clientId, provider_ids)), ...(addTools.length ? { control: { addTools } } : {}) };
      } }),
      defineTool({ name: "kulo_image_models_import", description: "Import user-selected candidate image models (`discovery_id` and `candidate_ids` from this window's discovery result) into the image capability catalog; set `allow_task_generation: true` only when explicitly permitted. 关键词：导入生图模型 添加选中图片模型", parameters: obj({ discovery_id: str(), candidate_ids: arr(str()), allow_task_generation: opt(bool()) }), deferred: true, replay: "safe", execute: async ({ discovery_id, candidate_ids, allow_task_generation }, api) => {
        const client = await context();
        return result(await get().settingsAssistant.workspaceAction(api.callId, "添加图像模型", candidate_ids, () => get().imageConfiguration.importModels({ clientId: client.clientId, discoveryId: discovery_id, candidateIds: candidate_ids, commandId: api.callId, allowTaskGeneration: allow_task_generation })));
      } }),
      defineTool({ name: "kulo_image_draft", description: "Update, save, or discard the shared UI image configuration draft after reading the catalog (`update` accepts credential-free declarative JSON with `name`/`adapter`/`modelId` and optional `baseUrl`/`credentialProviderId`/`imageProfile`/`defaults`/`routing`/`customAdapter`; `save` commits on user request).", parameters: obj({ action: oneOf(["update", "save", "discard"]), config: opt(str()), expected_revision: opt(num()) }), replay: "safe", execute: async ({ action, config, expected_revision }, api) => {
        const client = await context();
        const view = await observed();
        const expectedRevision = expected_revision ?? view.imageDraftRevision ?? 0;
        if (action === "update") {
          if (!config || config.length > 48_000) throw new Error("请提供有效的图像配置草稿。");
          const draft = await get().imageConfiguration.updateDraft({ clientId: client.clientId, config: JSON.parse(config) as ImageCapabilityConfiguration, expectedRevision });
          await get().harness.commit(async (tx) => { const state = await tx.doc(SettingsAssistantDoc); if (state.observedWorkspace) state.observedWorkspace.imageDraftRevision = draft.revision; }, BACKGROUND_CONTEXT);
          return result(draft);
        }
        if (action === "discard") { await get().imageConfiguration.discardDraft(client.clientId, expectedRevision); return result({ discarded: true }); }
        return result(await get().settingsAssistant.workspaceAction(api.callId, "保存图像配置", [], () => get().imageConfiguration.saveDraft({ clientId: client.clientId, expectedRevision, commandId: api.callId })));
      } }),
      defineTool({ name: "kulo_image_routing", description: "Configure multi-model automatic image routing rules after reading the catalog (`settings` JSON with `mode` `auto`|`default`, `preference` `balanced`|`speed`|`quality`|`cost`, `instructions`, and `rules`; explicit user model choices and format/reference/permission gates take precedence). 关键词：图像路由规则 多模型选型偏好", parameters: obj({ settings: str() }), deferred: true, replay: "safe", execute: async ({ settings }, api) => {
        await context();
        if (settings.length > 16_000) throw new Error("图像调用规则过长。");
        const view = await observed();
        return result(await get().settingsAssistant.workspaceAction(api.callId, "修改图像调用规则", [], () => get().capabilities.configureRouting({ settings: JSON.parse(settings) as ImageRoutingSettings, expectedRevision: view.capabilityRevision, commandId: api.callId })));
      } }),
      defineTool({ name: "kulo_capability_manage", description: "Check connectivity (`check`, unbilled), `enable`, `disable`, or propose removing (`remove`, requires confirmation) a configured media capability. 关键词：启用停用删除生图能力 测试连接", parameters: obj({ id: str(), action: oneOf(["check", "enable", "disable", "remove"]) }), deferred: true, replay: "safe", execute: async ({ id, action }, api) => {
        const client = await context();
        const view = await observed();
        const revision = view.capabilities[id];
        if (revision === undefined) throw new Error("请先读取目标能力。");
        const undo = action === "enable" || action === "disable" ? await capabilityUndo(id, revision, api.callId) : undefined;
        const expectedRevision = undo?.before.kind === "capability" ? undo.before.capability.revision : revision;
        return result(await get().settingsAssistant.workspaceAction(api.callId, action === "remove" ? "移除能力" : action === "check" ? "检查能力连接" : action === "enable" ? "启用能力" : "停用能力", [id], async () => {
          if (action === "check") return get().capabilities.check(id, client.clientId);
          return get().capabilities.setEnabled(id, action === "enable", expectedRevision, api.callId);
        }, action === "remove" ? { kind: "capability-remove", id, expectedRevision: revision, commandId: api.callId } : undefined, undo));
      } }),
      defineTool({ name: "kulo_capability_input", description: "Request an in-chat `secret` credential input or `browser` Flow sign-in for a capability (never accepts secret values; set `credentialProviderId: null` via `kulo_capability_configure` first if detaching from a shared model key). 关键词：输入能力密钥 登录Flow浏览器", parameters: obj({ id: str(), kind: oneOf(["secret", "browser"]) }), deferred: true, replay: "safe", execute: async ({ id, kind }) => {
        const client = await context();
        return result(await get().capabilities.requestInput(id, kind, client.clientId));
      } }),
      defineTool({ name: "kulo_skill_manage", description: "Manage Skills after reading the catalog: `import` local directory or HTTPS Git source (stages resources only, runs no install scripts), `enable`, `disable`, `update`, `rollback`, or propose `remove`. 关键词：导入管理技能 启用停用删除Skill", parameters: obj({ action: oneOf(["import", "enable", "disable", "update", "rollback", "remove"]), id: opt(str()), source: opt(str()), audiences: opt(arr(oneOf(["settings", "chat", "worker"]))) }), deferred: true, replay: "safe", execute: async (args, api) => {
        await context();
        const view = await observed();
        const undo = (args.action === "enable" || args.action === "disable") && args.id && args.audiences === undefined ? await skillUndo(args.id, view.skillRevision, api.callId) : undefined;
        const expectedRevision = undo?.before.kind === "skill" ? undo.before.catalogRevision : view.skillRevision;
        const response = await get().settingsAssistant.workspaceAction(api.callId, "管理 Skill", [args.action, args.id ?? "导入 Skill"],
          () => get().skills.manage({ ...args, audiences: args.audiences as SkillAudience[] | undefined, expectedRevision, commandId: api.callId }),
          args.action === "remove" && args.id ? { kind: "skill-remove", id: args.id, expectedRevision: view.skillRevision, commandId: api.callId } : undefined, undo);
        return result(response);
      } }),
    ],
  });
}
