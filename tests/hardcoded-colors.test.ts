import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No new hardcoded white overlays or neutral hex colors in the UI.
 *
 * Every translucent white hover, hairline and sheen is drawn in `contrast`
 * (`bg-contrast/10`, `color-mix(in srgb, var(--contrast) …)`), shadows and
 * recessed bands in `shade`, and neutral surfaces, text and borders in the
 * role tokens (`bg-bg-elevated`, `text-text-secondary`, …). That is what lets
 * one class render correctly on a dark base and a light one.
 *
 * The pattern that breaks it is the one this codebase grew up on:
 * `hover:bg-white/5` reads fine on black, so nothing looks wrong until the
 * base is light and the hover silently disappears. Review does not catch it,
 * because on the screen the reviewer is looking at, it works.
 *
 * What remains is listed below with the reason it stays literal. Adding an
 * entry is fine when the color really is fixed — say why. An entry whose code
 * is gone fails too, so the list cannot rot into a blanket exemption.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src");

const PATTERNS: RegExp[] = [
  // Tailwind white utilities, with or without opacity
  /(?<![\w-])!?(?:[a-z0-9-]+:)*!?(?:border|bg|ring|divide|outline|from|via|to|fill|stroke|text)-white(?:\/(?:\[[0-9.]+\]|\d+))?(?![\w-])/g,
  // 8-digit white hex in an arbitrary value
  /-\[#ffffff[0-9a-fA-F]{2}\]/g,
  // raw translucent white
  /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/g,
  // arbitrary 3/6-digit hex on a neutral utility
  /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring)-\[#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\]/g,
  // bare black utilities (scrims use bg-black/N, which is allowed)
  /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border)-black(?![\w/-])/g,
];

type Allowed = { file: string; snippet: string; reason: string };

const KEYCAP = "hint keycap: a fixed dark frosted-glass component in both modes";
const COLORED_FILL = "white text/ring on a colored fill, not on the theme surface";
const XTERM = "must match xterm's own canvas colors, which are set in JS";
const CANVAS_2D =
  "drawn with Canvas 2D (fillStyle/strokeStyle), which needs a resolved color; a CSS variable does not work there";

