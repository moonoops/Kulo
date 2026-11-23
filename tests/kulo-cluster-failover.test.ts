import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  CLUSTER_AUTH_HEADER,
  DeviceRoleTransitions,
  collectDeviceSystemInfo,
  createClusterAuthHeader,
  readPeerConfig,
  savePeerConfig,
  startDevicePeer,
  type DevicePeerRuntime,
} from "@kulo/env";
import {
  ConnectionVaultError,
  KuloHub,
  createStandbyHostBridge,
  getClusterProtectedPaths,
  resolveClusterPaths,
  runPreStartFence,
  startKuloHubServer,
  type ConnectionVaultKeyStore,
  type KuloHubServer,
} from "@kulo/hub";
import type {
  ClusterLocalStatusView,
  DeviceInterconnectionView,
  DevicePeerConfig,
} from "@kulo/protocol";
import { openTestHub } from "./helpers/secure-hub.js";
import { HUB_TEST_ADMIN_TOKEN } from "./helpers/hub-auth.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

class MemoryKeyStore implements ConnectionVaultKeyStore {
  readonly keys = new Map<string, Buffer>();
  async checkAvailability(): Promise<void> {}
  async getOrCreateKey(namespace: string, create = true): Promise<Buffer> {
    let key = this.keys.get(namespace);
    if (!key && create) {
      key = randomBytes(32);
      this.keys.set(namespace, key);
    }
    if (!key) throw new ConnectionVaultError("connection_vault_key_missing");
    return Buffer.from(key);
  }
}

function lanIpv4(): string {
  const addr = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
  if (!addr) throw new Error("Cluster failover test requires a non-loopback IPv4 interface.");
  return addr;
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for condition");
}

interface ManagedNode {
  name: string;
  dataDir: string;
  paths: ReturnType<typeof resolveClusterPaths>;
  keyStore: MemoryKeyStore;
  hub?: KuloHub;
  server?: KuloHubServer;
  peer?: DevicePeerRuntime;
  roles: DeviceRoleTransitions;
  port: number;
  startAsHub(): Promise<void>;
  startAsPeer(config: DevicePeerConfig): Promise<DevicePeerRuntime>;
  stop(): Promise<void>;
}

