import crypto from "node:crypto";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import { parseMediaRange } from "../media-http.js";

const MAX_CLIPS = 8;
const MAX_CLIP_BYTES = 2 * 1024 * 1024;
const CLIP_TTL_MS = 60_000;
const CLIP_ID_RE = /^[a-f0-9]{64}$/;

const VIRTUAL_IFACE_PREFIXES = [
  "lo",
  "utun",
  "tun",
  "tap",
  "bridge",
  "docker",
  "veth",
  "awdl",
  "llw",
  "anpi",
  "ap",
  "stf",
  "gif",
  "vmnet",
  "vboxnet",
  "tailscale",
  "wg",
];

interface StoredClip {
  id: string;
  bytes: Buffer;
  mimeType: "audio/mpeg" | "audio/wav";
  expiresAt: number;
}

export function isRfc1918Ipv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function isDirectLanRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const clean = remoteAddress.toLowerCase().replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  if (clean === "127.0.0.1" || clean === "::1") return true;
  if (net.isIP(clean) === 4) return isRfc1918Ipv4(clean);
  if (net.isIP(clean) === 6) return clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe80:");
  return false;
}

export function isDirectLanHttpRequest(req: http.IncomingMessage): boolean {
  if (req.headers.forwarded || req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) {
    return false;
  }
  return isDirectLanRemoteAddress(req.socket.remoteAddress);
}

/**
 * Selects a physical RFC1918 LAN IPv4 address reachable by household Wi-Fi speakers (e.g. LX04).
 * Explicitly skips loopback, Tailscale (100.64/10), OrbStack/benchmark bridges (198.18/15),
 * link-local (169.254/16), and virtual tunnel/container interfaces.
 */
export function selectPhysicalLanIpv4(
  haBaseUrl?: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | undefined {
  let targetHost: string | undefined;
  if (haBaseUrl) {
    try {
      const parsed = new URL(haBaseUrl);
      const host = parsed.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(host) === 4 && isRfc1918Ipv4(host)) targetHost = host;
    } catch {
      // ignore invalid URL
    }
  }

  const candidates: Array<{ iface: string; address: string; score: number }> = [];
  for (const [ifaceName, list] of Object.entries(interfaces)) {
    if (!list) continue;
    const lowerName = ifaceName.toLowerCase();
    if (VIRTUAL_IFACE_PREFIXES.some((prefix) => lowerName.startsWith(prefix))) continue;
    for (const entry of list) {
      if (entry.internal || entry.family !== "IPv4") continue;
      if (!isRfc1918Ipv4(entry.address)) continue;
      let score = 0;
      if (lowerName === "en0" || lowerName === "eth0" || lowerName.startsWith("wlan") || lowerName.startsWith("wl")) {
        score += 10;
      }
      if (targetHost) {
        const a = entry.address.split(".");
        const b = targetHost.split(".");
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) score += 100;
        else if (a[0] === b[0] && a[1] === b[1]) score += 50;
      }
      candidates.push({ iface: ifaceName, address: entry.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.iface.localeCompare(b.iface));
  return candidates[0]?.address;
}

/**
 * Bounded, LAN-only ephemeral audio clip relay used for Kulo TTS playback on Home Assistant speakers
 * (`/_ha-tts/:clipId`), supporting GET, HEAD, and single byte Range requests without exposing Hub admin tokens.
 */
export class HaLanAudioRelay {
  readonly #clips = new Map<string, StoredClip>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? CLIP_TTL_MS;
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, clip] of this.#clips) {
      if (clip.expiresAt <= now) this.#clips.delete(id);
    }
  }

  store(bytes: Buffer, mimeType: "audio/mpeg" | "audio/wav"): string {
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_CLIP_BYTES) {
      throw new Error("播报音频大小超出限制。");
    }
    this.#prune();
    while (this.#clips.size >= MAX_CLIPS) {
      const oldest = this.#clips.keys().next().value;
      if (!oldest) break;
      this.#clips.delete(oldest);
    }
    const id = crypto.randomBytes(32).toString("hex");
    this.#clips.set(id, {
      id,
      bytes,
      mimeType,
      expiresAt: this.#now() + this.#ttlMs,
    });
    return id;
  }

  get(clipId: string): StoredClip | undefined {
    if (!CLIP_ID_RE.test(clipId)) return undefined;
    this.#prune();
    return this.#clips.get(clipId);
  }

  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, clipId: string): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "cache-control": "no-store" }).end();
      return;
    }
    if (!isDirectLanHttpRequest(req)) {
      res.writeHead(403, { "cache-control": "no-store" }).end();
      return;
    }
    const clip = this.get(clipId);
    if (!clip) {
      res.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }

    const size = clip.bytes.byteLength;
    const baseHeaders: Record<string, string> = {
      "content-type": clip.mimeType,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : undefined;
    if (rangeHeader !== undefined) {
      const range = parseMediaRange(rangeHeader, size);
      if (!range) {
        res.writeHead(416, { ...baseHeaders, "content-range": `bytes */${size}`, "content-length": "0" }).end();
        return;
      }
      const slice = clip.bytes.subarray(range.start, range.end + 1);
      res.writeHead(206, {
        ...baseHeaders,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "content-length": String(slice.byteLength),
      });
      res.end(req.method === "HEAD" ? undefined : slice);
      return;
    }

    res.writeHead(200, { ...baseHeaders, "content-length": String(size) });
    res.end(req.method === "HEAD" ? undefined : clip.bytes);
  }

  clear(): void {
    this.#clips.clear();
  }
}
