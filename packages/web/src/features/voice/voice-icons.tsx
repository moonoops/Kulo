import type { SVGProps } from "react";
import { KuloIcon } from "../../kulo-icon";

type VoiceIconName = "phone" | "message" | "hangup" | "microphone" | "muted" | "captions" | "minimize" | "speaker";

export function VoiceIcon({ name, size = 20, ...props }: { name: VoiceIconName; size?: number } & SVGProps<SVGSVGElement>) {
  return <KuloIcon name={name} size={size} {...props} />;
}
