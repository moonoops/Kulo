import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { KuloCapabilitiesDoc } from "../packages/hub/src/capabilities.js";
import { KuloProjectsDoc } from "../packages/hub/src/projects.js";
import { KuloSettingsDoc, KuloStateDoc, migrateLegacyLocalReferences } from "@kulo/hub";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kulo-cluster-migration-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("legacy 'local' cluster migration and physical localEnvId invariants", () => {
  it("idempotently migrates all 'local' device references across all 4 Durable documents", async () => {
    const stateDir = tempDir();
    const hub = await openTestHub({
      config: {
        stateDir,
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: true,
        memory: { enabled: false },
      },
    });
    cleanups.push(() => hub.close());

    await hub.harness.commit(async (tx) => {
      const projects = await tx.doc(KuloProjectsDoc);
      projects.projects["proj-1"] = {
        id: "proj-1",
        name: "Moco",
        deviceId: "local",
        workspaceDir: "/tmp/proj",
        directoryId: "dir-1",
        revision: 1,
        grantRevision: 1,
        notes: "",
        createdAt: 1,
        updatedAt: 1,
      };
      projects.bindings["bind-1"] = {
        projectId: "proj-1",
        deviceId: "local",
        workspaceDir: "/tmp/proj",
        topicId: "topic-1",
        createdAt: 1,
      } as never;
      projects.cleanup["local:dir-1"] = {
        deviceId: "local",
        directoryId: "dir-1",
        workspaceDir: "/tmp/proj",
        failedAt: 1,
      } as never;

      const state = await tx.doc(KuloStateDoc);
      state.topics["topic-1"] = {
        id: "topic-1",
        title: "Work",
        conversationId: 10,
        createdAt: 1,
        updatedAt: 1,
        targetDeviceId: "local",
      } as never;
      state.tickets["tkt-done"] = {
        id: "tkt-done",
        title: "Finished task",
        role: "developer",
        roleLabel: "开发",
        status: "done",
        envId: "local",
        workspaceDir: "/tmp/proj",
        originTopicId: "topic-1",
        createdAt: 1,
        updatedAt: 1,
      } as never;
      state.tickets["tkt-sched"] = {
        id: "tkt-sched",
        title: "Scheduled task",
        role: "developer",
        roleLabel: "开发",
        status: "waiting",
        envId: "local",
        workspaceDir: "/tmp/proj",
        originTopicId: "topic-1",
        createdAt: 1,
        updatedAt: 1,
      } as never;
      state.chatRequestTargets = { "req-1": "local", "req-2": "remote-peer" };

      const settings = await tx.doc(KuloSettingsDoc);
      settings.roles = [
        {
          id: "developer",
          label: "开发",
          prompt: "",
          model: { provider: "openai", model: "gpt-5" },
          external: { kind: "codex", envId: "local", verifiedAt: 1 },
        } as never,
      ];
      settings.externalClients = {
        "codex:local": {
          id: "codex:local",
          kind: "codex",
          envId: "local",
          verifiedAt: 1,
        } as never,
      };

      const caps = await tx.doc(KuloCapabilitiesDoc);
      caps.connections["conn-1"] = {
        id: "conn-1",
        browserEnvId: "local",
      } as never;
      caps.inputs = {
        "inp-1": { id: "inp-1", envId: "local", createdAt: 1 } as never,
      };
    }, BACKGROUND_CONTEXT);

    const targetNodeId = "node-macmini-01";
    const first = await migrateLegacyLocalReferences(hub.harness, targetNodeId, BACKGROUND_CONTEXT);
    expect(first.migrated).toBe(true);
    expect(first.projectsUpdated).toBe(1);
    expect(first.ticketsUpdated).toBe(2);
    expect(first.topicsUpdated).toBe(1);
    expect(first.settingsUpdated).toBe(true);
    expect(first.capabilitiesUpdated).toBe(true);

    const projectsSnap = await hub.harness.snapshot(KuloProjectsDoc, BACKGROUND_CONTEXT);
    expect(projectsSnap?.projects["proj-1"]?.deviceId).toBe(targetNodeId);
    expect(projectsSnap?.bindings["bind-1"]?.deviceId).toBe(targetNodeId);
    expect(projectsSnap?.cleanup["local:dir-1"]).toBeUndefined();
    expect(projectsSnap?.cleanup[`${targetNodeId}:dir-1`]?.deviceId).toBe(targetNodeId);

    const stateSnap = await hub.harness.snapshot(KuloStateDoc, BACKGROUND_CONTEXT);
    expect(stateSnap?.topics["topic-1"]?.targetDeviceId).toBe(targetNodeId);
    expect(stateSnap?.tickets["tkt-done"]?.envId).toBe(targetNodeId);
    expect(stateSnap?.tickets["tkt-sched"]?.envId).toBe(targetNodeId);
    expect(stateSnap?.chatRequestTargets?.["req-1"]).toBe(targetNodeId);
    expect(stateSnap?.chatRequestTargets?.["req-2"]).toBe("remote-peer");

    const settingsSnap = await hub.harness.snapshot(KuloSettingsDoc, BACKGROUND_CONTEXT);
    expect(settingsSnap?.roles[0]?.external?.envId).toBe(targetNodeId);
    expect(settingsSnap?.externalClients?.["codex:local"]).toBeUndefined();
    expect(settingsSnap?.externalClients?.[`codex:${targetNodeId}`]?.envId).toBe(targetNodeId);

    const capsSnap = await hub.harness.snapshot(KuloCapabilitiesDoc, BACKGROUND_CONTEXT);
    expect(capsSnap?.connections["conn-1"]?.browserEnvId).toBe(targetNodeId);
    expect(capsSnap?.inputs?.["inp-1"]?.envId).toBe(targetNodeId);

    // Re-running migration is strictly idempotent
    const second = await migrateLegacyLocalReferences(hub.harness, targetNodeId, BACKGROUND_CONTEXT);
    expect(second.migrated).toBe(false);
  });

  it("keeps EnvManager local env lookup and extraProtectedPaths intact with physical localEnvId", async () => {
    const rootDir = tempDir();
    const stateDir = path.join(rootDir, "hub");
    const standbyDir = path.join(rootDir, "standby");
    fs.mkdirSync(standbyDir, { recursive: true });
    fs.writeFileSync(path.join(standbyDir, "sync-key.enc"), "top-secret-key", "utf8");

    const hub = await openTestHub({
      config: {
        stateDir,
        authToken: HUB_TEST_ADMIN_TOKEN,
        enableLocalEnv: true,
        localEnvId: "node-macmini-01",
        extraProtectedPaths: [standbyDir],
        memory: { enabled: false },
      },
    });
    cleanups.push(() => hub.close());

    expect(hub.envManager.localEnvId).toBe("node-macmini-01");
    expect(hub.envManager.isLocalEnv("node-macmini-01")).toBe(true);
    expect(hub.envManager.isLocalEnv("local")).toBe(false);
    const localDesc = hub.envManager.getEnvDescriptor("node-macmini-01");
    expect(localDesc?.kind).toBe("local");
    expect(localDesc?.id).toBe("node-macmini-01");
    // RemoteExecutionEnv keeps id "node:local" while EnvManager exposes physical nodeId
    expect(hub.envManager.createExecutionEnv("node-macmini-01", localDesc!.rootDir).id).toBe("node:local");
  });
});
