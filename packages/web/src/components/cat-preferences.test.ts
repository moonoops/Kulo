import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function storageFixture() {
  const data = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
  };
  const events = new EventTarget();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", events);
  const dispatch = (key: string | null, newValue: string | null) => {
    const event = Object.assign(new Event("storage"), { key, newValue });
    events.dispatchEvent(event);
  };
  return { data, storage, dispatch };
}

describe("cat appearance preferences", () => {
  it("validates persisted IDs and booleans without accepting asset paths or truthy strings", async () => {
    const { parseCatPreferences } = await import("./cat-preferences");
    for (const raw of [null, undefined, "bad json", [], { appearance: "../asset.webp", animated: "false" }, { appearance: "yellow-cat", animated: 0 }]) {
      expect(parseCatPreferences(raw)).toEqual({ appearance: "auto", animated: true });
    }
    expect(parseCatPreferences('{"appearance":"hat-scarf","animated":false}')).toEqual({ appearance: "hat-scarf", animated: false });
    expect(parseCatPreferences({ appearance: "sleep-belly-up" })).toEqual({ appearance: "sleep-belly-up", animated: true });
  });

  it("persists appearance and motion together across reloads without changing theme or language", async () => {
    const { data, storage } = storageFixture();
    data.set("moco:appearance", '{"mode":"light"}');
    data.set("moco:language", "en");
    let api = await import("./cat-preferences");
    expect(api.saveCatPreferences({ appearance: "beanie" })).toBe(true);
    expect(api.saveCatPreferences({ animated: false })).toBe(true);
    expect(JSON.parse(data.get(api.CAT_PREFERENCES_STORAGE_KEY)!)).toEqual({ appearance: "beanie", animated: false });
    expect(data.get("moco:appearance")).toBe('{"mode":"light"}');
    expect(data.get("moco:language")).toBe("en");
    expect(storage.setItem.mock.calls.every(([key]) => key === api.CAT_PREFERENCES_STORAGE_KEY)).toBe(true);
    vi.resetModules();
    api = await import("./cat-preferences");
    expect(api.getCatPreferences()).toEqual({ appearance: "beanie", animated: false, error: null });
  });

  it("shares stable snapshots, notifies same-tab subscribers and synchronizes other tabs and clears", async () => {
    const { storage, dispatch } = storageFixture();
    const api = await import("./cat-preferences");
    const first = api.getCatPreferences();
    expect(api.getCatPreferences()).toBe(first);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    const onChange = vi.fn();
    const unsubscribe = api.subscribeCatPreferences(onChange);
    api.saveCatPreferences({ appearance: "raincoat" });
    expect(onChange).toHaveBeenCalledTimes(1);
    dispatch("moco:language", "en");
    expect(onChange).toHaveBeenCalledTimes(1);
    dispatch(api.CAT_PREFERENCES_STORAGE_KEY, '{"appearance":"beret","animated":false}');
    expect(api.getCatPreferences()).toEqual({ appearance: "beret", animated: false, error: null });
    expect(onChange).toHaveBeenCalledTimes(2);
    dispatch(null, null);
    expect(api.getCatPreferences()).toEqual({ appearance: "auto", animated: true, error: null });
    unsubscribe();
    dispatch(api.CAT_PREFERENCES_STORAGE_KEY, '{"appearance":"headphones"}');
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(api.getCatPreferences().appearance).toBe("auto");
  });

  it("keeps the saved choice on write failure, exposes an error and permits a successful retry", async () => {
    const { storage } = storageFixture();
    const api = await import("./cat-preferences");
    expect(api.saveCatPreferences({ appearance: "cap" })).toBe(true);
    storage.setItem.mockImplementationOnce(() => { throw new DOMException("Storage full", "QuotaExceededError"); });
    expect(api.saveCatPreferences({ appearance: "nightcap", animated: false })).toBe(false);
    expect(api.getCatPreferences()).toEqual({ appearance: "cap", animated: true, error: "save" });
    expect(api.saveCatPreferences({ appearance: "nightcap", animated: false })).toBe(true);
    expect(api.getCatPreferences()).toEqual({ appearance: "nightcap", animated: false, error: null });
  });

  it("exposes blocked reads and rejects invalid internal writes before touching storage", async () => {
    const { storage } = storageFixture();
    storage.getItem.mockImplementation(() => { throw new DOMException("Storage blocked", "SecurityError"); });
    const api = await import("./cat-preferences");
    expect(api.getCatPreferences()).toEqual({ appearance: "auto", animated: true, error: "read" });
    expect(() => api.saveCatPreferences({ appearance: "../unknown" } as never)).toThrow(TypeError);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
