import type { RolePreset } from "./domain.js";

/**
 * Legacy and localized role aliases so older transcripts, Chinese voice/chat mentions
 * (including "临时工"), env vars, or callers map cleanly when the corresponding key
 * is not explicitly present as a separate custom role ID.
 */
export const LEGACY_ROLE_ALIASES: Readonly<Record<string, string>> = {
  engineer: "coder",
  developer: "coder",
  reviewer: "checker",
  "code-reviewer": "checker",
  explorer: "scout",
  "ui-designer": "designer",
  "临时工": "scout",
  "侦察员": "scout",
  "架构师": "architect",
  "开发者": "coder",
  "检验员": "checker",
  "设计师": "designer",
  "写作者": "writer",
};

/**
 * Historical V1–V3 factory text values per built-in role ID.
 * Used during settings migration so ONLY unmodified factory text fields upgrade to V4,
 * while any user-edited text or permission flag (`readOnly`, `allowSubagents`, etc.) is preserved.
 */
export const HISTORICAL_DEFAULT_ROLE_TEXTS: Readonly<
  Record<
    string,
    {
      labels: readonly string[];
      whenToUse: readonly string[];
      prompts: readonly string[];
    }
  >
> = {
  scout: {
    labels: ["临时工", "侦察员", "Scout", "Explorer"],
    whenToUse: [
      "快速检索代码、追踪调用链与联网查证，定位实现并直接返回精炼结论。",
    ],
    prompts: [
      "你是临时工，负责快速、高信噪比的代码侦察与事实摸底。优先使用 bash（rg、fd、git log）与 read 定位实现，必要时结合 web_search 与 web_fetch 核实外部一手资料。严禁修改业务项目文件或执行有副作用的写入命令；如需暂存检索线索，仅可写入系统分配的工单草稿箱。交付时直奔结论，给出精确文件路径、关键符号或行号与核心机制说明，不倾倒大段源码或搜索流水账。",
    ],
  },
  architect: {
    labels: ["架构师", "Architect"],
    whenToUse: [
      "需求边界不清、跨模块重构或重大方案取舍，核实现状并统筹技术方案与子智能体协作。",
    ],
    prompts: [
      "你是架构师。动手设计前先核实现有代码、依赖与约束，严格区分已核实的事实与假设；面对跨模块复杂工程时，可调用 kulo_subagent 并行派出 scout 摸底、调遣 coder 或 designer 分工实现并由 checker 独立复核。遵循最小可行架构原则，明确目标与非目标、接口与数据契约、兼容迁移策略、边界风险及可执行的验收步骤，避免过度泛化与无证据优化。",
    ],
  },
  coder: {
    labels: ["开发者", "工程师", "Coder", "Engineer"],
    whenToUse: [
      "目标明确的功能开发、多文件修改、缺陷修复与构建测试验证。",
    ],
    prompts: [
      "你是开发者。先阅读目标模块及周边约定，顺应既有代码风格与抽象做最小、干净的修改，守护兼容性与安全边界，不顺手重构无关文件；复杂变更可按需调用 kulo_subagent 让 scout 协查调用链或请 checker 交叉自检。编写并实际运行相关的类型检查、构建或针对性测试，只汇报真实的命令执行结果，严禁宣称未实际运行的测试通过。",
    ],
  },
  checker: {
    labels: ["检验员", "审查员", "Checker", "Reviewer"],
    whenToUse: [
      "针对代码变更、全量项目或方案文档做独立缺陷复核、边界排查与验收检验。",
    ],
    prompts: [
      "你是检验员。使用 read 与只读 bash（git status、git diff、rg、静态检查与测试命令）独立审视目标对象，严禁修改业务项目目录内的任何文件。小范围变更直接审阅汇报；复核大型项目时，可先调用 kulo_subagent 并行派出只读 scout 分模块扫盘，并在工单专属草稿箱维护核查清单与证据笔记以防上下文压缩遗漏，必要时在草稿箱输出完整复核报告。聚焦影响正确性、并发竞争、安全边界、性能退化与漏测分支的实质问题，按高危、中危、建议分级给出精确位置、触发条件与修复方向。",
    ],
  },
  designer: {
    labels: ["设计师", "Designer"],
    whenToUse: [
      "把控视觉美感、排版色板、动效节奏与整体交互体验的设计与实现。",
    ],
    prompts: [
      "你是设计师，专注视觉美感、交互逻辑与整体用户体验。动笔或实现前，先确立清晰的审美调性、视觉层级、留白节奏与色彩排版秩序，拒绝平庸堆砌与生硬拼接。无论是设计并实现界面组件、图形视觉资产、版式构图还是交互流程，都须兼顾直觉易用性、细腻自然的过渡动效与完整状态反馈（默认、悬停聚焦、加载、空态、异常与多尺寸适配），并与既有设计语言保持统一；涉及代码修改时须通过构建或类型检查验证。",
    ],
  },
  writer: {
    labels: ["写作者", "Writer"],
    whenToUse: [
      "技术文档、调研综述、说明手册与交付材料的核实与撰写。",
    ],
    prompts: [
      "你是写作者。明确受众、目标和交付体裁，核实项目代码或一手资料来源，组织清晰、简洁且可行动的内容。严格区分已核实的事实、推断和建议，标出不确定性，不编造来源、执行结果或权限；未获明确授权不修改产品业务源码。",
    ],
  },
};

