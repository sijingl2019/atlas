/**
 * Render a project's stored glyph: a lucide icon (a `PROJECT_ICON_MAP` key),
 * a raw emoji character, or the plain folder fallback. Shared by the sidebar
 * row and the picker's trigger tile so a choice previews exactly as it lands.
 */
import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { projectIcon } from "../lib/project-icons";

export function ProjectGlyph({
  icon,
  color,
  size = 13,
  muted = "text-[var(--muted-foreground)]",
  className,
}: {
  icon: string | null | undefined;
  /** Explicit tint; when null the glyph inherits `muted`. */
  color?: string | null;
  size?: number;
  /** Tone used when no explicit colour is set. */
  muted?: string;
  className?: string;
}) {
  const Glyph = projectIcon(icon);
  // A chosen value that is not a registry key is an emoji (or any other
  // character the user typed) - render it verbatim.
  if (icon && !Glyph) {
    return (
      <span className={cn("shrink-0 leading-none", className)} style={{ fontSize: size + 2 }}>
        {icon}
      </span>
    );
  }
  const Icon = Glyph ?? Folder;
  return (
    <Icon
      size={size}
      style={color ? { color } : undefined}
      className={cn("shrink-0", color ? undefined : muted, className)}
    />
  );
}
