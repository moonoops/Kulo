# Changelog

## v0.1.9 (2026-11-26)

全面推进基准驱动的编排器 Harness 工程治理与减负重构，同时囊括助理主动唤醒规则管道、DSH 风格提示词架构与 1M 自适应上下文压缩能力（`v0.1.9`）。在 ShellBench、AlignBench 与 WildBench v2 249 道公开基准题的三方同场双盲重测中，彻底消除“框架税”：WildBench v2 全面反超同模型裸模型（`+0.382` / WB-Score `+0.763`）、AlignBench 纯直答损耗削减 84%、ShellBench 平均耗时腰斩（提速 `2.0×–2.2×`）且安全细则达成 100% 全过。

### Harness Engineering, URL Hygiene & Dispatch Reliability

- **远端默认节点工作目录修复与无沙箱保护（`@kulo/hub`）**
  - 新增纯叶子模块 `orchestrator-env-cwd.ts`，在未绑定项目且锁定目标设备或单台在线电脑节点场景下，正确将默认工作目录映射至远端节点 `rootDir`，彻底消除跨宿主机路径越界报错与多余的 `kulo_host_action` 探测绕路；同时在 `sandboxed` 模式下自动过滤未就绪的 `no-sandbox`/SSH 节点，防止纯对话误抛异常。
- **只读工作区智能推断、节点端预检与证据路径移交（`@kulo/hub`、`@kulo/env`）**
  - 新增 `dispatch-workspace-infer.ts` 与 `dispatch-evidence-manifest.ts`：仅为无项目只读工单推断受管根内公共目录或只读绑定远端专用根，解决空 `table/` 目录遮蔽工作区文件的问题，并向 Worker 移交主控已读路径清单避免重复读盘；在执行节点侧（`agent-stream-spawn.ts`、`bridge-execution-env.ts`）于路径边界校验后增加只读目录存在性预检；`scheduler.ts` 脱敏并截断透传真实底层失败原因。
- **代码感知的 `@agent` 点名守卫（`@kulo/hub`）**
  - 新增 `agent-mention-guard.ts` 并接入 `agent-routing.ts`（含 `namedDispatchDevices`）：对未加代码围栏的汇编修饰（如 `.type main, @function`）、scoped 包、SSH 主机、注释与装饰器执行词法局部等长遮蔽，要求未知 `@name` 具备显式指派动词或句首呼语子句，同时严格保留显式点名不静默替换的安全不变量。
- **四端对称 URL 追踪参数清洗与联网纪律（`@kulo/protocol`、`@kulo/hub`、`@kulo/web`）**
  - 在 `@kulo/protocol` 新增共享叶子 `url-hygiene.ts`（支持平衡括号 URL、跳过代码块、兼容流式未闭合链接、折叠相邻同 URL 引用），对称接入 `web-content.ts`、`model-native-tools.ts`（仅 Responses API，不触碰 Anthropic 签名块）、`hub-display-projection.ts` 与前端 `citation-sources.ts`，彻底消除 `?utm_source=openai` 追踪外链污染并完整保留 Web UI `<SourceCitationLink asPill>` 胶囊体验；在主控提示词中明确角色扮演、创作、润色与纯逻辑数学题的禁搜边界。
- **工具面减负、交付落点与文体自适应提示词（`@kulo/hub`、`@kulo/protocol`）**
  - 抽离 `tool-surface-tiers.ts` 使 `tool-surface.ts` 退出超长遗留文件清单（930 → 843 行）；将 `kulo_ui_diagram` 与 `kulo_history_search` 静态降级为 `deferred`（读 `diagram-design` 技能自动挂载，零额外轮次；保持 `kulo_ui_show`/`kulo_steer`/`kulo_stop` 常驻无缓存抖动）；放宽图示 `fallbackText` 至 4000 字符。
  - 明确“聊天直接交付代码 vs 后台工作区派单”决策边界、工单回传终态自包含与单轮轻核验、逻辑/数学题先推导再结论、角色扮演充分沉浸、实体锚点保真及 V4→V5 双语角色路由无损迁移（瓶颈优先路由替代按输出后缀归类 `writer`）。

### Proactive Watch-Rule Wake Pipeline & Prompt Architecture Foundation

- **助理主动唤醒规则与桌面通知路由（`@kulo/hub`、`@kulo/protocol`、`@kulo/desktop`、`@kulo/web`）**
  - 新增 `assistant-watch-rules.ts`、`assistant-proactive-wake.ts`、`assistant-proactive-guard.ts` 与 `assistant-echo.ts`，支持按用户配置规则自动监听外部消息流并受控唤醒主对话与桌面系统通知。
