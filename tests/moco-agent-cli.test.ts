import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentCli } from "../packages/env/src/agent-cli.js";

const directories: string[] = [];
function fixture(source: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moco-agent-cli-"));
  directories.push(directory);
  const script = path.join(directory, "native-tool.mjs");
  fs.writeFileSync(script, source);
  return { cwd: directory, tool: "agent-browser" as const, args: [] as string[], env: { ...process.env, MOCO_AGENT_BROWSER_PATH: script } };
}

afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("native agent CLI runner", () => {
  it("passes literal arguments and stdin without a shell", async () => {
    const invocation = fixture(`let input=''; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({success:true,args:process.argv.slice(2),input}));`);
    const text = "$(touch /tmp/never-created); `echo secret`\n--json";
    expect(await runAgentCli({ ...invocation, args: ["fill", "@e1", "--", text], input: "piped text" })).toEqual({ success: true, args: ["fill", "@e1", "--", text], input: "piped text" });
  });

  it("returns native structured failures on nonzero exits", async () => {
    const invocation = fixture(`console.log(JSON.stringify({success:false,error:'Native action refused'})); process.exitCode=1;`);
    expect(await runAgentCli(invocation)).toEqual({ success: false, error: "Native action refused" });
  });

  it("does not expose stderr or unstructured stdout when a process fails", async () => {
    const invocation = fixture(`process.stderr.write('a-private-token'); console.log('private-app-content'); process.exitCode=1;`);
    await expect(runAgentCli(invocation)).rejects.toMatchObject({ code: "CLI_INVALID_OUTPUT", message: "agent-browser returned no valid JSON response" });
  });

  it("rejects success-shaped output from a failed process", async () => {
    const invocation = fixture(`console.log(JSON.stringify({success:true,data:{}})); process.exitCode=7;`);
    await expect(runAgentCli(invocation)).rejects.toMatchObject({ code: "CLI_FAILED" });
  });

  it("kills timed out child processes", async () => {
    const invocation = fixture(`setInterval(()=>{},1000);`);
    await expect(runAgentCli({ ...invocation, timeoutMs: 40 })).rejects.toMatchObject({ code: "CLI_TIMEOUT" });
  });

  it("cancels an in-flight native process", async () => {
    const invocation = fixture(`setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const result = runAgentCli({ ...invocation, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "CLI_ABORTED" });
  });

  it("rejects excessive output", async () => {
    const invocation = fixture(`process.stdout.write('x'.repeat(1024*1024+1));`);
    await expect(runAgentCli(invocation)).rejects.toMatchObject({ code: "CLI_OUTPUT_LIMIT" });
  });

  it("requires absolute executable overrides and does not print their value", async () => {
    const invocation = fixture("");
    await expect(runAgentCli({ ...invocation, env: { MOCO_AGENT_BROWSER_PATH: "private/secret-token" } })).rejects.toMatchObject({ code: "CLI_CONFIGURATION", message: "MOCO_AGENT_BROWSER_PATH must be an absolute executable path" });
  });
});
