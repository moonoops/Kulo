export function composerDraftKey(topicId: string, ticketId?: string): string {
  return ticketId ? "ticket:" + ticketId : "topic:" + topicId;
}

export function restoreComposerDraft(
  drafts: Record<string, string>,
  key: string,
  text: string,
): Record<string, string> {
  return { ...drafts, [key]: drafts[key] ? (text + "\n" + drafts[key]).trim() : text };
}

export interface TaskChatReturn {
  topicId: string;
  top: number;
  requested: boolean;
}

export function resolveTaskChatReturn(
  captured: TaskChatReturn | null,
  topicId: string,
  projectionOpen: boolean,
  settingsOpen: boolean,
): { captured: TaskChatReturn | null; restore: TaskChatReturn | null } {
  if (!captured || settingsOpen || captured.topicId !== topicId) {
    return { captured: null, restore: null };
  }
  if (projectionOpen) return { captured, restore: null };
  return { captured: null, restore: captured.requested ? captured : null };
}

export function restoredChatScroll(top: number, scrollHeight: number, clientHeight: number) {
  const scrollTop = Math.max(0, Math.min(top, scrollHeight - clientHeight));
  const distance = Math.max(0, scrollHeight - clientHeight - scrollTop);
  return { scrollTop, nearBottom: distance < 120, showToBottom: distance > 180 };
}
