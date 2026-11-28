import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Disclosure } from "@heroui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolActionMeta } from "@kulo/protocol";
import { ChatToolStepList, type ChatToolCallItem } from "./tool-step-list";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.cells)) {
        hooks.cells[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      return [
        hooks.cells[index],
        (value: unknown) => {
          hooks.cells[index] =
            typeof value === "function" ? (value as (prev: unknown) => unknown)(hooks.cells[index]) : value;
        },
      ];
    },
  };
});

vi.mock("../../kulo-i18n", () => ({
  useI18n: () => ({ language: "zh-CN" as const, locale: "zh-CN" as const, setLanguage: vi.fn(), t: (zh: string) => zh }),
  translate: (zh: string) => zh,
}));

function step(id: string, name: string, actionMeta: ToolActionMeta): ChatToolCallItem {
  return { id, name, argsSummary: "{}", actionMeta };
}

function findElements<P>(tree: ReactNode, type: unknown): ReactElement<P>[] {
  const results: ReactElement<P>[] = [];
  const visit = (value: ReactNode) => {
    for (const node of Array.isArray(value) ? value : [value]) {
      if (Array.isArray(node)) {
        visit(node);
        continue;
      }
      if (!isValidElement<{ children?: ReactNode }>(node)) continue;
      if (node.type === type) results.push(node as ReactElement<P>);
      visit(node.props.children);
    }
  };
  visit(tree);
  return results;
}

describe("ChatToolStepList click-to-expand interaction", () => {
  beforeEach(() => {
    hooks.cells = [];
    hooks.cursor = 0;
  });

  it("toggles folded read group in place on click and preserves expansion when later non-read steps arrive", () => {
    const readCalls = [
      step("c1", "web_search", { category: "read", labelKey: "web_search", targetLabel: "Kulo", status: "ok" }),
      step("c2", "web_fetch", { category: "read", labelKey: "web_fetch", targetLabel: "example.com", status: "ok" }),
      step("c3", "read", { category: "read", labelKey: "read", targetLabel: "app.ts", status: "ok" }),
    ];

    const renderList = (toolCalls: readonly ChatToolCallItem[]) => {
      hooks.cursor = 0;
      return ChatToolStepList({ toolCalls, language: "zh-CN" });
    };

    const initial = renderList(readCalls);
    const disclosures = findElements<ComponentProps<typeof Disclosure>>(initial, Disclosure);
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]!.props.isExpanded).toBe(false);

    // Click to expand in place.
    disclosures[0]!.props.onExpandedChange?.(true);
    const expandedTree = renderList(readCalls);
    const expandedDisclosures = findElements<ComponentProps<typeof Disclosure>>(expandedTree, Disclosure);
    expect(expandedDisclosures[0]!.props.isExpanded).toBe(true);

    // A subsequent write step arrives: read-group:c1 keeps its key & expanded state intact.
    const withWrite = renderList([
      ...readCalls,
      step("w1", "bash", { category: "write", labelKey: "bash", status: "running" }),
    ]);
    const disclosuresAfterWrite = findElements<ComponentProps<typeof Disclosure>>(withWrite, Disclosure);
    expect(disclosuresAfterWrite).toHaveLength(1);
    expect(disclosuresAfterWrite[0]!.props.isExpanded).toBe(true);

    // Click again to collapse back to a single summary row.
    disclosuresAfterWrite[0]!.props.onExpandedChange?.(false);
    const collapsedAgain = renderList(readCalls);
    expect(findElements<ComponentProps<typeof Disclosure>>(collapsedAgain, Disclosure)[0]!.props.isExpanded).toBe(false);
  });
});