- **DSH 风格提示词编排、工具输出溢出分页与 1M 自适应压缩（`@kulo/hub`、`@kulo/env`）**
  - 新增 `orchestrator-prompt-wiring.ts` 与 `staged-workspace-policy.ts`，完善工具输出 3D 溢出分页检索（`asset-inspection.ts`、`orchestrator-tool-overflow.ts`）与超长上下文自适应压缩策略。

## v0.1.8 (2026-11-24)

修复聊天图片缩略图大于 32 KiB 时的 WebP 封装损坏与 Peer 浏览器媒体会话 Cookie 转发问题，并全面升级飞书（`lark-cli v1.0.100`）增量同步、只读查库工具与跨源助理降噪协同，全程零额外用户配置负担（`v0.1.8`）。

### Chat Image Thumbnails & Peer Read-Only Media Sessions

- **WebP 缩略图修复与磁盘自愈（`@kulo/hub`、`@kulo/web`）**
  - 将 FFmpeg 缩略图管道封装由 `-f webp pipe:1` 修正为 `-f image2pipe pipe:1`，彻底消除大于 32 KiB 缩略图写入 `riff_size = 0` 导致 Chromium/Electron 解码报「图片无法显示」的缺陷；升级缩略图缓存版本至 `v2` 并实现顶层 RIFF/WebP 校验与损坏文件读取前自动清除重建。
  - 前端 `AssetImage` 缩略图加载失败时自动静默回退原图一次，并在原图异常或手动重试时自动刷新媒体会话 Cookie 与同步重置切换状态。
- **Peer 节点浏览器只读媒体会话映射（`@kulo/env`）**
  - 新增 `PeerMediaSessionStore` 有界会话映射：支持 `POST /api/media/session` 签发独立本地 `HttpOnly` `kulo_media` Cookie，并仅对 `GET/HEAD /api/uploads/:id(/meta|/preview|/view)?` 以 Cookie-only 转发上游 Hub（不携带设备 Bearer），在主脑切换或会话吊销时自动失效清理。

### Feishu / Lark Sync, Read-Only Bridge & Cross-Source Awareness

- **全面适配 `lark-cli v1.0.100` 与 IM 区间增量同步（`@kulo/hub`、`@kulo/protocol`、`@kulo/web`）**
  - 完整解析 `{ ok, data }` 及 stderr 结构化错误信封与 `auth status --json` 四态诊断，补齐全链路 `--as user` 身份、单飞同步互斥锁与先落盘再推进游标机制；设置页现有飞书状态芯片精准展示分通道健康态。
  - 新增 IM 区间增量同步（分页断点续传、`message_ids` `mget` 回填、话题回复展平、`missing_scope` 自动降级 `+chat-list` 及权限变更自动回探）、免打扰群差集识别与 2 小时冷启动回补隔离。
  - 扩展 `kulo_lark_bridge` 支持 `list_chats`、`read_chat`、`search_messages` 只读查询（仅对主对话与话题编排器开放，对设置助手与普通 Worker 硬隔离，保留敏感载荷过滤与体积上限）。
- **助理账本 v3、Token 节流阀与零 LLM 协同（`@kulo/hub`）**
  - `assistant.sqlite` 幂等升级至 v3（持久化消息方向、结构化元数据、驱动来源与同步游标），支持撤回消息清洗旧原文与 FTS 摘要、启动未摘要事件恢复、`飞书`/`lark` 家族检索，以及非破坏性读时折叠被 `lark-cli` 覆盖的飞书通知重复摘要。
  - 本人发出回复零模型调用直接归档事实摘要；免打扰群无 `@我`、历史回补与 `@所有人` 确定性归档不唤醒主模型 Coordinator；同家族飞书卡片自动合并，并在检测到已关联本人回复（私聊或带 `replyToMessageId`/`threadId` 群回复）时零 LLM 自动消解被动提醒卡（严格保护 L2 决策卡与未回复提问）。

## v0.1.7 (2026-11-24)

重构本机高权执行与低摩擦权限体系（`executionTrustMode: "trusted" | "sandboxed"`），在保留核心态安全底线与向后兼容的前提下，显著降低个人主机研发、工具链调用、电脑操控与内网服务的权限摩擦（`v0.1.7`）。

### Trusted Host Execution & Low-Friction Permissions

