import { describe, expect, it } from "vitest";
import { hashString, iconCacheKey, iconSourceFor, svgFromDataUrl } from "./notification-icon";

describe("notification icon", () => {
  it("hashes deterministically and distinguishes content", () => {
    expect(hashString("a")).toBe(hashString("a"));
    expect(hashString("a")).not.toBe(hashString("b"));
  });

  it("decodes svg data urls (percent and base64) and rejects other types", () => {
    expect(svgFromDataUrl("data:image/svg+xml,%3Csvg%2F%3E")).toBe("<svg/>");
    expect(svgFromDataUrl(`data:image/svg+xml;base64,${btoa("<svg/>")}`)).toBe("<svg/>");
    expect(svgFromDataUrl("data:image/png;base64,AAAA")).toBeNull();
  });

  it("keys by agent, scheme and content, file-name safe", () => {
    const a = iconCacheKey("claude-code", "dark", { kind: "svg", svg: "<svg>1</svg>" });
    expect(a).toMatch(/^claude-code-dark-[0-9a-f]+$/);
    expect(iconCacheKey("claude-code", "light", { kind: "svg", svg: "<svg>1</svg>" })).not.toBe(a);
    expect(iconCacheKey("claude-code", "dark", { kind: "svg", svg: "<svg>2</svg>" })).not.toBe(a);
    expect(iconCacheKey("a/b c", "dark", { kind: "url", url: "x" })).toMatch(/^a_b_c-dark-/);
  });

  it("tints a first-party mark with its brand hue and falls back to the scheme foreground", async () => {
    const claude = await iconSourceFor("claude-code", "dark");
    expect(claude).toMatchObject({ kind: "svg" });
    expect(claude && claude.kind === "svg" && claude.svg).toContain("color:#c98263");
    const opencode = await iconSourceFor("opencode", "light");
    expect(opencode && opencode.kind === "svg" && opencode.svg).toContain("color:#9ca3af");
  });

  it("has no image for an agent with no mark", async () => {
    expect(await iconSourceFor("some-unknown-agent", "dark")).toBeNull();
  });
});
