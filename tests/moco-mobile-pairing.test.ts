import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvManager } from "@moco/env";
import type { MobileConnectionMetadata, MobileInvitation, MobileInvitationData, MobilePairingProfile, MobilePairingRequest } from "@moco/protocol";
import { DeviceConnectionError, DeviceInterconnectionManager } from "../packages/hub/src/devices.js";
import { MOBILE_INVITATION_TTL_MS, MOBILE_PAIRING_RECOVERY_TTL_MS } from "../packages/hub/src/mobile-pairing.js";

vi.mock("@moco/env", () => ({
  collectDeviceSystemInfo: () => ({ hostname: "test-hub", platform: "linux", arch: "x64", release: "test", cpu: "test-cpu", memoryBytes: 1024, ips: ["192.0.2.10"] }),
}));

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const metadata: MobileConnectionMetadata = {
  hubName: "Test Hub", spkiSHA256: "a".repeat(64),
  candidates: [{ route: "lan", origin: "https://192.0.2.10:7789" }, { route: "tailscale", origin: "https://100.100.100.10:7789" }],
};

function fixture(stateDir?: string) {
  if (!stateDir) {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moco-mobile-pairing-"));
    directories.push(stateDir);
  }
  const env = {
    setDeviceCredential: vi.fn(), setDeviceDisplayName: vi.fn(), removeDevice: vi.fn(),
    setRemoteConnectionsEnabled: vi.fn(), listEnvs: vi.fn(() => []),
  };
  const manager = new DeviceInterconnectionManager(stateDir, env as unknown as EnvManager);
  return { manager, env, stateDir, stateFile: path.join(stateDir, "devices.json") };
}

function invitation(manager: DeviceInterconnectionManager) {
  const summary = manager.createMobileInvitation(metadata);
  const payload = decode(summary);
  return { summary, payload };
}

function decode(invite: MobileInvitation): MobileInvitationData {
  const encoded = new URL(invite.qrValue).searchParams.get("data")!;
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as MobileInvitationData;
}

function request(invite: MobileInvitationData): MobilePairingRequest {
  return {
    invitationId: invite.invitationId, invitationToken: invite.invitationToken,
    attemptId: randomUUID(), installationId: randomUUID(), deviceName: "Test Phone",
    info: { hostname: "test-phone", platform: "android", arch: "arm64", release: "16", cpu: "test-cpu", memoryBytes: 8 * 1024 ** 3, ips: ["192.0.2.20", "127.0.0.1"] },
  };
}

function fingerprints(profile: MobilePairingProfile): string[] {
  return [profile.clientToken, profile.envToken].map((value) => createHash("sha256").update(value).digest("hex"));
}

function status(run: () => unknown): { status: number; code: string } {
  try { run(); }
  catch (error) {
    expect(error).toBeInstanceOf(DeviceConnectionError);
    const failure = error as DeviceConnectionError;
    return { status: failure.status, code: failure.code };
  }
  throw new Error("Expected the operation to reject");
}

