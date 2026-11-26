import { describe, expect, it } from "vitest";
import { defaultRolePresets, type AgentDispatchIntent, type EnvNodeDescriptor, type ExternalAgentKind, type ExternalClientConnection, type RolePreset } from "@kulo/protocol";
import { AgentRoutingError, assertAgentDefaultScopes, assertAgentDispatchAvailable, extractAgentDispatchIntent, normalizeAgentDispatchPolicy, resolveAgentDispatch, resolveRoleOrDirectClient } from "../packages/hub/src/agent-routing.js";

function external(id = "codex-main", kind: ExternalAgentKind = "codex", extra: Partial<RolePreset> = {}): RolePreset {
  return { id, label: id, whenToUse: "Configured external Agent", prompt: "Work within the task", enabled: true,
    external: { kind, envId: "mac", verifiedAt: 100 }, ...extra };
}
function env(id = "mac", extra: Partial<EnvNodeDescriptor> = {}): EnvNodeDescriptor {
  return { id, name: id === "mac" ? "Mac mini" : id, kind: "reverse-ws", executionKind: "pi-env", online: true, platform: "darwin", arch: "arm64", rootDir: "/workspace", capabilities: ["external-agents", "worker-isolation"], connectedAt: 1, lastSeenAt: 1, ...extra };
}
const roles = { ...defaultRolePresets(), "codex-main": external("codex-main", "codex", { label: "代码搭子" }), "claude-main": external("claude-main", "claude-code", { label: "Claude 主力" }), "dsh-main": external("dsh-main", "dsh") };
const intent = (name: string, agentId?: string, kind?: ExternalAgentKind): AgentDispatchIntent => ({ version: 1, targets: [{ name, ...(agentId ? { agentId } : {}), ...(kind ? { kind } : {}) }] });

