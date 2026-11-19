import { useEffect, useState } from "react";

export function useComposerAttention(): HTMLTextAreaElement | null {
  const [target, setTarget] = useState<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const accept = (element: EventTarget | null) => setTarget(element instanceof HTMLTextAreaElement &&
      element.hasAttribute("data-kulo-companion-input") && !element.disabled ? element : null);
    const focus = (event: FocusEvent) => accept(event.target);
    const blur = (event: FocusEvent) => accept(event.relatedTarget);
    accept(document.activeElement);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    return () => { document.removeEventListener("focusin", focus); document.removeEventListener("focusout", blur); };
  }, []);
  return target?.isConnected ? target : null;
}
