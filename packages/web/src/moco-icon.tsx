import type { SVGProps } from "react";
import { MOCO_ICONS, type MocoIconName } from "./moco-icons";

export function MocoIcon({
  name,
  filled: _filled = false,
  size = 20,
  className = "",
  ...props
}: {
  name: MocoIconName;
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
      <path d={MOCO_ICONS[name]} />
    </svg>
  );
}
