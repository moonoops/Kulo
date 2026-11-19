import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createReleaseManifest, writeReleaseManifest } from "@moco/recovery";
import { createDesktopCustomizationService } from "../packages/hub/src/customization-host.js";
import { createCustomizationSourceArchive } from "../packages/hub/src/customization-source.js";
import { resolveHubConfig } from "../packages/hub/src/config.js";
import { openTestHub } from "./helpers/secure-hub.js";

const cleanup: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  const exists = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation((file) => path.basename(String(file)) === ".env" ? false : exists(file));
  for (const key of ["MOCO_MODEL", "MOCO_DEFAULT_PROVIDER", "MOCO_API_KEY", "OPENAI_API_KEY", "MOCO_HINDSIGHT_API_KEY"]) vi.stubEnv(key, "");
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function directory() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moco-managed-tools-")));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function hostFixture() {
  const root = directory(), trustedRoot = path.join(root, "trusted"), appRoot = path.join(root, "payload"), dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(trustedRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.join(trustedRoot, "web/dist"), { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(path.join(trustedRoot, "dist/runtime.js"), "export {};\n");
  fs.writeFileSync(path.join(trustedRoot, "web/dist/index.html"), "<div id=\"root\"></div>");
  const manifest = await createReleaseManifest(trustedRoot, { version: "0.1.0", kind: "custom", shellVersion: "1" });
  await writeReleaseManifest(trustedRoot, manifest);
  const config = resolveHubConfig({
    stateDir: path.join(dataDir, "hub"), identityDir: path.join(dataDir, "hub/identity"),
    customization: { dataDir, appRoot, trustedRoot, nodePath: process.execPath, shellVersion: "1" },
  });
  return { root, trustedRoot, appRoot, dataDir, config };
}

describe("managed desktop tools without a maintenance workflow", () => {
  it("persists ordinary settings without opening the source, creating candidates, or initializing recovery", async () => {
    const root = directory(), dataDir = path.join(root, "data");
    const models = createModels();
    models.setProvider(fauxProvider({ provider: "openai", models: [{ id: "fixture" }] }));
    const hub = await openTestHub({ models, config: {
      stateDir: path.join(dataDir, "hub"), identityDir: path.join(dataDir, "hub/identity"),
      localEnvRoot: path.join(dataDir, "workspace"), enableLocalEnv: false,
      watchdogMinutes: 0, memory: { enabled: false },
      model: { defaultProvider: "openai", defaultModel: "fixture", thinkingLevel: "off", apiKey: "" },
      customization: {
        dataDir, appRoot: path.join(root, "unavailable-app"),
        trustedRoot: path.join(root, "unavailable-trust"), sourceRoot: path.join(root, "unavailable-source"),
        nodePath: process.execPath,
      },
    } });
    cleanup.push(() => hub.close());
    const before = hub.getSettingsView().blocks.presentation;
    await hub.updateSettingsBlock("presentation", before.revision, { ...before.value, agentName: "个人 Moco" });
    expect(hub.getSettingsView().blocks.presentation.value.agentName).toBe("个人 Moco");
    for (const name of ["customizations", "staging", "recovery", "versions", "updates"]) {
      expect(fs.existsSync(path.join(dataDir, name))).toBe(false);
    }
  });

  it("ignores update trust supplied by a customized payload and does not create work on a status read", async () => {
    const f = await hostFixture();
    const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    fs.writeFileSync(path.join(f.appRoot, "moco-update-trust.json"), JSON.stringify({ formatVersion: 1, keys: { impostor: key } }));
    const service = await createDesktopCustomizationService(f.config, (text) => text);
    cleanup.push(() => service.close());
    expect(await service.status({ id: "conversation:1", canModify: true })).toMatchObject({
      sourceCustomizationAvailable: false, officialUpdatesAvailable: false, hasPendingUpdate: false,
    });
    expect(fs.existsSync(f.dataDir)).toBe(false);
    await expect(service.installOfficial(undefined, { id: "conversation:1", canModify: true })).rejects.toMatchObject({
      code: "official_updates_unconfigured",
    });
    expect(fs.existsSync(f.dataDir)).toBe(false);
  });

  it("rejects unsafe host feeds and source/data mismatches before starting any work", async () => {
    const f = await hostFixture();
    fs.writeFileSync(path.join(f.trustedRoot, "moco-update-trust.json"), JSON.stringify({
      formatVersion: 1, keys: {}, feedUrl: "http://127.0.0.1/private-feed",
    }));
    await writeReleaseManifest(f.trustedRoot, await createReleaseManifest(f.trustedRoot, { version: "0.1.0", kind: "custom", shellVersion: "1" }));
    await expect(createDesktopCustomizationService(f.config, (text) => text)).rejects.toThrow("HTTPS");
    fs.unlinkSync(path.join(f.trustedRoot, "moco-update-trust.json"));
    await expect(createDesktopCustomizationService({ ...f.config, stateDir: path.join(f.root, "different-hub") }, (text) => text)).rejects.toThrow("不匹配");
    expect(fs.existsSync(f.dataDir)).toBe(false);
  });

  it("discovers the compact bundled source without extracting it or preparing a build on status reads", async () => {
    const f = await hostFixture(), source = path.join(f.root, "source");
    fs.mkdirSync(path.join(source, "packages/web/src"), { recursive: true });
    fs.writeFileSync(path.join(source, "package.json"), '{"name":"moco-monorepo","version":"0.1.0"}');
    fs.writeFileSync(path.join(source, "packages/web/src/example.ts"), 'export const example = "baseline";');
    const archive = await createCustomizationSourceArchive(source, path.join(f.trustedRoot, "moco-source.json.gz"), { version: "0.1.0" });
    fs.writeFileSync(path.join(f.trustedRoot, "moco-source.json"), JSON.stringify(archive));
    await writeReleaseManifest(f.trustedRoot, await createReleaseManifest(f.trustedRoot, {
      version: "0.1.0", kind: "custom", shellVersion: "1", sourceTreeHash: archive.treeHash,
      ...(archive.commit ? { sourceCommit: archive.commit } : {}),
    }));
    const service = await createDesktopCustomizationService(f.config, (text) => text);
    cleanup.push(() => service.close());
    expect(await service.status({ id: "conversation:1", canModify: true })).toMatchObject({ sourceCustomizationAvailable: true });
    expect(fs.existsSync(f.dataDir)).toBe(false);
    fs.appendFileSync(path.join(f.trustedRoot, "moco-source.json"), " ");
    await expect(createDesktopCustomizationService(f.config, (text) => text)).rejects.toThrow("不匹配");
  });
});
