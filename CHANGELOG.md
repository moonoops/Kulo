# Changelog

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
