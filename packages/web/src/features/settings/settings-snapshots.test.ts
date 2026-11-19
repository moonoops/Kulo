import { describe, expect, it } from "vitest";
import type { MocoSettingsView } from "@moco/protocol";
import { acceptSettingsSnapshot } from "./settings-helpers";

describe("settings acknowledgements", () => {
  it("keeps newer sibling changes when an earlier save response arrives after a broadcast", () => {
    const newer = { globalRevision: 9, blocks: { executor: { revision: 4 }, presentation: { revision: 3 } } } as MocoSettingsView;
    const delayed = { globalRevision: 8, blocks: { executor: { revision: 4 }, presentation: { revision: 2 } } } as MocoSettingsView;
    expect(acceptSettingsSnapshot(newer, delayed)).toBe(newer);
    expect(acceptSettingsSnapshot(delayed, newer)).toBe(newer);
  });

  it("accepts the initial settings and same-revision responses with refreshed public metadata", () => {
    const first = { globalRevision: 1 } as MocoSettingsView;
    const refreshed = { ...first, history: [] } as MocoSettingsView;
    expect(acceptSettingsSnapshot(null, first)).toBe(first);
    expect(acceptSettingsSnapshot(first, refreshed)).toBe(refreshed);
  });
});
