// Shared plumbing for the theme codemods.
//
// Every rule declares how many sites it expects to change. The run fails (and
// in --apply mode writes nothing) unless every rule matches exactly, so a tree
// that drifted from the one the counts were taken against stops the codemod
// instead of half-applying it.

import fs from "node:fs";
import path from "node:path";

export const APPLY = process.argv.includes("--apply");
export const ROOT = process.cwd();

/** Source files under src/, excluding tests. */
export function sourceFiles(exts = /\.(ts|tsx)$/) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, "src"));
  return out;
}

export const abs = (rel) => path.join(ROOT, rel);

/**
 * Collects edits in memory. `lines(files, fn)` maps each line (EOL-preserving);
 * `commit()` checks every expectation and only then writes.
 */
export function session(name) {
  const files = new Map(); // abs path -> current text
  const results = [];

  const load = (file) => {
    if (!files.has(file)) files.set(file, fs.readFileSync(file, "utf8"));
    return files.get(file);
  };

  return {
    /** Apply `fn(line) -> line` to every line of each file. */
    lines(fileList, fn) {
      for (const file of fileList) {
        const text = load(file);
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        files.set(file, text.split(eol).map((l) => fn(l, file)).join(eol));
      }
    },
    /** Replace an exact literal that must occur exactly `n` times in the file. */
    literal(file, from, to, n = 1) {
      const text = load(file);
      const count = text.split(from).length - 1;
      if (count !== n) {
        throw new Error(`${path.relative(ROOT, file)}: expected ${n}x of ${JSON.stringify(from)}, found ${count}`);
      }
      files.set(file, text.split(from).join(to));
      return count;
    },
    expect(label, actual, expected) {
      results.push({ label, actual, expected });
    },
    commit() {
      let bad = 0;
      for (const r of results) {
        const ok = r.actual === r.expected;
        if (!ok) bad++;
        console.log(`${ok ? "ok  " : "FAIL"} ${r.label}: ${r.actual}${ok ? "" : ` (expected ${r.expected})`}`);
      }
      if (bad) {
        console.log(`\n${name}: ${bad} rule(s) off, nothing written`);
        process.exit(1);
      }
      if (APPLY) {
        for (const [file, text] of files) {
          if (fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text);
        }
      }
      console.log(`\n${name}: all rules matched${APPLY ? ", written" : " (dry run)"}`);
    },
  };
}

/** `0.95` -> `95%`, `.5` -> `50%`. */
export const pct = (alpha) => `${+(Number(alpha) * 100).toFixed(4)}%`;