describe("agent routing intent from actual user text", () => {
  it.each([
    ["让 Codex 修复这个问题", "codex-main"], ["请用代码搭子修复这个问题", "codex-main"],
    ["使用 codex-main 实现功能", "codex-main"], ["这个任务交给 Claude Code 来做", "claude-main"],
    ["指派给 DeepSeek Harness 检查一下", "dsh-main"], ["@codex-main 帮我修复问题", "codex-main"],
    ["Please use Codex to fix this bug", "codex-main"], ["Assign this task to ClaudeCode", "claude-main"],
    ["Codex, please fix this bug", "codex-main"], ["用“Codex”修复问题", "codex-main"],
    ["你能不能让 Codex 修复一下？", "codex-main"], ["能否用 Codex 来实现？", "codex-main"],
    ["这个任务交由 Claude Code 完成", "claude-main"],
  ])("captures an explicit assignment: %s", (text, agentId) => {
    expect(extractAgentDispatchIntent(text!, roles)?.targets).toEqual([expect.objectContaining({ agentId })]);
  });

  it.each([
    "请让「本机 Antigravity 兼容验收」在一个新的临时工作目录创建 hello.txt",
    "请让本机 Antigravity 兼容验收在一个新的临时工作目录创建 hello.txt",
    "交给本机 Antigravity 兼容验收于临时目录执行任务",
    "让本机 Antigravity 兼容验收从临时目录读取文件",
    "让本机 Antigravity 兼容验收到临时目录运行测试",
    "请让“本机 Antigravity 兼容验收”将结果返回",
    "让『本机 Antigravity 兼容验收』把结果发回来",
    '让"本机 Antigravity 兼容验收"进行测试',
  ])("binds a Chinese name followed by a task or location clause: %s", text => {
    const named = external("agy-main", "antigravity", { label: "本机 Antigravity 兼容验收" });
    const pool = { ...roles, [named.id]: named,
      "codex-main": { ...roles["codex-main"], dispatchPolicy: { defaultFor: ["coding" as const] } } };
    const selection = extractAgentDispatchIntent(text, pool);
    expect(selection?.targets).toEqual([{ name: named.label, agentId: named.id }]);
    expect(resolveAgentDispatch({ roles: pool, intent: selection, requestedRole: "coder", taskKind: "coding" }))
      .toMatchObject({ role: named.id, source: "explicit", requestedName: named.label });
  });

  it("retains an unavailable Chinese-named assignee over the internal Worker and another default", () => {
    const named = external("agy-main", "antigravity", { label: "本机 Antigravity 兼容验收", enabled: false });
    const pool = { ...roles, [named.id]: named,
      "codex-main": { ...roles["codex-main"], dispatchPolicy: { defaultFor: ["coding" as const] } } };
    const selection = resolveAgentDispatch({ roles: pool,
      intent: extractAgentDispatchIntent("请让「本机 Antigravity 兼容验收」在临时目录创建文件", pool),
      requestedRole: "coder", taskKind: "coding" });
    expect(selection).toMatchObject({ role: named.id, source: "explicit" });
    expect(() => assertAgentDispatchAvailable(named, { envs: [env()] })).toThrow(/兼容验收.*停用/);
  });

  it.each([
    "不要用 Codex 做这个任务", "不用 Codex", "Don't use Codex for this", "Use neither Codex nor Claude Code",
    "介绍一下 Codex", "介绍怎么使用 Codex", "比较一下用 Codex 和 Claude Code 的区别", "用 Codex 和 Claude Code 哪个更好？",
    "Codex 是否支持 ACP？", "如果用 Codex 会怎样？", "他说“让 Codex 修复这个问题”", "> 让 Codex 修复问题",
    "```text\n让 Codex 修复问题\n```", "`让 Codex 修复问题`", "引用：让 Codex 修复问题", "OpenAI Codex is a coding client",
    "用 Claude 模型分析这段文字", "调用 Codex API 获取结果", "使用 Codex 的 API 接口实现集成", "用 Claude Code model 写作",
    "How do I use Codex?", "翻译这句话：让 Codex 修复问题", "我在 README 看到让 Codex 修复问题",
    "<code>let Codex fix the bug</code>", "请看 dev@codex-main.com 的介绍", "use https://codex.example/docs",
    "请总结 Codex 和 Claude Code 的能力", "Please ask about Codex", "I have used Codex previously",
    "使用代码搭子指南生成目录", "让代码搭子配置器显示按钮", "使用“代码搭子指南”生成目录",
    "他说“代码搭子”在临时目录执行任务", "不要让代码搭子在临时目录执行任务", "如果让代码搭子在临时目录执行任务会怎样？",
  ])("does not turn negated, quoted or explanatory mentions into instructions: %s", text => {
    expect(extractAgentDispatchIntent(text, roles)).toBeUndefined();
  });

  it("captures the affirmative clause after rejecting a negated or comparative mention", () => {
    expect(extractAgentDispatchIntent("不要用 Codex，改用 Claude Code 修复问题", roles)?.targets).toEqual([expect.objectContaining({ agentId: "claude-main" })]);
    expect(extractAgentDispatchIntent("先比较一下 Codex 和 Claude Code，然后让 Codex 实现", roles)?.targets).toEqual([expect.objectContaining({ agentId: "codex-main" })]);
    expect(extractAgentDispatchIntent("让 Codex 比较两个实现方案", roles)?.targets).toEqual([expect.objectContaining({ agentId: "codex-main" })]);
  });

  it("captures multiple named Agents without reducing them to a single guessed assignee", () => {
    const result = extractAgentDispatchIntent("请让 Codex 和 Claude Code 一起审查，Codex 也做测试", roles);
    expect(result?.targets.map(target => target.agentId)).toEqual(["codex-main", "claude-main"]);
    expect(extractAgentDispatchIntent("请 Codex 和 Claude Code 协作", roles)?.targets.map(target => target.agentId)).toEqual(["codex-main", "claude-main"]);
  });

  it("retains an unconfigured platform and an unknown @mention so resolution cannot quietly choose an internal worker", () => {
    expect(extractAgentDispatchIntent("用 Antigravity 来实现功能", roles)).toEqual(intent("Antigravity", undefined, "antigravity"));
    expect(extractAgentDispatchIntent("@missing-agent 请处理这个任务", roles)).toEqual(intent("missing-agent"));
    expect(() => resolveAgentDispatch({ roles, intent: extractAgentDispatchIntent("用 Antigravity 来实现功能", roles), requestedRole: "coder" })).toThrow(/Antigravity.*未配置/);
  });

  it("preserves same-platform ambiguity, but accepts an exact custom name, @id or user-named device", () => {
    const pool = { ...roles, "codex-other": external("codex-other", "codex", { label: "办公室助手", external: { kind: "codex", envId: "office", verifiedAt: 100 } }) };
    expect(extractAgentDispatchIntent("让 Codex 修复问题", pool)).toEqual(intent("Codex", undefined, "codex"));
    expect(() => resolveAgentDispatch({ roles: pool, intent: intent("Codex", undefined, "codex"), requestedRole: "codex-main" })).toThrow(/多个已配置/);
    expect(resolveAgentDispatch({ roles: pool, intent: intent("Codex", undefined, "codex"), requestedRole: "coder", envId: "mac" }).role).toBe("codex-main");
    expect(extractAgentDispatchIntent("交给办公室助手来修复", pool)?.targets[0]?.agentId).toBe("codex-other");
    expect(extractAgentDispatchIntent("@codex-main 修复", pool)?.targets[0]?.agentId).toBe("codex-main");
    expect(extractAgentDispatchIntent("用 Mac mini 上的 Codex 来修复", pool, [env(), env("office")])?.targets[0]?.agentId).toBe("codex-main");
  });

  it("supports an explicit built-in Worker escape from external default policies", () => {
    const pool = { ...roles, "codex-main": { ...roles["codex-main"], dispatchPolicy: { defaultFor: ["coding" as const] } } };
    const selection = extractAgentDispatchIntent("用内置 Worker 实现这个功能", pool);
    expect(selection?.targets[0]?.agentId).toBe("coder");
    expect(resolveAgentDispatch({ roles: pool, intent: selection, requestedRole: "codex-main", taskKind: "coding" })).toMatchObject({ role: "coder", source: "explicit" });
  });
});

