/**
 * Custom properties declared directly in one `:root…{ … }` block of a
 * stylesheet. `selector` is matched literally at the start of a line, so
 * `:root` finds the bare dark palette and never `:root[data-mode="light"]`.
 *
 * Values are whitespace-normalized so a multi-line declaration compares equal
 * to its one-line form.
 */
export function rootBlockTokens(css: string, selector: string): Record<string, string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{`).exec(noComments);
  if (!match) throw new Error(`no ${selector} block`);
  const open = noComments.indexOf("{", match.index);
  let depth = 0;
  let close = -1;
  for (let i = open; i < noComments.length; i++) {
    if (noComments[i] === "{") depth++;
    else if (noComments[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) throw new Error(`unterminated ${selector} block`);
  const out: Record<string, string> = {};
  for (const m of noComments.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
  return out;
}

/** The dark palette: the first bare `:root { … }` block. */
export const darkRootTokens = (css: string) => rootBlockTokens(css, ":root");
