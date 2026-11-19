<p align="center">
  <img src="packages/web/public/moco-icon.png" width="96" alt="Moco">
</p>

<h1 align="center">Moco</h1>

<p align="center"><strong>Your always-on agent, across devices.</strong></p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPLv3-blue" alt="License: AGPLv3"></a>
  <img src="https://img.shields.io/badge/deployment-self--hosted-brightgreen" alt="Self-hosted">
</p>

<!-- Add repository-specific Release and Stars badges once the public repository URL is set. Add a CI badge when a workflow exists. -->

Moco is a self-hosted personal agent that stays available across your devices. You keep talking to the same Moco: it maintains your shared working relationship, coordinates agents on different machines, and brings their results back to the conversation. Text, voice, interactive interfaces, and background tasks work together in one place.

[Multiple devices](#multi-device) · [SuperAgent](#superagent) · [Multimodal interaction](#multimodal) · [Memory and sharing](#memory) · [Customization and recovery](#customization) · [Quick start](#quick-start)

> Screenshot placeholder: the main conversation, topic list, task progress, and connected devices.

<a id="multi-device"></a>
## One Moco, multiple devices

Run a Host on your computer or server, then connect other devices. The Host's **Hub** runs the main agent, manages conversations and tasks, and stores their state. Each Device's **Env** provides an environment where tasks actually run.

```text
Web / desktop / terminal clients
               |
        Host · Moco Hub
     Main agent / conversations / tasks
               |
       +-------+-------+
    Local Env  Device A  Device B
     Files     Browser  Dev tools
```

The device you use to talk to Moco can be different from the one doing the work. Ask from your phone, have a Worker organize files on your computer, and delegate a coding task to another machine. A Host can also run its own local Env, so you can start on one computer and add devices later.

Moco builds on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) for persistent agent sessions, [Pi Env](https://github.com/earendil-works/pi/tree/main/packages/env) for execution environments, and [Pi AI](https://github.com/earendil-works/pi/tree/main/packages/ai) for model access. Multiple clients connect to the same Hub and share the same Moco.

<a id="superagent"></a>
## SuperAgent: keep talking to the same Moco

### Different topics, the same agent

The main agent is your ongoing point of contact. It understands your requests, arranges work, follows progress, and reports back. Creating a topic opens another discussion space while keeping the same identity, relationship, and coordinating role. Each topic retains its own messages and task context.

You might plan a trip in one topic and develop a project in another. Switching topics leaves dispatched work running, with results returned to the relevant topic. Moco draws on its shared identity and memory, the current topic, and permitted history retrieval to continue the conversation. Topic histories remain separate and are retrieved within their allowed scope.

### Add a thought while work is in progress

You can send another message while Moco is thinking, replying, or waiting for a Worker. Add a constraint, correct the direction, ask for progress, or move on to another subject. New messages are picked up at subsequent processing boundaries; an in-flight tool operation may finish before a change takes effect.

For example, ask Codex to fix a login problem, then add a requirement to preserve an existing API. Moco can pass that guidance to the running task. You can discuss the release plan in another topic while it continues, then return to the original topic for Moco's reviewed result. Ask explicitly to stop a task when you want to cancel it; changing topics does not cancel work.

### A main agent with a team behind it

Moco can split complex work among Workers with different roles, models, and devices. You do not have to manage a separate conversation with every agent or assemble their answers yourself.

```text
You ask, add context, or change direction
                    |
          Moco coordinates the work
                    |
    Built-in Workers / Codex / Claude Code
                    |
       Work runs on the selected device
                    |
       Moco reviews and delivers results
```

Alongside built-in Workers, Moco can delegate to external agents such as Codex and Claude Code. They use their native clients, accounts, tools, and permission settings, with task-scoped Moco tools available for reporting and authorized context. Install and authenticate the relevant client on the execution device before using it.

Worker artifacts are staged for the main agent to inspect before publication to the conversation. For staged code tasks, Moco can inspect the diff and apply the accepted changes. Progress updates, decisions that need your input, and final delivery all come through the main agent; task details remain available when you want to look closer.

> Demo placeholder: delegate a task → add a constraint mid-task → switch topics → review and receive the result from Moco.

<a id="multimodal"></a>
## Multimodal and generative conversation

Moco accepts text, images, audio, video, and files. Media understanding depends on the selected model and configured processing tools. Its replies can also take a form suited to the task.

**Generative UI** lets the agent produce tables, charts, forms, choices, and sliders inside the conversation. Compare options, adjust parameters, or submit a choice; the structured response goes back to the agent to continue the work. Interactive elements come from a registered component catalog. For more flexible presentation, Moco can also deliver HTML artifacts in an isolated preview.

> Generative UI demo placeholder: compare options in a chart, adjust a form, and continue the conversation.

**Full-duplex Live conversation** supports real-time voice, captions, and interruption. A Live session can use the current topic's context, hand work to the main agent, and receive task updates. Hanging up leaves already-dispatched tasks running. Configure a supported Live service before starting a call.

> Live demo placeholder: talk → interrupt and clarify → delegate work → receive an update.

<a id="memory"></a>
## Memory across topics, sharing with boundaries

Moco stores conversation and task state in local SQLite on the Host, alongside its identity, relationship, and recent-work context. The main agent can retrieve permitted history from the current topic or other topics in the same project. Stored records make continuity possible; retrieval and context selection determine what the agent uses in a particular reply.

For longer-term semantic memory, enable the optional **Hindsight dual-bank integration**:

| Memory bank | Main agent | Worker |
| --- | --- | --- |
| Private bank | Read and write | No access |
| Shared bank | Read only | Read and write |

Private memory supports your ongoing relationship with Moco. Shared memory holds project knowledge and work reports. Workers can recall relevant project knowledge when starting a task and retain their reports afterward, so later Workers can build on that experience. External agents receive authorized shared-memory access through task-scoped tools.

Separate credentials and server-side authorization enforce these roles. The two banks may live in the same Hindsight service and database; isolation relies on authorization rules together with the device, file, and credential permissions around them.

Hindsight is disabled by default, and Moco works without it. See the [Hindsight integration guide](integrations/hindsight/README.md) for deployment and authorization details.

<a id="customization"></a>
## Configure through conversation, customize with a recovery path

Ask the main agent to configure capabilities, change settings, or combine tools into a workflow. For interface customization, the macOS desktop app provides a managed Web UI modification process: prepare a separate candidate, build and validate it, schedule it for the next launch, and check that the new interface becomes ready. A failed launch can fall back to a compatible local version.

An independent rescue tool, `moco-rescue`, remains available outside the main interface. It can inspect the installation, roll back an application version, and export diagnostic information for a third-party agent of your choice to investigate. Managed source customization currently covers the desktop Web interface. Recovery changes the application version; it does not undo database changes or actions already performed in external systems.

<a id="quick-start"></a>
## Quick start

Start with a complete Moco installation on one computer. You need **Node.js ≥ 22.20.0** and **pnpm 11.25.0**. Run these commands from the source repository root:

```sh
pnpm install
cp .env.example .env
```

Edit `.env` and set `MOCO_AUTH_TOKEN` to a unique random secret; at least 32 characters is recommended. Replace the example `MOCO_BASE_URL`, `MOCO_API_KEY`, and `MOCO_MODEL` values with your provider settings, or clear those example values and configure the model in the interface after launch. See [.env.example](.env.example) for available options.

```sh
pnpm build
node packages/cli/dist/bin.js open
```

`open` starts the Hub and local Env, then opens an authenticated browser page. The default local address is `http://localhost:7788`. Configure a model, add a project when you need work in a specific directory, and start a conversation.

On **macOS 14 or later**, you can also build and install the desktop development app for your machine's architecture:

```sh
pnpm desktop:install --launch
```

The desktop development app, **Moco Dev**, has its own settings and data, separate from the source CLI's `.env`. Configure it through the app. For development, `pnpm dev` builds and opens the TUI in an interactive terminal; `pnpm desktop:dev` builds and starts the desktop app.

<a id="connect-devices"></a>
## Connect more devices

Open **Settings → Device interconnection → Add device**, then run the generated installation and pairing command on the target device. SSH-assisted deployment is also available. Each Env uses its own node credentials; the Hub's management token is reserved for clients and administration.

If you have already built Moco from source on the target device, you can use:

```sh
node packages/cli/dist/bin.js join --hub <host-address> --invite <invitation>
```

Replace the placeholders with the invitation's address and credentials, and ensure the device can reach the Host. After pairing, `open` or `dev` uses the saved connection. Associate a project with the device and an authorized working directory. When a target is offline, Moco reports it instead of silently running the task elsewhere.

<a id="capabilities"></a>
## Add capabilities as you need them

| Capability | Setup and use |
| --- | --- |
| Models and roles | Choose the main agent's model and configure Worker roles in settings. |
| External agents | Install and authenticate the client on its device, then add its connection and roles. |
| Skills and MCP | Discover skills and connect tools or services for the work you do. |
| Browser and desktop operation | Available by default on execution devices; install the required runtime and grant OS permissions. Use `MOCO_COMPUTER_USE` to select or disable these capabilities per device. |
| Projects and working directories | Associate topics, files, and tasks with a project on a selected device. |
| Generative UI and artifacts | Interact with generated content in the conversation and receive reviewed deliverables. |
| Live voice | Configure the Live provider, model, credentials, and voice in call settings. |
| Images and video | Configure the relevant service and model or a browser session on the execution device. |
| Long-term memory | Configure Hindsight locally or connect an existing compatible service. |
| Long-context extension | Optionally enable the managed Billion Context / acp-kernel integration. |
| Scheduled work | Ask Moco to arrange a one-time or recurring task. |

Billion Context is disabled by default; Pi Durable remains responsible for the compression lifecycle when the extension is enabled. Model providers and external services may require your own accounts or credentials.

Browser automation needs Chrome or Chromium. To install the browser runtime on a source-based execution device:

```sh
pnpm --filter @moco/env exec agent-browser install
```

<a id="platforms"></a>
## Platform support

| Entry point or component | Current scope |
| --- | --- |
| Web client | Modern browsers on computers, phones, and tablets. |
| macOS desktop app | macOS 14+; source builds target the current machine's architecture. |
| Hub | Node.js service; task execution also needs a working Env. |
| macOS Env | Local isolated execution; computer operation needs the appropriate OS permissions. |
| Linux / Windows Env | Execution nodes with the platform's isolation backend and runtime dependencies configured. |

Built-in Worker execution requires its supported isolation backend. Browser and desktop automation depend on the execution device; desktop operation needs an interactive graphical session. Headless servers are suitable for tasks that do not require a desktop. The desktop app's packaging scripts currently target macOS.

<a id="faq"></a>
## FAQ

**Do I need multiple devices?**

No. One computer can run the Hub and local Env. Add other devices when you need them.

**Does self-hosting mean the model runs locally?**

You host the Hub and conversation state. Where inference happens depends on your configuration. Cloud models and external tools send the relevant requests to their respective services.

**Why can't I record audio or start Live from my phone?**

Recording and Live need an HTTPS or `localhost` secure context and microphone permission. A plain HTTP LAN IP address does not meet that requirement.

<a id="development"></a>
## Development and contributions

Moco uses TypeScript and pnpm workspaces.

| Directory | Responsibility |
| --- | --- |
| `packages/hub` | Main agent, orchestration, HTTP/WS service, and persistent state. |
| `packages/env` | Execution nodes, devices, and external agent clients. |
| `packages/web` | React conversation and settings interface. |
| `packages/desktop` | Electron desktop shell and packaging. |
| `packages/cli` | CLI and terminal interface. |
| `packages/protocol` | Shared types and schemas. |
| `packages/recovery` | Release verification and independent rescue runtime. |
| `integrations/hindsight` | Dual-bank memory authorization extension. |

```sh
pnpm typecheck
pnpm build
pnpm test
```

Changes to the Hindsight integration also require its Python tests, using `uv`:

```sh
pnpm test:hindsight
```

Issues, suggestions, and pull requests are welcome. Include reproduction steps and redacted diagnostics in bug reports. Explain the behavior changed by a contribution, run the relevant checks, and keep the English and Chinese READMEs in sync.

See the [changelog](CHANGELOG.md), [configuration example](.env.example), [Hindsight guide](integrations/hindsight/README.md), and [third-party notices](THIRD_PARTY_NOTICES.md) for more detail.

<a id="acknowledgements"></a>
## Acknowledgements

Moco builds on open-source projects and knowledge shared by their communities. Thank you to:

- [Pi](https://github.com/earendil-works/pi): Pi Durable, Pi Env, Pi AI, Pi Schema, and Chord provide the foundations for persistent agents, model access, and execution environments.
- Vercel Labs: [json-render](https://github.com/vercel-labs/json-render), [skills](https://github.com/vercel-labs/skills), [agent-skills](https://github.com/vercel-labs/agent-skills), [agent-browser](https://github.com/vercel-labs/agent-browser), and [agent-desktop](https://github.com/vercel-labs/agent-desktop) support generative UI, skills, and computer operation.
- Moco uses [acp-kernel](https://github.com/ranxianglei/acp-kernel) and the [Billion Context](https://github.com/ranxianglei/billion-context) approach for its optional long-context and compression integration.
- [Hindsight](https://github.com/vectorize-io/hindsight) for long-term memory.
- [HeroUI](https://github.com/heroui-inc/heroui) for interface components.
- [LINUX DO](https://linux.do/) for the discussions, experiments, and knowledge shared by its community.

See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses and retained attributions.

<a id="license"></a>
## License

Moco's original code is licensed under the **GNU Affero General Public License v3.0 only (AGPL-3.0-only)**. See [LICENSE](LICENSE) for the full terms. Third-party dependencies, bundled skills, and other third-party materials retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<a id="star-history"></a>
## Star History

> Star chart placeholder: connect the public repository once its URL is available.

See the [official Star History embedding guide](https://www.star-history.com/blog/how-to-use-github-star-history/#how-to-embed-the-chart-in-your-readme).

<!-- Add the repository's Star History chart here once the public URL is set. -->
