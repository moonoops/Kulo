import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireCustomizationOperationLock } from "../packages/recovery/src/customization-executions.js";

let directory: string;
let template: string;
beforeAll(async () => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-rescue-cleanup-")));
  template = path.join(directory, "template-bin.js");
  await build({
    entryPoints: [fileURLToPath(new URL("../packages/recovery/src/bin.ts", import.meta.url))],
    outfile: template, bundle: true, platform: "node", format: "esm", target: "node22", external: ["node:*"],
  });
});
afterAll(async () => { if (directory) await fsp.rm(directory, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(directory, "case-"));
  const runtime = path.join(root, "standalone-rescue");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.copyFileSync(template, path.join(runtime, "bin.js"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const called = path.join(root, "fixed-helper-called");
  const attack = path.join(root, "receipt-command-ran");
  return { root, runtime, dataDir, called, attack };
}

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

function trustedRuntime(f: ReturnType<typeof fixture>) {
  const binary = path.join(f.runtime, "macos-worker-cleanup");
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shellQuote(f.called) + "\n", { mode: 0o500 });
  const metadata = { formatVersion: 1, file: "macos-worker-cleanup", sha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex") };
  fs.writeFileSync(path.join(f.runtime, "moco-cleanup-runtime.json"), JSON.stringify(metadata));
  return { binary, metadata };
}

function receipt(f: ReturnType<typeof fixture>, ownerPid = 2_000_000_000) {
  const id = randomUUID();
  const control = path.join(f.dataDir, "customizations", "executions", id);
  const workRoot = path.join(f.dataDir, "staging", "customization", "session-a");
  fs.mkdirSync(control, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const marker = "moco.customization." + "a".repeat(48);
  const negative = "moco.unowned." + "b".repeat(48);
  const untrustedBinary = path.join(control, "macos-worker-cleanup");
  fs.writeFileSync(untrustedBinary, "#!/bin/sh\nprintf unsafe > " + shellQuote(f.attack) + "\n", { mode: 0o500 });
  const owner = { ownerPid, workRoot, cleanupCommand: [untrustedBinary, "--cleanup", marker, negative], state: "running" };
  fs.writeFileSync(path.join(control, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  return { id, control, owner, marker, negative, workRoot };
}

function command(f: ReturnType<typeof fixture>) {
  const result = spawnSync(process.execPath, [path.join(f.runtime, "bin.js"), "cleanup", "--data-dir", f.dataDir, "--json"], {
    cwd: f.root, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 15_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, result: JSON.parse(result.stdout || result.stderr) as Record<string, any> };
}

describe("standalone customization process cleanup", () => {
  it("rejects cleanup while an active desktop owns the data directory before loading any helper", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dataDir, "desktop-status.json"), JSON.stringify({ pid: process.pid }));
    const output = command(f);
    expect(output.code).toBe(1);
    expect(output.result.error.code).toBe("runtime_active");
    expect(fs.existsSync(f.called)).toBe(false);
  });

  it("reports unsupported when the trusted standalone binary is absent", () => {
    const f = fixture();
    const output = command(f);
    expect(output.code).toBe(1);
    expect(output.result.error.code).toBe("cleanup_runtime_unavailable");
  });

  it.runIf(process.platform === "darwin")("runs only the fixed bundled helper and never the binary named by an owner receipt", () => {
    const f = fixture();
    trustedRuntime(f);
    const scope = receipt(f);
    const output = command(f);
    expect(output.code).toBe(0);
    expect(output.result.recovered).toBe(1);
    expect(output.result.pending).toEqual([]);
    expect(fs.readFileSync(f.called, "utf8").trim().split("\n")).toEqual(["--cleanup", scope.marker, scope.negative]);
    expect(fs.existsSync(f.attack)).toBe(false);
    expect(fs.existsSync(scope.control)).toBe(false);
    expect(fs.existsSync(scope.workRoot)).toBe(true);
  });

  it.runIf(process.platform === "darwin").each(["hash", "binary-symlink", "metadata-symlink", "filename"])("rejects a %s violation before invoking cleanup", (fault) => {
    const f = fixture();
    const helper = trustedRuntime(f);
    const scope = receipt(f);
    const metadataFile = path.join(f.runtime, "moco-cleanup-runtime.json");
    if (fault === "hash") fs.writeFileSync(metadataFile, JSON.stringify({ ...helper.metadata, sha256: "0".repeat(64) }));
    else if (fault === "filename") fs.writeFileSync(metadataFile, JSON.stringify({ ...helper.metadata, file: "../../receipt-command" }));
    else if (fault === "metadata-symlink") {
      const outside = path.join(f.root, "metadata.json");
      fs.renameSync(metadataFile, outside);
      fs.symlinkSync(outside, metadataFile);
    } else {
      const outside = path.join(f.root, "binary");
      fs.renameSync(helper.binary, outside);
      fs.symlinkSync(outside, helper.binary);
    }
    const output = command(f);
    expect(output.code).toBe(1);
    expect(output.result.error.code).toBe("cleanup_runtime_invalid");
    expect(fs.existsSync(f.called)).toBe(false);
    expect(fs.existsSync(f.attack)).toBe(false);
    expect(fs.existsSync(path.join(scope.control, "owner.json"))).toBe(true);
  });

  it.runIf(process.platform === "darwin")("preserves invalid command records without executing shell instructions", () => {
    const f = fixture();
    trustedRuntime(f);
    const scope = receipt(f);
    fs.writeFileSync(path.join(scope.control, "owner.json"), JSON.stringify({
      ...scope.owner, cleanupCommand: ["/bin/sh", "-c", "printf unsafe > " + shellQuote(f.attack), scope.negative],
    }));
    const output = command(f);
    expect(output.code).toBe(1);
    expect(output.result.pending).toEqual([{ id: scope.id, reason: "invalid-record" }]);
    expect(fs.existsSync(f.called)).toBe(false);
    expect(fs.existsSync(f.attack)).toBe(false);
    expect(fs.existsSync(scope.control)).toBe(true);
  });

  it.runIf(process.platform === "darwin")("does not stop an owner that is still active", () => {
    const f = fixture();
    trustedRuntime(f);
    const scope = receipt(f, process.pid);
    const output = command(f);
    expect(output.code).toBe(1);
    expect(output.result.pending).toEqual([{ id: scope.id, reason: "owner-active" }]);
    expect(fs.existsSync(f.called)).toBe(false);
  });

  it.runIf(process.platform === "darwin")("takes the same customization operation lock before cleaning dead executions", () => {
    const f = fixture();
    trustedRuntime(f);
    receipt(f);
    const unlock = acquireCustomizationOperationLock(f.dataDir);
    try {
      const output = command(f);
      expect(output.code).toBe(1);
      expect(output.result.error.code).toBe("recovery_busy");
      expect(fs.existsSync(f.called)).toBe(false);
    } finally { unlock(); }
  });
});
