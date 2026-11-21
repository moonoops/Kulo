import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { DeviceSystemInfo } from "@kulo/protocol";
import { collectDeviceIps } from "./device-network.js";

const GENERIC_DMI_MODELS = new Set([
  "system product name",
  "to be filled by o.e.m.",
  "default string",
  "not specified",
  "none",
  "unknown",
]);

let cachedHardwareModel: string | null | undefined;

function sanitizeHardwareModel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 256) return undefined;
  if (GENERIC_DMI_MODELS.has(cleaned.toLowerCase())) return undefined;
  return cleaned;
}

function runQuery(command: string, args: readonly string[], timeout: number): string | undefined {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

export function parseMacHardwareModelOutput(sources: {
  ioregProduct?: string;
  systemProfiler?: string;
  sysctlHwModel?: string;
}): string | undefined {
  const ioregMatch = sources.ioregProduct?.match(/"product-name"\s*=\s*<"([^"]+)">/i)?.[1];
  const fromIoreg = sanitizeHardwareModel(ioregMatch);
  if (fromIoreg) return fromIoreg;

  const profilerMatch = sources.systemProfiler?.match(/^\s*Model Name:\s*(.+)$/im)?.[1];
  const fromProfiler = sanitizeHardwareModel(profilerMatch);
  if (fromProfiler) return fromProfiler;

  return sanitizeHardwareModel(sources.sysctlHwModel);
}

function detectHardwareModel(): string | undefined {
  if (cachedHardwareModel !== undefined) return cachedHardwareModel ?? undefined;
  let detected: string | undefined;
  if (process.platform === "darwin") {
    const ioregProduct = runQuery("ioreg", ["-r", "-d", "2", "-n", "product"], 1500);
    detected = parseMacHardwareModelOutput({ ioregProduct });
    if (!detected) {
      const systemProfiler = runQuery("system_profiler", ["SPHardwareDataType"], 2500);
      detected = parseMacHardwareModelOutput({ systemProfiler });
    }
    if (!detected) {
      const sysctlHwModel = runQuery("sysctl", ["-n", "hw.model"], 1000);
      detected = parseMacHardwareModelOutput({ sysctlHwModel });
    }
  } else if (process.platform === "linux") {
    try {
      detected = sanitizeHardwareModel(fs.readFileSync("/sys/devices/virtual/dmi/id/product_name", "utf8"));
    } catch {
      detected = undefined;
    }
  }
  cachedHardwareModel = detected ?? null;
  return detected;
}

export function collectDeviceSystemInfo(): DeviceSystemInfo {
  const ips = collectDeviceIps();
  const model = detectHardwareModel();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpu: os.cpus()[0]?.model ?? "",
    memoryBytes: os.totalmem(),
    ips,
    ...(model ? { model } : {}),
  };
}
