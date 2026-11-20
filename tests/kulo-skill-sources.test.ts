import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSkillSource, parseSkillSource, SkillSourceError } from "../packages/hub/src/skill-sources.js";

const officialSkills = await import(pathToFileURL(createRequire(new URL("../packages/hub/package.json", import.meta.url)).resolve("skills")).href) as typeof import("../packages/hub/node_modules/skills/dist/index.mjs");
function api() { return { resolveSource: vi.fn(officialSkills.resolveSource), installSkills: vi.fn(officialSkills.installSkills) }; }

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-official-skills-"))); directories.push(root);
  const stagingDir = path.join(root, "staging"); fs.mkdirSync(stagingDir);
  const skill = (name = "fixture-skill", parent = root) => {
    const directory = path.join(parent, name); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: An owned fixture workflow.\n---\nUse the fixture.\n`);
    return directory;
  };
  return { root, stagingDir, skill };
}

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(directory: string) {
  git(directory, "add", "."); git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
}

function remoteFixture(submodule = false) {
  const f = fixture();
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const repo = path.join(f.root, "repository"); fs.mkdirSync(repo); git(repo, "init", "-q", "--initial-branch=main");
  const selected = f.skill("fixture-skill", path.join(repo, "skills"));
  if (submodule) {
    const privateRepo = path.join(f.root, "owned-private-repository"); fs.mkdirSync(privateRepo); git(privateRepo, "init", "-q");
    fs.writeFileSync(path.join(privateRepo, "owned-private.txt"), "This belongs only to the test fixture."); commit(privateRepo);
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", privateRepo, "skills/fixture-skill/nested");
  }
  commit(repo);
  const expectedCommit = git(repo, "rev-parse", "HEAD");
  const bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
  const commandLog = path.join(f.root, "commands.jsonl");
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs'); const cp=require('node:child_process');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(commandLog)},JSON.stringify({args,home:process.env.HOME,config:process.env.GIT_CONFIG_GLOBAL,submodules:process.env.GIT_CONFIG_VALUE_1})+'\\n');\nconst source=args.findIndex(arg=>arg==='https://fixture.invalid/repository.git'||arg==='https://github.com/kulo-fixture/repository.git'); if(args.includes('clone')&&source>=0) args[source]=${JSON.stringify(repo)};\nconst r=cp.spawnSync(${JSON.stringify(realGit)},args,{env:process.env,stdio:'inherit'}); process.exit(r.status??1);\n`, { mode: 0o755 });
  return { ...f, repo, selected, realGit, expectedCommit, bin, commandLog };
}

