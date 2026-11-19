import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { settingsSaveActivity } from "./settings-save-activity";

type NavigationIntent = { action: () => void; onCancelled?: () => void };

/** Blur commits finish before navigation decides whether a draft still needs confirmation. */
export function useSettingsNavigation(dirty: boolean, active = true) {
  const saving = useSyncExternalStore(settingsSaveActivity.subscribe, settingsSaveActivity.getSnapshot, settingsSaveActivity.getServerSnapshot);
  const [waiting, setWaiting] = useState<NavigationIntent | null>(null);
  const [confirmation, setConfirmation] = useState<NavigationIntent | null>(null);
  const waitingRef = useRef(waiting);
  const confirmationRef = useRef(confirmation);
  const status = useRef({ dirty, active });
  status.current = { dirty, active };

  const navigate = useCallback((action: () => void, onCancelled?: () => void) => {
    waitingRef.current?.onCancelled?.();
    confirmationRef.current?.onCancelled?.();
    confirmationRef.current = null;
    setConfirmation(null);
    const intent = { action, onCancelled };
    waitingRef.current = intent;
    setWaiting(intent);
  }, []);

  useEffect(() => {
    if (!waiting || saving) return;
    // Child editors may report dirty through more than one parent effect.
    const timer = setTimeout(() => {
      if (waitingRef.current !== waiting || settingsSaveActivity.getSnapshot()) return;
      waitingRef.current = null;
      setWaiting(null);
      if (status.current.active && status.current.dirty) {
        confirmationRef.current = waiting;
        setConfirmation(waiting);
      } else waiting.action();
    }, 0);
    return () => clearTimeout(timer);
  }, [waiting, saving, dirty, active]);

  const cancel = useCallback(() => {
    const intent = confirmationRef.current;
    confirmationRef.current = null;
    setConfirmation(null);
    intent?.onCancelled?.();
  }, []);

  const discard = useCallback(() => {
    const intent = confirmationRef.current;
    confirmationRef.current = null;
    setConfirmation(null);
    intent?.action();
  }, []);

  return { navigate, needsConfirmation: Boolean(confirmation), cancel, discard, saving };
}
