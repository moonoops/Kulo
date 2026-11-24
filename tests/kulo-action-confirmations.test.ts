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
import { validateUiCardInput } from "@kulo/protocol";
import { KuloStateDoc, type KuloHub } from "@kulo/hub";
import {
  ActionConfirmationsDoc,
  buildCustomizationConfirmCard,
  buildExternalPermissionCard,
  buildHostActionConfirmCard,
  buildMemoryServiceConfirmCard,
  buildStagedApplyConfirmCard,
  buildTicketDecisionCard,
  customizationValidateFingerprint,
  ticketDecisionFingerprint,
} from "../packages/hub/src/action-confirmations.js";
import { DeliveryReceiptDoc, deliveryReceiptKey } from "../packages/hub/src/delivery-receipts.js";
import { KuloProjectsDoc } from "../packages/hub/src/projects.js";
import { HindsightLocalService } from "../packages/hub/src/hindsight-service.js";
import { MemoryServiceDoc } from "../packages/hub/src/memory-service.js";
import { openTestHub } from "./helpers/secure-hub.js";

const dirs: string[] = [];
const hubs: KuloHub[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kulo-confirm-${prefix}-`));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const hub of hubs.splice(0).reverse()) await hub.close().catch(() => {});
  for (const dir of dirs.splice(0).reverse()) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Main-Agent Full Authority, Smart Judgment & Non-Blocking Interactive Confirmations", () => {
  it("produces strict GenUI-valid confirmation cards with Allow/Reject/Options + Manual Input", () => {
    const c1 = buildCustomizationConfirmCard("调整侧边栏间距", ["packages/web/src/App.tsx", "packages/web/src/kulo.css"]);
    expect(() => validateUiCardInput(c1.input)).not.toThrow();
    expect(c1.logicalIds).toEqual(["confirm", "cancel", "manual"]);

    const c2 = buildExternalPermissionCard("Run npm test in /workspace?", [
      { id: "allow-once", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ], "涉及外部仓库命令");
    expect(() => validateUiCardInput(c2.input)).not.toThrow();
    expect(c2.logicalIds).toEqual(["allow-once", "deny", "manual"]);

    const c3 = buildStagedApplyConfirmCard({
      ticketId: "T-0001",
      sensitivePaths: [".github/workflows/ci.yml", "package.json"],
      conflictFiles: ["src/index.ts"],
      allowConflicts: true,
    });
    expect(() => validateUiCardInput(c3.input)).not.toThrow();
    expect(c3.logicalIds).toEqual(["confirm", "cancel", "manual"]);

    const c4 = buildMemoryServiceConfirmCard({
      operation: "uninstall",
      title: "卸载本机 Hindsight",
      deviceName: "Macmini.local",
      changes: ["Macmini.local", "同时删除此安装的记忆数据"],
    });
    expect(() => validateUiCardInput(c4.input)).not.toThrow();
    expect(c4.logicalIds).toEqual(["confirm", "cancel", "manual"]);

    const c5 = buildHostActionConfirmCard({
      envName: "Macmini.local",
      summary: "安装 uv",
      commands: ["brew install uv"],
      cwd: "/Users/demo",
    });
    expect(() => validateUiCardInput(c5.input)).not.toThrow();
    expect(c5.logicalIds).toEqual(["confirm", "cancel", "manual"]);

    const c6 = buildTicketDecisionCard({
      title: "安装 Hindsight",
      question: "8888 端口已存在旧版 Hindsight，如何处理？",
      options: [
        { id: "reuse", label: "复用现有 8888 实例", tone: "primary" },
        { id: "new_port", label: "换端口全新安装", tone: "secondary" },
        { id: "abort_task", label: "暂不安装，结束任务", tone: "secondary", action: "stop" },
      ],
    });
    expect(() => validateUiCardInput(c6.input)).not.toThrow();
    expect(c6.logicalIds).toEqual(["reuse", "new_port", "abort_task", "manual"]);
    expect(c6.input.actions.map((a) => ({ id: a.id, kind: a.kind }))).toEqual([
      { id: "choice_0", kind: "submit" },
      { id: "choice_1", kind: "submit" },
      { id: "choice_2", kind: "cancel" },
      { id: "manual", kind: "submit" },
    ]);

    const fpReply = ticketDecisionFingerprint({
      ticketId: "T-0001",
      runEpoch: 1,
      question: "是否继续？",
      options: [{ id: "end", label: "结束任务", action: "reply" }],
    });
    const fpStop = ticketDecisionFingerprint({
      ticketId: "T-0001",
      runEpoch: 1,
      question: "是否继续？",
      options: [{ id: "end", label: "结束任务", action: "stop" }],
    });
    expect(fpReply).not.toBe(fpStop);
  });

  it("lets Main Agent merge sensitive staged changes directly by default, and still supports optional ask_user card escalation", async () => {
    const stateDir = tempDir("staged-state");
    const localEnvRoot = tempDir("staged-env");
    const projectDir = tempDir("staged-proj");
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Demo\n");

    const faux = fauxProvider({ provider: "confirm-test", models: [{ id: "confirm-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let mode: "direct_sensitive" | "ask_user_sensitive" = "direct_sensitive";
    let lastApplyToolResult = "";

    faux.setResponses(
      Array.from({ length: 24 }, () => (ctx: TranscriptContext) => {
        const isOrchestrator =
          Boolean(ctx.tools?.some((t) => t.name === "kulo_dispatch")) ||
          ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_dispatch"));
        if (!isOrchestrator) {
          const alreadyReported = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_report");
          if (alreadyReported) return fauxAssistantMessage([fauxText("Done")]);
          const wrote = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "write");
          if (!wrote) {
            return fauxAssistantMessage(
              [
                mode === "direct_sensitive"
                  ? fauxToolCall("write", { path: ".github/workflows/ci.yml", content: "name: DirectCI\n" })
                  : fauxToolCall("write", { path: ".github/workflows/release.yml", content: "name: ReleaseCI\n" }),
              ],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage(
            [fauxToolCall("kulo_report", { state: "ready", summary: "Added workflow" })],
            { stopReason: "toolUse" },
          );
        }

        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
        const applyRes = turnResults.find((m) => m.toolName === "kulo_apply_staged_changes");
        if (applyRes) {
          lastApplyToolResult = applyRes.content.map((c) => ("text" in c ? c.text : "")).join("");
          return fauxAssistantMessage([fauxText("已处理合并请求。")]);
        }

        const lastUserContent = ctx.messages[lastUserIdx]?.content;
        const lastUserText = typeof lastUserContent === "string"
          ? lastUserContent
          : Array.isArray(lastUserContent)
            ? lastUserContent.map((c) => ("text" in c ? c.text : "")).join("")
            : "";
        if (lastUserText.includes("[KULO_WORKER_RELAY]")) {
          const ticketMatch = /(T-\d{4})/.exec(lastUserText);
          const ticketId = ticketMatch?.[1] ?? "T-0001";
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_apply_staged_changes", {
                command_id: `apply-${mode}-${ticketId}`,
                ticket_id: ticketId,
                ...(mode === "ask_user_sensitive" ? { ask_user: true } : {}),
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (lastUserText.includes("kulo.ui.action")) {
          return fauxAssistantMessage([fauxText("已收到确认并完成合并。")]);
        }
        if (turnResults.length === 0) {
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_dispatch", {
                command_id: `dispatch-${mode}`,
                title: mode === "direct_sensitive" ? "直接合并工作流" : "需确认发布工作流",
                goal: "新增 workflow 文件",
                scope: ".github/workflows/",
                role: "coder",
                project_id: project.id,
                workspace_mode: "staged",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("任务已派发。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "confirm-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "confirm-test", defaultModel: "confirm-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    const project = await hub.projects.create({
      commandId: "create-confirm-demo",
      name: "ConfirmDemo",
      deviceId: "local",
      workspaceDir: projectDir,
    });

    // 1. Sensitive path merge (.github/workflows/ci.yml) -> Main Agent merges directly with 0 cards!
    mode = "direct_sensitive";
    await hub.sendUserMessage("修改 CI 工作流");
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(projectDir, ".github/workflows/ci.yml"))).toBe(true);
    }, { timeout: 12_000, interval: 40 });
    expect(await hub.uiCards.snapshot(Number(hub.rootConversation.id))).toHaveLength(0);

    // 2. When Main Agent explicitly passes ask_user: true -> card appears & merges on user click
    mode = "ask_user_sensitive";
    lastApplyToolResult = "";
    await hub.sendUserMessage("修改发布工作流并请我确认");
    await vi.waitFor(() => {
      expect(lastApplyToolResult).toContain("awaiting_user_confirmation");
    }, { timeout: 12_000, interval: 40 });
    expect(fs.existsSync(path.join(projectDir, ".github/workflows/release.yml"))).toBe(false);

    const cards = await hub.uiCards.snapshot(Number(hub.rootConversation.id));
    expect(cards).toHaveLength(1);
    const confirmCard = cards[0]!;
    const confirmAction = confirmCard.actions.find((a) => a.label === "允许")!;

    const receipt = await hub.submitUiAction({
      cardId: confirmCard.cardId,
      revision: confirmCard.revision,
      actionId: confirmAction.id,
      values: {},
      commandId: "user-confirm-sensitive-merge",
    });
    expect(receipt.status).toBe("submitted");
    expect(fs.readFileSync(path.join(projectDir, ".github/workflows/release.yml"), "utf8")).toBe("name: ReleaseCI\n");
  });

  it("lets Main Agent decide external permissions directly, escalate with ask_user, and auto-settle open cards when user replies in chat", async () => {
    const stateDir = tempDir("extperm-state");
    const localEnvRoot = tempDir("extperm-env");
    const faux = fauxProvider({ provider: "extperm-test", models: [{ id: "extperm-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let stepMode: "direct" | "ask_user" | "chat_settle" = "direct";
    let lastToolResultText = "";
    faux.setResponses(
      Array.from({ length: 12 }, () => (ctx: TranscriptContext) => {
        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
        const res = turnResults.find((m) => m.toolName === "kulo_external_permission");
        if (res) {
          lastToolResultText = res.content.map((c) => ("text" in c ? c.text : "")).join("");
          return fauxAssistantMessage([fauxText(stepMode === "ask_user" ? "请确认卡片或在聊天中直接回复。" : "[COORDINATOR_OK]")]);
        }
        if (stepMode === "direct") {
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_external_permission", {
                ticket_id: "T-EXT1",
                run_epoch: 1,
                permission_id: "perm-1",
                mode: "decide",
                choice_id: "allow-once",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (stepMode === "ask_user") {
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_external_permission", {
                ticket_id: "T-EXT1",
                run_epoch: 1,
                permission_id: "perm-2",
                mode: "ask_user",
                reason: "涉及推送远程仓库",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage(
          [
            fauxToolCall("kulo_external_permission", {
              ticket_id: "T-EXT1",
              run_epoch: 1,
              permission_id: "perm-2",
              mode: "decide",
              choice_id: "deny",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "extperm-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "extperm-test", defaultModel: "extperm-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    const requestSpy = vi.spyOn(hub.envManager, "requestExternalAgent").mockResolvedValue({
      type: "run",
      run: {
        id: "run-ext-1",
        taskId: "T-EXT1",
        runEpoch: 1,
        kind: "codex",
        state: "running",
        text: "",
        events: [],
        permissions: [
          {
            id: "perm-2",
            title: "Allow running git push?",
            choices: [
              { id: "allow-once", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          },
        ],
        nextSequence: 2,
      },
    });

    await hub.harness.commit(async (tx) => {
      const state = await tx.doc(KuloStateDoc);
      state.tickets["T-EXT1"] = {
        id: "T-EXT1",
        title: "External Codex Task",
        goal: "Check repo",
        scope: "repo",
        acceptance: "done",
        role: "coder",
        envId: "local",
        workspaceDir: localEnvRoot,
        workerConversationId: 999,
        originConversationId: Number(hub.rootConversation.id),
        originTopicId: "root",
        status: "running",
        runEpoch: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        externalExecution: {
          binding: { kind: "codex", envId: "local" },
          runId: "run-ext-1",
          pendingPermissions: [
            {
              id: "perm-1",
              title: "Run pnpm test?",
              choices: [
                { id: "allow-once", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
            {
              id: "perm-2",
              title: "Allow running git push?",
              choices: [
                { id: "allow-once", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        },
      } as never;
      const { injectEventToolsInTx } = await import("../packages/hub/src/tool-surface.js");
      await injectEventToolsInTx(tx, hub.rootConversation.id, ["kulo_external_permission"]);
    }, BACKGROUND_CONTEXT);

    // 1. Main Agent directly approves perm-1 (mode="decide") -> immediately forwarded, 0 cards!
    stepMode = "direct";
    const sub1 = await hub.sendUserMessage("处理外部权限 1");
    await sub1.wait(BACKGROUND_CONTEXT);
    expect(requestSpy).toHaveBeenCalledWith("local", {
      operation: "respond",
      runId: "run-ext-1",
      permissionId: "perm-1",
      choiceId: "allow-once",
    });
    expect(await hub.uiCards.snapshot(Number(hub.rootConversation.id))).toHaveLength(0);

    // 2. Main Agent escalates risky perm-2 (mode="ask_user") -> card appears!
    stepMode = "ask_user";
    const sub2 = await hub.sendUserMessage("处理外部权限 2");
    await sub2.wait(BACKGROUND_CONTEXT);
    expect(lastToolResultText).toContain("awaiting_user_confirmation");
    const cards = await hub.uiCards.snapshot(Number(hub.rootConversation.id));
    expect(cards).toHaveLength(1);
    const permCard = cards[0]!;
    expect(permCard.status).toBe("ready");

    // 3. User ignores card and replies in chat ("拒绝 push") -> Main Agent calls decide -> forwarded AND card auto-settled!
    stepMode = "chat_settle";
    const sub3 = await hub.sendUserMessage("拒绝 push");
    await sub3.wait(BACKGROUND_CONTEXT);
    expect(requestSpy).toHaveBeenCalledWith("local", {
      operation: "respond",
      runId: "run-ext-1",
      permissionId: "perm-2",
      choiceId: "deny",
    });
    const settled = await hub.uiCards.get(permCard.cardId);
    expect(settled?.status).toBe("submitted");
    expect(settled?.resultSummary).toBe("已通过对话处理");
  });

  it("binds customization confirmation fingerprints strictly to session revision and changed files", () => {
    const fp1 = customizationValidateFingerprint("custom-1", 2, ["packages/web/src/App.tsx"]);
    const fp2 = customizationValidateFingerprint("custom-1", 3, ["packages/web/src/App.tsx"]);
    const fp3 = customizationValidateFingerprint("custom-1", 2, ["packages/web/src/App.tsx", "packages/web/src/evil.ts"]);
    expect(fp1).not.toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });

  it("lets Main Agent validate kulo_customization directly by default and supports optional ask_user card", async () => {
    const stateDir = tempDir("custom-state");
    const localEnvRoot = tempDir("custom-env");
    const faux = fauxProvider({ provider: "custom-confirm-test", models: [{ id: "custom-confirm-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let askUser = false;
    const toolOutputs: string[] = [];
    faux.setResponses(
      Array.from({ length: 8 }, () => (ctx: TranscriptContext) => {
        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");
        const lastTool = turnResults.find((m) => m.toolName === "kulo_customization");
        if (lastTool) {
          const text = lastTool.content.map((c) => ("text" in c ? c.text : "")).join("");
          toolOutputs.push(text);
          return fauxAssistantMessage([fauxText(text.includes("awaiting_user_confirmation") ? "请确认卡片。" : "已验证并安排生效。")]);
        }
        return fauxAssistantMessage(
          [
            fauxToolCall("kulo_customization", {
              action: "validate",
              request: JSON.stringify(askUser ? { session_id: "custom-session-1", ask_user: true } : { session_id: "custom-session-1" }),
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "custom-confirm-test",
      config: {
        stateDir,
        localEnvRoot,
        customization: { dataDir: stateDir, sourceRoot: localEnvRoot, nodePath: process.execPath },
        model: { defaultProvider: "custom-confirm-test", defaultModel: "custom-confirm-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    const validateSpy = vi.fn(async () => ({ id: "custom-session-1", status: "pending", result: "准备完成，下次打开时生效。" }));
    const fakeService = {
      status: vi.fn(async () => ({
        currentVersion: "0.1.0",
        currentReleaseId: "rel-1",
        pendingReleaseId: null,
        hasPendingUpdate: false,
        sourceCustomizationAvailable: true,
        officialUpdatesAvailable: false,
        session: {
          id: "custom-session-1",
          summary: "微调聊天间距",
          status: "prepared",
          revision: 2,
          changedFiles: ["packages/web/src/kulo.css"],
        },
      })),
      validateAndStage: validateSpy,
      close: vi.fn(async () => {}),
    };
    vi.spyOn(hub, "customizationService").mockResolvedValue(fakeService as never);

    await hub.harness.commit(async (tx) => {
      const { injectEventToolsInTx } = await import("../packages/hub/src/tool-surface.js");
      await injectEventToolsInTx(tx, hub.rootConversation.id, ["kulo_customization"]);
    }, BACKGROUND_CONTEXT);

    // 1. Default validate executes directly with Main Agent authority (0 cards!)
    askUser = false;
    const sub1 = await hub.sendUserMessage("直接验证并应用界面定制");
    await sub1.wait(BACKGROUND_CONTEXT);
    expect(validateSpy).toHaveBeenCalledTimes(1);
    expect(await hub.uiCards.snapshot(Number(hub.rootConversation.id))).toHaveLength(0);

    // 2. Explicit ask_user: true shows confirmation card
    askUser = true;
    const sub2 = await hub.sendUserMessage("验证界面定制但先让我确认");
    await sub2.wait(BACKGROUND_CONTEXT);
    expect(validateSpy).toHaveBeenCalledTimes(1);
    expect(toolOutputs.at(-1)).toContain("awaiting_user_confirmation");
    expect(await hub.uiCards.snapshot(Number(hub.rootConversation.id))).toHaveLength(1);
  });

  it("lets Main Chat directly uninstall Hindsight, optionally escalate with ask_user, and toggle long-term memory enable/disable", async () => {
    const stateDir = tempDir("memory-state");
    const localEnvRoot = tempDir("memory-env");

    let installed = true;
    vi.spyOn(HindsightLocalService.prototype, "inspect").mockImplementation(async () => ({
      installed,
      running: installed,
      platform: "darwin",
      deviceName: "Macmini.local",
      ...(installed ? { endpoint: "http://127.0.0.1:18888", phase: "running" } : { phase: "absent" }),
    }));
    const uninstallSpy = vi.spyOn(HindsightLocalService.prototype, "uninstall").mockImplementation(async () => {
      installed = false;
      return { installed: false, running: false, platform: "darwin", deviceName: "Macmini.local", phase: "absent" };
    });

    const faux = fauxProvider({ provider: "mem-confirm-test", models: [{ id: "mem-confirm-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let flow: "direct_uninstall" | "toggle_disable" = "direct_uninstall";
    let step = 0;
    const prepareOutputs: string[] = [];
    faux.setResponses(
      Array.from({ length: 16 }, () => (ctx: TranscriptContext) => {
        const lastTool = ctx.messages.at(-1);
        if (lastTool?.role === "toolResult" && lastTool.toolName === "kulo_settings_read") {
          return fauxAssistantMessage([fauxToolCall("kulo_memory_service_read", {})], { stopReason: "toolUse" });
        }
        if (lastTool?.role === "toolResult" && lastTool.toolName === "kulo_memory_service_read") {
          return fauxAssistantMessage(
            [
              flow === "direct_uninstall"
                ? fauxToolCall("kulo_memory_service_prepare", {
                    operation: "uninstall",
                    config: JSON.stringify({ deleteData: true }),
                  })
                : fauxToolCall("kulo_memory_service_prepare", { operation: "disable" }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (lastTool?.role === "toolResult" && lastTool.toolName === "kulo_memory_service_prepare") {
          prepareOutputs.push(lastTool.content.map((c) => ("text" in c ? c.text : "")).join(""));
          return fauxAssistantMessage([fauxText("操作已完成。")]);
        }
        step += 1;
        if (flow === "direct_uninstall" && step === 1) {
          return fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: "读取设置 identity 长期记忆", limit: 3 })],
            { stopReason: "toolUse" },
          );
        }
        if (flow === "direct_uninstall" && step === 2) {
          return fauxAssistantMessage([fauxToolCall("kulo_settings_read", { section: "identity" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxToolCall("kulo_memory_service_read", {})], { stopReason: "toolUse" });
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "mem-confirm-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "mem-confirm-test", defaultModel: "mem-confirm-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    // 1. kulo_settings_read(section="identity") auto-loads kulo_memory_service_read, and Main Agent uninstalls directly without forced card!
    const sub1 = await hub.sendUserMessage("帮我检查并卸载本机 hindsight");
    await sub1.wait(BACKGROUND_CONTEXT);

    await vi.waitFor(() => {
      expect(uninstallSpy).toHaveBeenCalledTimes(1);
      expect(installed).toBe(false);
    }, { timeout: 6_000, interval: 40 });
    expect(uninstallSpy.mock.calls[0]?.[0]?.deleteData).toBe(true);
    expect(await hub.uiCards.snapshot(Number(hub.rootConversation.id))).toHaveLength(0);

    const memDoc = await hub.harness.snapshot(MemoryServiceDoc, BACKGROUND_CONTEXT);
    expect(Object.values(memDoc?.jobs ?? {}).some((job) => job.view.operation === "uninstall" && job.view.status === "succeeded")).toBe(true);

    // 2. Main Chat can directly toggle memory enabled/disabled via kulo_memory_service_prepare(operation="disable")
    flow = "toggle_disable";
    const sub2 = await hub.sendUserMessage("帮我关闭长期记忆开关");
    await sub2.wait(BACKGROUND_CONTEXT);
    expect(prepareOutputs.at(-1)).toContain('"status":"disabled"');
  });

  it("parks blocked Workers for Coordinator-first judgment and syncs kulo_ticket_ask_user cards with non-blocking chat replies", async () => {
    const stateDir = tempDir("blocked-coord-state");
    const localEnvRoot = tempDir("blocked-coord-env");

    const faux = fauxProvider({ provider: "blocked-coord-test", models: [{ id: "coord-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let mode: "coordinator_solves" | "escalate_to_user" = "coordinator_solves";
    let escalatedTicketId = "";
    let observedWorkerWaitingReasonDuringRelay = "";

    faux.setResponses(
      Array.from({ length: 24 }, () => (ctx: TranscriptContext) => {
        const isOrchestrator =
          Boolean(ctx.tools?.some((t) => t.name === "kulo_dispatch")) ||
          ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_dispatch"));
        if (!isOrchestrator) {
          const hasSteer = ctx.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("主控补充引导"));
          const reportedReady = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_report");
          if (hasSteer) {
            if (ctx.messages.filter((m) => m.role === "toolResult" && m.toolName === "kulo_report").length >= 2) {
              return fauxAssistantMessage([fauxText("Done")]);
            }
            return fauxAssistantMessage(
              [fauxToolCall("kulo_report", { state: "ready", summary: "Resumed and completed after decision." })],
              { stopReason: "toolUse" },
            );
          }
          if (reportedReady) return fauxAssistantMessage([fauxText("Parked")]);
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_report", {
                state: "blocked",
                summary: "Port 8888 already has Hindsight running",
                question: "Reuse existing 8888 instance or install a fresh one on port 8889?",
                options: ["Reuse existing 8888", "Install fresh on 8889"],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const lastText = typeof ctx.messages[lastUserIdx]?.content === "string" ? ctx.messages[lastUserIdx]!.content as string : "";
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");

        if (lastText.includes("[KULO_WORKER_RELAY]") && lastText.includes("State: blocked")) {
          const ticketId = /(T-\d{4})/.exec(lastText)![1]!;
          escalatedTicketId = ticketId;
          if (mode === "coordinator_solves") {
            if (turnResults.some((m) => m.toolName === "kulo_steer")) {
              return fauxAssistantMessage([fauxText("[COORDINATOR_OK]")]);
            }
            return fauxAssistantMessage(
              [fauxToolCall("kulo_steer", { command_id: `coord-solve-${ticketId}`, ticket_id: ticketId, text: "直接复用现有 8888 实例继续验证。" })],
              { stopReason: "toolUse" },
            );
          }
          if (turnResults.some((m) => m.toolName === "kulo_ticket_ask_user")) {
            return fauxAssistantMessage([fauxText("8888 端口已有旧实例，请确认方案。")]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_ticket_ask_user", {
                ticket_id: ticketId,
                question: "Mac mini 上 8888 端口已运行旧版 Hindsight，你想怎么处理？",
                options: [
                  { id: "reuse", label: "复用现有 8888 实例", tone: "primary" },
                  { id: "fresh", label: "换端口全新安装", tone: "secondary" },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (lastText.includes("换个新端口装吧")) {
          if (turnResults.some((m) => m.toolName === "kulo_steer")) {
            return fauxAssistantMessage([fauxText("好的，已通知任务换端口全新安装。")]);
          }
          return fauxAssistantMessage(
            [fauxToolCall("kulo_steer", { command_id: `chat-steer-${escalatedTicketId}`, ticket_id: escalatedTicketId, text: "用户选择换端口全新安装。" })],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("收到。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "blocked-coord-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "blocked-coord-test", defaultModel: "coord-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    // 1. Coordinator resolves blocked Worker silently -> never surfaces waiting.reason="user" or UI card!
    mode = "coordinator_solves";
    const t1 = await hub.dispatchTicket({
      commandId: "coord-blocked-1",
      title: "部署 Hindsight",
      goal: "检查并配置 Hindsight",
      scope: "host",
      role: "coder",
    });
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const t = snap?.tickets[t1.id];
      if (t?.status === "waiting" && t.waiting?.reason && !observedWorkerWaitingReasonDuringRelay) {
        observedWorkerWaitingReasonDuringRelay = t.waiting.reason;
      }
      expect(t?.status).toBe("ready");
    }, { timeout: 15_000, interval: 20 });
    expect(observedWorkerWaitingReasonDuringRelay === "" || observedWorkerWaitingReasonDuringRelay === "coordinator").toBe(true);
    expect(await hub.uiCards.snapshot(Number(hub.rootConversation.id))).toHaveLength(0);

    // 2. Coordinator escalates via kulo_ticket_ask_user -> card & ticket.waiting.options appear; user replies in chat -> Worker resumes AND card auto-settles!
    mode = "escalate_to_user";
    const t2 = await hub.dispatchTicket({
      commandId: "coord-blocked-2",
      title: "安装 Hindsight",
      goal: "安装或复用 Hindsight",
      scope: "host",
      role: "coder",
    });

    let cardId = "";
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const t = snap?.tickets[t2.id];
      expect(t?.status).toBe("waiting");
      expect(t?.waiting?.reason).toBe("user");
      expect(t?.waiting?.detail).toContain("8888 端口");
      expect(t?.waiting?.options?.map((o) => o.label)).toEqual(["复用现有 8888 实例", "换端口全新安装"]);
      expect(t?.waiting?.cardId).toBeTruthy();
      cardId = t!.waiting!.cardId!;
    }, { timeout: 15_000, interval: 40 });

    const subReply = await hub.sendUserMessage("换个新端口装吧");
    await subReply.wait(BACKGROUND_CONTEXT);

    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(snap?.tickets[t2.id]?.status).toBe("ready");
    }, { timeout: 15_000, interval: 40 });

    const settled = await hub.uiCards.get(cardId);
    expect(settled?.status).toBe("submitted");
    expect(settled?.resultSummary).toBe("已通过对话处理");
  }, 30_000);

  it("stops tickets atomically from action='stop' decision cards with zero race, zero worker wake, and idempotent Phase 2 retry", async () => {
    const stateDir = tempDir("stop-card-state");
    const localEnvRoot = tempDir("stop-card-env");
    const faux = fauxProvider({ provider: "stop-card-test", models: [{ id: "stop-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let workerRuns = 0;
    let observedUiActionRaw = "";
    let observedTicketStatusAtUiActionTurn = "";
    let hubRef: KuloHub | undefined;

    faux.setResponses(
      Array.from({ length: 24 }, () => (ctx: TranscriptContext) => {
        const isOrchestrator =
          Boolean(ctx.tools?.some((t) => t.name === "kulo_dispatch")) ||
          ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_dispatch"));
        if (!isOrchestrator) {
          const reported = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_report");
          if (reported) return fauxAssistantMessage([fauxText("Parked")]);
          workerRuns += 1;
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_report", {
                state: "blocked",
                summary: "设备未授予截屏权限",
                question: "是否授予截屏权限，还是结束本次截屏任务？",
                options: ["已授权，继续截屏", "暂不授予，结束任务"],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const lastText = typeof ctx.messages[lastUserIdx]?.content === "string" ? ctx.messages[lastUserIdx]!.content as string : "";
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");

        if (lastText.includes("[KULO_WORKER_RELAY]") && lastText.includes("State: blocked")) {
          const ticketId = /(T-\d{4})/.exec(lastText)![1]!;
          if (turnResults.some((m) => m.toolName === "kulo_ticket_ask_user")) {
            return fauxAssistantMessage([fauxText("请决定是否授予截屏权限。")]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_ticket_ask_user", {
                ticket_id: ticketId,
                question: "当前未授予手机读屏/截图权限，你想怎么处理？",
                options: [
                  { id: "grant", label: "已授权，继续截屏", tone: "primary", action: "reply" },
                  { id: "decline_stop", label: "暂不授予，结束任务", tone: "secondary", action: "stop" },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        if (lastText.includes("kulo.ui.action")) {
          observedUiActionRaw = lastText;
          observedTicketStatusAtUiActionTurn = JSON.stringify(ctx);
          return fauxAssistantMessage([fauxText("好的，已为你结束这次截屏任务。")]);
        }

        return fauxAssistantMessage([fauxText("收到。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "stop-card-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "stop-card-test", defaultModel: "stop-model", thinkingLevel: "off" },
      },
    });
    hubRef = hub;
    hubs.push(hub);

    // 1. Direct stop via chat decision card (zero 0ms race, zero worker re-wake, zero failure recovery)
    const t1 = await hub.dispatchTicket({
      commandId: "stop-card-1",
      title: "截取手机屏幕",
      goal: "截取手机当前画面",
      scope: "android",
      role: "coder",
    });

    let cardId = "";
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const t = snap?.tickets[t1.id];
      expect(t?.status).toBe("waiting");
      expect(t?.waiting?.reason).toBe("user");
      expect(t?.waiting?.options?.[1]).toMatchObject({ id: "decline_stop", action: "stop" });
      expect(t?.waiting?.cardId).toBeTruthy();
      cardId = t!.waiting!.cardId!;
    }, { timeout: 15_000, interval: 40 });
    expect(workerRuns).toBe(1);

    const card = (await hub.uiCards.get(cardId))!;
    const stopAction = card.actions.find((a) => a.label === "暂不授予，结束任务")!;
    expect(stopAction.kind).toBe("cancel");

    const receipt = await hub.submitUiAction({
      cardId: card.cardId,
      revision: card.revision,
      actionId: stopAction.id,
      values: {},
      commandId: "user-stop-via-card-1",
    });
    expect(receipt.status).toBe("cancelled");
    expect(receipt.card?.resultSummary).toBe("已停止任务");

    await vi.waitFor(() => {
      expect(observedUiActionRaw).toContain("kulo.ui.action");
    }, { timeout: 10_000, interval: 20 });

    // P1-3: First JSON key stays `"type":"kulo.ui.action"` so transcript projection never leaks raw JSON.
    expect(observedUiActionRaw.startsWith('{"type":"kulo.ui.action"')).toBe(true);
    expect(JSON.parse(observedUiActionRaw)).toMatchObject({
      type: "kulo.ui.action",
      systemEffect: { kind: "ticket_stopped", ticketId: t1.id, reason: "暂不授予，结束任务" },
    });
    // Zero-race: at the moment Orchestrator woke up on 0ms fauxProvider, Recent Work already saw `stopped`.
    expect(observedTicketStatusAtUiActionTurn).toContain(`${t1.id} · 截取手机屏幕 · stopped`);

    const snap1 = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(snap1?.tickets[t1.id]).toMatchObject({
      status: "stopped",
      stoppedReason: "暂不授予，结束任务",
      cleanupPending: false,
    });
    expect(snap1?.tickets[t1.id]?.recovery).toBeUndefined();
    expect(snap1?.tickets[t1.id]?.waiting).toBeUndefined();
    expect(workerRuns).toBe(1);

    // 2. P0-2: Transient Phase 2 failure after uiCards.submit commits -> same commandId retry completes cleanup!
    const t2 = await hub.dispatchTicket({
      commandId: "stop-card-2",
      title: "截取手机屏幕2",
      goal: "再次截取手机画面",
      scope: "android",
      role: "coder",
    });
    let cardId2 = "";
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      const t = snap?.tickets[t2.id];
      expect(t?.status).toBe("waiting");
      expect(t?.waiting?.cardId).toBeTruthy();
      cardId2 = t!.waiting!.cardId!;
    }, { timeout: 15_000, interval: 40 });
    expect(workerRuns).toBe(2);

    const card2 = (await hub.uiCards.get(cardId2))!;
    const stopAction2 = card2.actions.find((a) => a.label === "暂不授予，结束任务")!;
    const mediaSpy = vi.spyOn(hubRef.mediaJobs, "list").mockRejectedValueOnce(new Error("transient Phase 2 error"));
    await expect(
      hub.submitUiAction({
        cardId: card2.cardId,
        revision: card2.revision,
        actionId: stopAction2.id,
        values: {},
        commandId: "user-stop-via-card-2",
      }),
    ).rejects.toThrow("transient Phase 2 error");
    mediaSpy.mockRestore();

    // Phase 1 committed stopped + projects.cancellations even though Phase 2 threw.
    const midProjects = await hub.harness.snapshot(KuloProjectsDoc, BACKGROUND_CONTEXT);
    expect(midProjects?.cancellations?.[t2.id]).toBeDefined();

    // Retry with identical commandId hits deduplicated=true AND completes Phase 2 cleanup!
    const retryReceipt = await hub.submitUiAction({
      cardId: card2.cardId,
      revision: card2.revision,
      actionId: stopAction2.id,
      values: {},
      commandId: "user-stop-via-card-2",
    });
    expect(retryReceipt.deduplicated).toBe(true);
    const afterProjects = await hub.harness.snapshot(KuloProjectsDoc, BACKGROUND_CONTEXT);
    expect(afterProjects?.cancellations?.[t2.id]).toBeUndefined();
    const snap2 = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(snap2?.tickets[t2.id]).toMatchObject({ status: "stopped", cleanupPending: false });
    expect(workerRuns).toBe(2);
  }, 30_000);

  it("handles P0-1 crash replay on legacy ticket.steer stop fallback and auto-settles cards on kulo_stop", async () => {
    const stateDir = tempDir("steer-stop-state");
    const localEnvRoot = tempDir("steer-stop-env");
    const faux = fauxProvider({ provider: "steer-stop-test", models: [{ id: "steer-stop-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let workerRuns = 0;
    let activeTicketId = "";

    faux.setResponses(
      Array.from({ length: 24 }, () => (ctx: TranscriptContext) => {
        const isOrchestrator =
          Boolean(ctx.tools?.some((t) => t.name === "kulo_dispatch")) ||
          ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_dispatch"));
        if (!isOrchestrator) {
          const reported = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "kulo_report");
          if (reported) return fauxAssistantMessage([fauxText("Parked")]);
          workerRuns += 1;
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_report", {
                state: "blocked",
                summary: "缺少权限",
                question: "是否继续？",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const lastText = typeof ctx.messages[lastUserIdx]?.content === "string" ? ctx.messages[lastUserIdx]!.content as string : "";
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");

        if (lastText.includes("[KULO_WORKER_RELAY]") && lastText.includes("State: blocked")) {
          activeTicketId = /(T-\d{4})/.exec(lastText)![1]!;
          if (turnResults.some((m) => m.toolName === "kulo_ticket_ask_user")) {
            return fauxAssistantMessage([fauxText("请确认操作。")]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_ticket_ask_user", {
                ticket_id: activeTicketId,
                question: "是否授予权限？",
                options: [
                  { id: "grant", label: "继续", action: "reply" },
                  { id: "stop_now", label: "结束任务", action: "stop", tone: "secondary" },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }

        if (lastText.includes("算了直接结束")) {
          if (turnResults.some((m) => m.toolName === "kulo_stop")) {
            return fauxAssistantMessage([fauxText("好的，已停止任务。")]);
          }
          return fauxAssistantMessage(
            [fauxToolCall("kulo_stop", { ticket_id: activeTicketId, reason: "用户聊天要求结束" })],
            { stopReason: "toolUse" },
          );
        }

        return fauxAssistantMessage([fauxText("收到。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "steer-stop-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "steer-stop-test", defaultModel: "steer-stop-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    // 1. P0-1: Legacy ticket.steer with decisionOptionId pointing to action='stop' crashes after Phase 1 -> replay succeeds without 409!
    const t1 = await hub.dispatchTicket({
      commandId: "legacy-stop-ticket-1",
      title: "旧客户端停单测试",
      goal: "测试停单崩溃重放",
      scope: "local",
      role: "coder",
    });
    let cardId1 = "";
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(snap?.tickets[t1.id]?.status).toBe("waiting");
      expect(snap?.tickets[t1.id]?.waiting?.cardId).toBeTruthy();
      cardId1 = snap!.tickets[t1.id]!.waiting!.cardId!;
    }, { timeout: 15_000, interval: 40 });
    expect(workerRuns).toBe(1);

    const crashSpy = vi.spyOn(hub.mediaJobs, "list").mockRejectedValueOnce(new Error("crash after phase 1"));
    await expect(
      hub.steerTicket({
        ticketId: t1.id,
        commandId: "cmd-legacy-stop-1",
        text: "结束任务",
        decisionOptionId: "stop_now",
      }),
    ).rejects.toThrow("crash after phase 1");
    crashSpy.mockRestore();

    const midSnap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(midSnap?.tickets[t1.id]?.status).toBe("stopped");
    expect(midSnap?.tickets[t1.id]?.waiting).toBeUndefined();
    const midReceipt = await hub.harness.snapshot(DeliveryReceiptDoc, deliveryReceiptKey("cmd-legacy-stop-1"), BACKGROUND_CONTEXT);
    expect(midReceipt?.phase).toBe("admitted");

    // Replay exact same ticket.steer command -> resumes Phase 2 cleanly without 409!
    const completedCard = await hub.steerTicket({
      ticketId: t1.id,
      commandId: "cmd-legacy-stop-1",
      text: "结束任务",
      decisionOptionId: "stop_now",
    });
    expect(completedCard.status).toBe("stopped");
    expect(completedCard.cleanupPending).toBeFalsy();
    expect(completedCard.stoppedReason).toBe("结束任务");
    const doneSnap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(doneSnap?.tickets[t1.id]?.cleanupPending).toBe(false);
    const doneReceipt = await hub.harness.snapshot(DeliveryReceiptDoc, deliveryReceiptKey("cmd-legacy-stop-1"), BACKGROUND_CONTEXT);
    expect(doneReceipt?.phase).toBe("complete");
    expect((await hub.uiCards.get(cardId1))?.status).toBe("cancelled");
    expect(workerRuns).toBe(1);

    // Third replay returns complete receipt idempotently.
    const replayCard = await hub.steerTicket({
      ticketId: t1.id,
      commandId: "cmd-legacy-stop-1",
      text: "结束任务",
      decisionOptionId: "stop_now",
    });
    expect(replayCard.status).toBe("stopped");

    // 2. Chat kulo_stop auto-settles open ticket_decision card!
    const t2 = await hub.dispatchTicket({
      commandId: "chat-stop-ticket-2",
      title: "聊天停单收口测试",
      goal: "测试聊天停单自动收口卡片",
      scope: "local",
      role: "coder",
    });
    let cardId2 = "";
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(snap?.tickets[t2.id]?.status).toBe("waiting");
      expect(snap?.tickets[t2.id]?.waiting?.cardId).toBeTruthy();
      cardId2 = snap!.tickets[t2.id]!.waiting!.cardId!;
    }, { timeout: 15_000, interval: 40 });

    const sub = await hub.sendUserMessage("算了直接结束");
    await sub.wait(BACKGROUND_CONTEXT);

    const snap2 = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(snap2?.tickets[t2.id]?.status).toBe("stopped");
    const settledCard2 = await hub.uiCards.get(cardId2);
    expect(settledCard2?.status).toBe("cancelled");
    expect(settledCard2?.resultSummary).toBe("任务已停止");
    expect(workerRuns).toBe(2);
  }, 30_000);

  it("prevents stale stop cards from clobbering ready tickets with staged diffs and respects manual/dispatched boundaries", async () => {
    const stateDir = tempDir("p04-state");
    const localEnvRoot = tempDir("p04-env");
    const projectDir = tempDir("p04-proj");
    fs.writeFileSync(path.join(projectDir, "README.md"), "# P0-4 Demo\n");

    const faux = fauxProvider({ provider: "p04-test", models: [{ id: "p04-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    faux.setResponses(
      Array.from({ length: 24 }, () => (ctx: TranscriptContext) => {
        const isOrchestrator =
          Boolean(ctx.tools?.some((t) => t.name === "kulo_dispatch")) ||
          ctx.messages.some((m) => m.role === "system" && "toolsAdded" in m && Array.isArray(m.toolsAdded) && m.toolsAdded.some((t) => t.name === "kulo_dispatch"));
        if (!isOrchestrator) {
          const hasSteer = ctx.messages.some(
            (m) =>
              m.role === "user" &&
              typeof m.content === "string" &&
              (m.content.includes("继续执行") || m.content.includes("Follow-Up / Resume Instructions")),
          );
          const reportCount = ctx.messages.filter((m) => m.role === "toolResult" && m.toolName === "kulo_report").length;
          if (hasSteer) {
            if (reportCount >= 2) return fauxAssistantMessage([fauxText("Done")]);
            const wrote = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "write");
            if (!wrote) {
              return fauxAssistantMessage(
                [fauxToolCall("write", { path: ".github/workflows/p04.yml", content: "name: P04\n" })],
                { stopReason: "toolUse" },
              );
            }
            return fauxAssistantMessage(
              [fauxToolCall("kulo_report", { state: "ready", summary: "Finished staged edit" })],
              { stopReason: "toolUse" },
            );
          }
          if (reportCount >= 1) return fauxAssistantMessage([fauxText("Parked")]);
          return fauxAssistantMessage(
            [fauxToolCall("kulo_report", { state: "blocked", summary: "Need go-ahead", question: "Continue or stop?" })],
            { stopReason: "toolUse" },
          );
        }

        const lastUserIdx = ctx.messages.findLastIndex((m) => m.role === "user");
        const lastText = typeof ctx.messages[lastUserIdx]?.content === "string" ? ctx.messages[lastUserIdx]!.content as string : "";
        const turnResults = ctx.messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult");

        if (lastText.includes("[KULO_WORKER_RELAY]") && lastText.includes("State: blocked")) {
          const ticketId = /(T-\d{4})/.exec(lastText)![1]!;
          if (turnResults.some((m) => m.toolName === "kulo_ticket_ask_user")) {
            return fauxAssistantMessage([fauxText("请决定是否继续。")]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_ticket_ask_user", {
                ticket_id: ticketId,
                question: "是否继续修改？",
                options: [
                  { id: "go", label: "继续", action: "reply" },
                  { id: "stop", label: "结束", action: "stop" },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (lastText.includes("[KULO_WORKER_RELAY]") && lastText.includes("State: ready")) {
          const ticketId = /(T-\d{4})/.exec(lastText)![1]!;
          if (turnResults.some((m) => m.toolName === "kulo_apply_staged_changes")) {
            return fauxAssistantMessage([fauxText("请确认是否合并敏感改动。")]);
          }
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_apply_staged_changes", {
                command_id: `ask-apply-${ticketId}`,
                ticket_id: ticketId,
                ask_user: true,
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        return fauxAssistantMessage([fauxText("收到。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "p04-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "p04-test", defaultModel: "p04-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    const project = await hub.projects.create({
      commandId: "create-p04-proj",
      name: "P04Proj",
      deviceId: "local",
      workspaceDir: projectDir,
    });

    const t = await hub.dispatchTicket({
      commandId: "p04-dispatch-1",
      title: "暂存改动测试",
      goal: "写入 workflow 文件",
      scope: ".github/workflows/",
      role: "coder",
      projectId: project.id,
      workspaceMode: "staged",
    });

    let decisionCardId = "";
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(snap?.tickets[t.id]?.status).toBe("waiting");
      expect(snap?.tickets[t.id]?.waiting?.cardId).toBeTruthy();
      decisionCardId = snap!.tickets[t.id]!.waiting!.cardId!;
    }, { timeout: 15_000, interval: 40 });

    // Create a second independent decision card (simulating an unsettled stale stop card) plus a manual-split record and dispatched record test.
    const staleBuilt = buildTicketDecisionCard({
      title: t.title,
      question: "过期决策卡",
      options: [{ id: "stale_stop", label: "结束", action: "stop" }],
    });
    const { confirmation: staleConfirm } = await hub.actionConfirmations.ensurePendingCard({
      conversationId: Number(hub.rootConversation.id),
      ticketId: t.id,
      callId: "stale-card-call",
      kind: "ticket_decision",
      fingerprint: "stale-stop-fp-1",
      cardInput: staleBuilt.input,
      logicalIds: staleBuilt.logicalIds,
      payload: {
        kind: "ticket_decision",
        ticketId: t.id,
        runEpoch: 1,
        question: "过期决策卡",
        options: [{ id: "stale_stop", label: "结束", action: "stop" }],
      },
    });

    // Resume ticket directly so it finishes `ready` with stagedDiff and triggers staged_apply card.
    await hub.steerTicket({ ticketId: t.id, commandId: "p04-go", text: "继续执行" });

    let stagedApplyCardId = "";
    await vi.waitFor(async () => {
      const snap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
      expect(snap?.tickets[t.id]?.status).toBe("ready");
      expect(snap?.tickets[t.id]?.workspaceStaging?.stagedDiff?.hasChanges).toBe(true);
      const cards = await hub.uiCards.snapshot(Number(hub.rootConversation.id));
      const applyCard = cards.find((c) => c.title === "确认合并高风险改动");
      expect(applyCard?.status).toBe("ready");
      stagedApplyCardId = applyCard!.cardId;
    }, { timeout: 15_000, interval: 40 });

    // P0-4(a): onTicketSettled auto-settled stale decision cards while keeping staged_apply ready!
    expect((await hub.uiCards.get(decisionCardId))?.status).toBe("submitted");
    expect((await hub.uiCards.get(staleConfirm.cardId!))?.status).toBe("cancelled");
    expect((await hub.uiCards.get(stagedApplyCardId))?.status).toBe("ready");

    // P0-4(b): Even if a fresh stale action='stop' card exists on a ready ticket, clicking stop NEVER clobbers ready or deletes stagedCwd!
    const lateBuilt = buildTicketDecisionCard({
      title: t.title,
      question: "迟到决策卡",
      options: [{ id: "late_stop", label: "结束", action: "stop" }],
    });
    const { confirmation: lateConfirm } = await hub.actionConfirmations.ensurePendingCard({
      conversationId: Number(hub.rootConversation.id),
      ticketId: t.id,
      callId: "late-card-call",
      kind: "ticket_decision",
      fingerprint: "late-stop-fp-2",
      cardInput: lateBuilt.input,
      logicalIds: lateBuilt.logicalIds,
      payload: {
        kind: "ticket_decision",
        ticketId: t.id,
        runEpoch: 2,
        question: "迟到决策卡",
        options: [{ id: "late_stop", label: "结束", action: "stop" }],
      },
    });
    const lateCard = (await hub.uiCards.get(lateConfirm.cardId!))!;
    const lateStopAction = lateCard.actions.find((a) => a.label === "结束")!;
    const lateReceipt = await hub.submitUiAction({
      cardId: lateCard.cardId,
      revision: lateCard.revision,
      actionId: lateStopAction.id,
      values: {},
      commandId: "late-stop-click",
    });
    expect(lateReceipt.card?.resultSummary).toBe("任务已完成");
    const afterLate = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(afterLate?.tickets[t.id]?.status).toBe("ready");
    expect(afterLate?.tickets[t.id]?.workspaceStaging?.stagedCwd).toBeTruthy();
    expect(fs.existsSync(afterLate!.tickets[t.id]!.workspaceStaging!.stagedCwd!)).toBe(true);

    // P1-2: Verify settlePendingForTicket settles manual-split byId pending_orchestrator record AND leaves dispatched record untouched!
    const manualBuilt = buildTicketDecisionCard({
      title: t.title,
      question: "手动分裂测试",
      options: [{ id: "ok", label: "好" }],
    });
    const { confirmation: manualConfirm } = await hub.actionConfirmations.ensurePendingCard({
      conversationId: Number(hub.rootConversation.id),
      ticketId: t.id,
      callId: "manual-split-call",
      kind: "ticket_decision",
      fingerprint: "manual-split-fp",
      cardInput: manualBuilt.input,
      logicalIds: manualBuilt.logicalIds,
      payload: {
        kind: "ticket_decision",
        ticketId: t.id,
        runEpoch: 2,
        question: "手动分裂测试",
        options: [{ id: "ok", label: "好" }],
      },
    });
    const manualActionId = Object.entries(manualConfirm.actionMap).find(([, logical]) => logical === "manual")![0]!;
    await hub.actionConfirmations.resolveFromUiSubmit(manualConfirm.cardId!, manualActionId, { instruction: "改方案" });

    const dispatchedConfirm = await hub.actionConfirmations.createPendingOrchestratorRequest({
      conversationId: Number(hub.rootConversation.id),
      kind: "host_action",
      fingerprint: "dispatched-host-fp",
      payload: {
        kind: "host_action",
        envId: "local",
        envName: "local",
        summary: "已派发命令",
        commands: ["echo hi"],
        ticketId: t.id,
        runEpoch: 2,
      },
    });
    await hub.actionConfirmations.resolveProgrammatically(dispatchedConfirm.id, {
      status: "approved",
      selectedChoiceId: "confirm",
      resultSummary: "已允许",
      markExecuted: false,
    });
    expect(await hub.actionConfirmations.markDispatched(dispatchedConfirm.id)).toBe(true);

    // Close ticket -> settles staged_apply + manual-split pending_orchestrator, does NOT mutate dispatched!
    await hub.closeTicket({ ticketId: t.id, commandId: "close-p04", kind: "obsolete", reason: "测试丢弃关闭" });
    expect((await hub.uiCards.get(stagedApplyCardId))?.status).toBe("cancelled");
    expect((await hub.uiCards.get(stagedApplyCardId))?.resultSummary).toBe("任务已关闭");

    const confirmDoc = await hub.harness.snapshot(ActionConfirmationsDoc, BACKGROUND_CONTEXT);
    expect(confirmDoc?.byId?.[manualConfirm.id]).toMatchObject({ status: "denied", executed: true, effect: "confirmed" });
    expect(confirmDoc?.byId?.[dispatchedConfirm.id]).toMatchObject({ status: "approved", effect: "dispatched" });
    expect(confirmDoc?.byId?.[dispatchedConfirm.id]?.executed).not.toBe(true);
  }, 30_000);
});
