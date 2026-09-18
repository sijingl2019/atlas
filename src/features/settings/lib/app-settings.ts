/**
 * The `AppSettings` schema and its defaults.
 *
 * Lives in the settings feature (not the project store) because that is the
 * domain that owns it: `atlas-config-api.ts` needs the type to describe its
 * own IPC surface, and importing it back out of the project store — which in
 * turn imports the api wrapper and runs listener registration at module scope
 * — made the two modules a cycle.
 */

import { DEFAULT_SCALE } from "./ui-scale";
import { DEFAULT_EDITOR_THEME_ID } from "@/features/editor/themes/themes";
import type { ThemeMode } from "@/features/theme/mode";
import { DEFAULT_ATLAS_THEME_ID } from "@/features/theme/themes";

/**
 * App-wide preferences surfaced in Settings → General. Mirrors
 * `src-tauri/src/state/atlas_config.rs:AppSettings`. Defaults declared on
 * both sides; if you add a field, default it both places.
 */
export interface AppSettings {
  /** Auto-add `.atlas/` to each opened git project's `.gitignore`. */
  autoAddAtlasGitignore: boolean;
  /** Record Atlas-internal events (sign-in, agent lifecycle, etc.) into
   *  the Logs panel under the `atlas` source. */
  enableAtlasLogs: boolean;
  /** Show dotfiles / dot-directories in the explorer file tree. */
  showHiddenFiles: boolean;
  /** Global interface zoom (1 == 100%). Driven by the ⌘+/⌘-/⌘0 hotkeys;
   *  applied via the native WebView zoom. */
  uiScale: number;
  /** Anonymous product telemetry (PostHog). Default ON (opt-out) — gates both
   *  the Rust emitter and the frontend crash reporter. See
   *  `src/features/telemetry`. */
  shareTelemetry: boolean;
  /** Attribute telemetry to the signed-in Atlas account rather than keeping it
   *  on the anonymous per-device person. Default ON; irrelevant while signed out
   *  or while `shareTelemetry` is off — both gate it. */
  linkTelemetryToAccount: boolean;
  /** Selected on-device embedding model id (== dir name). Managed by the Local
   *  Model Manager; carried here so settings round-trips never clobber it. */
  embeddingModelId: string;
  /** Code-editor color theme id (see src/features/editor/themes). Drives the
   *  CodeMirror editor, the diff viewer and the source-control diff views. */
  codeEditorTheme: string;
  /** Atlas interface-theme id (see src/features/theme/themes). The dark mode's
   *  interface theme — swaps the whole UI palette — background, panels, text,
   *  borders and accent — while keeping dark-theme primitives. Independent of
   *  `codeEditorTheme` (which only themes code syntax). Default "atlas-black" =
   *  original AMOLED look. */
  atlasTheme: string;
  /** Light / Dark / System. `atlasTheme` and `codeEditorTheme` are the dark
   *  mode's picks; the `…Light` fields are light mode's. Default "dark". */
  themeMode: ThemeMode;
  /** Interface theme id used in light mode. Default "atlas-light". */
  atlasThemeLight: string;
  /** Editor theme id used in light mode. Default "atlas-light". */
  codeEditorThemeLight: string;
  /** Adaptive next-step suggestion chips in the agent chat's per-turn card.
   *  "agent" (default) asks the coding agent to end each reply with a hidden
   *  `<next_steps>` block (uses the live session context, no BYOK); "off"
   *  disables it. (Legacy "parse"/"llm" values are treated as enabled.) */
  adaptiveSuggestions: "off" | "agent";
  /** Inline Git blame in the code editor — dim author/age/summary annotation
   *  trailing the active line. Off = the CodeMirror extension isn't loaded. */
  gitBlameInline: boolean;
  /** Auto-update master switch. ON (default) → every startup checks PostHog
   *  remote config and prompts when a newer signed DMG is available. */
  autoUpdate: boolean;
  /** Let the Atlas Agent's engine sync OpenAI's curated plugin catalogue
   *  (github.com/openai/plugins) when it starts. OFF by default — it is a
   *  network fetch at every launch. Applies the next time the agent starts. */
  curatedPluginSync: boolean;
  /** A version the user chose to "Ignore" in the update prompt; the startup
   *  check won't re-prompt for exactly this version. */
  updaterIgnoredVersion: string | null;
  /** Chat composer send gesture. true (default) = Enter sends, Shift+Enter
   *  inserts a newline (Slack/Discord/ChatGPT convention). false = only
   *  Cmd/Ctrl+Enter sends, bare Enter always inserts a newline (the old
   *  default). Cmd/Ctrl+Enter always sends regardless of this setting. */
  enterToSend: boolean;
  /** Terminal notifications master switch: a command finishing (failed, or
   *  longer than `terminalNotifyMinDurationMs`) or wanting input raises an
   *  in-app notification, a toast when the terminal is off screen, and a
   *  native notification when Atlas is not the front app. */
  terminalNotifications: boolean;
  /** A successful command shorter than this never notifies. */
  terminalNotifyMinDurationMs: number;
  /** Notify on a non-zero exit code regardless of duration. */
  terminalNotifyOnFailure: boolean;
  /** Notify when a command wants input (password prompt, bell, OSC 9/777). */
  terminalNotifyOnAttention: boolean;
  /** Also raise a macOS notification when the window is not focused. */
  terminalNotifyNative: boolean;
  /** Play a short chime with the notification. */
  terminalNotifySound: boolean;
  /** Shell a new terminal launches on Windows. Ignored on macOS/Linux, which
   *  run `$SHELL`. */
  terminalShell: "powershell" | "cmd";
  /** Terminal font stack (CSS font-family list). Empty = built-in font; a
   *  platform monospace is always appended. Use a Nerd Font for prompt themes
   *  (oh-my-posh, powerlevel10k) or their icons render as boxes. */
  terminalFontFamily: string;
  /** Terminal font size in px, 6–72. */
  terminalFontSize: number;
  /** Terminal line height multiple, 1.0–3.0. */
  terminalLineHeight: number;
  /** `normal`, `bold`, or `100`–`900`. */
  terminalFontWeight: string;
}

