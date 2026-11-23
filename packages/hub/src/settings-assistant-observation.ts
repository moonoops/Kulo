import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ConversationView, ConversationWindow, Harness, Observation } from "@earendil-works/pi-durable";

export interface SettingsConversationObservation {
  readonly view: ConversationView;
  activate(): void;
  detach(): void;
}

/**
 * Attaches a synchronous conversation view observer so `view` always reflects committed
 * mutations immediately, while deferring side-effect callbacks until `activate()` is called.
 */
export async function attachSettingsConversationObservation(
  harness: Harness,
  conversationId: ConversationId,
  window: ConversationWindow,
  onChange: (view: ConversationView, observation: SettingsConversationObservation) => void,
): Promise<SettingsConversationObservation> {
  let active = false;
  let detached = false;
  let currentView: ConversationView | null = null;
  let attached: Observation<ConversationView> | null = null;

  const handle: SettingsConversationObservation = {
    get view() {
      return currentView ?? attached!.value;
    },
    activate() {
      if (!detached) active = true;
    },
    detach() {
      if (detached) return;
      detached = true;
      active = false;
      attached?.detach();
    },
  };

  attached = await harness.observeConversation(
    conversationId,
    {
      advance(call) {
        if (call.kind !== "value" || detached) return;
        currentView = call.value;
        if (!active) return;
        const nextView = call.value;
        queueMicrotask(() => {
          if (active && !detached) onChange(nextView, handle);
        });
      },
      end() {},
    },
    BACKGROUND_CONTEXT,
    window,
  );
  if (detached) attached.detach();
  return handle;
}
