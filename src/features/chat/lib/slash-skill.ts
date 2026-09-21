// Skill rows in the composer and the picker.
//
// ACP has no "this command is a skill" flag. An advertised command is a name, a
// description and an optional input hint, and that is the whole of it — so
// Atlas reads the two things agents actually say, and nothing else:
//
//   - **Codex's adapter** prefixes every skill it discovered with `$`
//     (`@agentclientprotocol/codex-acp` builds `name: "$" + skill.name`), so
//     its skills arrive as `$atlas-self-configure` and the composer token is
//     `/$atlas-self-configure`. The `$` is the adapter's own marker, and it is
//     also the mention the Codex engine resolves, which is why the wire token
//     keeps it.
//   - **Atlas's own agent** advertises the skills `skills/list` found for the
//     session's cwd as ordinary rows, so it tags them
//     `_meta.atlas.kind = "skill"` to tell them from its builtins — see
//     `crates/atlas-native-agent/src/engine/commands.rs`.
//
// An agent that says neither (Claude Code advertises its skills as plain
// commands, indistinguishable from `/status`) gets no chip. Filling that gap
// would mean matching the advertisement against a local skill registry — the
// second source of truth ADR-0005 rejects — so an unrecognised skill row stays
// a plain command row, which is exactly what it looks like today.
//
// Pure and CodeMirror-free on purpose: `message-input.tsx` imports this on the
// eager boot path, and that file must not drag the editor chunk in with it
// (see the chunking note in `cm-clear-range.ts`).

/** A skill row, projected for the composer and the picker. */
export interface SlashSkill {
  /** The advertised command name without the leading `/` — what the picker
   *  matches and what the composer's chip is anchored to. Codex's skills keep
   *  their `$`, because that is the name the agent published. */
  name: string;
  /** The chip / row label: `atlas-self-configure` → `Atlas Self Configure`. */
  displayName: string;
}

/** `$atlas-self-configure` → `Atlas Self Configure`.
 *
 *  Skill names are slugs, and a chip that read `atlas-self-configure` would be
 *  a filename in the middle of a sentence. Only the first letter of each word
 *  is touched, so a name its author cased deliberately (`PDF-Tools`,
 *  `iOS-Builds`) keeps that casing. */
export function humanizeSkillName(name: string): string {
  const bare = name.replace(/^[$/]+/, "");
  const words = bare.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return bare;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The skill an advertised command represents, or `null` when the agent said
 *  nothing that identifies one.
 *
 *  Tolerant by design, like `configActionOf`: `_meta` is untyped by contract,
 *  so a malformed block reads as "no marker" rather than throwing. */
export function skillInfoOf(command: unknown): SlashSkill | null {
  if (!command || typeof command !== "object") return null;
  const o = command as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return null;
  // Codex's marker. `$` is never part of a builtin's name, and the adapter puts
  // it on every skill row and on nothing else.
  if (name.startsWith("$")) {
    return { name, displayName: humanizeSkillName(name) };
  }
  const meta = o._meta;
  if (!meta || typeof meta !== "object") return null;
  const atlas = (meta as Record<string, unknown>).atlas;
  if (!atlas || typeof atlas !== "object") return null;
  if (str((atlas as Record<string, unknown>).kind) !== "skill") return null;
  return { name, displayName: humanizeSkillName(name) };
}

/** The skill rows out of a composer command list.
 *
 *  Order and identity are preserved so the result can be memoised by the caller
 *  and handed straight to the chip extension. */
export function skillTokensOf(commands: readonly { skill?: SlashSkill }[]): SlashSkill[] {
  const out: SlashSkill[] = [];
  for (const command of commands) {
    if (command.skill) out.push(command.skill);
  }
  return out;
}
