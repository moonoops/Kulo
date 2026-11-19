import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CatAvatar, catFrameStyle } from "./cat-avatar";
import { CAT_APPEARANCES, CAT_NATIVE_FRAME_SIZE, getCatAppearanceCrop } from "./cat-catalog";

describe("cat avatar rendering", () => {
  it("renders all 24 static previews from the shared lossless sheets", () => {
    for (const appearance of CAT_APPEARANCES) {
      const html = renderToStaticMarkup(<CatAvatar appearance={appearance.id} animated={false} />);
      expect(html).toContain(`data-appearance="${appearance.id}"`);
      expect(html).toContain('data-animated="false"');
      expect(html).toContain(`/mascots/cat/actions-${appearance.sheet}.webp`);
      expect(html).not.toContain("marmot");
      expect(html).not.toContain("<canvas");
    }
  });

  it("retains the selected wardrobe across work states and preserves automatic voice identity", () => {
    const selected = renderToStaticMarkup(<CatAvatar appearance="hat-scarf" state="working" animated={false} />);
    expect(selected).toContain('data-appearance="hat-scarf"');
    expect(selected).toContain('data-frame="2"');
    const automatic = renderToStaticMarkup(<CatAvatar state="listening" />);
    expect(automatic).toContain('data-appearance="headphones"');
    expect(automatic).toContain('aria-hidden="true"');
  });

  it("uses the same portrait crop for neutral, attentive and greeting frames without changing avatar size", () => {
    for (const appearance of CAT_APPEARANCES.filter(({ sheet }) => sheet < 5)) {
      const frameStyles = ([0, 1, 2, 3] as const).map((frame) => catFrameStyle(appearance, frame));
      const viewports = frameStyles.map(({ width, height, left, top }) => ({ width, height, left, top }));
      expect(viewports).toEqual(Array.from({ length: 4 }, () => viewports[0]));
      expect(new Set(frameStyles.map(({ backgroundPosition }) => backgroundPosition)).size).toBe(4);
      const crops = ["idle", "working", "success"].map((state) => {
        const html = renderToStaticMarkup(<CatAvatar appearance={appearance.id} state={state as "idle" | "working" | "success"} animated={false} />);
        const style = html.match(/class="moco-cat-avatar-sprite" style="([^"]+)"/)![1]!;
        return style.split(";").filter((declaration) => /^(?:width|height|left|top):/.test(declaration));
      });
      expect(crops[1]).toEqual(crops[0]);
      expect(crops[2]).toEqual(crops[0]);
      const [x, y, size] = getCatAppearanceCrop(appearance.id);
      expect(size).toBeGreaterThanOrEqual(256);
      expect(y + size).toBeLessThan(CAT_NATIVE_FRAME_SIZE);
      expect(crops[0]).toContain(`left:${-x / size * 100}%`);
      expect(crops[0]).toContain(`top:${-y / size * 100}%`);
    }
    const html = renderToStaticMarkup(<CatAvatar animated={false} />);
    expect(html).not.toMatch(/moco-cat-avatar" style=/);
    // The default portrait's torso ends at native y=298; the viewport ends one pixel inside it.
    const [, top, size] = getCatAppearanceCrop("sunglasses");
    expect(top + size).toBe(297);
  });

  it("retains complete frames for all four sleeping poses", () => {
    for (const appearance of CAT_APPEARANCES.filter(({ sheet }) => sheet === 5)) {
      expect(getCatAppearanceCrop(appearance.id)).toEqual([0, 0, CAT_NATIVE_FRAME_SIZE]);
      const html = renderToStaticMarkup(<CatAvatar appearance={appearance.id} animated={false} />);
      expect(html).toContain("width:100%;height:100%;left:0%;top:0%");
    }
  });
});
