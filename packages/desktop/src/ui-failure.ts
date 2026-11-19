export interface DesktopUiFailureContents {
  readonly mainFrame: { readonly origin: string };
  isDestroyed(): boolean;
  on(event: "console-message", listener: (details: {
    level: string; sourceId: string; frame: { readonly origin: string };
  }) => void): unknown;
  on(event: "did-start-navigation", listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

export function configureDesktopUiFailureHandler(options: {
  contents: DesktopUiFailureContents;
  rendererOrigin(): string | undefined;
  isBooting(): boolean;
  isQuitting(): boolean;
  failStartup(error: Error): void;
  recover(message: string): Promise<void>;
  checkFailed(): void;
}): void {
  const contents = options.contents;
  let epoch = 0, pending: number | undefined, reported: number | undefined;
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) { epoch++; pending = undefined; reported = undefined; }
  });
  // Page exceptions do not reach the preload's isolated-world window error listener.
  // Use Electron's native event, then inspect only the DOM; never forward error text.
  contents.on("console-message", (details) => {
    if (options.isQuitting() || contents.isDestroyed() || pending === epoch || reported === epoch ||
        details.level !== "error" || details.frame !== contents.mainFrame) return;
    const origin = options.rendererOrigin();
    if (!origin || details.frame.origin !== origin) return;
    try {
      const source = new URL(details.sourceId), trusted = new URL(origin);
      if (trusted.origin !== origin || trusted.protocol !== "http:" || trusted.hostname !== "127.0.0.1" ||
          trusted.username || trusted.password || source.origin !== origin || source.username || source.password) return;
    } catch { return; }
    const observedEpoch = epoch, frame = details.frame;
    const current = () => epoch === observedEpoch && !options.isQuitting() && !contents.isDestroyed() &&
      contents.mainFrame === frame && options.rendererOrigin() === origin && frame.origin === origin;
    pending = observedEpoch;
    // World 999 shares the stable preload's DOM bindings, isolated from customized JS globals.
    const code = `document.location.origin === ${JSON.stringify(origin)} && (() => { const root = document.getElementById("root"); return !root || root.childElementCount === 0; })()`;
    let check: Promise<unknown>;
    try { check = contents.executeJavaScriptInIsolatedWorld(999, [{ code }]); }
    catch { pending = undefined; if (current()) options.checkFailed(); return; }
    void check.then((blank) => {
      if (blank !== true || !current()) return;
      reported = observedEpoch;
      const message = "界面脚本错误后未能继续显示。";
      if (options.isBooting()) options.failStartup(new Error(message));
      else void options.recover(message);
    }, () => { if (current()) options.checkFailed(); }).finally(() => {
      if (pending === observedEpoch) pending = undefined;
    });
  });
}
