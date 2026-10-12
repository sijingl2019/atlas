// nbformat v4 types — only the fields the viewer reads. Full spec:
// https://nbformat.readthedocs.io/en/latest/format_description.html

export interface NotebookOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  // stream
  name?: "stdout" | "stderr";
  text?: string | string[];
  // execute_result / display_data
  data?: Record<string, string | string[]>;
  execution_count?: number | null;
  // error
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  outputs?: NotebookOutput[];
  execution_count?: number | null;
}

export interface NotebookFile {
  cells: NotebookCell[];
  metadata?: {
    kernelspec?: { language?: string; name?: string };
    language_info?: { name?: string };
  };
  nbformat?: number;
  nbformat_minor?: number;
}

/** Parse a notebook's JSON, throwing a readable error for anything that is not
 *  an nbformat v4 document (v3 keeps its cells under `worksheets`). */
export function parseNotebook(text: string): NotebookFile {
  const notebook = JSON.parse(text) as NotebookFile;
  if (!notebook || !Array.isArray(notebook.cells)) {
    throw new Error('missing a top-level "cells" array (only nbformat v4 is supported)');
  }
  return notebook;
}

/** nbformat allows `source`/`text`/`traceback` as either a single string or an
 *  array of lines (no trailing newlines between entries) — normalize both. */
export function joinSource(src: string | string[] | undefined): string {
  if (src === undefined) return "";
  return Array.isArray(src) ? src.join("") : src;
}

/** Best-effort language id for syntax highlighting, mapped to a highlight.js
 *  grammar name. Falls back to "python" (the overwhelmingly common case) so
 *  code cells still get *some* highlighting rather than none. */
export function notebookLanguage(nb: NotebookFile): string {
  const raw = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? "python";
  const lower = raw.toLowerCase();
  if (lower.startsWith("python")) return "python";
  return lower;
}

/** Wrap `source` in a fenced code block for the Markdown renderer. The fence is
 *  one backtick longer than the longest backtick run in the source, so a cell
 *  that itself contains ``` cannot close the block early. */
export function codeFence(source: string, language: string): string {
  const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${source}\n${fence}`;
}

/** The MIME types the viewer renders, richest first. `text/html` and
 *  `application/javascript` are deliberately absent: an output is static data
 *  from the file, and rendering either would run whatever the file carries. */
const RENDERABLE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "text/markdown",
  "text/plain",
] as const;

export type RenderableMime = (typeof RENDERABLE_MIMES)[number];

export function pickOutputMime(data: Record<string, unknown>): RenderableMime | undefined {
  return RENDERABLE_MIMES.find((mime) => data[mime] !== undefined);
}

/** `src` for an image output. Raster types are stored base64 (sometimes
 *  line-wrapped); SVG is stored as plain markup, not base64. An `<img>` never
 *  runs script inside an SVG, so the markup is safe to hand over as-is. */
export function imageOutputSrc(mime: string, data: string | string[]): string {
  const raw = joinSource(data);
  if (mime === "image/svg+xml") return `data:image/svg+xml,${encodeURIComponent(raw)}`;
  return `data:${mime};base64,${raw.replace(/\s/g, "")}`;
}

// ESC [ … final-byte: every CSI sequence, not just SGR colours — IPython's
// tracebacks are mostly SGR, but progress bars written to stdout carry cursor
// moves (`ESC[A`, `ESC[K`) too.
// oxlint-disable-next-line no-control-regex -- matching the ESC byte is the point
const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Strip ANSI escape sequences Jupyter kernels embed in tracebacks and stream
 *  output — Atlas has no ANSI renderer in this view, so keep the text plain. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}
