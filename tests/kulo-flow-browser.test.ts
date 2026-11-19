import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { EnvManager, KuloEnvAgent } from "@kulo/env";
import { FlowBrowserService, type FlowBrowserDriver, type FlowJobState } from "../packages/env/src/browser.js";
import { MainChromeFlowDriver } from "../packages/env/src/flow-main-driver.js";
import type { BrowserRequest, BrowserResult, HubToEnvControlMessage } from "@kulo/protocol";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function directory(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-flow-")));
  roots.push(root); return root;
}
function mockBrowser() {
  let checked: BrowserResult["status"] = "ready";
  let completed = false;
  let failAfterClick = false;
  let clicks = 0;
  const driver: FlowBrowserDriver = {
    check: vi.fn(async () => ({ status: checked, profileRef: "" })),
    submit: vi.fn(async (_input, beforeSubmit) => {
      if (checked !== "ready") return { status: checked, profileRef: "" };
      beforeSubmit("https://flow.google.com/project/one", ["https://storage.googleapis.com/old.mp4"]);
      clicks++;
      if (failAfterClick) throw new Error("Lost connection after click");
      return { status: "running", profileRef: "", remoteUrl: "https://flow.google.com/project/one" };
    }),
    poll: vi.fn(async (_job) => completed
      ? { status: "completed", profileRef: "", mediaUrl: "https://storage.googleapis.com/new.mp4" }
      : { status: "running", profileRef: "" }),
    download: vi.fn(async (_job: FlowJobState, destination: string) => {
      const bytes = Buffer.alloc(32); bytes.write("ftyp", 4); fs.writeFileSync(destination, bytes);
      return { name: "result.mp4", mimeType: "video/mp4", size: bytes.length };
    }),
    close: vi.fn(async () => {}),
  };
  return { driver, clicks: () => clicks, setChecked: (status: BrowserResult["status"]) => { checked = status; }, setCompleted: () => { completed = true; }, failAfterClick: () => { failAfterClick = true; } };
}
const submit = (jobId = "job-one", profileRef = "profile-one"): BrowserRequest => ({ action: "submit", profileRef, jobId, prompt: "A small quiet forest stream" });
const prepare = (jobId = "job-one", profileRef = "profile-one"): BrowserRequest => ({ action: "prepare", profileRef, jobId, prompt: "A small quiet forest stream" });
const quote = { credits: 10, outputs: 1, durationSeconds: 5, modelId: "Veo 3.1 Lite" };

