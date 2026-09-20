import { Globe, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KbScope } from "../stores/kb-scope-store";

/** Two-button Global / View segmented switch. Sized to sit in a header row
 *  next to the 22×22 icon buttons the KB sidebar and the graph already use. */
export function KbScopeToggle({
  scope,
  onChange,
  globalTitle = "Global knowledge base",
  viewTitle = "This workspace's knowledge base",
}: {
  scope: KbScope;
  onChange: (s: KbScope) => void;
  globalTitle?: string;
  viewTitle?: string;
}) {
  return (
    <div
      className="flex items-center rounded border border-border-subtle overflow-hidden mr-1 shrink-0"
      style={{ height: 18 }}
    >
      {(
        [
          ["global", Globe, "Global", globalTitle],
          ["view", Eye, "View", viewTitle],
        ] as const
      ).map(([value, Icon, label, title]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          title={title}
          className={cn(
            "flex items-center gap-1 px-1.5 h-full text-[9px] font-semibold uppercase tracking-wider transition-colors cursor-pointer",
            scope === value
              ? "text-text-primary"
              : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary",
          )}
          style={{ background: scope === value ? "var(--bg-active)" : undefined }}
        >
          <Icon size={9} strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  );
}
