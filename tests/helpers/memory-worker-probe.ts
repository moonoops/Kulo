import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { EnvManager } from "../../packages/env/src/index.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  baseUrl: string;
  workerKey: string;
  privateBank: string;
  sharedBank: string;
  workspaceDir: string;
};
const workspaceDir = path.resolve(input.workspaceDir);
const canaryDir = fs.mkdtempSync(path.join(path.dirname(workspaceDir), "kulo-private-canary-"));
const canaryFile = path.join(canaryDir, "private.txt");
fs.writeFileSync(canaryFile, "private-filesystem-canary", { mode: 0o600 });
process.env.KULO_HINDSIGHT_ROUTER_API_KEY = "router-environment-canary-000000000000";
const manager = new EnvManager({ localRootDir: workspaceDir, getProtectedPaths: () => [canaryDir],
  workerNetwork: { localConnectPorts: [Number(new URL(input.baseUrl).port)] } });
try {
  await manager.start();
  const env = manager.createWorkerExecutionEnv("local", workspaceDir);
  const file = await env.readTextFile(canaryFile, BACKGROUND_CONTEXT);
  assert.equal(file.ok, false, "Worker read a private file outside its scope");
  let shellOutput = "";
  const shell = await env.exec(["/bin/cat", canaryFile], { onOutput: (text) => { shellOutput += text; } }, BACKGROUND_CONTEXT);
  assert.ok(!shell.ok || shell.value.exitCode !== 0, "Worker shell read a private file");
  assert.ok(!shellOutput.includes("private-filesystem-canary"));
  let environment = "";
  const listed = await env.exec(["/usr/bin/env"], { onOutput: (text) => { environment += text; } }, BACKGROUND_CONTEXT);
  assert.ok(listed.ok && listed.value.exitCode === 0);
  assert.ok(!environment.includes("router-environment-canary"), "Worker inherited a Router credential");

  const request = async (bank: string, operation: string, body?: unknown): Promise<number> => {
    let status = "";
    const result = await env.exec([
      "/usr/bin/curl", "--disable", "--silent", "--show-error", "--max-time", "15",
      "--output", "/dev/null", "--write-out", "%{http_code}",
      "--header", `Authorization: Bearer ${input.workerKey}`,
      ...(body ? ["--header", "Content-Type: application/json", "--data", JSON.stringify(body)] : []),
      "--url", `${input.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/${operation}`,
    ], { timeout: 20_000, onOutput: (text) => { status += text; } }, BACKGROUND_CONTEXT);
    assert.ok(result.ok && result.value.exitCode === 0, "Isolated Worker HTTP request failed");
    return Number(status);
  };
  const privateStatus = await request(input.privateBank, "documents");
  const sharedStatus = await request(input.sharedBank, "documents");
  const sharedWriteStatus = await request(input.sharedBank, "knowledge-base/folders", { name: "sandbox-worker-folder" });
  assert.equal(privateStatus, 403);
  assert.equal(sharedStatus, 200);
  assert.equal(sharedWriteStatus, 201);
  process.stdout.write(JSON.stringify({ privateStatus, sharedStatus, sharedWriteStatus, privateFileDenied: true, routerEnvironmentDenied: true }));
} finally {
  await manager.close();
  fs.rmSync(canaryDir, { recursive: true, force: true });
}
