import { createHash } from "node:crypto";
import path from "node:path";
import type { DevicePeerConfig } from "@moco/protocol";
import { discoverLocalInstance, LocalInstanceInUseError, LocalInstanceOwner, type LocalInstanceFiles } from "./local-instance.js";
import { getPeerConfigPath, localPeerProof, localPeerProxyToken } from "./peer-config.js";

function peerFiles(config: DevicePeerConfig, configPath: string): LocalInstanceFiles {
  const filename = path.resolve(configPath);
  // Embedded callers may run different device identities in the same installation.
  const id = createHash("sha256").update(JSON.stringify([path.basename(filename), config.deviceId, config.hubUrl])).digest("hex").slice(0, 32);
  return { directory: path.dirname(filename), name: "peer-" + id, identity: localPeerProof(config, "instance-owner") };
}

export class DevicePeerInUseError extends LocalInstanceInUseError {}

export function claimDevicePeer(config: DevicePeerConfig, configPath: string): LocalInstanceOwner {
  try { return LocalInstanceOwner.acquire(peerFiles(config, configPath), "这台 Moco 设备客户端已在运行。"); }
  catch (error) {
    if (error instanceof LocalInstanceInUseError) throw new DevicePeerInUseError(error.directory, error.message);
    throw error;
  }
}

export function discoverDevicePeer(config: DevicePeerConfig, localToken?: string, configPath = getPeerConfigPath()) {
  const token = localToken?.trim() || localPeerProxyToken(config);
  return discoverLocalInstance(peerFiles(config, configPath), "/_moco/instance", token);
}
