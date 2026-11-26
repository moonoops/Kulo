import { afterEach, describe, expect, it } from "vitest";
import {
  describeKuloError,
  isVerifiedImageBinaryPayload,
  isVerifiedImageContainerValue,
  isVerifiedImageDataUrl,
  MAX_VERIFIED_IMAGE_BYTES,
  VISION_IMAGE_MIMES,
} from "@kulo/protocol";
import { describeLocalizedKuloError } from "../packages/web/src/kulo-error.js";
import { setLanguage } from "../packages/web/src/kulo-i18n.js";

function makePng(width = 8, height = 8, extraTail: number[] = []): string {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, iend, Buffer.from(extraTail)]).toString("base64");
}

function makeJpeg(extraTail: number[] = []): string {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ...extraTail,
  ]);
  return bytes.toString("base64");
}

function makeGif(version: "87a" | "89a" = "89a", width = 4, height = 4, extraTail: number[] = []): string {
  const buf = Buffer.alloc(14 + extraTail.length);
  buf.write(`GIF${version}`, 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  buf[13] = 0x3b;
  for (let i = 0; i < extraTail.length; i++) buf[14 + i] = extraTail[i]!;
  return buf.toString("base64");
}

function makeWebp(kind: "VP8 " | "VP8L" | "VP8X", oddPad = false): string {
  let subChunk: Buffer;
  if (kind === "VP8 ") {
    const body = Buffer.alloc(15, 0x11);
    body[3] = 0x9d;
    body[4] = 0x01;
    body[5] = 0x2a;
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length, 0);
    subChunk = Buffer.concat([Buffer.from("VP8 ", "ascii"), len, body]);
  } else if (kind === "VP8L") {
    const body = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0xaa, 0xbb]);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length, 0);
    subChunk = Buffer.concat([Buffer.from("VP8L", "ascii"), len, body]);
  } else {
    const body = Buffer.alloc(10, 0x00);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(10, 0);
    subChunk = Buffer.concat([Buffer.from("VP8X", "ascii"), len, body]);
  }
  const riffPayload = Buffer.concat([Buffer.from("WEBP", "ascii"), subChunk]);
  const riffLen = Buffer.alloc(4);
  // Optionally test odd RIFF chunkSize with 1 trailing alignment pad byte
  riffLen.writeUInt32LE(riffPayload.length, 0);
  const tail = oddPad && riffPayload.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), riffLen, riffPayload, tail]).toString("base64");
}

