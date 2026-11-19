import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { SkillSnapshot } from "@kulo/protocol";
import { startKuloHubServer } from "../packages/hub/src/server.js";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const NODE_TOKEN = "skills-http-node-fixture-only";
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["KULO_MODEL", "KULO_DEFAULT_PROVIDER", "KULO_API_KEY", "OPENAI_API_KEY", "KULO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kulo-skills-http-")));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "openai", models: [{ id: "skills-http" }] });
  const models = createModels(); models.setProvider(provider.provider);
  const hub = await openTestHub({ models, config: {
    stateDir: path.join(directory, "state"), identityDir: path.join(directory, "identity"), authToken: HUB_TEST_ADMIN_TOKEN,
    envTokens: { "skill-node": NODE_TOKEN }, workerEnvIds: ["skill-node"], enableLocalEnv: false, watchdogMinutes: 0,
    memory: { enabled: false }, model: { defaultProvider: "openai", defaultModel: "skills-http", thinkingLevel: "off", apiKey: "" },
  } });
  cleanups.push(() => hub.close());
  const source = path.join(directory, "source"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: skills-http-sample\ndescription: A local skill for HTTP management.\nmetadata:\n  kulo-audiences: worker\n---\nUse this workflow for the fixture task.\n");
  const seeded = await hub.skills.manage({ action: "import", source, commandId: "http-import" });
  const skill = seeded.skills.find((item) => item.source === "local")!;
  const server = await startKuloHubServer(hub, { host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.close());
  async function call(route: string, method = "GET", body?: unknown, token: string | null = HUB_TEST_ADMIN_TOKEN) {
    const response = await fetch(`${server.url}${route}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as SkillSnapshot & { error?: string; code?: string } };
  }
  return { hub, source, skill, call };
}

describe("direct skill management HTTP", () => {
  it("requires a management identity for reads, edits and removal", async () => {
    const f = await fixture();
    const before = await f.hub.skills.snapshot();
    for (const token of [null, NODE_TOKEN]) {
      expect((await f.call("/api/skills", "GET", undefined, token)).status).toBe(401);
      expect((await f.call(`/api/skills/${f.skill.id}`, "PATCH", { enabled: false, expectedRevision: before.revision, commandId: `denied-edit-${token ?? "anonymous"}` }, token)).status).toBe(401);
      expect((await f.call(`/api/skills/${f.skill.id}`, "DELETE", { expectedRevision: before.revision, commandId: `denied-delete-${token ?? "anonymous"}` }, token)).status).toBe(401);
    }
    expect((await f.call("/api/skills")).body).toEqual(before);
    expect(await f.hub.skills.snapshot()).toEqual(before);
  });

  it("persists enable and audience edits, rejects stale changes, and removes the imported skill without deleting its source", async () => {
    const f = await fixture();
    const before = await f.hub.skills.snapshot();
    const change = { enabled: false, audiences: ["chat", "worker"], expectedRevision: before.revision, commandId: "http-edit-once" };
    const edited = await f.call(`/api/skills/${f.skill.id}`, "PATCH", change);
    expect(edited.status).toBe(200);
    expect(edited.body.skills.find((item) => item.id === f.skill.id)).toMatchObject({ enabled: false, audiences: ["chat", "worker"] });
    expect((await f.hub.skills.catalog("worker")).some((item) => item.id === f.skill.id)).toBe(false);
    const replay = await f.call(`/api/skills/${f.skill.id}`, "PATCH", change);
    expect(replay.status).toBe(200);
    expect(replay.body.revision).toBe(edited.body.revision);
    const conflict = await f.call(`/api/skills/${f.skill.id}`, "PATCH", { ...change, enabled: true, commandId: "http-stale" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("skill_revision_conflict");
    const enabled = await f.call(`/api/skills/${f.skill.id}`, "PATCH", { enabled: true, audiences: ["settings"], expectedRevision: edited.body.revision, commandId: "http-enable-settings" });
    expect(enabled.status).toBe(200);
    expect((await f.hub.skills.catalog("settings")).some((item) => item.id === f.skill.id)).toBe(true);
    expect((await f.hub.skills.catalog("worker")).some((item) => item.id === f.skill.id)).toBe(false);
    const removal = { expectedRevision: enabled.body.revision, commandId: "http-remove-once" };
    const removed = await f.call(`/api/skills/${f.skill.id}`, "DELETE", removal);
    expect(removed.status).toBe(200);
    expect(removed.body.skills.some((item) => item.id === f.skill.id)).toBe(false);
    expect((await f.call(`/api/skills/${f.skill.id}`, "DELETE", removal)).body.revision).toBe(removed.body.revision);
    expect(fs.readFileSync(path.join(f.source, "SKILL.md"), "utf8")).toContain("Use this workflow");
    expect((await f.call("/api/skills")).body).toEqual(removed.body);
  });

  it("preserves built-in deletion and required setup protections", async () => {
    const f = await fixture();
    const before = await f.hub.skills.snapshot();
    const disable = await f.call("/api/skills/capability-setup", "PATCH", { enabled: false, expectedRevision: before.revision, commandId: "required-disable" });
    expect(disable.status).toBe(400);
    expect(disable.body.code).toBe("required_skill");
    const rescope = await f.call("/api/skills/capability-setup", "PATCH", { enabled: true, audiences: ["worker"], expectedRevision: before.revision, commandId: "required-rescope" });
    expect(rescope.status).toBe(400);
    expect(rescope.body.code).toBe("required_skill");
    const remove = await f.call("/api/skills/image-generation", "DELETE", { expectedRevision: before.revision, commandId: "builtin-delete" });
    expect(remove.status).toBe(400);
    expect(remove.body.code).toBe("builtin_skill_managed");
    expect((await f.hub.skills.snapshot()).revision).toBe(before.revision);
    const regular = await f.call("/api/skills/image-generation", "PATCH", { enabled: false, expectedRevision: before.revision, commandId: "builtin-disable" });
    expect(regular.status).toBe(200);
    expect(regular.body.skills.find((item) => item.id === "image-generation")?.enabled).toBe(false);
  });

  it("rejects a deletion confirmed against a catalog that changed after the intent was opened", async () => {
    const f = await fixture();
    const opened = await f.hub.skills.snapshot();
    const removal = { expectedRevision: opened.revision, commandId: "opened-removal-intent" };
    const changed = await f.call(`/api/skills/${f.skill.id}`, "PATCH", {
      enabled: false, audiences: ["chat"], expectedRevision: opened.revision, commandId: "other-window-edits-skill",
    });
    expect(changed.status).toBe(200);
    expect(changed.body.revision).toBeGreaterThan(removal.expectedRevision);
    const rejected = await f.call(`/api/skills/${f.skill.id}`, "DELETE", removal);
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe("skill_revision_conflict");
    expect((await f.hub.skills.snapshot()).skills.find((item) => item.id === f.skill.id)).toMatchObject({ enabled: false, audiences: ["chat"] });
    expect((await f.call("/api/skills")).body.revision).toBe(changed.body.revision);
  });

  it("rejects unknown fields, missing revision/identity and invalid scope without opening an import or file-write path", async () => {
    const f = await fixture();
    const before = await f.hub.skills.snapshot();
    const valid = { enabled: true, expectedRevision: before.revision, commandId: "validate-request" };
    const bad = [
      { ...valid, source: "/outside/skill" }, { ...valid, action: "import" }, { ...valid, content: "replacement" },
      { ...valid, expectedRevision: undefined }, { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: "1" },
      { ...valid, commandId: undefined }, { ...valid, commandId: "" }, { ...valid, enabled: "false" },
      { ...valid, audiences: [] }, { ...valid, audiences: ["administrator"] },
    ];
    for (const body of bad) expect((await f.call(`/api/skills/${f.skill.id}`, "PATCH", body)).status).toBe(400);
    expect((await f.call(`/api/skills/${f.skill.id}`, "DELETE", valid)).status).toBe(400);
    expect((await f.call("/api/skills/%E0%A4", "PATCH", valid)).status).toBe(400);
    expect((await f.call("/api/skills/invalid%2Fpath", "PATCH", valid)).status).toBe(400);
    expect((await f.call(`/api/skills/${f.skill.id}`, "POST", valid)).status).toBe(404);
    expect(await f.hub.skills.snapshot()).toEqual(before);
  });
});
