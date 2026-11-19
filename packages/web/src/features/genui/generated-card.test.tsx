import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getUiSpecFields, type UiCardSnapshot, type UiSpec } from "@moco/protocol";
import { GeneratedCard } from "./generated-card";

function card(): UiCardSnapshot {
  return {
    cardId: "render-test", schemaVersion: 1, catalogVersion: 1, revision: 1, title: "选择照明方案", status: "ready",
    originConversationId: 1, committedState: {},
    actions: [{ id: "server-issued-action", label: "采用方案", kind: "submit", fields: [{ name: "plan", label: "方案", type: "enum", required: true, options: ["warm", "focus"] }] }],
    spec: { root: "root", state: { values: { plan: "warm" } }, elements: {
      root: { type: "Card", props: { title: "选择照明方案" }, children: ["content"] },
      content: { type: "Stack", props: {}, children: ["choice", "preview", "submit"] },
      choice: { type: "Choice", props: { field: "plan", label: "照明方案", required: true, options: [
        { value: "warm", label: "温暖", description: "柔和照明" }, { value: "focus", label: "专注" },
      ] } },
      preview: { type: "Text", props: { field: "plan" } },
      submit: { type: "Button", props: { actionId: "server-issued-action", label: "采用方案" } },
    } },
  };
}

const onAction = async () => { throw new Error("SSR must not submit"); };

