import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { KuloSkills } from "../packages/hub/src/skills.js";
import { createSkillToolsExtension, materializeSkill } from "../packages/hub/src/tools-skills.js";
import type { SkillRuntimeContext } from "../packages/hub/src/skill-runtime.js";
import * as skillSources from "../packages/hub/src/skill-sources.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const windows: SkillRuntimeContext = { platform: "win32", capabilities: ["agent-browser", "agent-desktop"], reactWorkspace: false };
const react: SkillRuntimeContext = { platform: "linux", capabilities: [], reactWorkspace: true };
const frontend = ["vercel-composition-patterns", "vercel-react-best-practices", "web-design-guidelines"];

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-presets-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const skills = new KuloSkills({ harness, stateDir: path.join(directory, "state") });
  await skills.initialize();
  return { skills, directory, harness };
}

describe("bundled Skill applicability", () => {
  it("initializes offline and selects guides for the executing device", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const f = await fixture();
    expect(fetch).not.toHaveBeenCalled();
    const all = await f.skills.snapshot();
    expect(all.skills).toHaveLength(12);
    const ids = (await f.skills.catalog("worker", windows)).map((skill) => skill.id);
    expect(ids).toEqual(expect.arrayContaining(["browser-automation", "desktop-automation", "desktop-windows"]));
    expect(ids).not.toContain("desktop-macos"); expect(ids).not.toContain("desktop-linux");
    for (const id of frontend) expect(ids).not.toContain(id);
    expect(await f.skills.read("browser-automation", "SKILL.md", "worker", undefined, windows)).toContain("kulo_browser");
    expect(await f.skills.read("desktop-windows", "PROVENANCE.json", "worker", undefined, windows)).toContain("agent-desktop");
    const offline = (await f.skills.catalog("worker", { capabilities: [], reactWorkspace: false })).map((skill) => skill.id);
    expect(offline).toEqual(["image-generation", "video-generation"]);
  });

  it("offers frontend guides only to a confirmed React workspace and reads bodies on demand", async () => {
    const f = await fixture();
    const ids = (await f.skills.catalog("worker", react)).map((skill) => skill.id);
    for (const id of frontend) expect(ids).toContain(id);
    expect(ids).not.toContain("desktop-linux");
    const guide = await f.skills.read("vercel-react-best-practices", "SKILL.md", "worker", undefined, react);
    expect(guide).toContain("kulo_skill_read");
    expect(guide).toContain("HeroUI");
    expect((await f.skills.resources("vercel-react-best-practices", "worker", undefined, react)).length).toBeGreaterThan(50);
  });

  it("enforces the same conditions on explicit reads, old version handles and materialization", async () => {
    const f = await fixture();
    const version = (await f.skills.snapshot()).skills.find((skill) => skill.id === "desktop-macos")!.version;
    await expect(f.skills.read("desktop-macos", "SKILL.md", "worker", version, windows)).rejects.toMatchObject({ code: "skill_context_denied" });
    await expect(f.skills.describe("desktop-macos", "worker", version, windows)).rejects.toMatchObject({ code: "skill_context_denied" });
    await expect(f.skills.resources("desktop-macos", "worker", version, windows)).rejects.toMatchObject({ code: "skill_context_denied" });
    await expect(f.skills.readBytes("desktop-macos", "SKILL.md", "worker", version)).rejects.toMatchObject({ code: "skill_context_denied" });
    const exec = vi.fn();
    await expect(materializeSkill({ get: () => f.skills, audience: () => "worker", runtimeContext: async () => windows,
      executionScope: async () => ({ scratchDir: "/authorized/scratch", assertActive: async () => {} }),
    }, { id: "desktop-macos", version }, { env: { exec } } as never, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "skill_context_denied" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps external same-name Skills independent and preserves preset user settings", async () => {
    const f = await fixture();
    const directory = path.join(f.directory, "external"); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nname: desktop-macos\ndescription: External guide.\nmetadata:\n  kulo-audiences: worker\n---\nExternal instructions.\n");
    const imported = await f.skills.manage({ action: "import", source: directory, commandId: "external" });
    const skill = imported.skills.find((entry) => entry.source === "local")!;
    expect(await f.skills.read(skill.id, "SKILL.md", "worker", undefined, windows)).toContain("External instructions");
    await f.skills.manage({ action: "disable", id: "browser-automation", commandId: "disable" });
    await f.skills.initialize();
    expect((await f.skills.snapshot()).skills.find((entry) => entry.id === "browser-automation")!.enabled).toBe(false);
    expect((await f.skills.catalog("worker", windows)).some((entry) => entry.id === "browser-automation")).toBe(false);
  });

  it("reuses unchanged bundled snapshots on restart and still rejects corrupted resources", async () => {
    const f = await fixture();
    const before = await f.skills.snapshot();
    const install = vi.spyOn(skillSources, "installSkillSource");
    const reopened = new KuloSkills({ harness: f.harness, stateDir: path.join(f.directory, "state") });
    await reopened.initialize();
    expect(install).not.toHaveBeenCalled();
    expect(await reopened.snapshot()).toEqual(before);
    const skill = before.skills.find((entry) => entry.id === "desktop-windows")!;
    const resource = path.join(f.directory, "state", "skills", "packages", skill.id, skill.version, "upstream", "SKILL.md");
    fs.chmodSync(resource, 0o600);
    fs.writeFileSync(resource, "Corrupted guide.");
    await expect(reopened.initialize()).rejects.toMatchObject({ code: "skill_snapshot_changed" });
    expect(install).not.toHaveBeenCalled();
  });

  it("keeps existing and OS-only guides available when React detection is unavailable", async () => {
    const f = await fixture();
    const runtimeContext = vi.fn(async (_api, _context, required) => required.reactWorkspace
      ? { ...windows, diagnostics: ["React 项目检测失败（permission_denied），前端预置 Skill 暂不可用。"] } : windows);
    const extension = createSkillToolsExtension({ get: () => f.skills, audience: () => "worker", runtimeContext });
    const read = extension.tools!.find((tool) => tool.name === "kulo_skill_read")!;
    await read.execute({ id: "image-generation" }, {} as never, BACKGROUND_CONTEXT);
    expect(runtimeContext).not.toHaveBeenCalled();
    await read.execute({ id: "desktop-windows" }, {} as never, BACKGROUND_CONTEXT);
    expect(runtimeContext.mock.calls[0]![2]).toEqual({ reactWorkspace: false });
    await expect(read.execute({ id: "vercel-react-best-practices" }, {} as never, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "skill_context_unavailable" });
    const catalog = await extension.sections![0]!.render({} as never, BACKGROUND_CONTEXT);
    expect(catalog).toContain("permission_denied");
    expect(catalog).toContain("desktop-windows");
    expect(catalog).not.toContain("vercel-react-best-practices");
    await f.skills.manage({ action: "disable", id: "vercel-react-best-practices", commandId: "disable-react" });
    await f.skills.manage({ action: "disable", id: "vercel-composition-patterns", commandId: "disable-composition" });
    await f.skills.manage({ action: "disable", id: "web-design-guidelines", commandId: "disable-design" });
    runtimeContext.mockClear();
    await extension.sections![0]!.render({} as never, BACKGROUND_CONTEXT);
    expect(runtimeContext.mock.calls[0]![2]).toEqual({ reactWorkspace: false });
  });

  it("uses the existing Pi Durable extension loop without loading all Skill bodies", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-skill-pi-"));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    let skills!: KuloSkills;
    let runtime = windows;
    const requests: TranscriptContext[] = [];
    const provider = fauxProvider({ provider: "openai", models: [{ id: "skills-compatibility" }] });
    provider.setResponses([
      (context) => { requests.push(context); return fauxAssistantMessage([fauxToolCall("kulo_skill_read", { id: "desktop-windows" })], { stopReason: "toolUse" }); },
      (context) => { requests.push(context); return fauxAssistantMessage([fauxText("已读取目标设备指引。")]); },
      (context) => { requests.push(context); return fauxAssistantMessage([fauxText("当前项目不需要前端技能。")]); },
    ]);
    const models = createModels(); models.setProvider(provider.provider);
    const extension = createSkillToolsExtension({ get: () => skills, audience: () => "worker", runtimeContext: async () => runtime });
    const registry = createRegistry(); registry.install(extension);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
    skills = new KuloSkills({ harness, stateDir: path.join(directory, "state") }); await skills.initialize();
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "openai", modelId: "skills-compatibility" },
      extensions: [extension], thinkingLevel: "off", maxTurns: 5 } });
    await conversation.submit({ type: "input", content: "读取目标 Windows 设备的桌面指引。" }, BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(requests).toHaveLength(2);
    const initial = JSON.stringify(requests[0]);
    expect(initial).toContain("desktop-windows"); expect(initial).not.toContain("desktop-macos");
    expect(initial).not.toContain("# Windows");
    expect(JSON.stringify(requests[1])).toContain("kulo_desktop");
    expect(JSON.stringify(requests[1])).not.toContain("vercel-react-best-practices");
    runtime = { capabilities: [], reactWorkspace: false };
    await conversation.submit({ type: "input", content: "继续当前任务。" }, BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    const sections = requests[2]!.messages.flatMap((message) => message.role === "system" ? [message.sections?.kulo_skills ?? ""] : []);
    expect(sections.at(-1)).not.toContain("desktop-windows");
  });
});
