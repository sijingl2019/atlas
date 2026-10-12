import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "with-posthog-env.mjs");

/**
 * `with-posthog-env.mjs` prepends `node_modules/.bin` to the child's PATH so the
 * Tauri CLI resolves. Windows spells the variable `Path`, and the script works on
 * a `{ ...process.env }` SPREAD — a plain object, where `env.PATH` does not see a
 * `Path` key. Writing `env.PATH = … + (env.PATH ?? "")` there produced a second
 * key holding ONLY `.bin`, and which of the two duplicates the child saw was
 * undefined: `tauri dev` / `build:app:win` died with "bun is not installed in
 * %PATH%" from one terminal and ran fine from the next (fixed in 0bc364f0).
 *
 * macOS and Linux always spell it `PATH`, so the bug is invisible there — hence
 * this suite forces the Windows spelling on every platform. On the old code it
 * fails for `Path` and passes for `PATH`.
 *
 * `scripts/build-frontend.mjs` carries the same fix in `childEnv()`, but running
 * it means a full Vite build, so it is not exercised here.
 *
 * Originally contributed by @sijingl2019 in #264.
 */
describe("with-posthog-env PATH handling", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "posthog-env-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A file, not `node -e`: the script spawns through cmd.exe on Windows, which
  // mangles a quoted inline program.
  const probe = path.join(dir, "probe.cjs");
  writeFileSync(
    probe,
    'console.log(JSON.stringify((process.env.PATH || process.env.Path || "").split(require("path").delimiter)));',
  );

  for (const key of ["PATH", "Path"]) {
    it(`keeps the inherited PATH when the variable is spelled ${key}`, () => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k.toLowerCase() !== "path") env[k] = v;
      }
      env[key] = ["/sentinel/dir", process.env.PATH ?? ""].join(path.delimiter);

      const r = spawnSync(process.execPath, [script, process.execPath, probe], {
        env: { ...env, ATLAS_POSTHOG_KEY: "" },
        encoding: "utf8",
      });

      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      const line = r.stdout.trim().split(/\r?\n/).slice(-1)[0] ?? "[]";
      const entries: string[] = JSON.parse(line);

      // The `.bin` prepend happened…
      expect(entries.some((d) => d.includes(path.join("node_modules", ".bin")))).toBe(true);
      // …and it did not eat what was already there.
      expect(entries).toContain("/sentinel/dir");
    });
  }
});
