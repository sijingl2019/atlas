import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No build script may assign `env.PATH` on a `{...process.env}` spread.
 *
 * Windows spells the variable `Path`. A plain object spread keeps that spelling
 * verbatim, so `env.PATH = …` creates a SECOND key holding only what the script
 * just prepended, and which duplicate the child process receives depends on the
 * rest of the environment. This has now shipped twice: once in
 * `with-posthog-env.mjs` (`tauri dev` died with "bun is not installed in
 * %PATH%") and once in `build-frontend.mjs`, where `tauri build` failed the same
 * way while `bun run build` — which never goes through that env — worked.
 *
 * The fix both scripts use is to find the existing key case-insensitively. This
 * test is what stops the third one, and it costs nothing on macOS/Linux where
 * the bug is invisible.
 */

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

/** `env.PATH = …`, `env["PATH"] = …`, and the lowercase spellings. */
const DIRECT_ASSIGNMENT =
  /\benv(?:\.(?:PATH|Path|path)\b|\[\s*["'](?:PATH|Path|path)["']\s*\])\s*=/g;

describe("build scripts and the Windows PATH spelling", () => {
  const files = readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
    .map((f) => ({ name: f, text: readFileSync(path.join(SCRIPTS, f), "utf8") }));

  it("reads scripts to check", () => {
    // A glob that matched nothing would pass the real assertion silently.
    expect(files.length).toBeGreaterThan(0);
  });

  it("never assigns a fixed-case PATH key", () => {
    const offenders = files
      .flatMap(({ name, text }) =>
        [...text.matchAll(DIRECT_ASSIGNMENT)].map((m) => `${name}: ${m[0]}`),
      )
      .sort();
    expect(offenders).toEqual([]);
  });

  it("still recognizes the pattern it exists to stop", () => {
    const sample = `const env = {...process.env}; env.PATH = "x" + env.PATH;`;
    expect([...sample.matchAll(DIRECT_ASSIGNMENT)]).toHaveLength(1);
  });
});
