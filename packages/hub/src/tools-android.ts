import { createHash } from "node:crypto";
import { defineExtension, defineTool, GenerationTask, hook, type JsonObject, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { compile, equal, unsafe, type Schema } from "@earendil-works/pi-schema";
import { ANDROID_TOOL_CATALOG, androidOperationPolicy, isAndroidArgs, isAndroidRequest, isAndroidResult,
  type AndroidAction, type AndroidRequest, type AndroidResult, type AndroidToolDefinition } from "@kulo/protocol";

export interface AndroidToolScope {
  ticketId: string;
  conversationId: number;
  runEpoch: number;
  deviceIds: readonly string[];
  readOnly: boolean;
  assertActive(): Promise<void>;
}

export interface AndroidToolsOptions {
  hubId(): string;
  scope(api: ToolExecutionApi): Promise<AndroidToolScope>;
  execute(envId: string, request: AndroidRequest, signal?: AbortSignal): Promise<AndroidResult>;
  /** Canonicalize only references already authorized to this live task; never forward arbitrary file paths. */
  resolveInput?(scope: AndroidToolScope & { deviceId: string }, action: AndroidAction, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Resolve only Hub-owned assets already checked against the target device and ticket. */
  resolveAssets?(scope: AndroidToolScope & { deviceId: string; supportsImages: boolean }, result: AndroidResult): Promise<NonNullable<ToolExecutionResult["output"]>>;
}

type AndroidArguments = Record<string, unknown> & { device_id?: string };

export function androidOperationId(scope: Pick<AndroidToolScope, "ticketId" | "conversationId" | "runEpoch">,
  api: Pick<ToolExecutionApi, "taskId" | "callId" | "conversationId">, action: AndroidAction, deviceId: string): string {
  if (api.taskId === undefined || typeof api.callId !== "string" || !api.callId || Number(api.conversationId) !== scope.conversationId) {
    throw new Error("Android operation has no stable Pi tool identity");
  }
  return "android-" + createHash("sha256").update(JSON.stringify([
    scope.ticketId, scope.conversationId, scope.runEpoch, String(api.taskId), api.callId, action, deviceId,
  ])).digest("hex");
}

function parametersFor(definition: AndroidToolDefinition): Schema<AndroidArguments> {
  return unsafe<AndroidArguments>({ ...definition.parameters, properties: {
    ...definition.parameters.properties,
    device_id: { type: "string", minLength: 1, maxLength: 100,
      description: "Target phone ID (omit when single phone; required when multiple)." },
  }, additionalProperties: false });
}

function output(result: AndroidResult, deviceId: string): NonNullable<ToolExecutionResult["output"]> {
  const encoded = JSON.stringify({ deviceId, ...result });
  if (encoded.length <= 64_000) return [{ type: "text", text: encoded }];
  return [{ type: "text", text: JSON.stringify({ deviceId, version: result.version, operationId: result.operationId,
    ticketId: result.ticketId, runEpoch: result.runEpoch, action: result.action, status: result.status,
    ...(result.error ? { error: result.error } : {}), truncated: true,
    data: JSON.stringify(result.data ?? null).slice(0, 56_000) }) }];
}

const SCREEN_BEARING_TOOLS = new Set([
  "android_screen", "android_tap", "android_type", "android_scroll", "android_key",
  "android_tap_xy", "android_open", "android_collect", "android_wait_for", "android_gesture",
]);

const KEEP_RECENT_SCREENS = 2;

function foldScreenTextField(target: Record<string, unknown>): boolean {
  let changed = false;
  if (typeof target.text === "string" && target.text.length > 160) {
    const screenId = typeof target.screen === "string" ? target.screen : "?";
    const pkg = typeof target.packageName === "string" ? target.packageName : "";
    const verdict = typeof target.verdict === "string" && target.verdict ? ` | ${target.verdict}` : "";
    target.text = `[folded screen ${screenId}${pkg ? ` (${pkg})` : ""}${verdict}; ${target.text.length} chars omitted]`;
    changed = true;
  }
  if (typeof target.currentScreen === "string" && target.currentScreen.length > 160) {
    const screenId = typeof target.screen === "string" ? target.screen : "?";
    target.currentScreen = `[folded recovery screen ${screenId}; ${target.currentScreen.length} chars omitted]`;
    changed = true;
  }
  return changed;
}

/**
 * Folds older Android screen observations (beyond the latest 2) and drops older ephemeral
 * observation images before each LLM generation request without mutating committed history.
 */
export function foldAndroidScreenMessages(messages: readonly Message[]): readonly Message[] | undefined {
  const screenIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as { role?: string; toolName?: string };
    if (msg.role === "toolResult" && typeof msg.toolName === "string" && SCREEN_BEARING_TOOLS.has(msg.toolName)) {
      screenIndices.push(i);
    }
  }
  if (screenIndices.length <= KEEP_RECENT_SCREENS) return undefined;
  const foldSet = new Set(screenIndices.slice(0, screenIndices.length - KEEP_RECENT_SCREENS));
  let anyChanged = false;
  const next = messages.map((message, index) => {
    if (!foldSet.has(index)) return message;
    const rawMsg = message as unknown as Record<string, unknown>;
    if (!Array.isArray(rawMsg.content)) return message;
    let msgChanged = false;
    const nextContent: Array<Record<string, unknown>> = [];
    for (const entry of rawMsg.content) {
      if (!entry || typeof entry !== "object") {
        nextContent.push(entry as Record<string, unknown>);
        continue;
      }
      const block = entry as Record<string, unknown>;
      if (block.type === "image") {
        msgChanged = true;
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        try {
          const parsed = JSON.parse(block.text) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
            const data = { ...(parsed.data as Record<string, unknown>) };
            let dataChanged = foldScreenTextField(data);
            if (data.afterScreen && typeof data.afterScreen === "object" && !Array.isArray(data.afterScreen)) {
              const after = { ...(data.afterScreen as Record<string, unknown>) };
              if (foldScreenTextField(after)) { data.afterScreen = after; dataChanged = true; }
            }
            if (data.screen && typeof data.screen === "object" && !Array.isArray(data.screen)) {
              const nested = { ...(data.screen as Record<string, unknown>) };
              if (foldScreenTextField(nested)) { data.screen = nested; dataChanged = true; }
            }
            if (dataChanged) {
              msgChanged = true;
              nextContent.push({ ...block, text: JSON.stringify({ ...parsed, data }) });
              continue;
            }
          }
        } catch {
          // Non-JSON text block; keep verbatim
        }
      }
      nextContent.push(block);
    }
    if (!msgChanged) return message;
    anyChanged = true;
    return { ...rawMsg, content: nextContent.length > 0 ? nextContent : [{ type: "text", text: "[folded android screen]" }] } as unknown as Message;
  });
  return anyChanged ? next : undefined;
}

