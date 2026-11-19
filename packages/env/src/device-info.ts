import os from "node:os";
import type { DeviceSystemInfo } from "@kulo/protocol";
import { collectDeviceIps } from "./device-network.js";

export function collectDeviceSystemInfo(): DeviceSystemInfo {
  const ips = collectDeviceIps();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpu: os.cpus()[0]?.model ?? "",
    memoryBytes: os.totalmem(),
    ips,
  };
}