describe("deterministic Agent resolution", () => {
  it("overrides an incorrect model role with the user's single named Agent", () => {
    expect(resolveAgentDispatch({ roles, intent: intent("Codex", "codex-main", "codex"), requestedRole: "coder" })).toMatchObject({ role: "codex-main", source: "explicit", requestedName: "Codex", readOnly: false });
    expect(resolveAgentDispatch({ roles, intent: intent("Codex", "codex-main"), requestedRole: "hallucinated-role" }).role).toBe("codex-main");
  });

  it("requires a selection among multiple named Agents and checks only the selected member's availability", () => {
    const pool = { ...roles, "claude-main": { ...roles["claude-main"], enabled: false } };
    const multi: AgentDispatchIntent = { version: 1, targets: [{ name: "Codex", agentId: "codex-main" }, { name: "Claude Code", agentId: "claude-main" }, { name: "Muse", kind: "muse" }] };
    for (const requestedRole of [undefined, "coder", "unknown"]) expect(() => resolveAgentDispatch({ roles: pool, intent: multi, requestedRole })).toThrow(/点名了.*请明确/);
    const selection = resolveAgentDispatch({ roles: pool, intent: multi, requestedRole: "codex-main" });
    expect(selection.role).toBe("codex-main");
    expect(() => assertAgentDispatchAvailable(pool[selection.role as "codex-main"], { envs: [env()] })).not.toThrow();
    const unavailable = resolveAgentDispatch({ roles: pool, intent: multi, requestedRole: "claude-main" });
    expect(() => assertAgentDispatchAvailable(pool[unavailable.role as "claude-main"], { envs: [env()] })).toThrow(/claude-main.*停用/);
  });

  it("keeps inherited task assignments through recovery and worker relays, unless the user supplies a new intent", () => {
    const inheritedAssignment = { agentId: "codex-main", source: "explicit" as const, taskKind: "coding" as const, requestedName: "代码搭子", sourceEntryId: 123 };
    expect(resolveAgentDispatch({ roles, inheritedAssignment, requestedRole: "writer", taskKind: "debugging" })).toEqual({ role: "codex-main", source: "explicit", taskKind: "debugging", requestedName: "代码搭子", readOnly: false });
    expect(resolveAgentDispatch({ roles, inheritedAssignment, intent: intent("Claude 主力", "claude-main"), requestedRole: "coder" }).role).toBe("claude-main");
    expect(() => resolveAgentDispatch({ roles, inheritedAssignment: { ...inheritedAssignment, agentId: "removed" }, requestedRole: "coder" })).toThrow(/原任务绑定已移除/);
  });

  it("applies project-specific defaults before global defaults and filters fixed devices", () => {
    const pool = { ...roles,
      "codex-main": external("codex-main", "codex", { dispatchPolicy: { defaultFor: ["coding", "debugging"] } }),
      "claude-main": external("claude-main", "claude-code", { readOnly: true, dispatchPolicy: { defaultFor: ["coding"], projectIds: ["project-one"] } }),
      "dsh-main": external("dsh-main", "dsh", { external: { kind: "dsh", envId: "office", verifiedAt: 100 }, dispatchPolicy: { defaultFor: ["coding"] } }),
    };
    expect(resolveAgentDispatch({ roles: pool, requestedRole: "coder", projectId: "project-one", envId: "mac" })).toMatchObject({ role: "claude-main", source: "default", taskKind: "coding", readOnly: true });
    expect(resolveAgentDispatch({ roles: pool, taskKind: "coding", projectId: "another-project", envId: "mac" }).role).toBe("codex-main");
    expect(resolveAgentDispatch({ roles: pool, taskKind: "debugging", envId: "mac" }).role).toBe("codex-main");
    expect(resolveAgentDispatch({ roles: pool, taskKind: "coding", envId: "office" }).role).toBe("dsh-main");
    expect(() => resolveAgentDispatch({ roles: pool, taskKind: "coding" })).toThrow(/同优先级默认/);
  });

  it("keeps unavailable defaults selected instead of quietly falling back to internal workers", () => {
    const pool = { ...roles, "codex-main": external("codex-main", "codex", { enabled: false, dispatchPolicy: { defaultFor: ["coding"] } }) };
    const selection = resolveAgentDispatch({ roles: pool, taskKind: "coding", requestedRole: "coder" });
    expect(selection).toMatchObject({ role: "codex-main", source: "default" });
    expect(() => assertAgentDispatchAvailable(pool["codex-main"], { envs: [env()] })).toThrow(/codex-main.*停用/);
  });

  it("requires classification before default routing, while builtin roles supply their known category", () => {
    const pool = { ...roles, "codex-main": external("codex-main", "codex", { dispatchPolicy: { defaultFor: ["coding"] } }) };
    expect(() => resolveAgentDispatch({ roles: pool })).toThrow(/任务类型/);
    expect(() => resolveAgentDispatch({ roles: pool, requestedRole: "codex-main" })).toThrow(/任务类型/);
    expect(resolveAgentDispatch({ roles: pool, requestedRole: "coder" })).toMatchObject({ role: "codex-main", taskKind: "coding" });
    expect(resolveAgentDispatch({ roles: pool, requestedRole: "checker" })).toMatchObject({ role: "checker", taskKind: "review", readOnly: true });
    expect(resolveAgentDispatch({ roles, requestedRole: "architect" })).toMatchObject({ role: "architect", taskKind: "architecture" });
    expect(resolveAgentDispatch({ roles })).toMatchObject({ role: "coder", source: "legacy", taskKind: "coding" });
  });

  it("allows orchestrator-selected external roles via whenToUse while resolving client-level naming across personas on the same client", () => {
    for (const dispatchPolicy of [undefined, { defaultFor: [] }]) {
      const pool = { ...roles, "codex-main": external("codex-main", "codex", { dispatchPolicy }) };
      expect(resolveAgentDispatch({ roles: pool, requestedRole: "codex-main", taskKind: "coding" })).toMatchObject({ role: "codex-main", source: "orchestrator", taskKind: "coding" });
      expect(resolveAgentDispatch({ roles: pool, requestedRole: "codex-main", trustedManual: true })).toMatchObject({ role: "codex-main", source: "manual" });
    }
    const multiPersonaPool = {
      ...roles,
      "codex-architect": external("codex-architect", "codex", { label: "架构师", modelId: "astra", externalClientId: "codex:mac" }),
      "codex-tester": external("codex-tester", "codex", { label: "测试员", modelId: "sol", externalClientId: "codex:mac" }),
    };
    delete (multiPersonaPool as Record<string, RolePreset>)["codex-main"];
    const clientIntent = extractAgentDispatchIntent("让 Codex 设计这个模块的架构", multiPersonaPool);
    expect(resolveAgentDispatch({ roles: multiPersonaPool, intent: clientIntent, requestedRole: "codex-architect", taskKind: "architecture" }))
      .toMatchObject({ role: "codex-architect", source: "explicit", taskKind: "architecture" });
    expect(() => resolveAgentDispatch({ roles: multiPersonaPool, intent: clientIntent, requestedRole: "coder" })).toThrow(/多个已配置/);
    expect(() => resolveAgentDispatch({ roles, requestedRole: "imaginary-agent" })).toThrow(/未配置/);
    expect(() => resolveAgentDispatch({ roles: { only: external("only") } })).toThrow(/内置 Worker/);
    expect(resolveAgentDispatch({ roles, requestedRole: "engineer" })).toMatchObject({ role: "coder", taskKind: "coding" });
  });

  it("returns typed public errors without silently interpreting malformed intent", () => {
    for (const malformed of [{ version: 2, targets: [] }, { version: 1, targets: [] }, { version: 1, targets: [{ name: "Codex", kind: "unknown" }] }]) {
      try { resolveAgentDispatch({ roles, intent: malformed as AgentDispatchIntent }); throw new Error("Expected routing to fail"); }
      catch (error) { expect(error).toBeInstanceOf(AgentRoutingError); expect(error).toMatchObject({ status: 400, code: "invalid_agent_dispatch_intent" }); }
    }
  });
});

