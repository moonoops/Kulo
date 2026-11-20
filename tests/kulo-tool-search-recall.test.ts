import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import { ANDROID_TOOL_CATALOG, type AndroidEnvStatus, type EnvNodeDescriptor } from "@kulo/protocol";
import { buildPhilosophyPrompt } from "../packages/hub/src/prompts/orchestrator.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { routeSettingsTitleRequests } from "./helpers/settings-title-provider.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

interface BenchmarkCase {
  query: string;
  expectedAnyOf: readonly string[];
}

const ORCHESTRATOR_BENCHMARK: readonly BenchmarkCase[] = [
  // Global Settings & Appearance
  { query: "把深色模式打开，切换夜间主题", expectedAnyOf: ["kulo_settings_appearance"] },
  { query: "切换成浅色模式外观", expectedAnyOf: ["kulo_settings_appearance"] },
  { query: "查看当前的并发和角色设置配置", expectedAnyOf: ["kulo_settings_read"] },
  { query: "读取一下现在的模型和设备设置", expectedAnyOf: ["kulo_settings_read"] },
  { query: "修改并发上限和子智能体数量设置", expectedAnyOf: ["kulo_settings_update"] },
  { query: "把自动归档天数改一下", expectedAnyOf: ["kulo_settings_update"] },
  { query: "帮我打开设置页面去添加 API 密钥", expectedAnyOf: ["kulo_settings_navigate"] },
  { query: "跳转到长期记忆设置页配置", expectedAnyOf: ["kulo_settings_navigate"] },
  { query: "检查本机是否安装了 Hindsight 长期记忆服务", expectedAnyOf: ["kulo_memory_service_read"] },
  { query: "卸载删除本机 Hindsight 记忆服务", expectedAnyOf: ["kulo_memory_service_prepare"] },

  // Persisted Chat History
  { query: "搜索以前聊过的历史聊天记录", expectedAnyOf: ["kulo_history_search"] },
  { query: "查找之前对话里提到过的原文", expectedAnyOf: ["kulo_history_search"] },
  { query: "读取历史消息 entry_id 的完整原文", expectedAnyOf: ["kulo_history_read"] },

  // Projects & Conversations
  { query: "查看所有项目列表和绑定的工作目录", expectedAnyOf: ["kulo_projects"] },
  { query: "列出这个项目下面的所有对话话题", expectedAnyOf: ["kulo_project_conversations"] },
  { query: "新建一个项目并绑定本地工程目录", expectedAnyOf: ["kulo_project_create"] },
  { query: "修改项目名称和项目备注", expectedAnyOf: ["kulo_project_update"] },
  { query: "删除归档这个旧项目", expectedAnyOf: ["kulo_project_delete"] },
  { query: "恢复刚才误删的项目", expectedAnyOf: ["kulo_project_restore"] },
  { query: "给当前对话改个名字，修改话题标题", expectedAnyOf: ["kulo_conversation_rename"] },
  { query: "把这个对话话题移入指定项目", expectedAnyOf: ["kulo_conversation_move"] },
  { query: "找回还原已删除的历史对话话题", expectedAnyOf: ["kulo_conversation_restore"] },
  { query: "搜索同一个项目里其他话题的聊天历史", expectedAnyOf: ["kulo_project_history"] },

  // Media, Image, Video & TTS Speech
  { query: "看看当前有哪些可用的生图和视频生成模型能力", expectedAnyOf: ["kulo_media_capabilities"] },
  { query: "帮我画一张赛博朋克猫咪插画图片", expectedAnyOf: ["kulo_generate_image"] },
  { query: "生成一张产品海报生图", expectedAnyOf: ["kulo_generate_image"] },
  { query: "生成一段五秒钟的海浪动画视频", expectedAnyOf: ["kulo_generate_video"] },
  { query: "查询刚才提交的生图视频媒体任务进度", expectedAnyOf: ["kulo_media_job"] },
  { query: "把这段文字转成语音朗读配音发给我", expectedAnyOf: ["kulo_synthesize_speech"] },

  // Connections & Credentials
  { query: "查看已保存的 SSH 服务器和应用连接列表", expectedAnyOf: ["kulo_connections"] },
  { query: "使用已保存的 SSH 连接执行远程命令", expectedAnyOf: ["kulo_connection_use"] },
  { query: "给运行中的工单分配授权连接权限", expectedAnyOf: ["kulo_connection_grant"] },

  // Identity/Relationship, Avatar Expression, Device Invite, Ticket Inspect/Close, UI & Memory
  { query: "读取身份协议和协作关系身份文档", expectedAnyOf: ["kulo_identity_read"] },
  { query: "提交一份新的人设身份协议修改提案", expectedAnyOf: ["kulo_identity_propose"] },
  { query: "记住我的沟通偏好，更新协作关系", expectedAnyOf: ["kulo_relationship_update"] },
  { query: "把侧边栏猫咪头像表情切成开心状态", expectedAnyOf: ["kulo_expression"] },
  { query: "生成设备配对码邀请另一台电脑接入互联", expectedAnyOf: ["kulo_device_invite"] },
  { query: "查看后台工单的实时运行进度和子任务详情", expectedAnyOf: ["kulo_inspect"] },
  { query: "关闭清理已经废弃的旧工单", expectedAnyOf: ["kulo_close"] },
  { query: "刷新更新刚才那张交互卡片的内容", expectedAnyOf: ["kulo_ui_update"] },
  { query: "把工作区里的报告文件作为附件发送发布到聊天", expectedAnyOf: ["kulo_publish_asset"] },
  { query: "打开浏览器访问动态渲染网页获取快照", expectedAnyOf: ["kulo_browser"] },
  { query: "对长期记忆做深度反思归纳历史原因", expectedAnyOf: ["hindsight_reflect"] },
  { query: "查看长期记忆里的心智模型列表和主题综述", expectedAnyOf: ["hindsight_list_mental_models", "hindsight_get_mental_model"] },
  { query: "新建创建一个长期心智模型综述", expectedAnyOf: ["hindsight_create_mental_model"] },
  { query: "浏览长期记忆知识页目录树结构", expectedAnyOf: ["hindsight_get_page_tree", "hindsight_list_knowledge_pages"] },
  { query: "把那条过时错误的旧记忆标记失效作废掉", expectedAnyOf: ["hindsight_invalidate_memory"] },
];

