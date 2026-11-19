import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installSkills, resolveSource, version as skillsVersion } from "skills";

const root = fileURLToPath(new URL("../skills/", import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, "presets.json"), "utf8"));
const selected = new Set(process.argv.slice(2));
const limit = 2 * 1024 * 1024;
const allowedExtensions = new Set([".md", ".txt", ".json"]);
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.presets)) throw new Error("Invalid skill preset manifest");
for (const id of selected) if (!manifest.presets.some((entry) => entry.id === id)) throw new Error(`Unknown preset: ${id}`);

for (const preset of manifest.presets) {
  if (selected.size && !selected.has(preset.id)) continue;
  const { repository, ref, sourcePath } = preset.upstream;
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(ref)
    || !/^[a-zA-Z0-9_-]+$/.test(preset.directory) || sourcePath.split("/").some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
    throw new Error(`Invalid pinned source for ${preset.id}`);
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "moco-skill-preset-"));
  let source;
  try {
    const url = `https://github.com/${repository}/tree/${ref}/${sourcePath}`;
    source = await resolveSource(url, { cwd: temporary, ref, onWarning: (warning) => { throw new Error(warning.message); } });
    if (source.source.commit !== ref || source.skills.length !== 1) throw new Error(`Source identity mismatch for ${preset.id}`);
    const installed = await installSkills(source, {
      cwd: temporary, skills: [source.skills[0].name], agents: ["universal"], mode: "copy",
      lockfile: false, telemetry: false, duplicates: "error", symlinks: "reject",
      onWarning: (warning) => { throw new Error(warning.message); },
    });
    if (installed.failed.length || installed.installed.length !== 1) throw new Error(`Skill installation failed for ${preset.id}`);
    const input = installed.installed[0].path;
    const staged = path.join(temporary, "docs");
    await fs.mkdir(staged);
    const files = {};
    let bytes = 0;
    async function copy(directory, relative = "") {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${name}`);
        if (entry.isDirectory()) {
          if (["scripts", "templates", "node_modules", ".git"].includes(entry.name)) continue;
          await copy(absolute, name);
        } else if (entry.isFile() && (allowedExtensions.has(path.extname(entry.name)) || /^(LICENSE|NOTICE)(\..*)?$/.test(entry.name))) {
          const content = await fs.readFile(absolute);
          bytes += content.length;
          if (bytes > limit || Object.keys(files).length >= 480) throw new Error(`Preset documentation exceeds its limit: ${preset.id}`);
          new TextDecoder("utf-8", { fatal: true }).decode(content);
          const destination = path.join(staged, name);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, content, { mode: 0o644 });
          files[`upstream/${name}`] = { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
        }
      }
    }
    await copy(input);
    if (!files["upstream/SKILL.md"]) throw new Error(`Missing guide for ${preset.id}`);
    const destination = path.join(root, preset.directory);
    const recordPath = path.join(destination, "PROVENANCE.json");
    let previous = {};
    try { previous = JSON.parse(await fs.readFile(recordPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.rm(path.join(destination, "upstream"), { recursive: true, force: true });
    await fs.rename(staged, path.join(destination, "upstream"));
    const license = await fs.readFile(path.join(destination, "LICENSE"));
    await fs.writeFile(recordPath, JSON.stringify({
      schemaVersion: 1, ...preset.upstream,
      sourceUrl: `https://github.com/${repository}/tree/${ref}/${sourcePath}`,
      installer: { package: "skills", version: skillsVersion, mode: "copy", telemetry: false },
      licenseFile: { path: "LICENSE", sha256: createHash("sha256").update(license).digest("hex"), bytes: license.length },
      files, ...(previous.additionalSources ? { additionalSources: previous.additionalSources } : {}),
      modifications: "Original upstream documentation is unchanged. Moco routing lives in the parent SKILL.md. Executable scripts and templates are omitted.",
    }, null, 2) + "\n");
    console.log(`${preset.id}: ${Object.keys(files).length} documentation files, ${bytes} bytes, ${ref}`);
  } finally {
    await source?.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
