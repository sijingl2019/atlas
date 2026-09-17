// Define --contrast, --shade and --shadow-popover in the dark :root and expose
// the two colors to Tailwind. Values equal the literals they replace, so the
// dark rendering is unchanged.

import fs from "node:fs";
import { abs, session } from "./lib.mjs";

const s = session("tokens");

const TOKENS_ANCHOR = "  /* === shadcn compat === */";
const TOKENS_INSERT = `  /* === Mode-relative overlays ===
     \`--contrast\` is the color that stands out against the base: every
     translucent hover wash, hairline and sheen is drawn in it, so one
     \`bg-contrast/10\` lifts a dark surface and shades a light one. \`--shade\`
     darkens — shadows and recessed bands. These are the literals the app always
     drew with (#fff, #000), so dark mode renders exactly as before. */
  --contrast: #ffffff;
  --shade: #000000;
  /* The glass popover shadow, previously written out in twelve menus. */
  --shadow-popover:
    inset 0 1px 0 color-mix(in srgb, var(--contrast) 8%, transparent),
    0 16px 48px color-mix(in srgb, var(--shade) 95%, transparent);

`;

const THEME_ANCHOR = "  --color-border-focus: var(--border-focus);\n";
const THEME_INSERT = "\n  --color-contrast: var(--contrast);\n  --color-shade: var(--shade);\n";

/** Match the file's line endings (the working tree is CRLF on Windows). */
const withEol = (text, snippet) => (text.includes("\r\n") ? snippet.split("\n").join("\r\n") : snippet);

const tokens = abs("src/styles/tokens.css");
const globals = abs("src/styles/globals.css");
const t = fs.readFileSync(tokens, "utf8");
const g = fs.readFileSync(globals, "utf8");

s.expect(
  "tokens.css anchor",
  s.literal(tokens, withEol(t, TOKENS_ANCHOR), withEol(t, TOKENS_INSERT + TOKENS_ANCHOR)),
  1,
);
s.expect(
  "globals.css @theme anchor",
  s.literal(globals, withEol(g, THEME_ANCHOR), withEol(g, THEME_ANCHOR + THEME_INSERT)),
  1,
);
s.commit();