const ALLOWED: Allowed[] = [
  // ── fixed components ──
  {
    file: "features/hint-nav/components/hint-overlay.tsx",
    snippet: `color: "rgba(255,255,255,0.95)"`,
    reason: KEYCAP,
  },
  {
    file: "features/hint-nav/components/hint-overlay.tsx",
    snippet: `border: "1px solid rgba(255,255,255,0.08)"`,
    reason: KEYCAP,
  },
  {
    file: "features/hint-nav/components/hint-overlay.tsx",
    snippet: `"inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0`,
    reason: KEYCAP,
  },
  {
    file: "features/comms/components/comms-home.tsx",
    snippet: `ink="rgba(255,255,255,0.95)"`,
    reason: KEYCAP,
  },
  {
    file: "features/comms/components/comms-home.tsx",
    snippet: `border: "1px solid rgba(255,255,255,0.08)"`,
    reason: KEYCAP,
  },
  {
    file: "features/comms/components/comms-home.tsx",
    snippet: `"inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0`,
    reason: KEYCAP,
  },
  {
    file: "features/organisations/components/org-switcher.tsx",
    snippet: `color: "rgba(255,255,255,0.95)"`,
    reason: KEYCAP,
  },
  {
    file: "features/organisations/components/org-switcher.tsx",
    snippet: `border: "1px solid rgba(255,255,255,0.08)"`,
    reason: KEYCAP,
  },
  {
    file: "features/organisations/components/org-switcher.tsx",
    snippet: `"inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0`,
    reason: KEYCAP,
  },
  {
    file: "components/titlebar.tsx",
    snippet: `leading-none font-medium text-white"`,
    reason: "session-capture pill: white on its blue gradient",
  },
  {
    file: "components/titlebar.tsx",
    snippet: `rgba(37,99,235,0.35), 0 1px 0 0 rgba(255,255,255,0.25) inset`,
    reason: "session-capture pill highlight",
  },
  {
    file: "components/titlebar.tsx",
    snippet: `"linear-gradient(180deg, rgba(255,255,255,0.25) 0%`,
    reason: "session-capture pill sheen",
  },
  {
    file: "components/titlebar.tsx",
    snippet: `"0 0 0 1px rgba(255,255,255,0.10) inset`,
    reason: "session-capture pill rim",
  },
  {
    file: "components/titlebar.tsx",
    snippet: `hover:bg-[#e81123]`,
    reason: "Windows close-button red, same in every theme",
  },

  // ── on a colored fill ──
  {
    file: "features/auth/components/account-avatar.tsx",
    snippet: "text-white/90",
    reason: COLORED_FILL,
  },
  {
    file: "features/comms/components/comms-avatar.tsx",
    snippet: "text-white/90",
    reason: COLORED_FILL,
  },
  { file: "features/comms/lib/mention-pill.ts", snippet: "text-white/90", reason: COLORED_FILL },
  {
    // The checkmark drawn on a selected colour swatch. The swatch hues are a
    // fixed palette (not theme tokens), so a white tick stays legible on every
    // one of them in both modes; the unselected/`default` swatch uses a token.
    file: "features/workspaces/components/project-icon-picker.tsx",
    snippet: `c.value ? "text-white"`,
    reason: COLORED_FILL,
  },
  {
    file: "features/explorer/components/file-tree-confirm-delete.tsx",
    snippet: `"text-white bg-[var(--status-error)]`,
    reason: COLORED_FILL,
  },
  {
    file: "features/organisations/components/org-switcher.tsx",
    snippet: "bg-error text-white",
    reason: COLORED_FILL,
  },
  {
    file: "features/spaces/components/space-cursors.tsx",
    snippet: `leading-none text-white"`,
    reason: "cursor label on the collaborator's color",
  },
  {
    file: "features/feedback/components/feedback-panel.tsx",
    snippet: "bg-black/70 text-white/80",
    reason: "remove button over an image thumbnail",
  },
  {
    file: "features/canvas/components/node-handles.tsx",
    snippet: "!border-white/40 !bg-[var(--accent-primary)]",
    reason: COLORED_FILL,
  },
  {
    file: "features/canvas/components/shape-node.tsx",
    snippet: "!bg-[var(--accent-primary)] !border-white/60",
    reason: COLORED_FILL,
  },
  {
    file: "features/spaces/components/space-nodes.tsx",
    snippet: "!bg-[var(--accent-primary)] !border-white/60",
    reason: COLORED_FILL,
  },
  {
    file: "features/git/components/git-manager/git-error-dialog.tsx",
    snippet: "never `text-white`",
    reason: "comment",
  },
  {
    file: "features/git/components/git-manager/merge-branch-dialog.tsx",
    snippet: "never `text-white`",
    reason: "comment",
  },

  // ── content that is light or dark regardless of theme ──
  {
    file: "features/pdf/components/pdf-viewer.tsx",
    snippet: "relative bg-white shadow-lg",
    reason: "PDF page",
  },
  {
    file: "features/pdf/components/pdf-viewer.tsx",
    snippet: `flex items-center justify-center bg-white`,
    reason: "PDF page placeholder",
  },
  {
    file: "features/comms/components/media-lightbox.tsx",
    snippet: "h-full w-full bg-black object-contain",
    reason: "media letterboxing",
  },
  {
    file: "features/comms/components/message-group.tsx",
    snippet: "border-border-subtle bg-black",
    reason: "media letterboxing",
  },
  {
    file: "features/settings/components/settings-panel.tsx",
    snippet: `"translate-x-0 bg-white"`,
    reason: "toggle knob, white on any track",
  },

  // ── the terminal ──
  {
    file: "features/terminal/lib/terminal-palette.ts",
    snippet: `selectionInactiveBackground: "rgba(255,255,255,0.16)"`,
    reason: XTERM,
  },

  // ── colors handed to canvas, SVG and chart renderers ──
  {
    file: "components/graph-ruler.tsx",
    snippet: `border: "rgba(255,255,255,0.06)"`,
    reason: CANVAS_2D,
  },

  // ── theme data and tested fallbacks ──
  {
    file: "features/editor/themes/themes.ts",
    snippet: `selectionBg: "rgba(255,255,255,0.13)"`,
    reason: "a dark editor theme's own palette",
  },
  {
    file: "styles/globals.css",
    snippet: "var(--cm-active-line-bg, rgba(255, 255, 255, 0.04))",
    reason: "fallback pinned by css-fallbacks.test.ts",
  },
  {
    file: "styles/globals.css",
    snippet: "rgba(255, 255, 255, 0.86) 0%, rgba(246, 246, 246, 0.9) 100%",
    reason: "light-mode HUD dock glass, only applied under data-mode=light",
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Character range of the first bare `:root {…}` block — the palette itself. */
function rootBlock(text: string): [number, number] | null {
  const m = /(^|\n)\s*:root\s*\{/.exec(text);
  if (!m) return null;
  let depth = 0;
  for (let i = text.indexOf("{", m.index); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return [m.index, i];
  }
  return null;
}

type Hit = { file: string; line: string; match: string };

function hardcodedColorHits(): Hit[] {
  const hits: Hit[] = [];
  for (const abs of sourceFiles(SRC)) {
    const file = path.relative(SRC, abs).split(path.sep).join("/");
    const text = readFileSync(abs, "utf8");
    const root = file === "styles/tokens.css" ? rootBlock(text) : null;
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) {
        if (root && m.index! > root[0] && m.index! < root[1]) continue;
        const start = text.lastIndexOf("\n", m.index!) + 1;
        const end = text.indexOf("\n", m.index!);
        hits.push({ file, line: text.slice(start, end < 0 ? undefined : end), match: m[0] });
      }
    }
  }
  return hits;
}

describe("hardcoded colors", () => {
  const hits = hardcodedColorHits();

  it("finds nothing outside the allowlist", () => {
    const unexpected = hits
      .filter((h) => !ALLOWED.some((a) => a.file === h.file && h.line.includes(a.snippet)))
      .map((h) => `${h.file}: ${h.match}  in  ${h.line.trim().slice(0, 120)}`);
    expect(unexpected).toEqual([]);
  });

  it("has no allowlist entries whose code is gone", () => {
    const stale = ALLOWED.filter(
      (a) => !hits.some((h) => h.file === a.file && h.line.includes(a.snippet)),
    ).map((a) => `${a.file}: ${a.snippet}`);
    expect(stale).toEqual([]);
  });

  it("still recognizes the pattern it exists to stop", () => {
    // A regex that quietly stopped matching would pass both checks above.
    const sample = `<div className="hover:bg-white/5 border-white/[0.07] text-[#aaa]" style={{ color: "rgba(255,255,255,0.4)" }} />`;
    const found = PATTERNS.flatMap((re) => [...sample.matchAll(re)].map((m) => m[0]));
    expect(found).toEqual([
      "hover:bg-white/5",
      "border-white/[0.07]",
      "rgba(255,255,255,",
      "text-[#aaa]",
    ]);
  });
});
