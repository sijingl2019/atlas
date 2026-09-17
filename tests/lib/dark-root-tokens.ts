/**
 * Custom properties declared directly in the FIRST bare `:root { … }` block of
 * a stylesheet — the dark palette in `src/styles/tokens.css`. Later blocks
 * (`:root[data-mode="light"]`, utility classes) are not part of it.
 *
 * Values are whitespace-normalized so a multi-line declaration compares equal
 * to its one-line form.
 */
export function darkRootTokens(css: string): Record<string, string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const match = /(^|\n)\s*:root\s*\{/.exec(noComments);
  if (!match) throw new Error("no :root block");
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
  if (close < 0) throw new Error("unterminated :root block");
  const out: Record<string, string> = {};
  for (const m of noComments.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
  return out;
}
