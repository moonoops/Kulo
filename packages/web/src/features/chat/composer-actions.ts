export type ComposerAction = "stop" | "configure" | "call" | "send";

export interface ComposerActionState {
  busy: boolean;
  canStop: boolean;
  allowBusySend?: boolean;
  needsConfiguration: boolean;
  hasPayload: boolean;
  hasAttachments: boolean;
  canCall: boolean;
}

export interface ResolvedComposerActions {
  primary: ComposerAction;
  showStop: boolean;
}

export function resolveComposerActions({
  busy,
  canStop,
  allowBusySend = true,
  needsConfiguration,
  hasPayload,
  hasAttachments,
  canCall,
}: ComposerActionState): ResolvedComposerActions {
  if (busy) {
    if (needsConfiguration) return { primary: canStop ? "stop" : "configure", showStop: false };
    if (allowBusySend && (hasPayload || hasAttachments)) {
      return { primary: "send", showStop: canStop };
    }
    return { primary: canStop ? "stop" : "send", showStop: false };
  }
  if (needsConfiguration) return { primary: "configure", showStop: false };
  if (!hasPayload && !hasAttachments && canCall) return { primary: "call", showStop: false };
  return { primary: "send", showStop: false };
}

export function resolveComposerAction(state: ComposerActionState): ComposerAction {
  return resolveComposerActions(state).primary;
}
