import { describe, expect, it } from "vitest";
import type { LiveStreamState } from "@kulo/protocol";
import { LIVE_WAIT_ELAPSED_THRESHOLD_SECONDS, resolveLiveWaitStatus } from "./live-status";

function baseLive(overrides: Partial<LiveStreamState> = {}): LiveStreamState {
  return {
    busy: true,
    activeTools: [],
    queuedCount: 0,
    ...overrides,
  };
}

describe("resolveLiveWaitStatus", () => {
  it("stays silent below the elapsed threshold when no stage details have arrived", () => {
    expect(resolveLiveWaitStatus(baseLive(), { elapsedSeconds: LIVE_WAIT_ELAPSED_THRESHOLD_SECONDS - 1, language: "zh-CN" }))
      .toEqual({ label: null, elapsedSuffix: null });
  });

  it("separates discrete status label from decorative elapsed seconds after threshold", () => {
    expect(resolveLiveWaitStatus(baseLive(), { elapsedSeconds: 12, language: "zh-CN" })).toEqual({
      label: "等待模型响应",
      elapsedSuffix: "（12s）",
    });
    expect(resolveLiveWaitStatus(baseLive(), { elapsedSeconds: 12, language: "en" })).toEqual({
      label: "Waiting for model",
      elapsedSuffix: " (12s)",
    });
  });

  it("prioritizes retry > active tool > thinking > elapsed wait", () => {
    expect(
      resolveLiveWaitStatus(
        baseLive({
          retrying: { attempt: 2, at: 1234 },
          activeTools: [{ callId: "c1", name: "kulo_dispatch" }],
          streamingThinking: "reasoning",
        }),
        { elapsedSeconds: 30, language: "zh-CN" },
      ),
    ).toEqual({
      label: "模型响应异常，正在重试（第 2 次）…",
      elapsedSuffix: null,
    });

    expect(
      resolveLiveWaitStatus(
        baseLive({
          activeTools: [{ callId: "c1", name: "kulo_dispatch" }],
          streamingThinking: "reasoning",
        }),
        { elapsedSeconds: 30, language: "zh-CN" },
      ),
    ).toEqual({
      label: "正在派发任务…",
      elapsedSuffix: null,
    });

    expect(
      resolveLiveWaitStatus(
        baseLive({
          activeTools: [{ callId: "c1", name: "kulo_dispatch" }],
        }),
        { showProcess: true, language: "en" },
      ),
    ).toEqual({
      label: "Dispatching task · kulo_dispatch",
      elapsedSuffix: null,
    });

    expect(
      resolveLiveWaitStatus(
        baseLive({ streamingThinking: "Checking..." }),
        { elapsedSeconds: 20, language: "en" },
      ),
    ).toEqual({
      label: "Thinking…",
      elapsedSuffix: null,
    });
  });
});
