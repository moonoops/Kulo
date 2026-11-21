import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { compareAuthorityTuples, isAuthorityHigher } from "@kulo/protocol";
import {
  ClusterNonceGuard,
  createClusterAuthHeader,
  decryptKeyMaterialWithKek,
  encryptClusterEnvelope,
  encryptKeyMaterialWithKek,
  generateClusterNodeKeyMaterial,
  probeUrlsHappyEyeballs,
  verifyAndDecryptClusterEnvelope,
} from "@kulo/env";

describe("cluster authority ordering and security primitives", () => {
  it("enforces deterministic total ordering on AuthorityTuple (epoch > preferredPrimary > nodeId)", () => {
    expect(
      isAuthorityHigher(
        { epoch: 2, isPreferredPrimary: false, nodeId: "node-a" },
        { epoch: 1, isPreferredPrimary: true, nodeId: "node-z" },
      ),
    ).toBe(true);
    expect(
      isAuthorityHigher(
        { epoch: 2, isPreferredPrimary: true, nodeId: "node-a" },
        { epoch: 2, isPreferredPrimary: false, nodeId: "node-z" },
      ),
    ).toBe(true);
    expect(
      isAuthorityHigher(
        { epoch: 2, isPreferredPrimary: false, nodeId: "node-b" },
        { epoch: 2, isPreferredPrimary: false, nodeId: "node-a" },
      ),
    ).toBe(true);
    expect(
      compareAuthorityTuples(
        { epoch: 3, isPreferredPrimary: true, nodeId: "node-a" },
        { epoch: 3, isPreferredPrimary: true, nodeId: "node-a" },
      ),
    ).toBe(0);
  });

  it("verifies HMAC-SHA256 cluster auth headers and blocks tampering, replays, and stale timestamps", () => {
    const guard = new ClusterNonceGuard(60_000);
    const secret = "sync-secret-fixture-value-0123456789";
    const body = JSON.stringify({ generation: 4, db: "kulo.sqlite", pages: [0, 1] });
    const now = 1_700_000_000_000;
    const { header, nonce } = createClusterAuthHeader({
      secret,
      nodeId: "standby-macbook",
      method: "POST",
      pathWithQuery: "/api/cluster/sync/sqlite-pages",
      body,
      timestampMs: now,
    });

    // Valid request passes
    const ok = guard.verifyAndConsume({
      headerValue: header,
      method: "POST",
      pathWithQuery: "/api/cluster/sync/sqlite-pages",
      body,
      resolveSecret: (id) => (id === "standby-macbook" ? secret : undefined),
      now,
    });
    expect(ok).toEqual({ ok: true, nodeId: "standby-macbook", nonce });

    // Replay with identical nonce is rejected
    const replay = guard.verifyAndConsume({
      headerValue: header,
      method: "POST",
      pathWithQuery: "/api/cluster/sync/sqlite-pages",
      body,
      resolveSecret: (id) => (id === "standby-macbook" ? secret : undefined),
      now: now + 1000,
    });
    expect(replay).toEqual({ ok: false, reason: "replayed_nonce" });

    // Tampered body fails HMAC
    const fresh = createClusterAuthHeader({
      secret,
      nodeId: "standby-macbook",
      method: "POST",
      pathWithQuery: "/api/cluster/sync/sqlite-pages",
      body,
      timestampMs: now,
    });
    expect(
      guard.verifyAndConsume({
        headerValue: fresh.header,
        method: "POST",
        pathWithQuery: "/api/cluster/sync/sqlite-pages",
        body: JSON.stringify({ generation: 4, db: "kulo.sqlite", pages: [0, 2] }),
        resolveSecret: () => secret,
        now,
      }),
    ).toEqual({ ok: false, reason: "invalid_hmac" });

    // Out-of-window timestamp is rejected
    const stale = createClusterAuthHeader({
      secret,
      nodeId: "standby-macbook",
      method: "GET",
      pathWithQuery: "/api/cluster/sync/manifest",
      timestampMs: now - 120_000,
    });
    expect(
      guard.verifyAndConsume({
        headerValue: stale.header,
        method: "GET",
        pathWithQuery: "/api/cluster/sync/manifest",
        resolveSecret: () => secret,
        now,
      }),
    ).toEqual({ ok: false, reason: "timestamp_out_of_window" });
  });

  it("encrypts and authenticates sync envelopes end-to-end and rejects MITM, tampering, and nonce mismatch", () => {
    const primaryKeys = generateClusterNodeKeyMaterial();
    const standbyKeys = generateClusterNodeKeyMaterial();
    const attackerKeys = generateClusterNodeKeyMaterial();
    const plaintext = Buffer.from(JSON.stringify({ secret: "fixture-api-key-12345" }), "utf8");

    const envelope = encryptClusterEnvelope({
      plaintext,
      hubId: "hub-123",
      epoch: 2,
      generation: 9,
      senderNodeId: "node-primary",
      targetNodeId: "node-standby",
      requestNonce: "nonce-abcdef0123456789",
      resourceId: "vault",
      recipientX25519PublicKey: standbyKeys.x25519PublicKey,
      senderEd25519PrivateDerB64: primaryKeys.ed25519PrivateDerB64,
    });

    const decrypted = verifyAndDecryptClusterEnvelope({
      envelope,
      expectedHubId: "hub-123",
      expectedMinEpoch: 2,
      expectedTargetNodeId: "node-standby",
      expectedRequestNonce: "nonce-abcdef0123456789",
      expectedResourceId: "vault",
      expectedSenderIdentityPublicKey: primaryKeys.ed25519PublicKey,
      recipientX25519PrivateDerB64: standbyKeys.x25519PrivateDerB64,
    });
    expect(decrypted.equals(plaintext)).toBe(true);

    // Wrong sender public key (MITM)
    expect(() =>
      verifyAndDecryptClusterEnvelope({
        envelope,
        expectedHubId: "hub-123",
        expectedMinEpoch: 2,
        expectedTargetNodeId: "node-standby",
        expectedRequestNonce: "nonce-abcdef0123456789",
        expectedResourceId: "vault",
        expectedSenderIdentityPublicKey: attackerKeys.ed25519PublicKey,
        recipientX25519PrivateDerB64: standbyKeys.x25519PrivateDerB64,
      }),
    ).toThrow();

    // Wrong requestNonce (replay into another HTTP request)
    expect(() =>
      verifyAndDecryptClusterEnvelope({
        envelope,
        expectedHubId: "hub-123",
        expectedMinEpoch: 2,
        expectedTargetNodeId: "node-standby",
        expectedRequestNonce: "nonce-different-000000",
        expectedResourceId: "vault",
        expectedSenderIdentityPublicKey: primaryKeys.ed25519PublicKey,
        recipientX25519PrivateDerB64: standbyKeys.x25519PrivateDerB64,
      }),
    ).toThrow();

    // Epoch downgrade rejected
    expect(() =>
      verifyAndDecryptClusterEnvelope({
        envelope,
        expectedHubId: "hub-123",
        expectedMinEpoch: 3,
        expectedTargetNodeId: "node-standby",
        expectedRequestNonce: "nonce-abcdef0123456789",
        expectedResourceId: "vault",
        expectedSenderIdentityPublicKey: primaryKeys.ed25519PublicKey,
        recipientX25519PrivateDerB64: standbyKeys.x25519PrivateDerB64,
      }),
    ).toThrow();

    // Tampered ciphertext fails signature/GCM auth
    const tamperedBytes = Buffer.from(envelope.ciphertext, "base64");
    tamperedBytes[0] = (tamperedBytes[0]! ^ 0xff) & 0xff;
    expect(() =>
      verifyAndDecryptClusterEnvelope({
        envelope: { ...envelope, ciphertext: tamperedBytes.toString("base64") },
        expectedHubId: "hub-123",
        expectedMinEpoch: 2,
        expectedTargetNodeId: "node-standby",
        expectedRequestNonce: "nonce-abcdef0123456789",
        expectedResourceId: "vault",
        expectedSenderIdentityPublicKey: primaryKeys.ed25519PublicKey,
        recipientX25519PrivateDerB64: standbyKeys.x25519PrivateDerB64,
      }),
    ).toThrow();
  });

  it("wraps and unwraps node key material with 32-byte KEK bound to AAD context", () => {
    const kek = randomBytes(32);
    const material = generateClusterNodeKeyMaterial();
    const sealed = encryptKeyMaterialWithKek(material, kek, "sync-key:/data/kulo");
    const restored = decryptKeyMaterialWithKek(sealed, kek, "sync-key:/data/kulo");
    expect(restored).toEqual(material);
    expect(() => decryptKeyMaterialWithKek(sealed, kek, "sync-key:/data/other")).toThrow();
  });

  it("races LAN URLs ahead of Tailscale URLs with Happy Eyeballs and aborts losers", async () => {
    const aborted: string[] = [];
    const result = await probeUrlsHappyEyeballs(
      ["http://100.88.1.2:7788", "http://192.168.1.10:7788"],
      async (url, signal) => {
        signal.addEventListener("abort", () => aborted.push(url));
        if (url.includes("192.168.")) {
          await new Promise((r) => setTimeout(r, 20));
          return "lan-ok";
        }
        await new Promise((r) => setTimeout(r, 400));
        return "ts-ok";
      },
      { timeoutMs: 2_000, staggerMs: 100 },
    );
    expect(result).toEqual({ url: "http://192.168.1.10:7788", value: "lan-ok" });
    expect(aborted).not.toContain("http://100.88.1.2:7788");
  });
});
