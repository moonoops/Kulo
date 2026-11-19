interface ComposerKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function isMacComposerPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function composerEnterAction(event: ComposerKey, platform: string): "send" | "newline" | undefined {
  if (event.key !== "Enter") return undefined;
  if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) return "newline";
  const newlineModifier = isMacComposerPlatform(platform)
    ? event.altKey && !event.ctrlKey
    : event.ctrlKey && !event.altKey;
  if (newlineModifier && !event.shiftKey && !event.metaKey) return "newline";
  if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) return "send";
  return undefined;
}

export function insertComposerNewline(text: string, start: number, end: number): { text: string; caret: number } {
  return { text: `${text.slice(0, start)}\n${text.slice(end)}`, caret: start + 1 };
}
