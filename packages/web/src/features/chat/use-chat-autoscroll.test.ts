import { describe, expect, it } from "vitest";
import { computeChatScrollState } from "./use-chat-autoscroll";

describe("computeChatScrollState", () => {
  it("keeps nearBottom true near the end and exposes jump-to-latest past the button threshold", () => {
    expect(
      computeChatScrollState({
        metrics: { scrollTop: 920, scrollHeight: 1500, clientHeight: 500 },
        nearThreshold: 120,
        showButtonThreshold: 180,
      }),
    ).toEqual({
      distance: 80,
      nearBottom: true,
      showToBottom: false,
      scrollingToLatest: false,
    });

    expect(
      computeChatScrollState({
        metrics: { scrollTop: 700, scrollHeight: 1500, clientHeight: 500 },
        nearThreshold: 120,
        showButtonThreshold: 180,
      }),
    ).toEqual({
      distance: 300,
      nearBottom: false,
      showToBottom: true,
      scrollingToLatest: false,
    });
  });

  it("does not drop nearBottom or re-show the button mid-flight during smooth scroll-to-latest", () => {
    const midFlight = computeChatScrollState({
      metrics: { scrollTop: 400, scrollHeight: 2000, clientHeight: 600 },
      nearThreshold: 120,
      showButtonThreshold: 180,
      scrollingToLatest: true,
    });
    expect(midFlight).toEqual({
      distance: 1000,
      nearBottom: true,
      showToBottom: false,
      scrollingToLatest: true,
    });

    const arrived = computeChatScrollState({
      metrics: { scrollTop: 1350, scrollHeight: 2000, clientHeight: 600 },
      nearThreshold: 120,
      showButtonThreshold: 180,
      scrollingToLatest: true,
    });
    expect(arrived).toEqual({
      distance: 50,
      nearBottom: true,
      showToBottom: false,
      scrollingToLatest: false,
    });
  });

  it("disables nearBottom while explicitly navigating to a historical turn", () => {
    expect(
      computeChatScrollState({
        metrics: { scrollTop: 950, scrollHeight: 1500, clientHeight: 500 },
        nearThreshold: 120,
        showButtonThreshold: 180,
        navigating: true,
      }),
    ).toMatchObject({ nearBottom: false, showToBottom: false });
  });
});
