import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "@kulo/protocol";
import { MessageContent } from "./message-content";
import { registerMedia } from "./media-message";
import { VoiceMessage, voiceBubbleWidth, voiceDuration } from "./voice-message";

const voice: ChatAttachment = { id: "voice", name: "语音消息.m4a", kind: "audio", presentation: "voice", url: "/api/uploads/voice", mimeType: "audio/mp4", size: 12000, recordedDuration: 7.2 };

describe("voice message presentation", () => {
  it("uses compact bubbles only for a user's recorded voice", () => {
    const user = renderToStaticMarkup(<MessageContent item={{ id: 1, role: "user", text: "", attachments: [voice] }} />);
    expect(user).toContain("kulo-voice-message");
    expect(user).not.toContain("kulo-chat-audio");
    expect(user).not.toContain("kulo-chat-media-title");
    expect(user).not.toContain("播放速度");
    expect(user).not.toContain("音量");
    const ordinaryAudio = renderToStaticMarkup(<MessageContent item={{ id: 2, role: "user", text: "", attachments: [{ ...voice, presentation: undefined }] }} />);
    expect(ordinaryAudio).toContain("kulo-chat-audio");
    expect(ordinaryAudio).not.toContain("kulo-voice-message");
    const assistant = renderToStaticMarkup(<MessageContent item={{ id: 3, role: "assistant", text: "", attachments: [voice] }} />);
    expect(assistant).toContain("kulo-chat-audio");
    expect(assistant).not.toContain("kulo-voice-message");
  });

  it("marks timer duration as approximate until actual metadata is available", () => {
    expect(voiceDuration(voice)).toEqual({ seconds: 7.2, approximate: true });
    expect(voiceDuration({ ...voice, duration: 6.8 })).toEqual({ seconds: 6.8, approximate: false });
    expect(voiceDuration({ ...voice, duration: 6.8 }, 6.7)).toEqual({ seconds: 6.7, approximate: false });
    expect(voiceDuration({ duration: NaN, recordedDuration: 4 }, Infinity)).toEqual({ seconds: 4, approximate: true });
    expect(voiceDuration({ duration: -1, recordedDuration: NaN })).toEqual({ seconds: 0, approximate: false });
    const estimated = renderToStaticMarkup(<VoiceMessage asset={voice} />);
    expect(estimated).toContain("约 8″");
    expect(estimated).toContain('aria-label="播放语音，约8秒"');
    const probed = renderToStaticMarkup(<VoiceMessage asset={{ ...voice, duration: 6.5 }} />);
    expect(probed).not.toContain("约");
    expect(probed).toContain("7″");
  });

  it("keeps duration-based widths bounded and never autoplays", () => {
    expect(voiceBubbleWidth(0)).toBe(120);
    expect(voiceBubbleWidth(10)).toBeGreaterThan(voiceBubbleWidth(2));
    expect(voiceBubbleWidth(1000)).toBe(260);
    expect(voiceBubbleWidth(Infinity)).toBe(120);
    const html = renderToStaticMarkup(<VoiceMessage asset={voice} />);
    expect(html).toContain("kulo-voice-bubble");
    expect(html).toContain('<audio src="/api/uploads/voice"');
    expect(html).toContain('hidden=""');
    expect(html).not.toMatch(/autoPlay|autoplay/);
    expect(html).toContain('aria-pressed="false"');
  });
});

class TestMedia extends EventTarget {
  currentTime = 0;
  duration = 20;
  readyState = 1;
  paused = true;
  ended = false;
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event("pause")); });
}

describe("shared playback position", () => {
  const releases: Array<() => void> = [];
  const register = (media: TestMedia, key: string) => { const release = registerMedia(media as unknown as HTMLMediaElement, key); releases.push(release); return release; };
  afterEach(() => { for (const release of releases.splice(0)) release(); });

  it("restores a remounted player without starting playback and keeps topics separate", () => {
    const first = new TestMedia();
    const release = register(first, "voice-position:topic-one");
    first.currentTime = 4.5; first.dispatchEvent(new Event("timeupdate")); release();
    const restored = new TestMedia(); register(restored, "voice-position:topic-one");
    expect(restored.currentTime).toBe(4.5);
    expect(restored.paused).toBe(true);
    const otherTopic = new TestMedia(); register(otherTopic, "voice-position:topic-two");
    expect(otherTopic.currentTime).toBe(0);
    const firstTopic = new TestMedia(); const leaveTopic = register(firstTopic, "voice-position:same-node-one");
    firstTopic.currentTime = 3; firstTopic.dispatchEvent(new Event("timeupdate")); leaveTopic();
    register(firstTopic, "voice-position:same-node-two");
    expect(firstTopic.currentTime).toBe(0);
  });

  it("does not erase a saved position during resource reload", () => {
    const media = new TestMedia(); register(media, "voice-position:reload");
    media.currentTime = 6; media.dispatchEvent(new Event("timeupdate"));
    media.readyState = 0; media.currentTime = 0; media.dispatchEvent(new Event("timeupdate"));
    media.readyState = 1; media.dispatchEvent(new Event("loadedmetadata"));
    expect(media.currentTime).toBe(6);
  });

  it("clears a completed recording so replay begins at the start", () => {
    const finished = new TestMedia(); const release = register(finished, "voice-position:completed");
    finished.currentTime = 5; finished.dispatchEvent(new Event("timeupdate"));
    finished.ended = true; finished.currentTime = finished.duration; finished.dispatchEvent(new Event("ended")); release();
    const replay = new TestMedia(); register(replay, "voice-position:completed");
    expect(replay.currentTime).toBe(0);
  });
});