describe("default scope validation and Agent availability", () => {
  it("normalizes enum and public project IDs without widening a nonempty project scope", () => {
    expect(normalizeAgentDispatchPolicy(undefined)).toBeUndefined();
    expect(normalizeAgentDispatchPolicy({ defaultFor: [] })).toBeUndefined();
    expect(normalizeAgentDispatchPolicy({ defaultFor: ["review", "coding", "review"], projectIds: ["project-b", "project-a", "project-b"] })).toEqual({ defaultFor: ["coding", "review"], projectIds: ["project-a", "project-b"] });
    expect(normalizeAgentDispatchPolicy({ defaultFor: ["research"], projectIds: [] })).toEqual({ defaultFor: ["research"] });
  });

  it.each([null, {}, { defaultFor: "coding" }, { defaultFor: ["anything"] }, { defaultFor: ["coding"], secret: "value" },
    { defaultFor: ["coding"], projectIds: ["../private"] }, { defaultFor: ["coding"], projectIds: ["constructor"] }, { defaultFor: ["coding"], projectIds: ["password=synthetic-secret"] }])("rejects malformed or private default scope data %#", value => {
    expect(() => normalizeAgentDispatchPolicy(value)).toThrow(AgentRoutingError);
    try { normalizeAgentDispatchPolicy(value); } catch (error) { expect(error).toMatchObject({ status: 400 }); expect(String(error)).not.toContain("synthetic-secret"); }
  });

  it("rejects same-device same-priority overlaps including disabled defaults", () => {
    const a = external("a", "codex", { dispatchPolicy: { defaultFor: ["coding"] } });
    const b = external("b", "claude-code", { enabled: false, dispatchPolicy: { defaultFor: ["coding"] } });
    expect(() => assertAgentDefaultScopes({ a, b })).toThrow(/a.*b.*重叠/);
    expect(() => assertAgentDefaultScopes({ a: { ...a, dispatchPolicy: { defaultFor: ["coding"], projectIds: ["one", "two"] } }, b: { ...b, dispatchPolicy: { defaultFor: ["coding"], projectIds: ["two", "three"] } } })).toThrow(/重叠/);
    expect(() => assertAgentDefaultScopes({ a, b: { ...b, dispatchPolicy: { defaultFor: ["coding"], projectIds: ["one"] } } })).not.toThrow();
    expect(() => assertAgentDefaultScopes({ a, b: { ...b, external: { ...b.external!, envId: "office" } } })).not.toThrow();
    expect(() => assertAgentDefaultScopes({ a, b: { ...b, dispatchPolicy: { defaultFor: ["research"] } } })).not.toThrow();
  });

  it.each(["grok-bot", "dots", "muse"] as const)("keeps %s out of automatic default scopes even while disabled", kind => {
    const experimental = external(kind, kind, { enabled: false, dispatchPolicy: { defaultFor: ["research"] } });
    expect(() => assertAgentDefaultScopes({ experimental })).toThrow(/尚未正式支持默认派发.*用户点名/);
    try { assertAgentDefaultScopes({ experimental }); } catch (error) { expect(error).toMatchObject({ status: 400, code: "agent_default_kind_unsupported" }); }
    expect(() => assertAgentDefaultScopes({ experimental: { ...experimental, dispatchPolicy: { defaultFor: [] } } })).not.toThrow();
    expect(() => assertAgentDefaultScopes({ stable: external("unverified-stable", "codex", { enabled: false, external: { kind: "codex", envId: "mac" }, dispatchPolicy: { defaultFor: ["research"] } }) })).not.toThrow();
  });

  it.each([
    [external("offline"), [env("mac", { online: false })], "offline.*离线"],
    [external("unverified", "codex", { external: { kind: "codex", envId: "mac" } }), [env()], "unverified.*验证"],
    [external("experimental", "grok-bot"), [env()], "experimental.*不支持稳定"],
    [external("reserved", "dots"), [env()], "reserved.*不支持稳定"],
    [external("phone-bound"), [env("mac", { platform: "android", executionKind: "native-device" })], "phone-bound.*不是.*电脑"],
    [external("missing-device"), [], "missing-device.*尚未接入"],
  ] as const)("surfaces the named Agent's exact availability failure %#", (role, envs, message) => {
    expect(() => assertAgentDispatchAvailable(role, { envs })).toThrow(new RegExp(message));
    try { assertAgentDispatchAvailable(role, { envs }); } catch (error) { expect(error).toMatchObject({ status: 409, humanError: expect.any(String) }); }
  });

  it("refuses a fixed-device change and accepts a verified stable client on its own online computer", () => {
    expect(() => assertAgentDispatchAvailable(external(), { envs: [env(), env("office")], envId: "office" })).toThrow(/codex-main.*不能改派/);
    expect(() => assertAgentDispatchAvailable(external(), { envs: [env()], envId: "mac" })).not.toThrow();
    expect(() => assertAgentDispatchAvailable(defaultRolePresets().checker, { envs: [] })).not.toThrow();
  });
});

