import { translate as t } from "../../kulo-i18n";

export function isMicrophonePermissionFailure(cause: unknown): boolean {
  return cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError");
}

export function microphonePermissionFailureMessage(): string {
  return t("麦克风访问未获允许", "Microphone access is not allowed");
}
