import { describe, expect, it } from "vitest";
import { constrainPreviewPan, constrainPreviewScale, fitPreviewScale, previewPanLimits } from "./asset-preview-model";

describe("image preview geometry", () => {
  const viewport = { width: 1000, height: 700 };

  it("fits wide and tall pictures completely inside the available canvas", () => {
    const wide = { width: 4000, height: 1000 };
    const tall = { width: 1000, height: 4000 };
    expect(fitPreviewScale(wide, viewport)).toBeCloseTo(952 / 4000);
    expect(fitPreviewScale(tall, viewport)).toBeCloseTo(652 / 4000);
    for (const image of [wide, tall]) {
      const scale = fitPreviewScale(image, viewport);
      expect(image.width * scale).toBeLessThanOrEqual(viewport.width - 48);
      expect(image.height * scale).toBeLessThanOrEqual(viewport.height - 48);
      expect(previewPanLimits(image, viewport, scale)).toEqual({ x: 0, y: 0 });
    }
  });

  it("preserves a small image's original size instead of upscaling its initial view", () => {
    expect(fitPreviewScale({ width: 200, height: 100 }, viewport)).toBe(1);
  });

  it("keeps extreme portrait images usable on a narrow screen", () => {
    const scale = fitPreviewScale({ width: 2000, height: 20000 }, { width: 240, height: 500 });
    expect(scale).toBeCloseTo(452 / 20000);
    expect(constrainPreviewScale(scale, scale)).toBe(scale);
    expect(constrainPreviewScale(0.001, scale)).toBe(scale);
  });

  it("bounds zoom without preventing a fitted image below ten percent", () => {
    expect(constrainPreviewScale(10, 0.2)).toBe(8);
    expect(constrainPreviewScale(0.01, 0.2)).toBe(0.1);
    expect(constrainPreviewScale(0.02, 0.02)).toBe(0.02);
  });

  it("reaches exact zoom limits after stepping so button availability changes at the boundary", () => {
    const fitScale = 0.08;
    const enlarged = constrainPreviewScale(fitScale * 1.25, fitScale);
    expect(enlarged).toBeGreaterThan(fitScale);
    expect(constrainPreviewScale(enlarged / 1.25, fitScale)).toBe(fitScale);
    expect(constrainPreviewScale(7 * 1.25, fitScale)).toBe(8);
  });

  it("constrains dragging to overflowing axes and stops at the image edge", () => {
    const image = { width: 1600, height: 400 };
    expect(constrainPreviewPan({ x: 1000, y: -1000 }, image, viewport, 1)).toEqual({ x: 324, y: 0 });
    expect(constrainPreviewPan({ x: -1000, y: 1000 }, image, viewport, 1)).toEqual({ x: -324, y: 0 });
    expect(constrainPreviewPan({ x: 80, y: 0 }, image, viewport, 1)).toEqual({ x: 80, y: 0 });
  });

  it("recenters an image when it fits again after resizing or zooming out", () => {
    const image = { width: 1600, height: 1200 };
    const scale = fitPreviewScale(image, viewport);
    expect(constrainPreviewPan({ x: 500, y: 300 }, image, viewport, scale)).toEqual({ x: 0, y: 0 });
    expect(constrainPreviewPan({ x: 500, y: 300 }, image, { width: 2000, height: 1600 }, 1)).toEqual({ x: 0, y: 0 });
  });
});
