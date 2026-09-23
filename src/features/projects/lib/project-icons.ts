/**
 * The project icon + colour vocabulary, shared by the create/edit dialogs and
 * the sidebar row.
 *
 * A project stores the icon as a stable STRING key (`Project.icon`) rather
 * than a component reference: the value round-trips through `state.json` and
 * the Rust `AppState`, neither of which can hold a React component. The key is
 * what persists; `PROJECT_ICON_MAP` is how a key becomes a glyph at render
 * time. An unknown key (a hand-edited state file, or an icon dropped from the
 * set in a later release) resolves to `undefined` and the row falls back to the
 * plain folder glyph rather than crashing.
 */
import {
  Bot,
  BookOpen,
  Braces,
  Briefcase,
  Bug,
  Cloud,
  Code,
  Compass,
  Cpu,
  Database,
  FlaskConical,
  Folder,
  Gamepad2,
  Globe,
  GraduationCap,
  Hammer,
  Layers,
  Leaf,
  Music,
  Package,
  Palette,
  PenTool,
  Puzzle,
  Rocket,
  Shapes,
  Sparkles,
  Star,
  Terminal,
  Trophy,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface ProjectIconDef {
  /** Stable key persisted on `Project.icon`. */
  key: string;
  Icon: LucideIcon;
  /** Extra search terms so "shell" finds the terminal glyph. */
  keywords: string;
}

/** The curated grid. Order is the render order in the picker: 6 per row. */
export const PROJECT_ICONS: ProjectIconDef[] = [
  { key: "folder", Icon: Folder, keywords: "folder directory files" },
  { key: "terminal", Icon: Terminal, keywords: "terminal shell console cli" },
  { key: "code", Icon: Code, keywords: "code dev programming" },
  { key: "braces", Icon: Braces, keywords: "braces json code syntax" },
  { key: "briefcase", Icon: Briefcase, keywords: "briefcase work business job" },
  { key: "palette", Icon: Palette, keywords: "palette design color art" },
  { key: "database", Icon: Database, keywords: "database db data storage" },
  { key: "package", Icon: Package, keywords: "package module box library" },
  { key: "rocket", Icon: Rocket, keywords: "rocket launch ship deploy" },
  { key: "sparkles", Icon: Sparkles, keywords: "sparkles magic ai new" },
  { key: "bug", Icon: Bug, keywords: "bug debug issue defect" },
  { key: "flask", Icon: FlaskConical, keywords: "flask lab experiment test" },
  { key: "bot", Icon: Bot, keywords: "bot agent robot ai" },
  { key: "book", Icon: BookOpen, keywords: "book docs read notes" },
  { key: "cloud", Icon: Cloud, keywords: "cloud server infra" },
  { key: "compass", Icon: Compass, keywords: "compass explore navigate" },
  { key: "cpu", Icon: Cpu, keywords: "cpu chip hardware" },
  { key: "gamepad", Icon: Gamepad2, keywords: "gamepad game play" },
  { key: "globe", Icon: Globe, keywords: "globe web world site" },
  { key: "cap", Icon: GraduationCap, keywords: "graduation cap learn study" },
  { key: "hammer", Icon: Hammer, keywords: "hammer build tools" },
  { key: "layers", Icon: Layers, keywords: "layers stack levels" },
  { key: "leaf", Icon: Leaf, keywords: "leaf nature green eco" },
  { key: "music", Icon: Music, keywords: "music audio sound" },
  { key: "pen", Icon: PenTool, keywords: "pen tool write edit" },
  { key: "puzzle", Icon: Puzzle, keywords: "puzzle plugin extension" },
  { key: "shapes", Icon: Shapes, keywords: "shapes design geometry" },
  { key: "star", Icon: Star, keywords: "star favourite favorite" },
  { key: "trophy", Icon: Trophy, keywords: "trophy award win" },
  { key: "wrench", Icon: Wrench, keywords: "wrench settings config" },
];

/** `Project.icon` key → glyph. Built once from the list above. */
export const PROJECT_ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  PROJECT_ICONS.map((i) => [i.key, i.Icon]),
);

/** Resolve a persisted key to a glyph, or `undefined` for the folder fallback. */
export function projectIcon(key: string | undefined | null): LucideIcon | undefined {
  return key ? PROJECT_ICON_MAP[key] : undefined;
}

export interface ProjectColorDef {
  /** Stable key persisted on `Project.color`. */
  key: string;
  /** CSS colour, or `null` for "inherit the theme's muted foreground". */
  value: string | null;
  label: string;
}

/**
 * Eight swatches, mirroring the picker's single row. The first is the
 * theme-aware default (`null` → the icon inherits `--text-tertiary`, which is
 * legible on both the light and the dark theme); the rest are fixed hues chosen
 * to hold contrast on either background.
 */
export const PROJECT_COLORS: ProjectColorDef[] = [
  { key: "default", value: null, label: "Default" },
  { key: "red", value: "#ef4444", label: "Red" },
  { key: "orange", value: "#f97316", label: "Orange" },
  { key: "yellow", value: "#eab308", label: "Yellow" },
  { key: "green", value: "#22c55e", label: "Green" },
  { key: "blue", value: "#3b82f6", label: "Blue" },
  { key: "purple", value: "#a855f7", label: "Purple" },
  { key: "pink", value: "#ec4899", label: "Pink" },
];

/** The swatch to render as selected when the stored colour is `null`. */
export const DEFAULT_PROJECT_COLOR_KEY = "default";

/** True when `color` matches a swatch in the palette. */
export function projectColorLabel(color: string | undefined | null): string {
  const hit = PROJECT_COLORS.find((c) => c.value === (color ?? null));
  return hit?.label ?? "Default";
}