describe("GeneratedCard", () => {
  it("renders the genuine json-render registry and controlled field state", () => {
    const html = renderToStaticMarkup(<GeneratedCard card={card()} onAction={onAction} />);
    expect(html).toContain("温暖");
    expect(html).toContain("柔和照明");
    expect(html).toContain("采用方案");
    expect(html).toContain("warm</p>");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="收起卡片内容：选择照明方案"');
    expect(html).not.toContain("参数与预览");
    expect(html).not.toContain("moco-genui-section");
    expect(html).not.toContain("此卡片暂时无法显示");
    expect(html).not.toContain('data-enter="true"');
  });

  it("disables semantic actions offline and still renders the draft", () => {
    const html = renderToStaticMarkup(<GeneratedCard card={card()} onAction={onAction} isConnected={false} />);
    expect(html).toContain("离线 · 输入已保留");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>采用方案<\/button>/);
    expect(html).toContain("温暖");
  });

  it("preserves field layout when a redundant Card directly contains several controls", () => {
    const snapshot = card();
    snapshot.spec = { root: "root", elements: {
      root: { type: "Card", props: { title: snapshot.title }, children: ["name", "count"] },
      name: { type: "TextField", props: { field: "name", label: "名称" } },
      count: { type: "NumberField", props: { field: "count", label: "数量" } },
    } };
    snapshot.actions = [{ id: "submit", kind: "submit", label: "确认", fields: getUiSpecFields(snapshot.spec) }];
    const html = renderToStaticMarkup(<GeneratedCard card={snapshot} onAction={onAction} />);
    expect(html).toContain("名称");
    expect(html).toContain("数量");
    expect(html).toContain('class="moco-genui-stack"');
    expect(html).not.toContain("moco-genui-section");
  });

  it("supplies missing action controls and does not duplicate explicit Button nodes", () => {
    const explicit = renderToStaticMarkup(<GeneratedCard card={card()} onAction={onAction} />);
    expect(explicit.match(/>采用方案<\/button>/g)).toHaveLength(1);
    const implicit = card();
    implicit.spec.elements.content.children = ["choice", "preview"];
    delete implicit.spec.elements.submit;
    const html = renderToStaticMarkup(<GeneratedCard card={implicit} onAction={onAction} isConnected={false} />);
    expect(html.match(/>采用方案<\/button>/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>采用方案<\/button>/);
  });

  it("shows read-only comparison content directly without a parameters disclosure", () => {
    const snapshot: UiCardSnapshot = { ...card(), cardId: "comparison-preview", actions: [], spec: {
      root: "table", elements: { table: { type: "Table", props: {
        columns: [{ key: "name", label: "方案" }], rows: [{ name: "方案一" }], caption: "方案对比",
      } } },
    } };
    const html = renderToStaticMarkup(<GeneratedCard card={snapshot} onAction={onAction} />);
    expect(html).toContain("方案一");
    expect(html).toContain("预览");
    expect(html).not.toContain("参数与预览");
    expect(html).not.toContain('aria-expanded="true"');
    snapshot.spec.elements.table.props.rows = [];
    expect(renderToStaticMarkup(<GeneratedCard card={snapshot} onAction={onAction} />)).toContain("暂无数据");
  });

  it("renders table selection from the controlled field without forcing an initial row", () => {
    const spec: UiSpec = { root: "table", elements: { table: { type: "Table", props: {
      field: "selection", rowKey: "id", columns: [{ key: "name", label: "方案" }],
      rows: [{ id: "a", name: "方案甲" }, { id: "b", name: "方案乙" }], caption: "对比方案",
    } } } };
    const snapshot: UiCardSnapshot = { ...card(), cardId: "selectable-table", spec,
      actions: [{ id: "confirm-table", label: "采用所选方案", kind: "submit", fields: getUiSpecFields(spec) }] };
    const empty = renderToStaticMarkup(<GeneratedCard card={snapshot} onAction={onAction} />);
    expect(empty).toContain("采用所选方案");
    expect(empty).toContain("选择方案甲");
    expect(empty).not.toContain('aria-selected="true"');
    spec.state = { values: { selection: "b" } };
    const selected = renderToStaticMarkup(<GeneratedCard card={snapshot} onAction={onAction} />);
    expect(selected.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(selected).toContain("已选 1");
    expect(selected).not.toContain("此卡片暂不支持显示");
  });

  it("renders multiple selected table rows and readable committed result labels", () => {
    const spec: UiSpec = { root: "table", state: { values: { selected: ["a", "b"] } }, elements: { table: { type: "Table", props: {
      field: "selected", selectionMode: "multiple", rowKey: "id", columns: [{ key: "name", label: "方案" }],
      rows: [{ id: "a", name: "方案甲" }, { id: "b", name: "方案乙" }], caption: "方案",
    } } } };
    const snapshot: UiCardSnapshot = { ...card(), cardId: "multiple-table", spec,
      actions: [{ id: "table-submit", label: "提交所选", kind: "submit", fields: getUiSpecFields(spec) }] };
    const selected = renderToStaticMarkup(<GeneratedCard card={snapshot} onAction={onAction} />);
    expect(selected.match(/aria-selected="true"/g)).toHaveLength(2);
    expect(selected).toContain("选择本页全部行");
    const submitted = renderToStaticMarkup(<GeneratedCard card={{ ...snapshot, status: "submitted", committedState: { selected: ["a", "b"] } }} onAction={onAction} />);
    expect(submitted).toContain("方案甲、方案乙");
    expect(submitted).toContain('aria-expanded="false"');
  });

  it("collapses submitted parameters and reports only submission to the Agent", () => {
    const completed: UiCardSnapshot = { ...card(), revision: 2, status: "submitted", committedState: { plan: "focus" }, resultSummary: "已将选择发送给 Agent" };
    const html = renderToStaticMarkup(<GeneratedCard card={completed} onAction={onAction} onAdjust={() => undefined} />);
    expect(html).toContain("已提交");
    expect(html).toContain("已将选择发送给 Agent");
    expect(html).toContain("专注");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("以此调整");
    expect(html).not.toContain("已应用");
  });

  it("isolates unsupported versions and forbidden props without rendering a control", () => {
    const invalid = { ...card(), catalogVersion: 99 } as unknown as UiCardSnapshot;
    expect(renderToStaticMarkup(<GeneratedCard card={invalid} onAction={onAction} />)).toContain("此卡片暂不支持显示");
    const forbidden = card();
    forbidden.spec.elements.submit.props = { actionId: "server-issued-action", onClick: "run arbitrary code" };
    const html = renderToStaticMarkup(<GeneratedCard card={forbidden} onAction={onAction} />);
    expect(html).toContain("此卡片暂不支持显示");
    expect(html).not.toContain("run arbitrary code");
    expect(html).not.toContain("采用方案");
  });

  it("keeps original fallback text for a version-one card with an unsupported component", () => {
    const unsupported = card();
    unsupported.spec.elements.submit.type = "UnknownWidget" as never;
    const html = renderToStaticMarkup(<GeneratedCard card={unsupported} onAction={onAction} fallbackText={'方案原文\n<script>alert(1)</script>'} />);
    expect(html).toContain("方案原文\n&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("此卡片暂不支持显示");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("采用方案");
  });

  it("composes forms, tabs, comparison data and injected media using the shared catalog", () => {
    const spec: UiSpec = { root: "stack", elements: {
      stack: { type: "Stack", props: {}, children: ["grid", "chip", "text", "number", "select", "slider", "switch", "check", "tabs", "disclosure", "table", "chart", "media", "code", "submit"] },
      grid: { type: "Grid", props: { columns: 2 }, children: ["metric", "description"] },
      metric: { type: "Metric", props: { label: "预算", field: "budget", unit: "元" } },
      description: { type: "Text", props: { text: "方案预览", tone: "muted" } },
      chip: { type: "Chip", props: { text: "可调整", tone: "accent", variant: "soft" } },
      text: { type: "TextField", props: { field: "name", label: "名称", multiline: true } },
      number: { type: "NumberField", props: { field: "budget", label: "预算", min: 0 } },
      select: { type: "Select", props: { field: "mode", label: "模式", options: [{ value: "auto", label: "自动" }] } },
      slider: { type: "Slider", props: { field: "level", label: "亮度", min: 0, max: 100 } },
      switch: { type: "Switch", props: { field: "active", label: "启用" } },
      check: { type: "Checkbox", props: { field: "save", label: "保存方案" } },
      tabs: { type: "Tabs", props: { tabs: [{ id: "first", label: "预览" }, { id: "second", label: "详情" }] }, children: ["tab-first", "tab-second"] },
      "tab-first": { type: "Text", props: { text: "第一组内容" } },
      "tab-second": { type: "Text", props: { text: "第二组内容" } },
      disclosure: { type: "Disclosure", props: { title: "更多参数", defaultExpanded: true }, children: ["detail"] },
      detail: { type: "Text", props: { text: "展开的内容" } },
      table: { type: "Table", props: { columns: [{ key: "name", label: "方案" }, { key: "value", label: "数值" }], rows: [{ name: "方案一", value: 80 }], caption: "方案对比" } },
      chart: { type: "Chart", props: { type: "line", data: [{ label: "一月", value: 25 }, { label: "二月", value: 40 }], label: "数据趋势" } },
      media: { type: "Media", props: { assetId: "authorized-asset", alt: "图片预览" } },
      code: { type: "Code", props: { code: "const value = 1;", language: "typescript" } },
      submit: { type: "Button", props: { actionId: "server-issued-action" } },
    }, state: { values: { name: "客厅", budget: 300, mode: "auto" } } };
    const snapshot: UiCardSnapshot = { ...card(), cardId: "all-catalog-components", spec,
      actions: [{ id: "server-issued-action", label: "提交参数", kind: "submit", fields: getUiSpecFields(spec) }] };
    const html = renderToStaticMarkup(<GeneratedCard card={snapshot} onAction={onAction}
      renderMedia={({ assetId }) => <span>授权媒体：{assetId}</span>}
      renderCode={({ code }) => <pre>{code}</pre>} />);
    expect(html).toContain("300");
    expect(html).toContain("第一组内容");
    expect(html).toContain("展开的内容");
    expect(html).toContain("方案一");
    expect(html).toContain("数据趋势");
    expect(html).toContain("授权媒体：authorized-asset");
    expect(html).toContain("查看代码");
    expect(html).toContain('data-wide="true"');
    expect(html).not.toContain("此卡片暂不支持显示");
  });

  it("keeps generated code behind a named disclosure instead of filling the chat", () => {
    const snapshot: UiCardSnapshot = { ...card(), cardId: "code-preview", actions: [], spec: {
      root: "code", elements: { code: { type: "Code", props: {
        code: "const value = 1;", language: "typescript", fileName: "scene.ts",
      } } },
    } };
    const html = renderToStaticMarkup(<GeneratedCard card={snapshot} onAction={onAction} />);
    expect(html).toContain("scene.ts");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("const value = 1;");
    expect(html).not.toContain("moco-chat-code-toolbar");
  });
});
