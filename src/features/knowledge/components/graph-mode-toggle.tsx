import { Square, Orbit } from "lucide-react";
import { cn } from "@/lib/utils";

/** Flat (2D force graph) or 3D (solar-system orbits). */
export type GraphMode = "2d" | "3d";

/** Two-button Flat / 3D segmented switch. Matches `KbScopeToggle`'s sizing so
 *  the two sit level on opposite corners of the graph. */
export function GraphModeToggle({
  mode,
  onChange,
}: {
  mode: GraphMode;
  onChange: (m: GraphMode) => void;
}) {
  return (
    <div
      className="flex items-center rounded border border-border-subtle overflow-hidden shrink-0"
      style={{ height: 18 }}
    >
      {(
        [
          ["2d", Square, "Flat", "Force-directed 2D graph"],
          ["3d", Orbit, "3D", "Solar-system view — linked notes orbit their hubs"],
        ] as const
      ).map(([value, Icon, label, title]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          title={title}
          className={cn(
            "flex items-center gap-1 px-1.5 h-full text-3xs font-semibold uppercase tracking-wider transition-colors cursor-pointer",
            mode === value
              ? "text-foreground"
              : "text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground",
          )}
          style={{ background: mode === value ? "var(--atlas-element-active)" : undefined }}
        >
          <Icon size={9} strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  );
}
