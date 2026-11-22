import { describe, expect, it, vi } from "vitest";
import { defaultRolePresets, type KuloSettingsView, type RolePreset } from "@kulo/protocol";
import { commitRoleMutation, rebaseRoleDrafts, roleMutationValue } from "./worker-role-settings";
import { internalAgentPresets } from "./external-agents-view";

const analyst: RolePreset = {
  id: "analyst", label: "分析师", whenToUse: "检查数据", prompt: "先检查来源。",
  provider: "api-demo", modelId: "saved-model", thinkingLevel: "high", enabled: true,
};
const writer: RolePreset = {
  id: "writer", label: "写作者", whenToUse: "编写文档", prompt: "清楚表达。", enabled: true,
};
const external: RolePreset = {
  id: "codex-mac", label: "Mac 开发者", whenToUse: "修复代码", prompt: "遵循项目规范。", enabled: true,
  external: { kind: "codex", envId: "mac", version: "1.0", verifiedAt: 123 },
  dispatchPolicy: { defaultFor: ["coding"], projectIds: ["kulo"] },
};
const saved = { analyst, writer, [external.id]: external };
const settings = (revision: number, value: Record<string, RolePreset>) => ({
  globalRevision: revision, blocks: { roles: { revision, value } },
} as KuloSettingsView);

