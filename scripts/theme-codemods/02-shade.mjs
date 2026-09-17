// Route black shadows and recessed bands through `--shade`. Run after 01.
//
// Left black on purpose:
//   - modal scrims (`bg-black/N` on overlays): a scrim dims in both modes
//   - the hint keycaps (hint-overlay, comms-home, org-switcher badge): a fixed
//     dark frosted-glass component, recognizable by its `inset 0 -1px 0` shade
//   - media backdrops, PDF pages
//   - the `--shadow-*` tokens in :root, which light mode overrides instead

import { abs, pct, session, sourceFiles } from "./lib.mjs";

const s = session("02-shade");
const tsx = sourceFiles();

const RGBA_BLACK = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([0-9.]+)\s*\)/g;
const RGBA_WHITE = /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([0-9.]+)\s*\)/g;

// ── S1: inside Tailwind `shadow-[…]` classes (spaces are underscores) ───────
let s1Black = 0;
let s1White = 0;
s.lines(tsx, (line) =>
  line.replace(/shadow-\[[^\]\s"'`]*\]/g, (cls) =>
    cls
      .replace(RGBA_BLACK, (_m, a) => (s1Black++, `color-mix(in_srgb,var(--shade)_${pct(a)},transparent)`))
      .replace(RGBA_WHITE, (_m, a) => (s1White++, `color-mix(in_srgb,var(--contrast)_${pct(a)},transparent)`)),
  ),
);
s.expect("S1 shadow-[…] black -> shade", s1Black, 22);
s.expect("S1 shadow-[…] white -> contrast", s1White, 3);

// ── S2: inline style strings ────────────────────────────────────────────────
let s2 = 0;
s.lines(
  [
    "src/features/agents/components/agent-oauth-modal.tsx",
    "src/features/capture/components/capture-popover.tsx",
    "src/features/comms/components/comms-panel.tsx",
    "src/features/organisations/components/org-switcher.tsx",
    "src/features/workspaces/components/workspace-sidebar.tsx",
    "src/features/artifacts/components/session-stats.tsx",
  ].map(abs),
  (line) =>
    line.includes("inset 0 -1px 0") || line.includes("shadow-[")
      ? line
      : line.replace(RGBA_BLACK, (_m, a) => (s2++, `color-mix(in srgb, var(--shade) ${pct(a)}, transparent)`)),
);
s.expect("S2 inline rgba(0,0,0,a) -> color-mix(shade)", s2, 10);

// ── S3: recessed bands drawn as translucent black ──────────────────────────
const BANDS = {
  "src/features/capture/components/capture-popover.tsx": "bg-black/40",
  "src/features/feedback/components/feedback-panel.tsx": "bg-black/20",
  "src/features/comms/components/message-body-impl.tsx": "bg-black/50",
  "src/features/spaces/components/space-nodes.tsx": "bg-black/30",
};
// One value per file; the same files also hold scrims at other opacities
// (feedback-panel's bg-black/70 over an image thumbnail), which must not match.
let s3 = 0;
for (const [file, cls] of Object.entries(BANDS)) {
  const re = new RegExp(`(?<![\\w-])${cls.replace("/", "\\/")}(?![\\w/-])`, "g");
  s.lines([abs(file)], (line) => line.replace(re, () => (s3++, cls.replace("black", "shade"))));
}
s.expect("S3 bands bg-black/N -> bg-shade/N", s3, 4);
s.commit();
