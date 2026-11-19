import { defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { SkillAudience } from "@moco/protocol";
import type { MocoSkills } from "./skills.js";
import { SkillError } from "./skills.js";
import { writeExecutionFile } from "./execution-files.js";
import type { SkillRuntimeContext } from "./skill-runtime.js";
import { resolveDeferredAddTools } from "./tool-surface.js";

export interface SkillToolsOptions {
  get: () => MocoSkills;
  audience: (api: Pick<ToolExecutionApi, "conversationId">) => SkillAudience | Promise<SkillAudience>;
  runtimeContext?: (api: Pick<ToolExecutionApi, "conversationId" | "env">, context: Context, requirements: { reactWorkspace: boolean }) => Promise<SkillRuntimeContext | undefined>;
  executionScope?: (api: ToolExecutionApi) => Promise<{ scratchDir: string; assertActive: () => Promise<void> }>;
}

const CHECK_DEPENDENCY = String.raw`const fs = require('node:fs'), path = require('node:path');
const name = process.argv[1], dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
for (const directory of dirs) for (const extension of extensions) {
  try { const target = path.join(directory, name + extension); if (fs.statSync(target).isFile()) { fs.accessSync(target, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); process.exit(0); } }
  catch (error) { if (!['ENOENT','ENOTDIR','EACCES'].includes(error.code)) process.exit(21); }
}
process.exit(20);`;

async function skillRuntime(options: SkillToolsOptions, audience: SkillAudience, id: string | undefined, api: Pick<ToolExecutionApi, "conversationId" | "env">, context: Context) {
  if (!options.runtimeContext) return undefined;
  const required = await options.get().runtimeRequirements(audience, id);
  if (!required.targetDevice && !required.reactWorkspace) return undefined;
  const runtime = await options.runtimeContext(api, context, { reactWorkspace: required.reactWorkspace });
  if (id && required.reactWorkspace && runtime?.diagnostics?.length) throw new SkillError(409, "skill_context_unavailable", runtime.diagnostics.join(" "));
  return runtime;
}

export async function materializeSkill(options: SkillToolsOptions, args: { id: string; version?: string }, api: ToolExecutionApi, context: Context) {
  if (await options.audience(api) !== "worker" || !api.env || !options.executionScope) throw new SkillError(403, "skill_materialize_scope_denied", "只有运行中的 Worker 可以在受控执行目录准备 Skill 资源。");
  const env = api.env;
  const scope = await options.executionScope(api);
  await scope.assertActive();
  let release: (() => void) | undefined;
  try {
    if (args.version) release = options.get().retainVersion(args.id, args.version);
    const runtime = await skillRuntime(options, "worker", args.id, api, context);
    const skill = await options.get().describe(args.id, "worker", args.version, runtime);
    release ??= options.get().retainVersion(skill.id, skill.version);
    for (const dependency of skill.dependencies) {
      await scope.assertActive();
      const result = getOrThrow(await env.exec(["node", "-e", CHECK_DEPENDENCY, dependency], { timeout: 10_000 }, context));
      if (result.exitCode === 20) throw new SkillError(409, "skill_dependency_missing", `目标节点缺少 ${dependency}，未安装依赖或执行 Skill。`);
      if (result.exitCode !== 0) throw new SkillError(500, "skill_dependency_check_failed", "目标节点依赖检查失败。");
    }
    const files = await options.get().resources(skill.id, "worker", skill.version, runtime);
    await scope.assertActive();
    getOrThrow(await env.createDir(scope.scratchDir, { recursive: true }, context));
    const directory = getOrThrow(await env.joinPath([scope.scratchDir, "moco-skills", skill.id, skill.version], context));
    const copied: Array<{ resource: string; path: string; hash: string; executable: boolean }> = [];
    for (const file of files) {
      const target = getOrThrow(await env.joinPath([directory, file.path], context));
      const bytes = await options.get().readBytes(skill.id, file.path, "worker", skill.version, runtime);
      const result = await writeExecutionFile({ env, root: scope.scratchDir, target, size: file.size, hash: file.hash,
        chunks: (async function* () { yield bytes; })(), assertActive: scope.assertActive, context });
      await scope.assertActive();
      const mode = file.executable ? "500" : "400";
      const permissions = getOrThrow(await env.exec(["node", "-e", "require('node:fs').chmodSync(process.argv[1], parseInt(process.argv[2], 8))", result.path, mode], { timeout: 10_000 }, context));
      if (permissions.exitCode !== 0) throw new SkillError(500, "skill_permissions_failed", "无法设置目标节点的 Skill 文件权限。");
      copied.push({ resource: file.path, path: result.path, hash: file.hash, executable: file.executable });
    }
    return { id: skill.id, version: skill.version, envId: env.id, directory, files: copied };
  } finally { release?.(); }
}

export function createSkillToolsExtension(options: SkillToolsOptions) {
  const readSkill = async (args: { id: string; resource?: string; version?: string }, api: ToolExecutionApi, context: Context) => {
    const audience = await options.audience(api);
    const runtime = await skillRuntime(options, audience, args.id, api, context);
    const addTools = audience === "worker"
      ? await resolveDeferredAddTools(api, context, ["moco_skill_materialize"])
      : [];
    try {
      const text = await options.get().read(args.id, args.resource ?? "SKILL.md", audience, args.version, runtime);
      return { output: [{ type: "text" as const, text }], ...(addTools.length ? { control: { addTools } } : {}) };
    } catch (error) {
      if (audience === "settings" && error instanceof SkillError && error.status === 403) {
        const chatRuntime = await skillRuntime(options, "chat", args.id, api, context);
        return { output: [{ type: "text" as const, text: await options.get().read(args.id, args.resource ?? "SKILL.md", "chat", args.version, chatRuntime) }] };
      }
      throw error;
    }
  };
  const renderSkills = async (api: Pick<ToolExecutionApi, "conversationId" | "env">, context: Context) => {
    const audience = await options.audience(api);
    const runtime = await skillRuntime(options, audience, undefined, api, context);
    let skills = await options.get().catalog(audience, runtime);
    if (audience === "settings") {
      const chatRuntime = await skillRuntime(options, "chat", undefined, api, context);
      const chatSkills = await options.get().catalog("chat", chatRuntime);
      const seen = new Set(skills.map((item) => item.id));
      skills = [...skills, ...chatSkills.filter((item) => !seen.has(item.id))];
    }
    return ["Available on-demand Skills (call `moco_skill_read` when relevant; Skills grant no extra permissions, and Workers needing bundled assets/scripts must stage them via `moco_skill_materialize` using the returned node path):",
      ...(runtime?.diagnostics ?? []),
      ...skills.map((skill) => JSON.stringify({ id: skill.id, name: skill.name, description: skill.description, version: skill.version }))].join("\n");
  };
  const extension = defineExtension({
    name: "moco-skills",
    sections: [section("moco_skills", (api, context) => renderSkills(api, context))],
    tools: [
      defineTool({ name: "moco_skill_read", description: "Read a Skill's `SKILL.md` (default) or bundled reference resource within the current Agent's audience and device/project eligibility.", parameters: obj({ id: str(), resource: opt(str()), version: opt(str()) }), replay: "safe", execute: readSkill }),
      defineTool({ name: "moco_skill_materialize", description: "Worker only: verify target-node dependencies and stage a pinned Skill's resources into the ticket scratch directory (does not install dependencies or execute scripts). 关键词：展开技能包 准备技能脚本 释放模板资源", parameters: obj({ id: str(), version: opt(str()) }), deferred: true, replay: "safe", execute: async (args, api, context) => ({ output: [{ type: "text" as const,
        text: JSON.stringify(await materializeSkill(options, args, api, context)) }] }) }),
    ],
  });
  return Object.assign(extension, { renderSkills });
}
