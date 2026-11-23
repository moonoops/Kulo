import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type KuloSettingsView, type SettingsAssistantAction } from "@kulo/protocol";
import { EMPTY_SETTINGS_ASSISTANT } from "../../kulo-api";
import { composerPlaceholder, KuloComposer } from "../../kulo-composer";
import { SettingsAssistantPanel } from "./settings-assistant-panel";
import { KuloSettingsRail } from "./settings-rail";
import { canExecuteSettingsClientAction, getSettingsAssistantShortcuts, resolveSettingsAppearanceUndo } from "./settings-assistant-actions";
import type { SettingsAssistantControls } from "./use-settings-assistant";
import { SETTINGS_MODULES } from "./settings-helpers";
import { CAPABILITY_VIEWS } from "./capability-views";

const settings: KuloSettingsView = {
  globalRevision: 1,
  blocks: {
    presentation: { revision: 1, value: { agentName: "Kulo", workbenchName: "工作台" } },
    executor: { revision: 1, value: { maxConcurrentWorkers: 3, maxSubagentsPerTicket: 4, paused: false, watchdogMinutes: 5 } },
    roles: { revision: 1, value: defaultRolePresets() },
    model: { revision: 1, hasApiKey: false, value: { baseUrl: "http://127.0.0.1:9/v1", apiMode: "openai-completions", defaultModel: "", thinkingLevel: "off", customProviders: [] } },
    identity: { revision: 1, directoryRevision: 1, effectiveDirectory: "/tmp/identity", value: { directory: "/tmp/identity" } },
    memory: { revision: 1, hasRouterApiKey: false, hasWorkerApiKey: false, value: { enabled: false, endpoint: "http://127.0.0.1:9", endpoints: [], caCertPem: "", routerApiKeyEnv: "", workerApiKeyEnv: "", authFile: "", autoAttachTopLevelRouters: false, banks: { private: "private", shared: "shared" } } },
  },
  history: [],
};

function controls(): SettingsAssistantControls {
  return {
    draft: "保留我的设置需求", setDraft: vi.fn(), clientId: "tab-a", appearance: "dark",
    attachments: [], enqueueFiles: vi.fn(), removeAttachment: vi.fn(), retryAttachment: vi.fn(), cancelAttachment: vi.fn(), restoreInput: vi.fn(),
    sending: false, switchingConversation: false, pendingActionId: null, unconfirmedSend: false, localAppearance: null,
    send: vi.fn(async () => {}), retrySend: vi.fn(async () => {}), subscribe: vi.fn(async () => {}),
    abort: vi.fn(async () => {}), createConversation: vi.fn(async () => true), selectConversation: vi.fn(async () => true), deleteConversation: vi.fn(async () => true), decide: vi.fn(async () => true),
    navigate: vi.fn(async () => {}), changeAppearance: vi.fn(), undoLocalAppearance: vi.fn(),
  };
}

const appearanceAction: SettingsAssistantAction = {
  id: "appearance-1", kind: "appearance", title: "切换深色", changes: ["浅色 → 深色"],
  status: "pending", requiresConfirmation: false, canUndo: false,
  clientId: "tab-a", appearance: "dark", previousAppearance: "light",
};