describe("mobile device pairing", () => {
  it("encodes only short-lived pairing metadata and hashes recovery secrets in the same state file", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const { summary, payload } = invitation(f.manager);
    expect(Object.keys(summary).sort()).toEqual(["deviceId", "expiresAt", "id", "qrValue"]);
    expect(payload.kind).toBe("moco.mobile.invite");
    expect(payload.version).toBe(1);
    expect(payload.hubId).toBe(f.manager.hubId);
    expect(payload.invitationId).toBe(summary.id);
    expect(payload.candidates).toEqual(metadata.candidates);
    expect(Object.keys(payload).some((key) => /clientToken|envToken|installationId|attemptId/.test(key))).toBe(false);
    const input = request(payload);
    const profile = f.manager.pairMobile(input);
    expect(profile.deviceId).toBe(summary.deviceId);
    expect(profile.name).toBe(input.deviceName);
    expect(profile.clientToken === profile.envToken).toBe(false);
    const state = fs.readFileSync(f.stateFile, "utf8");
    for (const value of [input.invitationToken, input.installationId, input.attemptId]) expect(state.includes(value)).toBe(false);
    const stored = JSON.parse(state);
    expect(stored.devices.length).toBe(1);
    expect(stored.mobileInvitations[0].binding.pairedAt).toBe(profile.pairedAt);
    expect(stored.devices[0].info.ips).toEqual(["192.0.2.20"]);
    if (process.platform !== "win32") expect(fs.statSync(f.stateFile).mode & 0o777).toBe(0o600);
  });

  it("preserves an unclaimed mobile invitation through Hub restart", () => {
    const first = fixture();
    first.manager.setEnabled(true);
    const { payload } = invitation(first.manager);
    const restarted = fixture(first.stateDir);
    expect(restarted.manager.hubId).toBe(first.manager.hubId);
    const profile = restarted.manager.pairMobile(request(payload));
    expect(profile.deviceId).toBe(payload.deviceId);
    expect(restarted.env.setDeviceCredential).toHaveBeenCalledWith(profile.deviceId, expect.any(String));
  });

  it("does not claim an invitation or create a device when the current Hub identity differs", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const input = request(invitation(f.manager).payload);
    const original = fs.readFileSync(f.stateFile, "utf8");
    expect(status(() => f.manager.pairMobile(input, "b".repeat(64)))).toEqual({ status: 409, code: "mobile_identity_changed" });
    expect(fs.readFileSync(f.stateFile, "utf8") === original).toBe(true);
    const unchanged = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
    expect(unchanged.devices.length).toBe(0);
    expect(unchanged.mobileInvitations[0].binding).toBeUndefined();
    const profile = f.manager.pairMobile(input, metadata.spkiSHA256);
    expect(profile.spkiSHA256).toBe(metadata.spkiSHA256);
    expect(profile.deviceId).toBe(unchanged.mobileInvitations[0].deviceId);
  });

  it("checks the current Hub identity before recovering a previous pairing response", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const input = request(invitation(f.manager).payload);
    const first = f.manager.pairMobile(input, metadata.spkiSHA256);
    const restarted = fixture(f.stateDir);
    const original = fs.readFileSync(f.stateFile, "utf8");
    expect(status(() => restarted.manager.pairMobile(input, "b".repeat(64)))).toEqual({ status: 409, code: "mobile_identity_changed" });
    expect(fs.readFileSync(f.stateFile, "utf8") === original).toBe(true);
    expect(fingerprints(restarted.manager.pairMobile(input, metadata.spkiSHA256))).toEqual(fingerprints(first));
    expect(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).devices.length).toBe(1);
  });

  it("recovers the same device and credentials for an exact private binding even after restart", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const input = request(invitation(f.manager).payload);
    const first = f.manager.pairMobile(input);
    const again = f.manager.pairMobile({ ...input, deviceName: "Different retry label" });
    expect(fingerprints(again)).toEqual(fingerprints(first));
    expect(again.deviceId).toBe(first.deviceId);
    expect(again.name).toBe(first.name);
    expect(again.pairedAt).toBe(first.pairedAt);
    const restarted = fixture(f.stateDir);
    expect(fingerprints(restarted.manager.pairMobile(input))).toEqual(fingerprints(first));
    expect(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).devices.length).toBe(1);
  });

  it("requires the original invitation token, installation secret and attempt secret for recovery", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const input = request(invitation(f.manager).payload);
    f.manager.pairMobile(input);
    expect(status(() => f.manager.pairMobile({ ...input, invitationToken: "z".repeat(43) })).status).toBe(401);
    expect(status(() => f.manager.pairMobile({ ...input, installationId: randomUUID() }))).toEqual({ status: 409, code: "mobile_pairing_conflict" });
    expect(status(() => f.manager.pairMobile({ ...input, attemptId: randomUUID() }))).toEqual({ status: 409, code: "mobile_pairing_conflict" });
    expect(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).devices.length).toBe(1);
  });

  it("expires first claims in ten minutes and recovery in twenty-four hours without extending on retry", () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    f.manager.setEnabled(true);
    const expired = request(invitation(f.manager).payload);
    now += MOBILE_INVITATION_TTL_MS;
    expect(status(() => f.manager.pairMobile(expired))).toEqual({ status: 401, code: "mobile_invitation_expired" });
    const input = request(invitation(f.manager).payload);
    const profile = f.manager.pairMobile(input);
    now += MOBILE_INVITATION_TTL_MS + 1;
    expect(fingerprints(f.manager.pairMobile(input))).toEqual(fingerprints(profile));
    now = profile.pairedAt + MOBILE_PAIRING_RECOVERY_TTL_MS;
    expect(status(() => f.manager.pairMobile(input))).toEqual({ status: 401, code: "mobile_recovery_expired" });
    expect(f.manager.authenticateClient(profile.clientToken)).toBe(profile.deviceId);
  });

  it("rejects recovery while interconnection is disabled and never resurrects a removed device", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const input = request(invitation(f.manager).payload);
    const profile = f.manager.pairMobile(input);
    f.manager.setEnabled(false);
    expect(status(() => f.manager.pairMobile(input)).status).toBe(403);
    expect(f.manager.authenticateClient(profile.clientToken)).toBeUndefined();
    expect(f.manager.authenticateEnv(profile.envToken)).toBeUndefined();
    f.manager.setEnabled(true);
    expect(fingerprints(f.manager.pairMobile(input))).toEqual(fingerprints(profile));
    f.manager.remove(profile.deviceId);
    const restarted = fixture(f.stateDir);
    expect(status(() => restarted.manager.pairMobile(input)).status).toBeGreaterThanOrEqual(400);
    expect(restarted.manager.authenticateClient(profile.clientToken)).toBeUndefined();
    expect(restarted.manager.authenticateEnv(profile.envToken)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).devices.length).toBe(0);
  });

  it("cancels pending invitations but does not remove a paired device when the QR dialog closes", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const pending = invitation(f.manager);
    f.manager.cancelMobileInvitation(pending.summary.id);
    expect(status(() => f.manager.pairMobile(request(pending.payload))).status).toBe(401);
    const paired = invitation(f.manager);
    const input = request(paired.payload);
    const profile = f.manager.pairMobile(input);
    f.manager.cancelMobileInvitation(paired.summary.id);
    expect(fingerprints(f.manager.pairMobile(input))).toEqual(fingerprints(profile));
    expect(f.manager.authenticateClient(profile.clientToken)).toBe(profile.deviceId);
  });

  it("invalidates pending invitations when interconnection is disabled", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const input = request(invitation(f.manager).payload);
    f.manager.setEnabled(false);
    f.manager.setEnabled(true);
    expect(status(() => f.manager.pairMobile(input)).status).toBe(401);
    expect(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).devices.length).toBe(0);
  });

  it("returns current public connection metadata without credentials or recovery secrets", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const input = request(invitation(f.manager).payload);
    const profile = f.manager.pairMobile(input);
    f.manager.rename(profile.deviceId, "Renamed Phone");
    const current = f.manager.mobileProfile(profile.deviceId, { ...metadata, hubId: f.manager.hubId, hubName: "Renamed Hub" });
    expect(current.hubId).toBe(f.manager.hubId);
    expect(current.hubName).toBe("Renamed Hub");
    expect(current.name).toBe("Renamed Phone");
    expect(Object.keys(current).sort()).toEqual(["candidates", "deviceId", "hubId", "hubName", "name", "pairedAt", "spkiSHA256", "version"]);
    const publicText = JSON.stringify(current);
    for (const secret of [profile.clientToken, profile.envToken, input.invitationToken, input.installationId, input.attemptId]) expect(publicText.includes(secret)).toBe(false);
    expect(status(() => f.manager.mobileProfile(profile.deviceId, { ...metadata, hubId: randomUUID() })).code).toBe("mobile_identity_mismatch");
    current.candidates.length = 0;
    expect(f.manager.pairMobile(input).candidates.length).toBe(2);
  });

  it("keeps client and Env authentication separate and supports legacy desktop pairing", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const mobile = f.manager.pairMobile(request(invitation(f.manager).payload));
    expect(f.manager.authenticateClient(mobile.clientToken)).toBe(mobile.deviceId);
    expect(f.manager.authenticateEnv(mobile.envToken)).toBe(mobile.deviceId);
    expect(f.manager.authenticateClient(mobile.envToken)).toBeUndefined();
    expect(f.manager.authenticateEnv(mobile.clientToken)).toBeUndefined();
    const legacy = f.manager.createInvitation({ hubUrl: "http://192.0.2.10:7788" });
    const info = { hostname: "test-desktop", platform: "linux", arch: "x64", release: "test", cpu: "cpu", memoryBytes: 1024, ips: [] };
    const desktop = f.manager.pair({ inviteToken: legacy.inviteToken, info });
    expect(desktop.version).toBe(1);
    expect(f.manager.authenticateClient(desktop.clientToken)).toBe(desktop.deviceId);
    expect(f.manager.authenticateEnv(desktop.envToken)).toBe(desktop.deviceId);
    expect(status(() => f.manager.mobileProfile(desktop.deviceId, metadata)).status).toBe(404);
  });

  it("validates connection metadata and private request identifiers", () => {
    const f = fixture();
    expect(status(() => f.manager.createMobileInvitation(metadata)).status).toBe(403);
    f.manager.setEnabled(true);
    for (const origin of ["http://192.0.2.10:7789", "https://user:password@example.invalid", "https://example.invalid/path", "https://example.invalid/?token=redacted"]) {
      expect(status(() => f.manager.createMobileInvitation({ ...metadata, candidates: [{ route: "lan", origin }] })).status).toBe(400);
    }
    expect(status(() => f.manager.createMobileInvitation({ ...metadata, spkiSHA256: "not-a-fingerprint" })).status).toBe(400);
    expect(status(() => f.manager.createMobileInvitation({ ...metadata, hubId: randomUUID() })).code).toBe("mobile_identity_mismatch");
    const input = request(invitation(f.manager).payload);
    expect(status(() => f.manager.pairMobile({ ...input, attemptId: "not-a-private-uuid" })).status).toBe(400);
    expect(status(() => f.manager.pairMobile({ ...input, installationId: "not-a-private-uuid" })).status).toBe(400);
    expect(status(() => f.manager.pairMobile({ ...input, info: {} })).status).toBe(400);
  });

  it("does not consume an invitation or mutate the live device list when durable commit fails", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const input = request(invitation(f.manager).payload);
    const original = fs.readFileSync(f.stateFile, "utf8");
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("simulated state commit failure"); });
    expect(() => f.manager.pairMobile(input)).toThrow("simulated state commit failure");
    rename.mockRestore();
    expect(fs.readFileSync(f.stateFile, "utf8") === original).toBe(true);
    const profile = f.manager.pairMobile(input);
    expect(f.manager.authenticateClient(profile.clientToken)).toBe(profile.deviceId);
    expect(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).devices.length).toBe(1);
    expect(fs.readdirSync(f.stateDir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("rejects corrupt mobile invitation state on restart", () => {
    const f = fixture();
    f.manager.setEnabled(true);
    invitation(f.manager);
    const state = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
    state.mobileInvitations[0].tokenHash = "invalid";
    fs.writeFileSync(f.stateFile, JSON.stringify(state));
    expect(() => fixture(f.stateDir)).toThrow("设备互联配置已损坏");
  });
});
