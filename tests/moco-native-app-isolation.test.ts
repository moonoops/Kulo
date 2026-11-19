import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationProtectedPaths, buildWorkerSandboxProfile, defaultProtectedPaths, isApplicationPrivatePath } from "../packages/env/src/isolation.js";
import { ProjectDirectoryRegistry } from "../packages/env/src/project-directories.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-app-isolation-")));
  roots.push(root);
  const home = path.join(root, "home");
  const library = path.join(home, "Library");
  const project = path.join(library, "Developer", "project");
  const state = path.join(root, "state");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(state);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const privateRoots = applicationProtectedPaths();
  for (const directory of privateRoots) fs.mkdirSync(directory, { recursive: true });
  const privateFiles = [
    path.join(home, "Library/Messages/chat.db"),
    path.join(home, "Library/Mail/Envelope Index"),
    path.join(home, "Library/SMS/synthetic.db"),
    path.join(home, "Library/Containers/com.apple.mail.MailQuickLookExtension/Data/private.db"),
    path.join(home, "Library/Containers/com.apple.MobileSMS.MessagesExtension/Data/private.db"),
    path.join(home, "Library/Group Containers/group.com.apple.mail/private.db"),
    path.join(home, "Library/Group Containers/com.apple.MailPersonaStorage/private.db"),
  ];
  for (const file of privateFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "synthetic-app-private-sentinel");
  }
  return { root, home, library, project, state, privateRoots, privateFiles };
}