function createManagedNode(name: string, options: { warmStandbyCapable: boolean }): ManagedNode {
  const dataDir = tempDir(`kulo-cluster-node-${name}-`);
  const workspaceDir = path.join(dataDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const paths = resolveClusterPaths(dataDir);
  const keyStore = new MemoryKeyStore();
  const protectedPaths = getClusterProtectedPaths(paths);

  const node: ManagedNode = {
    name,
    dataDir,
    paths,
    keyStore,
    port: 0,
    roles: null as unknown as DeviceRoleTransitions,
    async stop() {
      const p = node.peer;
      const s = node.server;
      const h = node.hub;
      node.peer = undefined;
      node.server = undefined;
      node.hub = undefined;
      if (p) await p.close().catch(() => {});
      if (s) await s.close().catch(() => {});
      if (h) await h.close().catch(() => {});
    },
    async startAsHub() {
      await node.stop();
      const provider = fauxProvider({ provider: "openai", models: [{ id: "cluster-model" }] });
      provider.setResponses(Array.from({ length: 16 }, () => () => fauxAssistantMessage([fauxText(`来自 ${name} 主机`)])));
      const models = createModels();
      models.setProvider(provider.provider);
      node.hub = await openTestHub({
        models,
        providerId: "openai",
        connectionVaultKeyStore: keyStore,
        config: {
          stateDir: paths.hubStateDir,
          localEnvRoot: workspaceDir,
          host: "0.0.0.0",
          port: node.port,
          authToken: HUB_TEST_ADMIN_TOKEN,
          envTokens: {},
          workerEnvIds: [],
          enableLocalEnv: true,
          extraProtectedPaths: protectedPaths,
          memory: { enabled: false },
          model: { defaultProvider: "openai", defaultModel: "cluster-model", thinkingLevel: "off", baseUrl: "http://127.0.0.1:9/v1" },
        },
      });
      node.server = await startKuloHubServer(node.hub, {
        host: "0.0.0.0",
        port: node.port,
        peerConfigPath: paths.peerConfigPath,
        peerRootDir: workspaceDir,
        roleTransitions: node.roles,
        clusterPaths: paths,
        clusterKeyStore: keyStore,
        clusterSyncDebounceMs: 60,
        clusterSyncMaxDelayMs: 120,
        clusterFenceIntervalMs: 5_000,
      });
      node.port = node.server.port;
    },
    async startAsPeer(config: DevicePeerConfig) {
      await node.stop();
      savePeerConfig(config, paths.peerConfigPath);
      node.peer = await startDevicePeer(config, {
        port: node.port,
        configPath: paths.peerConfigPath,
        authToken: HUB_TEST_ADMIN_TOKEN,
        protectedPaths: [paths.hubStateDir, ...protectedPaths],
        roleTransitions: node.roles,
        ...(options.warmStandbyCapable
          ? { standbyHost: createStandbyHostBridge({ paths, keyStore, pollIntervalMs: 60_000 }) }
          : {}),
      });
      node.port = node.peer.port;
      return node.peer;
    },
  };

  node.roles = new DeviceRoleTransitions({
    configPath: paths.peerConfigPath,
    rootDir: workspaceDir,
    startHub: async () => { await node.startAsHub(); },
    startPeer: async (cfg) => node.startAsPeer(cfg),
  });

  cleanups.push(async () => {
    await node.roles.settled().catch(() => {});
    await node.stop();
  });
  return node;
}

async function pairPeerToHub(hubOrigin: string, target: ManagedNode): Promise<DevicePeerConfig> {
  const inviteRes = await fetch(`${hubOrigin}/api/devices/invitations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ hubUrl: hubOrigin, name: target.name }),
  });
  expect(inviteRes.status).toBe(201);
  const invite = (await inviteRes.json()) as { id: string; deviceId: string; command?: string };
  const inviteToken = /'([A-Za-z0-9_-]+)'$/.exec(invite.command ?? "")?.[1];
  expect(inviteToken).toBeTruthy();

  const pairRes = await fetch(`${hubOrigin}/api/devices/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      inviteToken,
      info: collectDeviceSystemInfo(),
      rootDir: path.join(target.dataDir, "workspace"),
    }),
  });
  expect(pairRes.status).toBe(200);
  const peerConfig = (await pairRes.json()) as DevicePeerConfig;
  await target.startAsPeer(peerConfig);
  await target.peer!.ready;
  return peerConfig;
}