const ANDROID_SEARCH_KEYWORDS: Partial<Record<AndroidAction, string>> = {
  screen: "read screen observe screenshot image ui 读取屏幕 观察界面 截屏 截图",
  tap: "click press button element long press 点击 按钮 长按 轻触",
  type: "input text keyboard search submit 输入文字 打字 填表 搜索 提交",
  scroll: "swipe scroll list page up down left right 滑动 滚动 翻页 列表",
  key: "back home recents notifications quick settings 返回 桌面 最近任务 通知栏",
  tap_xy: "coordinate click touch canvas game 坐标点击 自绘界面",
  open: "launch start app url virtual display 打开应用 启动软件 微信 网址 虚拟屏",
  intent: "alarm timer calendar dial sms share navigate settings 闹钟 计时器 日历 拨号 短信草稿 分享 导航 系统设置",
  collect: "scrape paginate list items scroll collect 采集列表 连续翻页 抓取",
  handoff: "user takeover login captcha otp payment permission 人工接管 登录 验证码 支付 权限",
  apps: "search list installed launcher apps 搜索应用 应用列表 包名",
  wait_for: "wait ui text package appear disappear 等待页面 元素加载",
  gesture: "pinch zoom multi-touch multi-pointer 多指手势 缩放",
  virtual_screen: "virtual display background screen present move_to_main stop 虚拟屏 后台屏幕 预览 移回主屏",
  app_info: "installed apps permissions 已装应用 权限详情",
  app_exit_info: "crash anr exit reason 闪退 崩溃记录",
  network_usage: "data traffic wifi mobile 流量统计 网络消耗",
  privacy_usage: "camera mic location access 隐私访问记录 权限使用",
  battery_usage: "power drain charging 耗电排行 电池状态",
  settings_get: "read system setting brightness volume 读取音量亮度系统开关",
  settings_set: "change brightness volume dnd 调节音量 屏幕亮度 勿扰模式",
  settings_restore: "revert system setting 恢复原系统设置",
  notifications_query: "read notifications statusbar 查看通知栏 消息提醒",
  calendar_query: "calendar events schedule 日历 日程 会议安排",
  contacts_query: "contacts phonebook number 通讯录 联系人 查手机号",
  usage_query: "screen time foreground app 屏幕使用时间 应用时长",
  file_grants: "authorized folders storage 文件目录授权 存储权限",
  file_list: "list directory files 浏览手机文件夹 文件列表",
  file_read: "read phone file document 读取手机文件 查看文档",
  file_export: "upload export phone file 导出手机文件 提取照片文档",
  browser_status: "mobile webview browser status 手机浏览器状态",
  browser_open: "open url mobile browser 手机打开网页 浏览网址",
  browser_observe: "inspect mobile webpage dom 观察手机网页 读取网页内容",
  browser_click: "click mobile webpage element 点击手机网页按钮链接",
  browser_input: "fill mobile web form 手机网页输入填表",
  browser_wait: "wait mobile webpage load 等待手机网页加载",
  browser_back: "mobile browser back 手机网页后退",
  compute_run: "run script python shell sandbox 手机沙箱计算 运行脚本",
  compute_jobs: "check compute job status 查询手机计算任务",
  compute_artifact: "fetch compute output file 获取手机计算结果文件",
  audio_start: "record microphone audio 开始录音 麦克风采集",
  audio_status: "recording status 录音状态检查",
  audio_stop: "stop audio recording 停止录音 保存音频",
  audio_transcribe: "speech to text asr 语音转文字 音频转写 听写",
  audio_transcript_read: "read transcription text 读取转写文稿",
  audio_transcription_stop: "stop live transcription 停止实时转写",
  process_memory: "process ram maps 进程内存映射",
  memory_scan: "scan memory value 内存数值扫描",
  memory_read: "read memory address 读取内存地址",
  memory_write: "patch write memory 修改写入内存",
  sensor: "accelerometer gyroscope light step 传感器 步数 光照 陀螺仪",
  location: "gps coordinates latitude longitude 定位 当前位置 经纬度",
  infrared: "ir blaster remote control 红外遥控 空调电视遥控器",
  bluetooth: "ble scan pair devices 蓝牙扫描 连接耳机设备",
  wifi: "wlan ssid scan network WiFi无线网 扫描切换热点",
  cellular: "sim signal carrier 5g 移动网络 信号强度 运营商",
  network_probe: "ping dns http latency 网络诊断 延迟连通性测试",
  device_data: "sms call log clipboard alarm media 短信 通话记录 剪贴板 闹钟 相册媒体",
  nfc: "read write nfc tag NFC读卡写标签",
  nfc_emulation: "hce card emulation NFC门禁卡模拟",
  device_shortcut: "torch flashlight ringer 快捷开关 手电筒 响铃静音",
  notification_rules: "auto notification filter 通知过滤规则 自动监听",
  notification_channels: "app notification channels 应用通知渠道",
  notify: "send local phone alert 发送手机本地提醒通知",
};

