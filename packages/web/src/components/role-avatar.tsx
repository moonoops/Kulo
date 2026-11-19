import { Avatar } from "@heroui/react";
import { KuloIcon } from "../kulo-icon";
import type { KuloIconName } from "../kulo-icons";

const ROLE_ICONS: Readonly<Record<string, KuloIconName>> = {
  scout: "search",
  architect: "psychology",
  coder: "task-alt",
  checker: "shield",
  designer: "palette",
  writer: "edit",
};

export function RoleAvatar({
  roleId,
  label,
  size = "md",
  quiet = false,
}: {
  roleId?: string;
  label: string;
  size?: "sm" | "md" | "lg";
  quiet?: boolean;
}) {
  const iconName = roleId ? ROLE_ICONS[roleId] : undefined;
  const fallbackChar = [...(label.trim() || roleId || "W")][0]?.toUpperCase() ?? "W";

  if (quiet && iconName) {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center text-foreground" aria-label={label}>
        <KuloIcon name={iconName} size={22} />
      </span>
    );
  }

  return (
    <Avatar size={size} variant="soft" color={quiet ? "default" : "accent"} className="shrink-0">
      <Avatar.Fallback aria-label={label}>
        {iconName ? (
          <KuloIcon name={iconName} size={size === "sm" ? 15 : size === "lg" ? 22 : 18} />
        ) : (
          <span className="text-xs font-semibold">{fallbackChar}</span>
        )}
      </Avatar.Fallback>
    </Avatar>
  );
}
