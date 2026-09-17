// For every compiled rule whose selector uses a white overlay in the baseline,
// find the contrast rule that replaced it and check the color-mix declarations
// match once var(--color-white) is read as var(--contrast).
//
// usage: node verify-equivalence.mjs <baseline.css> <after.css>
import fs from "node:fs";

const [, , basePath, afterPath] = process.argv;

function rules(css) {
  const out = new Map();
  const re = /(^|[{}])\s*(\.[^{}@]+?)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const sel = m[2].trim();
    if (!out.has(sel)) out.set(sel, []);
    out.get(sel).push(m[3]);
  }
  return out;
}

const base = rules(fs.readFileSync(basePath, "utf8"));
const after = rules(fs.readFileSync(afterPath, "utf8"));

const WHITE_SEL = /-white\\\/|-\\\[#ffffff[0-9a-f]{2}\\\]/i;
const alphaOf = (hh) => String(+(parseInt(hh, 16) / 255).toFixed(3)).replace(".", "\\.");
const mixes = (bodies) => bodies.map((b) => (b.match(/color-mix\([^;]*\)/) || [])[0]).filter(Boolean);

let checked = 0;
const kept = [];
const missing = [];
const differ = [];
for (const [sel, bodies] of base) {
  if (!WHITE_SEL.test(sel)) continue;
  const mapped = sel
    .replace(/-white\\\//g, "-contrast\\/")
    .replace(/-\\\[#ffffff([0-9a-f]{2})\\\]/gi, (_m, hh) => `-contrast\\/\\[${alphaOf(hh)}\\]`);
  checked++;
  const target = after.get(mapped);
  if (!target) {
    // A deliberately kept white rule survives under its original selector.
    if (!after.has(sel)) missing.push(`${sel}  ->  ${mapped}`);
    else kept.push(sel);
    continue;
  }
  const oldMix = mixes(bodies).map((s) => s.replace(/var\(--color-white\)/g, "var(--contrast)"));
  const newMix = mixes(target);
  if (JSON.stringify(oldMix) !== JSON.stringify(newMix)) {
    differ.push(`${sel}\n    old ${oldMix.join(" | ")}\n    new ${newMix.join(" | ")}`);
  }
}

console.log(`white overlay rules in baseline: ${checked}`);
console.log(`kept as white on purpose: ${kept.length}  ${kept.join("  ")}`);
console.log(`no matching contrast rule after: ${missing.length}`);
for (const s of missing.slice(0, 15)) console.log("  " + s);
console.log(`color-mix declaration differs: ${differ.length}`);
for (const s of differ.slice(0, 15)) console.log("  " + s);
process.exit(missing.length || differ.length ? 1 : 0);
