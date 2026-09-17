// For every compiled rule whose selector uses a white overlay in the baseline,
// find the contrast rule that replaced it and check it renders the same.
//
// - `bg-white/10` compiles to a color-mix; its replacement must have the same
//   color-mix once var(--color-white) is read as var(--contrast).
// - `bg-[#ffffff08]` compiles to a plain hex; its replacement `bg-contrast/[0.031]`
//   is a color-mix, so the alpha is compared numerically, within the 3-decimal
//   rounding the codemod applied.
//
// Scope: compiled Tailwind utility classes only. Inline style strings, CSS
// files, the shade shadows and the role-token mappings are not covered here.
// Only the @supports color-mix branch is compared; the unconditional fallback
// Tailwind emits for engines without color-mix differs by design (an opaque
// var() instead of an alpha-baked hex).
//
// usage: node verify-equivalence.mjs <baseline.css> <after.css>
import fs from "node:fs";

const [, , basePath, afterPath] = process.argv;

function rules(css) {
  const out = new Map();
  // The boundary is a lookbehind so it is not consumed: in minified CSS the
  // next rule starts right after this rule's `}`, and consuming it would skip
  // every other rule.
  const re = /(?<=^|[{}])\s*(\.[^{}@]+?)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const sel = m[1].trim();
    if (!out.has(sel)) out.set(sel, []);
    out.get(sel).push(m[2]);
  }
  return out;
}

const base = rules(fs.readFileSync(basePath, "utf8"));
const after = rules(fs.readFileSync(afterPath, "utf8"));

// Tailwind escapes `/`, `[`, `]`, `.` and `#` in selectors with a backslash.
const SLASH_WHITE = /-white\\\//;
const HEX_WHITE = /-\\\[\\#ffffff([0-9a-f]{2})\\\]/i;
const alphaOf = (hh) => String(+(parseInt(hh, 16) / 255).toFixed(3)).replace(".", "\\.");
const mixes = (bodies) => bodies.map((b) => (b.match(/color-mix\([^;]*\)/) || [])[0]).filter(Boolean);

let checked = 0;
let compared = 0;
const kept = [];
const missing = [];
const differ = [];
for (const [sel, bodies] of base) {
  const hex = HEX_WHITE.exec(sel);
  if (!SLASH_WHITE.test(sel) && !hex) continue;
  const mapped = sel
    .replace(/-white\\\//g, "-contrast\\/")
    .replace(new RegExp(HEX_WHITE.source, "gi"), (_m, hh) => `-contrast\\/\\[${alphaOf(hh)}\\]`);
  checked++;
  const target = after.get(mapped);
  if (!target) {
    // A deliberately kept white rule survives under its original selector.
    if (!after.has(sel)) missing.push(`${sel}  ->  ${mapped}`);
    else kept.push(sel);
    continue;
  }
  if (hex) {
    const want = parseInt(hex[1], 16) / 255;
    const pctMatch = (mixes(target)[0] || "").match(/var\(--contrast\) ([0-9.]+)%/);
    const got = pctMatch ? Number(pctMatch[1]) / 100 : NaN;
    if (!(Math.abs(want - got) <= 0.0005)) {
      differ.push(`${sel}\n    old alpha ${want.toFixed(4)}\n    new alpha ${got}`);
    } else compared++;
    continue;
  }
  const oldMix = mixes(bodies).map((s) => s.replace(/var\(--color-white\)/g, "var(--contrast)"));
  const newMix = mixes(target);
  // Two empty lists would compare equal and prove nothing.
  if (oldMix.length === 0 || newMix.length === 0) {
    differ.push(`${sel}\n    no color-mix found (old ${oldMix.length}, new ${newMix.length})`);
    continue;
  }
  compared++;
  if (JSON.stringify(oldMix) !== JSON.stringify(newMix)) {
    differ.push(`${sel}\n    old ${oldMix.join(" | ")}\n    new ${newMix.join(" | ")}`);
  }
}

console.log(`white overlay rules in baseline: ${checked}`);
console.log(`compared and equal: ${compared}`);
console.log(`kept as white on purpose: ${kept.length}  ${kept.join("  ")}`);
console.log(`no matching contrast rule after: ${missing.length}`);
for (const s of missing.slice(0, 15)) console.log("  " + s);
console.log(`color or alpha differs: ${differ.length}`);
for (const s of differ.slice(0, 15)) console.log("  " + s);
process.exit(missing.length || differ.length ? 1 : 0);
