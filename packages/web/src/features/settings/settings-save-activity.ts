import { useLayoutEffect, useRef } from "react";

export function createSettingsSaveActivity() {
  const pending = new Set<symbol>();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => pending.size > 0,
    getServerSnapshot: () => false,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setPending(key: symbol, active: boolean) {
      const wasPending = pending.size > 0;
      if (active) pending.add(key); else pending.delete(key);
      if (wasPending !== (pending.size > 0)) for (const listener of listeners) listener();
    },
  };
}

export const settingsSaveActivity = createSettingsSaveActivity();

/** Register writes before the next navigation event, including blur-triggered commits. */
export function useSettingsPending(pending: boolean) {
  const key = useRef(Symbol("settings-save"));
  useLayoutEffect(() => {
    settingsSaveActivity.setPending(key.current, pending);
    return () => { settingsSaveActivity.setPending(key.current, false); };
  }, [pending]);
}