describe("official skills source adapter", () => {
  it("normalizes existing locator forms and accepts official repository skill selectors", () => {
    expect(parseSkillSource("https://github.com/example/skills/tree/main/skills/demo")).toMatchObject({ kind: "git", locator: "https://github.com/example/skills#ref=main&path=skills%2Fdemo", input: "https://github.com/example/skills", ref: "main", subpath: "skills/demo" });
    expect(parseSkillSource("https://github.com/example/skills#ref=v1&path=skills/demo")).toMatchObject({ ref: "v1", subpath: "skills/demo" });
    expect(parseSkillSource("example/skills@demo")).toMatchObject({ kind: "git", input: "example/skills@demo", skill: "demo" });
    expect(parseSkillSource("example/skills@v1.2.3")).toMatchObject({ input: "example/skills@v1.2.3" });
    expect(parseSkillSource("example/skills@v1.2.3").ref).toBeUndefined();
    expect(parseSkillSource("project://project-a/skills/demo")).toMatchObject({ kind: "local", input: "project://project-a/skills/demo" });
    expect(parseSkillSource("project://project-a/.agents/skills/demo")).toMatchObject({ kind: "local", input: "project://project-a/.agents/skills/demo" });
    expect(parseSkillSource("project://project-a/.pi/skills/demo")).toMatchObject({ kind: "local", input: "project://project-a/.pi/skills/demo" });
  });

  it.each(["http://example.com/repo.git", "file:///tmp/repo", "ext::danger", "https://user:password@example.com/repo.git", "https://example.com/repo.git?token=secret", "https://github.com/example/repo#ref=main&path=../outside", "https://github.com/example/repo/tree/main/../outside", "https://github.com/example/repo/tree/main/%2e%2e/outside", "project://project-a/.private/demo", "project://project-a/skills/%2e%2e/outside"])("rejects unsafe source %s", (source) => {
    expect(() => parseSkillSource(source)).toThrow();
  });

  it.each(["example/skills@%zz", "example/skills#%zz", "example/skills#main@%zz", "example/skills@%E0%A4%A", "example/skills#%C0%AF"])("normalizes malformed shorthand encoding in %s", (source) => {
    expect.assertions(2);
    try { parseSkillSource(source); }
    catch (error) { expect(error).toBeInstanceOf(SkillSourceError); expect(error).toMatchObject({ status: 400, code: "invalid_skill" }); }
  });

  it("uses the real official API to install one local package privately without executing scripts", async () => {
    const f = fixture(); const source = f.skill();
    fs.mkdirSync(path.join(source, "scripts"));
    fs.writeFileSync(path.join(source, "scripts", "run.sh"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const localApi = api(); const { resolveSource: resolve, installSkills: install } = localApi;
    const validate = vi.fn();
    const result = await installSkillSource(parseSkillSource(source), { stagingDir: f.stagingDir, validateDirectory: validate, localApi });
    expect(fs.readFileSync(path.join(result.directory, "SKILL.md"), "utf8")).toContain("fixture-skill");
    expect(fs.statSync(path.join(result.directory, "scripts/run.sh")).mode & 0o111).not.toBe(0);
    expect(resolve).toHaveBeenCalledWith(source, expect.objectContaining({ fullDepth: false }));
    expect(install).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agents: ["universal"], scope: "project", mode: "copy", telemetry: false, lockfile: false, duplicates: "error", symlinks: "reject" }));
    expect(validate).toHaveBeenCalledWith(source); expect(validate).toHaveBeenCalledWith(result.directory);
    expect(fs.existsSync(path.join(f.stagingDir, "skills-lock.json"))).toBe(false);
    await result.dispose(); await result.dispose(); expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it("rejects multiple discovered skills without an explicit selector", async () => {
    const f = fixture(); const source = path.join(f.root, "collection"); fs.mkdirSync(source); f.skill("first-skill", source); f.skill("second-skill", source);
    await expect(installSkillSource(parseSkillSource(source), { stagingDir: f.stagingDir })).rejects.toMatchObject({ code: "skill_selection_required" });
    expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it.each(["browser-automation", "desktop-automation"])("installs bundled %s as its root skill with provenance metadata", async (name) => {
    const f = fixture(); const source = path.resolve("packages/hub/skills", name);
    const result = await installSkillSource(parseSkillSource(source), { stagingDir: f.stagingDir });
    expect(fs.readFileSync(path.join(result.directory, "SKILL.md"), "utf8")).toContain(`name: ${name}`);
    expect(fs.existsSync(path.join(result.directory, "PROVENANCE.json"))).toBe(true);
    await result.dispose();
  });

  it.each([".env", "credentials.json", "private.key"])("rejects %s before the official installer can filter it", async (name) => {
    const f = fixture(); const source = f.skill(); fs.writeFileSync(path.join(source, name), "owned fixture");
    const localApi = api(); const install = localApi.installSkills;
    await expect(installSkillSource(parseSkillSource(source), { stagingDir: f.stagingDir, localApi })).rejects.toMatchObject({ code: "invalid_skill" });
    expect(install).not.toHaveBeenCalled(); expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it("refuses symlink roots and children without copying their target", async () => {
    const f = fixture(); const source = f.skill();
    const link = path.join(f.root, "source-link"); fs.symlinkSync(source, link, "dir");
    await expect(installSkillSource(parseSkillSource(link), { stagingDir: f.stagingDir })).rejects.toMatchObject({ code: "invalid_skill" });
    fs.symlinkSync(path.join(source, "SKILL.md"), path.join(source, "linked.md"));
    await expect(installSkillSource(parseSkillSource(source), { stagingDir: f.stagingDir })).rejects.toMatchObject({ code: "invalid_skill" });
    expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it("treats per-target failures as failed installs and cleans the partial output", async () => {
    const f = fixture(); const source = f.skill();
    const localApi = api();
    localApi.installSkills.mockResolvedValueOnce({ source: { input: source, type: "local", url: source }, installed: [], skipped: [], failed: [{ skill: "fixture-skill", agent: "universal", code: "SKILLS_INSTALL_FAILED", message: "fixture" }] });
    await expect(installSkillSource(parseSkillSource(source), { stagingDir: f.stagingDir, localApi })).rejects.toMatchObject({ code: "skill_install_failed" });
    expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it("releases project authorization staging on success and failed validation", async () => {
    const f = fixture(); const source = f.skill(); const dispose = vi.fn(async () => {});
    const resolveLocalSource = vi.fn(async () => ({ directory: source, dispose }));
    const result = await installSkillSource(parseSkillSource("project://project-a/skills/demo"), { stagingDir: f.stagingDir, resolveLocalSource });
    expect(resolveLocalSource).toHaveBeenCalledWith("project://project-a/skills/demo");
    await result.dispose(); expect(dispose).toHaveBeenCalledTimes(1);
    await expect(installSkillSource(parseSkillSource("project://project-a/skills/demo"), { stagingDir: f.stagingDir, resolveLocalSource, validateDirectory: () => { throw new Error("grant revoked"); } })).rejects.toThrow("grant revoked");
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")("obtains a real commit through the official API in a contained process", async () => {
    const f = remoteFixture(); vi.stubEnv("PATH", f.bin + path.delimiter + process.env.PATH);
    const parentHome = process.env.HOME;
    const validate = vi.fn();
    const result = await installSkillSource(parseSkillSource("https://fixture.invalid/repository.git#ref=main&path=skills/fixture-skill"), { stagingDir: f.stagingDir, validateDirectory: validate });
    expect(result.commit).toBe(f.expectedCommit); expect(fs.readFileSync(path.join(result.directory, "SKILL.md"), "utf8")).toContain("fixture-skill");
    const commands = fs.readFileSync(f.commandLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.some((command) => command.args.includes("clone"))).toBe(true);
    expect(commands.every((command) => command.home !== parentHome)).toBe(true);
    expect(process.env.HOME).toBe(parentHome);
    await result.dispose(); expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("runs the source adapter under the tsx development loader without captured helpers", () => {
    const f = remoteFixture(); vi.stubEnv("PATH", f.bin + path.delimiter + process.env.PATH);
    const moduleUrl = pathToFileURL(path.resolve("packages/hub/src/skill-sources.ts")).href;
    const script = `import {parseSkillSource,installSkillSource} from ${JSON.stringify(moduleUrl)}; let result; try { result=await installSkillSource(parseSkillSource('https://fixture.invalid/repository.git#path=skills/fixture-skill'),{stagingDir:process.argv[1],timeoutMs:5000}); console.log(JSON.stringify({code:'ok',commit:result.commit})); } catch(error) { console.log(JSON.stringify({code:error.code??'error',message:error.message})); process.exitCode=1; } finally { await result?.dispose(); }`;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.stagingDir], { encoding: "utf8", timeout: 10_000 });
    expect(JSON.parse(output.trim())).toEqual({ code: "ok", commit: f.expectedCommit });
    expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("lets the real official parser distinguish @version from @skill", async () => {
    const f = remoteFixture(); f.skill("second-skill", path.join(f.repo, "skills")); commit(f.repo); git(f.repo, "tag", "v1.2.3");
    vi.stubEnv("PATH", f.bin + path.delimiter + process.env.PATH); vi.stubEnv("TMPDIR", f.root);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    for (const suffix of ["v1.2.3", "fixture-skill"]) {
      const source = parseSkillSource(`kulo-fixture/repository@${suffix}`);
      const handle = await officialSkills.resolveSource(source.input, { cwd: f.stagingDir, fullDepth: true });
      try {
        expect(handle.source.ref).toBe(suffix === "v1.2.3" ? "v1.2.3" : undefined);
        const installed = await officialSkills.installSkills(handle, { cwd: f.stagingDir, agents: ["universal"], mode: "copy", lockfile: false, telemetry: false });
        expect(installed.failed).toEqual([]);
        expect(installed.installed.map((entry) => entry.skill).sort()).toEqual(suffix === "v1.2.3" ? ["fixture-skill", "second-skill"] : ["fixture-skill"]);
      } finally { await handle.dispose(); }
    }
  });

  it.skipIf(process.platform === "win32")("blocks a selected file-protocol submodule and inherited Git hooks", async () => {
    const f = remoteFixture(true); vi.stubEnv("PATH", f.bin + path.delimiter + process.env.PATH);
    const marker = path.join(f.root, "hook-ran");
    const hooks = path.join(f.root, "malicious-hooks"); fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const config = path.join(f.root, "inherited-gitconfig"); fs.writeFileSync(config, `[core]\n hooksPath = ${hooks}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    await expect(installSkillSource(parseSkillSource("https://fixture.invalid/repository.git#ref=main&path=skills/fixture-skill"), { stagingDir: f.stagingDir })).rejects.toMatchObject({ code: "invalid_skill" });
    expect(fs.existsSync(marker)).toBe(false); expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("ignores inherited Git smudge filters during the official clone", async () => {
    const f = remoteFixture();
    fs.writeFileSync(path.join(f.repo, ".gitattributes"), "*.md filter=kulo-fixture\n"); commit(f.repo);
    const expectedCommit = git(f.repo, "rev-parse", "HEAD");
    const marker = path.join(f.root, "smudge-ran");
    const smudge = path.join(f.root, "owned-smudge.sh");
    fs.writeFileSync(smudge, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    const config = path.join(f.root, "inherited-gitconfig");
    fs.writeFileSync(config, `[filter "kulo-fixture"]\n smudge = ${smudge}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", config); vi.stubEnv("PATH", f.bin + path.delimiter + process.env.PATH);
    const result = await installSkillSource(parseSkillSource("https://fixture.invalid/repository.git#path=skills/fixture-skill"), { stagingDir: f.stagingDir });
    expect(result.commit).toBe(expectedCommit);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(result.directory, "SKILL.md"), "utf8")).toContain("fixture-skill");
    await result.dispose(); expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("kills a timed-out official source process and removes staging", async () => {
    const f = fixture(); const bin = path.join(f.root, "slow-bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nsetTimeout(()=>process.exit(0),30000);\n`, { mode: 0o755 });
    vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
    await expect(installSkillSource(parseSkillSource("https://fixture.invalid/repository.git"), { stagingDir: f.stagingDir, timeoutMs: 100 })).rejects.toMatchObject({ code: "skill_source_timeout" });
    expect(fs.readdirSync(f.stagingDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("cancels an active official Git source and removes staging", async () => {
    const f = fixture(); const bin = path.join(f.root, "cancel-bin"); fs.mkdirSync(bin);
    const started = path.join(f.root, "git-started");
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(started)},'started'); setInterval(()=>{},1000);\n`, { mode: 0o755 });
    vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
    const controller = new AbortController();
    const outcome = installSkillSource(parseSkillSource("https://fixture.invalid/repository.git"), { stagingDir: f.stagingDir, signal: controller.signal }).then(() => undefined, (error: unknown) => error);
    try {
      await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 3_000, interval: 25 });
      controller.abort();
      expect(await outcome).toMatchObject({ code: "skill_source_cancelled" });
      expect(fs.readdirSync(f.stagingDir)).toEqual([]);
    } finally { controller.abort(); await outcome; }
  });

  it.skipIf(process.platform === "win32")("removes its download process group and staging after the Hub parent dies", async () => {
    const f = fixture(); const bin = path.join(f.root, "orphan-bin"); fs.mkdirSync(bin);
    const marker = path.join(f.root, "owned-processes.json"), heartbeat = path.join(f.root, "heartbeat");
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({git:process.pid,worker:process.ppid})); fs.appendFileSync(${JSON.stringify(heartbeat)},'x'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),25);\n`, { mode: 0o755 });
    const moduleUrl = pathToFileURL(path.resolve("packages/hub/src/skill-sources.ts")).href;
    const script = `import {parseSkillSource,installSkillSource} from ${JSON.stringify(moduleUrl)}; try {await installSkillSource(parseSkillSource('https://fixture.invalid/repository.git'),{stagingDir:process.argv[1],timeoutMs:30000});} catch {process.exitCode=1;}`;
    const launcher = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.stagingDir], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, stdio: "ignore" });
    const closed = once(launcher, "close");
    let owned: { worker: number; git: number } | undefined; let ownGroup = false;
    const running = (pid: number) => {
      try { return !/^Z/u.test(execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
      catch (error) { if ((error as { status?: number }).status === 1) return false; throw error; }
    };
    try {
      await vi.waitFor(() => { expect(fs.existsSync(marker)).toBe(true); expect(fs.existsSync(heartbeat)).toBe(true); }, { timeout: 5_000, interval: 25 });
      owned = JSON.parse(fs.readFileSync(marker, "utf8"));
      expect(owned!.worker).not.toBe(process.pid);
      ownGroup = Number(execFileSync("/bin/ps", ["-p", String(owned!.worker), "-o", "pgid="], { encoding: "utf8" }).trim()) === owned!.worker;
      expect(ownGroup).toBe(true);
      launcher.kill("SIGKILL"); await closed;
      await vi.waitFor(() => {
        expect(running(owned!.worker)).toBe(false); expect(running(owned!.git)).toBe(false);
        expect(fs.readdirSync(f.stagingDir)).toEqual([]);
      }, { timeout: 3_000, interval: 25 });
      const stopped = fs.statSync(heartbeat).size;
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(fs.statSync(heartbeat).size).toBe(stopped);
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
      await closed;
      if (owned && ownGroup) {
        try { process.kill(-owned.worker, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  });
});