describe("Flow browser workflow", () => {
  it("uses the main Chrome driver as its only production connector", async () => {
    const root = directory(); const browser = mockBrowser(); browser.setChecked("needs_login");
    const factory = vi.spyOn(MainChromeFlowDriver, "open").mockResolvedValue(browser.driver as MainChromeFlowDriver);
    const service = new FlowBrowserService({ rootDir: root, platform: "darwin", executablePath: "/mock/Chrome" });
    expect(await service.request({ action: "open", profileRef: "connection-one" })).toMatchObject({ status: "needs_login" });
    expect(await service.request({ action: "check", profileRef: "connection-one", takeover: true })).toMatchObject({ status: "needs_login" });
    browser.setChecked("ready");
    expect(await service.request({ action: "check", profileRef: "connection-one" })).toMatchObject({ status: "ready" });
    expect(factory).toHaveBeenCalledExactlyOnceWith(path.join(root, "connections/connection-one"));
    expect(browser.driver.close).not.toHaveBeenCalled(); expect(browser.driver.submit).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "profiles"))).toBe(false);
    await service.close(); expect(browser.driver.close).toHaveBeenCalledTimes(1);
  });

  it("ignores retired native markers and never reads, modifies, or closes the old Chrome profile", async () => {
    const root = directory(); const browser = mockBrowser(); const marker = path.join(root, "login-profile-one.json");
    const retired = path.join(root, "profiles/profile-one"); fs.mkdirSync(retired, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid })); fs.writeFileSync(path.join(retired, "SingletonLock"), "still-occupied");
    const original = fs.readFileSync(marker, "utf8"); const factory = vi.fn(async () => browser.driver);
    const service = new FlowBrowserService({ rootDir: root, driverFactory: factory });
    expect(await service.request({ action: "open", profileRef: "profile-one" })).toMatchObject({ status: "ready" });
    expect(await service.request({ action: "check", profileRef: "profile-one", takeover: true })).toMatchObject({ status: "ready" });
    expect(factory).toHaveBeenCalledExactlyOnceWith(path.join(root, "connections/profile-one"));
    expect(browser.driver.close).not.toHaveBeenCalled(); await service.close();
    expect(fs.readFileSync(marker, "utf8")).toBe(original);
    expect(fs.readFileSync(path.join(retired, "SingletonLock"), "utf8")).toBe("still-occupied");
  });

  it("checks a running main Chrome job without detaching or sending its prompt again", async () => {
    const browser = mockBrowser(); const factory = vi.fn(async () => browser.driver);
    const service = new FlowBrowserService({ rootDir: directory(), driverFactory: factory });
    await service.request(submit());
    expect(await service.request({ action: "open", profileRef: "profile-one" })).toMatchObject({ status: "ready" });
    expect(await service.request({ action: "check", profileRef: "profile-one", takeover: true })).toMatchObject({ status: "ready" });
    expect(await service.request(submit())).toMatchObject({ status: "running", submitted: true });
    expect(factory).toHaveBeenCalledTimes(1); expect(browser.driver.close).not.toHaveBeenCalled();
    expect(browser.driver.submit).toHaveBeenCalledTimes(1); await service.close();
  });

  it("validates the legacy takeover flag without ever closing Chrome", async () => {
    const browser = mockBrowser(); const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    await service.request({ action: "open", profileRef: "profile-one" });
    for (const request of [{ action: "check", profileRef: "profile-one", takeover: "true" }, { ...submit(), takeover: true }]) {
      await expect(service.request(request as unknown as BrowserRequest)).rejects.toThrow("takeover");
    }
    expect(browser.driver.close).not.toHaveBeenCalled(); await service.close();
  });

  it("retries an explicit main Chrome connection while ordinary checks remain passive", async () => {
    const browser = mockBrowser(); browser.setChecked("needs_login"); let connected = false;
    browser.driver.open = vi.fn(async () => { if (connected) browser.setChecked("ready"); return browser.driver.check(); });
    const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    expect(await service.request({ action: "check", profileRef: "profile-one" })).toMatchObject({ status: "needs_login" });
    expect(browser.driver.open).not.toHaveBeenCalled();
    expect(await service.request({ action: "open", profileRef: "profile-one" })).toMatchObject({ status: "needs_login" });
    await service.request({ action: "check", profileRef: "profile-one" });
    expect(browser.driver.open).toHaveBeenCalledTimes(1);
    connected = true;
    expect(await service.request({ action: "open", profileRef: "profile-one" })).toMatchObject({ status: "ready" });
    expect(browser.driver.open).toHaveBeenCalledTimes(2);
    await service.request({ action: "check", profileRef: "profile-one" });
    expect(browser.driver.open).toHaveBeenCalledTimes(2); expect(browser.driver.close).not.toHaveBeenCalled();
    await service.close();
  });

  it.each(["prepare", "submit"] as const)("persists a same-card manual approval observed during %s and polls without another paid click", async (action) => {
    const root = directory(); const browser = mockBrowser(); let now = 1000;
    browser.driver.prepare = vi.fn(async (_input, beforePrepare) => { beforePrepare("https://flow.google.com/project/one", []); return { status: "ready", profileRef: "", prepared: true, quote }; });
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver, now: () => now });
    await service.request(prepare()); now = 2000;
    const observed = vi.fn(async () => ({ status: "running" as const, profileRef: "", remoteUrl: "https://flow.google.com/project/one", submitted: true, quote }));
    if (action === "prepare") browser.driver.prepare = observed;
    else browser.driver.submit = observed;
    const result = await service.request(action === "prepare" ? prepare() : submit());
    expect(result).toMatchObject({ status: "running", submitted: true, remoteId: "job-one" });
    const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
    expect(saved.jobs["job-one"]).toMatchObject({ status: "running", preparedAt: 1000, submittedAt: 2000, remoteMayBeRunning: true, remoteUrl: "https://flow.google.com/project/one" });
    expect(await service.request({ action: "poll", profileRef: "profile-one", jobId: "job-one" })).toMatchObject({ status: "running", submitted: true });
    expect(browser.driver.poll).toHaveBeenCalledTimes(1); expect(browser.clicks()).toBe(0); await service.close();
    const restarted = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await restarted.request(submit())).toMatchObject({ status: "running", submitted: true });
    expect(observed).toHaveBeenCalledTimes(1);
    browser.setCompleted();
    expect(await restarted.request({ action: "poll", profileRef: "profile-one", jobId: "job-one" })).toMatchObject({ status: "completed", submitted: true });
    expect(browser.driver.poll).toHaveBeenCalledTimes(2); expect(browser.clicks()).toBe(0); await restarted.close();
  });

  it("releases only a newly reserved preparation explicitly confirmed unsent and resumes the same job", async () => {
    const root = directory(); const browser = mockBrowser(); let sends = 0; let repaired = false; let reservations = 0;
    browser.driver.prepare = vi.fn(async (input, beforePrepare) => {
      if (input.job.preparedAt === undefined) { beforePrepare("https://flow.google.com/project/one", []); reservations++; }
      if (!repaired) return { status: "needs_review", profileRef: "", preparationSent: false };
      sends++; return { status: "ready", profileRef: "", preparationSent: true, prepared: true, quote };
    });
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await service.request(prepare())).toMatchObject({ status: "needs_review", preparationSent: false, prepared: false, submitted: false });
    const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
    expect(saved.jobs["job-one"]?.preparedAt).toBeUndefined(); expect(saved.jobs["job-one"]?.quote).toBeUndefined();
    expect(sends).toBe(0); await service.close(); repaired = true;
    const restarted = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await restarted.request(prepare())).toMatchObject({ status: "ready", prepared: true, submitted: false, quote });
    expect(reservations).toBe(2); expect(sends).toBe(1);
    expect(await restarted.request(submit())).toMatchObject({ status: "running", submitted: true });
    expect(browser.clicks()).toBe(1); await restarted.close();
  });

  it("retains an unknown earlier send reservation even if a later inspection performs no send", async () => {
    const root = directory(); const browser = mockBrowser(); let sends = 0; let unknown = true;
    browser.driver.prepare = vi.fn(async (input, beforePrepare) => {
      if (input.job.preparedAt === undefined) { beforePrepare("https://flow.google.com/project/one", []); sends++; }
      if (unknown) throw new Error("Unknown result after send");
      return { status: "needs_review", profileRef: "", preparationSent: false };
    });
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await service.request(prepare())).toMatchObject({ status: "needs_review", submitted: false });
    await service.close(); unknown = false;
    const restarted = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await restarted.request(prepare())).toMatchObject({ status: "needs_review", submitted: false });
    expect(await restarted.request(prepare())).toMatchObject({ status: "needs_review", submitted: false });
    const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
    expect(saved.jobs["job-one"]?.preparedAt).toBeTypeOf("number"); expect(sends).toBe(1); expect(browser.clicks()).toBe(0); await restarted.close();
  });

  it("persists preparation before the external prompt and retains one quote across repeated prepares and restart", async () => {
    const root = directory(); const browser = mockBrowser(); let prompts = 0;
    browser.driver.prepare = vi.fn(async (input, beforePrepare) => {
      if (input.job.preparedAt === undefined) {
        beforePrepare("https://flow.google.com/project/one", ["https://storage.googleapis.com/old.mp4"]);
        const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
        expect(saved.jobs[input.job.id]?.preparedAt).toBeTypeOf("number");
        expect(saved.jobs[input.job.id]?.submittedAt).toBeUndefined(); prompts++;
      }
      return { status: "ready", profileRef: "", prepared: true, quote };
    });
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await service.request(prepare())).toMatchObject({ status: "ready", prepared: true, quote, submitted: false });
    expect(await service.request(prepare())).toMatchObject({ status: "ready", prepared: true, quote, submitted: false });
    expect(prompts).toBe(1); expect(browser.driver.submit).not.toHaveBeenCalled();
    await service.close();
    const restarted = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await restarted.request(prepare())).toMatchObject({ status: "ready", prepared: true, quote, submitted: false });
    expect(prompts).toBe(1);
    expect(await restarted.request(submit())).toMatchObject({ status: "running", submitted: true });
    expect(vi.mocked(browser.driver.submit).mock.calls[0]![0].job.quote).toEqual(quote);
    expect(await restarted.request(submit())).toMatchObject({ status: "running", submitted: true });
    expect(await restarted.request(prepare())).toMatchObject({ status: "running", submitted: true });
    expect(browser.clicks()).toBe(1); expect(browser.driver.prepare).toHaveBeenCalledTimes(3); await restarted.close();
  });

  it("does not resend a prepared prompt when its receipt was lost before restart", async () => {
    const root = directory(); const browser = mockBrowser(); let prompts = 0; let lostReceipt = true;
    browser.driver.prepare = vi.fn(async (input, beforePrepare) => {
      if (input.job.preparedAt === undefined) { beforePrepare("https://flow.google.com/project/one", []); prompts++; }
      if (lostReceipt) throw new Error("Receipt lost after prompt send");
      return { status: "ready", profileRef: "", prepared: true, quote };
    });
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await service.request(prepare())).toMatchObject({ status: "needs_review", submitted: false });
    expect(prompts).toBe(1); expect(browser.clicks()).toBe(0); await service.close();
    lostReceipt = false;
    const restarted = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await restarted.request(prepare())).toMatchObject({ status: "ready", prepared: true, quote, submitted: false });
    expect(prompts).toBe(1); expect(browser.clicks()).toBe(0); await restarted.close();
  });

  it.each([{ credits: -1, outputs: 1 }, { credits: NaN, outputs: 1 }, { credits: 10, outputs: 2 }, { credits: 10, outputs: 1, durationSeconds: Infinity }])("keeps an invalid native quote out of the ready receipt and ledger: %j", async (invalidQuote) => {
    const root = directory(); const browser = mockBrowser();
    browser.driver.prepare = vi.fn(async (_input, beforePrepare) => { beforePrepare("https://flow.google.com/project/one", []); return { status: "ready", profileRef: "", prepared: true, quote: invalidQuote }; });
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    const result = await service.request(prepare());
    expect(result).toMatchObject({ status: "needs_review", prepared: false, submitted: false }); expect(result.quote).toBeUndefined();
    const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
    expect(saved.jobs["job-one"]?.quote).toBeUndefined(); expect(browser.clicks()).toBe(0); await service.close();
  });

  it("requires the durable preparation callback before accepting a ready quote", async () => {
    const browser = mockBrowser(); browser.driver.prepare = vi.fn(async () => ({ status: "ready", profileRef: "", prepared: true, quote }));
    const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    expect(await service.request(prepare())).toMatchObject({ status: "needs_review", prepared: false, submitted: false });
    expect(browser.clicks()).toBe(0); await service.close();
  });

  it("honors stop before approval and never prepares or submits that stopped job again", async () => {
    const browser = mockBrowser(); browser.driver.prepare = vi.fn(async (_input, beforePrepare) => { beforePrepare("https://flow.google.com/project/one", []); return { status: "ready", profileRef: "", prepared: true, quote }; });
    const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    await service.request(prepare());
    expect(await service.request({ action: "stop", profileRef: "profile-one", jobId: "job-one" })).toMatchObject({ status: "stopped", submitted: false });
    expect(await service.request(prepare())).toMatchObject({ status: "stopped", submitted: false });
    expect(await service.request(submit())).toMatchObject({ status: "stopped", submitted: false });
    expect(browser.driver.prepare).toHaveBeenCalledTimes(1); expect(browser.driver.submit).not.toHaveBeenCalled();
    expect(browser.driver.close).not.toHaveBeenCalled(); await service.close();
  });

  it("keeps a stopped thinking request reserved until its own native card can be rejected", async () => {
    const root = directory(); const browser = mockBrowser(); let cardReady = false;
    browser.driver.prepare = vi.fn(async (_input, beforePrepare) => { beforePrepare("https://flow.google.com/project/one", []); return { status: "ready", profileRef: "", prepared: true, quote }; });
    browser.driver.stop = vi.fn(async (job) => ({ status: cardReady ? "stopped" : "needs_review", profileRef: job.profileRef, jobId: job.id, submitted: false }));
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    await service.request(prepare());
    const stopped = await service.request({ action: "stop", profileRef: "profile-one", jobId: "job-one" });
    expect(stopped).toMatchObject({ status: "stopped", submitted: false }); expect(stopped.message).toContain("仍待核对");
    expect(await service.request(prepare("second-job"))).toMatchObject({ status: "needs_review", submitted: false });
    expect(browser.driver.prepare).toHaveBeenCalledTimes(1); expect(browser.driver.poll).not.toHaveBeenCalled();
    cardReady = true;
    expect(await service.request({ action: "check", profileRef: "profile-one" })).toMatchObject({ status: "ready" });
    const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
    expect(saved.jobs["job-one"]).toMatchObject({ status: "stopped", remoteMayBeRunning: false });
    expect(vi.mocked(browser.driver.stop).mock.calls.every(([job]) => job.id === "job-one")).toBe(true);
    expect(await service.request(prepare("second-job"))).toMatchObject({ status: "ready", submitted: false });
    expect(browser.driver.prepare).toHaveBeenCalledTimes(2); expect(browser.clicks()).toBe(0); await service.close();
  });

  it("persists stop intent before rejecting a verified unapproved native card", async () => {
    const root = directory(); const browser = mockBrowser();
    browser.driver.prepare = vi.fn(async (_input, beforePrepare) => { beforePrepare("https://flow.google.com/project/one", []); return { status: "ready", profileRef: "", prepared: true, quote }; });
    browser.driver.stop = vi.fn(async (job) => {
      const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
      expect(saved.jobs[job.id]).toMatchObject({ status: "stopped", remoteMayBeRunning: true });
      return { status: "stopped", profileRef: job.profileRef, jobId: job.id, submitted: false };
    });
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    await service.request(prepare());
    expect(await service.request({ action: "stop", profileRef: "profile-one", jobId: "job-one" })).toMatchObject({ status: "stopped", submitted: false });
    expect(await service.request(prepare("second-job"))).toMatchObject({ status: "ready", submitted: false });
    expect(browser.driver.stop).toHaveBeenCalledTimes(1); expect(browser.driver.poll).not.toHaveBeenCalled();
    expect(browser.clicks()).toBe(0); await service.close();
  });

  it("keeps the user stop decision when the native card was manually approved first and reconciles only by poll", async () => {
    const root = directory(); const browser = mockBrowser();
    browser.driver.prepare = vi.fn(async (_input, beforePrepare) => { beforePrepare("https://flow.google.com/project/one", []); return { status: "ready", profileRef: "", prepared: true, quote }; });
    browser.driver.stop = vi.fn(async () => ({ status: "running", profileRef: "", submitted: true, remoteUrl: "https://flow.google.com/project/one" }));
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    await service.request(prepare());
    expect(await service.request({ action: "stop", profileRef: "profile-one", jobId: "job-one" })).toMatchObject({ status: "stopped", submitted: true });
    expect(await service.request({ action: "check", profileRef: "profile-one" })).toMatchObject({ status: "needs_review" });
    expect(browser.driver.stop).toHaveBeenCalledTimes(1); expect(browser.driver.poll).toHaveBeenCalledTimes(1);
    browser.setCompleted();
    expect(await service.request({ action: "check", profileRef: "profile-one" })).toMatchObject({ status: "ready" });
    const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
    expect(saved.jobs["job-one"]).toMatchObject({ status: "stopped", remoteMayBeRunning: false });
    expect(saved.jobs["job-one"]?.submittedAt).toBeTypeOf("number");
    expect(browser.driver.stop).toHaveBeenCalledTimes(1); expect(browser.clicks()).toBe(0); await service.close();
  });

  it("checks authorization before persisting and sending a prepared request", async () => {
    const browser = mockBrowser(); let active = true; let prompts = 0;
    browser.driver.prepare = vi.fn(async (_input, beforePrepare) => { active = false; beforePrepare("https://flow.google.com/project/one", []); prompts++; return { status: "ready", profileRef: "", prepared: true, quote }; });
    const root = directory(); const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await service.request(prepare(), () => active)).toMatchObject({ status: "needs_review", submitted: false });
    const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
    expect(saved.jobs["job-one"]?.preparedAt).toBeUndefined(); expect(prompts).toBe(0); expect(browser.clicks()).toBe(0); await service.close();
  });

  it("persists submit intent and never clicks again after restart or an ambiguous submission", async () => {
    const root = directory(); const browser = mockBrowser(); browser.failAfterClick();
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await service.request(submit())).toMatchObject({ status: "needs_review", submitted: true });
    expect(browser.driver.submit).toHaveBeenCalledTimes(1);
    await service.close();
    const restarted = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await restarted.request(submit())).toMatchObject({ status: "needs_review", jobId: "job-one", submitted: true });
    expect(browser.driver.submit).toHaveBeenCalledTimes(1);
    await expect(restarted.request({ ...submit(), prompt: "A different request" } as BrowserRequest)).rejects.toThrow("another request");
    await restarted.close();
  });

  it("serializes an in-flight generation per profile and allows independent profiles", async () => {
    const browser = mockBrowser();
    const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    expect(await service.request(submit("first"))).toMatchObject({ status: "running" });
    expect(await service.request(submit("second"))).toMatchObject({ status: "needs_review", submitted: false });
    expect(browser.driver.submit).toHaveBeenCalledTimes(1);
    expect(await service.request(submit("third", "other-profile"))).toMatchObject({ status: "running" });
    await expect(service.request({ action: "poll", profileRef: "other-profile", jobId: "first" })).rejects.toThrow("different browser");
    await service.close();
  });

  it("stages bounded reference chunks, handles chunk replay, and preserves job identity", async () => {
    const root = directory(); const browser = mockBrowser();
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    const chunk = { action: "upload" as const, profileRef: "profile-one", jobId: "job-one", assetId: "picture-one", name: "reference.png", mimeType: "image/png", data: Buffer.from("png-image-data").toString("base64"), offset: 0, final: true };
    expect(await service.request(chunk)).toMatchObject({ offset: 14 });
    expect(await service.request(chunk)).toMatchObject({ offset: 14 });
    expect(await service.request({ ...submit(), referenceIds: ["picture-one"] } as BrowserRequest)).toMatchObject({ status: "running" });
    const input = vi.mocked(browser.driver.submit).mock.calls[0]![0];
    expect(input.referencePaths[0]).toBe(path.join(root, "jobs/profile-one/job-one/picture-one.png"));
    expect(fs.readFileSync(input.referencePaths[0]!, "utf8")).toBe("png-image-data");
    await expect(service.request({ ...chunk, data: Buffer.alloc(1024 * 1024 + 1).toString("base64") })).rejects.toThrow("upload chunk");
    await expect(service.request({ action: "check", profileRef: "../cookies" })).rejects.toThrow("profile");
    await service.close();
  });

  it("recovers a file write whose upload receipt was interrupted", async () => {
    const root = directory(); const browser = mockBrowser();
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    const chunk = { action: "upload" as const, profileRef: "profile-one", jobId: "job-one", assetId: "picture-one", name: "reference.png", mimeType: "image/png", data: Buffer.from("first").toString("base64"), offset: 0, final: false };
    await service.request(chunk); await service.close();
    fs.appendFileSync(path.join(root, "jobs/profile-one/job-one/picture-one.png"), "second");
    const restarted = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    expect(await restarted.request({ ...chunk, data: Buffer.from("second").toString("base64"), offset: 5, final: true })).toMatchObject({ offset: 11 });
    expect(await restarted.request({ ...submit(), referenceIds: ["picture-one"] } as BrowserRequest)).toMatchObject({ status: "running" });
    await restarted.close();
  });

  it("replays the same references after an unsubmitted review and clicks only after repair", async () => {
    const browser = mockBrowser(); browser.setChecked("needs_review");
    const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    const chunk = { action: "upload" as const, profileRef: "profile-one", jobId: "job-one", assetId: "reference-one", name: "reference.png", mimeType: "image/png", data: Buffer.from("unchanged-reference").toString("base64"), offset: 0, final: true };
    const request = { ...submit(), referenceIds: ["reference-one"] } as BrowserRequest;
    await service.request(chunk);
    expect(await service.request(request)).toMatchObject({ status: "needs_review", submitted: false });
    expect(browser.clicks()).toBe(0);
    await expect(service.request({ ...chunk, data: Buffer.from("modified-reference!").toString("base64") })).rejects.toThrow("offset");
    await expect(service.request({ ...chunk, data: Buffer.from("unchanged").toString("base64") })).rejects.toThrow("content changed");
    await expect(service.request({ ...chunk, assetId: "new-reference" })).rejects.toThrow("identity changed");
    browser.setChecked("ready");
    expect(await service.request(chunk)).toMatchObject({ status: "ready", submitted: false });
    expect(await service.request(request)).toMatchObject({ status: "running", submitted: true });
    expect(browser.clicks()).toBe(1);
    await expect(service.request(chunk)).rejects.toThrow("cannot change after submission");
    expect(browser.clicks()).toBe(1);
    await service.close();
  });

  it("collects an existing job and bounded output without resubmitting or exposing local paths", async () => {
    const root = directory(); const browser = mockBrowser();
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    await service.request(submit()); browser.setCompleted();
    expect(await service.request({ action: "poll", profileRef: "profile-one", jobId: "job-one" })).toMatchObject({ status: "completed" });
    const result = await service.request({ action: "download", profileRef: "profile-one", jobId: "job-one" });
    expect(result.file).toMatchObject({ name: "result.mp4", mimeType: "video/mp4", size: 32 });
    expect(JSON.stringify(result)).not.toContain(root);
    const bytes = await service.request({ action: "read", profileRef: "profile-one", jobId: "job-one", offset: 0, length: 12 });
    expect(Buffer.from(bytes.data!, "base64").toString("ascii", 4, 8)).toBe("ftyp");
    await expect(service.request({ action: "read", profileRef: "profile-one", jobId: "job-one", offset: 0, length: 1024 * 1024 + 1 })).rejects.toThrow("range");
    expect(browser.driver.submit).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("keeps an unconfirmed download pending with its submitted receipt intact", async () => {
    const browser = mockBrowser(); browser.driver.download = vi.fn(async () => null);
    const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    await service.request(submit()); browser.setCompleted();
    expect(await service.request({ action: "download", profileRef: "profile-one", jobId: "job-one" })).toMatchObject({ status: "needs_review", submitted: true, remoteId: "job-one" });
    expect(browser.driver.submit).toHaveBeenCalledTimes(1); await service.close();
  });

  it("does not claim stopping local tracking cancelled or refunded the remote generation", async () => {
    const browser = mockBrowser(); const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    await service.request(submit());
    const stopped = await service.request({ action: "stop", profileRef: "profile-one", jobId: "job-one" });
    expect(stopped.status).toBe("stopped"); expect(stopped.message).toContain("可能仍在继续");
    expect(await service.request(submit("other-job"))).toMatchObject({ status: "needs_review" });
    await service.close();
  });

  it("checks a stopped job before releasing its profile and keeps the stop decision", async () => {
    const root = directory(); const browser = mockBrowser();
    const service = new FlowBrowserService({ rootDir: root, driverFactory: async () => browser.driver });
    await service.request(submit());
    await service.request({ action: "stop", profileRef: "profile-one", jobId: "job-one" });
    expect(await service.request({ action: "check", profileRef: "profile-one" })).toMatchObject({ status: "needs_review" });
    expect(browser.driver.submit).toHaveBeenCalledTimes(1);
    browser.setCompleted();
    expect(await service.request({ action: "check", profileRef: "profile-one" })).toMatchObject({ status: "ready" });
    expect(await service.request({ action: "poll", profileRef: "profile-one", jobId: "job-one" })).toMatchObject({ status: "stopped", submitted: true });
    const saved = JSON.parse(fs.readFileSync(path.join(root, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
    expect(saved.jobs["job-one"]).toMatchObject({ status: "stopped", remoteMayBeRunning: false });
    expect(await service.request(submit("new-job"))).toMatchObject({ status: "running", submitted: true });
    expect(browser.driver.submit).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it("can reconcile a stopped job during a new submit without resuming its old generation", async () => {
    const browser = mockBrowser();
    const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    await service.request(submit());
    await service.request({ action: "stop", profileRef: "profile-one", jobId: "job-one" });
    browser.setCompleted();
    expect(await service.request(submit("new-job"))).toMatchObject({ status: "running" });
    expect(vi.mocked(browser.driver.submit).mock.calls.map(([input]) => input.job.id)).toEqual(["job-one", "new-job"]);
    await service.close();
  });

  it("checks an authorization fence immediately before clicking the external generation", async () => {
    const browser = mockBrowser(); let authorized = true;
    browser.driver.submit = vi.fn(async (_input, before) => { authorized = false; before("https://flow.google.com/project/test", []); return { status: "running", profileRef: "" }; });
    const service = new FlowBrowserService({ rootDir: directory(), driverFactory: async () => browser.driver });
    expect(await service.request(submit(), () => authorized)).toMatchObject({ status: "needs_review", submitted: false });
    const state = JSON.parse(fs.readFileSync(path.join(service.rootDir, "jobs.json"), "utf8")) as { jobs: Record<string, FlowJobState> };
    expect(state.jobs["job-one"]?.submittedAt).toBeUndefined();
    await service.close();
  });
});

async function server(manager: EnvManager) {
  const httpServer = http.createServer(); const sockets = new WebSocketServer({ server: httpServer });
  sockets.on("connection", (socket) => manager.handleEnvWebSocket(socket));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return {
    url: "ws://127.0.0.1:" + (httpServer.address() as { port: number }).port,
    close: async () => { for (const socket of sockets.clients) socket.terminate(); await new Promise<void>((resolve) => sockets.close(() => httpServer.close(() => resolve()))); },
  };
}
async function connect(url: string, envId: string, token: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const registered = new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const result = JSON.parse(data.toString()) as { type: string };
      if (result.type === "hub.registered") { socket.off("message", onMessage); resolve(); }
    };
    socket.on("message", onMessage); socket.once("close", () => reject(new Error("Registration rejected")));
  });
  socket.send(JSON.stringify({ type: "env.register", envId, token, name: envId, rootDir: "/tmp/env", platform: "darwin", arch: "arm64", capabilities: ["flow-browser"] }));
  await registered; return socket;
}
function nextBrowserRequest(socket: WebSocket): Promise<Extract<HubToEnvControlMessage, { type: "hub.browser_request" }>> {
  return new Promise((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const value = JSON.parse(raw.toString()) as HubToEnvControlMessage;
      if (value.type === "hub.browser_request") { socket.off("message", onMessage); resolve(value); }
    };
    socket.on("message", onMessage);
  });
}

describe("Flow browser Env control", () => {
  it("routes browser control locally and protects private Flow state from project grants", async () => {
    const root = directory(); const browser = mockBrowser();
    const service = new FlowBrowserService({ rootDir: path.join(root, "private-browser"), driverFactory: async () => browser.driver });
    const manager = new EnvManager({ localRootDir: path.join(root, "env"), browserService: service });
    await manager.start();
    try {
      expect(manager.getEnvDescriptor("local")?.capabilities).toContain("flow-browser");
      expect(await manager.requestBrowser("local", { action: "check", profileRef: "profile-one" })).toMatchObject({ status: "ready" });
      await expect(manager.authorizeProjectDirectory("local", { projectId: "cookie-project", path: service.rootDir, operationId: "cookie-project" })).rejects.toThrow("protected");
    } finally { await manager.close(); }
  });

  it("executes main Chrome requests through a registered Env agent without exposing private Flow state", async () => {
    const root = directory(); const browser = mockBrowser(); browser.setChecked("needs_login");
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "device-browser-token" } }); await manager.start();
    const host = await server(manager);
    const service = new FlowBrowserService({ rootDir: path.join(root, "private-browser"), driverFactory: async () => browser.driver });
    const agent = new KuloEnvAgent({ hubUrl: host.url, envId: "device", authToken: "device-browser-token", rootDir: path.join(root, "env"), browserService: service, reconnect: false });
    try {
      await agent.start();
      expect(await manager.requestBrowser("device", { action: "open", profileRef: "profile-one" })).toMatchObject({ status: "needs_login", profileRef: "profile-one" });
      expect(await manager.requestBrowser("device", { action: "check", profileRef: "profile-one" })).toMatchObject({ status: "needs_login" });
      await expect(manager.requestBrowser("device", { action: "check", profileRef: "profile-one", takeover: "true" } as unknown as BrowserRequest)).rejects.toThrow("takeover");
      expect(browser.driver.close).not.toHaveBeenCalled();
      browser.setChecked("ready");
      expect(await manager.requestBrowser("device", { action: "check", profileRef: "profile-one", takeover: true })).toMatchObject({ status: "ready" });
      expect(browser.driver.submit).not.toHaveBeenCalled();
      expect(await manager.requestBrowser("device", submit())).toMatchObject({ status: "running", submitted: true });
    } finally { await agent.stop(); await manager.close(); await host.close(); }
  });

  it("rejects an unauthenticated device before it can advertise browser capability", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "real-browser-token" } }); await manager.start();
    const host = await server(manager);
    try {
      await expect(connect(host.url, "device", "wrong-token")).rejects.toThrow("Registration rejected");
      await expect(manager.requestBrowser("device", { action: "check", profileRef: "one" })).rejects.toThrow("offline");
    } finally { await manager.close(); await host.close(); }
  });

  it("accepts a browser receipt only from the request's authenticated device and matching profile", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { first: "first-token", second: "second-token" } }); await manager.start();
    const host = await server(manager);
    try {
      const first = await connect(host.url, "first", "first-token"); const second = await connect(host.url, "second", "second-token");
      const message = nextBrowserRequest(first); const response = manager.requestBrowser("first", { action: "check", profileRef: "one" });
      const request = await message; let settled = false; void response.then(() => { settled = true; }, () => { settled = true; });
      second.send(JSON.stringify({ type: "env.browser_result", requestId: request.requestId, result: { status: "ready", profileRef: "one" } }));
      await new Promise((resolve) => setTimeout(resolve, 15)); expect(settled).toBe(false);
      first.send(JSON.stringify({ type: "env.browser_result", requestId: request.requestId, result: { status: "ready", profileRef: "wrong-profile" } }));
      await expect(response).rejects.toThrow("Invalid Flow browser response");
      first.close(); second.close();
    } finally { await manager.close(); await host.close(); }
  });

  it("rejects in-flight requests on disconnect instead of retrying a possibly submitted action", async () => {
    const manager = new EnvManager({ enableLocal: false, envTokens: { device: "browser-token" } }); await manager.start();
    const host = await server(manager);
    try {
      const device = await connect(host.url, "device", "browser-token");
      const message = nextBrowserRequest(device); const response = manager.requestBrowser("device", submit());
      const rejection = expect(response).rejects.toThrow("disconnected");
      await message; device.close(); await rejection;
    } finally { await manager.close(); await host.close(); }
  });
});
