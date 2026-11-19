import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MOCO_ICONS } from "../../moco-icons";
import { CallStatusIcon } from "./call-status-icon";

describe("call status icon", () => {
  it("distinguishes the idle voice entry from a connected call", () => {
    const idle = renderToStaticMarkup(<CallStatusIcon />);
    const active = renderToStaticMarkup(<CallStatusIcon state="listening" />);
    expect(idle).toContain(MOCO_ICONS.waveform);
    expect(idle).not.toContain("moco-call-status-dot");
    expect(active).toContain(MOCO_ICONS.phone);
    expect(active).not.toContain(MOCO_ICONS.waveform);
    expect(active).toContain("badge--success");
  });

  it.each(["connecting", "reconnecting"] as const)("keeps %s visibly pending without claiming a live connection", (state) => {
    const html = renderToStaticMarkup(<CallStatusIcon state={state} />);
    expect(html).toContain("spinner");
    expect(html).not.toContain("moco-call-status-dot");
    expect(html).not.toContain(MOCO_ICONS.waveform);
  });

  it("keeps mute distinct from a disconnected call", () => {
    const muted = renderToStaticMarkup(<CallStatusIcon state="speaking" muted />);
    const ended = renderToStaticMarkup(<CallStatusIcon state="ended" muted />);
    expect(muted).toContain(MOCO_ICONS.phone);
    expect(muted).toContain("badge--warning");
    expect(ended).toContain(MOCO_ICONS.phone);
    expect(ended).not.toContain("moco-call-status-dot");
  });
});