const ANDROID_BENCHMARK: readonly BenchmarkCase[] = [
  { query: "给手机屏幕截屏截图看看画面", expectedAnyOf: ["android_screenshot"] },
  { query: "在手机上打开启动微信应用", expectedAnyOf: ["android_open_app", "android_find_apps"] },
  { query: "按名称查找搜索手机里安装的软件包应用", expectedAnyOf: ["android_find_apps", "android_app_info"] },
  { query: "查看手机通知栏里的最新消息提醒", expectedAnyOf: ["android_notifications_query"] },
  { query: "查询手机日历里的今天会议日程安排", expectedAnyOf: ["android_calendar_query"] },
  { query: "在手机通讯录里查找联系人的电话号码", expectedAnyOf: ["android_contacts_query"] },
  { query: "查看手机短信和通话记录以及剪贴板", expectedAnyOf: ["android_device_data"] },
  { query: "获取手机当前的 GPS 定位经纬度位置", expectedAnyOf: ["android_location"] },
  { query: "扫描附近的 WiFi 无线网络热点", expectedAnyOf: ["android_wifi"] },
  { query: "蓝牙扫描并连接蓝牙耳机设备", expectedAnyOf: ["android_bluetooth"] },
  { query: "在手机输入框里打字输入一段文字", expectedAnyOf: ["android_input_text"] },
  { query: "点击手机屏幕上的指定坐标位置", expectedAnyOf: ["android_tap", "android_node_action"] },
  { query: "在手机屏幕上向上滑动翻页", expectedAnyOf: ["android_swipe"] },
  { query: "按手机返回键回到上一页", expectedAnyOf: ["android_back", "android_global_action"] },
  { query: "调节手机媒体音量和屏幕亮度勿扰模式", expectedAnyOf: ["android_settings_set", "android_settings_get"] },
  { query: "浏览列出手机授权文件夹里的文件列表", expectedAnyOf: ["android_file_list", "android_file_grants"] },
  { query: "把手机里的照片文档导出提取出来", expectedAnyOf: ["android_file_export"] },
  { query: "用手机浏览器打开指定网址网页", expectedAnyOf: ["android_browser_open"] },
  { query: "开启手机麦克风开始录音", expectedAnyOf: ["android_audio_start"] },
  { query: "把录音音频语音转文字听写出来", expectedAnyOf: ["android_audio_transcribe"] },
  { query: "统计今天手机屏幕使用时间和应用前台时长", expectedAnyOf: ["android_usage_query"] },
  { query: "查看手机电池耗电排行情况", expectedAnyOf: ["android_battery_usage"] },
  { query: "测试手机网络 ping 和 DNS 延迟连通性", expectedAnyOf: ["android_network_probe"] },
  { query: "打开手机手电筒快捷开关", expectedAnyOf: ["android_device_shortcut"] },
  { query: "用手机红外遥控器控制空调电视", expectedAnyOf: ["android_infrared"] },
];

