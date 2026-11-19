import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MocoThinkingIndicator } from "./thinking-indicator";

describe("Moco thinking indicator", () => {
  it("announces one status while keeping the animated planes decorative", () => {
    const html = renderToStaticMarkup(<MocoThinkingIndicator />);
    expect(html).toContain('role="status" aria-label="思考中"');
    expect((html.match(/class="moco-thinking-plane" aria-hidden="true"/g) ?? [])).toHaveLength(3);
    expect(html).not.toContain('data-slot="spinner"');
  });

  it("accepts the caller's status label and layout class", () => {
    const html = renderToStaticMarkup(<MocoThinkingIndicator aria-label="设置助手思考中" className="shrink-0" />);
    expect(html).toContain('aria-label="设置助手思考中"');
    expect(html).toContain('class="moco-thinking-indicator shrink-0"');
  });

  it("lets the surrounding conversation status announce a compact decorative indicator", () => {
    const html = renderToStaticMarkup(<MocoThinkingIndicator size="compact" decorative />);
    expect(html).toContain('class="moco-thinking-indicator moco-thinking-indicator--compact" aria-hidden="true"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("aria-label=");
    expect((html.match(/class="moco-thinking-plane" aria-hidden="true"/g) ?? [])).toHaveLength(3);
  });
});