- **统一执行权限模式与跨设备能力协商（`@kulo/protocol`、`@kulo/env`、`@kulo/hub`、`@kulo/web`）**
  - 新增 `executionTrustMode`（`trusted` 本机信任 / `sandboxed` 隔离沙箱）单一开关：新装默认 `trusted`，历史版本升级保持 `sandboxed`，并在「设置 → 并发与执行」提供简洁切换入口、说明 Popover 与沙箱升权 `AlertDialog` 二次确认；仅主人设备控制台（排除 SSH principal）可修改执行权限或执行涉及权限变更的历史回滚。
  - 新增 `trusted-host-v1` 协议能力协商与 `hub.execution_trust_mode` 下发；未升级旧版 Peer 自动降级为 `sandboxed` 并保持 OS 沙箱隔离；非计划主备接管通过 `failover-trust-guard.json` 强制降级保护。
  - 切换执行权限采用非破坏性热切换：正在执行的 `runEpoch` 冻结维持原模式（覆盖 `steer`/`retry`/`park`、Scheduler、Subagent、`host_action` 与 `computer_use`），空闲缓存温和淘汰，且多并发 Worker 与主对话按 `executionKey` 精确隔离清理。
- **本机工具链、自我研发与进程监督（`@kulo/env`、`@kulo/hub`）**
  - `trusted` 模式下解除 OS 沙箱对本机 Keychain、SSH、已登录 CLI 工具链与跨目录读写的阻断，支持 Kulo 直接修改自身源码仓库；仅通过内存透传净化 Kulo/Hindsight 内部秘钥变量（磁盘零 `env.json` 落盘），并持续保护运行态核心凭据与数据库文件（含 symlink 解析防御与 ACP 核心路径守卫）。
  - 完善 POSIX 进程组与 Windows Job Object（无 `CmdletBinding` 参数抢占）生命周期监督与父进程 EOF 自动回收。

### Computer Use, External Agents & Local Network Unlock

- **主对话电脑操控与预览接管增强（`@kulo/env`、`@kulo/hub`、`@kulo/web`）**
  - `trusted` 模式下解锁主对话交互式 `kulo_browser` 与只读 `kulo_desktop`、持久化浏览器 Profile（并发自动降级临时 Profile）及 `autoConnect` 无损关闭；修复主对话浏览器接管通过预览弹窗完成后的自动唤醒与关闭交互。
- **本机/私网 HTTP 与 MCP OAuth 放通及云元数据防御（`@kulo/hub`）**
  - `trusted` 模式下支持 `web_fetch`、MCP 及 MCP OAuth 直接访问 `localhost` 与私有局域网服务（内网请求绝不外泄至云端搜索代理），同时持续阻断云元数据地址（含 IPv4-mapped IPv6 与完整展开形式 AWS IPv6 IMDS）与跨源重放重定向。

## v0.1.6 (2026-11-24)

新增零配置内置长期记忆、主对话归档与平滑轮转、跨平台宿主机/桌面打包与附着模式、免密局域网/本机模型直连注册、右侧助理降噪治理、聊天媒体缩略图，以及升级自愈、Windows 沙箱/命令执行、SQLite 并发安全与移动端网关权限收口修复（`v0.1.6`）。

### Built-in Long-Term Memory & Main Conversation Archiving

- **内置长期记忆引擎（`@kulo/hub`、`@kulo/protocol`、`@kulo/web`）**
  - 新增本地 SQLite + FTS5 + 向量混合检索的开箱即用内置长期记忆（`memory.sqlite`），支持与 Hindsight 自动切换/接管、清空屏障与崩溃恢复、启动脱敏清理与热备集群增量同步。
  - 修复启动脱敏清理与集群同步/状态读取并发时的 `SQLITE_BUSY` 阻塞风险；完善 flush `supersedesId` 与 `resolved` 状态回写，统一 `project`/`topic` 作用域在 FTS、精确匹配与向量召回下的过滤语义；修复内置记忆面板在未加载/无权限时的状态展示与嵌套标题层级。
- **主对话归档与根会话轮转（`@kulo/hub`、`@kulo/protocol`、`@kulo/web`）**
  - 支持将主对话一键归档为只读历史话题并在后台提取工作记忆后无缝开启新主对话，支持归档话题还原与多端实时同步。

### Cross-Platform Host, Packaging & Local Model Connectivity

- **macOS / Windows / Linux 宿主机收敛与多平台打包（`@kulo/desktop`、`@kulo/env`、`@kulo/cli`）**
  - 新增统一宿主机数据目录布局、`kulo host` 无头常驻宿主模式、桌面端 Attach Mode 自动附着外部宿主、Linux 凭据三层密钥库（Secret Service / `systemd-creds` / 加密密封文件）、Windows NSIS 安装包与 Linux `.deb` / AppImage / 无头运行时构建及 GitHub Release 工作流。
  - 修复桌面端从 `v0.1.5`（状态格式 v2）升级到 `v0.1.6`（状态格式 v3）时因启动前未先执行状态升级而触发 `incompatible_release` 锁死的问题（升级前自动备份 `kulo.sqlite` 并保留降级保护）。
  - 修复 Windows `HostActionService` 沙箱临时目录与受保护目录重叠报错、Windows `.cmd`/`.bat` `%~dp0` 与 `worker-supervisor` 传参不一致、POSIX 节点安装脚本末尾斜杠兼容，以及 Linux dev `.deb` 图标与 AppArmor 路径引号问题。
