<p align="center">
  <img src="packages/web/public/moco-icon.png" width="96" alt="Moco">
</p>

<h1 align="center">Moco</h1>

<p align="center"><strong>你的常驻 Agent，协同多台设备</strong></p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPLv3-blue" alt="License: AGPLv3"></a>
  <img src="https://img.shields.io/badge/deployment-self--hosted-brightgreen" alt="Self-hosted">
</p>

<!-- 确定公开仓库地址后添加 Release、Stars 徽章；配置工作流后再添加 CI 徽章。 -->

Moco 是可以自建的个人 Agent。你始终和同一个 Moco 交流，由它记住与你的关系、协调不同设备上的智能体，并把结果带回对话。文字、语音、可交互界面和后台任务，共同组成一个持续工作的伙伴。

[多设备协作](#multi-device) · [SuperAgent](#superagent) · [多模态交互](#multimodal) · [记忆与共享](#memory) · [自定义与恢复](#customization) · [快速开始](#quick-start)

> 主界面截图待补充：常驻对话、话题列表、任务进度与设备状态。

<a id="multi-device"></a>
## 一套 Moco，连接多台设备

你可以把 Host 主机部署在自己的电脑或服务器上，再让其他设备接入。Host 上的 **Hub** 负责主 Agent、会话、任务调度和状态存储；Device 上的 **Env** 提供任务实际执行的环境。

```text
电脑 / 手机 / 平板上的浏览器
             │
        Host · Moco Hub
        主 Agent / 会话 / 调度
             │
    ┌────────┼────────┐
  本机 Env  设备 A Env  设备 B Env
    文件      浏览器      开发工具
```

打开 Moco 的设备和执行任务的设备可以不同：你在手机上提出需求，Moco 可以安排电脑上的 Worker 整理文件，再调用另一台设备的开发工具。Host 也可以同时运行本机 Env，先在一台电脑上使用，随后逐步接入更多设备。

底层由 [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) 和 [Pi Env](https://github.com/earendil-works/pi/tree/main/packages/env) 支撑，分别承担持久会话与执行环境能力，[Pi AI](https://github.com/earendil-works/pi/tree/main/packages/ai) 负责模型接入。多台客户端连接同一个 Hub，共同访问同一套 Moco。

<a id="superagent"></a>
## SuperAgent：始终和同一个 Moco 对话

### 不同话题，同一个 Agent

Moco 的主 Agent 是你的固定对话入口。它负责理解需求、安排工作、跟进结果和向你汇报。新建话题只是换一个讨论空间：身份、与你的关系和协调职责保持一致，各话题保留各自的消息记录与任务上下文。

你可以在一个话题里研究旅行计划，在另一个话题里开发项目。切换话题后，已经派发的任务仍可继续执行，结果回到对应话题。主 Agent 会结合共享的身份与记忆、当前话题以及允许检索的历史接续交流，不会默认把所有话题全文混在一起。

### 工作进行时，也能自由插话

主 Agent 思考、回复或跟进后台任务时，你都可以自由插话：补充条件、纠正方向、询问进度，或者先聊另一件事。新消息会在后续处理节点被吸收；正在执行的工具操作不一定立即停止。

例如，一次开发任务可以这样进行：

1. 在开发话题里说：“让工作站上的 Codex 检查登录页，修复键盘操作。”
2. 任务进行中补充：“保留现在的视觉样式，也检查一下窄屏。”Moco 接收新约束，调整后续安排。
3. 切到另一个话题，和同一个 Moco 讨论周末计划；开发任务继续在后台执行。
4. Codex 提交结果，主 Agent 检查改动与验证情况，再回到原来的开发话题向你交付。

### 主 Agent 协调，Worker 分工

主 Agent 可以把复杂任务拆给不同 Worker，选择合适的角色、模型和设备。你无需分别管理每个智能体，也无需自己拼接它们的回答。

```text
你提出需求、补充条件或调整方向
              ↓
     Moco 主 Agent 理解与协调
              ↓
   内置 Worker / Codex / Claude Code
              ↓
     在选定设备上执行，回传结果
              ↓
   主 Agent 检查产物，向你交付
```

除了内置 Worker，Moco 也能派发外部 Agent，例如 Codex 和 Claude Code，让它们在自己的原生运行环境中完成任务。外部 Agent 沿用各自的工具与权限配置，Moco 负责组织任务和接收回报。

Worker 产物先交给主 Agent 检查，再由主 Agent 发布到对话。任务进展、需要你决定的问题和最终结果，都通过这个统一入口与你对接。

> SuperAgent 演示待补充：任务分派 → 中途插话 → 切换话题 → 主 Agent 审核并交付。

<a id="multimodal"></a>
## 多模态与生成式对话交互

除了文字，Moco 支持图片、音频、视频和文件输入，具体理解能力取决于所选模型与配置的处理能力。对话也可以呈现为更适合当前任务的交互形式。

**生成式 UI** 让 Agent 在对话中给出表格、图表、表单、选项和滑块。你直接调整参数、比较方案或提交选择，结构化结果回到 Agent，继续推动任务。交互组件来自受控的组件集合；需要更自由的展示时，也可提供在沙箱中运行的 HTML 产物。

> 生成式 UI 演示待补充：用图表比较方案，在表单中调整条件并继续对话。

**Live 全双工对话** 支持实时语音、字幕和打断。语音会话可以结合当前话题上下文，把需要执行的工作交给主 Agent，并接收任务更新。结束通话后，已派发的任务仍可继续。使用前需要配置支持的 Live 服务。

> Live 演示待补充：语音交流 → 打断与补充 → 后台执行 → 结果返回。

<a id="memory"></a>
## 跨会话记忆，有边界的信息共享

Moco 在 Host 本地使用 SQLite 保存会话与任务状态，并维护身份、关系和近期工作信息。主 Agent 可以检索当前话题及同一项目内允许访问的历史，在后续对话中找回相关内容。持久记录为连续交流提供依据，实际回忆仍取决于检索和上下文选择。

需要更长期的语义记忆时，可以启用可选的 **Hindsight 双 Bank**：

| 记忆区域 | 主 Agent | Worker |
| --- | --- | --- |
| 私有 Bank | 读写 | 禁止访问 |
| 共享 Bank | 只读 | 读写 |

私有记忆用于主 Agent 与你的持续关系；共享记忆用于任务知识和协作结果。权限由服务端和独立凭据执行。两个 Bank 可以位于同一 Hindsight 实例与数据库中，隔离依靠授权规则，并需要配套的设备、文件和凭据权限。

启用共享记忆后，Worker 在任务开始时检索相关历史，提交工作报告后异步保存结果与验证记录，供后续任务复用。Codex、Claude Code 等外部 Agent 也能通过任务工具检索获授权的共享记忆、读取知识页面和提交新知识，无需获得主 Agent 的私有记忆权限。

Hindsight 默认关闭，无需启用也能使用 Moco。部署和权限细节见 [Hindsight 集成说明](integrations/hindsight/README.md)。

<a id="customization"></a>
## 用对话配置，也为自定义留下退路

你可以通过自然语言让主 Agent 配置能力、调整设置和组合工作流程。对于界面层面的定制，macOS 桌面版提供受管的 Web 界面修改流程：准备候选版本、构建与验证、在下次启动时启用，并检查新界面是否正常就绪；启动失败时可回到上一个可用版本。

独立救援工具 `moco-rescue` 保留在主界面之外，可以检查安装状态、选择恢复版本并导出诊断日志，供你选择的第三方 Agent 排查修复。目前这套受管流程覆盖桌面 Web 界面，恢复范围是应用版本，不会撤销数据库变化或已经发生的外部操作。

<a id="quick-start"></a>
## 快速开始

先在一台电脑上运行完整的 Moco。需要 **Node.js ≥ 22.20.0** 和 **pnpm 11.25.0**，以下命令从源码仓库根目录执行：

```sh
pnpm install
cp .env.example .env
```

编辑 `.env`，为 `MOCO_AUTH_TOKEN` 设置独立的随机密钥，建议至少 32 个字符；将 `MOCO_MODEL`、`MOCO_BASE_URL`、`MOCO_API_KEY` 替换为自己的模型配置。也可以先清空这三个示例值，启动后再通过界面设置模型与凭据。环境变量配置项见 [.env.example](.env.example)。

```sh
pnpm build
node packages/cli/dist/bin.js open
```

`open` 会启动 Hub 与本机 Env，并打开已携带认证信息的浏览器页面，默认本地地址为 `http://localhost:7788`。完成模型配置后即可开始对话；需要操作指定目录时，为它创建项目。

在 **macOS 14 及以上**，还可以构建并安装当前机器架构的桌面开发版：

```sh
pnpm desktop:install --launch
```

安装的 `Moco Dev` 使用独立的配置与状态，不读取源码目录的 `.env`；首次打开时需要在应用中完成配置。开发时，`pnpm dev` 会构建并在交互式终端中打开 TUI，`pnpm desktop:dev` 会构建并启动桌面应用。

<a id="connect-devices"></a>
## 接入更多设备

打开「设置 → 设备互联 → 添加设备」，将生成的配对安装命令放到目标设备执行，也可以使用 SSH 辅助部署。每个 Env 使用独立的节点凭据，Hub 管理密钥只供客户端与管理操作使用。

目标设备已有源码构建时，也可以使用：

```sh
node packages/cli/dist/bin.js join --hub <hub-address> --invite <invitation>
```

将占位参数替换为邀请提供的地址与凭据，并确保设备能访问 Hub。配对后，`open` 或 `dev` 会使用保存的连接。设备上线后，再为它配置允许执行的能力，并绑定项目与授权目录。目标设备离线时，Moco 会如实报告，不会暗中改到其他设备执行。

<a id="capabilities"></a>
## 按需组合能力

| 能力 | 用途 | 配置方式 |
| --- | --- | --- |
| 模型与角色 | 为主 Agent 和不同 Worker 选择模型 | 配置供应商、模型与凭据 |
| Skills 与 MCP | 接入技能、工具和外部服务 | 安装所需技能或配置 MCP 连接 |
| 浏览器与桌面操作 | 在授权设备上操作网页与应用、查看执行画面 | 默认启用，仍需运行依赖与系统授权；可用 `MOCO_COMPUTER_USE` 按设备调整或关闭 |
| 外部 Agent | 派发 Codex、Claude Code 任务 | 在执行设备安装并配置相应 Agent |
| 项目与工作目录 | 组织相关话题、文件和任务 | 为项目选择设备与工作目录 |
| 生成式 UI 与产物 | 展示可交互内容，由主 Agent 检查后交付 | 随任务在对话中使用 |
| 语音与 Live | 语音输入、播报与实时通话 | 配置相应语音或 Live 服务 |
| 图片与视频生成 | 在任务中生成视觉内容 | 配置相应服务与模型，或执行设备上的浏览器会话 |
| 可选长期记忆 | 保存与检索私有和共享知识 | 部署并连接 Hindsight |
| 可选长上下文扩展 | 使用受管的长上下文压缩能力 | 按需启用 Billion Context / acp-kernel |
| 定时任务 | 在指定时间执行一次或定期运行 | 通过对话安排 |

Billion Context 扩展默认关闭；启用后仍由 Pi Durable 管理压缩流程。各项能力按需配置，模型和外部服务可能需要你自己的账号或凭据。

浏览器操作需要 Chrome 或 Chromium。源码部署的执行设备可以运行以下命令安装浏览器运行环境：

```sh
pnpm --filter @moco/env exec agent-browser install
```

<a id="platforms"></a>
## 平台支持

| 入口或组件 | 当前范围 |
| --- | --- |
| Web 客户端 | 电脑、手机和平板上的现代浏览器 |
| macOS 桌面版 | macOS 14+，可从源码构建本机架构开发版 |
| Hub | Node.js 服务；执行任务还需具备可用的 Env |
| macOS Env | 本机隔离执行，电脑操作需要相应系统授权 |
| Linux / Windows Env | 可连接执行节点；需配置对应平台的隔离后端和运行依赖 |

内置 Worker 需要可用的系统隔离后端。浏览器与桌面自动化的可用范围取决于执行设备；桌面操作需要可用的交互式图形会话，无图形桌面的服务器适合运行不依赖桌面的任务。目前桌面应用的打包脚本面向 macOS。

<a id="faq"></a>
## 常见问题

**必须准备多台设备吗？**

不需要。单机可以同时运行 Hub 和本地 Env，之后再添加设备。

**自建意味着模型也在本地运行吗？**

Hub 和会话状态由你托管，模型运行位置取决于配置。使用云端模型或外部工具时，相关请求会发送给对应服务。

**为什么在手机打开页面后无法录音或使用 Live？**

录音和 Live 需要 HTTPS 或 `localhost` 安全上下文，以及浏览器的麦克风权限。局域网中的普通 HTTP IP 地址不满足这一要求。

<a id="development"></a>
## 开发与贡献

仓库使用 TypeScript 和 pnpm workspace：

| 模块 | 职责 |
| --- | --- |
| [packages/hub](packages/hub) | 主 Agent、任务协调、HTTP / WebSocket 服务与状态存储 |
| [packages/env](packages/env) | 执行环境与设备连接 |
| [packages/web](packages/web) | React Web 界面 |
| [packages/desktop](packages/desktop) | Electron 桌面外壳与打包 |
| [packages/cli](packages/cli) | 命令行入口 |
| [packages/protocol](packages/protocol) | 共享类型与协议 |
| [packages/recovery](packages/recovery) | 版本验证与独立恢复运行时 |
| [integrations/hindsight](integrations/hindsight) | 双 Bank 记忆授权扩展 |

```sh
pnpm typecheck
pnpm build
pnpm test
```

修改 Hindsight 集成时，还需安装 `uv` 并运行 Python 测试：

```sh
pnpm test:hindsight
```

欢迎提交问题、改进建议和 Pull Request。问题报告请附复现步骤与脱敏日志；贡献代码时说明行为变化，完成相关验证，并保持中英文 README 同步。版本变化见 [CHANGELOG](CHANGELOG.md)。

<a id="acknowledgements"></a>
## 致谢

Moco 建立在开源项目与社区分享之上，感谢：

- [Pi](https://github.com/earendil-works/pi)：Pi Durable、Pi Env、Pi AI、Pi Schema 和 Chord，为持久 Agent、模型接入与执行环境提供基础。
- Vercel Labs 的 [json-render](https://github.com/vercel-labs/json-render)、[skills](https://github.com/vercel-labs/skills)、[agent-skills](https://github.com/vercel-labs/agent-skills)、[agent-browser](https://github.com/vercel-labs/agent-browser) 与 [agent-desktop](https://github.com/vercel-labs/agent-desktop)：提供生成式 UI、技能与电脑操作能力。
- Moco 使用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 与 [Billion Context](https://github.com/ranxianglei/billion-context) 提供可选的长上下文与压缩扩展。
- [Hindsight](https://github.com/vectorize-io/hindsight)：提供长期记忆能力。
- [HeroUI](https://github.com/heroui-inc/heroui)：提供界面组件。
- [LINUX DO](https://linux.do/)：感谢论坛中的交流、探索和知识分享。

更多依赖及许可信息见 [第三方许可声明](THIRD_PARTY_NOTICES.md)。

<a id="license"></a>
## 开源协议

Moco 自有代码采用 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**，完整条款见 [LICENSE](LICENSE)。第三方依赖、随附技能与其他第三方材料保留各自的许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

<a id="star-history"></a>
## Star History

> Star 趋势图待补充：仓库公开后接入真实数据。

嵌入方式见 [Star History 官方说明](https://www.star-history.com/blog/how-to-use-github-star-history/#how-to-embed-the-chart-in-your-readme)。

<!-- 确定公开仓库地址后，在此添加对应仓库的 Star History 图。 -->