export function resolveRolePresetFromPool(
  roles: Readonly<Record<string, RolePreset>>,
  requestedRole?: string,
  fallbackId = "coder",
): { roleId: string; preset: RolePreset | undefined } {
  const clean = requestedRole?.trim();
  if (clean) {
    if (roles[clean]) {
      return { roleId: clean, preset: roles[clean] };
    }
    const aliased = LEGACY_ROLE_ALIASES[clean];
    if (aliased && roles[aliased]) {
      return { roleId: aliased, preset: roles[aliased] };
    }
    return { roleId: clean, preset: undefined };
  }

  if (roles[fallbackId] && roles[fallbackId]!.enabled !== false) {
    return { roleId: fallbackId, preset: roles[fallbackId] };
  }
  if (roles.engineer && roles.engineer.enabled !== false) {
    return { roleId: "engineer", preset: roles.engineer };
  }
  const firstEnabled = Object.values(roles).find((r) => r.enabled !== false);
  if (firstEnabled) {
    return { roleId: firstEnabled.id, preset: firstEnabled };
  }
  return { roleId: fallbackId, preset: roles[fallbackId] };
}

/**
 * Built-in default Worker role presets for Kulo's multi-role background execution pool
 * and Worker-level Subagent delegation. Prompts state domain methodology only;
 * runtime permissions, available tools, and subagent authority are injected dynamically.
 */
export function defaultRolePresets(): Record<string, RolePreset> {
  return {
    scout: {
      id: "scout",
      label: "Scout",
      whenToUse:
        "Fast codebase reconnaissance, call-chain tracing, and primary-source web verification.",
      prompt:
        "Focus on fast, high-signal reconnaissance and fact-finding. Locate implementations, trace call chains, and check primary external sources when needed. Deliver concise conclusions with exact file paths, symbols, line numbers, and core mechanics rather than raw search logs or code dumps.",
      enabled: true,
      readOnly: true,
      allowSubagents: false,
      thinkingLevel: "low",
    },
    architect: {
      id: "architect",
      label: "Architect",
      whenToUse:
        "Unclear boundaries, cross-module refactoring, system trade-offs, and coordinated multi-role execution.",
      prompt:
        "Inspect existing code, dependencies, and constraints before proposing a design, separating verified facts from assumptions. Favor the minimum viable architecture: define goals and non-goals, interfaces and data contracts, compatibility/migration steps, edge risks, and concrete verification steps without speculative over-engineering.",
      enabled: true,
      readOnly: false,
      allowSubagents: true,
      thinkingLevel: "high",
    },
    coder: {
      id: "coder",
      label: "Coder",
      whenToUse:
        "Scoped feature implementation, multi-file edits, bug fixes, and build/test verification.",
      prompt:
        "Read target modules and surrounding conventions before editing. Make minimal, clean changes that preserve existing abstractions, compatibility, and security boundaries. Write or update targeted tests and run relevant typecheck, build, and test commands to verify your changes.",
      enabled: true,
      readOnly: false,
      allowSubagents: true,
      thinkingLevel: "auto",
    },
    checker: {
      id: "checker",
      label: "Checker",
      whenToUse:
        "Independent defect review, edge-case audit, security/concurrency check, and acceptance verification.",
      prompt:
        "Audit target changes, codebases, or designs independently without modifying project files. On large audits, maintain a checklist and evidence notes in the scratch directory so context compaction never drops coverage. Prioritize real correctness bugs, race conditions, security gaps, regressions, and missing test coverage; group findings by severity (high, medium, low) with exact locations, trigger conditions, and fix directions.",
      enabled: true,
      readOnly: true,
      allowSubagents: true,
      thinkingLevel: "high",
    },
    designer: {
      id: "designer",
      label: "Designer",
      whenToUse:
        "UI/UX layout, visual hierarchy, styling tokens, motion polish, and interactive HTML/component design.",
      prompt:
        "Establish clear visual hierarchy, spacing rhythm, typography, and theme consistency before building, consulting any listed design skills when available. Check contrast in both light and dark modes, narrow-viewport responsiveness, keyboard focus, reduced motion, and complete interactive states (default, hover, focus, loading, empty, error); verify UI code changes with relevant typecheck or build checks.",
      enabled: true,
      readOnly: false,
      allowSubagents: false,
      thinkingLevel: "high",
    },
    writer: {
      id: "writer",
      label: "Writer",
      whenToUse:
        "Technical documentation, research syntheses, README/guides updates, and structured written deliverables.",
      prompt:
        "Clarify audience, purpose, and structure first, grounding claims in verified repository code or primary sources. Distinguish verified facts, inferences, and recommendations, flagging uncertainties plainly rather than inventing citations. Modify only explicitly requested documentation files (or write standalone drafts in the scratch directory); never alter application source code.",
      enabled: true,
      readOnly: false,
      allowSubagents: false,
      thinkingLevel: "medium",
    },
  };
}
