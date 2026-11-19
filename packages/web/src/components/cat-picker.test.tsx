import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatAvatar } from "./cat-avatar";
import { CAT_APPEARANCES } from "./cat-catalog";
import { CatPicker } from "./cat-picker";
import * as preferences from "./cat-preferences";

// Render the normally portalled content so the visible copy contract can be checked.
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const surface = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { ...actual, Popover: Object.assign(surface, { Content: surface, Dialog: surface }) };
});

afterEach(() => vi.restoreAllMocks());

describe("image-only cat picker", () => {
  it("shows 24 unnamed images while retaining accessible choices and the selected outfit", () => {
    vi.spyOn(preferences, "useCatPreferences").mockReturnValue({ appearance: "programmer", animated: true, error: null });
    const html = renderToStaticMarkup(<CatPicker><CatAvatar animated={false} /></CatPicker>);
    const buttons = html.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(25);
    expect(buttons[0]).toContain('aria-label="更换 Moco 形象"');
    expect(html.replace(/<[^>]+>/g, "")).toBe("");
    for (const appearance of CAT_APPEARANCES) {
      const choice = buttons.find((button) => button.includes(`aria-label="${appearance.labelZh}"`));
      expect(choice).toContain(`data-appearance="${appearance.id}"`);
      expect(choice).toContain(`aria-pressed="${appearance.id === "programmer"}"`);
      expect(choice).toContain('data-animated="false"');
    }
    expect(html).not.toContain("palette");
    expect(html).not.toContain("跟随状态");
    expect(html).not.toContain('role="switch"');
  });

  it("keeps storage failures visible", () => {
    vi.spyOn(preferences, "useCatPreferences").mockReturnValue({ appearance: "programmer", animated: true, error: "save" });
    const html = renderToStaticMarkup(<CatPicker><CatAvatar animated={false} /></CatPicker>);
    expect(html).toContain("无法保存形象偏好");
  });
});
