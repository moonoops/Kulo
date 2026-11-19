export type ComposerAction = "stop" | "configure" | "call" | "send";

export function resolveComposerAction({ busy, canStop, needsConfiguration, hasPayload, hasAttachments, canCall }: {
  busy: boolean;
  canStop: boolean;
  needsConfiguration: boolean;
  hasPayload: boolean;
  hasAttachments: boolean;
  canCall: boolean;
}): ComposerAction {
  if (busy) return canStop ? "stop" : "send";
  if (needsConfiguration) return "configure";
  if (!hasPayload && !hasAttachments && canCall) return "call";
  return "send";
}