describe("independent agent mutations", () => {
  it("saves only the selected enable flag while retaining every saved manual field and external agent", async () => {
    const response = settings(9, { ...saved, analyst: { ...analyst, enabled: false } });
    const save = vi.fn().mockResolvedValue(response);
    const result = await commitRoleMutation({ revision: 8, value: saved }, { kind: "enabled", id: analyst.id, enabled: false }, save);

    expect(save).toHaveBeenCalledExactlyOnceWith(8, response.blocks.roles.value);
    expect(result).toBe(response);
    const [, payload] = save.mock.calls[0]!;
    expect(payload.analyst).toEqual({ ...analyst, enabled: false });
    expect(payload.writer).toBe(writer);
    expect(payload[external.id]).toBe(external);
    expect(saved.analyst.enabled).toBe(true);
  });

  it("rebases a successful enable save without committing or clearing edits on the same and other agents", async () => {
    const previous = internalAgentPresets(saved);
    const draft = {
      ...previous,
      analyst: { ...analyst, prompt: "本地未保存提示词。", modelId: "draft-model", readOnly: true },
      writer: { ...writer, label: "本地未保存名称", whenToUse: "本地未保存职责" },
    };
    const save = vi.fn(async (revision: number, value: Record<string, RolePreset>) => settings(revision + 1, value));
    const response = await commitRoleMutation({ revision: 8, value: saved }, { kind: "enabled", id: analyst.id, enabled: false }, save);

    const submitted = save.mock.calls[0]![1];
    expect(submitted.analyst?.prompt).toBe(analyst.prompt);
    expect(submitted.analyst?.modelId).toBe(analyst.modelId);
    expect(submitted.writer?.label).toBe(writer.label);
    const incoming = internalAgentPresets(response.blocks.roles.value);
    const rebased = rebaseRoleDrafts(previous, draft, incoming);
    expect(rebased).toEqual({ ...draft, analyst: { ...draft.analyst, enabled: false } });
    expect(rebased).not.toEqual(incoming);
    expect(rebaseRoleDrafts(previous, previous, incoming)).toEqual(incoming);
    expect(saved.analyst.enabled).toBe(true);
  });

  it.each([new Error("network unavailable"), Object.assign(new Error("revision conflict"), { status: 409 })])(
    "propagates a failed save without changing the saved state or the manual drafts: %s", async (failure) => {
      const draft = { ...saved, analyst: { ...analyst, prompt: "本地未保存提示词。" } };
      const before = structuredClone({ saved, draft });
      const save = vi.fn().mockRejectedValue(failure);

      await expect(commitRoleMutation({ revision: 8, value: saved }, { kind: "enabled", id: analyst.id, enabled: false }, save)).rejects.toBe(failure);
      expect(save).toHaveBeenCalledTimes(1);
      expect({ saved, draft }).toEqual(before);
    },
  );

  it("creates an agent with one explicit save and leaves existing edits pending", async () => {
    const created = { ...writer, id: "editor", label: "编辑者" };
    const draft = { analyst: { ...analyst, prompt: "未保存的编辑" }, writer };
    const save = vi.fn(async (revision: number, value: Record<string, RolePreset>) => settings(revision + 1, value));
    const response = await commitRoleMutation({ revision: 8, value: saved }, { kind: "create", role: created }, save);

    expect(save).toHaveBeenCalledExactlyOnceWith(8, { ...saved, editor: created });
    const rebased = rebaseRoleDrafts(internalAgentPresets(saved), draft, internalAgentPresets(response.blocks.roles.value));
    expect(rebased.editor).toEqual(created);
    expect(rebased.analyst?.prompt).toBe("未保存的编辑");
    expect(response.blocks.roles.value.analyst?.prompt).toBe(analyst.prompt);
  });

  it("deletes an agent with one explicit save and preserves another agent's pending edits", async () => {
    const draft = { analyst, writer: { ...writer, prompt: "未保存的写作提示词" } };
    const save = vi.fn(async (revision: number, value: Record<string, RolePreset>) => settings(revision + 1, value));
    const response = await commitRoleMutation({ revision: 8, value: saved }, { kind: "delete", id: analyst.id }, save);

    expect(save).toHaveBeenCalledExactlyOnceWith(8, { writer, [external.id]: external });
    const rebased = rebaseRoleDrafts(internalAgentPresets(saved), draft, internalAgentPresets(response.blocks.roles.value));
    expect(rebased).toEqual({ writer: draft.writer });
    expect(response.blocks.roles.value.writer?.prompt).toBe(writer.prompt);
  });

  it("rejects duplicate and external IDs, missing agents and disabling or deleting the final enabled agent before writing", async () => {
    const save = vi.fn();
    for (const id of [analyst.id, external.id]) {
      await expect(commitRoleMutation({ revision: 8, value: saved }, { kind: "create", role: { ...writer, id } }, save)).rejects.toThrow();
    }
    const lastEnabled = { ...saved, writer: { ...writer, enabled: false }, [external.id]: { ...external, enabled: false } };
    for (const mutation of [{ kind: "enabled", id: analyst.id, enabled: false }, { kind: "delete", id: analyst.id }] as const) {
      await expect(commitRoleMutation({ revision: 8, value: lastEnabled }, mutation, save)).rejects.toThrow();
    }
    await expect(commitRoleMutation({ revision: 8, value: saved }, { kind: "enabled", id: "missing", enabled: true }, save)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it("restores built-in defaults (including built-in roles switched to external engines) while preserving custom external roles", () => {
    const withBuiltInOnExternal: Record<string, RolePreset> = {
      ...saved,
      architect: {
        ...defaultRolePresets().architect!,
        externalClientId: "codex:mac",
        external: { kind: "codex", envId: "mac", verifiedAt: 123 },
      },
    };
    const restored = roleMutationValue(withBuiltInOnExternal, { kind: "restore" });
    expect(internalAgentPresets(restored)).toEqual(defaultRolePresets());
    expect(restored.architect?.external).toBeUndefined();
    expect(restored[external.id]).toBe(external);
    expect(restored.analyst).toBeUndefined();
  });
});

describe("manual agent drafts after a live mutation", () => {
  it("keeps only user-edited properties and adopts server normalization for untouched properties", () => {
    const draft = { analyst: { ...analyst, provider: undefined, prompt: "本地提示词" }, writer };
    const incoming = { analyst: { ...analyst, enabled: false, thinkingLevel: "medium" }, writer };
    const rebased = rebaseRoleDrafts({ analyst, writer }, draft, incoming);

    expect(rebased.analyst).toEqual({ ...incoming.analyst, provider: undefined, prompt: "本地提示词" });
    expect(rebased.writer).toBeDefined();
    expect(analyst.enabled).toBe(true);
    expect(draft.analyst.thinkingLevel).toBe("high");
  });
});
