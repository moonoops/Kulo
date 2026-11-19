import type { SVGProps } from "react";
import { KULO_ICONS, type KuloIconName } from "./kulo-icons";

export function KuloIcon({
  name,
  filled: _filled = false,
  size = 20,
  className = "",
  ...props
}: {
  name: KuloIconName;
  filled?: boolean;
  size?: number;
} & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      className={`mc-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={KULO_ICONS[name]} />
    </svg>
  );
}
