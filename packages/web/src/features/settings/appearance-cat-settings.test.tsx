import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceModule } from "./appearance-module";
import * as preferences from "../../components/cat-preferences";

const controls = vi.hoisted(() => new Map<string, { onChange?: (selected: boolean) => void; isSelected?: boolean }>());
vi.mock("@heroui/react", async (original) => {
  const actual = await original<typeof import("@heroui/react")>();
  const { createElement } = await import("react");
  const Switch = Object.assign((props: React.ComponentProps<typeof actual.Switch>) => {
    controls.set(props["aria-label"] ?? "", props);
    return createElement(actual.Switch, props);
  }, actual.Switch);
  return { ...actual, Switch };
});

let data: Map<string, string>;
let setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;

beforeEach(() => {
  data = new Map();
  setItem = vi.fn((key: string, value: string) => { data.set(key, value); });
  vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem });
  preferences.saveCatPreferences({ appearance: "auto", animated: true });
  vi.spyOn(preferences, "useCatPreferences").mockImplementation(preferences.getCatPreferences);
  controls.clear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function render() { return renderToStaticMarkup(<AppearanceModule />); }
function change(label: string, selected: boolean) {
  const control = controls.get(label);
  expect(control?.onChange).toBeTypeOf("function");
  control!.onChange!(selected);
}

describe("Kulo appearance settings", () => {
  it("exposes automatic appearance and motion as named settings switches", () => {
    const html = render();
    expect(html).toContain('aria-label="Kulo 形象偏好"');
    expect(html).toContain('aria-label="自动切换形象"');
    expect(html).toContain('aria-label="动态"');
    expect(controls.get("自动切换形象")?.isSelected).toBe(true);
    expect(controls.get("动态")?.isSelected).toBe(true);
    expect(controls.get("系统通知")?.isSelected).toBe(true);
    expect(controls.get("提示音")?.isSelected).toBe(false);
    expect(controls.get("任务栏红点")?.isSelected).toBe(true);
    expect(html.match(/role="switch"/g)).toHaveLength(5);
  });

  it("changes motion without replacing a manually selected outfit", () => {
    preferences.saveCatPreferences({ appearance: "hat-scarf", animated: true });
    render();
    change("动态", false);
    expect(preferences.getCatPreferences()).toEqual({ appearance: "hat-scarf", animated: false, error: null });
    expect(JSON.parse(data.get(preferences.CAT_PREFERENCES_STORAGE_KEY)!)).toEqual({ appearance: "hat-scarf", animated: false });
  });

  it("enables automatic appearance without changing the motion preference", () => {
    preferences.saveCatPreferences({ appearance: "beret", animated: false });
    render();
    expect(controls.get("自动切换形象")?.isSelected).toBe(false);
    change("自动切换形象", true);
    expect(preferences.getCatPreferences()).toEqual({ appearance: "auto", animated: false, error: null });
  });

  it("pins the displayed working outfit when automatic switching is disabled", () => {
    preferences.saveCatPreferences({ animated: false });
    render();
    const querySelector = vi.fn(() => ({ getAttribute: () => "programmer" }));
    vi.stubGlobal("document", { querySelector });
    change("自动切换形象", false);
    expect(querySelector).toHaveBeenCalledWith(".kulo-agent-profile-avatar[data-appearance]");
    expect(preferences.getCatPreferences()).toEqual({ appearance: "programmer", animated: false, error: null });
  });

  it.each([null, "../unknown.webp", "auto"])("uses the default when the displayed outfit is unavailable or invalid: %s", (displayed) => {
    render();
    vi.stubGlobal("document", { querySelector: () => displayed === null ? null : { getAttribute: () => displayed } });
    change("自动切换形象", false);
    expect(preferences.getCatPreferences()).toEqual({ appearance: "sunglasses", animated: true, error: null });
  });

  it("keeps an already fixed outfit when automatic switching is disabled", () => {
    preferences.saveCatPreferences({ appearance: "nightcap", animated: false });
    render();
    change("自动切换形象", false);
    expect(preferences.getCatPreferences()).toEqual({ appearance: "nightcap", animated: false, error: null });
  });

  it("shows blocked preference reads in settings", () => {
    vi.mocked(preferences.useCatPreferences).mockReturnValue({ appearance: "auto", animated: true, error: "read" });
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("无法读取形象偏好");
  });

  it("keeps the saved setting and displays a save error when storage rejects the change", () => {
    render();
    setItem.mockImplementationOnce(() => { throw new DOMException("Storage full", "QuotaExceededError"); });
    change("动态", false);
    expect(preferences.getCatPreferences()).toEqual({ appearance: "auto", animated: true, error: "save" });
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("无法保存形象偏好");
    expect(controls.get("动态")?.isSelected).toBe(true);
  });
});
