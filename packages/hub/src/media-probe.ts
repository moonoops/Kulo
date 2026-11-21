import { execFile } from "node:child_process";
import { buildAugmentedHostPath } from "./host-path.js";

export type UploadKind = "image" | "audio" | "video" | "file";

export interface MediaMetadata {
  kind: UploadKind;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
  metadataStatus: "ready" | "unavailable";
}

const finitePositive = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

function dimensions(width: number, height: number): Pick<MediaMetadata, "width" | "height"> {
  return width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : {};
}

function jpegDimensions(bytes: Buffer): Pick<MediaMetadata, "width" | "height"> {
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      return dimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    offset += length + 2;
  }
  return {};
}

/** A declared MIME only describes ordinary files; inline media requires a matching signature. */
export function inspectMediaPrefix(bytes: Buffer, declaredMime = "application/octet-stream", totalBytes?: number): MediaMetadata {
  const file = (mimeType = declaredMime): MediaMetadata => ({ kind: "file", mimeType, metadataStatus: "ready" });
  const media = (kind: UploadKind, mimeType: string, extra: Partial<MediaMetadata> = {}): MediaMetadata => ({ kind, mimeType, metadataStatus: "unavailable", ...extra });
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") {
    const size = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    return media("image", "image/png", { ...size, metadataStatus: size.width ? "ready" : "unavailable" });
  }
  if (bytes.length >= 10 && /^(GIF87a|GIF89a)$/.test(bytes.toString("ascii", 0, 6))) {
    const size = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
    return media("image", "image/gif", { ...size, metadataStatus: size.width ? "ready" : "unavailable" });
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegDimensions(bytes);
    return media("image", "image/jpeg", { ...size, metadataStatus: size.width ? "ready" : "unavailable" });
  }
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    let size: Pick<MediaMetadata, "width" | "height"> = {};
    const format = bytes.toString("ascii", 12, 16);
    if (format === "VP8X" && bytes.length >= 30) size = dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
    else if (format === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      size = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else if (format === "VP8 " && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      size = dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    }
    return media("image", "image/webp", { ...size, metadataStatus: size.width ? "ready" : "unavailable" });
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    let offset = 12;
    let byteRate = 0;
    let duration: number | undefined;
    while (offset + 8 <= bytes.length) {
      const name = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      if (name === "fmt " && length >= 16 && offset + 24 <= bytes.length) byteRate = bytes.readUInt32LE(offset + 16);
      if (name === "data" && byteRate > 0 && (totalBytes === undefined || offset + 8 + length <= totalBytes)) duration = length / byteRate;
      if (length > bytes.length - offset - 8) break;
      offset += 8 + length + (length % 2);
    }
    return media("audio", "audio/wav", duration !== undefined && duration > 0 ? { duration, metadataStatus: "ready" } : {});
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(bytes.toString("ascii", 8, 12))) return media("audio", "audio/aiff");
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "fLaC") return media("audio", "audio/flac");
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") {
    const isVideo = bytes.includes(Buffer.from("theora"));
    return media(isVideo ? "video" : "audio", isVideo ? "video/ogg" : "audio/ogg");
  }
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") return media("audio", "audio/mpeg");
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return media("audio", "audio/aac");
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x18) !== 0x08 && (bytes[1]! & 0x06) !== 0) return media("audio", "audio/mpeg");
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const brand = bytes.toString("ascii", 8, 12);
    const isAudio = ["M4A ", "M4B ", "M4P "].includes(brand);
    return media(isAudio ? "audio" : "video", brand === "qt  " ? "video/quicktime" : isAudio ? "audio/mp4" : "video/mp4");
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    const webm = bytes.includes(Buffer.from("webm"));
    const audioOnly = (bytes.includes(Buffer.from("A_OPUS")) || bytes.includes(Buffer.from("A_VORBIS"))) && !bytes.includes(Buffer.from("V_"));
    return media(audioOnly ? "audio" : "video", webm ? audioOnly ? "audio/webm" : "video/webm" : "video/x-matroska");
  }
  const text = bytes.toString("utf8", 0, Math.min(bytes.length, 4096)).trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text)) return file("image/svg+xml");
  if (/^(?:<!doctype\s+html|<html(?:\s|>))/i.test(text)) return file("text/html");
  if (declaredMime.startsWith("image/") || declaredMime.startsWith("audio/") || declaredMime.startsWith("video/")) return file("application/octet-stream");
  return file();
}

/** ffprobe is optional. Its absence or a decode error never fabricates duration or codec support. */
export async function probeMediaFile(filePath: string, basic: MediaMetadata): Promise<MediaMetadata> {
  if (basic.kind === "file" || basic.kind === "image") return basic;
  const result = await new Promise<string | null>((resolve) => {
    execFile("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-max_alloc", "16777216", "-analyzeduration", "1000000", "-probesize", "1048576", "-show_entries", "stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic:format=duration", "-of", "json", filePath], {
      timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8",
      env: { ...process.env, PATH: buildAugmentedHostPath() },
    }, (error, stdout) => resolve(error ? null : stdout));
  });
  if (result === null) return basic;
  let parsed: { streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string; disposition?: { attached_pic?: number } }>; format?: { duration?: string } };
  try { parsed = JSON.parse(result); } catch { return { ...basic, metadataStatus: "unavailable" }; }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  if (!video && !audio) return { ...basic, metadataStatus: "unavailable" };
  const kind = video ? "video" : "audio";
  const mimeType = kind === "audio" && basic.mimeType === "video/mp4" ? "audio/mp4" : kind === "audio" && basic.mimeType === "video/webm" ? "audio/webm" : basic.mimeType;
  const duration = finitePositive(parsed.format?.duration) ?? finitePositive(video?.duration) ?? finitePositive(audio?.duration);
  return {
    ...basic, kind, mimeType,
    ...(video ? dimensions(video.width ?? 0, video.height ?? 0) : {}),
    ...(duration === undefined ? {} : { duration }),
    metadataStatus: "ready",
  };
}