describe("image-payload structural verification", () => {
  it("whitelists only raster vision MIMEs and strictly excludes SVG", () => {
    for (const mime of ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]) {
      expect(VISION_IMAGE_MIMES.has(mime)).toBe(true);
    }
    expect(VISION_IMAGE_MIMES.has("image/svg+xml")).toBe(false);
    expect(VISION_IMAGE_MIMES.has("image/heic")).toBe(false);
    expect(VISION_IMAGE_MIMES.has("image/bmp")).toBe(false);
  });

  it("verifies PNG, JPEG, GIF87a/89a, and WebP VP8/VP8L/VP8X including zero-byte tail padding and browser MIME/magic mismatch", () => {
    const png = makePng();
    const pngZeroPad = makePng(16, 16, [0x00, 0x00, 0x00, 0x00]);
    const jpeg = makeJpeg();
    const jpegZeroPad = makeJpeg([0x00, 0x00]);
    const gif87 = makeGif("87a");
    const gif89 = makeGif("89a", 10, 20, [0x00]);
    const webpVp8 = makeWebp("VP8 ", true);
    const webpVp8l = makeWebp("VP8L", true);
    const webpVp8x = makeWebp("VP8X");

    for (const sample of [png, pngZeroPad, jpeg, jpegZeroPad, gif87, gif89, webpVp8, webpVp8l, webpVp8x]) {
      expect(isVerifiedImageBinaryPayload(sample)).toBe(true);
    }
    // Browser MIME/magic mismatch among the 4 raster types is tolerated
    expect(isVerifiedImageBinaryPayload(png, "image/jpeg")).toBe(true);
    expect(isVerifiedImageDataUrl(`data:image/jpeg;base64,${png}`)).toBe(true);
    expect(isVerifiedImageDataUrl(`data:image/jpg;base64,${jpeg}`)).toBe(true);
    expect(isVerifiedImageDataUrl(`data:image/webp;base64,${webpVp8l}`)).toBe(true);
    expect(isVerifiedImageDataUrl(`data:image/gif;base64,${gif89}`)).toBe(true);
  });

  it("rejects forged headers, zero dimensions, post-trailer payloads, SVG, non-base64 strings, and >20 MiB payloads", () => {
    const png = makePng();
    expect(isVerifiedImageBinaryPayload(makePng(0, 8), "image/png")).toBe(false);
    expect(isVerifiedImageBinaryPayload(makePng(8, 0), "image/png")).toBe(false);
    expect(isVerifiedImageBinaryPayload(makeGif("89a", 0, 4), "image/gif")).toBe(false);
    // Forged PNG header without IEND
    const headerOnly = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x73, 0x6b, 0x2d, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x31, 0x32, 0x33, 0x34,
    ]).toString("base64");
    expect(isVerifiedImageBinaryPayload(headerOnly, "image/png")).toBe(false);
    // Non-zero bytes appended after IEND / EOI / GIF trailer
    expect(isVerifiedImageBinaryPayload(makePng(8, 8, [0x73, 0x6b]), "image/png")).toBe(false);
    expect(isVerifiedImageBinaryPayload(makeJpeg([0x41, 0x42]), "image/jpeg")).toBe(false);
    expect(isVerifiedImageBinaryPayload(makeGif("89a", 4, 4, [0x41]), "image/gif")).toBe(false);
    // WebP size mismatch
    const badWebp = Buffer.concat([Buffer.from(makeWebp("VP8X"), "base64"), Buffer.from([0x01, 0x02, 0x03])]).toString("base64");
    expect(isVerifiedImageBinaryPayload(badWebp, "image/webp")).toBe(false);
    // SVG rejected even with valid PNG bytes or SVG bytes
    expect(isVerifiedImageBinaryPayload(png, "image/svg+xml")).toBe(false);
    expect(isVerifiedImageDataUrl(`data:image/svg+xml;base64,${png}`)).toBe(false);
    expect(isVerifiedImageDataUrl(`data:image/png;base64,[消息过长，敏感内容已隐藏]`)).toBe(false);
    // Invalid base64 charset / padding
    expect(isVerifiedImageBinaryPayload(`${png.slice(0, 20)}!${png.slice(21)}`, "image/png")).toBe(false);
    expect(isVerifiedImageBinaryPayload(png.slice(0, -1), "image/png")).toBe(false);
    // Exceeds 20 MiB limit
    const overLimit = "A".repeat(Math.ceil((MAX_VERIFIED_IMAGE_BYTES + 3) / 3) * 4);
    expect(isVerifiedImageBinaryPayload(overLimit, "image/png")).toBe(false);
  });

  it("matches all supported internal and provider wire image containers", () => {
    const png = makePng();
    const url = `data:image/png;base64,${png}`;
    expect(isVerifiedImageContainerValue({ type: "image", mimeType: "image/png", data: png }, "data", png)).toBe(true);
    expect(isVerifiedImageContainerValue({ type: "base64", media_type: "image/png", data: png }, "data", png)).toBe(true);
    expect(isVerifiedImageContainerValue({ mimeType: "image/png", data: png }, "data", png)).toBe(true);
    expect(isVerifiedImageContainerValue({ type: "image", mime_type: "image/png", data: png }, "data", png)).toBe(true);
    expect(isVerifiedImageContainerValue({ type: "image", format: "png", data_base64: png }, "data_base64", png)).toBe(true);
    expect(isVerifiedImageContainerValue({ type: "input_image", image_url: url }, "image_url", url)).toBe(true);
    expect(isVerifiedImageContainerValue({ type: "image_url", imageUrl: url }, "imageUrl", url)).toBe(true);
    expect(isVerifiedImageContainerValue({ url }, "url", url)).toBe(true);
    expect(isVerifiedImageContainerValue([url], "images", url)).toBe(true);

    // Non-image container keys are never exempted
    expect(isVerifiedImageContainerValue({ type: "text", text: url }, "text", url)).toBe(false);
    expect(isVerifiedImageContainerValue({ type: "image", format: "svg", data_base64: png }, "data_base64", png)).toBe(false);
  });
});