/** The terminal notifier's view of settings — flat keys on the wire (the
 *  Rust side writes top-level `[settings]` keys only), grouped here. */
export interface TerminalNotificationPrefs {
  enabled: boolean;
  minDurationMs: number;
  onFailure: boolean;
  onAttention: boolean;
  native: boolean;
  sound: boolean;
}

export function terminalNotificationPrefs(s: AppSettings): TerminalNotificationPrefs {
  return {
    enabled: s.terminalNotifications,
    minDurationMs: s.terminalNotifyMinDurationMs,
    onFailure: s.terminalNotifyOnFailure,
    onAttention: s.terminalNotifyOnAttention,
    native: s.terminalNotifyNative,
    sound: s.terminalNotifySound,
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoAddAtlasGitignore: true,
  enableAtlasLogs: true,
  showHiddenFiles: true,
  uiScale: DEFAULT_SCALE,
  shareTelemetry: true,
  linkTelemetryToAccount: true,
  embeddingModelId: "all-MiniLM-L6-v2",
  codeEditorTheme: DEFAULT_EDITOR_THEME_ID,
  atlasTheme: DEFAULT_ATLAS_THEME_ID,
  themeMode: "dark",
  atlasThemeLight: "atlas-light",
  codeEditorThemeLight: "atlas-light",
  adaptiveSuggestions: "agent",
  gitBlameInline: true,
  autoUpdate: true,
  curatedPluginSync: false,
  updaterIgnoredVersion: null,
  enterToSend: true,
  terminalNotifications: true,
  terminalNotifyMinDurationMs: 10_000,
  terminalNotifyOnFailure: true,
  terminalNotifyOnAttention: true,
  terminalNotifyNative: true,
  terminalNotifySound: false,
  terminalShell: "powershell",
  terminalFontFamily: "",
  terminalFontSize: 13,
  terminalLineHeight: 1.4,
  terminalFontWeight: "normal",
};
