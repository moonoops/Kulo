import { openTestHub } from "./helpers/secure-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import WebSocket from "ws";
import { MocoEnvAgent } from "@moco/env";
import { MocoHub, startMocoHubServer } from "@moco/hub";
import { traceTicketTransitions } from "./helpers/ticket-trace.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `moco-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function isOrchestratorContext(ctx: TranscriptContext): boolean {
  if (ctx.tools?.some((t) => t.name === "moco_dispatch")) return true;
  return ctx.messages.some(
    (m) =>
      m.role === "system" &&
      "toolsAdded" in m &&
      Array.isArray(m.toolsAdded) &&
      m.toolsAdded.some((t) => t.name === "moco_dispatch"),
  );
}

async function waitForCondition(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 12_000,
  intervalMs = 60,
  diagnose?: () => Promise<unknown>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const detail = diagnose ? `: ${JSON.stringify(await diagnose())}` : "";
  throw new Error(`Condition not met within ${timeoutMs}ms${detail}`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup race
    }
  }
});

describe("Moco Hub + Pi Env End-to-End Suite", () => {
  it("1. dispatches at millisecond zero, runs CodingTools on local Pi Env, and relays result back to Moco", async () => {
    const stateDir = makeTempDir("local-duplex");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let workerStep = 0;

    faux.setResponses(
      Array.from({ length: 12 }, () => (ctx) => {
        if (isOrchestratorContext(ctx)) {
          const allUserTexts = ctx.messages
            .filter((m) => m.role === "user")
            .map((m) =>
              typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            )
            .join("\n");
          if (allUserTexts.includes("[MOCO_WORKER_RELAY]")) {
            return fauxAssistantMessage([
              fauxText("后台脚本已经写好并校验通过了，随时可以用。"),
            ]);
          }
          const hasDispatched = ctx.messages.some((m) => m.role === "toolResult");
          if (hasDispatched) {
            return fauxAssistantMessage([
              fauxText("已经安排工程师在后台创建并验证脚本，你先忙别的。"),
            ]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("moco_dispatch", {
                command_id: "cmd-hello-1",
                title: "生成问候配置并校验",
                goal: "写入 greeting.txt 并用 bash 验证内容",
                scope: "仅限当前工单隔离目录",
                role: "engineer",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        // Worker conversation steps
        workerStep++;
        if (workerStep === 1) {
          return fauxAssistantMessage(
            [
              fauxToolCall("write", {
                path: "greeting.txt",
                content: "Hello from Moco Pi Env!\n",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (workerStep === 2) {
          return fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: "cat greeting.txt",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage(
          [
            fauxToolCall("moco_report", {
              state: "ready",
              summary: "已创建 greeting.txt 并经 bash 读取校验一致。",
              deliverable: "greeting.txt",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      config: {
        stateDir,
        model: {
          baseUrl: "http://localhost",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "off",
        },
      },
      models,
    });

    try {
      const sub = await hub.sendUserMessage("帮我写一个 greeting.txt 并验证内容");
      const settled = await sub.wait(BACKGROUND_CONTEXT);
      expect(settled.status).toBe("done");

      // Wait for background worker ticket to reach "ready" and relay back to Moco
      await waitForCondition(async () => {
        const snap = await hub.getFullClientSnapshot();
        const ticket = snap.tickets[0];
        const hasRelayAnswer = snap.messages.some((m) =>
          m.text.includes("后台脚本已经写好并校验通过了"),
        );
        return ticket?.status === "ready" && hasRelayAnswer;
      });

      const board = await hub.getBoardSnapshot();
      expect(board.tickets).toHaveLength(1);
      expect(board.tickets[0]!.status).toBe("ready");
      expect(board.slots.used).toBe(0);

      const createdFile = path.join(board.tickets[0]!.workspaceDir, "greeting.txt");
      expect(fs.existsSync(createdFile)).toBe(true);
      expect(fs.readFileSync(createdFile, "utf8")).toBe("Hello from Moco Pi Env!\n");
    } finally {
      await hub.close();
    }
  });

  it("2. executes Worker tools on a decoupled remote MocoEnvAgent connected over WebSocket (/ws/env)", async () => {
    const hubStateDir = makeTempDir("remote-hub");
    const remoteLaptopDir = makeTempDir("remote-laptop-env");

    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let workerRound = 0;
    faux.setResponses(
      Array.from({ length: 10 }, () => (ctx) => {
        if (isOrchestratorContext(ctx)) {
          return fauxAssistantMessage([fauxText("远程笔记本节点上的文件已处理完成。")]);
        }
        workerRound++;
        if (workerRound === 1) {
          return fauxAssistantMessage(
            [
              fauxToolCall("write", {
                path: "laptop-note.md",
                content: "# Executed on Remote Laptop via Pi Env WS Tunnel\n",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (workerRound === 2) {
          return fauxAssistantMessage(
            [
              fauxToolCall("edit", {
                path: "laptop-note.md",
                edits: [
                  {
                    oldText: "WS Tunnel",
                    newText: "Reverse WebSocket Tunnel (Verified)",
                  },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage(
          [
            fauxToolCall("moco_report", {
              state: "ready",
              summary: "已在远程 macbook 节点完成写入与局部编辑。",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      config: {
        stateDir: hubStateDir,
        host: "127.0.0.1",
        port: 0,
        authToken: "secret-test-token",
        envTokens: { "macbook-pro": "remote-node-test-token" },
        workerEnvIds: ["macbook-pro"],
        enableLocalEnv: false,
        model: {
          baseUrl: "http://localhost",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "off",
        },
      },
      models,
    });

    const server = await startMocoHubServer(hub, { host: "127.0.0.1", port: 0 });
    const remoteEnv = new MocoEnvAgent({
      hubUrl: server.envWsUrl,
      envId: "macbook-pro",
      name: "Roaming MacBook Pro",
      rootDir: remoteLaptopDir,
      authToken: "remote-node-test-token",
    });

    try {
      await remoteEnv.start();

      const envs = hub.envManager.listEnvs();
      expect(envs).toHaveLength(1);
      expect(envs[0]!.id).toBe("macbook-pro");
      expect(envs[0]!.online).toBe(true);

      const clientWs = new WebSocket(`${server.clientWsUrl}?token=secret-test-token`);
      const firstMsg = await new Promise<{ type: string }>((resolve, reject) => {
        clientWs.once("message", (raw) => resolve(JSON.parse(raw.toString("utf8"))));
        clientWs.once("error", reject);
      });
      expect(firstMsg.type).toBe("hub.snapshot");
      clientWs.close();

      const card = await hub.dispatchTicket({
        commandId: "cmd-remote-1",
        title: "修改远程笔记本本地笔记",
        goal: "在远程节点写入并编辑 laptop-note.md",
        scope: "仅限工单目录",
        role: "writer",
        envId: "macbook-pro",
      });

      expect(card.envId).toBe("macbook-pro");
      expect(card.workspaceDir.startsWith(remoteLaptopDir)).toBe(true);

      await waitForCondition(async () => {
        const detail = await hub.inspectTicketDetail(card.id);
        return detail.ticket.status === "ready";
      });

      const remoteFile = path.join(card.workspaceDir, "laptop-note.md");
      expect(fs.existsSync(remoteFile)).toBe(true);
      expect(fs.readFileSync(remoteFile, "utf8")).toContain(
        "Reverse WebSocket Tunnel (Verified)",
      );
    } finally {
      await remoteEnv.stop();
      await server.close();
      await hub.close();
    }
  });

  it("3. enforces safety hooks, parks for user confirmation, resumes on steer, and honors explicit human stop", async () => {
    const stateDir = makeTempDir("steer-and-safety");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let workerCall = 0;
    faux.setResponses(
      Array.from({ length: 12 }, () => (ctx) => {
        if (isOrchestratorContext(ctx)) {
          return fauxAssistantMessage([fauxText("收到回执。")]);
        }

        workerCall++;
        if (workerCall === 1) {
          return fauxAssistantMessage(
            [fauxToolCall("bash", { command: "rm -rf /" })],
            { stopReason: "toolUse" },
          );
        }
        if (workerCall === 2) {
          const lastToolMsg = ctx.messages[ctx.messages.length - 1];
          const text =
            lastToolMsg?.role === "toolResult"
              ? JSON.stringify(lastToolMsg.content)
              : "";
          expect(text).toContain("Blocked high-risk shell command");

          return fauxAssistantMessage(
            [
              fauxToolCall("moco_report", {
                state: "blocked",
                summary: "端口配置存在歧义",
                question: "请问服务端口使用 8080 还是 9090？",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        return fauxAssistantMessage(
          [
            fauxToolCall("moco_report", {
              state: "ready",
              summary: "已按你确认的 9090 端口完成配置。",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      config: {
        stateDir,
        model: {
          baseUrl: "http://localhost",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "off",
        },
      },
      models,
    });
    let ticketTrace: ReturnType<typeof traceTicketTransitions> | undefined;

    try {
      const card = await hub.dispatchTicket({
        commandId: "cmd-safety-1",
        title: "配置服务监听端口",
        goal: "完成端口配置",
        scope: "当前工单目录",
        role: "engineer",
      });
      ticketTrace = traceTicketTransitions(hub, card.id);
      const diagnose = async () => {
        const { ticket, live } = await hub.inspectTicketDetail(card.id);
        return { status: ticket.status, waiting: ticket.waiting, latestReport: ticket.latestReport, runEpoch: ticket.runEpoch, live, workerCall, trace: ticketTrace?.events };
      };

      await waitForCondition(async () => {
        const board = await hub.getBoardSnapshot();
        return board.tickets[0]?.status === "waiting" && board.tickets[0]?.waiting?.reason === "user" && board.slots.used === 0;
      }, 12_000, 60, diagnose);

      const blockedBoard = await hub.getBoardSnapshot();
      expect(blockedBoard.tickets[0]!.latestReport?.question).toContain("9090");
      const pausedEpoch = (await hub.inspectTicketDetail(card.id)).ticket.runEpoch;

      await hub.steerTicket({
        commandId: "steer-answer-9090",
        ticketId: card.id,
        text: "请使用 9090 端口",
      });

      await waitForCondition(async () => {
        const detail = await hub.inspectTicketDetail(card.id);
        return detail.ticket.status === "ready" && detail.ticket.runEpoch === pausedEpoch + 1;
      }, 12_000, 60, diagnose);

      const card2 = await hub.dispatchTicket({
        commandId: "cmd-stop-test",
        title: "待停止的测试工单",
        goal: "测试人工停止",
        scope: "当前目录",
      });
      await hub.stopTicket(card2.id, "用户取消");
      await expect(
        hub.steerTicket({
          commandId: "steer-after-stop",
          ticketId: card2.id,
          text: "继续跑",
        }),
      ).rejects.toThrow(/stopped/);
    } finally {
      ticketTrace?.stop();
      await hub.close();
    }
  });

  it("4. bounds concurrency with single maxConcurrentWorkers pool and drains queued tickets in FIFO order", async () => {
    const stateDir = makeTempDir("slot-bounding");
    const faux = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    faux.setResponses(
      Array.from({ length: 16 }, () => (ctx) => {
        if (isOrchestratorContext(ctx)) {
          return fauxAssistantMessage([fauxText("已全部完成。")]);
        }
        return fauxAssistantMessage(
          [
            fauxToolCall("moco_report", {
              state: "ready",
              summary: "槽位任务执行完成",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      config: {
        stateDir,
        maxConcurrentWorkers: 1,
        model: {
          baseUrl: "http://localhost",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "off",
        },
      },
      models,
    });

    let maxObservedUsed = 0;
    const unsub = hub.subscribe({
      onTickets: (_tickets, slots) => {
        if (slots.used > maxObservedUsed) maxObservedUsed = slots.used;
      },
    });

    try {
      const [t1, t2, t3] = await Promise.all([
        hub.dispatchTicket({
          commandId: "slot-1",
          title: "队列任务一",
          goal: "任务1",
          scope: "目录1",
        }),
        hub.dispatchTicket({
          commandId: "slot-2",
          title: "队列任务二",
          goal: "任务2",
          scope: "目录2",
        }),
        hub.dispatchTicket({
          commandId: "slot-3",
          title: "队列任务三",
          goal: "任务3",
          scope: "目录3",
        }),
      ]);

      await waitForCondition(async () => {
        const board = await hub.getBoardSnapshot();
        return (
          board.tickets.length === 3 &&
          board.tickets.every((t) => t.status === "ready") &&
          board.slots.used === 0 &&
          board.slots.max === 1
        );
      });

      expect(maxObservedUsed).toBeLessThanOrEqual(1);
      const board = await hub.getBoardSnapshot();
      expect(board.tickets.map((t) => t.id).sort()).toEqual(
        [t1.id, t2.id, t3.id].sort(),
      );
    } finally {
      unsub();
      await hub.close();
    }
  });

  it("5. persists conversations and tickets in SQLite across full Hub restarts", async () => {
    const stateDir = makeTempDir("sqlite-persistence");

    {
      const faux1 = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
      const models1 = createModels();
      models1.setProvider(faux1.provider);
      faux1.setResponses(
        Array.from({ length: 10 }, () => (ctx) => {
          if (isOrchestratorContext(ctx)) {
            const allUserTexts = ctx.messages
              .filter((m) => m.role === "user")
              .map((m) =>
                typeof m.content === "string" ? m.content : JSON.stringify(m.content),
              )
              .join("\n");
            if (allUserTexts.includes("[MOCO_WORKER_RELAY]")) {
              return fauxAssistantMessage([fauxText("持久化任务也已完成。")]);
            }
            return fauxAssistantMessage([fauxText("你好！我是 Moco，状态已写入 SQLite。")]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("moco_report", {
                state: "ready",
                summary: "持久化验证任务已完成",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }),
      );

      const hub1 = await openTestHub({
        config: {
          stateDir,
          model: {
            baseUrl: "http://localhost",
            apiMode: "openai-completions",
            defaultModel: "gpt-4o",
            thinkingLevel: "off",
          },
        },
        models: models1,
      });

      const sub = await hub1.sendUserMessage("测试持久化记忆");
      await sub.wait(BACKGROUND_CONTEXT);

      const card = await hub1.dispatchTicket({
        commandId: "cmd-persist-1",
        title: "验证重启后工单留存",
        goal: "完成持久化校验",
        scope: "工单目录",
      });

      await waitForCondition(async () => {
        const snap = await hub1.getFullClientSnapshot();
        const ready = snap.tickets.some((t) => t.id === card.id && t.status === "ready");
        const relayed = snap.messages.some((m) => m.text.includes("持久化任务也已完成"));
        return ready && relayed;
      });

      await hub1.close();
    }

    // Reopen a fresh MocoHub instance on the exact same SQLite directory!
    {
      const faux2 = fauxProvider({ provider: "openai", models: [{ id: "gpt-4o" }] });
      const models2 = createModels();
      models2.setProvider(faux2.provider);

      const hub2 = await openTestHub({
        config: {
          stateDir,
          model: {
            baseUrl: "http://localhost",
            apiMode: "openai-completions",
            defaultModel: "gpt-4o",
            thinkingLevel: "off",
          },
        },
        models: models2,
      });

      try {
        const snapshot = await hub2.getFullClientSnapshot();
        expect(
          snapshot.messages.some((m) => m.text.includes("我是 Moco，状态已写入 SQLite")),
        ).toBe(true);
        expect(
          snapshot.messages.some((m) => m.text.includes("持久化任务也已完成")),
        ).toBe(true);
        expect(snapshot.tickets).toHaveLength(1);
        expect(snapshot.tickets[0]!.id).toBe("T-0001");
        expect(snapshot.tickets[0]!.status).toBe("ready");
        expect(snapshot.tickets[0]!.latestReport?.summary).toBe("持久化验证任务已完成");
      } finally {
        await hub2.close();
      }
    }
  });

  it("6. resolves role thinkingLevel='auto' from moco_dispatch and runs silent WorkerWatchdog + moco_inspect", async () => {
    const stateDir = makeTempDir("watchdog-auto-thinking");
    const faux = fauxProvider({
      provider: "openai",
      models: [{ id: "gpt-4o", reasoning: true }],
    });
    const models = createModels();
    models.setProvider(faux.provider);

    let observedWorkerReasoning: string | undefined;
    let inspectCalled = false;
    let releaseStalledWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseStalledWorker = resolve;
    });

    const extractMsgText = (m: TranscriptContext["messages"][number]): string => {
      if (!("content" in m)) return "";
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((c) =>
            c && typeof c === "object" && "text" in c && typeof c.text === "string"
              ? c.text
              : "",
          )
          .join(" ");
      }
      return "";
    };

    const handler = async (
      ctx: TranscriptContext,
      opts: { reasoning?: string } | undefined,
    ) => {
      if (isOrchestratorContext(ctx)) {
        let lastUserIdx = -1;
        for (let i = ctx.messages.length - 1; i >= 0; i--) {
          if (ctx.messages[i]?.role === "user") {
            lastUserIdx = i;
            break;
          }
        }
        const lastUserText = lastUserIdx >= 0 ? extractMsgText(ctx.messages[lastUserIdx]!) : "";
        const afterUserTools = ctx.messages
          .slice(lastUserIdx + 1)
          .filter((m) => m.role === "toolResult")
          .map((m) => (m as { toolName?: string }).toolName);

        if (lastUserText.includes("[MOCO_WORKER_WATCHDOG]")) {
          if (!afterUserTools.includes("moco_inspect")) {
            return fauxAssistantMessage(
              [fauxToolCall("moco_inspect", { ticket_id: "T-0001" })],
              { stopReason: "toolUse" },
            );
          }
          inspectCalled = true;
          releaseStalledWorker();
          return fauxAssistantMessage([fauxText("[WATCHDOG_OK]")]);
        }

        if (lastUserText.includes("[MOCO_WORKER_RELAY]")) {
          return fauxAssistantMessage([fauxText("后台耗时构建已经顺利完成了。")]);
        }

        if (!afterUserTools.includes("moco_dispatch")) {
          return fauxAssistantMessage(
            [
              fauxToolCall("moco_dispatch", {
                command_id: "wd-1",
                title: "耗时构建检查",
                goal: "模拟耗时操作",
                scope: "工单目录",
                role: "engineer",
                thinking_level: "high",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        return fauxAssistantMessage([fauxText("已安排工程师在后台执行构建。")]);
      }

      const reported = ctx.messages.some(
        (m) =>
          m.role === "toolResult" &&
          (m as { toolName?: string }).toolName === "moco_report",
      );
      if (!reported) {
        observedWorkerReasoning = opts?.reasoning;
        await workerGate;
        return fauxAssistantMessage(
          [
            fauxToolCall("moco_report", {
              state: "ready",
              summary: "耗时构建已完成",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }

      return fauxAssistantMessage([fauxText("构建结束。")]);
    };

    faux.setResponses(Array.from({ length: 14 }, () => handler));

    const hub = await openTestHub({
      config: {
        stateDir,
        watchdogMinutes: 5,
        model: {
          baseUrl: "http://localhost",
          apiMode: "openai-completions",
          defaultModel: "gpt-4o",
          thinkingLevel: "low",
        },
      },
      models,
      watchdogCheckIntervalMs: 60,
      watchdogStallMsOverride: 140,
    });

    try {
      await hub.sendUserMessage("帮我跑一下耗时构建");

      await waitForCondition(async () => {
        const board = await hub.getBoardSnapshot();
        const rootView = await hub.getTopicView("root");
        return (
          inspectCalled &&
          board.tickets[0]?.status === "ready" &&
          rootView.messages.some((m) => m.text.includes("后台耗时构建已经顺利完成了"))
        );
      });

      expect(observedWorkerReasoning).toBe("high");

      const detail = await hub.inspectWorker("T-0001");
      expect(detail.ticketId).toBe("T-0001");
      expect(detail.status).toBe("ready");
      expect(detail.recentEntries.length).toBeGreaterThan(0);

      const rootView = await hub.getTopicView("root");
      expect(
        rootView.messages.some((m) => m.text.includes("[MOCO_WORKER_WATCHDOG]")),
      ).toBe(false);
      expect(
        rootView.messages.some((m) => m.text.trim() === "[WATCHDOG_OK]"),
      ).toBe(false);
      expect(
        rootView.messages.some((m) => m.text.includes("后台耗时构建已经顺利完成了")),
      ).toBe(true);
    } finally {
      releaseStalledWorker();
      await hub.close();
    }
  });
});
