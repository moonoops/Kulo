import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionApplicationId, ConnectionUseResult } from "@kulo/protocol";
import { KuloConnections, type ConnectionVault } from "../packages/hub/src/connections.js";
import { CONNECTION_APPLICATIONS, LocalConnectionApplications, getConnectionApplication, type ConnectionApplicationBackend } from "../packages/hub/src/connection-applications.js";
import type { ConnectionExecutionBackend } from "../packages/hub/src/connection-execution.js";

const directories: string[] = [];
class MemoryVault implements ConnectionVault {
  readonly values = new Map<string, Record<string, string>>();
  available = true;
  async get(ref: string) { return this.values.get(ref) && structuredClone(this.values.get(ref)!); }
  async set(ref: string, value: Record<string, string>) { if (!this.available) throw new Error("vault unavailable"); this.values.set(ref, structuredClone(value)); }
  async delete(ref: string) { this.values.delete(ref); }
  async refs() { return [...this.values.keys()]; }
  async entries() { return [...this.values].map(([ref, fields]) => ({ ref, fields: structuredClone(fields) })); }
  async ready() { return { available: this.available, ...(!this.available ? { error: "系统密钥库不可用。" } : {}) }; }
}
function fixture(platform: NodeJS.Platform = "darwin") {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-app-connections-")); directories.push(stateDir);
  const vault = new MemoryVault();
  const applications: ConnectionApplicationBackend = {
    probe: vi.fn(async (appId) => ({ username: `account-${appId}` })),
    execute: vi.fn(async (_appId, _secrets, operation): Promise<ConnectionUseResult> => ({ kind: "app", output: JSON.stringify({ action: operation.action, accepted: true }) })),
  };
  const executor: ConnectionExecutionBackend = { scan: vi.fn(async () => ({ fingerprint: "unused", lines: [] })), trust: vi.fn(async () => undefined),
    execute: vi.fn(async (record, secrets, operation, signal) => {
      if (record.kind !== "app" || !record.appId || operation.kind !== "app") throw new Error("unexpected generic operation");
      return applications.execute(record.appId, secrets, operation, signal);
    }) };
  const manager = new KuloConnections({ stateDir, vault, executor, applications, platform });
  async function connect(appId: ConnectionApplicationId, apiKey = "synthetic-app-token") {
    const input = await manager.prepare({ clientId: "window-one", appId });
    const record = await manager.submitInput(input.id, "window-one", { name: "ignored user label", kind: "app", appId,
      ...(getConnectionApplication(appId).authentication === "token" ? { secrets: { apiKey } } : {}) });
    return { input, record };
  }
  return { stateDir, vault, applications, executor, manager, connect };
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("fixed connection application catalogue", () => {
  it("defines four fixed applications and keeps action permissions immutable", () => {
    expect(CONNECTION_APPLICATIONS.map((app) => app.id).sort()).toEqual(["figma", "github", "mail", "messages"]);
    expect(CONNECTION_APPLICATIONS.every((app) => app.instructions.length > 0 && app.actions.some((action) => action.readOnly) && app.actions.some((action) => !action.readOnly))).toBe(true);
    const action = getConnectionApplication("messages").actions.find((item) => item.id === "messages.send")!;
    expect(() => { action.readOnly = true; }).toThrow();
    expect(action.readOnly).toBe(false);
  });
  it("routes only fixed app IDs and passes explicit permission intent to the native owner", async () => {
    const native: ConnectionApplicationBackend = { probe: vi.fn(async () => ({})), execute: vi.fn(async () => ({ kind: "app", output: "ok" })) };
    const web: ConnectionApplicationBackend = { probe: vi.fn(async () => ({})), execute: vi.fn(async () => ({ kind: "app", output: "ok" })) };
    const backend = new LocalConnectionApplications({ native, web, platform: "darwin" });
    await backend.probe("messages", {}, undefined, { requestPermission: true });
    expect(native.probe).toHaveBeenCalledWith("messages", {}, undefined, { requestPermission: true });
    await backend.probe("github", { apiKey: "synthetic-token" });
    expect(web.probe).toHaveBeenCalledWith("github", { apiKey: "synthetic-token" }, undefined, { requestPermission: false });
    await expect(backend.probe("unknown" as never, {})).rejects.toMatchObject({ code: "connection_application_unknown" });
    await expect(backend.execute("messages", {}, { kind: "app", action: "create_issue" })).rejects.toMatchObject({ code: "connection_application_action_invalid" });
    expect(native.execute).not.toHaveBeenCalled();
  });
  it("keeps native applications unavailable on non-Mac hosts", async () => {
    const native: ConnectionApplicationBackend = { probe: vi.fn(async () => ({})), execute: vi.fn(async () => ({ kind: "app", output: "ok" })) };
    const web: ConnectionApplicationBackend = { probe: vi.fn(async () => ({})), execute: vi.fn(async () => ({ kind: "app", output: "ok" })) };
    const backend = new LocalConnectionApplications({ native, web, platform: "linux" });
    await expect(backend.probe("mail", {})).rejects.toMatchObject({ code: "connection_application_unavailable" });
    expect(native.probe).not.toHaveBeenCalled();
    await backend.probe("figma", { apiKey: "synthetic-token" });
    expect(web.probe).toHaveBeenCalledOnce();
  });
});

describe("application connection lifecycle", () => {
  it("shows disconnected apps without probing, then verifies a native connection without needing a vault credential", async () => {
    const f = fixture(); f.vault.available = false;
    const before = await f.manager.snapshot();
    expect(before.applications?.every((app) => app.status === "disconnected")).toBe(true);
    expect(f.applications.probe).not.toHaveBeenCalled();
    const { record } = await f.connect("messages");
    expect(record).toMatchObject({ kind: "app", category: "app", appId: "messages", name: "信息", status: "verified", hasCredential: false, secretFields: [] });
    expect(f.applications.probe).toHaveBeenCalledWith("messages", {}, expect.any(AbortSignal), { requestPermission: true });
    expect((await f.manager.snapshot()).applications?.find((app) => app.id === "messages")?.status).toBe("connected");
    expect(f.vault.values.size).toBe(0);
    f.manager.grant("T-app", 1, [record.id]);
    await f.manager.use("T-app", 1, record.id, { kind: "app", action: "messages.read", params: { chatId: "synthetic-guid" } }, { readOnly: true });
    expect(f.applications.probe).toHaveBeenLastCalledWith("messages", {}, expect.any(AbortSignal), { requestPermission: false });
    expect(f.applications.execute).toHaveBeenCalledWith("messages", {}, expect.objectContaining({ action: "messages.read" }), expect.any(AbortSignal));
  });
  it("never presents a native app as available on a non-Mac host", async () => {
    const f = fixture("linux");
    expect((await f.manager.snapshot()).applications?.find((app) => app.id === "messages")?.status).toBe("unavailable");
    await expect(f.connect("mail")).rejects.toMatchObject({ code: "connection_application_unavailable" });
    expect(f.applications.probe).not.toHaveBeenCalled();
    expect((await f.manager.snapshot()).connections).toEqual([]);
  });
  it("keeps a failed authorization pending for retry and binds permission prompts to the submitting window", async () => {
    const f = fixture(), input = await f.manager.prepare({ appId: "mail", clientId: "window-one" });
    await expect(f.manager.submitInput(input.id, "window-two", { name: "邮件", kind: "app", appId: "mail" })).rejects.toMatchObject({ status: 403 });
    expect(f.applications.probe).not.toHaveBeenCalled();
    vi.mocked(f.applications.probe).mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "connection_app_automation_required", status: 409 }));
    await expect(f.manager.submitInput(input.id, "window-one", { name: "邮件", kind: "app", appId: "mail" })).rejects.toMatchObject({ code: "connection_app_automation_required" });
    expect((await f.manager.snapshot("window-one")).inputs[0]?.status).toBe("pending");
    expect((await f.manager.snapshot()).applications?.find((app) => app.id === "mail")?.status).toBe("disconnected");
    const retried = await f.manager.submitInput(input.id, "window-one", { name: "邮件", kind: "app", appId: "mail" });
    expect(retried.status).toBe("verified");
  });
  it("stores token app credentials only in the vault and prevents duplicate application records", async () => {
    const f = fixture(), firstInput = await f.manager.prepare({ appId: "github", clientId: "window-one" }), secondInput = await f.manager.prepare({ appId: "github", clientId: "window-two" });
    const first = await f.manager.submitInput(firstInput.id, "window-one", { name: "GitHub", kind: "app", appId: "github", secrets: { apiKey: "synthetic-github-token" } });
    expect(first.secretFields).toEqual(["apiKey"]);
    expect(JSON.stringify(await f.manager.snapshot())).not.toContain("synthetic-github-token");
    expect(fs.readFileSync(path.join(f.stateDir, "connections.json"), "utf8")).not.toContain("synthetic-github-token");
    await expect(f.manager.submitInput(secondInput.id, "window-two", { name: "GitHub", kind: "app", appId: "github", secrets: { apiKey: "another-token" } })).rejects.toMatchObject({ code: "connection_application_exists" });
    expect((await f.manager.prepare({ appId: "github", clientId: "window-two" })).connectionId).toBe(first.id);
    await expect(f.manager.save({ ...first, expectedRevision: first.revision, appId: "figma" })).rejects.toMatchObject({ code: "connection_application_identity_changed" });
    await expect(f.manager.save({ ...first, expectedRevision: first.revision, kind: "custom", category: "information", appId: undefined })).rejects.toMatchObject({ code: "connection_application_identity_changed" });
    await expect(f.manager.describe({ id: first.id, expectedRevision: first.revision, category: "information" })).rejects.toMatchObject({ code: "connection_application_identity_changed" });
    expect((await f.vault.get(`connection:${first.id}`))?.apiKey).toBe("synthetic-github-token");
    const edit = await f.manager.prepare({ appId: "github", clientId: "window-two" });
    const reconnected = await f.manager.submitInput(edit.id, "window-two", { name: "GitHub", kind: "app", appId: "github", secrets: { apiKey: "synthetic-reconnected-token" } });
    expect(reconnected.revision).toBe(first.revision + 1);
    expect((await f.vault.get(`connection:${first.id}`))?.apiKey).toBe("synthetic-reconnected-token");
  });
  it("rechecks actual native authorization after restart instead of trusting a persisted verified flag", async () => {
    const f = fixture(), { record } = await f.connect("messages");
    vi.mocked(f.applications.probe).mockRejectedValue(Object.assign(new Error("access revoked"), { code: "connection_messages_full_disk_access_required", status: 409 }));
    const restarted = new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor, applications: f.applications, platform: "darwin" });
    const snapshot = await restarted.snapshot();
    expect(snapshot.applications?.find((app) => app.id === "messages")?.status).toBe("needs_attention");
    expect(snapshot.connections.find((item) => item.id === record.id)?.status).toBe("error");
    expect(f.applications.probe).toHaveBeenLastCalledWith("messages", {}, expect.any(AbortSignal), { requestPermission: false });
    restarted.grant("T-app", 1, [record.id]);
    await expect(restarted.use("T-app", 1, record.id, { kind: "app", action: "messages.list" })).rejects.toMatchObject({ code: "connection_application_not_ready" });
  });
  it("enforces each saved app's actual action permissions and never accepts generic HTTP for an app", async () => {
    const f = fixture(), { record } = await f.connect("messages");
    f.manager.grant("T-app", 1, [record.id]);
    await expect(f.manager.use("T-app", 1, record.id, { kind: "app", action: "messages.send", params: { to: "someone@example.test", text: "synthetic" } }, { readOnly: true })).rejects.toMatchObject({ code: "connection_read_only" });
    await expect(f.manager.use("T-app", 1, record.id, { kind: "app", action: "create_issue", params: {} })).rejects.toMatchObject({ code: "connection_application_action_invalid" });
    await expect(f.manager.use("T-app", 1, record.id, { kind: "http", path: "/" })).rejects.toMatchObject({ code: "connection_application_action_invalid" });
    expect(f.applications.execute).not.toHaveBeenCalled();
    await f.manager.use("T-app", 1, record.id, { kind: "app", action: "messages.send", params: { to: "someone@example.test", text: "synthetic" } });
    expect(f.applications.execute).toHaveBeenCalledOnce();
  });
  it("moves revoked app authorization to needs_attention, keeps the token, and sends no action", async () => {
    const f = fixture(), { record } = await f.connect("github", "synthetic-github-token");
    f.manager.grant("T-app", 1, [record.id]);
    vi.mocked(f.applications.probe).mockRejectedValue(Object.assign(new Error("token revoked"), { code: "connection_app_authorization_failed", status: 401 }));
    await expect(f.manager.use("T-app", 1, record.id, { kind: "app", action: "create_issue", params: { owner: "example", repo: "repo", title: "Synthetic" } })).rejects.toMatchObject({ code: "connection_app_authorization_failed" });
    expect(f.applications.execute).not.toHaveBeenCalled();
    expect((await f.manager.snapshot()).applications?.find((app) => app.id === "github")?.status).toBe("needs_attention");
    expect((await f.vault.get(`connection:${record.id}`))?.apiKey).toBe("synthetic-github-token");
    expect(f.manager.hasGrant("T-app", 1, record.id)).toBe(false);
  });
  it("aborts a pending native permission check when its owning input is cancelled", async () => {
    const f = fixture(), input = await f.manager.prepare({ appId: "mail", clientId: "window-one" });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(f.applications.probe).mockImplementation(async (_id, _secrets, signal) => new Promise((_resolve, reject) => { signal!.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "connection_app_cancelled" })), { once: true }); entered(); }));
    const submission = f.manager.submitInput(input.id, "window-one", { name: "邮件", kind: "app", appId: "mail" });
    const settled = Promise.allSettled([submission]);
    await started; await f.manager.cancelInput(input.id, "window-one");
    expect((await settled)[0]?.status).toBe("rejected");
    expect((await f.manager.snapshot("window-one")).inputs[0]?.status).toBe("cancelled");
    expect((await f.manager.snapshot()).connections).toEqual([]);
  });
  it("reports a removed app as disconnected when a queued quiet probe is cancelled", async () => {
    const f = fixture(), { record } = await f.connect("messages");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(f.applications.probe).mockImplementation(async (_id, _secrets, signal) => new Promise((_resolve, reject) => { signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); entered(); }));
    const restarted = new KuloConnections({ stateDir: f.stateDir, vault: f.vault, executor: f.executor, applications: f.applications, platform: "darwin" });
    const pendingSnapshot = restarted.snapshot();
    await started; await restarted.remove(record.id);
    const snapshot = await pendingSnapshot;
    expect(snapshot.applications?.find((app) => app.id === "messages")?.status).toBe("disconnected");
    expect(snapshot.connections).toEqual([]);
  });
  it("fences an in-progress token replacement and restores the old token if cancelled before metadata commit", async () => {
    const f = fixture(), { record } = await f.connect("github", "synthetic-old-token");
    f.manager.grant("T-app", 1, [record.id]);
    const input = await f.manager.prepare({ appId: "github", clientId: "window-two" });
    const originalSet = f.vault.set.bind(f.vault);
    let entered!: () => void, unblock!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { unblock = resolve; });
    f.vault.set = vi.fn(async (ref, fields) => { await originalSet(ref, fields); if (fields.apiKey === "synthetic-new-token") { entered(); await gate; } });
    const submission = f.manager.submitInput(input.id, "window-two", { name: "GitHub", kind: "app", appId: "github", secrets: { apiKey: "synthetic-new-token" } });
    const settled = Promise.allSettled([submission]);
    await started;
    expect(f.manager.hasGrant("T-app", 1, record.id)).toBe(false);
    expect(() => f.manager.grant("T-app", 1, [record.id], { [record.id]: record.revision })).toThrow("连接正在更新");
    const cancelled = f.manager.cancelInput(input.id, "window-two"); unblock(); await cancelled;
    expect((await settled)[0]?.status).toBe("rejected");
    expect((await f.vault.get(`connection:${record.id}`))?.apiKey).toBe("synthetic-old-token");
    expect((await f.manager.snapshot()).connections.find((item) => item.id === record.id)?.revision).toBe(record.revision);
  });
});
