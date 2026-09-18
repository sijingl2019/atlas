import type { ResolvedMode } from "@/features/theme/mode";

/** xterm's 16 ANSI slots in SGR order (30–37, then 90–97). */
export const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

type AnsiKey = (typeof ANSI_KEYS)[number];
export type TerminalPalette = Record<AnsiKey, string> & {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
};

/**
 * Terminal colors per mode. Dark is the palette Atlas always shipped. Light is
 * One Light's hues, each held to ≥ 3:1 on white ("white" and "bright white"
 * become mid greys — a light terminal cannot draw white text on white).
 * The light values are mirrored as `--term-bg` and `--ansi-0` … `--ansi-15`
 * in tokens.css for the DOM block renderer (tests/terminal-palette.test.ts).
 */
export const TERMINAL_PALETTES: Record<ResolvedMode, TerminalPalette> = {
  dark: {
    background: "#000000",
    foreground: "#cccccc",
    cursor: "#b3b3b3",
    selectionBackground: "rgba(97,175,239,0.35)",
    selectionInactiveBackground: "rgba(255,255,255,0.16)",
    black: "#1a1a1a",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#cccccc",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#383a42",
    cursor: "#555555",
    selectionBackground: "rgba(64,120,242,0.25)",
    selectionInactiveBackground: "rgba(0,0,0,0.1)",
    black: "#383a42",
    red: "#e45649",
    green: "#4f9f4e",
    yellow: "#be8201",
    blue: "#4078f2",
    magenta: "#a626a4",
    cyan: "#0184bc",
    white: "#8c8d95",
    brightBlack: "#696c77",
    brightRed: "#ca1243",
    brightGreen: "#3e953a",
    brightYellow: "#986801",
    brightBlue: "#2f5af3",
    brightMagenta: "#8b1f89",
    brightCyan: "#0e7aa6",
    brightWhite: "#696c77",
  },
};
