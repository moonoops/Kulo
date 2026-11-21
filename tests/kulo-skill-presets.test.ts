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
const computerAll: SkillRuntimeContext = { platform: "win32", capabilities: ["agent-browser", "agent-desktop"], executionDomain: "computer" };
const emptyRuntime: SkillRuntimeContext = { capabilities: [] };

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
  it("initializes offline, keeps capability manuals out of user snapshot, and selects guides by active capabilities", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const f = await fixture();
    expect(fetch).not.toHaveBeenCalled();

    // User Skills table stays clean with only universal user-facing built-ins
    const all = await f.skills.snapshot();
    expect(all.skills.map((skill) => skill.id)).toEqual(["genui-cards", "interactive-html"]);

    // Computer Use guides load when device capabilities are present; desktop merges macOS/Linux/Windows references
    const ids = (await f.skills.catalog("worker", computerAll)).map((skill) => skill.id);
    expect(ids).toEqual(expect.arrayContaining(["browser-automation", "desktop-automation", "interactive-html"]));
    expect(ids).not.toContain("image-generation");
    expect(ids).not.toContain("video-generation");
    expect(ids).not.toContain("android-automation");
    expect(ids).not.toContain("hindsight-knowledge");
    expect(await f.skills.read("browser-automation", "SKILL.md", "worker", undefined, computerAll)).toContain("kulo_browser");
    expect(await f.skills.read("desktop-automation", "SKILL.md", "worker", undefined, computerAll)).toContain("references/windows.md");
    expect(await f.skills.read("desktop-automation", "references/macos.md", "worker", undefined, computerAll)).toContain("Accessibility (AX)");
    expect(await f.skills.read("desktop-automation", "references/linux.md", "worker", undefined, computerAll)).toContain("AT-SPI");
    expect(await f.skills.read("desktop-automation", "references/windows.md", "worker", undefined, computerAll)).toContain("UI Automation");
    expect(await f.skills.read("desktop-automation", "PROVENANCE.json", "worker", undefined, computerAll)).toContain("agent-desktop");

    // Without capabilities, universal computer worker built-ins and hidden diagram guide appear
    const offline = (await f.skills.catalog("worker", emptyRuntime)).map((skill) => skill.id);
    expect(offline).toEqual(["diagram-design", "interactive-html"]);
  });

  it("gates media, Android, customization, and Hindsight knowledge guides strictly on their runtime conditions", async () => {
    const f = await fixture();

    // Media guides require enabled media kinds
    const withImage = (await f.skills.catalog("chat", { capabilities: [], mediaKinds: ["image"] })).map((s) => s.id);
    expect(withImage).toContain("image-generation");
    expect(withImage).not.toContain("video-generation");

    const withVideo = (await f.skills.catalog("worker", { capabilities: [], mediaKinds: ["video"] })).map((s) => s.id);
    expect(withVideo).toContain("video-generation");
    expect(withVideo).not.toContain("image-generation");

    // Android Worker receives android-automation and hides computer-only interactive-html and diagram-design
    const androidWorker = (await f.skills.catalog("worker", { capabilities: [], executionDomain: "android", androidAvailable: true })).map((s) => s.id);
    expect(androidWorker).toEqual(["android-automation"]);
    expect(await f.skills.read("android-automation", "SKILL.md", "worker", undefined, { capabilities: [], executionDomain: "android", androidAvailable: true })).toContain("android_screen");
    await expect(f.skills.read("interactive-html", "SKILL.md", "worker", undefined, { capabilities: [], executionDomain: "android", androidAvailable: true })).rejects.toMatchObject({ code: "skill_context_denied" });
    await expect(f.skills.read("diagram-design", "SKILL.md", "worker", undefined, { capabilities: [], executionDomain: "android", androidAvailable: true })).rejects.toMatchObject({ code: "skill_context_denied" });

    // Kulo UI self-customization guide appears only when customizationEnabled is true
    const withoutCustom = (await f.skills.catalog("chat", emptyRuntime)).map((s) => s.id);
    expect(withoutCustom).not.toContain("kulo-ui-customization");
    const withCustom = (await f.skills.catalog("chat", { capabilities: [], customizationEnabled: true })).map((s) => s.id);
    expect(withCustom).toContain("kulo-ui-customization");
    expect(await f.skills.read("kulo-ui-customization", "SKILL.md", "settings", undefined, { capabilities: [], customizationEnabled: true })).toContain("HeroUI v3");

    // Hindsight knowledge guide appears only when memoryKnowledgeEnabled is true
    expect((await f.skills.catalog("chat", emptyRuntime)).map((s) => s.id)).not.toContain("hindsight-knowledge");
    expect((await f.skills.catalog("chat", { capabilities: [], memoryKnowledgeEnabled: true })).map((s) => s.id)).toContain("hindsight-knowledge");
    expect(await f.skills.read("hindsight-knowledge", "SKILL.md", "worker", undefined, { capabilities: [], memoryKnowledgeEnabled: true })).toContain("hindsight_get_page_tree");
  });

  it("enforces the same conditions on explicit reads, old version handles and materialization", async () => {
    const f = await fixture();
    const described = await f.skills.describe("desktop-automation", "worker", undefined, computerAll);
    const version = described.version;
    await expect(f.skills.read("desktop-automation", "SKILL.md", "worker", version, emptyRuntime)).rejects.toMatchObject({ code: "skill_context_denied" });
    await expect(f.skills.describe("desktop-automation", "worker", version, emptyRuntime)).rejects.toMatchObject({ code: "skill_context_denied" });
    await expect(f.skills.resources("desktop-automation", "worker", version, emptyRuntime)).rejects.toMatchObject({ code: "skill_context_denied" });
    await expect(f.skills.readBytes("desktop-automation", "SKILL.md", "worker", version)).rejects.toMatchObject({ code: "skill_context_denied" });
    const exec = vi.fn();
    await expect(materializeSkill({ get: () => f.skills, audience: () => "worker", runtimeContext: async () => emptyRuntime,
      executionScope: async () => ({ scratchDir: "/authorized/scratch", assertActive: async () => {} }),
    }, { id: "desktop-automation", version }, { env: { exec } } as never, BACKGROUND_CONTEXT)).rejects.toMatchObject({ code: "skill_context_denied" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps external same-name Skills independent and protects hidden capability presets from direct user management", async () => {
    const f = await fixture();
    const directory = path.join(f.directory, "external"); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nname: desktop-automation\ndescription: External guide.\nmetadata:\n  kulo-audiences: worker\n---\nExternal instructions.\n");
    const imported = await f.skills.manage({ action: "import", source: directory, commandId: "external" });
    const skill = imported.skills.find((entry) => entry.source === "local")!;
    expect(await f.skills.read(skill.id, "SKILL.md", "worker", undefined, emptyRuntime)).toContain("External instructions");
    await expect(f.skills.manage({ action: "disable", id: "browser-automation", commandId: "disable-hidden" })).rejects.toMatchObject({ code: "builtin_skill_managed" });
    expect((await f.skills.catalog("worker", computerAll)).some((entry) => entry.id === "browser-automation")).toBe(true);
  });

  it("reuses unchanged bundled snapshots on restart and still rejects corrupted resources", async () => {
    const f = await fixture();
    const before = await f.skills.snapshot();
    const desktop = await f.skills.describe("desktop-automation", "worker", undefined, computerAll);
    const install = vi.spyOn(skillSources, "installSkillSource");
    const reopened = new KuloSkills({ harness: f.harness, stateDir: path.join(f.directory, "state") });
    await reopened.initialize();
    expect(install).not.toHaveBeenCalled();
    expect(await reopened.snapshot()).toEqual(before);
    const resource = path.join(f.directory, "state", "skills", "packages", desktop.id, desktop.version, "references", "windows.md");
    fs.chmodSync(resource, 0o600);
    fs.writeFileSync(resource, "Corrupted guide.");
    await expect(reopened.initialize()).rejects.toMatchObject({ code: "skill_snapshot_changed" });
    expect(install).not.toHaveBeenCalled();
  });

  it("uses the existing Pi Durable extension loop without preloading Skill bodies", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-skill-pi-"));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    let skills!: KuloSkills;
    let runtime: SkillRuntimeContext = computerAll;
    const requests: TranscriptContext[] = [];
    const provider = fauxProvider({ provider: "openai", models: [{ id: "skills-compatibility" }] });
    provider.setResponses([
      (context) => { requests.push(context); return fauxAssistantMessage([fauxToolCall("kulo_skill_read", { id: "desktop-automation", resource: "references/windows.md" })], { stopReason: "toolUse" }); },
      (context) => { requests.push(context); return fauxAssistantMessage([fauxText("已读取目标设备指引。")]); },
      (context) => { requests.push(context); return fauxAssistantMessage([fauxText("当前设备未启用桌面操控。")]); },
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
    expect(initial).toContain("desktop-automation");
    expect(initial).not.toContain("# Windows Desktop");
    expect(JSON.stringify(requests[1])).toContain("UI Automation");
    runtime = emptyRuntime;
    await conversation.submit({ type: "input", content: "继续当前任务。" }, BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    const sections = requests[2]!.messages.flatMap((message) => message.role === "system" ? [message.sections?.kulo_skills ?? ""] : []);
    expect(sections.at(-1)).not.toContain("desktop-automation");
  });
});