describe("settings assistant action boundaries", () => {
  it.each(["light", "dark", "system"] as const)("offers appearance customization prefills rather than duplicating %s theme controls", (mode) => {
    const appearance = getSettingsAssistantShortcuts("appearance", true, mode);
    expect(appearance.map((shortcut) => shortcut.label)).toEqual(["创建我的配色", "更换应用字体"]);
    expect(appearance.every((shortcut) => shortcut.kind === "prefill" && shortcut.draft.length > 0 && shortcut.draft.length < 30)).toBe(true);
    expect(appearance.some((shortcut) => shortcut.kind === "appearance" || shortcut.kind === "navigate")).toBe(false);
  });

  it.each([true, false])("offers direct model setup cards, calibration, and local background model recommendation with model availability %s", (hasModel) => {
    const shortcuts = getSettingsAssistantShortcuts("models", hasModel, "dark");
    expect(shortcuts.map((shortcut) => shortcut.label)).toEqual(["自动接入供应商", "校准模型配置", "排查调用失败", "推荐本机模型"]);
    expect(shortcuts.slice(0, 3).map((shortcut) => shortcut.kind === "model" && shortcut.action)).toEqual(["connect", "calibrate", "diagnose"]);
    const connect = shortcuts.find((shortcut) => shortcut.id === "connect-provider");
    const calibrate = shortcuts.find((shortcut) => shortcut.id === "calibrate-models");
    const diagnose = shortcuts.find((shortcut) => shortcut.id === "diagnose-models");
    const recommendLocal = shortcuts.find((shortcut) => shortcut.id === "recommend-local-model");
    expect(connect?.kind === "model" && connect.prompt).toBeUndefined();
    expect(diagnose?.kind === "model" && diagnose.prompt).toBeUndefined();
    expect(calibrate?.kind === "model" && calibrate.prompt).toBe("校准已有模型配置");
    expect(recommendLocal?.kind).toBe("ask");
    expect(recommendLocal?.kind === "ask" && recommendLocal.prompt).toContain("后台处理所在主机");
  });

  it.each(SETTINGS_MODULES.filter((module) => module.id !== "appearance" && module.id !== "models" && module.id !== "workers" && module.id !== "capabilities"))("keeps $id task suggestions hidden until that capability is connected", ({ id }) => {
    for (const hasModel of [false, true]) expect(getSettingsAssistantShortcuts(id, hasModel, "dark")).toEqual([]);
  });

  it.each(CAPABILITY_VIEWS.filter((view) => view.id !== "image"))("does not turn $id management controls into agent task suggestions", ({ id }) => {
    for (const hasModel of [false, true]) expect(getSettingsAssistantShortcuts("capabilities", hasModel, "dark", id)).toEqual([]);
  });

  it.each([false, true])("offers the image configuration controls before chatting with model availability %s", (hasModel) => {
    const image = getSettingsAssistantShortcuts("capabilities", hasModel, "dark", "image");
    expect(image.map((shortcut) => shortcut.label)).toEqual(["从已有供应商添加", "添加图像模型", "调用规则"]);
    expect(image.map((shortcut) => shortcut.kind === "image" && shortcut.action)).toEqual(["discover", "configure", "routing"]);
  });

  it("automatically executes only unconfirmed browser actions owned by this tab", () => {
    expect(canExecuteSettingsClientAction(appearanceAction, "tab-a")).toBe(true);
    expect(canExecuteSettingsClientAction(appearanceAction, "tab-b")).toBe(false);
    expect(canExecuteSettingsClientAction({ ...appearanceAction, requiresConfirmation: true }, "tab-a")).toBe(false);
    expect(canExecuteSettingsClientAction({ ...appearanceAction, historical: true }, "tab-a")).toBe(false);
    expect(canExecuteSettingsClientAction({ ...appearanceAction, kind: "settings" }, "tab-a")).toBe(false);
    for (const status of ["applied", "rejected", "undone", "failed"] as const) {
      expect(canExecuteSettingsClientAction({ ...appearanceAction, status }, "tab-a")).toBe(false);
    }
  });

  it("can retry an appearance undo whose browser change succeeded before its acknowledgment was lost", () => {
    expect(resolveSettingsAppearanceUndo(appearanceAction, "dark", "tab-a")).toBe("light");
    expect(resolveSettingsAppearanceUndo(appearanceAction, "light", "tab-a")).toBe("light");
    expect(() => resolveSettingsAppearanceUndo(appearanceAction, "system", "tab-a")).toThrow("外观已再次修改");
    expect(() => resolveSettingsAppearanceUndo(appearanceAction, "dark", "tab-b")).toThrow("执行此修改的窗口");
  });
});

