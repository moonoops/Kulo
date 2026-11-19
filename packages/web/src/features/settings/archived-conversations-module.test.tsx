import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MocoSettingsView, TopicSummary } from "@moco/protocol";
import { ArchivedConversationsModule } from "./archived-conversations-module";
import { MocoSettingsBoard } from "../../moco-settings";

function topic(id: string, patch: Partial<TopicSummary> = {}): TopicSummary {
  return { id, conversationId: 2, title: id, archived: true, createdAt: 1, updatedAt: 2, ...patch };
}

describe("archived conversations settings", () => {
  it("lists ordinary and project topics with independent named restore actions and excludes the primary conversation", () => {
    const html = renderToStaticMarkup(<ArchivedConversationsModule loaded connected topics={[
      topic("普通归档话题"), topic("项目归档话题", { projectId: "project-1" }),
      topic("活跃话题", { archived: false }), topic("已删除话题", { deletedAt: 3 }),
      topic("root", { title: "主会话" }), topic("其他主会话", { master: true }),
    ]} projects={[{ id: "project-1", name: "照明项目" }]} />);
    for (const text of ["标题", "所属", "操作", "普通归档话题", "项目归档话题", "照明项目"]) expect(html).toContain(text);
    for (const text of ["活跃话题", "已删除话题", "主会话", "其他主会话"]) expect(html).not.toContain(text);
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const name of ["普通归档话题", "项目归档话题"]) {
      expect(buttons.find((button) => button.includes(`还原“${name}”`))).not.toContain('disabled=""');
    }
    expect(html).toContain("moco-settings-table-scroll");
    expect(html).not.toContain('aria-selected="true"');
  });

  it("retains the list but disables restore while disconnected", () => {
    const html = renderToStaticMarkup(<ArchivedConversationsModule loaded connected={false} topics={[topic("离线归档")]} projects={[]} />);
    expect(html).toContain("与中枢连接已断开");
    expect(html).toContain("离线归档");
    expect(html.match(/<button\b[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("distinguishes the initial load from an empty archive", () => {
    const loading = renderToStaticMarkup(<ArchivedConversationsModule connected loaded={false} topics={[]} projects={[]} />);
    expect(loading).toContain("加载中");
    expect(loading).not.toContain("暂无已归档会话");
    const empty = renderToStaticMarkup(<ArchivedConversationsModule connected loaded topics={[]} projects={[]} />);
    expect(empty).toContain("暂无已归档会话");
    expect(empty).not.toContain("加载中");
  });

  it("receives ordinary and project history through the settings board", () => {
    const html = renderToStaticMarkup(<MocoSettingsBoard module="archives" settings={{} as MocoSettingsView} envs={[]}
      topics={[topic("设置页归档", { projectId: "project-1" })]} projects={[{ id: "project-1", name: "设置页项目" }]}
      topicsLoaded onSettingsUpdated={() => {}} />);
    expect(html).toContain("设置页归档");
    expect(html).toContain("设置页项目");
  });

  it("surfaces snapshot load failures with a retry action instead of spinning forever", () => {
    const html = renderToStaticMarkup(<MocoSettingsBoard module="archives" settings={{} as MocoSettingsView} envs={[]}
      topics={[]} projects={[]} topicsLoaded={false} snapshotError="本地会话存储连接异常，请重启 Moco 后重试。"
      onSnapshotRefresh={() => {}} onSettingsUpdated={() => {}} />);
    expect(html).toContain("本地会话存储连接异常，请重启 Moco 后重试。");
    expect(html).toContain("重试");
    expect(html).not.toContain("加载中");
  });
});
