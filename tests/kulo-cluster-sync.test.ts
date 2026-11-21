import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLUSTER_AUTH_HEADER,
  ClusterNonceGuard,
  parseClusterAuthHeader,
} from "@kulo/env";
import {
  AssistantLedger,
  ClusterSyncHttpError,
  ClusterSyncService,
  ConnectionVaultError,
  KuloIdentityFiles,
  LocalConnectionVault,
  StandbyReplicator,
  applyReplicaForPromotion,
  createStandbyVaultNamespace,
  ensureLocalClusterKeys,
  readReplicaState,
  recoverInterruptedClusterTransition,
  resolveClusterPaths,
  type ConnectionVaultKeyStore,
} from "@kulo/hub";
import { resolveEffectiveIdentityDir } from "../packages/hub/src/settings.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function tempDir(prefix = "kulo-cluster-sync-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class MemoryKeyStore implements ConnectionVaultKeyStore {
  readonly keys = new Map<string, Buffer>();
  locked = false;

  async checkAvailability(): Promise<void> {
    if (this.locked) throw new ConnectionVaultError("connection_vault_locked");
  }

  async getOrCreateKey(namespace: string, create = true): Promise<Buffer> {
    if (this.locked) throw new ConnectionVaultError("connection_vault_locked");
    let key = this.keys.get(namespace);
    if (!key && create) {
      key = randomBytes(32);
      this.keys.set(namespace, key);
    }
    if (!key) throw new ConnectionVaultError("connection_vault_key_missing");
    return Buffer.from(key);
  }
}

async function startMockSyncPrimary(options: {
  syncService: ClusterSyncService;
  syncToken: string;
  standbyNodeId: string;
  onSqlitePages?: (pages: number[]) => void;
}): Promise<{ origin: string; close: () => Promise<void> }> {
  const guard = new ClusterNonceGuard();
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const authHeader = typeof req.headers[CLUSTER_AUTH_HEADER] === "string" ? req.headers[CLUSTER_AUTH_HEADER] : undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);

    const parsed = parseClusterAuthHeader(authHeader);
    if (!parsed) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (parsed.nodeId !== options.standbyNodeId) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Revoked", code: "standby_revoked" }));
      return;
    }
    const auth = guard.verifyAndConsume({
      headerValue: authHeader,
      method: req.method ?? "GET",
      pathWithQuery: req.url ?? parsedUrl.pathname,
      body: req.method === "POST" ? rawBody : undefined,
      resolveSecret: () => options.syncToken,
    });
    if (!auth.ok) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: auth.reason }));
      return;
    }

    try {
      if (parsedUrl.pathname === "/api/cluster/sync/manifest" && req.method === "GET") {
        const env = await options.syncService.serveManifest(auth.nodeId, auth.nonce);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(env));
        return;
      }
      if (parsedUrl.pathname === "/api/cluster/sync/sqlite-pages" && req.method === "POST") {
        const body = JSON.parse(rawBody.toString("utf8")) as { generation: number; db: string; pages: number[] };
        options.onSqlitePages?.(body.pages);
        const env = await options.syncService.serveSqlitePages(auth.nodeId, auth.nonce, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(env));
        return;
      }
      if (parsedUrl.pathname === "/api/cluster/sync/file" && req.method === "GET") {
        const env = await options.syncService.serveFile(auth.nodeId, auth.nonce, {
          generation: Number(parsedUrl.searchParams.get("generation")),
          relPath: parsedUrl.searchParams.get("path") ?? "",
          ...(parsedUrl.searchParams.has("offset") ? { offset: Number(parsedUrl.searchParams.get("offset")) } : {}),
          ...(parsedUrl.searchParams.has("length") ? { length: Number(parsedUrl.searchParams.get("length")) } : {}),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(env));
        return;
      }
      if (parsedUrl.pathname === "/api/cluster/sync/vault" && req.method === "GET") {
        const env = await options.syncService.serveVault(auth.nodeId, auth.nonce, Number(parsedUrl.searchParams.get("generation")));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(env));
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (error) {
      const status = error instanceof ClusterSyncHttpError ? error.status : 500;
      const code = error instanceof ClusterSyncHttpError ? error.code : "error";
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), code }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind mock sync server");
  const close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  cleanups.push(close);
  return { origin: `http://127.0.0.1:${addr.port}`, close };
}

