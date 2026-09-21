// Helpers for splitting the "Atlas context" suffix the @-mention picker
// appends to user prose. Lives in /lib/ so both the chat-store
// (computing once on message insert) and the MessageItem renderer (as
// a fallback for legacy messages) can use the same split logic.

const ATLAS_CONTEXT_MARKER = "\n\n---\n# Atlas context\n\n";

export interface SplitContext {
  prose: string;
  context: string | null;
  blockCount: number;
}

// Block labels that Atlas (Rust `agents_send`) injects into the wire prompt:
// shared cross-agent memory + retrieved long-term memory + recent-session recap.
// The coding agent echoes the received prompt into its transcript, so resumed
// sessions (esp. Codex, whose replay arrives via live deltas, not the JSONL the
// Rust reader strips) would otherwise show this scaffolding as the user message.
const INJECTED_CORES = [
  "SHARED MEMORY",
  "RELEVANT PROJECT MEMORY",
  "PROJECT MEMORY",
  "RECENT SESSION",
];

// Keep this in sync with `NEXT_STEPS_MARKER` in `next-steps.ts`.
const NEXT_STEPS_MARKER = "\u2550\u2550\u2550 Atlas next-steps \u2550\u2550\u2550";

// The boundary marker Codex itself puts between a model-context preamble and
// the user's real request (`codex_protocol::protocol::USER_MESSAGE_BEGIN`).
// `agents_send` inserts it for Codex sessions so Codex's own thread title keeps
// only what the user typed. Keep in sync with `CODEX_USER_MESSAGE_BEGIN` in
// `src-tauri/src/commands/memory_pack.rs`.
const CODEX_USER_MESSAGE_BEGIN = "## My request for Codex:";

/** One Atlas-injected context block, recovered rather than discarded. */
export interface InjectedBlock {
  /** The marker's label - `SHARED MEMORY`, `RELEVANT PROJECT MEMORY`, ... */
  label: string;
  body: string;
}

interface InjectedRange {
  label: string;
  start: number;
  end: number;
  body: string;
}

/** Find the next `--- LABEL ---` marker at or after `from`.
 *
 *  The old parser required the marker to occupy a whole line. Codex can
 *  collapse the wire prompt (including the marker and its body) into one line
 *  before reporting a session title, so the parser also needs to recognise a
 *  marker followed by body text on the same line. */
function findInjectedStart(
  text: string,
  from: number,
): { label: string; start: number; markerEnd: number } | null {
  let search = from;
  while (true) {
    const start = text.indexOf("--- ", search);
    if (start < 0) return null;
    const afterPrefix = start + 4;
    const label = INJECTED_CORES.find((core) => text.startsWith(core, afterPrefix));
    if (label) {
      const afterCore = afterPrefix + label.length;
      const close = text.indexOf("---", afterCore);
      const newline = text.indexOf("\n", afterCore);
      if (close >= 0 && (newline < 0 || close < newline)) {
        const before = start > 0 ? text[start - 1] : "";
        if (start === 0 || /\s/.test(before)) {
          return { label, start, markerEnd: close + 3 };
        }
      }
    }
    search = start + 4;
  }
}

function injectedRanges(text: string): InjectedRange[] {
  const ranges: InjectedRange[] = [];
  let cursor = 0;
  while (true) {
    const start = findInjectedStart(text, cursor);
    if (!start) break;
    const endMarker = `--- END ${start.label} ---`;
    const endAt = text.indexOf(endMarker, start.markerEnd);
    const bodyEnd = endAt >= 0 ? endAt : text.length;
    const end = endAt >= 0 ? endAt + endMarker.length : text.length;
    ranges.push({
      label: start.label,
      start: start.start,
      end,
      body: text.slice(start.markerEnd, bodyEnd).trim(),
    });
    cursor = end;
  }
  return ranges;
}

/** Split Atlas-injected `--- LABEL ---` ... `--- END LABEL ---` blocks out of a
 *  prompt, returning both halves. Position-agnostic and tolerant of a marker
 *  collapsed onto the same line as its body; mirrors the Rust
 *  `strip_injected_context`.
 *
 *  The blocks are *kept* here because two callers want opposite things from the
 *  same parse: the chat renderer drops them (they are scaffolding the agent
 *  echoed back), while the Timeline's session detail renders them as their own
 *  cards - what Atlas contributed to a turn is a fact about the turn, and
 *  hiding it made every prompt look unassisted. One parser, so the two can
 *  never disagree about where a block ends. */
export function extractInjectedContext(text: string): {
  prose: string;
  blocks: InjectedBlock[];
} {
  const directiveAt = text.indexOf(NEXT_STEPS_MARKER);
  const body = directiveAt >= 0 ? text.slice(0, directiveAt).replace(/\s+$/, "") : text;

  // Codex's boundary marker is authoritative when present: everything after it
  // is what the user typed, everything before it is preamble.
  const boundaryAt = body.indexOf(CODEX_USER_MESSAGE_BEGIN);
  const hasBoundary = boundaryAt >= 0;
  const preamble = hasBoundary ? body.slice(0, boundaryAt) : body;
  const typed = hasBoundary ? body.slice(boundaryAt + CODEX_USER_MESSAGE_BEGIN.length) : null;

  const ranges = preamble.includes("--- ") ? injectedRanges(preamble) : []; // fast path
  if (ranges.length === 0) return { prose: (typed ?? preamble).trim(), blocks: [] };

  const blocks: InjectedBlock[] = [];
  let leftover = "";
  let cursor = 0;
  for (const range of ranges) {
    leftover += preamble.slice(cursor, range.start);
    blocks.push({ label: range.label, body: range.body });
    cursor = range.end;
  }
  leftover += preamble.slice(cursor);
  return { prose: (leftover + (typed ?? "")).trim(), blocks };
}

/** Strip Atlas-injected context blocks, keeping only the prose. */
export function stripInjectedContext(text: string): string {
  return extractInjectedContext(text).prose;
}

/** Split a user message into (prose, contextBody, contextBlockCount).
 *  Returns `context: null` for messages without an Atlas-context
 *  suffix. Each block in the context starts with a `## ` heading
 *  (see `composePrompt`) so block count is a regex over the body. The prose is
 *  also cleaned of any injected shared-memory blocks so resumed sessions don't
 *  render the raw `--- SHARED MEMORY ---` scaffolding. */
export function splitAtlasContext(content: string): SplitContext {
  const idx = content.indexOf(ATLAS_CONTEXT_MARKER);
  if (idx === -1) {
    return { prose: stripInjectedContext(content), context: null, blockCount: 0 };
  }
  const prose = stripInjectedContext(content.slice(0, idx));
  const context = content.slice(idx + ATLAS_CONTEXT_MARKER.length).replace(/\n+$/, "");
  if (context.length === 0) return { prose, context: null, blockCount: 0 };
  const matches = context.match(/^## /gm);
  return {
    prose,
    context,
    blockCount: matches ? matches.length : 0,
  };
}
