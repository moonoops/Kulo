# Changelog

## v0.1.4 (2026-11-22)

新增多主机热备集群与故障切换、Home Assistant 深度集成与内联图表渲染、安全边界与配额预算治理、电脑操作交互接管、Composio / MCP 扩展增强、客户端 Office 文档在线预览，以及双端实机验证收敛修复（`v0.1.4`）。

### Multi-Host Cluster & Connectors

- **多主机热备集群与实时同步（`@kulo/hub`、`@kulo/env`、`@kulo/protocol`、`@kulo/web`）**
  - 支持主/备多主机集群拓扑、增量状态同步、故障接管与无损回切、预启动围栏（Pre-start Fence）及跨设备实时任务路由与同步。
- **Home Assistant 深度集成、Composio 桥接与智能 MCP 接入（`@kulo/hub`、`@kulo/web`）**
  - 深化 Home Assistant 状态监听与安防哨兵；新增 **Composio** 连接桥接与应用授权弹窗；新增 **MCP 智能粘贴解析器**（支持 `mcpServers` JSON / CLI 命令自动填充）。

### Security Hardening, Quotas & Usage Governance

- **全链路安全加固（`@kulo/protocol`、`@kulo/hub`、`@kulo/env`）**
  - 新增外部不可信文本 XML / Harness 控制标记转义（`provenance.ts`）、POSIX Shell 安全底线分类器（`shell-safety-floor.ts`）、外部智能体环境变量密钥净化（`external-agent-env.ts`）与个人助理自回声抑制（`assistant-echo.ts`）。
- **用量预算上限与外部智能体配额探测（`@kulo/protocol`、`@kulo/hub`、`@kulo/env`、`@kulo/web`）**
  - 新增后台任务日/周 Token 与费用上限控制（Usage Caps）及侧栏用量统计 Popover；支持外部编码智能体（Codex 等）实时配额探测。

### Chat Content, Office Preview & Computer Handoff

- **内联图表、引用来源与客户端 Office 预览（`@kulo/web`、`@kulo/hub`）**
  - 新增内联图表渲染与网页引用来源归属展示；支持客户端零依赖解析与内联/弹窗预览 `.docx`、`.xlsx`（多 Sheet 切换）、`.pptx`（幻灯片翻页）。
- **电脑操作交互接管、记忆遗忘与语音播报清洗（`@kulo/hub`、`@kulo/web`）**
  - 新增电脑实时预览交互接管（Computer Handoff）与坐标映射控制；新增记忆遗忘词条机制与服务端 TTS Markdown 朗读清洗器。

### Stability & Dual-Host Verification Fixes

- **Peer 集群状态与健康检查一致性（`@kulo/env`）**：修正未启用温备时 Peer `/api/devices/cluster-status` 误报 `enabled: true` 与 URL 回退的问题，并统一未鉴权 `GET /api/health` 响应行为。
- **删除会话自动清理任务栏孤儿卡片（`@kulo/hub`）**：`deleteTopic` 原子关闭该会话下已结束且无待合入/待清理锁的关联任务并实时广播同步，避免 Task Rail 残留孤儿任务卡片。
- **窄屏对话顶栏布局与桌面打包修复（`@kulo/web`、`@kulo/hub`）**：收紧 `< 640px` 设备选择触发器与顶栏间距并兼顾触控 44px 目标尺寸，确保窄屏下会话标题清晰可读；排除本地私有目录并将受管源码归档压缩上限提升至 64 MiB。

## v0.1.3 (2026-11-21)

新增个人助理感知闭环与多生态连接器、标准 MCP 与外部 ACP 智能体接入重构、主机动作与分布式设备路由增强，以及 macOS 桌面端正式版/开发版双通道证书签名与常驻体验升级（`v0.1.3`）。

### Personal Assistant Perception & Connectors

- **个人助理感知闭环与主动简报（`@kulo/hub`、`@kulo/env`、`@kulo/protocol`、`@kulo/web`）**
  - 新增连接器安全护栏、macOS 通知中心只读采集、SQLite 事件与摘要账本、环境模型（oMLX / 云端）分拣器、右栏置顶助理卡片与主动话题推送。
  - 新增 **Spark Mail CLI** 连接器（本地/远端 Env 双路 RPC 与幂等 L2 确认卡片）、**Home Assistant** 局域网状态镜像与高危物理操作硬红线、**飞书 / Lark（`lark-cli`）** 双组织桥接，以及移动端 HTTP/SSE 实时同步网关。
  - 「设置 → 连接」新增极简实时感知控制与独立 **MCP 服务连接**（基于 `@earendil-works/pi-mcp`，支持预设与自定义 HTTP/stdio、OAuth / Bearer 鉴权与动态工具挂载）。

### External Agents (ACP) & Device Routing

- **外部智能体 ACP 统一接入与注册表（`@kulo/env`、`@kulo/hub`、`@kulo/protocol`、`@kulo/web`）**
  - 重构外部智能体驱动架构，统一支持 ACP 协议家族（Claude Code、Codex、Cursor、Gemini CLI、GitHub Copilot、OpenCode、Kiro、Grok 及在线 ACP Registry 模板），完善连接探测、模型选择与只读/工作区安全约束。
