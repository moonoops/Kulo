import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KuloThinkingIndicator } from "./thinking-indicator";

describe("Kulo thinking indicator", () => {
  it("announces one status while keeping the animated planes decorative", () => {
    const html = renderToStaticMarkup(<KuloThinkingIndicator />);
    expect(html).toContain('role="status" aria-label="思考中"');
    expect((html.match(/class="kulo-thinking-plane" aria-hidden="true"/g) ?? [])).toHaveLength(3);
    expect(html).not.toContain('data-slot="spinner"');
  });

  it("accepts the caller's status label and layout class", () => {
    const html = renderToStaticMarkup(<KuloThinkingIndicator aria-label="设置助手思考中" className="shrink-0" />);
    expect(html).toContain('aria-label="设置助手思考中"');
    expect(html).toContain('class="kulo-thinking-indicator shrink-0"');
  });

  it("lets the surrounding conversation status announce a compact decorative indicator", () => {
    const html = renderToStaticMarkup(<KuloThinkingIndicator size="compact" decorative />);
    expect(html).toContain('class="kulo-thinking-indicator kulo-thinking-indicator--compact" aria-hidden="true"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("aria-label=");
    expect((html.match(/class="kulo-thinking-plane" aria-hidden="true"/g) ?? [])).toHaveLength(3);
  });
});
