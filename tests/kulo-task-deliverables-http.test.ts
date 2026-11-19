import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { TicketRecord } from "@kulo/protocol";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import { KuloStateDoc } from "../packages/hub/src/state.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_AUTH_TOKEN", "KULO_ENV_TOKENS", "KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-task-files-http-"));
  cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const models = createModels(); models.setProvider(fauxProvider({ provider: "task-files-http", models: [{ id: "test" }] }).provider);
  const hub = await openTestHub({ models, config: { stateDir, identityDir: path.join(stateDir, "identity"), localEnvRoot: path.join(stateDir, "workspace"),
    authToken: HUB_TEST_ADMIN_TOKEN, enableLocalEnv: false, watchdogMinutes: 0, memory: { enabled: false },
    model: { defaultProvider: "task-files-http", defaultModel: "test", thinkingLevel: "off", apiKey: "" } } });
  cleanup.push(() => hub.close());
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanup.push(() => server.close());
  const request = (endpoint: string, authorized = true) => fetch(`${server.url}${endpoint}`, { headers: authorized ? { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` } : {} });
  return { hub, request };
}

describe("task deliverable HTTP boundary", () => {
  it("requires management authorization and downloads bytes with inert content headers", async () => {
    const f = await fixture();
    const id = "a".repeat(32);
    const bytes = Buffer.from("<!DOCTYPE html><script>window.parent.secret = true</script>");
    const file = { id, name: "页面.html", mimeType: "text/html", size: bytes.length, url: `/api/tickets/T-1/deliverables/${id}`, previewable: true };
    const list = vi.spyOn(f.hub, "listTicketDeliverables").mockResolvedValue({ files: [file] });
    const read = vi.spyOn(f.hub, "readTicketDeliverable").mockResolvedValue({ file, bytes });
    expect((await f.request("/api/tickets/T-1/deliverables", false)).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect((await (await f.request("/api/tickets/T-1/deliverables")).json()).files).toEqual([file]);
    const response = await f.request(file.url);
    expect(response.status).toBe(200);
    expect(read.mock.calls[0]!.slice(0, 2)).toEqual(["T-1", id]);
    expect(read.mock.calls[0]![2]!.abortSignal).toBeInstanceOf(AbortSignal);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("content-disposition")).toContain("attachment; filename*=UTF-8''");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(bytes.toString());
  });

  it("returns empty results for a text report without opening a device and denies changed project grants", async () => {
    const f = await fixture();
    const ticket: TicketRecord = { id: "T-1", commandId: "one", title: "结果", goal: "结果", scope: "结果", role: "coder", status: "ready",
      envId: "remote", workspaceDir: "/remote/workspace", workerConversationId: 900, runEpoch: 1, createdAt: 1, updatedAt: 1,
      latestReport: { state: "ready", summary: "已完成文本分析。", at: 1 } };
    await f.hub.harness.commit(async (tx) => { (await tx.doc(KuloStateDoc)).tickets[ticket.id] = ticket; }, BACKGROUND_CONTEXT);
    const createEnv = vi.spyOn(f.hub.envManager, "createWorkerExecutionEnv");
    expect(await f.hub.listTicketDeliverables(ticket.id)).toEqual({ files: [] });
    expect(createEnv).not.toHaveBeenCalled();
    await f.hub.harness.commit(async (tx) => {
      const current = (await tx.doc(KuloStateDoc)).tickets[ticket.id]!;
      current.projectId = "project"; current.grantRevision = 1; current.directoryId = "dir";
      current.latestReport = { state: "ready", summary: "已保存 index.html", at: 2 };
    }, BACKGROUND_CONTEXT);
    vi.spyOn(f.hub.envManager, "getEnvDescriptor").mockReturnValue({ online: true } as never);
    vi.spyOn(f.hub.projects, "get").mockResolvedValue({ id: "project", grantRevision: 2, workspaceDir: ticket.workspaceDir, deviceId: ticket.envId, directoryId: "dir" } as never);
    const authorize = vi.spyOn(f.hub.projects, "ensureAuthorized");
    const response = await f.request(`/api/tickets/${ticket.id}/deliverables`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "task_deliverable_scope_changed" });
    expect(createEnv).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    const attachment = f.hub.uploads.saveUpload({ name: "已发布页面.html", mimeType: "text/html", bytes: Buffer.from("<!doctype html><title>已发布</title>") });
    await f.hub.harness.commit(async (tx) => {
      (await tx.doc(KuloStateDoc)).tickets[ticket.id]!.latestReport!.attachments = [attachment];
    }, BACKGROUND_CONTEXT);
    const published = await f.hub.listTicketDeliverables(ticket.id);
    expect(published.files).toMatchObject([{ id: attachment.id, url: attachment.url, name: attachment.name, previewable: true }]);
    expect(createEnv).not.toHaveBeenCalled();
  });
});