- **主机动作、内置 Billion Context 与分布式设备路由（`@kulo/hub`、`@kulo/env`、`@kulo/web`）**
  - 内置 Billion Context 长上下文压缩内核，增强跨设备路由、Env 休眠唤醒恢复、电脑操作（`agent-browser` / `agent-desktop`）实时预览与跨端设备身份展示。
  - 长期记忆新增本地 / 云端 LLM 桥接与 Hindsight 服务诊断能力。

### macOS Desktop & Release Signing

- **macOS 桌面端常驻与窗口体验升级（`@kulo/desktop`、`@kulo/web`）**
  - 新增菜单栏托盘图标（深浅色未读角标）、后台运行与通知偏好、窗口尺寸/位置持久化恢复，以及按会话聚合的系统通知与 Dock 角标同步。
- **正式版 / 开发版双通道打包与 Developer ID 签名（`@kulo/desktop`）**
  - `packages/desktop/scripts/package.mjs` 支持 `release`（`Kulo.app` / `io.kulo.desktop`）与 `dev`（`Kulo Dev.app` / `io.kulo.desktop.dev`）双通道独立构建，并自动选用本机证书（优先 `Developer ID Application`）签名以跨升级保留系统权限。

## v0.1.2 (2026-11-19)

项目全面更名为 **Kulo**，同步默认智能体名称为 **Kulo**，并带来模型元数据自动同步、多草稿模型校准、可调宽设置工作台与语音通话错误提示改进（`v0.1.2`）。

### Rebranding to Kulo

- **全仓更名为 Kulo**：Monorepo 包名（`@kulo/*`）、CLI 入口（`kulo` / `kulo-rescue`）、默认智能体名称（`Kulo`）、环境变量前缀（`KULO_*`）、数据库与状态路径（`kulo.sqlite` / `.kulo-state`）、Hindsight 记忆扩展（`kulo-hindsight-auth` / `kulo-core` / `kulo-shared`）、macOS 桌面应用标识（`Kulo Dev` / `io.kulo.desktop.dev`）及 GitHub 仓库（`moonoops/Kulo`）全面切换为 Kulo。

### Model Registry & Calibration

- **公开模型元数据注册表与校准（`@kulo/hub`、`@kulo/protocol`、`@kulo/web`）**
  - 内置 `models.dev` 与 `litellm` 模型元数据快照并支持按需在线刷新（`/api/providers/resolve-model-metadata`），自动补全上下文窗口、输出上限、输入/输出模态与思考强度挡位。
  - 支持多草稿并行模型配置及通过设置助手批量校准已保存模型参数。

### Workbench & Voice Refinements

- **可自由拖拽调节设置侧栏宽度（`@kulo/web`）**：设置工作台支持指针拖拽与键盘步进调整右侧栏宽度，并持久化用户偏好。
- **语音通话异常提示优化（`@kulo/web`、`@kulo/hub`）**：新增原生 HeroUI 语音通话错误横幅（`VoiceCallErrorAlert`），支持一键重试、权限引导与更精准的 TTS / Live 供应商自动匹配。

## v0.1.1 (2026-11-19)

安全地基加固、关键高危边界交互确认与日常体验打磨版本（`v0.1.1`）。

### Security & Runtime Hardening

- **Linux 沙箱与离线定制构建加固（`@moco/env`、`@moco/hub`）**
  - `network.offline === true` 时彻底跳过代理套接字挂载与代理环境变量注入，代理出口额外拦截 RFC1918 内网、Tailscale CGNAT（`100.64/10`）、IPv6 ULA 与组播地址。
  - 受管源码定制的 `typecheck`、`build`、`test` 阶段默认运行在真离线模式；仅探测阶段放行 `localhost`，仅依赖安装阶段放行 `install`。
- **外部智能体路径与沙箱 fail-closed 边界（`@moco/env`）**
  - 外部 ACP 驱动文件操作新增软链 / 悬空软链规范化校验，阻断受保护的系统与 Moco 凭据路径，限制 `staged` 模式不越出暂存目录，并在 `read_only` 模式下禁止 `terminal/create`。
  - 缺少隔离器或约束工作目录时强制 fail-closed，不再静默降级到裸执行。
- **Web CSP、URL Token 擦除与 Peer 本地代理鉴权（`@moco/hub`、`@moco/env`、`@moco/web`）**
  - 静态 HTML 响应补齐严格 `Content-Security-Policy`；前端吸收 `?token=` 后立即通过 `history.replaceState` 从地址栏清除。
  - 本地 Peer 共享代理默认强制 Bearer Token 鉴权，不在日志中输出明文凭据。
- **运行时稳定性修复（`@moco/hub`）**
  - 修复 Watchdog 运行态追踪未 `await`、Watchdog/Recovery 缺少 `moco_inspect` 注入、级联停止子任务未串行化、非 `auto` 角色思考强度未透传、Worker `bash(timeout)` 缺上限保护，以及草稿上传文件定期自动清理。

