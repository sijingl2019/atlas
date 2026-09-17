// Route white overlays through the `contrast` color.
//
// Dark mode is unchanged by construction: `--contrast` is #ffffff there, and
// `bg-contrast/10` compiles to the same color-mix Tailwind already emits for
// `bg-white/10`. Run after 00-popover.

import { abs, pct, session, sourceFiles } from "./lib.mjs";

const s = session("01-contrast");
const tsx = sourceFiles();

// ── A: Tailwind white-with-opacity utilities ───────────────────────────────
// Skips React Flow connection handles: that white ring outlines an
// accent-filled dot, not the theme surface.
const TW_WHITE =
  /(?<![\w-])(!?(?:[a-z0-9-]+:)*!?(?:border|bg|ring|divide|outline|from|via|to|fill|stroke|decoration|caret|placeholder)(?:-[trblxy])?)-white\/(\[[0-9.]+\]|\d+)/g;
let a = 0;
s.lines(tsx, (line) =>
  line.includes("!bg-[var(--accent-primary)]")
    ? line
    : line.replace(TW_WHITE, (_m, prefix, alpha) => (a++, `${prefix}-contrast/${alpha}`)),
);
s.expect("A  white/N -> contrast/N", a, 198);

// ── A2: 8-digit white hex in arbitrary values (#ffffff08 …) ────────────────
const TW_WHITE_HEX =
  /(?<![\w-])((?:[a-z0-9-]+:)*(?:border|bg|ring|divide|outline|fill|stroke)(?:-[trblxy])?)-\[#ffffff([0-9a-fA-F]{2})\]/g;
let a2 = 0;
s.lines(tsx, (line) =>
  line.replace(TW_WHITE_HEX, (_m, prefix, hh) => (a2++, `${prefix}-contrast/[${+(parseInt(hh, 16) / 255).toFixed(3)}]`)),
);
s.expect("A2 [#ffffffNN] -> contrast/[a]", a2, 13);

// ── A3: gradient headings (from-white, no opacity) ─────────────────────────
let a3 = 0;
s.lines(
  ["src/features/artifacts/components/session-chat-panel.tsx", "src/features/chat/components/chat-panel.tsx"].map(abs),
  (line) => line.replace(/(?<![\w-])from-white(?![\w/-])/g, () => (a3++, "from-contrast")),
);
s.expect("A3 from-white -> from-contrast", a3, 2);

// ── A4: white text/icons on a translucent chip over the theme surface ──────
// Avatars and mention pills keep white: they sit on a colored fill.
let a4 = 0;
s.lines(
  [
    "src/features/canvas/components/note-editor-panel.tsx",
    "src/features/canvas/components/note-node.tsx",
    "src/features/spaces/components/space-nodes.tsx",
  ].map(abs),
  (line) => line.replace(/(?<![\w-])text-white\/(60|80)(?![\w-])/g, (_m, alpha) => (a4++, `text-contrast/${alpha}`)),
);
s.expect("A4 chip icon text-white/N -> text-contrast/N", a4, 3);

// ── B: rgba(255,255,255,a) consumed as CSS ─────────────────────────────────
// Canvas fillStyle, SVG attributes, recharts props and xterm options cannot
// resolve a CSS variable, and the hint keycaps are a fixed dark component;
// none of those are listed. `shadow-[…]` classes are left to 02-shade.
const RGBA_WHITE = /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([0-9.]+)\s*\)/g;
const CSS_CONTEXT = {
  "src/styles/globals.css": (l) => !l.includes("--cm-active-line-bg"),
  // the neutral agent chip squares (.agent-claude/codex/opencode/cersei)
  "src/styles/tokens.css": (l) => l.includes("--agent-bg:"),
  "src/features/editor-notion/tiptap.css": () => true,
  "src/features/monitor/components/usage-panel.tsx": () => true,
  "src/features/mission-control/components/dashboard/gantt-timeline.tsx": () => true,
  "src/features/git/components/git-diff-panel.tsx": () => true,
  "src/features/memory/components/memory-timeline-calendar.tsx": (l) => l.includes("DOT_PLAIN ="),
  "src/features/canvas/components/canvas-panel.tsx": (l) => l.includes("stroke:"),
  "src/features/spaces/components/space-canvas.tsx": (l) => l.includes("stroke:"),
  "src/features/canvas/components/shape-node.tsx": () => true,
  "src/features/spaces/components/space-nodes.tsx": (l) => l.includes("const stroke"),
  "src/features/telemetry/error-boundary.tsx": () => true,
  "src/features/agents/components/agent-oauth-modal.tsx": () => true,
  "src/features/comms/components/comms-panel.tsx": () => true,
  "src/features/workspaces/components/workspace-sidebar.tsx": () => true,
};
let b = 0;
for (const [file, keep] of Object.entries(CSS_CONTEXT)) {
  s.lines([abs(file)], (line) =>
    !keep(line) || line.includes("shadow-[")
      ? line
      : line.replace(RGBA_WHITE, (_m, alpha) => (b++, `color-mix(in srgb, var(--contrast) ${pct(alpha)}, transparent)`)),
  );
}
s.expect("B  css rgba(255,255,255,a) -> color-mix(contrast)", b, 32);

s.commit();