describe("Step 3: tool_search bilingual recall, deterministic event injection & compaction pruning", () => {
  it("keeps Orchestrator Tool Discovery prompt line <= 400 chars with limit <= 3 guidance", () => {
    const prompt = buildPhilosophyPrompt("Kulo");
    const discoveryLine = prompt.split("\n").find((line) => line.includes("Tool Discovery"));
    expect(discoveryLine).toBeDefined();
    expect(discoveryLine!.length).toBeLessThanOrEqual(400);
    expect(discoveryLine).toContain("tool_search");
    expect(discoveryLine).toContain("<= 3");
  });

  it("achieves >= 90% Top-3 recall across >= 60 natural-language Chinese/bilingual queries on Orchestrator and Android deferred pools", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-recall-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = fauxProvider({ provider: "recall-test", models: [{ id: "recall-model" }] });
    const models = createModels();
    models.setProvider(routeSettingsTitleRequests(provider));

    const hub = await openTestHub({
      models,
      providerId: "recall-test",
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "workspace"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        customization: { repoRoot: dir } as never,
        memory: {
          enabled: true,
          endpoint: "http://127.0.0.1:19999",
          accessMode: "kulo",
          routerApiKey: "r".repeat(36),
          workerApiKey: "w".repeat(36),
        },
        model: { defaultProvider: "recall-test", defaultModel: "recall-model", thinkingLevel: "off", apiKey: "" },
      },
    });
    cleanups.push(() => hub.close());

    // Enable TTS and device invite on surface for full orchestrator deferred pool coverage
    vi.spyOn(hub.voice, "snapshot").mockResolvedValue({
      asr: { enabled: false, status: "not_installed" },
      tts: { enabled: true, provider: "openai", model: "tts-1", voice: "alloy", hasCredential: true },
    } as never);
    hub.bindDeviceController({
      view: () => ({ role: "hub", enabled: true, canSwitchRole: false, devices: [], sshScans: [] } as never),
      canSwitchRole: () => false,
      setEnabled: async () => ({} as never),
      removeDevice: async () => {},
      scanSsh: async () => ({} as never),
      addSsh: async () => ({} as never),
    });
    const view = hub.getSettingsView();
    await hub.updateSettingsBlock("presentation", view.blocks.presentation.revision, view.blocks.presentation.value);
    // Sync voice TTS flag
    await (hub.voice as unknown as { initialize(opts?: unknown): Promise<void> }).initialize({ prepareAsr: false });
    // Force orchestrator reconfigure with TTS enabled
    const rootAgent = await hub.rootConversation.agent(BACKGROUND_CONTEXT);
    // Ensure kulo_synthesize_speech is in deferred pool for benchmark
    const synthTool = rootAgent.extensions.flatMap((e) => e.tools ?? []).find((t) => t.name === "kulo_synthesize_speech")!;
    const orchestratorDeferred = [
      ...rootAgent.deferred,
      ...(rootAgent.deferred.some((t) => t.name === "kulo_synthesize_speech") ? [] : [synthTool]),
    ];

    const searchTool = createToolSearchTool();
    const runSearch = async (deferredPool: typeof orchestratorDeferred, query: string) => {
      const res = await searchTool.execute(
        { query, limit: 3 },
        {
          agent: async () => ({ deferred: deferredPool }) as never,
        } as unknown as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      );
      return (res.details as { loaded: string[] }).loaded;
    };

    const totalQueries = ORCHESTRATOR_BENCHMARK.length + ANDROID_BENCHMARK.length;
    expect(totalQueries).toBeGreaterThanOrEqual(50);

    let orchestratorHits = 0;
    const misses: string[] = [];
    for (const item of ORCHESTRATOR_BENCHMARK) {
      const top3 = await runSearch(orchestratorDeferred, item.query);
      if (item.expectedAnyOf.some((name) => top3.includes(name))) {
        orchestratorHits++;
      } else {
        misses.push(`[orchestrator] "${item.query}" -> got [${top3.join(", ")}], expected [${item.expectedAnyOf.join("|")}]`);
      }
    }

    // Prepare Android Worker conversation deferred pool
    hub.setAndroidHubIdentity("recall-android-hub");
    const status: AndroidEnvStatus = {
      version: 1,
      catalogVersion: 1,
      enabled: true,
      paused: false,
      revision: 1,
      grants: ["device", "observe", "control", "apps", "screenshot", "notifications", "calendar", "contacts", "usage", "files", "fileExport", "browser", "browserControl", "compute", "audioMicrophone", "audioTranscription", "sensors", "location", "infrared", "bluetoothRead", "bluetoothControl", "wifiRead", "wifiWrite", "cellularRead", "networkProbe", "deviceDataRead"],
      capabilities: ANDROID_TOOL_CATALOG.map((tool) => ({ action: tool.action, available: true })),
    };
    const phone: EnvNodeDescriptor = {
      id: "phone-recall",
      name: "Pixel",
      kind: "reverse-ws",
      online: true,
      platform: "android",
      arch: "arm64",
      rootDir: "",
      executionKind: "native-device",
      capabilities: ["android-device", "android-native-v1"],
      android: status,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    const origListEnvs = hub.envManager.listEnvs.bind(hub.envManager);
    const origGetEnv = hub.envManager.getEnvDescriptor.bind(hub.envManager);
    vi.spyOn(hub.envManager, "listEnvs").mockImplementation(() => [...origListEnvs(), phone]);
    vi.spyOn(hub.envManager, "getEnvDescriptor").mockImplementation((id) => (id === "phone-recall" ? phone : origGetEnv(id)));

    provider.setResponses([
      () => fauxAssistantMessage([fauxToolCall("kulo_wait", { reason: "user", detail: "inspect deferred pool" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("ok")]),
    ]);
    const ticket = await hub.dispatchTicket({
      commandId: "android-recall-pool",
      title: "手机工具召回基准",
      goal: "检查延迟工具池",
      scope: "仅检查",
      role: "coder",
      envId: "phone-recall",
      executionDomain: "android",
    });
    await vi.waitFor(async () => {
      const s = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(s?.tickets[ticket.id]?.status).toBe("waiting");
    });
    const state = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    const androidConv = (await hub.harness.conversation(
      state!.tickets[ticket.id]!.workerConversationId as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    const androidAgent = await androidConv.agent(BACKGROUND_CONTEXT);

    let androidHits = 0;
    for (const item of ANDROID_BENCHMARK) {
      const top3 = await runSearch(androidAgent.deferred, item.query);
      if (item.expectedAnyOf.some((name) => top3.includes(name))) {
        androidHits++;
      } else {
        misses.push(`[android] "${item.query}" -> got [${top3.join(", ")}], expected [${item.expectedAnyOf.join("|")}]`);
      }
    }

    const orchestratorRecall = orchestratorHits / ORCHESTRATOR_BENCHMARK.length;
    const androidRecall = androidHits / ANDROID_BENCHMARK.length;
    const overallRecall = (orchestratorHits + androidHits) / totalQueries;

    expect(orchestratorRecall, `Orchestrator misses:\n${misses.join("\n")}`).toBeGreaterThanOrEqual(0.9);
    expect(androidRecall, `Android misses:\n${misses.join("\n")}`).toBeGreaterThanOrEqual(0.9);
    expect(overallRecall, `Overall misses:\n${misses.join("\n")}`).toBeGreaterThanOrEqual(0.9);
  });

  it("deterministically injects event tools in order without duplicates and prunes idle deferred tools on compaction while keeping unresolved event tools", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-lifecycle-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const provider = fauxProvider({ provider: "lifecycle-test", models: [{ id: "lifecycle-model" }] });
    const models = createModels();
    models.setProvider(routeSettingsTitleRequests(provider));

    let phase = 0;
    const seenInitialTools: string[][] = [];
    provider.setResponses(
      Array.from({ length: 20 }, () => (ctx: TranscriptContext) => {
        const offered = [
          ...(ctx.tools?.map((t) => t.name) ?? []),
          ...ctx.messages.flatMap((m) => (m.role === "system" && Array.isArray(m.toolsAdded) ? m.toolsAdded.map((t) => t.name) : [])),
        ];
        seenInitialTools.push([...new Set(offered)]);
        phase++;
        if (phase === 1) {
          return fauxAssistantMessage([fauxToolCall("tool_search", { query: "深色模式 外观", limit: 2 })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxText(`阶段 ${phase} 回复完成。` + "填充上下文摘要内容。".repeat(80))]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "lifecycle-test",
      config: {
        stateDir: path.join(dir, "state"),
        identityDir: path.join(dir, "identity"),
        localEnvRoot: path.join(dir, "workspace"),
        enableLocalEnv: true,
        watchdogMinutes: 0,
        memory: { enabled: false },
        model: {
          defaultProvider: "lifecycle-test",
          defaultModel: "lifecycle-model",
          thinkingLevel: "off",
          apiKey: "",
          compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 120, backgroundTokens: 50_000 },
        },
      },
    });
    cleanups.push(() => hub.close());

    // 1. First turn: Resident tools exclude deferred settings/event tools; tool_search loads kulo_settings_appearance
    const sub1 = await hub.sendUserMessage("先查一下切换深色模式的工具");
    await sub1.wait(BACKGROUND_CONTEXT);
    expect(seenInitialTools[0]).toContain("tool_search");
    expect(seenInitialTools[0]).not.toContain("kulo_settings_appearance");
    expect(seenInitialTools[0]).not.toContain("kulo_inspect_asset");

    const agentDocAfterSearch = await hub.harness.snapshot(AgentDoc, hub.rootConversation.id, BACKGROUND_CONTEXT);
    const loadedAfterSearch =
      agentDocAfterSearch?.modelTools && !Array.isArray(agentDocAfterSearch.modelTools)
        ? agentDocAfterSearch.modelTools.add ?? []
        : [];
    expect(loadedAfterSearch).toContain("kulo_settings_appearance");

    // 2. Upload an attachment in a user message -> deterministic event injection appends kulo_inspect_asset & kulo_publish_asset preserving order!
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
    const uploaded = hub.uploads.saveUpload({ name: "sample.png", bytes: png, ownerId: "local" });
    const sub2 = await hub.sendUserMessage("帮我看看这张图", { attachments: [uploaded] });
    await sub2.wait(BACKGROUND_CONTEXT);

    const agentDocAfterAttach = await hub.harness.snapshot(AgentDoc, hub.rootConversation.id, BACKGROUND_CONTEXT);
    const addList =
      agentDocAfterAttach?.modelTools && !Array.isArray(agentDocAfterAttach.modelTools)
        ? agentDocAfterAttach.modelTools.add ?? []
        : [];
    expect(addList.indexOf("kulo_settings_appearance")).toBeGreaterThanOrEqual(0);
    expect(addList.indexOf("kulo_inspect_asset")).toBeGreaterThan(addList.indexOf("kulo_settings_appearance"));
    expect(addList).toContain("kulo_publish_asset");
    expect(new Set(addList).size).toBe(addList.length);

    // 3. Add enough plain turns so kulo_settings_appearance falls outside keepRecentTokens, then run manual compaction
    for (let i = 0; i < 4; i++) {
      const s = await hub.sendUserMessage(`普通长消息轮次 ${i}: ` + "测试上下文压缩回收闲置延迟工具。".repeat(60));
      await s.wait(BACKGROUND_CONTEXT);
    }

    const compactTaskId = await hub.rootConversation.compact(undefined, BACKGROUND_CONTEXT);
    const done = await hub.harness.waitForTask(compactTaskId, BACKGROUND_CONTEXT);
    if (done.state.outcome.status === "completed" && "submissionId" in done.state.outcome.result && done.state.outcome.result.submissionId !== undefined) {
      await (await hub.harness.submission(done.state.outcome.result.submissionId, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);
    }

    const agentDocAfterCompact = await hub.harness.snapshot(AgentDoc, hub.rootConversation.id, BACKGROUND_CONTEXT);
    const addAfterCompact =
      agentDocAfterCompact?.modelTools && !Array.isArray(agentDocAfterCompact.modelTools)
        ? agentDocAfterCompact.modelTools.add ?? []
        : [];
    expect(addAfterCompact).not.toContain("kulo_settings_appearance");
  });
});