describe("image error classification & bilingual parity", () => {
  afterEach(() => {
    setLanguage("zh");
  });

  it("classifies real T-0055 400 base64 error and provider payload/size/decode errors as image_payload_invalid without suggesting model switch", () => {
    const realT0055 = describeKuloError({
      reason: "model_error",
      detail:
        '400 {"error":{"message":"Invalid value: \'data:image/png;base64,[消息过长，敏感内容已隐藏]\'. Expected a base64-encoded image with a supported MIME type.","type":"invalid_request_error","param":"input","code":"invalid_value"}}',
      modelId: "gpt-5.4",
    });
    expect(realT0055.kind).toBe("image_payload_invalid");
    expect(realT0055.statusCode).toBe(400);
    expect(realT0055.suggestModelSettings).toBe(false);
    expect(realT0055.retryable).toBe(true);
    expect(realT0055.hint).toContain("无需切换模型");
    expect(realT0055.hint).not.toContain("模型设置");

    const cases = [
      '400 {"error":{"message":"Invalid base64 image_url.","type":"invalid_request_error","code":"invalid_value"}}',
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64.data: Image exceeds 5 MB maximum: 6123456 bytes > 5242880 bytes"}}',
      "400 invalid image input: could not decode",
      "400 Unsupported image format: image/bmp",
      "413 Image is too large",
      "400 Error while downloading image_url: url is not accessible",
      "422 Invalid image provided in request",
    ];
    for (const detail of cases) {
      const desc = describeKuloError({ reason: "model_error", detail });
      expect(desc.kind, detail).toBe("image_payload_invalid");
      expect(desc.suggestModelSettings, detail).toBe(false);
    }
  });

  it("does not misclassify non-image 400 errors or broad standalone image/vision/multimodal mentions", () => {
    const nonImageInvalidValue = describeKuloError({
      reason: "model_error",
      detail: '400 {"error":{"message":"Invalid value for temperature: 3.5","code":"invalid_value"}}',
    });
    expect(nonImageInvalidValue.kind).toBe("unknown");

    const nonImageMax = describeKuloError({
      reason: "model_error",
      detail: "400 max_tokens exceeds maximum of 8192",
    });
    expect(nonImageMax.kind).toBe("unknown");

    const standaloneVision = describeKuloError({
      reason: "model_error",
      detail: "400 vision pipeline temporary failure on shard 2",
    });
    expect(standaloneVision.kind).not.toBe("multimodal_unsupported");

    const standaloneMultimodal = describeKuloError({
      reason: "model_error",
      detail: "400 multimodal request missing required field messages",
    });
    expect(standaloneMultimodal.kind).not.toBe("multimodal_unsupported");
  });

  it("still classifies genuine model capability errors as multimodal_unsupported with bilingual parity", () => {
    const capabilityCases = [
      "400 This model does not support image input.",
      "400 image_url is only supported by certain models.",
      "400 vision is not supported for this model",
      "400 No endpoints found that support image input",
      "400 unknown variant `image_url`, expected `text`",
      "400 当前模型不支持图片理解",
    ];
    for (const detail of capabilityCases) {
      const zh = describeKuloError({ reason: "model_error", detail });
      expect(zh.kind, detail).toBe("multimodal_unsupported");
      expect(zh.suggestModelSettings, detail).toBe(true);
    }

    setLanguage("en");
    const enPayload = describeLocalizedKuloError({
      reason: "model_error",
      detail: "400 Invalid base64 image_url",
    });
    expect(enPayload.kind).toBe("image_payload_invalid");
    expect(enPayload.title).toBe("Invalid or oversized image payload");
    expect(enPayload.hint).toContain("no need to switch models");
    expect(enPayload.suggestModelSettings).toBe(false);

    const enCapability = describeLocalizedKuloError({
      reason: "model_error",
      detail: "400 This model does not support image input.",
    });
    expect(enCapability.kind).toBe("multimodal_unsupported");
    expect(enCapability.title).toBe("This model does not support images");
    expect(enCapability.suggestModelSettings).toBe(true);
  });
});
