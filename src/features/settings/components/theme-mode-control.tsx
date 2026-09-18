import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import type { ThemeMode } from "@/features/theme/mode";

const OPTIONS: { id: ThemeMode; label: string; icon: LucideIcon }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

/** Settings → Appearance: Light / Dark / System. Applies to both the interface
 *  and the editor theme tabs, which is why it sits above them. */
export function ThemeModeControl() {
  const themeMode = useProjectStore((s) => s.settings.themeMode);
  const { updateSettings } = useProjectStore.use.actions();

  return (
    <div
      role="radiogroup"
      aria-label="Appearance mode"
      className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-border-default p-0.5"
    >
      {OPTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={themeMode === id}
          onClick={() => updateSettings({ themeMode: id })}
          className={cn(
            "flex h-5 cursor-pointer items-center gap-1 rounded px-2 text-[11px] transition-colors",
            themeMode === id
              ? "bg-bg-active text-text-primary"
              : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary",
          )}
        >
          <Icon size={11} />
          {label}
        </button>
      ))}
    </div>
  );
}
