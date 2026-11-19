import fs from "node:fs";
import path from "node:path";
import type { SkillAudience, SkillRecord } from "@moco/protocol";
import type { SkillRuntimeContext } from "./skill-runtime.js";

export interface SkillPreset {
  id: string;
  directory: string;
  audiences: SkillAudience[];
  enabled: boolean;
  condition: { capability?: "agent-browser" | "agent-desktop"; platform?: "darwin" | "linux" | "win32"; projectFramework?: "react" };
  upstream: { repository: string; ref: string; version?: string; sourcePath: string; license: string };
}

export function loadSkillPresets(directory: string): SkillPreset[] {
  const file = path.join(directory, "presets.json");
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("Invalid bundled Skill preset manifest");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { schemaVersion?: number; presets?: SkillPreset[] };
  if (data.schemaVersion !== 1 || !Array.isArray(data.presets) || data.presets.length > 32) throw new Error("Invalid bundled Skill preset manifest");
  const ids = new Set<string>();
  for (const item of data.presets) {
    if (!item || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || item.id.length > 80 || item.directory !== item.id || ids.has(item.id)
      || !Array.isArray(item.audiences) || !item.audiences.length || item.audiences.some((value) => !["chat", "worker", "settings"].includes(value))
      || typeof item.enabled !== "boolean" || !item.condition || typeof item.condition !== "object"
      || Object.keys(item.condition).some((key) => !["capability", "platform", "projectFramework"].includes(key))
      || item.condition.capability !== undefined && !["agent-browser", "agent-desktop"].includes(item.condition.capability)
      || item.condition.platform !== undefined && !["darwin", "linux", "win32"].includes(item.condition.platform)
      || item.condition.projectFramework !== undefined && item.condition.projectFramework !== "react"
      || !item.upstream || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(item.upstream.repository)
      || !/^[a-f0-9]{40,64}$/.test(item.upstream.ref) || typeof item.upstream.sourcePath !== "string" || typeof item.upstream.license !== "string") {
      throw new Error("Invalid bundled Skill preset");
    }
    ids.add(item.id);
  }
  return data.presets;
}

export function isSkillApplicable(record: Pick<SkillRecord, "id" | "source">, presets: ReadonlyMap<string, SkillPreset>, runtime?: SkillRuntimeContext): boolean {
  const preset = record.source === "builtin" ? presets.get(record.id) : undefined;
  if (!preset) return true;
  if (!runtime) return false;
  const condition = preset.condition;
  return (!condition.capability || runtime.capabilities.includes(condition.capability))
    && (!condition.platform || runtime.platform === condition.platform)
    && (!condition.projectFramework || runtime.reactWorkspace);
}
