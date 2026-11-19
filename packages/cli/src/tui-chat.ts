import readline from "node:readline";
import WebSocket from "ws";
import type {
  ChatDisplayItem,
  ClientToHubMessage,
  EnvNodeDescriptor,
  HubToClientMessage,
  SlotSummary,
  TicketCardView,
} from "@moco/protocol";

export interface TuiChatOptions {
  wsUrl: string;
  authToken?: string;
  onExit?: () => Promise<void> | void;
}

export async function runTuiChatClient(options: TuiChatOptions): Promise<void> {
  const ws = new WebSocket(options.wsUrl, options.authToken
    ? { headers: { Authorization: `Bearer ${options.authToken}` } }
    : {});
  let printedUpToId = 0;
  let latestTickets: TicketCardView[] = [];
  let latestSlots: SlotSummary | null = null;
  let latestEnvs: EnvNodeDescriptor[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36mmoco>\x1b[0m ",
  });

  const printLineAbovePrompt = (line: string) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${line}\n`);
    rl.prompt(true);
  };

  const renderNewMessages = (messages: ChatDisplayItem[], initial = false) => {
    for (const msg of messages) {
      if (msg.id <= printedUpToId) continue;
      printedUpToId = msg.id;
      if (initial && msg.role === "user") {
        printLineAbovePrompt(`\x1b[90m[你] ${msg.text}\x1b[0m`);
      } else if (msg.role === "assistant") {
        if (msg.toolCalls?.length) {
          const names = msg.toolCalls.map((t) => t.name).join(", ");
          printLineAbovePrompt(`\x1b[90m  ↳ 调用工具: ${names}\x1b[0m`);
        }
        if (msg.text) {
          printLineAbovePrompt(`\x1b[32mMoco:\x1b[0m ${msg.text}`);
        }
      } else if (msg.role === "relay") {
        printLineAbovePrompt(`\x1b[33m⚡ 后台回执: ${msg.text}\x1b[0m`);
      }
    }
  };

  ws.on("message", (raw) => {
    let msg: HubToClientMessage;
    try {
      msg = JSON.parse(raw.toString("utf8")) as HubToClientMessage;
    } catch {
      return;
    }

    if (msg.type === "hub.snapshot") {
      latestTickets = msg.tickets;
      latestSlots = msg.slots;
      latestEnvs = msg.envs;
      renderNewMessages(msg.messages, true);
    } else if (msg.type === "hub.messages") {
      renderNewMessages(msg.messages, false);
    } else if (msg.type === "hub.tickets") {
      latestTickets = msg.tickets;
      latestSlots = msg.slots;
    } else if (msg.type === "hub.envs") {
      latestEnvs = msg.envs;
    } else if (msg.type === "hub.error") {
      printLineAbovePrompt(`\x1b[31m[错误] ${msg.message}\x1b[0m`);
    }
  });

  const send = (payload: ClientToHubMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  process.stdout.write(
    "\n\x1b[1m已连接 Moco 准全双工终端\x1b[0m（输入内容直接对话；命令: /tickets, /envs, /steer <ID> <内容>, /stop <ID>, /quit）\n\n",
  );
  rl.prompt();

  rl.on("line", async (rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      rl.prompt();
      return;
    }

    if (line === "/quit" || line === "/exit") {
      rl.close();
      ws.close();
      await options.onExit?.();
      process.exit(0);
    }

    if (line === "/tickets") {
      if (latestSlots) {
        console.log(
          `\nWorker 并发占用: ${latestSlots.used}/${latestSlots.max} | 排队 ${latestSlots.queuedCount}`,
        );
      }
      if (latestTickets.length === 0) {
        console.log("当前 Moco's table 暂无工单。\n");
      } else {
        for (const t of latestTickets) {
          const note =
            t.latestReport?.question
              ? `⚠️ 待确认: ${t.latestReport.question}`
              : t.latestReport?.summary ?? t.userSummary ?? "";
          console.log(
            `  • [${t.id}] (${t.status}) ${t.title} — ${t.roleLabel} @ ${t.envId} ${note ? `| ${note}` : ""}`,
          );
        }
        console.log("");
      }
      rl.prompt();
      return;
    }

    if (line === "/envs") {
      console.log("\n已注册 moco-env 执行节点:");
      for (const e of latestEnvs) {
        console.log(
          `  • ${e.id} (${e.online ? "online" : "offline"}) — ${e.name} [${e.platform}/${e.arch}] root=${e.rootDir}`,
        );
      }
      console.log("");
      rl.prompt();
      return;
    }

    if (line.startsWith("/steer ")) {
      const rest = line.slice("/steer ".length).trim();
      const sp = rest.indexOf(" ");
      if (sp <= 0) {
        console.log("用法: /steer <ticketId> <补充引导内容>");
      } else {
        const ticketId = rest.slice(0, sp).trim();
        const text = rest.slice(sp + 1).trim();
        send({
          type: "ticket.steer",
          ticketId,
          text,
          commandId: `cli-steer-${Date.now()}`,
        });
        console.log(`已向 ${ticketId} 发送步间引导。`);
      }
      rl.prompt();
      return;
    }

    if (line.startsWith("/stop ")) {
      const ticketId = line.slice("/stop ".length).trim();
      if (ticketId) {
        send({ type: "ticket.stop", ticketId, reason: "Stopped from CLI" });
        console.log(`已发送急停指令: ${ticketId}`);
      }
      rl.prompt();
      return;
    }

    if (line === "/abort") {
      send({ type: "chat.abort" });
      rl.prompt();
      return;
    }

    send({
      type: "chat.send",
      content: line,
      requestId: `cli-${Date.now()}`,
    });
    rl.prompt();
  });
}