export function createAndroidTools(options: AndroidToolsOptions) {
  return ANDROID_TOOL_CATALOG.map((definition) => {
    const parameters = parametersFor(definition);
    const valid = compile(parameters);
    const kw = ANDROID_SEARCH_KEYWORDS[definition.action];
    return defineTool({
      name: definition.name,
      description: kw ? `${definition.description} (${kw})` : definition.description,
      parameters,
      ...(definition.deferred ? { deferred: true as const } : {}),
      replay: definition.mutating ? "unsafe" : "safe",
      execute: async (input, api, context) => {
        if (!valid.check(input)) throw new Error("Android 工具参数无效；请使用当前工具定义及最新观察。");
        const { device_id: selectedDevice, ...rawArgs } = input;
        let args = rawArgs;
        if (!isAndroidArgs(definition.action, args)) throw new Error("Android 工具参数无效。");
        const scope = await options.scope(api);
        const deviceIds = [...new Set(scope.deviceIds)];
        const deviceId = selectedDevice ?? (deviceIds.length === 1 ? deviceIds[0] : undefined);
        if (!deviceId || !deviceIds.includes(deviceId)) throw new Error("只能操作本任务已获准的手机；多目标任务请填写 device_id。");
        const policy = androidOperationPolicy(definition.action, args);
        if (scope.readOnly && policy.mutating) throw new Error("当前角色只读，不能执行此手机操作。");
        await scope.assertActive();
        context.abortSignal?.throwIfAborted();
        if (definition.action === "audio_transcribe" && (args.audioRef !== undefined || args.filePath !== undefined)) {
          if (!options.resolveInput) throw new Error("音频附件需要当前Hub验证资源归属，不能直接访问文件路径。");
          args = await options.resolveInput({ ...scope, deviceId }, definition.action, args);
          if (!isAndroidArgs(definition.action, args)) throw new Error("音频附件引用无效。");
          await scope.assertActive();
          context.abortSignal?.throwIfAborted();
        }
        let supportsImages: boolean | undefined;
        const modelSupportsImages = async () => {
          if (supportsImages !== undefined) return supportsImages;
          const agent = await api.agent(context);
          return supportsImages = Boolean(agent.model && api.models.getModel(agent.model.provider, agent.model.modelId)?.input.includes("image"));
        };
        if (definition.action === "screen" && args.image === true) {
          if (!await modelSupportsImages()) {
            throw new Error("当前模型不支持图片，请省略 image 或传 image=false 使用紧凑语义文本观察屏幕，或选择支持图片的模型。");
          }
        }
        const candidate: AndroidRequest = { version: 1, hubId: options.hubId(), deviceId, ticketId: scope.ticketId,
          conversationId: scope.conversationId, runEpoch: scope.runEpoch,
          operationId: androidOperationId(scope, api, definition.action, deviceId),
          action: definition.action, args, deadline: api.now() + 120_000 };
        const request = await api.memo("kulo.android.intent", candidate as unknown as JsonObject, context) as unknown as AndroidRequest;
        if (!isAndroidRequest(request) || request.operationId !== candidate.operationId || request.hubId !== candidate.hubId ||
            request.deviceId !== deviceId || request.ticketId !== scope.ticketId || request.runEpoch !== scope.runEpoch ||
            request.conversationId !== scope.conversationId || request.action !== definition.action ||
            !equal(request.args, args)) throw new Error("Android 操作意图已改变，旧调用不能扩大授权或重新执行。");
        if (request.deadline <= api.now()) throw new Error("Android 操作已超过原始期限；先重新观察，不能延长期限重放动作。");
        await scope.assertActive();
        context.abortSignal?.throwIfAborted();
        const result = await options.execute(deviceId, request, context.abortSignal);
        if (!isAndroidResult(result, request)) throw new Error("Android 操作回执与当前任务不匹配。");
        await scope.assertActive();
        context.abortSignal?.throwIfAborted();
        const content = output(result, deviceId);
        if (result.status === "completed" && options.resolveAssets) {
          const images = await modelSupportsImages();
          const assets = await options.resolveAssets({ ...scope, deviceId, supportsImages: images }, result);
          content.push(...assets.filter((item) => item.type !== "image" || images));
        }
        await scope.assertActive();
        context.abortSignal?.throwIfAborted();
        return { output: content, ...(result.status === "completed" ? {} : { isError: true }) };
      },
    });
  });
}

export function createAndroidToolsExtension(options: AndroidToolsOptions) {
  return defineExtension({
    name: "kulo-android",
    tools: createAndroidTools(options),
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => {
          const folded = foldAndroidScreenMessages(request.messages);
          return folded ? { messages: folded } : undefined;
        },
      }),
    ],
  });
}
