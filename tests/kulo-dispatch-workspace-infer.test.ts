import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnlyWorkspaceExists } from "../packages/env/src/agent-stream-spawn.js";
import {
  extractAbsolutePaths,
  inferDispatchWorkspace,
  isDedicatedRemoteRoot,
} from "../packages/hub/src/dispatch-workspace-infer.js";

describe("dispatch workspace inference for unbound read-only tickets", () => {
  it("binds the deepest common directory of referenced files inside the Env root", () => {
    expect(inferDispatchWorkspace({
      envRootDir: "/app",
      isReadOnly: true,
      texts: ["Audit `/app/data/packet/manifest.csv` and /app/data/packet/notes.md.", "Stay inside /app/data/packet/"],
    })).toEqual({ kind: "inferred", dir: "/app/data/packet" });
    expect(inferDispatchWorkspace({
      envRootDir: "/app",
      isReadOnly: true,
      texts: ["Compare the mail export"],
      coordinatorReadPaths: ["/app/mail/a.eml", "/app/data/rates.json"],
    })).toEqual({ kind: "inferred", dir: "/app" });
  });

  it("never widens past the Env root and ignores paths outside it", () => {
    expect(inferDispatchWorkspace({
      envRootDir: "/app",
      isReadOnly: true,
      texts: ["Read /etc/passwd and ../../root/.ssh/id_rsa", "also /app/../etc/shadow"],
      isRemoteDedicatedRoot: false,
    })).toEqual({ kind: "default" });
    expect(inferDispatchWorkspace({
      envRootDir: "/app",
      isReadOnly: true,
      texts: ["Check /etc/hosts and /app/logs/run.log"],
    })).toEqual({ kind: "inferred", dir: "/app/logs" });
  });

  it("falls back to a read-only Env root only for dedicated remote roots", () => {
    expect(inferDispatchWorkspace({ envRootDir: "/app", isReadOnly: true, texts: ["Find the recovery packet"], isRemoteDedicatedRoot: true }))
      .toEqual({ kind: "env_root_readonly", dir: "/app" });
    expect(inferDispatchWorkspace({ envRootDir: "/Users/me/Kulo/workspace", isReadOnly: true, texts: ["Research the topic online"] }))
      .toEqual({ kind: "default" });
  });

  it("keeps writable tickets on their isolated default desk", () => {
    expect(inferDispatchWorkspace({
      envRootDir: "/app",
      isReadOnly: false,
      texts: ["Write /app/output/report.md from /app/data/input.csv"],
      coordinatorReadPaths: ["/app/data/input.csv"],
      isRemoteDedicatedRoot: true,
    })).toEqual({ kind: "default" });
  });

  it("handles Windows roots and URLs without treating them as paths", () => {
    expect(inferDispatchWorkspace({
      envRootDir: "C:\\kulo\\work",
      isReadOnly: true,
      texts: ["Review C:\\kulo\\work\\data\\sheet.xlsx and C:\\kulo\\work\\data\\notes.txt"],
    })).toEqual({ kind: "inferred", dir: "C:\\kulo\\work\\data" });
    expect(extractAbsolutePaths("See https://example.com/docs/page and 1/2 cup; use /srv/app/config.yaml.")).toEqual(["/srv/app/config.yaml"]);
  });

  it("recognizes only dedicated remote roots", () => {
    expect(isDedicatedRemoteRoot({ isLocal: false, rootDir: "/app" })).toBe(true);
    expect(isDedicatedRemoteRoot({ isLocal: false, rootDir: "/home/dev/kulo-workspace" })).toBe(true);
    expect(isDedicatedRemoteRoot({ isLocal: true, rootDir: "/app" })).toBe(false);
    for (const rootDir of ["/", "/home/dev", "/Users/dev", "/root", "/etc", "/tmp/x", undefined]) {
      expect(isDedicatedRemoteRoot({ isLocal: false, rootDir })).toBe(false);
    }
    expect(isDedicatedRemoteRoot({ isLocal: false, rootDir: "C:\\Users\\dev" })).toBe(false);
    expect(isDedicatedRemoteRoot({ isLocal: false, rootDir: "D:\\kulo" })).toBe(true);
  });
});

describe("read-only workspace existence on the execution node", () => {
  it("rejects missing read-only directories but allows Kulo-managed ticket desks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-ro-ws-"));
    try {
      fs.mkdirSync(path.join(root, "data"));
      fs.writeFileSync(path.join(root, "data", "file.txt"), "x");
      expect(() => assertReadOnlyWorkspaceExists(root, path.join(root, "data"))).not.toThrow();
      expect(() => assertReadOnlyWorkspaceExists(root, path.join(root, "table", "T-0001-research"))).not.toThrow();
      expect(() => assertReadOnlyWorkspaceExists(root, path.join(root, "missing"))).toThrow(/does not exist on target Env/);
      expect(() => assertReadOnlyWorkspaceExists(root, path.join(root, "data", "file.txt"))).toThrow(/does not exist on target Env/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