describe("warm-standby tiered sync engine and crash-idempotent promotion", () => {
  it("replicates kulo.sqlite + assistant.sqlite incrementally by 4KB pages, re-encrypts Vault across independent KeyStores, syncs uploads, and preserves local host files on promotion", async () => {
    const primaryData = tempDir("kulo-primary-");
    const standbyData = tempDir("kulo-standby-");
    const primaryPaths = resolveClusterPaths(primaryData);
    const standbyPaths = resolveClusterPaths(standbyData);
    fs.mkdirSync(primaryPaths.hubStateDir, { recursive: true });
    fs.mkdirSync(standbyPaths.hubStateDir, { recursive: true });

    const primaryKeyStore = new MemoryKeyStore();
    const standbyKeyStore = new MemoryKeyStore();
    const primaryKeys = await ensureLocalClusterKeys({
      dataDir: primaryData,
      hubStateDir: primaryPaths.hubStateDir,
      standbyDir: primaryPaths.standbyDir,
      keyStore: primaryKeyStore,
    });
    const standbyKeys = await ensureLocalClusterKeys({
      dataDir: standbyData,
      hubStateDir: standbyPaths.hubStateDir,
      standbyDir: standbyPaths.standbyDir,
      keyStore: standbyKeyStore,
    });

    const hubId = "hub-cluster-sync-test";
    const primaryNodeId = "node-macmini";
    const standbyNodeId = "node-macbook";
    const syncToken = "sync-tok-fixture-0123456789abcdef";

    // Populate primary kulo.sqlite (WAL mode) with multiple pages
    const primaryDbPath = path.join(primaryPaths.hubStateDir, "kulo.sqlite");
    const primaryDb = new DatabaseSync(primaryDbPath);
    cleanups.push(() => primaryDb.close());
    primaryDb.exec("PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT);");
    const insert = primaryDb.prepare("INSERT INTO items (id, body) VALUES (?, ?)");
    for (let i = 1; i <= 40; i++) insert.run(i, `payload-${i}-${"x".repeat(800)}`);

    // Populate primary assistant.sqlite
    const ledger = new AssistantLedger({ stateDir: primaryPaths.hubStateDir });
    cleanups.push(() => ledger.close());
    await ledger.recordDigest({
      createdAt: Date.now(),
      appId: "com.apple.mail",
      appLabel: "Mail",
      category: "work",
      disposition: "archive",
      urgency: "normal",
      digest: "Invoice approved by finance",
      eventIds: ["evt-1"],
      situationKey: "mail:invoice",
    }, (s) => s);

    // Populate primary Vault
    const primaryVault = new LocalConnectionVault({ stateDir: primaryPaths.hubStateDir, keyStore: primaryKeyStore });
    await primaryVault.set("durable-secret:00000000-0000-4000-8000-000000000001", { value: "fixture-primary-secret-999" });

    // Populate primary managed identity + backup (verify managed:identity portability!)
    const primaryIdentityDir = path.join(primaryPaths.hubStateDir, "identity");
    fs.mkdirSync(primaryIdentityDir, { recursive: true });
    const primaryIdentity = new KuloIdentityFiles(
      () => ({ directory: primaryIdentityDir, directoryRevision: 1 }),
      { managedDirectory: primaryIdentityDir },
    );
    const initRead = await primaryIdentity.read("relationship.md");
    const saved = await primaryIdentity.saveRelationship({
      file: "relationship.md",
      expected: initRead.version,
      content: "# 协作关系\n主节点写入的长期偏好。",
      summary: "首次记录偏好",
    });
    expect(saved.backupId).toBeTruthy();

    // Populate primary devices.json & an upload file > 1MB (tests multi-chunk Range resume)
    fs.writeFileSync(
      path.join(primaryPaths.hubStateDir, "devices.json"),
      JSON.stringify({
        version: 1,
        hubId,
        enabled: true,
        localName: "Mac mini",
        localNodeId: primaryNodeId,
        legacyLocalNodeId: primaryNodeId,
        clusterEpoch: 1,
        primaryNodeId,
        preferredPrimaryNodeId: primaryNodeId,
        identityPublicKey: primaryKeys.ed25519PublicKey,
        devices: [
          {
            id: primaryNodeId,
            name: "Mac mini",
            envToken: "env-p",
            clientToken: "cli-p",
            syncToken: "sync-p",
            rootDir: "/tmp",
            pairedAt: 1,
            standby: true,
            standbyPriority: 0,
            standbyPublicKey: primaryKeys.x25519PublicKey,
            identityPublicKey: primaryKeys.ed25519PublicKey,
          },
          {
            id: standbyNodeId,
            name: "MacBook Pro",
            envToken: "env-s",
            clientToken: "cli-s",
            syncToken,
            rootDir: "/tmp",
            pairedAt: 2,
            standby: true,
            standbyPriority: 1,
            standbyPublicKey: standbyKeys.x25519PublicKey,
            identityPublicKey: standbyKeys.ed25519PublicKey,
          },
        ],
      }),
    );
    const uploadsDir = path.join(primaryPaths.hubStateDir, "uploads", "blobs");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const largeUpload = randomBytes(1_250_000);
    fs.writeFileSync(path.join(uploadsDir, "report.bin"), largeUpload);

    const syncService = new ClusterSyncService({
      stateDir: primaryPaths.hubStateDir,
      getHubId: () => hubId,
      getPrimaryNodeId: () => primaryNodeId,
      getClusterEpoch: () => 1,
      hasRemoteStandbys: () => true,
      getEffectiveIdentityDir: () => primaryIdentityDir,
      backupAssistantLedger: (dest) => ledger.backupTo(dest),
      readVaultEntries: () => primaryVault.entries(),
      getSenderKeys: () => primaryKeys,
      resolveStandbyPublicKey: (id) => (id === standbyNodeId ? standbyKeys.x25519PublicKey : undefined),
      notifySyncAvailable: () => {},
      debounceMs: 50,
      maxDelayMs: 100,
    });
    cleanups.push(() => syncService.close());

    const fetchedPageCounts: number[] = [];
    const mockServer = await startMockSyncPrimary({
      syncService,
      syncToken,
      standbyNodeId,
      onSqlitePages: (pages) => fetchedPageCounts.push(pages.length),
    });

    const replicator = new StandbyReplicator({
      dataDir: standbyData,
      hubStateDir: standbyPaths.hubStateDir,
      standbyDir: standbyPaths.standbyDir,
      hubId,
      nodeId: standbyNodeId,
      syncToken,
      getPrimaryUrl: () => mockServer.origin,
      getPrimaryNodeId: () => primaryNodeId,
      getPrimaryIdentityPublicKey: () => primaryKeys.ed25519PublicKey,
      getClusterEpoch: () => 1,
      getNodeKeys: async () => standbyKeys,
      keyStore: standbyKeyStore,
    });
    cleanups.push(() => replicator.stop());

    // 1. Baseline sync (gen 1)
    const gen1Manifest = await syncService.flushNow();
    expect(gen1Manifest.generation).toBe(1);
    const state1 = await replicator.syncForHandover(1);
    expect(state1.generation).toBe(1);
    expect(state1.uploadsComplete).toBe(true);
    const totalPagesGen1 = fetchedPageCounts.reduce((a, b) => a + b, 0);
    expect(totalPagesGen1).toBeGreaterThan(5);

    // 2. Incremental mutation of 1 row -> gen 2 fetches dramatically fewer pages!
    fetchedPageCounts.length = 0;
    primaryDb.prepare("UPDATE items SET body = ? WHERE id = 1").run("updated-row-1");
    syncService.markDirty("sqlite");
    const gen2Manifest = await syncService.flushNow();
    expect(gen2Manifest.generation).toBe(2);
    const state2 = await replicator.syncForHandover(2);
    expect(state2.generation).toBe(2);
    const deltaPagesGen2 = fetchedPageCounts.reduce((a, b) => a + b, 0);
    expect(deltaPagesGen2).toBeGreaterThan(0);
    expect(deltaPagesGen2).toBeLessThan(totalPagesGen1);

    // 3. Verify Standby's Vault re-encrypted under Standby's own KeyStore
    const standbyVault = new LocalConnectionVault({
      stateDir: replicator.replicaDir,
      helperStateDir: standbyPaths.hubStateDir,
      namespaceOverride: createStandbyVaultNamespace(standbyData),
      keyStore: standbyKeyStore,
    });
    expect(await standbyVault.get("durable-secret:00000000-0000-4000-8000-000000000001")).toEqual({
      value: "fixture-primary-secret-999",
    });

    // 4. Plant local host-owned files AND foreign standalone hub + stale WAL files on Standby
    fs.mkdirSync(path.join(standbyPaths.hubStateDir, "managed-hindsight"), { recursive: true });
    fs.writeFileSync(path.join(standbyPaths.hubStateDir, "managed-hindsight", "local.db"), "hindsight-local");
    fs.writeFileSync(path.join(standbyPaths.hubStateDir, "memory-llm-bridge.json"), "{\"local\":true}");
    fs.writeFileSync(path.join(standbyPaths.hubStateDir, "runtime-token"), "local-standby-token");
    fs.mkdirSync(path.join(standbyPaths.hubStateDir, "mobile-connect"), { recursive: true });
    fs.writeFileSync(path.join(standbyPaths.hubStateDir, "mobile-connect", "old.pem"), "old-standalone-cert");
    fs.writeFileSync(path.join(standbyPaths.hubStateDir, "devices.json"), JSON.stringify({ version: 1, hubId: "foreign-standalone-hub", enabled: false, devices: [] }));
    fs.writeFileSync(path.join(standbyPaths.hubStateDir, "kulo.sqlite-wal"), "STALE-CORRUPT-WAL");
    fs.writeFileSync(path.join(standbyPaths.hubStateDir, "kulo.sqlite.redaction-pending"), "1");

    // 5. Promote Standby -> verify preserved local dirs, archived standalone hub, cleaned WAL, restored DB/Vault/Identity/Uploads
    const promoted = await applyReplicaForPromotion(standbyPaths, {
      nodeId: standbyNodeId,
      targetEpoch: 2,
      reason: "failover",
      primaryIdentityPublicKey: primaryKeys.ed25519PublicKey,
      keyStore: standbyKeyStore,
    });
    expect(promoted.hubId).toBe(hubId);
    expect(promoted.epoch).toBe(2);
    expect(promoted.archivedStandalonePath).toBeTruthy();
    expect(fs.existsSync(path.join(promoted.archivedStandalonePath!, "mobile-connect", "old.pem"))).toBe(true);
    expect(fs.existsSync(path.join(standbyPaths.hubStateDir, "mobile-connect"))).toBe(false);
    expect(fs.existsSync(path.join(standbyPaths.hubStateDir, "kulo.sqlite-wal"))).toBe(false);
    expect(fs.existsSync(path.join(standbyPaths.hubStateDir, "kulo.sqlite.redaction-pending"))).toBe(false);
    // Preserved local host files remain untouched
    expect(fs.readFileSync(path.join(standbyPaths.hubStateDir, "managed-hindsight", "local.db"), "utf8")).toBe("hindsight-local");
    expect(fs.readFileSync(path.join(standbyPaths.hubStateDir, "memory-llm-bridge.json"), "utf8")).toBe("{\"local\":true}");
    expect(fs.readFileSync(path.join(standbyPaths.hubStateDir, "runtime-token"), "utf8")).toBe("local-standby-token");

    // Verify promoted DB, assistant.sqlite, Vault, Uploads, and Identity backup portability!
    const promotedDb = new DatabaseSync(path.join(standbyPaths.hubStateDir, "kulo.sqlite"), { readOnly: true });
    cleanups.push(() => promotedDb.close());
    expect(promotedDb.prepare("SELECT body FROM items WHERE id = 1").get()).toEqual({ body: "updated-row-1" });

    const promotedLedger = new AssistantLedger({ stateDir: standbyPaths.hubStateDir });
    cleanups.push(() => promotedLedger.close());
    expect((await promotedLedger.recentDigests()).items[0]?.digest).toBe("Invoice approved by finance");

    const promotedVault = new LocalConnectionVault({ stateDir: standbyPaths.hubStateDir, keyStore: standbyKeyStore });
    expect(await promotedVault.get("durable-secret:00000000-0000-4000-8000-000000000001")).toEqual({
      value: "fixture-primary-secret-999",
    });

    expect(fs.readFileSync(path.join(standbyPaths.hubStateDir, "uploads", "blobs", "report.bin")).equals(largeUpload)).toBe(true);

    const promotedIdentityDir = path.join(standbyPaths.hubStateDir, "identity");
    const promotedIdentity = new KuloIdentityFiles(
      () => ({ directory: promotedIdentityDir, directoryRevision: 1 }),
      { managedDirectory: promotedIdentityDir },
    );
    expect((await promotedIdentity.read("relationship.md")).content).toContain("主节点写入的长期偏好");
    // Cross-host backup rollback metadata works because `directoryIdentity` is `"managed:identity"`!
    const backupRead = await promotedIdentity.readBackup("relationship.md", saved.backupId!);
    expect(backupRead.file).toBe("relationship.md");
  });

  it("enforces single-generation atomic barrier via vault-envelope.enc when Standby Keychain is locked and recovers interrupted promotion", async () => {
    const primaryData = tempDir("kulo-locked-primary-");
    const standbyData = tempDir("kulo-locked-standby-");
    const primaryPaths = resolveClusterPaths(primaryData);
    const standbyPaths = resolveClusterPaths(standbyData);
    fs.mkdirSync(primaryPaths.hubStateDir, { recursive: true });
    fs.mkdirSync(standbyPaths.hubStateDir, { recursive: true });

    const primaryKeyStore = new MemoryKeyStore();
    const standbyKeyStore = new MemoryKeyStore();
    const primaryKeys = await ensureLocalClusterKeys({
      dataDir: primaryData,
      hubStateDir: primaryPaths.hubStateDir,
      standbyDir: primaryPaths.standbyDir,
      keyStore: primaryKeyStore,
    });
    const standbyKeys = await ensureLocalClusterKeys({
      dataDir: standbyData,
      hubStateDir: standbyPaths.hubStateDir,
      standbyDir: standbyPaths.standbyDir,
      keyStore: standbyKeyStore,
    });

    const hubId = "hub-locked-test";
    const primaryNodeId = "node-p";
    const standbyNodeId = "node-s";
    const syncToken = "sync-tok-locked-0123456789abcdef";

    const db = new DatabaseSync(path.join(primaryPaths.hubStateDir, "kulo.sqlite"));
    cleanups.push(() => db.close());
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (k TEXT PRIMARY KEY); INSERT INTO t VALUES ('gen1');");

    const primaryVault = new LocalConnectionVault({ stateDir: primaryPaths.hubStateDir, keyStore: primaryKeyStore });
    await primaryVault.set("durable-secret:11111111-1111-4111-8111-111111111111", { value: "secret-while-standby-locked" });
    fs.writeFileSync(
      path.join(primaryPaths.hubStateDir, "devices.json"),
      JSON.stringify({
        version: 1,
        hubId,
        enabled: true,
        localNodeId: primaryNodeId,
        primaryNodeId,
        preferredPrimaryNodeId: primaryNodeId,
        clusterEpoch: 1,
        identityPublicKey: primaryKeys.ed25519PublicKey,
        devices: [
          { id: primaryNodeId, name: "P", envToken: "ep", clientToken: "cp", syncToken: "sp", rootDir: "/tmp", pairedAt: 1, standby: true, standbyPublicKey: primaryKeys.x25519PublicKey, identityPublicKey: primaryKeys.ed25519PublicKey },
          { id: standbyNodeId, name: "S", envToken: "es", clientToken: "cs", syncToken, rootDir: "/tmp", pairedAt: 2, standby: true, standbyPublicKey: standbyKeys.x25519PublicKey, identityPublicKey: standbyKeys.ed25519PublicKey },
        ],
      }),
    );

    const syncService = new ClusterSyncService({
      stateDir: primaryPaths.hubStateDir,
      getHubId: () => hubId,
      getPrimaryNodeId: () => primaryNodeId,
      getClusterEpoch: () => 1,
      hasRemoteStandbys: () => true,
      getEffectiveIdentityDir: () => path.join(primaryPaths.hubStateDir, "identity"),
      backupAssistantLedger: async () => false,
      readVaultEntries: () => primaryVault.entries(),
      getSenderKeys: () => primaryKeys,
      resolveStandbyPublicKey: () => standbyKeys.x25519PublicKey,
      notifySyncAvailable: () => {},
    });
    cleanups.push(() => syncService.close());
    const mockServer = await startMockSyncPrimary({ syncService, syncToken, standbyNodeId });

    // Lock Standby Keychain BEFORE syncing!
    standbyKeyStore.locked = true;
    const replicator = new StandbyReplicator({
      dataDir: standbyData,
      hubStateDir: standbyPaths.hubStateDir,
      standbyDir: standbyPaths.standbyDir,
      hubId,
      nodeId: standbyNodeId,
      syncToken,
      getPrimaryUrl: () => mockServer.origin,
      getPrimaryNodeId: () => primaryNodeId,
      getPrimaryIdentityPublicKey: () => primaryKeys.ed25519PublicKey,
      getClusterEpoch: () => 1,
      getNodeKeys: async () => standbyKeys,
      keyStore: standbyKeyStore,
    });
    cleanups.push(() => replicator.stop());

    await syncService.flushNow();
    const lockedState = await replicator.triggerSync();
    expect(lockedState?.pendingVaultEnvelope).toBe(true);
    expect(fs.existsSync(path.join(replicator.replicaDir, "vault-envelope.enc"))).toBe(true);
    expect(readReplicaState(replicator.replicaDir)?.pendingVaultEnvelope).toBe(true);

    // Simulate a crash mid-promotion (interrupted `cluster-transition.json`) then unlock Keychain on restart!
    standbyKeyStore.locked = false;
    fs.writeFileSync(
      standbyPaths.clusterTransitionPath,
      JSON.stringify({
        version: 1,
        action: "promote",
        hubId,
        nodeId: standbyNodeId,
        targetEpoch: 2,
        reason: "failover",
        stage: "copying",
        startedAt: Date.now(),
        primaryIdentityPublicKey: primaryKeys.ed25519PublicKey,
      }),
    );

    const recovered = await recoverInterruptedClusterTransition(standbyPaths, { keyStore: standbyKeyStore });
    expect(recovered.recovered).toBe(true);
    expect(fs.existsSync(standbyPaths.clusterTransitionPath)).toBe(false);

    const promotedVault = new LocalConnectionVault({ stateDir: standbyPaths.hubStateDir, keyStore: standbyKeyStore });
    expect(await promotedVault.get("durable-secret:11111111-1111-4111-8111-111111111111")).toEqual({
      value: "secret-while-standby-locked",
    });
  });

  it("falls back to managed default identity directory when a custom absolute path from another host does not exist", () => {
    const dir = tempDir("kulo-identity-fallback-");
    const defaultIdentity = path.join(dir, "hub", "identity");
    fs.mkdirSync(defaultIdentity, { recursive: true });

    const doc = {
      identity: { directory: "/nonexistent/other-host/custom-identity", directoryRevision: 2 },
    } as never;
    expect(resolveEffectiveIdentityDir(doc, defaultIdentity)).toBe(defaultIdentity);

    const existingCustom = path.join(dir, "custom");
    fs.mkdirSync(existingCustom, { recursive: true });
    const docExisting = {
      identity: { directory: existingCustom, directoryRevision: 2 },
    } as never;
    expect(resolveEffectiveIdentityDir(docExisting, defaultIdentity)).toBe(existingCustom);
  });
});
