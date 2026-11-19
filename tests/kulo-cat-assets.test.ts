import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAT_APPEARANCES, CAT_SHEET_URLS, getCatAppearanceCrop } from "../packages/web/src/components/cat-catalog";

const directory = fileURLToPath(new URL("../packages/web/public/mascots/cat/", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));

function renderedSize(file: string, selector: string) {
  const css = fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  const block = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`))?.[1];
  expect(block).toBeDefined();
  const width = Number(block!.match(/\bwidth:\s*(\d+)px/)?.[1]);
  const height = Number(block!.match(/\bheight:\s*(\d+)px/)?.[1]);
  expect(width).toBe(height);
  return width;
}

function losslessDimensions(bytes: Buffer) {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (type === "VP8L") {
      expect(bytes[offset + 8]).toBe(0x2f);
      const bits = bytes.readUInt32LE(offset + 9);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    expect(type).not.toBe("VP8 ");
    offset += 8 + size + (size & 1);
  }
  throw new Error("Missing lossless WebP image data");
}

describe("cat companion runtime artwork", () => {
  it("gives all 24 looks unique complete rows in the six shared animation sheets", () => {
    expect(CAT_APPEARANCES).toHaveLength(24);
    expect(new Set(CAT_APPEARANCES.map((appearance) => appearance.id)).size).toBe(24);
    expect(new Set(CAT_APPEARANCES.map(({ sheet, row }) => `${sheet}:${row}`)).size).toBe(24);
    expect(CAT_SHEET_URLS).toHaveLength(6);
    for (const { sheet, row } of CAT_APPEARANCES) {
      expect(sheet).toBeGreaterThanOrEqual(0);
      expect(sheet).toBeLessThan(6);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(4);
    }
  });

  it("accounts for the deployed 64px portrait crops and full sleeping frames", () => {
    expect(manifest.displaySize).toBe(64);
    expect(renderedSize("../packages/web/src/features/topics/agent-terminal.css", "kulo-agent-profile-avatar")).toBe(manifest.displaySize);
    expect(renderedSize("../packages/web/src/components/cat-picker.css", "kulo-cat-picker-thumbnail")).toBe(manifest.displaySize);
    expect(manifest.appearanceCrops.map((entry: { id: string }) => entry.id)).toEqual(CAT_APPEARANCES.map(({ id }) => id));
    for (const [index, appearance] of CAT_APPEARANCES.entries()) {
      const crop = getCatAppearanceCrop(appearance.id);
      expect(manifest.appearanceCrops[index]).toEqual({ id: appearance.id, crop, pixelRatio: crop[2] / manifest.displaySize });
      expect(crop[2]).toBeGreaterThanOrEqual(manifest.displaySize * 4);
      if (appearance.sheet === 5) expect(crop).toEqual([0, 0, manifest.sheets[5].cellSize]);
    }
    const minimumCrop = Math.min(...CAT_APPEARANCES.map(({ id }) => getCatAppearanceCrop(id)[2]));
    expect(minimumCrop).toBe(276);
    expect(manifest.minimumPixelRatio).toBe(minimumCrop / manifest.displaySize);
    expect(manifest.nativeFramePixelRatio).toBe(Math.min(...manifest.sheets.map((sheet: { cellSize: number }) => sheet.cellSize)) / manifest.displaySize);
  });

  it("ships lossless 4x character artwork and 3x paper at the actual display size", () => {
    let total = 0;
    for (const [index, sheet] of manifest.sheets.entries()) {
      expect(CAT_SHEET_URLS[index]).toBe(`/mascots/cat/${sheet.file}`);
      const bytes = fs.readFileSync(path.join(directory, sheet.file));
      const dimensions = losslessDimensions(bytes);
      expect(dimensions).toEqual({ width: sheet.width, height: sheet.height });
      expect(dimensions.width).toBe(sheet.cellSize * 4);
      expect(dimensions.height).toBe(sheet.cellSize * 4);
      expect(sheet.cellSize).toBeGreaterThanOrEqual(manifest.displaySize * 4);
      expect(sheet.frames).toBe(16);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sheet.sha256);
      total += bytes.length;
    }
    const paper = fs.readFileSync(path.join(directory, manifest.paper.file));
    const paperSize = losslessDimensions(paper);
    expect(paperSize).toEqual({ width: 192, height: 192 });
    expect(Math.min(paperSize.width, paperSize.height)).toBeGreaterThanOrEqual(manifest.displaySize * 3);
    expect(manifest.paperPixelRatio).toBe(Math.min(paperSize.width, paperSize.height) / manifest.displaySize);
    expect(total + paper.length).toBe(manifest.runtimeImageBytes);
    expect(total + paper.length).toBeLessThan(6 * 1024 * 1024);
    expect(total + paper.length).toBeLessThan(manifest.sourcePngBytes);
  });
});
