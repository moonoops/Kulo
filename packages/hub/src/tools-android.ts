import { createHash } from "node:crypto";
import { defineExtension, defineTool, type JsonObject, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { compile, equal, unsafe, type Schema } from "@earendil-works/pi-schema";
import { ANDROID_TOOL_CATALOG, androidOperationPolicy, isAndroidArgs, isAndroidRequest, isAndroidResult,
  type AndroidAction, type AndroidRequest, type AndroidResult, type AndroidToolDefinition } from "@moco/protocol";

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

const ANDROID_SEARCH_KEYWORDS: Partial<Record<AndroidAction, string>> = {
  find_apps: "search app package 搜索应用 查找软件包",
  app_info: "installed apps permissions 已装应用 权限详情",
  app_exit_info: "crash anr exit reason 闪退 崩溃记录",
  network_usage: "data traffic wifi mobile 流量统计 网络消耗",
  privacy_usage: "camera mic location access 隐私访问记录 权限使用",
  battery_usage: "power drain charging 耗电排行 电池状态",
  node_action: "accessibility node click scroll 无障碍节点操作 点击滑动",
  global_action: "home recents notifications lockscreen 桌面 最近任务 下拉通知栏 锁屏",
  open_settings: "system settings page 打开系统设置界面",
  screenshot: "capture screen image 截屏 截图 屏幕画面",
  sequence: "batch ui steps 连贯动作 批量操作",
  tap: "click coordinate touch 点击坐标 轻触屏幕",
  swipe: "scroll drag fling 滑动 翻页 拖拽",
  gesture: "pinch zoom multi-touch 手势 缩放 长按",
  verification: "otp sms code captcha 验证码 短信验证",
  input_text: "type text keyboard 输入文字 打字 粘贴文本",
  back: "navigate back 返回上一页 后退键",
  open_app: "launch start app 打开应用 启动软件 微信",
  wait_for: "wait ui condition 等待元素 页面加载",
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
  device_shortcut: "torch flashlightringer 快捷开关 手电筒 响铃静音",
  virtual_screen: "virtual display background screen 虚拟屏幕 后台显示",
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
        if (definition.action === "screenshot") {
          if (!await modelSupportsImages()) {
            throw new Error("当前模型不支持图片，请使用语义观察或选择支持图片的模型。");
          }
        }
        const candidate: AndroidRequest = { version: 1, hubId: options.hubId(), deviceId, ticketId: scope.ticketId,
          conversationId: scope.conversationId, runEpoch: scope.runEpoch,
          operationId: androidOperationId(scope, api, definition.action, deviceId),
          action: definition.action, args, deadline: api.now() + 120_000 };
        const request = await api.memo("moco.android.intent", candidate as unknown as JsonObject, context) as unknown as AndroidRequest;
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
  return defineExtension({ name: "moco-android", tools: createAndroidTools(options) });
}
