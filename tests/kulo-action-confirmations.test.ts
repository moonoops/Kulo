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
  buildCustomizationConfirmCard,
  buildExternalPermissionCard,
  buildMemoryServiceConfirmCard,
  buildStagedApplyConfirmCard,
  customizationValidateFingerprint,
} from "../packages/hub/src/action-confirmations.js";
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

describe("Hard-redline user confirmations (Package 2)", () => {
  it("produces strict GenUI-valid confirmation cards for all 3 hard redlines", () => {
    const c1 = buildCustomizationConfirmCard("调整侧边栏间距", ["packages/web/src/App.tsx", "packages/web/src/kulo.css"]);
    expect(() => validateUiCardInput(c1.input)).not.toThrow();
    expect(c1.logicalIds).toEqual(["confirm", "cancel"]);

    const c2 = buildExternalPermissionCard("Run npm test in /workspace?", [
      { id: "allow-once", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ]);
    expect(() => validateUiCardInput(c2.input)).not.toThrow();
    expect(c2.logicalIds).toEqual(["allow-once", "deny"]);

    const c3 = buildStagedApplyConfirmCard({
      ticketId: "T-0001",
      sensitivePaths: [".github/workflows/ci.yml", "package.json"],
      conflictFiles: ["src/index.ts"],
      allowConflicts: true,
    });
    expect(() => validateUiCardInput(c3.input)).not.toThrow();
    expect(c3.logicalIds).toEqual(["confirm", "cancel"]);

    const c4 = buildMemoryServiceConfirmCard({
      operation: "uninstall",
      title: "卸载本机 Hindsight",
      deviceName: "Macmini.local",
      changes: ["Macmini.local", "同时删除此安装的记忆数据"],
    });
    expect(() => validateUiCardInput(c4.input)).not.toThrow();
    expect(c4.logicalIds).toEqual(["confirm", "cancel"]);
  });

  it("gates sensitive staged merges behind a UI card while allowing ordinary merges immediately", async () => {
    const stateDir = tempDir("staged-state");
    const localEnvRoot = tempDir("staged-env");
    const projectDir = tempDir("staged-proj");
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Demo\n");

    const faux = fauxProvider({ provider: "confirm-test", models: [{ id: "confirm-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let mode: "ordinary" | "sensitive" = "ordinary";
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
                mode === "ordinary"
                  ? fauxToolCall("write", { path: "hello.txt", content: "ordinary change\n" })
                  : fauxToolCall("write", { path: ".github/workflows/ci.yml", content: "name: CI\n" }),
              ],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage(
            [fauxToolCall("kulo_report", { state: "ready", summary: mode === "ordinary" ? "Added hello.txt" : "Added workflow" })],
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
                title: mode === "ordinary" ? "普通代码改动" : "修改 CI 工作流",
                goal: mode === "ordinary" ? "新建 hello.txt" : "新建 .github/workflows/ci.yml",
                scope: mode === "ordinary" ? "hello.txt" : ".github/workflows/ci.yml",
                role: "coder",
                project_id: project.id,
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

    // 1. Ordinary merge -> zero confirmation card, applied immediately
    mode = "ordinary";
    await hub.sendUserMessage("新建普通文件 hello.txt");
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(projectDir, "hello.txt"))).toBe(true);
    }, { timeout: 12_000, interval: 40 });
    expect(await hub.uiCards.snapshot(Number(hub.rootConversation.id))).toHaveLength(0);

    // 2. Sensitive path merge (.github/workflows/ci.yml) -> blocked until UI card confirmation
    mode = "sensitive";
    lastApplyToolResult = "";
    await hub.sendUserMessage("修改 CI 工作流");
    await vi.waitFor(() => {
      expect(lastApplyToolResult).toContain("awaiting_user_confirmation");
    }, { timeout: 12_000, interval: 40 });
    expect(fs.existsSync(path.join(projectDir, ".github/workflows/ci.yml"))).toBe(false);

    const cards = await hub.uiCards.snapshot(Number(hub.rootConversation.id));
    expect(cards).toHaveLength(1);
    const confirmCard = cards[0]!;
    expect(confirmCard.status).toBe("ready");
    const confirmAction = confirmCard.actions.find((a) => a.kind === "submit")!;

    // User clicks Confirm in UI -> hub immediately merges the sensitive staged change!
    const receipt = await hub.submitUiAction({
      cardId: confirmCard.cardId,
      revision: confirmCard.revision,
      actionId: confirmAction.id,
      values: {},
      commandId: "user-confirm-sensitive-merge",
    });
    expect(receipt.status).toBe("submitted");
    expect(fs.readFileSync(path.join(projectDir, ".github/workflows/ci.yml"), "utf8")).toBe("name: CI\n");
  });

  it("blocks LLM self-approval of external agent permissions and executes immediately on user card click", async () => {
    const stateDir = tempDir("extperm-state");
    const localEnvRoot = tempDir("extperm-env");
    const faux = fauxProvider({ provider: "extperm-test", models: [{ id: "extperm-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let toolResultText = "";
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall("kulo_external_permission", {
              ticket_id: "T-EXT1",
              run_epoch: 1,
              permission_id: "perm-1",
              choice_id: "allow-once",
            }),
          ],
          { stopReason: "toolUse" },
        ),
      (ctx) => {
        const res = ctx.messages.find((m) => m.role === "toolResult" && m.toolName === "kulo_external_permission");
        toolResultText = res?.content.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
        return fauxAssistantMessage([fauxText("请点击卡片选择权限。")]);
      },
      () => fauxAssistantMessage([fauxText("权限决定已生效。")]),
    ]);

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
        permissions: [],
        nextSequence: 2,
      },
    });

    // Seed an active external ticket with a real pending permission & inject kulo_external_permission
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

    const sub = await hub.sendUserMessage("处理外部权限");
    await sub.wait(BACKGROUND_CONTEXT);

    // LLM attempt was intercepted — external agent did NOT receive respond yet!
    expect(toolResultText).toContain("awaiting_user_confirmation");
    expect(requestSpy).not.toHaveBeenCalled();

    const cards = await hub.uiCards.snapshot(Number(hub.rootConversation.id));
    expect(cards).toHaveLength(1);
    const permCard = cards[0]!;
    const denyAction = permCard.actions.find((a) => a.label === "Deny")!;

    // User clicks "Deny" on card -> Hub immediately forwards exact user choice to external agent!
    await hub.submitUiAction({
      cardId: permCard.cardId,
      revision: permCard.revision,
      actionId: denyAction.id,
      values: {},
      commandId: "user-deny-ext-perm",
    });

    const respondCalls = requestSpy.mock.calls.filter(([, req]) => req.operation === "respond");
    expect(respondCalls).toHaveLength(1);
    expect(respondCalls[0]).toEqual([
      "local",
      {
        operation: "respond",
        runId: "run-ext-1",
        permissionId: "perm-1",
        choiceId: "deny",
      },
    ]);
  });

  it("binds customization confirmation fingerprints strictly to session revision and changed files", () => {
    const fp1 = customizationValidateFingerprint("custom-1", 2, ["packages/web/src/App.tsx"]);
    const fp2 = customizationValidateFingerprint("custom-1", 3, ["packages/web/src/App.tsx"]);
    const fp3 = customizationValidateFingerprint("custom-1", 2, ["packages/web/src/App.tsx", "packages/web/src/evil.ts"]);
    expect(fp1).not.toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });

  it("gates kulo_customization validate behind a UI card and permits validation after user confirmation", async () => {
    const stateDir = tempDir("custom-state");
    const localEnvRoot = tempDir("custom-env");
    const faux = fauxProvider({ provider: "custom-confirm-test", models: [{ id: "custom-confirm-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    const toolOutputs: string[] = [];
    let turn = 0;
    faux.setResponses(
      Array.from({ length: 8 }, () => (ctx: TranscriptContext) => {
        const lastTool = [...ctx.messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "kulo_customization");
        if (lastTool) {
          const text = lastTool.content.map((c) => ("text" in c ? c.text : "")).join("");
          if (!toolOutputs.includes(text)) {
            toolOutputs.push(text);
            return fauxAssistantMessage([fauxText(text.includes("awaiting_user_confirmation") ? "请点击卡片确认。" : "已验证并安排生效。")]);
          }
        }
        turn += 1;
        return fauxAssistantMessage(
          [
            fauxToolCall("kulo_customization", {
              action: "validate",
              request: JSON.stringify({ session_id: "custom-session-1" }),
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

    // 1. First attempt: blocked by hard-redline confirmation card, validateAndStage NOT called
    const sub1 = await hub.sendUserMessage("开始验证界面定制");
    await sub1.wait(BACKGROUND_CONTEXT);
    expect(validateSpy).not.toHaveBeenCalled();
    expect(toolOutputs[0]).toContain("awaiting_user_confirmation");

    const cards = await hub.uiCards.snapshot(Number(hub.rootConversation.id));
    expect(cards).toHaveLength(1);
    const confirmCard = cards[0]!;
    const confirmAction = confirmCard.actions.find((a) => a.kind === "submit")!;

    // 2. User clicks Confirm -> card resolves, kulo_customization is injected, and validateAndStage now executes!
    await hub.submitUiAction({
      cardId: confirmCard.cardId,
      revision: confirmCard.revision,
      actionId: confirmAction.id,
      values: {},
      commandId: "user-confirm-customization-validate",
    });

    await vi.waitFor(() => {
      expect(validateSpy).toHaveBeenCalledTimes(1);
    }, { timeout: 6_000, interval: 40 });
    expect(turn).toBeGreaterThanOrEqual(2);
  });

  it("allows Main Chat to inspect Hub Hindsight status and uninstall via an in-chat confirmation card", async () => {
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

    let step = 0;
    const prepareOutputs: string[] = [];
    faux.setResponses(
      Array.from({ length: 12 }, () => (ctx: TranscriptContext) => {
        const lastTool = ctx.messages.at(-1);
        if (lastTool?.role === "toolResult" && lastTool.toolName === "kulo_memory_service_read") {
          return fauxAssistantMessage(
            [
              fauxToolCall("kulo_memory_service_prepare", {
                operation: "uninstall",
                config: JSON.stringify({ deleteData: true }),
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (lastTool?.role === "toolResult" && lastTool.toolName === "kulo_memory_service_prepare") {
          prepareOutputs.push(lastTool.content.map((c) => ("text" in c ? c.text : "")).join(""));
          return fauxAssistantMessage([fauxText("已生成卸载确认卡，请确认后执行。")]);
        }
        step += 1;
        if (step === 1) {
          return fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: "检查 Hindsight 长期记忆服务 安装状态", limit: 3 })],
            { stopReason: "toolUse" },
          );
        }
        if (step === 2) {
          return fauxAssistantMessage([fauxToolCall("kulo_memory_service_read", {})], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxText("已完成卸载。")]);
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

    const sub = await hub.sendUserMessage("检查一下 macmini 本机是否安装了 hindsight，安装了的话就删了吧");
    await sub.wait(BACKGROUND_CONTEXT);

    expect(uninstallSpy).not.toHaveBeenCalled();
    expect(prepareOutputs).toHaveLength(1);
    expect(prepareOutputs[0]).toContain("awaiting_user_confirmation");

    const cards = await hub.uiCards.snapshot(Number(hub.rootConversation.id));
    expect(cards).toHaveLength(1);
    const confirmCard = cards[0]!;
    const confirmAction = confirmCard.actions.find((a) => a.kind === "submit")!;

    await hub.submitUiAction({
      cardId: confirmCard.cardId,
      revision: confirmCard.revision,
      actionId: confirmAction.id,
      values: {},
      commandId: "user-confirm-hindsight-uninstall",
    });

    await vi.waitFor(() => {
      expect(uninstallSpy).toHaveBeenCalledTimes(1);
      expect(installed).toBe(false);
    }, { timeout: 6_000, interval: 40 });
    expect(uninstallSpy.mock.calls[0]?.[0]?.deleteData).toBe(true);

    const memDoc = await hub.harness.snapshot(MemoryServiceDoc, BACKGROUND_CONTEXT);
    const jobs = Object.values(memDoc?.jobs ?? {});
    expect(jobs.some((job) => job.view.operation === "uninstall" && job.view.status === "succeeded")).toBe(true);
  });

  it("rejects the prepared Hub Hindsight job cleanly when the user cancels the Main Chat confirmation card", async () => {
    const stateDir = tempDir("memory-cancel-state");
    const localEnvRoot = tempDir("memory-cancel-env");

    vi.spyOn(HindsightLocalService.prototype, "inspect").mockResolvedValue({
      installed: true,
      running: true,
      platform: "darwin",
      deviceName: "Macmini.local",
      endpoint: "http://127.0.0.1:18888",
      phase: "running",
    });
    const uninstallSpy = vi.spyOn(HindsightLocalService.prototype, "uninstall").mockResolvedValue({
      installed: false,
      running: false,
      platform: "darwin",
      deviceName: "Macmini.local",
      phase: "absent",
    });

    const faux = fauxProvider({ provider: "mem-cancel-test", models: [{ id: "mem-cancel-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);

    let step = 0;
    faux.setResponses(
      Array.from({ length: 10 }, () => (ctx: TranscriptContext) => {
        const lastTool = ctx.messages.at(-1);
        if (lastTool?.role === "toolResult" && lastTool.toolName === "kulo_memory_service_read") {
          return fauxAssistantMessage(
            [fauxToolCall("kulo_memory_service_prepare", { operation: "uninstall" })],
            { stopReason: "toolUse" },
          );
        }
        if (lastTool?.role === "toolResult" && lastTool.toolName === "kulo_memory_service_prepare") {
          return fauxAssistantMessage([fauxText("请确认是否卸载。")]);
        }
        step += 1;
        if (step === 1) {
          return fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: "检查 Hindsight 长期记忆服务", limit: 3 })],
            { stopReason: "toolUse" },
          );
        }
        if (step === 2) {
          return fauxAssistantMessage([fauxToolCall("kulo_memory_service_read", {})], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxText("已取消卸载。")]);
      }),
    );

    const hub = await openTestHub({
      models,
      providerId: "mem-cancel-test",
      config: {
        stateDir,
        localEnvRoot,
        model: { defaultProvider: "mem-cancel-test", defaultModel: "mem-cancel-model", thinkingLevel: "off" },
      },
    });
    hubs.push(hub);

    const sub = await hub.sendUserMessage("卸载主脑上的 hindsight");
    await sub.wait(BACKGROUND_CONTEXT);

    const cards = await hub.uiCards.snapshot(Number(hub.rootConversation.id));
    expect(cards).toHaveLength(1);
    const cancelAction = cards[0]!.actions.find((a) => a.kind === "cancel")!;

    await hub.submitUiAction({
      cardId: cards[0]!.cardId,
      revision: cards[0]!.revision,
      actionId: cancelAction.id,
      values: {},
      commandId: "user-cancel-hindsight-uninstall",
    });

    expect(uninstallSpy).not.toHaveBeenCalled();
    const memDoc = await hub.harness.snapshot(MemoryServiceDoc, BACKGROUND_CONTEXT);
    expect(Object.values(memDoc?.jobs ?? {}).some((job) => job.view.status === "rejected")).toBe(true);
  });
});
