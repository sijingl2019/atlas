// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_MODE_CACHE_KEY } from "@/features/theme/apply-theme-mode";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(REPO_ROOT, "index.html"), "utf8");
const bootScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((s) => s.includes(THEME_MODE_CACHE_KEY));

function run(systemDark = true) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("dark") ? systemDark : !systemDark,
  }));
  new Function(bootScript!)();
  const root = document.documentElement;
  return {
    mode: root.getAttribute("data-mode"),
    scheme: root.style.getPropertyValue("color-scheme"),
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-mode");
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("index.html boot theme script", () => {
  it("exists, reads the key apply-theme-mode writes, and runs in <head>", () => {
    expect(bootScript).toBeDefined();
    expect(html.indexOf(bootScript!)).toBeLessThan(html.indexOf("</head>"));
  });

  it("defaults to dark with no cache", () => {
    expect(run(false)).toEqual({ mode: "dark", scheme: "dark" });
  });

  it("applies a cached light mode", () => {
    localStorage.setItem(THEME_MODE_CACHE_KEY, "light");
    expect(run(true)).toEqual({ mode: "light", scheme: "light" });
  });

  it.each([
    [false, "light"],
    [true, "dark"],
  ])("resolves a cached System against the OS (dark=%s → %s)", (systemDark, mode) => {
    localStorage.setItem(THEME_MODE_CACHE_KEY, "system");
    expect(run(systemDark).mode).toBe(mode);
  });

  it("falls back to dark when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(run(false)).toEqual({ mode: "dark", scheme: "dark" });
  });

  it("lets body and #root inherit color-scheme from <html>", () => {
    // They used to declare `dark` themselves, which blocks inheritance: only
    // <html>'s inline style (rewritten per mode) may declare it.
    const rule = /html,\s*body,\s*#root\s*\{([^}]*)\}/.exec(html)![1];
    expect(rule).not.toContain("color-scheme");
    expect(html).toMatch(/<html[^>]*style="[^"]*color-scheme:dark/);
  });
});