- **免密本机/局域网模型接入与媒体缩略图（`@kulo/hub`、`@kulo/protocol`、`@kulo/web`）**
  - 支持直接发现并免密接入本机/私有局域网 OpenAI 兼容模型服务（含 DNS 重绑定校验与云端预设防覆盖守卫）；新增聊天媒体缩略图与 ETag 缓存；强化 Android 设备工具分级与下发校验。

### Proactive Assistant Noise Control & Security Hardening

- **右侧助理提醒降噪与权限一致性（`@kulo/hub`、`@kulo/web`）**
  - 新增开发工具静默归档与卡片分级治理、右侧栏一键批量已读及决策卡片保护；统一所有 `/api/assistant/*` 写接口的同源与权限校验，同时完整放行经受信任本地 TLS `kulo-connector` 接入的已配对移动端执行提醒动作。

## v0.1.5 (2026-11-23)

新增多智能体任务交接板与跨工单评审包、外部与内置智能体提示词及协议协同优化、长上下文守卫与工作记忆体系、Hub 架构模块化瘦身与反熵增守卫，以及 SSH 连接诊断、图像路由和 macOS 桌面打包权限持久化升级（`v0.1.5`）。

### Multi-Agent Collaboration, External & Built-in Worker Alignment

- **多智能体协作、任务交接板与只读评审包（`@kulo/hub`、`@kulo/protocol`、`@kulo/web`）**
  - 新增主脑门控任务交接板（`kulo_task_board`）、跨工单只读评审包物化（`review_ticket_id`）、单子智能体超时与可写中断熔断（`subagent-runner.ts`），以及任务详情内的 Subagent 队友可视化与决策直接终止能力。
- **外部智能体提示词与协议协同优化（`@kulo/hub`、`@kulo/env`、`@kulo/protocol`）**
  - 统一固定 MCP 服务名 `kulo-task` 与 Codex 点分键增量注入（保留用户本机其他 MCP），支持结构化派发能力协商（`EXTERNAL_AGENT_STRUCTURED_DISPATCH_CAPABILITY`）、16K 优先级参考资料预算与 XML 转义边界、Codex `readOnly` 沙箱、安全原生多模态图片附件、排队续接精确核销与 `256 KiB` MCP 报文上限。
- **内置 Worker / Subagent 模板精准对齐与权限收口（`@kulo/hub`）**
  - 基于 `tools ∪ deferred` 实现前缀缓存安全的动态 `Tool Discovery` 并补齐 `kulo_computer_handoff` 引导；收紧 `kulo_computer_handoff` 与 `kulo_connection_request` 为仅顶层 `computer-worker` 并补齐运行时 Subagent 拦截；消除首轮重复文案与 Android 出厂代码角色错配；补齐 Subagent 跨设备隐私守卫与 Hindsight `beforeRequest` 1.5s 软超时空回执持久化。

### Context Window Governance & Working Memory

- **长会话上下文守卫、工具溢出治理与工作记忆（`@kulo/hub`、`@kulo/protocol`）**
  - 新增上下文窗口守卫（`context-guard.ts`）、主脑工具输出溢出落盘（`orchestrator-tool-overflow.ts`）、结构化工作记忆（`working-memory.ts`）、压缩前记忆刷盘（`memory-flush.ts`）、空闲压缩（`idle-compaction.ts`）与私库持久化任务（`kulo.memory-private-retain`）。

### Hub Modularity, SSH Hardening & Desktop Packaging

- **Hub 架构瘦身与反熵增守卫（`@kulo/hub`、`@kulo/web`）**
  - 将 `hub.ts` 核心职责拆解为独立领域服务与 `packages/hub/src/http/*` 纯路由插件，引入基于 AST 的运行时依赖环与单向门面守卫（`kulo-module-cycles.test.ts`）并全面收紧文件行数棘轮基线。
- **SSH 连接加固、图像能力配置与桌面权限持久化（`@kulo/hub`、`@kulo/desktop`、`@kulo/web`）**
  - 新增 SSH 局域网扫描/主机指纹变更诊断、CRLF 私钥归一化、known-hosts 集群同步与 SSH 跟进弹窗；增强图像模型能力配置与 Vertex/厂商适配器隔离；桌面端新增打包期 Mach-O UUID 稳定化补丁（`macho-uuid.mjs`）、更新托盘图标及话题右键菜单。

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
