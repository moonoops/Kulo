import { translate as tr, useI18n } from "../../kulo-i18n";
import "./thinking-indicator.css";

export function KuloThinkingIndicator({ className, size = "default", decorative = false, "aria-label": label = tr("思考中", "Thinking") }: {
  className?: string;
  size?: "default" | "compact";
  decorative?: boolean;
  "aria-label"?: string;
}) {
  useI18n();
  return <span className={["kulo-thinking-indicator", size === "compact" && "kulo-thinking-indicator--compact", className].filter(Boolean).join(" ")}
    role={decorative ? undefined : "status"} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}>
    <span className="kulo-thinking-plane" aria-hidden="true" />
    <span className="kulo-thinking-plane" aria-hidden="true" />
    <span className="kulo-thinking-plane" aria-hidden="true" />
  </span>;
}
