import { translate as t } from "../../moco-i18n";

export async function copyDeviceTextWhenReady(value: Promise<string>, signal?: AbortSignal): Promise<void> {
  if (typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function") {
    // WebKit requires starting the clipboard write in the original press handler.
    const blob = value.then((text) => new Blob([text], { type: "text/plain" }));
    try {
      const write = navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      await Promise.all([blob, write]);
      return;
    } catch {
      await blob; // Surface issuance failure before attempting the text-only fallback.
    }
  }
  const text = await value;
  signal?.throwIfAborted();
  await copyDeviceText(text);
}

export async function copyDeviceText(value: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === "function") {
    await navigator.clipboard.writeText(value);
    return;
  }

  // LAN HTTP pages do not expose the asynchronous clipboard API.
  const previousFocus = document.activeElement;
  const field = document.createElement("textarea");
  field.value = value;
  field.tabIndex = -1;
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error(t("自动复制不可用，请选中内容复制", "Automatic copying is unavailable. Select the content and copy it."));
  } finally {
    field.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }
}
