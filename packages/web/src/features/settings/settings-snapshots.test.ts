import { describe, expect, it } from "vitest";
import type { KuloSettingsView } from "@kulo/protocol";
import { acceptSettingsSnapshot } from "./settings-helpers";

describe("settings acknowledgements", () => {
  it("keeps newer sibling changes when an earlier save response arrives after a broadcast", () => {
    const newer = { globalRevision: 9, blocks: { executor: { revision: 4 }, presentation: { revision: 3 } } } as KuloSettingsView;
    const delayed = { globalRevision: 8, blocks: { executor: { revision: 4 }, presentation: { revision: 2 } } } as KuloSettingsView;
    expect(acceptSettingsSnapshot(newer, delayed)).toBe(newer);
    expect(acceptSettingsSnapshot(delayed, newer)).toBe(newer);
  });

  it("accepts the initial settings and same-revision responses with refreshed public metadata", () => {
    const first = { globalRevision: 1 } as KuloSettingsView;
    const refreshed = { ...first, history: [] } as KuloSettingsView;
    expect(acceptSettingsSnapshot(null, first)).toBe(first);
    expect(acceptSettingsSnapshot(first, refreshed)).toBe(refreshed);
  });
});
