import { describe, expect, it, vi } from "vitest";
import { resetPdfPageScroll } from "./pdf-reading-position";

describe("PDF reading position", () => {
  it("starts a different page at its top without scrolling the outer conversation", () => {
    const conversation = { scrollTop: 1400, scrollLeft: 0 };
    const preview = { scrollTop: 480, scrollLeft: 30, parentElement: conversation };
    const closest = vi.fn(() => preview);
    const page = { scrollTop: 10, scrollLeft: 360, closest };
    resetPdfPageScroll(page as unknown as HTMLElement, 1, 2);
    expect(page.scrollTop).toBe(0);
    expect(page.scrollLeft).toBe(0);
    expect(preview).toMatchObject({ scrollTop: 0, scrollLeft: 0 });
    expect(closest).toHaveBeenCalledExactlyOnceWith(".moco-artifact-live-preview");
    expect(conversation.scrollTop).toBe(1400);
  });

  it("keeps both scroll axes when the same page is resized, zoomed or enlarged", () => {
    const preview = { scrollTop: 480, scrollLeft: 30 };
    const closest = vi.fn(() => preview);
    const page = { scrollTop: 10, scrollLeft: 360, closest };
    resetPdfPageScroll(page as unknown as HTMLElement, 2, 2);
    expect(page.scrollTop).toBe(10);
    expect(page.scrollLeft).toBe(360);
    expect(preview).toEqual({ scrollTop: 480, scrollLeft: 30 });
    expect(closest).not.toHaveBeenCalled();
  });

  it("supports backward navigation and an unmounted preview", () => {
    const page = { scrollTop: 0, scrollLeft: 180, closest: vi.fn(() => null) };
    resetPdfPageScroll(page as unknown as HTMLElement, 3, 2);
    expect(page.scrollLeft).toBe(0);
    expect(() => resetPdfPageScroll(null, 3, 2)).not.toThrow();
  });
});