describe("settings assistant visible states", () => {
  it("restores an unconfirmed model save after reload even when the server draft is already gone", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => key === "kulo:model-configuration-save:tab-a"
        ? JSON.stringify({ clientId: "tab-a", expectedRevision: 3, commandId: "save-response-lost" }) : null,
    });
    try {
      const html = renderToStaticMarkup(<SettingsAssistantPanel module="models" agentName="Kulo" settings={settings} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error={null} controls={controls()} />);
      expect(html).toContain("重试确认保存");
      expect(html).not.toContain('class="kulo-settings-assistant-intro"');
      expect(html).toMatch(/class="kulo-settings-assistant-footer[^"]*"[^>]*data-separated="true"/);
      const otherClient = renderToStaticMarkup(<SettingsAssistantPanel module="models" agentName="Kulo" settings={settings} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error={null} controls={{ ...controls(), clientId: "tab-b" }} />);
      expect(otherClient).not.toContain("重试确认保存");
    } finally { vi.unstubAllGlobals(); }
  });

  it("offers icon-only new and history entries and prevents switching during unfinished operations", () => {
    const snapshot = { ...EMPTY_SETTINGS_ASSISTANT, topicId: "settings-2", messages: [{ id: 1, role: "user" as const, text: "先前请求" }] };
    const render = (controller = controls(), connected = true, loaded = true, busy = false) => renderToStaticMarkup(
      <SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]} snapshot={{ ...snapshot, live: { ...snapshot.live, busy } }} loaded={loaded} connected={connected} error={null} controls={controller} />,
    ).match(/<button\b[^>]*aria-label="新建设置对话"[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(render()).toBeDefined();
    expect(render()).not.toContain("disabled");
    for (const controller of [
      { ...controls(), sending: true }, { ...controls(), switchingConversation: true },
      { ...controls(), unconfirmedSend: true }, { ...controls(), pendingActionId: "action-1" },
    ]) expect(render(controller)).toContain("disabled");
    expect(render(controls(), false)).toContain("disabled");
    expect(render(controls(), true, false)).toContain("disabled");
    expect(render(controls(), true, true, true)).toContain("disabled");
    const empty = renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error={null} controls={controls()} />);
    expect(empty).toContain('aria-label="新建设置对话"');
    expect(empty).toContain('aria-label="设置对话历史"');
    expect(empty).not.toContain("清空上下文");
    expect(render()).toContain("<svg");
    expect(render()).not.toContain(">新建设置对话<");
  });

  it("shows recovered configuration receipts as history without confirmation or undo actions", () => {
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]}
      snapshot={{ ...EMPTY_SETTINGS_ASSISTANT, topicId: "settings-2", actions: [
        { ...appearanceAction, historical: true, title: "早先的配置记录", requiresConfirmation: true, canUndo: true },
        { ...appearanceAction, id: "legacy-applied", historical: true, status: "applied", title: "早先完成的配置", canUndo: true },
      ] }} loaded connected error={null} controls={controls()} />);
    expect(html).toContain("早先的配置记录");
    expect(html).toContain("历史记录");
    expect(html).not.toContain("查看并确认");
    expect(html).not.toContain("等待原窗口应用");
    expect(html).not.toContain(">撤销</button>");
  });

  it("keeps a writable draft and connection entry before a model is configured", () => {
    const controller = controls();
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="models" agentName="Kulo" settings={settings} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error={null} controls={controller} />);
    expect(html).toContain("先连接一个模型，即可开始对话。");
    expect(html).toContain("自动接入供应商");
    expect(html).not.toContain("添加 API 连接");
    expect(html).not.toContain("登录订阅");
    expect(html).toContain("保留我的设置需求</textarea>");
    expect(html).toContain(">连接模型</button>");
    expect(html).toContain('aria-label="添加附件"');
    expect(html).not.toContain('aria-label="发送"');
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("keeps the shared conversation visible on another settings page and exposes only available recovery controls", () => {
    const controller = controls();
    const snapshot = {
      ...EMPTY_SETTINGS_ASSISTANT,
      messages: [{ id: 1, role: "user" as const, text: "把并发上限改成 3" }],
      actions: [
        { ...appearanceAction, id: "confirm", kind: "settings" as const, title: "删除连接", requiresConfirmation: true },
        { ...appearanceAction, id: "applied", status: "applied" as const, canUndo: true },
      ],
    };
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]} snapshot={snapshot} loaded connected error={null} controls={controller} />);
    expect(html).toContain("把并发上限改成 3");
    expect(html).not.toContain("查看智能体分工");
    expect(html).toContain("连接 Agent 客户端");
    expect(html).toContain("连接 Personal Agent");
    expect(html).not.toContain("kulo-settings-assistant-intro");
    expect(html).not.toContain("智能体设置");
    expect(html).toContain("查看并确认");
    expect(html).toContain("撤销");
    expect(controller.decide).not.toHaveBeenCalled();
  });

  it("keeps the shared settings assistant without redundant tabs, headings, or an avatar", () => {
    const html = renderToStaticMarkup(<KuloSettingsRail
      module="models" agentName="Kulo" settings={settings} envs={[]}
      assistant={EMPTY_SETTINGS_ASSISTANT} assistantLoaded={false} assistantError={null}
      connected assistantControls={controls()}
    />);
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toMatch(/<h[1-6]\b/);
    expect(html).not.toContain('data-slot="avatar"');
    for (const removed of ["更改记录", "加载设置对话", "需要调整什么？", "kulo-settings-assistant-starters"]) {
      expect(html).not.toContain(removed);
    }
    expect(html).toContain("先连接一个模型，即可开始对话。");
    expect(html).not.toContain("kulo-home-starter");
    expect(html).toContain("想要构建什么样的能力？");
    expect(html).toContain("kulo-settings-assistant-suggestions");
    expect(html).toContain('aria-label="新建设置对话"');
    expect(html).toContain('aria-label="设置对话历史"');
    expect(html).toContain("flex-wrap");
  });

  it("uses the shared composer with a page introduction and footer-only secondary task buttons", () => {
    const configured: KuloSettingsView = {
      ...settings,
      blocks: { ...settings.blocks, model: { ...settings.blocks.model, value: { ...settings.blocks.model.value, defaultModel: "test-model" } } },
    };
    const controller = controls();
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="models" agentName="Kulo" settings={configured} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error={null} controls={controller} />);
    const mainComposer = renderToStaticMarkup(<KuloComposer
      draftText={controller.draft} onDraftTextChange={controller.setDraft} attachments={[]}
      onEnqueueFiles={() => {}} onRemoveAttachment={() => {}} onSubmit={() => {}}
      connected
    />);
    const textareaClass = (markup: string) => markup.match(/<textarea\b[^>]*class="([^"]*)"/)?.[1];
    expect(textareaClass(html)).toBe(textareaClass(mainComposer));
    expect(html).toContain('class="kulo-composer"');
    expect(html).not.toContain("需要调整什么");
    expect(html).not.toContain("先连接一个模型");
    expect(html).toContain("校准模型配置");
    expect(html).toContain(`placeholder="${composerPlaceholder()}"`);
    expect(mainComposer).toContain(`placeholder="${composerPlaceholder()}"`);
    expect(html).toContain("想要构建什么样的能力？");
    const footerStart = html.indexOf('class="kulo-settings-assistant-footer');
    const suggestionsStart = html.indexOf('class="kulo-settings-assistant-suggestions');
    const composerStart = html.indexOf('class="kulo-composer"');
    expect(footerStart).toBeGreaterThan(0);
    expect(html).not.toMatch(/class="kulo-settings-assistant-footer[^"]*"[^>]*data-separated="true"/);
    expect(suggestionsStart).toBeGreaterThan(footerStart);
    expect(composerStart).toBeGreaterThan(suggestionsStart);
    expect(html.slice(0, footerStart)).not.toContain("kulo-settings-assistant-suggestion");
    const taskButtons = html.match(/<button\b[^>]*class="[^"]*kulo-settings-assistant-suggestion[^"]*"[^>]*>/g) ?? [];
    expect(taskButtons).toHaveLength(4);
    for (const button of taskButtons) {
      expect(button).toContain("button--secondary");
      expect(button).not.toContain("button--ghost");
    }
    // 4th button ("推荐本机模型", kind="ask") is enabled once a default model is configured.
    expect(taskButtons[3]).not.toContain("disabled");
    expect(html).not.toMatch(/<h[1-6]\b/);
  });

  it("keeps the same footer suggestions separated from the active settings conversation", () => {
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="appearance" agentName="Kulo" settings={settings} envs={[]}
      snapshot={{ ...EMPTY_SETTINGS_ASSISTANT, messages: [{ id: 1, role: "user", text: "我喜欢偏暖的配色" }] }} loaded connected error={null} controls={controls()} />);
    expect(html).toContain("我喜欢偏暖的配色");
    expect(html).not.toContain("kulo-settings-assistant-intro");
    expect(html).toMatch(/class="kulo-settings-assistant-footer[^"]*"[^>]*data-separated="true"/);
    expect(html.indexOf("创建我的配色")).toBeGreaterThan(html.indexOf('class="kulo-settings-assistant-footer'));
    expect(html.indexOf("创建我的配色")).toBeLessThan(html.indexOf('class="kulo-composer"'));
  });

  it("keeps model-backed appearance tasks disabled before a model is connected", () => {
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="appearance" agentName="Kulo" settings={settings} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error={null} controls={controls()} />);
    const buttons = html.match(/<button\b[^>]*class="[^"]*kulo-settings-assistant-suggestion[^"]*"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toContain("disabled");
  });

  it.each(SETTINGS_MODULES)("keeps the neutral greeting on $id above the log and the uniform settings composer without voice", ({ id }) => {
    const html = renderToStaticMarkup(<SettingsAssistantPanel module={id} agentName="Kulo QA canary" settings={settings} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error={null} controls={controls()} />);
    const intro = html.indexOf('class="kulo-settings-assistant-intro"');
    expect(intro).toBeGreaterThan(0);
    expect(intro).toBeLessThan(html.indexOf('role="log"'));
    const introCopy = html.match(/class="kulo-settings-assistant-intro">([\s\S]*?)<\/div>/)?.[1];
    expect(introCopy).toContain('<p class="kulo-section-title">想要构建什么样的能力？</p>');
    expect(introCopy).not.toContain("Kulo");
    expect(html).toContain(`placeholder="${composerPlaceholder()}"`);
    expect(html).not.toContain("kulo-composer-call");
    expect(html).not.toContain('aria-label="语音输入"');
  });

  it("keeps the empty settings action as disabled send and busy next drafts as stop", () => {
    const configured = { ...settings, blocks: { ...settings.blocks, model: { ...settings.blocks.model, value: { ...settings.blocks.model.value, defaultModel: "test-model" } } } };
    const render = (busy: boolean, draft: string) => renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={configured} envs={[]} snapshot={{ ...EMPTY_SETTINGS_ASSISTANT, live: { ...EMPTY_SETTINGS_ASSISTANT.live, busy } }} loaded connected error={null} controls={{ ...controls(), draft }} />);
    const empty = render(false, "");
    expect(empty.match(/<button\b[^>]*aria-label="发送"[^>]*>/)?.[0]).toContain("disabled");
    const busy = render(true, "下一条设置需求");
    expect(busy).toContain('aria-label="停止生成"');
    expect(busy).not.toContain('aria-label="发送"');
    expect(busy).toContain("下一条设置需求</textarea>");
    expect(busy).not.toContain("kulo-composer-call");
  });

  it("offers image and file input without voice transcription or calling", () => {
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="models" agentName="Kulo" settings={settings} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error={null} controls={controls()} />);
    expect(html).toContain('aria-label="添加附件"');
    expect(html.match(/type="file"/g)).toHaveLength(2);
    expect(html).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
    expect(html).not.toContain('accept="audio/*"');
    expect(html).not.toContain('accept="video/*"');
    // Without a configured default model, the conversational "推荐本机模型" shortcut stays disabled.
    const unconfiguredButtons = html.match(/<button\b[^>]*class="[^"]*kulo-settings-assistant-suggestion[^"]*"[^>]*>/g) ?? [];
    expect(unconfiguredButtons).toHaveLength(4);
    expect(unconfiguredButtons[3]).toContain("disabled");
    expect(html).not.toContain('aria-label="语音输入"');
    expect(html).not.toContain("kulo-composer-call");
  });

  it("allows attachment-only input after upload and keeps transfer failures recoverable", () => {
    const configured: KuloSettingsView = {
      ...settings,
      blocks: { ...settings.blocks, model: { ...settings.blocks.model, value: { ...settings.blocks.model.value, defaultModel: "test-model" } } },
    };
    const attachment = { id: "settings-file", name: "config.txt", kind: "file" as const, mimeType: "text/plain", size: 20, url: "/api/uploads/settings-file" };
    const ready = { localId: "draft-file", status: "ready" as const, ...attachment, attachment };
    const render = (status: "ready" | "uploading" | "error") => renderToStaticMarkup(<SettingsAssistantPanel
      module="models" agentName="Kulo" settings={configured} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error={null}
      controls={{ ...controls(), draft: "", attachments: [{ ...ready, status, ...(status === "error" ? { error: "上传失败" } : {}) }] }}
    />);
    const button = (html: string) => html.match(/<button\b[^>]*aria-label="发送"[^>]*>/)?.[0];
    expect(button(render("ready"))).toBeDefined();
    expect(button(render("ready"))).not.toContain("disabled");
    expect(button(render("uploading"))).toContain("disabled");
    expect(render("uploading")).toContain('aria-label="取消上传 config.txt"');
    expect(button(render("error"))).toContain("disabled");
    expect(render("error")).toContain('aria-label="重试上传 config.txt"');
    expect(render("error")).toContain("上传失败");
  });

  it("renders attachment-only history as a previewable user message", () => {
    const attachment = { id: "settings-image", name: "settings.png", kind: "image" as const, mimeType: "image/png", size: 20, url: "/api/uploads/settings-image" };
    const snapshot = { ...EMPTY_SETTINGS_ASSISTANT, topicId: "settings-2", messages: [{ id: 1, role: "user" as const, text: "", attachments: [attachment] }] };
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]} snapshot={snapshot} loaded connected error={null} controls={controls()} />);
    expect(html).toContain("settings.png");
    expect(html).toContain("/api/uploads/settings-image");
    expect(html).toContain("mc-user-message");
    expect(html).toContain('aria-label="预览图片：settings.png"');
  });

  it("keeps each operation beside its tool call, including calls without visible assistant text", () => {
    const snapshot = {
      ...EMPTY_SETTINGS_ASSISTANT,
      messages: [
        { id: 1, role: "user" as const, text: "第一轮请求" },
        { id: 2, role: "assistant" as const, text: "", toolCalls: [{ id: "call-old", name: "kulo_settings_update", argsSummary: "" }] },
        { id: 3, role: "assistant" as const, text: "第一轮回复" },
        { id: 4, role: "user" as const, text: "第二轮请求" },
        { id: 5, role: "assistant" as const, text: "第二轮处理", toolCalls: [
          { id: "call-new", name: "kulo_settings_update", argsSummary: "" },
          { id: "call-old", name: "kulo_settings_update", argsSummary: "" },
        ] },
        { id: 6, role: "assistant" as const, text: "第二轮回复" },
      ],
      actions: [
        { ...appearanceAction, id: "call-new", title: "本轮操作", status: "applied" as const },
        { ...appearanceAction, id: "historical", title: "先前操作", status: "applied" as const },
        { ...appearanceAction, id: "call-old", title: "旧轮操作", status: "undone" as const },
      ],
    };
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]} snapshot={snapshot} loaded connected error={null} controls={controls()} />);
    const positions = [
      'aria-label="先前操作"', "第一轮请求", 'aria-label="旧轮操作"', "第一轮回复",
      "第二轮请求", "第二轮处理", 'aria-label="本轮操作"', "第二轮回复",
    ].map((text) => html.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    for (const title of ["先前操作", "旧轮操作", "本轮操作"]) {
      expect(html.match(new RegExp(`aria-label="${title}"`, "g"))).toHaveLength(1);
    }
  });

  it("treats a manual stop as a normal conversation state without model repair or an error banner", () => {
    const snapshot = {
      ...EMPTY_SETTINGS_ASSISTANT,
      messages: [{ id: 1, role: "user" as const, text: "检查当前设置" }],
      live: { ...EMPTY_SETTINGS_ASSISTANT.live, runFailure: { reason: "aborted" } },
    };
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]} snapshot={snapshot} loaded connected error={null} controls={controls()} />);
    expect(html).toContain("检查当前设置");
    expect(html).not.toContain("aborted");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("恢复上次输入");
    expect(html).not.toContain("模型配置");
  });

  it("shows friendly model failure guidance without exposing raw upstream diagnostics", () => {
    const snapshot = {
      ...EMPTY_SETTINGS_ASSISTANT,
      live: {
        ...EMPTY_SETTINGS_ASSISTANT.live,
        runFailure: { reason: "model_error", detail: '401 {"error":{"message":"invalid_api_key sk-testonly0000000000"}}' },
      },
    };
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]} snapshot={snapshot} loaded connected error={null} controls={controls()} />);
    expect(html).toContain("模型接口鉴权失败");
    expect(html).toContain("已过期或未填写");
    expect(html).toMatch(/<button\b[^>]*>模型<\/button>/);
    expect(html).not.toContain("sk-testonly0000000000");
    expect(html).not.toContain("invalid_api_key");
    expect(html).not.toContain("model_error");
  });

  it("does not suggest model configuration for rate limits and redacts command errors", () => {
    const snapshot = {
      ...EMPTY_SETTINGS_ASSISTANT,
      live: { ...EMPTY_SETTINGS_ASSISTANT.live, runFailure: { reason: "model_error", detail: "429 rate_limit" } },
    };
    const html = renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]} snapshot={snapshot} loaded connected error={null} controls={controls()} />);
    expect(html).toContain("模型请求过于频繁");
    expect(html).not.toContain("模型配置");
    const commandFailure = renderToStaticMarkup(<SettingsAssistantPanel module="workers" agentName="Kulo" settings={settings} envs={[]} snapshot={EMPTY_SETTINGS_ASSISTANT} loaded connected error="保存失败 api_key=test-only-placeholder" controls={controls()} />);
    expect(commandFailure).toContain("保存失败");
    expect(commandFailure).not.toContain("test-only-placeholder");
  });

  it("pins the memory service deployment card at the top of the conversation rail above the scrollable message log", () => {
    const html = renderToStaticMarkup(
      <SettingsAssistantPanel
        module="identity"
        agentName="Kulo"
        settings={settings}
        envs={[]}
        snapshot={{ ...EMPTY_SETTINGS_ASSISTANT, messages: [{ id: 1, role: "user", text: "配置好了吗？" }] }}
        memoryServiceSnapshot={{
          revision: 1,
          deviceName: "Macmini.local",
          platform: "darwin",
          installed: true,
          running: false,
          connection: settings.blocks.memory.value,
          jobs: [{
            id: "job-deploy-1",
            clientId: "tab-a",
            operation: "deploy",
            status: "failed",
            stage: "未完成",
            title: "在本机部署 Hindsight",
            changes: ["Macmini.local", "理解模型：api-google-vertex / gemini-3.8-flash"],
            deviceName: "Macmini.local",
            createdAt: 1,
            updatedAt: 2,
            error: "所选本机 ONNX 模型仓库缺少 onnx/model.onnx 文件",
          }],
          inputs: [],
        }}
        loaded
        connected
        error={null}
        controls={controls()}
      />,
    );
    const pinnedIndex = html.indexOf('class="kulo-settings-assistant-pinned"');
    const cardIndex = html.indexOf("在本机部署 Hindsight");
    const scrollIndex = html.indexOf('class="kulo-settings-assistant-scroll"');
    const messageIndex = html.indexOf("配置好了吗？");
    expect(pinnedIndex).toBeGreaterThan(0);
    expect(cardIndex).toBeGreaterThan(pinnedIndex);
    expect(scrollIndex).toBeGreaterThan(cardIndex);
    expect(messageIndex).toBeGreaterThan(scrollIndex);
  });

  it("omits empty MessageMotion wrappers for tool-only assistant entries without bound actions", () => {
    const html = renderToStaticMarkup(
      <SettingsAssistantPanel
        module="models"
        agentName="Kulo"
        settings={settings}
        envs={[]}
        snapshot={{
          ...EMPTY_SETTINGS_ASSISTANT,
          topicId: "settings-5",
          messages: [
            { id: 1, role: "user", text: "帮我查一下配置" },
            { id: 2, role: "assistant", text: "   ", toolCalls: [{ id: "call-read", name: "kulo_read", argsSummary: "{}" }] },
            { id: 3, role: "assistant", text: "", toolCalls: [{ id: "call-act", name: "kulo_settings_update", argsSummary: "{}" }] },
          ],
          actions: [{ ...appearanceAction, id: "call-act", title: "切换为深色" }],
          live: { busy: true, activeTools: [], queuedCount: 0 },
        }}
        loaded
        connected
        error={null}
        controls={controls()}
      />,
    );
    expect(html.match(/kulo-message-motion/g)).toHaveLength(2);
    expect(html).toContain("帮我查一下配置");
    expect(html).toContain("切换为深色");
    expect(html).toContain("思考中");
  });

  it("hides main-chat one-shot navigate actions so SettingsAssistantPanel never renders a ghost card or hides welcome state", () => {
    const html = renderToStaticMarkup(
      <SettingsAssistantPanel
        module="models"
        agentName="Kulo"
        settings={settings}
        envs={[]}
        snapshot={{
          ...EMPTY_SETTINGS_ASSISTANT,
          topicId: null,
          messages: [],
          actions: [{
            id: "main-nav-1",
            kind: "navigate",
            title: "打开设置",
            changes: [],
            status: "pending",
            requiresConfirmation: false,
            canUndo: false,
            clientId: "tab-a",
            fromMainChat: true,
            module: "models",
            intent: "add-api",
          }],
          live: { busy: false, activeTools: [], queuedCount: 0 },
        }}
        loaded
        connected
        error={null}
        controls={controls()}
      />,
    );
    expect(html).not.toContain("打开设置");
    expect(html).toContain("kulo-settings-assistant-intro");
    expect(html).toContain("想要构建什么样的能力？");
  });
});
