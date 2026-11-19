import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsNumberField, SettingsSaveBar } from "./settings-layout";

describe("settings save activity", () => {
  it("blocks unrelated pending operations without showing a save in progress", () => {
    const html = renderToStaticMarkup(<SettingsSaveBar dirty busy saving={false} onDiscard={() => {}} />);
    expect(html).toContain('inert=""');
    expect(html).not.toContain("data-pending");
    expect(html).not.toContain('disabled=""');
  });

  it("retains the save progress and unavailable controls for a real save", () => {
    const html = renderToStaticMarkup(<SettingsSaveBar dirty busy onDiscard={() => {}} />);
    expect(html).toContain('data-pending="true"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("inert");
    const save = html.match(/<button\b[^>]*data-pending="true"[^>]*>/)?.[0];
    expect(save).not.toMatch(/\sdisabled=/);
    expect(save).toContain('tabindex="0"');
  });

  it("labels each manual configuration scope and omits unchanged save bars", () => {
    const html = renderToStaticMarkup(<SettingsSaveBar dirty scopeLabel="Voice configuration" saveLabel="Save voice" onDiscard={() => {}} />);
    expect(html).toContain('aria-label="Voice configuration"');
    expect(html).toContain("Save voice");
    expect(renderToStaticMarkup(<SettingsSaveBar dirty={false} onDiscard={() => {}} />)).toBe("");
  });

  it("keeps numeric controls labeled, unit-associated and focusable during a save", () => {
    const html = renderToStaticMarkup(<SettingsNumberField label="Update interval" value={2} minValue={1} maxValue={365} unit="days" isPending onChange={() => {}} onCommit={() => {}} />);
    expect(html).toContain('kulo-settings-row--number');
    expect(html).toContain('number-field--secondary');
    expect(html).toContain('aria-readonly="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('disabled=""');
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain("Update interval");
    expect(html).toContain("days");
  });
});
