/**
 * Tier-0 turn summary — pure, deterministic, no model call. The first
 * sentence of the agent's final message, markdown stripped, capped on a word
 * boundary. What a notification says the agent did without opening Atlas.
 */

/** Longest summary a banner carries; the OS truncates beyond this anyway. */
export const SUMMARY_MAX_CHARS = 120;

/** Markdown → plain prose. Drops fenced and indented code (the first sentence
 *  of a reply is never code), keeps the text of links and inline code. */
export function stripMarkdown(md: string): string {
  return (
    md
      .replace(/\r\n?/g, "\n")
      // Fenced code blocks, including an unterminated trailing fence.
      .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*(?=\n|$)|$)/gm, "")
      // HTML-ish blocks the agent protocol injects (<next_steps>, <thinking>…).
      .replace(/<([a-z_][\w-]*)>[\s\S]*?<\/\1>/gi, "")
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/<(https?:[^>]+)>/g, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
  );
}

/** Cut `s` to at most `max` chars on a word boundary, ending in an ellipsis. */
function clampWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const room = max - 1; // the ellipsis
  let cut = s.lastIndexOf(" ", room);
  // One enormous token: hard-cut rather than return nothing.
  if (cut < room / 2) cut = room;
  return `${s.slice(0, cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/**
 * The first sentence of `markdown`, plain, at most `max` chars. Null when
 * there is no usable prose (empty, whitespace, code only).
 *
 * A sentence ends at `.`, `!`, `?` followed by whitespace, or at a paragraph
 * break; a line that is a list item or heading is its own unit, so a reply that
 * opens with a list yields its first item. Dots inside tokens ("v1.2",
 * "src/a.ts", "e.g.") do not end it.
 */
export function firstSentence(markdown: string, max = SUMMARY_MAX_CHARS): string | null {
  const plain = stripMarkdown(markdown);
  const firstUnit = plain
    .split(/\n\s*\n|\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstUnit) return null;
  const text = firstUnit.replace(/\s+/g, " ");

  let end = text.length;
  const re = /[.!?]+(?=\s|$)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const head = text.slice(0, m.index);
    // "e.g." / "i.e." / "etc." read as abbreviations, not sentence ends.
    if (/(?:^|\s)(?:e\.g|i\.e|etc|vs|approx)$/i.test(head)) continue;
    end = m.index + m[0].length;
    break;
  }
  const sentence = text.slice(0, end).replace(/[.]+$/, "").trim();
  if (!/[\p{L}\p{N}]/u.test(sentence)) return null;
  return clampWords(sentence, max);
}
