/**
 * Project icon picker: a small popover with an Icons/Emoji tab pair, a search
 * field, one row of colour swatches, and a glyph grid.
 *
 * Controlled: the caller owns `icon`/`color` and re-renders on every pick, so
 * the dialog can preview the choice live in its header tile. Radix Popover
 * handles anchoring, outside-click dismissal and Esc.
 */
import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { PROJECT_COLORS, PROJECT_ICONS } from "../lib/project-icons";
import { ProjectGlyph } from "./project-glyph";

/** A short, opinionated emoji set: enough to feel personal without pulling in
 *  a full emoji-mart. Grouped by keyword so the search box has something to
 *  match against. */
const EMOJI: Array<{ char: string; keywords: string }> = [
  { char: "🚀", keywords: "rocket launch ship deploy" },
  { char: "✨", keywords: "sparkles magic new shine" },
  { char: "🔥", keywords: "fire hot flame trending" },
  { char: "⭐", keywords: "star favourite favorite" },
  { char: "💡", keywords: "idea bulb think insight" },
  { char: "🎨", keywords: "art design paint palette" },
  { char: "💻", keywords: "computer laptop code dev" },
  { char: "📚", keywords: "book read docs library" },
  { char: "📄", keywords: "file document page" },
  { char: "📁", keywords: "folder directory files" },
  { char: "📅", keywords: "calendar date schedule" },
  { char: "🛠️", keywords: "tool wrench fix build" },
  { char: "⚙️", keywords: "gear settings config" },
  { char: "🔨", keywords: "hammer build construct" },
  { char: "🐛", keywords: "bug debug issue defect" },
  { char: "🌿", keywords: "leaf plant nature eco" },
  { char: "🌳", keywords: "tree nature growth" },
  { char: "🌍", keywords: "earth globe world" },
  { char: "🌐", keywords: "globe web network" },
  { char: "📦", keywords: "package box module library" },
  { char: "🔄", keywords: "refresh sync loop cycle" },
  { char: "⚡", keywords: "bolt zap fast energy" },
  { char: "🛡️", keywords: "shield secure guard" },
  { char: "🔐", keywords: "key lock auth secure" },
  { char: "📊", keywords: "chart graph data stats" },
  { char: "📈", keywords: "chart analytics growth" },
  { char: "💰", keywords: "money finance cash" },
  { char: "🎵", keywords: "music audio sound" },
  { char: "📷", keywords: "camera photo capture" },
  { char: "🎬", keywords: "film movie video" },
  { char: "🎮", keywords: "game gamepad play" },
  { char: "🏠", keywords: "home house" },
  { char: "☕", keywords: "coffee break drink" },
  { char: "🧠", keywords: "brain mind ai think" },
  { char: "❤️", keywords: "heart love favourite" },
  { char: "✅", keywords: "check done task complete" },
];

type Tab = "icons" | "emoji";

export function ProjectIconPicker({
  icon,
  color,
  onIconChange,
  onColorChange,
}: {
  icon: string | null;
  color: string | null;
  onIconChange: (icon: string | null) => void;
  onColorChange: (color: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("icons");
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const icons = useMemo(
    () =>
      q ? PROJECT_ICONS.filter((i) => i.key.includes(q) || i.keywords.includes(q)) : PROJECT_ICONS,
    [q],
  );
  const emojis = useMemo(
    () => (q ? EMOJI.filter((e) => e.keywords.includes(q) || e.char === query.trim()) : EMOJI),
    [q, query],
  );

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset the search on close so reopening always starts at the top.
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger
        render={
          <button
            type="button"
            title="Change icon"
            aria-label="Change icon"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--atlas-panel-input-background)] transition-colors hover:border-[var(--atlas-border-strong)] cursor-pointer"
          >
            <ProjectGlyph
              icon={icon}
              color={color}
              size={16}
              muted="text-[var(--secondary-foreground)]"
            />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className="w-[292px] rounded-xl border border-[var(--border)] bg-[var(--popover)] p-2 shadow-md">
            {/* Tabs */}
            <div className="mb-2 flex gap-0.5 rounded-lg bg-[var(--atlas-panel-input-background)] p-0.5">
              {(["icons", "emoji"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1 text-xs capitalize transition-colors cursor-pointer",
                    tab === t
                      ? "bg-[var(--atlas-element-active)] text-[var(--foreground)]"
                      : "text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="mb-2 flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--atlas-panel-input-background)] px-2">
              <Search size={11} className="shrink-0 text-[var(--muted-foreground)]" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === "icons" ? "Search icons..." : "Search emoji..."}
                className="flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
              />
            </div>

            {/* Colour swatches: one row, applies to icons and emoji alike. */}
            <div className="mb-2 flex items-center gap-1.5 px-0.5">
              {PROJECT_COLORS.map((c) => {
                const selected = (color ?? null) === c.value;
                return (
                  <button
                    key={c.key}
                    type="button"
                    title={c.label}
                    aria-label={c.label}
                    onClick={() => onColorChange(c.value)}
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full transition-transform hover:scale-110 cursor-pointer",
                      !c.value && "border border-[var(--atlas-border-strong)]",
                    )}
                    style={c.value ? { background: c.value } : undefined}
                  >
                    {selected && (
                      <Check
                        size={11}
                        strokeWidth={3}
                        // ratchet-allow: the check sits on the user's own swatch colour, not a theme surface
                        className={c.value ? "text-white" : "text-[var(--secondary-foreground)]"}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Grid */}
            <div className="hide-scrollbar grid max-h-[176px] grid-cols-6 gap-0.5 overflow-y-auto">
              {tab === "icons" &&
                icons.map(({ key, Icon }) => (
                  <button
                    key={key}
                    type="button"
                    title={key}
                    onClick={() => {
                      onIconChange(key);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md transition-colors cursor-pointer",
                      icon === key
                        ? "bg-[var(--atlas-element-active)]"
                        : "hover:bg-[var(--atlas-element-hover)]",
                    )}
                  >
                    <Icon
                      size={14}
                      style={color ? { color } : undefined}
                      className={cn(!color && "text-[var(--secondary-foreground)]")}
                    />
                  </button>
                ))}
              {tab === "emoji" &&
                emojis.map(({ char }) => (
                  <button
                    key={char}
                    type="button"
                    onClick={() => {
                      onIconChange(char);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md text-lg leading-none transition-colors cursor-pointer",
                      icon === char
                        ? "bg-[var(--atlas-element-active)]"
                        : "hover:bg-[var(--atlas-element-hover)]",
                    )}
                  >
                    {char}
                  </button>
                ))}
              {(tab === "icons" ? icons : emojis).length === 0 && (
                <div className="col-span-6 py-4 text-center text-2xs text-[var(--muted-foreground)]">
                  No matches
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="mt-2 flex items-center justify-between border-t border-[var(--atlas-border-subtle)] pt-2">
              <span className="px-0.5 text-2xs text-[var(--muted-foreground)]">
                {tab === "icons" ? `${icons.length} icons` : `${emojis.length} emoji`}
              </span>
              {icon && (
                <button
                  type="button"
                  onClick={() => {
                    onIconChange(null);
                    setOpen(false);
                  }}
                  className="rounded px-1.5 py-0.5 text-2xs text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--secondary-foreground)] cursor-pointer"
                >
                  Remove icon
                </button>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
