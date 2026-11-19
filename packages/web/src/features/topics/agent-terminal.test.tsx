import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProfileCard, AgentTerminal } from "./agent-terminal";
import * as voiceContext from "../voice/voice-context";

const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "agent-terminal.css"), "utf8");

afterEach(() => vi.restoreAllMocks());

describe("agent profile card", () => {
  it("uses the lightweight identity row as the only main chat entry", () => {
    const html = renderToStaticMarkup(<AgentProfileCard agentName="Moco" connected activity={{ state: "idle", label: "等待任务" }}
      selected onOpenChat={vi.fn()} />);
    const buttons = html.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('aria-label="更换 Moco 形象"');
    expect(buttons[0]).toContain('data-appearance="sunglasses"');
    expect(buttons[0]).not.toContain('aria-label="Moco 主会话"');
    expect(buttons[1]).toContain('aria-label="Moco 主会话"');
    expect(buttons[1]).toContain('aria-current="page"');
    expect(buttons[1]).not.toContain('moco-cat-avatar');
    expect(buttons[0]?.match(/<button\b/g)).toHaveLength(1);
    expect(html).toContain("主会话");
    expect(html).toContain("在线");
    expect(html).not.toContain("呼叫");
    expect(html).toContain('data-state="idle"');
    expect(html).not.toContain("moco-marmot-avatar");
    expect(html).not.toContain("<time");
    expect(html).not.toContain("等待任务");
    expect(html).not.toContain("moco-agent-profile-activity");
  });

  it("keeps main chat navigation available while disconnected without a call entry", () => {
    vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue(null);
    const html = renderToStaticMarkup(<AgentTerminal agentName="Moco" connected={false} entries={[]} onAgentClick={vi.fn()} onOpenCallTopic={vi.fn()} />);
    expect(html).toContain('aria-label="Moco 主会话"');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("设置语音通话");
    expect(html).toContain("重连中");
    expect(html).not.toContain('role="dialog"');
  });

  it.each([true, false])("prevents restarting an ended call while recording=%s", (recordingActive) => {
    const context = {
      recordingActive, loading: false, snapshot: null,
      call: { call: { target: { topicId: "root", title: "与 Moco 对话" }, state: "ended", muted: false, minimized: false, captionsEnabled: false, captions: [], error: "连接已断开" },
        start: vi.fn(), hangup: vi.fn(), minimize: vi.fn(), expand: vi.fn(), toggleMute: vi.fn(), toggleCaptions: vi.fn() },
    } as unknown as voiceContext.VoiceWorkspace;
    vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue(context);
    const html = renderToStaticMarkup(<AgentTerminal agentName="Moco" connected entries={[]} onAgentClick={vi.fn()} onOpenCallTopic={vi.fn()} />);
    const retry = html.match(/<button\b[^>]*aria-label="重新通话"[^>]*>/)?.[0];
    expect(retry).toBeDefined();
    expect(retry!.includes('disabled=""')).toBe(recordingActive);
    expect(html).toContain('aria-label="关闭通话"');
  });

  it("keeps the main chat entry separate from an ordinary topic's active call", () => {
    const context = { call: { call: { target: { topicId: "design", title: "界面设计" }, state: "speaking", startedAt: Date.now(), muted: false, minimized: false, captionsEnabled: true, captions: [] } } } as unknown as voiceContext.VoiceWorkspace;
    vi.spyOn(voiceContext, "useVoiceWorkspace").mockReturnValue(context);
    const html = renderToStaticMarkup(<AgentTerminal agentName="Moco" connected entries={[]} mainChatSelected onAgentClick={vi.fn()} onOpenCallTopic={vi.fn()} />);
    expect(html).toContain('aria-label="Moco 主会话"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("界面设计");
    expect(html).toContain('aria-label="挂断通话"');
    expect(html).toContain('data-state="speaking"');
    expect(html).not.toContain('role="dialog"');
  });

  it("stretches the main chat button across the card while layering the avatar picker above only the avatar", () => {
    const header = css.match(/\.moco-agent-profile-header\s*\{([^}]+)\}/)?.[1] ?? "";
    const trigger = css.match(/\.moco-agent-profile-header\s*>\s*\.moco-cat-picker-trigger\s*\{([^}]+)\}/)?.[1] ?? "";
    const overview = css.match(/\.moco-agent-profile-overview\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(header).toMatch(/\bdisplay:\s*grid\b/);
    expect(trigger).toMatch(/\bgrid-area:\s*1\s*\/\s*1\b/);
    expect(trigger).toMatch(/\bz-index:\s*1\b/);
    expect(overview).toMatch(/\bgrid-area:\s*1\s*\/\s*1\b/);
    expect(overview).toMatch(/\bwidth:\s*100%;/);
    expect(overview).toContain("padding-inline-start: calc(var(--moco-space-3) * 2 + 64px)");
    expect(css).toContain(".moco-agent-profile-header:has(> .moco-agent-profile-overview:hover)");
    expect(css).toContain('.moco-agent-profile-header:has(> .moco-agent-profile-overview[data-hovered="true"])');
    expect(css).toContain(".moco-agent-profile-header:has(> .moco-agent-profile-overview:active)");
    expect(css).toContain('.moco-agent-profile-header:has(> .moco-agent-profile-overview[data-pressed="true"])');
    expect(css).not.toMatch(/\.moco-agent-profile-header:has\([^)]*moco-cat-picker-trigger/);
  });
});
