import { flushSync } from "react-dom";

let activeTransition: ViewTransition | null = null;

export function interruptSettingsTransition(): void {
  activeTransition?.skipTransition();
  activeTransition = null;
  delete document.documentElement.dataset.kuloTransition;
}

export function transitionSettingsLayout(direction: "enter" | "exit", update: () => void): void {
  const root = document.documentElement;
  interruptSettingsTransition();

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    root.dataset.reduceMotion === "true";
  if (reduceMotion || !window.matchMedia("(min-width: 1060px)").matches ||
    typeof document.startViewTransition !== "function") {
    flushSync(update);
    return;
  }

  root.dataset.kuloTransition = direction;
  const transition = document.startViewTransition(() => {
    // React must commit before the browser captures the destination conversation.
    flushSync(update);
  });
  activeTransition = transition;

  const finish = () => {
    if (activeTransition !== transition) return;
    activeTransition = null;
    delete root.dataset.kuloTransition;
  };
  void transition.ready.catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.error("无法播放设置页面过渡。", error);
    }
  });
  void transition.finished.then(finish, (error: unknown) => {
    finish();
    console.error("设置页面过渡未完成。", error);
  });
}