describe.skipIf(process.platform !== "darwin")("native application data remains outside Worker authority", () => {
  it("keeps Messages, Mail and their app containers protected in default policy", () => {
    const f = fixture();
    expect(defaultProtectedPaths()).toEqual(expect.arrayContaining(f.privateRoots));
    for (const file of f.privateFiles) expect(isApplicationPrivatePath(file)).toBe(true);
    expect(isApplicationPrivatePath(f.project)).toBe(false);
    expect(isApplicationPrivatePath(path.join(f.library, "Containers/com.example.Project/Data"))).toBe(false);
  });

  it("rejects writable/read-only project and scratch exceptions inside app stores", () => {
    const f = fixture();
    for (const privateRoot of f.privateRoots) {
      const nested = path.join(privateRoot, "project");
      fs.mkdirSync(nested);
      const common = { executable: "/usr/bin/true", protectedPaths: [privateRoot], workspaceRoot: nested, managedScratchRoot: nested };
      expect(() => buildWorkerSandboxProfile({ ...common, writablePaths: [nested] })).toThrow("protected application data");
      expect(() => buildWorkerSandboxProfile({ ...common, writablePaths: [f.project], readOnlyPaths: [nested] })).toThrow("protected application data");
    }
  });

  it("blocks privacy reads and writes inside a broad Library project while normal files still work", () => {
    const f = fixture();
    const regular = path.join(f.project, "source.txt");
    fs.writeFileSync(regular, "ordinary-project-file");
    const profile = buildWorkerSandboxProfile({ writablePaths: [f.library], executable: "/usr/bin/true", protectedPaths: [], workspaceRoot: f.library });
    const run = (command: string, args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, command, ...args], { encoding: "utf8", timeout: 5_000 });
    expect(run("/bin/cat", [regular]).stdout).toBe("ordinary-project-file");
    for (const privateFile of f.privateFiles) {
      const read = run("/bin/cat", [privateFile]);
      expect(read.status, read.stderr).not.toBe(0);
      expect(read.stdout).not.toContain("synthetic-app-private-sentinel");
      const write = run("/usr/bin/touch", [`${privateFile}.new`]);
      expect(write.status).not.toBe(0);
      expect(fs.existsSync(`${privateFile}.new`)).toBe(false);
      const caseAlias = privateFile.replace(/\/(Messages|Mail|SMS)\//u, (_, name: string) => `/${name.toUpperCase()}/`).replace(/com\.apple\.(?:mail|MobileSMS)/u, (name) => name.toUpperCase());
      if (caseAlias !== privateFile && fs.existsSync(caseAlias)) expect(run("/bin/cat", [caseAlias]).status).not.toBe(0);
    }
    const link = path.join(f.project, "mail-alias");
    fs.symlinkSync(f.privateFiles[0]!, link);
    expect(run("/bin/cat", [link]).status).not.toBe(0);
  });

  it("does not let grants or scratch roots bypass private data policy", () => {
    const f = fixture();
    const registry = new ProjectDirectoryRegistry({ deviceId: "synthetic-device", filePath: path.join(f.state, "projects.json"), scratchRoot: path.join(f.root, "scratch") });
    const grant = registry.authorize({ projectId: "normal", operationId: "normal", path: f.project });
    expect(registry.validate("normal", grant.workspaceDir, grant.revision).workspaceDir).toBe(f.project);
    const broad = registry.authorize({ projectId: "library", operationId: "library", path: f.library });
    expect(broad.workspaceDir).toBe(f.library);
    expect(() => registry.authorize({ projectId: "home", operationId: "home", path: f.home })).toThrow("home");
    for (const privateFile of f.privateFiles) {
      expect(() => registry.authorize({ projectId: "private", operationId: "private", path: path.dirname(privateFile) })).toThrow("protected application data");
    }
    expect(registry.list(f.library).entries.map((entry) => entry.name)).not.toContain("Messages");
    expect(registry.list(f.library).entries.map((entry) => entry.name)).not.toContain("Mail");
    expect(() => new ProjectDirectoryRegistry({ deviceId: "bad", filePath: path.join(f.state, "bad.json"), scratchRoot: path.join(f.privateRoots[0]!, "scratch") })).toThrow("protected application data");
    expect(() => new ProjectDirectoryRegistry({ deviceId: "bad", filePath: path.join(f.privateRoots[0]!, "registry.json"), scratchRoot: path.join(f.root, "scratch") })).toThrow("protected application data");
  });

  it("denies Apple Events and app-service lookups without contacting apps or prompting for permissions", () => {
    const f = fixture();
    const source = path.join(f.project, "policy-query.c");
    const executable = path.join(f.project, "policy-query");
    fs.writeFileSync(source, `#include <stdio.h>\n#include <unistd.h>\nextern int sandbox_check(pid_t,const char*,int,...);\nextern const int SANDBOX_CHECK_NO_REPORT;\nint main(void){\nint a=sandbox_check(getpid(),"appleevent-send",SANDBOX_CHECK_NO_REPORT);\nint m=sandbox_check(getpid(),"mach-lookup",2|SANDBOX_CHECK_NO_REPORT,"com.apple.imagent");\nint e=sandbox_check(getpid(),"mach-lookup",2|SANDBOX_CHECK_NO_REPORT,"com.apple.coreservices.appleevents");\nint d=sandbox_check(getpid(),"mach-lookup",2|SANDBOX_CHECK_NO_REPORT,"com.apple.mDNSResponder");\nprintf("%d %d %d %d",a,m,e,d);return 0;}\n`);
    const compile = spawnSync("/usr/bin/clang", ["-O2", "-Wall", "-Werror", source, "-o", executable], { encoding: "utf8", timeout: 30_000 });
    expect(compile.status, compile.stderr).toBe(0);
    const baseline = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", executable], { encoding: "utf8", timeout: 5_000 });
    expect(baseline.status, baseline.stderr).toBe(0);
    expect(baseline.stdout).toBe("0 0 0 0");
    const profile = buildWorkerSandboxProfile({ writablePaths: [f.project], executable, protectedPaths: [], workspaceRoot: f.project });
    expect(profile).toContain("(deny appleevent-send)");
    const isolated = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, executable], { encoding: "utf8", timeout: 5_000 });
    expect(isolated.status, isolated.stderr).toBe(0);
    expect(isolated.stdout).toBe("1 1 1 0");
  });
});
