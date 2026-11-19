import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KULO_ICONS } from "../../kulo-icons";
import { CallStatusIcon } from "./call-status-icon";

describe("call status icon", () => {
  it("distinguishes the idle voice entry from a connected call", () => {
    const idle = renderToStaticMarkup(<CallStatusIcon />);
    const active = renderToStaticMarkup(<CallStatusIcon state="listening" />);
    expect(idle).toContain(KULO_ICONS.waveform);
    expect(idle).not.toContain("kulo-call-status-dot");
    expect(active).toContain(KULO_ICONS.phone);
    expect(active).not.toContain(KULO_ICONS.waveform);
    expect(active).toContain("badge--success");
  });

  it.each(["connecting", "reconnecting"] as const)("keeps %s visibly pending without claiming a live connection", (state) => {
    const html = renderToStaticMarkup(<CallStatusIcon state={state} />);
    expect(html).toContain("spinner");
    expect(html).not.toContain("kulo-call-status-dot");
    expect(html).not.toContain(KULO_ICONS.waveform);
  });

  it("keeps mute distinct from a disconnected call", () => {
    const muted = renderToStaticMarkup(<CallStatusIcon state="speaking" muted />);
    const ended = renderToStaticMarkup(<CallStatusIcon state="ended" muted />);
    expect(muted).toContain(KULO_ICONS.phone);
    expect(muted).toContain("badge--warning");
    expect(ended).toContain(KULO_ICONS.phone);
    expect(ended).not.toContain("kulo-call-status-dot");
  });
});
