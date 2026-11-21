import { createHash } from "node:crypto";
import path from "node:path";
import type { DevicePeerConfig } from "@kulo/protocol";
import { discoverLocalInstance, LocalInstanceInUseError, LocalInstanceOwner, type LocalInstanceFiles } from "./local-instance.js";
import { getPeerConfigPath, localPeerProof, localPeerProxyToken } from "./peer-config.js";

function peerFiles(config: DevicePeerConfig, configPath: string): LocalInstanceFiles {
  const filename = path.resolve(configPath);
  // Embedded callers may run different device identities in the same installation.
  // Cluster-aware peers key the single-instance lock on immutable cluster hubId rather than mutable hubUrl.
  const scope = config.cluster?.hubId
    ? [path.basename(filename), config.cluster.hubId, config.deviceId, path.resolve(config.rootDir)]
    : [path.basename(filename), config.deviceId, config.hubUrl];
  const id = createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 32);
  return { directory: path.dirname(filename), name: "peer-" + id, identity: localPeerProof(config, "instance-owner") };
}

export class DevicePeerInUseError extends LocalInstanceInUseError {}

export function claimDevicePeer(config: DevicePeerConfig, configPath: string): LocalInstanceOwner {
  try { return LocalInstanceOwner.acquire(peerFiles(config, configPath), "这台 Kulo 设备客户端已在运行。"); }
  catch (error) {
    if (error instanceof LocalInstanceInUseError) throw new DevicePeerInUseError(error.directory, error.message);
    throw error;
  }
}

function legacyPeerFiles(config: DevicePeerConfig, configPath: string): LocalInstanceFiles {
  const filename = path.resolve(configPath);
  const id = createHash("sha256").update(JSON.stringify([path.basename(filename), config.deviceId, config.hubUrl])).digest("hex").slice(0, 32);
  const legacyConfig: DevicePeerConfig = { ...config, cluster: undefined };
  return { directory: path.dirname(filename), name: "peer-" + id, identity: localPeerProof(legacyConfig, "instance-owner") };
}

export async function discoverDevicePeer(config: DevicePeerConfig, localToken?: string, configPath = getPeerConfigPath()) {
  const token = localToken?.trim() || localPeerProxyToken(config);
  const primary = await discoverLocalInstance(peerFiles(config, configPath), "/_kulo/instance", token);
  if (primary || !config.cluster?.hubId) return primary;
  const legacyToken = localToken?.trim() || localPeerProxyToken({ ...config, cluster: undefined });
  return discoverLocalInstance(legacyPeerFiles(config, configPath), "/_kulo/instance", legacyToken);
}