### High-Risk Redline Confirmations

- **仅在 3 条高危红线处弹出原生内嵌确认卡片（普通操作保持零打扰）**
  - 持久化应用定制构建（`moco_customization(action="validate")`）前需用户点击卡片确认，绑定内容指纹防篡改。
  - 外部智能体权限请求（`moco_external_permission`）阻止模型替用户静默批准，原样展示外部工具原始选项，点击后立即执行。
  - 暂存改动合并（`moco_apply_staged_changes`）普通代码改动直通；仅涉及敏感路径或冲突强制合并时要求用户确认。

### UX & Desktop Refinements

- **首启主对话一键连接模型（`@moco/web`）**：未配置默认模型时，主对话输入框直接展示「连接模型」按钮，一键跳转至「设置 → 模型」。
- **桌面端后台任务系统通知（`@moco/desktop`、`@moco/web`）**：窗口失焦或处于后台时，后台任务实时进入完成 / 需确认 / 失败状态后发送 macOS 原生通知，点击即可切回 Moco 窗口。

## v0.1.0 (2026-11-17)

Moco 首阶段正式基线版本（`v0.1.0`），基于 `@earendil-works/pi-durable` 与 `@earendil-works/pi-env` 构建的个人常驻超级智能体工作台。

### Highlights

- **Moco Hub & Pi Env 准全双工调度内核（`@moco/hub`、`@moco/env`、`@moco/protocol`、`@moco/cli`）**
  - 单 SQLite 账本（`moco.sqlite`）原子持久化多项目/多话题对话事件、工具检查点、工单状态机、定时任务与运行时设置快照（支持 CAS 版本锁与历史回滚）。
  - 有界并发 Worker 调度与每工单子代理（`moco_subagent`）协同，支持任务派发（`moco_dispatch`）、步间无感追单引导（`moco_steer`）、外部等待恢复、阻塞提问回传、重试、停止与收口归档。
  - `/ws/client` 请求级 `hub.ack` 回执、`hub.error` 上下文归因、持久化幂等去重与前端 IndexedDB 可靠重发队列。
  - 支持本机沙箱（macOS Seatbelt / Linux Bubblewrap / Windows 受限隔离）与跨设备 `/ws/env` 反向隧道执行端接入（一次性配对命令、SSH 自动部署与受管 TLS 手机安全配对、Android 通知投递）。
- **HeroUI v3 三栏可视化工作台与多模态交互（`@moco/web`）**
  - 基于 React 19 + Vite + Tailwind CSS v4 + HeroUI React v3 构建三栏工作台，统一内置默认浅色 / 深色双主题（覆盖正文与全部 Portal 浮层）、四档排版字阶与无障碍键盘焦点闭环。
  - 内置动态猫咪陪伴形象（`CatAvatar`）、多模态输入栏、有序多媒体内容块、HTML 交付物安全沙箱预览，以及基于 `json-render` + HeroUI v3 的对话内生成式交互卡片。
  - 支持本地 Sherpa-ONNX 离线语音识别（ASR）、TTS 朗读与实时语音通话。
- **个性与记忆体系（身份与关系文档 + Hindsight 双身份双库隔离）**
  - 「个性与记忆」四模块：身份约定（双签 Diff 审阅、SHA-256 + 目录版本 CAS 锁与备份恢复）、协作关系（支持用户修订与空闲自主整理）、长期记忆（主备地址容灾）与近期工作动态摘要注入；个人设定严格仅对主脑可见，对后台 Worker 物理屏蔽。
  - 配套 `integrations/hindsight` 进程内权限扩展对接 Hindsight 1.2.1，强制隔离主脑私库（`moco-core` 读写 + `moco-shared` 只读）与 Worker 共享库（仅 `moco-shared` 读写）。
- **能力、技能、联网搜索、外部智能体与连接授权**
  - 标准 MCP 联网搜索（预设免 Key Exa，支持 Tavily、Brave 多账号优先级排序与可选 DuckDuckGo）及每模型原生联网工具开关；完整保留来源跨轮与重启恢复，API 密钥严格绑定服务 origin。
  - 基于 Vercel `skills` API 的技能发现、快照安装与按设备/项目条件受控读取；内置配置、生图、视频、浏览器（`agent-browser`）、桌面语义操作（`agent-desktop`）与前端工程预置技能，支持图片生成 API 与 Flow 主浏览器会话衔接。
  - 支持接入本地外部智能体客户端（Codex、Claude Code、Grok 等）并按角色职责与项目设置默认委派范围。
  - 系统密钥库（macOS Keychain / Linux Secret Service / Windows Credential Manager）加密保护预置应用（信息、邮件、GitHub、Figma）、SSH 与自定义凭据，入站对话自动脱敏。
- **macOS 桌面端与受管定制恢复（`@moco/desktop`、`@moco/recovery`）**
  - Electron macOS 桌面外壳与独立便携 Node 运行时打包、离线应用外壳缓存（Service Worker）、受管 Web 源码定制、Ed25519 官方更新验签、启动异常自动回退与独立救援入口（`moco-rescue`）。
