/// <reference types="vite/client" />
import { StrictMode, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { Toast } from "@heroui/react";
import { I18nProvider } from "react-aria-components";
import "./moco.css";
import { App } from "./App";
import { useI18n } from "./moco-i18n";
import { installNavigationMotion } from "./features/shell/navigation-motion";

let desktopReadyReported = false;

function MocoApplication() {
  const { locale } = useI18n();
  useLayoutEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useLayoutEffect(() => installNavigationMotion(), []);
  useEffect(() => {
    if (desktopReadyReported || !window.mocoDesktop?.ready) return;
    desktopReadyReported = true;
    void window.mocoDesktop.ready().catch((error: unknown) => {
      console.error("[MocoStartup] Unable to acknowledge the application mount", error);
    });
  }, []);
  return <I18nProvider locale={locale}>
    <Toast.Provider placement="bottom end" />
    <App />
  </I18nProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MocoApplication />
  </StrictMode>,
);

if (import.meta.env.PROD) {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    console.warn("[MocoOffline] Offline refresh needs HTTPS or a local address and Service Worker support");
  } else {
    const registerOfflineShell = () => {
      void navigator.serviceWorker.register("/moco-offline.js", { scope: "/", updateViaCache: "none" }).catch((error: unknown) => {
        console.warn("[MocoOffline] Unable to register the offline shell", error);
      });
    };
    if (document.readyState === "complete") registerOfflineShell();
    else window.addEventListener("load", registerOfflineShell, { once: true });
  }
}
