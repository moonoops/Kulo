import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureMediaSession } from "./kulo-api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensureMediaSession", () => {
  it("aborts a stuck in-flight request when force=true instead of reusing it", async () => {
    const signals: AbortSignal[] = [];
    let callCount = 0;

    vi.stubGlobal("window", {
      location: { pathname: "/", search: "", hash: "" },
      history: { replaceState: vi.fn() },
      sessionStorage: { getItem: () => null, setItem: () => {} },
    });

    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      callCount += 1;
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      if (callCount === 1) {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({
        expiresAt: Date.now() + 600_000,
        limits: {
          imageBytes: 1,
          audioBytes: 1,
          videoBytes: 1,
          fileBytes: 1,
          messageBytes: 1,
          maxAttachments: 1,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }));

    const first = ensureMediaSession(true);
    const second = ensureMediaSession(true);

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    await expect(first).rejects.toThrow();
    const session = await second;
    expect(session.limits.maxAttachments).toBe(1);
  });
});
