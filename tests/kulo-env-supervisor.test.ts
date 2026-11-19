import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanSupervisedExecution, cleanupRecordedExecutions, processFingerprint, supervisedCommand } from "../packages/env/src/worker-supervisor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true }); });

async function started(control: string): Promise<{ supervisor: ChildProcess; receipt: { childPid: number; supervisorIdentity: string; childIdentity: string } }> {
  const command = supervisedCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], control);
  const supervisor = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const errors: string[] = [];
  supervisor.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  for (let attempt = 0; attempt < 200; attempt++) {
    const file = path.join(control, "execution.json");
    if (fs.existsSync(file)) {
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      if (receipt.state === "running") return { supervisor, receipt };
    }
    if (supervisor.exitCode !== null) throw new Error(`Supervisor exited: ${errors.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  supervisor.kill("SIGTERM");
  throw new Error(`Supervisor did not start: ${errors.join("")}`);
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("Worker process cleanup receipts", () => {
  it.skipIf(process.platform !== "darwin")("rechecks transient metadata failures and retains a fence for a live process whose membership stays unknown", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-cleanup-metadata-"));
    roots.push(root);
    const source = path.join(root, "metadata-race.c"), executable = path.join(root, "metadata-race");
    fs.writeFileSync(source, `#define main kulo_cleanup_main
#define proc_listpids kulo_test_listpids
#define proc_pidinfo kulo_test_pidinfo
#define sandbox_check kulo_test_sandbox_check
#define kill kulo_test_kill
#define usleep kulo_test_usleep
#include ${JSON.stringify(fileURLToPath(new URL("../packages/env/native/macos-worker-cleanup.c", import.meta.url)))}
#undef main
static int mode, inspected;
int kulo_test_listpids(uint32_t type, uint32_t uid, void *buffer, int size) {
  (void)type; (void)uid; (void)size; if (buffer) *((pid_t *)buffer) = 12345; return sizeof(pid_t);
}
int kulo_test_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  (void)pid; (void)flavor; (void)arg; (void)size;
  if (mode != 2 || ++inspected < 4) { errno = EPERM; return 0; }
  struct proc_bsdinfo *info = buffer; memset(info, 0, sizeof(*info)); info->pbi_uid = geteuid(); return sizeof(*info);
}
int kulo_test_sandbox_check(pid_t pid, const char *operation, int type, ...) { (void)pid; (void)operation; (void)type; return 0; }
int kulo_test_kill(pid_t pid, int value) { (void)pid; (void)value; if (mode == 1) { errno = ESRCH; return -1; } return 0; }
int kulo_test_usleep(useconds_t delay) { (void)delay; return 0; }
int main(int argc, char **argv) {
  if (argc != 2) return 9; mode = atoi(argv[1]);
  char *arguments[] = { argv[0], "--cleanup", "kulo.worker.metadata-regression-0123456789", "kulo.unowned.metadata-regression-0123456789" };
  return kulo_cleanup_main(4, arguments);
}`);
    execFileSync("/usr/bin/clang", ["-O2", "-Wall", "-Wextra", "-Werror", source, "-o", executable]);
    expect(spawnSync(executable, ["1"], { encoding: "utf8" }).status).toBe(0);
    const transient = spawnSync(executable, ["2"], { encoding: "utf8" });
    expect(transient.status, transient.stderr).toBe(0);
    expect(transient.stderr).toContain("errno=1");
    const unknownLive = spawnSync(executable, ["3"], { encoding: "utf8" });
    expect(unknownLive.status).toBe(3);
    expect(unknownLive.stderr).toContain("exists=0");
  });

  it("reconciles an orphaned execution after its supervisor dies without reusing another process identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-supervisor-test-"));
    roots.push(root);
    const controlRoot = path.join(root, "controls");
    fs.mkdirSync(controlRoot);
    const control = fs.mkdtempSync(path.join(controlRoot, "kulo-worker-control-"));
    const temporaryDir = fs.mkdtempSync(path.join(root, "kulo-worker-"));
    const { supervisor, receipt } = await started(control);
    try {
      expect(receipt.childIdentity).toBe(processFingerprint(receipt.childPid));
      const closed = once(supervisor, "close");
      supervisor.kill("SIGKILL");
      await closed;
      fs.writeFileSync(path.join(control, "owner.json"), JSON.stringify({ ownerPid: process.pid, ownerIdentity: "previous-owner-identity", workspaceDir: root, temporaryDir, cleanupModel: "process-group" }));
      expect(await cleanupRecordedExecutions(controlRoot)).toBe(false);
      expect(fs.existsSync(control)).toBe(false);
      expect(fs.existsSync(temporaryDir)).toBe(false);
      expect(processFingerprint(receipt.childPid)).toBeUndefined();
    } finally {
      supervisor.kill("SIGKILL");
      if (processFingerprint(receipt.childPid) === receipt.childIdentity) {
        try { process.kill(-receipt.childPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  });

  it("keeps cleanup pending when a receipt points at a live PID with a different identity", async () => {
    const control = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-supervisor-stale-"));
    roots.push(control);
    fs.writeFileSync(path.join(control, "execution.json"), JSON.stringify({ supervisorPid: process.pid, supervisorIdentity: "different-start-time", state: "running" }));
    expect(await cleanSupervisedExecution(control)).toBe(true);
    expect(processFingerprint(process.pid)).toBeDefined();
  });
});