describe("3-node multi-hub warm-standby failover, pre-start fence, and zero-loss failback", () => {
  it("runs complete lifecycle: standby grant -> live sync -> primary crash -> failover -> pre-start fence auto-demote -> reverse-sync -> planned handover -> revoke wipe", async () => {
    const ip = lanIpv4();
    const nodeA = createManagedNode("MacMini", { warmStandbyCapable: true });
    const nodeB = createManagedNode("MacBook", { warmStandbyCapable: true });
    const nodeC = createManagedNode("Workstation", { warmStandbyCapable: false });

    // 1. Boot Node A as Primary and enable device interconnection
    await nodeA.startAsHub();
    const localA = `http://127.0.0.1:${nodeA.port}`;
    const lanA = `http://${ip}:${nodeA.port}`;
    const enableRes = await fetch(`${localA}/api/devices`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enableRes.status).toBe(200);

    // 2. Pair Node B (Standby-capable) and Node C (regular Peer)
    const cfgB = await pairPeerToHub(lanA, nodeB);
    const cfgC = await pairPeerToHub(lanA, nodeC);

    // 3. Create initial durable data + upload on Node A
    const topicRes = await fetch(`${localA}/api/topics`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "集群容灾验证会话" }),
    });
    expect(topicRes.ok).toBe(true);
    const createdTopic = (await topicRes.json()) as { id: string; title: string };
    const uploadA = nodeA.hub!.uploads.saveUpload({
      name: "primary-note.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("epoch-1-primary-payload", "utf8"),
      ownerId: "local",
    });

    // 4. Security check: proxied, cross-origin, and query-token standby mutations MUST be rejected (403)
    const proxiedStandby = await fetch(`${lanA}/api/devices/${cfgB.deviceId}/standby`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfgC.clientToken}`,
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(proxiedStandby.status).toBe(403);

    const crossSiteStandby = await fetch(`${lanA}/api/devices/${cfgB.deviceId}/standby`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfgC.clientToken}`,
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(crossSiteStandby.status).toBe(403);

    const queryTokenStandby = await fetch(
      `${lanA}/api/devices/${cfgB.deviceId}/standby?token=${encodeURIComponent(cfgC.clientToken)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(queryTokenStandby.status).toBe(403);

    // Paired desktop Peer C sees canManageHub/canManageStandby and shares owner Hub standby control
    const peerCViewRes = await fetch(`${lanA}/api/devices`, {
      headers: { authorization: `Bearer ${cfgC.clientToken}` },
    });
    expect(peerCViewRes.status).toBe(200);
    const peerCView = (await peerCViewRes.json()) as DeviceInterconnectionView;
    expect(peerCView.canManageHub).toBe(true);
    expect(peerCView.canManageStandby).toBe(true);

    // 5. Paired desktop Peer C grants warm-standby to Node B on Primary A
    const grantRes = await fetch(`${lanA}/api/devices/${cfgB.deviceId}/standby`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfgC.clientToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(grantRes.status).toBe(200);
    const viewAfterGrant = (await grantRes.json()) as DeviceInterconnectionView;
    const standbyDevice = viewAfterGrant.devices.find((d) => d.id === cfgB.deviceId);
    expect(standbyDevice?.clusterRole).toBe("standby");

    // 6. Wait for Node B to complete live baseline sync from Node A
    await waitFor(async () => {
      const res = await fetch(`${localA}/api/devices`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      const v = (await res.json()) as DeviceInterconnectionView;
      const b = v.devices.find((d) => d.id === cfgB.deviceId);
      return b?.syncStatus?.state === "synced" && (b.syncStatus.syncedGeneration ?? 0) >= 1;
    }, 15_000);

    // 7. Security check: non-standby Peer C gets 403 standby_revoked on sync manifest
    const cAuth = createClusterAuthHeader({
      secret: cfgC.clientToken,
      nodeId: cfgC.deviceId,
      method: "GET",
      pathWithQuery: "/api/cluster/sync/manifest",
    });
    const cSyncRes = await fetch(`${lanA}/api/cluster/sync/manifest`, {
      headers: { [CLUSTER_AUTH_HEADER]: cAuth.header },
    });
    expect(cSyncRes.status).toBe(403);
    expect(((await cSyncRes.json()) as { code?: string }).code).toBe("standby_revoked");

    // 8. Security check: non-loopback HTTP UI access on Standby B is rejected (403), while remote promote fails with 409 primary_still_reachable while A is online!
    const lanB = `http://${ip}:${nodeB.port}`;
    const localB = `http://127.0.0.1:${nodeB.port}`;
    const nonLoopbackUi = await fetch(`${lanB}/api/devices`, {
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
    });
    expect(nonLoopbackUi.status).toBe(403);

    const promoteWhileAliveAuth = createClusterAuthHeader({
      secret: cfgC.clientToken,
      nodeId: cfgC.deviceId,
      method: "POST",
      pathWithQuery: "/_kulo/cluster/promote",
      body: "{}",
    });
    const promoteWhileAlive = await fetch(`${lanB}/_kulo/cluster/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", [CLUSTER_AUTH_HEADER]: promoteWhileAliveAuth.header },
      body: "{}",
    });
    expect(promoteWhileAlive.status).toBe(409);

    // 9. Crash / Stop Primary A!
    await nodeA.stop();

    // 10. Promote Standby B locally via /api/devices/promote
    const promoteRes = await fetch(`${localB}/api/devices/promote`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect([200, 202]).toContain(promoteRes.status);

    // Wait for B to become Active Hub at epoch 2
    await waitFor(async () => {
      const r = await fetch(`${localB}/api/devices/cluster-status`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      if (!r.ok) return false;
      const st = (await r.json()) as ClusterLocalStatusView;
      return st.role === "primary" && st.epoch === 2 ? st : false;
    }, 15_000);

    // Verify Epoch-1 topic & upload survived on promoted B!
    const topicsOnB = await nodeB.hub!.listTopics();
    expect(topicsOnB.some((t) => t.id === createdTopic.id && t.title === "集群容灾验证会话")).toBe(true);
    const loadedUploadOnB = nodeB.hub!.uploads.getUpload(uploadA.id);
    expect(loadedUploadOnB).toBeTruthy();
    expect(fs.readFileSync(loadedUploadOnB!.filePath, "utf8")).toBe("epoch-1-primary-payload");

    // 11. Write NEW Epoch-2 topic + upload on promoted B!
    const topic2Res = await fetch(`${localB}/api/topics`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "备用主机接管期间新建会话" }),
    });
    expect(topic2Res.ok).toBe(true);
    const epoch2Topic = (await topic2Res.json()) as { id: string; title: string };
    const uploadB = nodeB.hub!.uploads.saveUpload({
      name: "standby-era-note.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("epoch-2-standby-payload", "utf8"),
      ownerId: cfgB.deviceId,
    });

    // 12. Original Primary A recovers! Pre-start Fence detects B (epoch 2) and automatically demotes A to Standby Peer!
    const fenceResult = await runPreStartFence(nodeA.paths, {
      defaultRootDir: path.join(nodeA.dataDir, "workspace"),
      probeTimeoutMs: 3_000,
    });
    expect(fenceResult.action).toBe("start_peer");
    if (fenceResult.action !== "start_peer") throw new Error("Expected start_peer");
    await nodeA.startAsPeer(fenceResult.peerConfig);
    await nodeA.peer!.ready;

    // Wait for B to observe A online + synced -> failbackOffer becomes ready!
    const failbackStatus = await waitFor(async () => {
      const r = await fetch(`${localB}/api/devices/cluster-status`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      if (!r.ok) return false;
      const st = (await r.json()) as ClusterLocalStatusView;
      return st.failbackOffer?.ready ? st : false;
    }, 15_000);
    expect(failbackStatus.failbackOffer?.preferredPrimaryNodeId).toBe(readPeerConfig(nodeA.paths.peerConfigPath)?.deviceId);

    // 13. Trigger Planned Handover (Graceful Failback) from B back to A!
    const handoverRes = await fetch(`${localB}/api/cluster/handover`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ targetNodeId: failbackStatus.failbackOffer!.preferredPrimaryNodeId }),
    });
    expect([200, 202]).toContain(handoverRes.status);

    // Wait for A to become Active Hub at epoch 3 AND B to demote cleanly back to Standby Peer!
    await waitFor(async () => {
      const r = await fetch(`${localA}/api/devices/cluster-status`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      if (!r.ok) return false;
      const st = (await r.json()) as ClusterLocalStatusView;
      return st.role === "primary" && st.epoch === 3 ? st : false;
    }, 15_000);

    // Verify ZERO data loss on A (both Epoch-1 AND Epoch-2 topics + uploads present!)
    const topicsBackOnA = await nodeA.hub!.listTopics();
    expect(topicsBackOnA.some((t) => t.id === createdTopic.id)).toBe(true);
    expect(topicsBackOnA.some((t) => t.id === epoch2Topic.id && t.title === "备用主机接管期间新建会话")).toBe(true);
    expect(fs.readFileSync(nodeA.hub!.uploads.getUpload(uploadA.id)!.filePath, "utf8")).toBe("epoch-1-primary-payload");
    expect(fs.readFileSync(nodeA.hub!.uploads.getUpload(uploadB.id)!.filePath, "utf8")).toBe("epoch-2-standby-payload");

    // 14. Wait for B to reconnect to A as Standby, then revoke B's standby role -> B wipes standby/!
    await waitFor(async () => {
      const r = await fetch(`${localA}/api/devices`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      const v = (await r.json()) as DeviceInterconnectionView;
      const b = v.devices.find((d) => d.id === cfgB.deviceId);
      return b?.status === "online" && b?.clusterRole === "standby";
    }, 15_000);

    const revokeRes = await fetch(`${localA}/api/devices/${cfgB.deviceId}/standby`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(revokeRes.status).toBe(200);

    await waitFor(async () => !fs.existsSync(nodeB.paths.standbyDir), 10_000);
    expect(fs.existsSync(nodeB.paths.standbyDir)).toBe(false);
  }, 60_000);

  it("enforces reversible HandoverBarrier (503 on writes, instant rollback) and allows remote Peer-triggered promotion when Primary is offline", async () => {
    const ip = lanIpv4();
    const nodeA = createManagedNode("PrimaryBarrier", { warmStandbyCapable: true });
    const nodeB = createManagedNode("StandbyRemote", { warmStandbyCapable: true });
    const nodeC = createManagedNode("RemoteTriggerPeer", { warmStandbyCapable: false });

    await nodeA.startAsHub();
    const localA = `http://127.0.0.1:${nodeA.port}`;
    const lanA = `http://${ip}:${nodeA.port}`;
    await fetch(`${localA}/api/devices`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    const cfgB = await pairPeerToHub(lanA, nodeB);
    await pairPeerToHub(lanA, nodeC);

    // Verify reversible HandoverBarrier rejects HTTP writes with 503 and recovers immediately on release
    nodeA.hub!.beginHandoverBarrier(10_000);
    const blockedWrite = await fetch(`${localA}/api/topics`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "blocked-during-handover" }),
    });
    expect(blockedWrite.status).toBe(503);
    expect(((await blockedWrite.json()) as { code?: string }).code).toBe("cluster_handover_in_progress");

    nodeA.hub!.releaseHandoverBarrier();
    const allowedWrite = await fetch(`${localA}/api/topics`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "restored-after-rollback" }),
    });
    expect(allowedWrite.ok).toBe(true);

    // Grant standby to B and wait for sync + Peer C receiving topology
    const grantRes = await fetch(`${localA}/api/devices/${cfgB.deviceId}/standby`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(grantRes.status).toBe(200);
    await waitFor(async () => {
      const r = await fetch(`${localA}/api/devices`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      const v = (await r.json()) as DeviceInterconnectionView;
      const b = v.devices.find((d) => d.id === cfgB.deviceId);
      const peerCluster = readPeerConfig(nodeC.paths.peerConfigPath)?.cluster;
      return b?.syncStatus?.state === "synced" && Boolean(peerCluster?.hubs.some((h) => h.nodeId === cfgB.deviceId && h.urls.length > 0));
    }, 15_000);

    // Crash Primary A, then trigger remote promote FROM Peer C's local UI API!
    await nodeA.stop();
    const localC = `http://127.0.0.1:${nodeC.port}`;
    const localB = `http://127.0.0.1:${nodeB.port}`;
    const remotePromoteRes = await fetch(`${localC}/api/devices/promote`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ targetNodeId: cfgB.deviceId }),
    });
    expect([200, 202]).toContain(remotePromoteRes.status);
    const remotePromoteBody = (await remotePromoteRes.json()) as { delegated?: boolean; targetNodeId?: string };
    expect(remotePromoteBody.delegated).toBe(true);
    expect(remotePromoteBody.targetNodeId).toBe(cfgB.deviceId);

    // Standby B promotes to Active Hub at epoch 2 AND Peer C automatically connects to B!
    await waitFor(async () => {
      const r = await fetch(`${localB}/api/devices/cluster-status`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      if (!r.ok) return false;
      const st = (await r.json()) as ClusterLocalStatusView;
      return st.role === "primary" && st.epoch === 2 ? st : false;
    }, 15_000);

    // Peer C's local proxy now serves topics from the promoted Hub B seamlessly!
    await waitFor(async () => {
      const r = await fetch(`${localC}/api/devices`, {
        headers: { authorization: `Bearer ${HUB_TEST_ADMIN_TOKEN}` },
      });
      if (!r.ok) return false;
      const v = (await r.json()) as DeviceInterconnectionView;
      return v.primaryNodeId === cfgB.deviceId && !v.hubError;
    }, 15_000);
  }, 60_000);
});
