import type { DeviceSystemInfo } from "./devices.js";

export interface MobileConnectionCandidate {
  route: "lan" | "tailscale";
  origin: string;
}

export interface MobileConnectionMetadata {
  /** When supplied, it must match the Hub that owns the device record. */
  hubId?: string;
  hubName: string;
  spkiSHA256: string;
  candidates: MobileConnectionCandidate[];
}

export interface MobileInvitationData {
  kind: "kulo.mobile.invite";
  version: 1;
  hubId: string;
  hubName: string;
  invitationId: string;
  invitationToken: string;
  deviceId: string;
  expiresAt: number;
  spkiSHA256: string;
  candidates: MobileConnectionCandidate[];
}

/** The QR value contains a short-lived private invitation. Do not put it in device lists or logs. */
export interface MobileInvitation {
  id: string;
  deviceId: string;
  expiresAt: number;
  qrValue: string;
}

export interface MobilePairingRequest {
  invitationId: string;
  invitationToken: string;
  /** Private random UUIDs, persisted on the phone before making its first pairing request. */
  attemptId: string;
  installationId: string;
  deviceName: string;
  info: DeviceSystemInfo;
}

export interface MobilePublicProfile {
  version: 1;
  hubId: string;
  hubName: string;
  spkiSHA256: string;
  deviceId: string;
  name: string;
  candidates: MobileConnectionCandidate[];
  pairedAt: number;
}

/** Pairing response and phone-private storage only. Never return this through public metadata APIs. */
export interface MobilePairingProfile extends MobilePublicProfile {
  clientToken: string;
  envToken: string;
}
