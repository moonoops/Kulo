import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderConnectionTable, type ProviderConnectionItem } from "./provider-connection-table";

const connection: ProviderConnectionItem = {
  id: "api-demo", name: "工作模型", protocol: "OpenAI Responses", modelCount: 3,
  authenticated: true, action: "编辑", disabled: false, onEdit() {}, onDelete() {},
};
const render = (items: ProviderConnectionItem[], loading = false) => renderToStaticMarkup(
  <ProviderConnectionTable label="API 接入" emptyLabel="暂无 API 接入" items={items} loading={loading} />,
);

describe("provider connection management table", () => {
  it("associates every connection with named columns and independent operations", () => {
    const html = render([connection, { ...connection, id: "api-other", name: "备用模型", authenticated: false, modelCount: 0 }]);
    expect(html).toMatch(/<table\b(?=[^>]*role="grid")(?=[^>]*aria-label="API 接入")/);
    expect(html.match(/role="columnheader"/g)).toHaveLength(4);
    expect(html.match(/role="rowheader"/g)).toHaveLength(2);
    for (const heading of ["连接", "模型数量", "状态", "操作"]) expect(html).toContain(heading);
    expect(html).toContain("OpenAI Responses");
    expect(html).toContain("3 个模型");
    expect(html).toContain("已认证");
    expect(html).toContain("未认证");
    expect(html).toContain('aria-label="编辑工作模型"');
    expect(html).toContain('aria-label="删除备用模型"');
    expect(html).not.toContain('aria-selected="');
  });

  it("preserves known authentication states and disables operations during refresh", () => {
    const html = render([connection, { ...connection, id: "api-other", authenticated: false }], true);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("读取认证状态");
    expect(html).toContain("已认证");
    expect(html).toContain("未认证");
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(4);
    expect(buttons.every((button) => button.includes("disabled"))).toBe(true);
  });

  it("distinguishes loading from an empty set of connections", () => {
    const loading = render([], true);
    expect(loading).toContain("加载模型连接");
    expect(loading).not.toContain("暂无 API 接入");
    const empty = render([]);
    expect(empty).toContain("暂无 API 接入");
    expect(empty.match(/role="columnheader"/g)).toHaveLength(4);
  });

  it("does not report an unknown authentication state as unauthenticated", () => {
    for (const loading of [true, false]) {
      const html = render([{ ...connection, authenticated: null }], loading);
      expect(html).toContain("认证状态尚未读取");
      expect(html).not.toContain("未认证");
      expect(html).not.toContain("已认证");
    }
  });

  it("keeps subscription refresh and its pending state on the correct connection", () => {
    const html = render([{ ...connection, name: "订阅账号", action: "刷新", pending: true, disabled: true }]);
    expect(html).toContain('aria-label="刷新订阅账号"');
    expect(html).toContain('aria-label="删除订阅账号"');
    expect(html).toContain('data-pending="true"');
    expect(html).not.toContain('aria-label="编辑订阅账号"');
  });
});
