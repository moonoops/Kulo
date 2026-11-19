import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthTokenFromUrl } from "./moco-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAuthTokenFromUrl", () => {
  it("absorbs ?token= into sessionStorage, strips it from the address bar, and preserves other params", () => {
    const store = new Map<string, string>();
    const location = {
      pathname: "/",
      search: "?topic=t1&token=secret-token-123&view=chat",
      hash: "#bottom",
    };
    const replaceState = vi.fn((_state: unknown, _title: string, nextUrl: string) => {
      const parsed = new URL(nextUrl, "http://127.0.0.1:7788");
      location.pathname = parsed.pathname;
      location.search = parsed.search;
      location.hash = parsed.hash;
    });
    vi.stubGlobal("window", {
      location,
      history: { state: { idx: 1 }, replaceState },
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
      },
    });

    expect(getAuthTokenFromUrl()).toBe("secret-token-123");
    expect(replaceState).toHaveBeenCalledWith({ idx: 1 }, "", "/?topic=t1&view=chat#bottom");
    expect(location.search).toBe("?topic=t1&view=chat");
    expect(location.hash).toBe("#bottom");
    expect(getAuthTokenFromUrl()).toBe("secret-token-123");
  });
});
