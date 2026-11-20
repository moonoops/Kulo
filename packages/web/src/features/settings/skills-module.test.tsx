import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillRecord, SkillSnapshot } from "@kulo/protocol";
import { kuloRest } from "../../kulo-api";
import { acceptSkillSnapshot, SkillSettingsFields, SkillsModule, skillStatusLabel } from "./skills-module";

const skill: SkillRecord = { id: "import-one", name: "report-workflow", description: "整理工作报告", source: "local", sourceUrl: "/fixture/report", version: "version-one", enabled: true, audiences: ["chat", "worker"], dependencies: [], diagnostics: [], createdAt: 1, updatedAt: 1 };
const snapshot: SkillSnapshot = { revision: 5, skills: [skill] };
const render = (next: SkillSnapshot | null = snapshot, connected = true) => renderToStaticMarkup(<SkillsModule snapshot={next} connected={connected} onRequest={vi.fn()} onRefresh={vi.fn()} />);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("direct skill settings", () => {
  it("shows distinct state, enable and lightweight edit/remove controls in named columns", () => {
    const html = render();
    expect(html).toContain('aria-label="技能列表"');
    expect(html.match(/role="columnheader"/g)).toHaveLength(5);
    expect(html).toContain("启用");
    expect(html).toContain("已启用");
    expect(html).toContain('aria-label="编辑report-workflow"');
    expect(html).toContain('aria-label="删除report-workflow"');
    expect(html).not.toContain("管理");
    expect(html).toContain("kulo-settings-table-action-group");
    for (const button of html.match(/<button\b(?=[^>]*aria-label="(?:编辑|删除)report-workflow")[^>]*>/g) ?? []) {
      expect(button).toContain("button--ghost");
      expect(button).not.toContain("disabled");
    }
    const toggle = html.match(/<input\b(?=[^>]*role="switch")[^>]*>/)?.[0];
    expect(toggle).toContain("checked");
    expect(toggle).not.toContain("disabled");
  });

  it("keeps actual data visible offline and protects built-in skills from deletion while allowing edits", () => {
    const builtin = { ...skill, id: "genui-cards", name: "genui-cards", source: "builtin" as const };
    const html = render({ revision: 5, skills: [builtin] });
    expect(html).toContain("内置");
    expect(html).toMatch(/<button\b(?=[^>]*aria-label="编辑genui-cards")(?![^>]*disabled)[^>]*>/);
    expect(html).toMatch(/<button\b(?=[^>]*aria-label="删除genui-cards")(?=[^>]*disabled)[^>]*>/);
    expect(html).toContain("内置技能随应用维护，不能删除");
    const offline = render(snapshot, false);
    expect(offline).toContain(skill.description);
    expect(offline).toMatch(/<input\b(?=[^>]*role="switch")(?=[^>]*disabled)[^>]*>/);
    expect(offline).toMatch(/<button\b(?=[^>]*aria-label="编辑report-workflow")(?=[^>]*disabled)[^>]*>/);
  });

  it("distinguishes a cold read from an empty catalog and uses honest status labels", () => {
    expect(render(null)).toContain('aria-label="加载技能"');
    expect(render(null)).not.toContain("尚无技能");
    expect(render({ revision: 1, skills: [] })).toContain("尚无技能");
    expect(skillStatusLabel({ ...skill, enabled: false, diagnostics: ["缺少 node"] })).toBe("已停用");
    expect(skillStatusLabel({ ...skill, diagnostics: ["缺少 node"] })).toBe("需处理");
  });

  it("provides real editable usage scopes and enabled state without exposing arbitrary sources or file writes", () => {
    const html = renderToStaticMarkup(<SkillSettingsFields value={skill} onChange={vi.fn()} />);
    for (const label of ["启用技能", "使用范围", "主聊天", "后台任务", "设置助手"]) expect(html).toContain(label);
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain("/fixture/report");
    const disabled = renderToStaticMarkup(<SkillSettingsFields value={skill} disabled onChange={vi.fn()} />);
    for (const input of disabled.match(/<input\b[^>]*>/g) ?? []) expect(input).toContain("disabled");
  });

  it("does not regress a completed direct edit with an older parent refresh", () => {
    const edited: SkillSnapshot = { revision: 6, skills: [{ ...skill, enabled: false }] };
    expect(acceptSkillSnapshot(edited, snapshot)).toBe(edited);
    expect(acceptSkillSnapshot(snapshot, edited)).toBe(edited);
    expect(acceptSkillSnapshot(edited, { ...snapshot, revision: 6 })).toBe(edited);
  });

  it("keeps background refreshes in the same state scope and ends that scope when the owning catalog is cleared", () => {
    const props = { snapshot, connected: true, onRequest: vi.fn(), onRefresh: vi.fn() };
    const current = SkillsModule(props);
    const background = SkillsModule({ ...props, snapshot: { ...snapshot, revision: 6 } });
    const cleared = SkillsModule({ ...props, snapshot: null });
    expect([background.type, background.key]).toEqual([current.type, current.key]);
    expect([cleared.type, cleared.key]).not.toEqual([current.type, current.key]);
    const pending = renderToStaticMarkup(cleared);
    expect(pending).toContain('aria-label="加载技能"');
    expect(pending).not.toContain(skill.name);
    const replacement = SkillsModule({ ...props, snapshot: { revision: 1, skills: [{ ...skill, id: "new-owner", name: "new-owner-skill" }] } });
    expect([replacement.type, replacement.key]).not.toEqual([cleared.type, cleared.key]);
    const loaded = renderToStaticMarkup(replacement);
    expect(loaded).toContain("new-owner-skill");
    expect(loaded).not.toContain(skill.name);
  });
});

describe("skill REST requests", () => {
  it("sends only a skill identity, supported settings and catalog revision/command identity", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(snapshot), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const change = { enabled: false, audiences: ["worker" as const], expectedRevision: 5, commandId: "edit-once" };
    expect(await kuloRest.updateSkill("import-one", change)).toEqual(snapshot);
    expect(fetch).toHaveBeenLastCalledWith("/api/skills/import-one", expect.objectContaining({ method: "PATCH", body: JSON.stringify(change) }));
    const remove = { expectedRevision: 5, commandId: "remove-once" };
    expect(await kuloRest.deleteSkill("import-one", remove)).toEqual(snapshot);
    expect(fetch).toHaveBeenLastCalledWith("/api/skills/import-one", expect.objectContaining({ method: "DELETE", body: JSON.stringify(remove) }));
    expect(await kuloRest.getSkills()).toEqual(snapshot);
    expect(fetch).toHaveBeenLastCalledWith("/api/skills", expect.objectContaining({ method: "GET" }));
  });
});