describe("routing authority boundaries", () => {
  it("supports switching to the built-in Worker through affirmative assignment syntax", () => {
    expect(extractAgentDispatchIntent("换成内置Worker来处理", roles)?.targets[0]?.agentId).toBe("coder");
    expect(extractAgentDispatchIntent("交由内置 Worker 来处理", roles)?.targets[0]?.agentId).toBe("coder");
  });

  it("recognizes registered developer compatibility without accepting unknown roles or shadowing real names", () => {
    const pool = { ...roles, "codex-main": external("codex-main", "codex", { dispatchPolicy: { defaultFor: ["coding"] } }) };
    const selection = extractAgentDispatchIntent("用 developer 实现这个功能", pool);
    expect(selection?.targets[0]?.agentId).toBe("coder");
    expect(resolveAgentDispatch({ roles: pool, intent: selection, requestedRole: "codex-main" })).toMatchObject({ role: "coder", source: "explicit", taskKind: "coding" });
    expect(resolveAgentDispatch({ roles, requestedRole: "developer" })).toMatchObject({ role: "coder", source: "legacy" });
    const named = { ...pool, personal: external("personal", "dsh", { label: "developer" }) };
    expect(extractAgentDispatchIntent("用 developer 来处理", named)?.targets[0]?.agentId).toBe("personal");
    expect(() => resolveAgentDispatch({ roles, requestedRole: "not-a-real-agent" })).toThrow(/未配置/);
  });

  it("retains a user's named device even when it has zero or several configured clients of that platform", () => {
    const devices = [env(), env("office", { name: "办公室电脑" })];
    const missing = extractAgentDispatchIntent("用办公室电脑上的 Codex 来实现", roles, devices)!;
    expect(missing.targets).toEqual([{ name: "Codex", kind: "codex", envId: "office" }]);
    expect(() => resolveAgentDispatch({ roles, intent: missing, requestedRole: "coder", envId: "mac" })).toThrow(/Codex.*office.*未配置/);
    const pool = { ...roles, first: external("first", "codex", { external: { kind: "codex", envId: "office", verifiedAt: 100 } }), second: external("second", "codex", { external: { kind: "codex", envId: "office", verifiedAt: 100 } }) };
    const ambiguous = extractAgentDispatchIntent("让办公室电脑上的 Codex 来实现", pool, devices)!;
    expect(ambiguous.targets[0]).toMatchObject({ kind: "codex", envId: "office" });
    expect(ambiguous.targets[0]?.agentId).toBeUndefined();
    expect(() => resolveAgentDispatch({ roles: pool, intent: ambiguous, envId: "mac" })).toThrow(/多个已配置/);
    expect(resolveAgentDispatch({ roles: pool, intent: intent("代码搭子", "codex-main"), envId: "office" }).role).toBe("codex-main");
    expect(() => assertAgentDispatchAvailable(roles["codex-main"], { envs: devices, envId: "office" })).toThrow(/不能改派/);
  });

  it("recognizes an unknown name only with an explicit @ or Agent marker", () => {
    expect(extractAgentDispatchIntent("让 ResearchBot Agent 来处理", roles)?.targets).toEqual([{ name: "ResearchBot Agent" }]);
    expect(extractAgentDispatchIntent("让小研智能体来检查", roles)?.targets).toEqual([{ name: "小研智能体" }]);
    expect(extractAgentDispatchIntent("让小明处理一下", roles)).toBeUndefined();
    expect(extractAgentDispatchIntent("用新的智能体实现", roles)).toBeUndefined();
  });

  it("bounds explicit targets and refuses unsafe registry names while matching valid names literally", () => {
    expect(() =>
      extractAgentDispatchIntent(
        `${Array.from({ length: 17 }, (_, i) => `@agent-${i}`).join(" ")} 请处理任务`,
        roles,
      ),
    ).toThrow(/最多点名 16/);
    for (const label of ["bad\nname", "bad\u202ename", "bad\ud800name", "x".repeat(201)]) {
      expect(() => extractAgentDispatchIntent("use Codex", { ...roles, unsafe: external("unsafe", "codex", { label }) })).toThrow(/名称或编号/);
    }
    const pool = { ...roles, literal: external("literal", "codex", { label: "literal.*" }), emoji: external("emoji", "codex", { label: "小研👩‍💻" }) };
    expect(extractAgentDispatchIntent("用 literal123 修复", pool)).toBeUndefined();
    expect(extractAgentDispatchIntent("用 literal.* 修复", pool)?.targets[0]?.agentId).toBe("literal");
    expect(extractAgentDispatchIntent("用小研👩‍💻 实现", pool)?.targets[0]?.agentId).toBe("emoji");
  });

  it("ignores unfenced assembly, decorators, CSS at-rules, scoped packages, and SSH hosts while keeping real @agent addressing", () => {
    const unfencedCodeCases = [
      "Why does printf crash in this ARM64 snippet?\n.global main\n.type main, @function\nmain:\n  bl printf@PLT",
      "Check this section header: .section .note.GNU-stack,\"\",@progbits",
      "@Override\npublic void run() { System.out.println(1); }",
      "@dataclass\nclass Item:\n    name: str\n    @property\n    def label(self): return self.name",
      "@pytest.mark.parametrize('x', [1, 2])\ndef test_inc(x): assert x > 0",
      "import { Button } from '@heroui/react';\nimport type { RolePreset } from @kulo/protocol/roles;",
      "@media (max-width: 640px) { .card { display: block; } }\n@tailwind utilities;",
      "/**\n * @param input user payload\n * @returns normalized output\n */\n// @ts-expect-error legacy field",
      "Clone git@github.com:org/repo.git or ssh root@192.0.2.50:22 to inspect logs",
      "Passing callback, @unknown_symbol without any dispatch verb in mid-sentence",
    ];
    for (const sample of unfencedCodeCases) {
      expect(extractAgentDispatchIntent(sample, roles), sample).toBeUndefined();
    }

    // Genuine unknown @agent calls (clause-initial, Markdown-emphasized, semicolon-separated, or preceded by dispatch verb) must still lock!
    expect(extractAgentDispatchIntent("@cursor 重构一下这个函数", roles)).toEqual(intent("cursor"));
    expect(extractAgentDispatchIntent("**@cursor** fix this regression", roles)).toEqual(intent("cursor"));
    expect(extractAgentDispatchIntent("Tests failed; @devin fix it", roles)).toEqual(intent("devin"));
    expect(extractAgentDispatchIntent("@devin, refactor the auth middleware", roles)).toEqual(intent("devin"));
    expect(extractAgentDispatchIntent("请让 @unconfigured-bot 检查构建日志", roles)).toEqual(intent("unconfigured-bot"));
    expect(extractAgentDispatchIntent("    - @codex-main 帮我修复空指针", roles)?.targets[0]?.agentId).toBe("codex-main");
    expect(extractAgentDispatchIntent("让 @codex-main 修一下 foo(a, b) === bar[0] 的崩溃", roles)?.targets[0]?.agentId).toBe("codex-main");

    // Even if a user explicitly names a custom agent after a reserved keyword, knownNames preserves it
    const withCustomOverride = { ...roles, override: external("override", "codex", { label: "override" }) };
    expect(extractAgentDispatchIntent("@override 请检查这段逻辑", withCustomOverride)?.targets[0]?.agentId).toBe("override");
  });

  it("preserves the original role's read-only restriction across explicit, inherited and default reassignment", () => {
    const pool = { ...roles, "codex-main": external("codex-main", "codex", { dispatchPolicy: { defaultFor: ["review", "research"] } }) };
    expect(resolveAgentDispatch({ roles: pool, requestedRole: "checker" })).toMatchObject({ role: "codex-main", source: "default", readOnly: true });
    expect(resolveAgentDispatch({ roles: pool, requestedRole: "scout", intent: intent("Codex", "codex-main") })).toMatchObject({ role: "codex-main", source: "explicit", taskKind: "research", readOnly: true });
    expect(resolveAgentDispatch({ roles: pool, requestedRole: "checker", inheritedAssignment: { agentId: "codex-main", source: "explicit" } })).toMatchObject({ role: "codex-main", readOnly: true });
    const multi: AgentDispatchIntent = { version: 1, targets: [{ name: "scout", agentId: "scout" }, { name: "Codex", agentId: "codex-main" }] };
    expect(resolveAgentDispatch({ roles: pool, requestedRole: "codex-main", intent: multi }).readOnly).toBe(false);
  });

  it("directly invokes a connected third-party client by explicit name when zero roles are bound, while blocking unrequested direct calls", () => {
    const builtins = defaultRolePresets();
    const codexMac: ExternalClientConnection = {
      id: "codex:mac", kind: "codex", envId: "mac", verifiedAt: 100, models: [], updatedAt: 100,
    };
    const codexOffice: ExternalClientConnection = {
      id: "codex:office", kind: "codex", envId: "office", verifiedAt: 100, models: [], updatedAt: 100,
    };
    const kimiMac: ExternalClientConnection = {
      id: "acp:mac:kimi-code", kind: "acp", envId: "mac", label: "Kimi Code", agentRef: "kimi-code",
      executable: "/usr/local/bin/kimi-code", acpArgs: ["acp"], verifiedAt: 100, models: [], updatedAt: 100,
    };
    const clients = { [codexMac.id]: codexMac, [kimiMac.id]: kimiMac };
    const devices = [env("mac"), env("office", { name: "办公室电脑" })];

    // Single connected Codex client with zero bound roles
    const codexIntent = extractAgentDispatchIntent("让 Codex 帮我修一下这个 bug", builtins, devices, clients);
    expect(codexIntent?.targets).toEqual([expect.objectContaining({ agentId: "client:codex:mac", kind: "codex" })]);
    const resolved = resolveAgentDispatch({ roles: builtins, externalClients: clients, intent: codexIntent, requestedRole: "coder" });
    expect(resolved).toMatchObject({ role: "client:codex:mac", source: "explicit" });
    const directPreset = resolveRoleOrDirectClient(resolved.role, builtins, clients);
    expect(directPreset).toMatchObject({ id: "client:codex:mac", label: "Codex", thinkingLevel: "auto" });
    expect(directPreset?.modelId).toBeUndefined();
    expect(() => assertAgentDispatchAvailable(directPreset, { envs: devices, envId: "mac" })).not.toThrow();

    // Custom ACP client invoked directly by label
    const acpIntent = extractAgentDispatchIntent("请让 Kimi Code 审查这段代码", builtins, devices, clients);
    expect(acpIntent?.targets).toEqual([expect.objectContaining({ agentId: "client:acp:mac:kimi-code" })]);
    expect(resolveAgentDispatch({ roles: builtins, externalClients: clients, intent: acpIntent, requestedRole: "coder" }))
      .toMatchObject({ role: "client:acp:mac:kimi-code", source: "explicit" });

    // Multi-device Codex clients require disambiguation unless scoped to one device
    const multiClients = { ...clients, [codexOffice.id]: codexOffice };
    const multiIntent = extractAgentDispatchIntent("让 Codex 修一下", builtins, devices, multiClients);
    expect(multiIntent?.targets[0]?.agentId).toBeUndefined();
    expect(() => resolveAgentDispatch({ roles: builtins, externalClients: multiClients, intent: multiIntent })).toThrow(/多个已配置/);
    expect(resolveAgentDispatch({ roles: builtins, externalClients: multiClients, intent: multiIntent, envId: "office" }).role)
      .toBe("client:codex:office");
    const namedOffice = extractAgentDispatchIntent("让办公室电脑上的 Codex 修一下", builtins, devices, multiClients);
    expect(namedOffice?.targets[0]?.agentId).toBe("client:codex:office");

    // Unverified direct client surfaces exact verification error instead of falling back
    const unverifiedClients = { [codexMac.id]: { ...codexMac, verifiedAt: undefined } };
    const unverifiedRole = resolveRoleOrDirectClient("client:codex:mac", builtins, unverifiedClients);
    expect(() => assertAgentDispatchAvailable(unverifiedRole, { envs: devices, envId: "mac" })).toThrow(/验证/);

    // Orchestrator cannot spontaneously invoke a direct client without explicit user naming
    expect(() => resolveAgentDispatch({ roles: builtins, externalClients: clients, requestedRole: "client:codex:mac" }))
      .toThrow(/仅在用户显式指定/);

    // Explicit built-in Worker escape still works even when coder itself is assigned to Codex
    const coderOnCodex = { ...builtins, coder: { ...builtins.coder!, externalClientId: codexMac.id, external: { kind: "codex" as const, envId: "mac", verifiedAt: 100 } } };
    const internalIntent = extractAgentDispatchIntent("用内置 Worker 来处理", coderOnCodex, devices, clients);
    const internalResolved = resolveAgentDispatch({ roles: coderOnCodex, externalClients: clients, intent: internalIntent });
    expect(internalResolved.source).toBe("explicit");
    expect(coderOnCodex[internalResolved.role]?.external).toBeUndefined();
  });
});
