/**
 * One glyph and color per issue source, so a row needs no "ONES ·" prefix to
 * say where its issues come from.
 */
import { Hexagon, SquareKanban, Webhook, type LucideIcon } from "lucide-react";
import type { SourceKind } from "../lib/integrations";

export const SOURCE_META: Record<SourceKind, { label: string; icon: LucideIcon; color: string }> = {
  ones: {
    label: "ONES",
    icon: Hexagon,
    // ratchet-allow: the ONES brand green, not Atlas's to choose.
    color: "#16a34a",
  },
  jira: {
    label: "Jira",
    icon: SquareKanban,
    // ratchet-allow: the Jira brand blue, not Atlas's to choose.
    color: "#2684ff",
  },
  custom: {
    label: "Custom",
    icon: Webhook,
    // ratchet-allow: a fixed hue so custom sources differ from both brands.
    color: "#a855f7",
  },
};

export function SourceIcon({ kind, size = 14 }: { kind: SourceKind; size?: number }) {
  const { icon: Icon, color, label } = SOURCE_META[kind];
  return <Icon size={size} color={color} className="shrink-0" aria-label={label} />;
}
