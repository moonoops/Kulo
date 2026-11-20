import fs from "node:fs";
import path from "node:path";
import type { MediaKind, SkillAudience, SkillRecord } from "@kulo/protocol";
import type { SkillRuntimeContext } from "./skill-runtime.js";

export interface SkillPresetCondition {
  capability?: "agent-browser" | "agent-desktop";
  platform?: "darwin" | "linux" | "win32";
  projectFramework?: "react";
  mediaKind?: MediaKind;
  androidAvailable?: boolean;
  customizationEnabled?: boolean;
  memoryKnowledgeEnabled?: boolean;
}

export interface SkillPresetUpstream {
  repository: string;
  ref: string;
  version?: string;
  sourcePath: string;
  license: string;
}

export interface SkillPreset {
  id: string;
  directory: string;
  audiences: SkillAudience[];
  enabled: boolean;
  hidden?: boolean;
  condition: SkillPresetCondition;
  upstream?: SkillPresetUpstream;
}

const CONDITION_KEYS = new Set([
  "capability",
  "platform",
  "projectFramework",
  "mediaKind",
  "androidAvailable",
  "customizationEnabled",
  "memoryKnowledgeEnabled",
]);

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
      || typeof item.enabled !== "boolean" || (item.hidden !== undefined && typeof item.hidden !== "boolean")
      || !item.condition || typeof item.condition !== "object"
      || Object.keys(item.condition).some((key) => !CONDITION_KEYS.has(key))
      || (item.condition.capability !== undefined && !["agent-browser", "agent-desktop"].includes(item.condition.capability))
      || (item.condition.platform !== undefined && !["darwin", "linux", "win32"].includes(item.condition.platform))
      || (item.condition.projectFramework !== undefined && item.condition.projectFramework !== "react")
      || (item.condition.mediaKind !== undefined && !["image", "video"].includes(item.condition.mediaKind))
      || (item.condition.androidAvailable !== undefined && typeof item.condition.androidAvailable !== "boolean")
      || (item.condition.customizationEnabled !== undefined && typeof item.condition.customizationEnabled !== "boolean")
      || (item.condition.memoryKnowledgeEnabled !== undefined && typeof item.condition.memoryKnowledgeEnabled !== "boolean")) {
      throw new Error("Invalid bundled Skill preset");
    }
    if (item.upstream !== undefined) {
      if (!item.upstream || typeof item.upstream !== "object"
        || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(item.upstream.repository)
        || !/^[a-f0-9]{40,64}$/.test(item.upstream.ref)
        || typeof item.upstream.sourcePath !== "string"
        || typeof item.upstream.license !== "string") {
        throw new Error("Invalid bundled Skill preset upstream");
      }
    }
    ids.add(item.id);
  }
  return data.presets;
}

export function isSkillApplicable(record: Pick<SkillRecord, "id" | "source">, presets: ReadonlyMap<string, SkillPreset>, runtime?: SkillRuntimeContext): boolean {
  if (record.source === "builtin" && record.id === "interactive-html" && runtime?.executionDomain === "android") {
    return false;
  }
  const preset = record.source === "builtin" ? presets.get(record.id) : undefined;
  if (!preset) return true;
  if (!runtime) return false;
  const condition = preset.condition;
  return (!condition.capability || runtime.capabilities.includes(condition.capability))
    && (!condition.platform || runtime.platform === condition.platform)
    && (!condition.projectFramework || Boolean(runtime.reactWorkspace))
    && (!condition.mediaKind || Boolean(runtime.mediaKinds?.includes(condition.mediaKind)))
    && (!condition.androidAvailable || Boolean(runtime.androidAvailable))
    && (!condition.customizationEnabled || Boolean(runtime.customizationEnabled))
    && (!condition.memoryKnowledgeEnabled || Boolean(runtime.memoryKnowledgeEnabled));
}
