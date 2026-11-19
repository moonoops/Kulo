import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanup: Array<() => void | Promise<void>> = [];
const nativeWorkers = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
const frontend = ["vercel-react-best-practices", "vercel-composition-patterns", "web-design-guidelines"];
const answer = () => fauxAssistantMessage([fauxText("任务结果已收到。")]);
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY", "MOCO_ENV_TOKENS"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function isWorker(request: TranscriptContext): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === "moco_report")) || request.messages.some((message) =>
    message.role === "system" && "toolsAdded" in message && Array.isArray(message.toolsAdded) && message.toolsAdded.some((tool) => tool.name === "moco_report"));
}

function catalog(request: TranscriptContext): string {
  return request.messages.flatMap((message) => message.role === "system" ? [message.sections?.moco_skills ?? ""] : []).at(-1) ?? "";
}

async function fixture(react: boolean, operations: Array<{ name: string; args: Record<string, unknown> }>) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-skill-worker-")));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "project");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "skill-flow", private: true, workspaces: ["packages/*"] }));
  if (react) {
    const app = path.join(workspace, "packages", "app"); fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "app", dependencies: { react: "^19.0.0" } }));
  }
  const provider = fauxProvider({ provider: "openai", models: [{ id: "skill-worker-model" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const requests: TranscriptContext[] = [];
  let stage = 0;
  provider.setResponses(Array.from({ length: 48 }, () => (request: TranscriptContext) => {
    if (!isWorker(request)) return answer();
    requests.push(request);
    const operation = operations[stage++];
    return operation ? call(operation.name, operation.args) : call("moco_report", { state: "ready", summary: "预置 Skill 验证完成。" });
  }));
  const hub = await openTestHub({ models, config: {
    authToken: HUB_TEST_ADMIN_TOKEN, stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"), localEnvRoot: path.join(directory, "runtime"),
    enableLocalEnv: true, memory: { enabled: false }, watchdogMinutes: 0,
    model: { defaultProvider: "openai", defaultModel: "skill-worker-model", thinkingLevel: "off", apiKey: "" },
  } });
  cleanup.push(() => hub.close());
  // Known credential text must not corrupt boolean fields in Skill tool JSON.
  hub.connectionManager.rememberSecrets(["false"]);
  const project = await hub.projects.create({ commandId: "skill-project", name: "Skill project", deviceId: "local", workspaceDir: workspace });
  const ticket = await hub.dispatchTicket({ commandId: "skill-work", title: "验证预置 Skill", goal: "读取并准备任务需要的 Skill", scope: "当前项目", role: "coder", projectId: project.id });
  await vi.waitFor(async () => {
    const { ticket: current } = await hub.inspectTicketDetail(ticket.id);
    expect(current.status, JSON.stringify(current.latestReport)).toBe("ready");
    expect(current.cleanupPending).not.toBe(true);
  }, { timeout: 15_000, interval: 25 });
  const completed = (await hub.inspectTicketDetail(ticket.id)).ticket;
  const conversation = await hub.harness.conversation(completed.workerConversationId as ConversationId, BACKGROUND_CONTEXT);
  const results = (await conversation!.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "toolResult" && message.toolName.startsWith("moco_skill_"));
  return { hub, requests, results, ticket: completed };
}

describe.skipIf(!nativeWorkers)("conditional Skills through real Hub Workers", () => {
  it("detects the executing React workspace, reads applicable guides and materializes into its sandbox", async () => {
    vi.stubEnv("MOCO_COMPUTER_USE", "browser,desktop");
    const f = await fixture(true, [
      { name: "moco_skill_read", args: { id: "browser-automation" } },
      { name: "moco_skill_read", args: { id: "desktop-macos" } },
      { name: "moco_skill_read", args: { id: "vercel-react-best-practices" } },
      { name: "moco_skill_materialize", args: { id: "browser-automation" } },
    ]);
    const initial = catalog(f.requests[0]!);
    for (const id of ["browser-automation", "desktop-automation", "desktop-macos", ...frontend]) expect(initial).toContain(`"id":"${id}"`);
    expect(initial).not.toContain('"id":"desktop-linux"'); expect(initial).not.toContain('"id":"desktop-windows"');
    expect(JSON.stringify(f.requests[0])).not.toContain("# React 性能");
    expect(f.results).toHaveLength(4);
    expect(f.results.every((result) => result.role === "toolResult" && !result.isError)).toBe(true);
    const materialized = f.results.find((result) => result.role === "toolResult" && result.toolName === "moco_skill_materialize")!;
    const data = JSON.parse(materialized.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    const browser = (await f.hub.skills.snapshot()).skills.find((skill) => skill.id === "browser-automation")!;
    expect(data).toMatchObject({ id: browser.id, version: browser.version });
    expect(data.directory.startsWith(`${f.ticket.scratchDir}${path.sep}`)).toBe(true);
    expect(fs.readFileSync(path.join(data.directory, "SKILL.md"), "utf8")).toContain("moco_browser");
  });

  it("does not inherit the Hub repository's React stack or disabled desktop capabilities", async () => {
    vi.stubEnv("MOCO_COMPUTER_USE", "");
    const f = await fixture(false, [{ name: "moco_skill_read", args: { id: "vercel-react-best-practices" } }]);
    const initial = catalog(f.requests[0]!);
    expect(initial).toContain('"id":"image-generation"');
    for (const id of [...frontend, "browser-automation", "desktop-automation", "desktop-macos"]) expect(initial).not.toContain(`"id":"${id}"`);
    expect(f.results).toHaveLength(1);
    expect(f.results[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(f.results[0])).toContain("不适用于当前执行设备或项目");
  });
});
