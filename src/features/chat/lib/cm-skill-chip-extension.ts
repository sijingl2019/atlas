// CodeMirror 6 extension that paints `/` + an advertised skill name as an
// inline chip — glyph + humanized label — in the composer.
//
// The document text is NOT rewritten. `/$atlas-self-configure` stays exactly
// the token the agent published and will resolve; only the paint changes. That
// is the same contract `cm-mention-extension.ts` keeps for its `@file` chips,
// and it is what lets a skill still carry arguments: the chip covers the token,
// and the prose after it stays prose.
//
// Shape, mirroring the mention extension:
//   - `skillTokensField` holds the skills the bound agent advertised. They are
//     pushed in through a `StateEffect` because the advertisement arrives
//     asynchronously (and can change mid-session), unlike a mention's data,
//     which is produced by the very transaction that inserts it.
//   - `skillRangesField` holds the `{from, to}` spans currently painted. It is
//     recomputed wholesale whenever the doc or the vocabulary changes: a full
//     rescan is cheap here (a composer is a few hundred characters, a skill
//     list a few dozen rows) and it cannot drift the way an incrementally
//     mapped range set would when a token is added or removed.
//   - `Decoration.replace` + `EditorView.atomicRanges` make the chip a single
//     character for Backspace and the arrow keys, like a mention chip.

import { Range, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

import type { SlashSkill } from "./slash-skill";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Replace the composer's skill vocabulary. Called by `chat-input.tsx` when
 *  the bound agent's advertisement lands or changes. */
const setSkillTokensEffect = StateEffect.define<readonly SlashSkill[]>();

function sameSkills(a: readonly SlashSkill[], b: readonly SlashSkill[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.name === b[i].name && s.displayName === b[i].displayName);
}

const skillTokensField = StateField.define<readonly SlashSkill[]>({
  create: () => [],
  update(value, tr) {
    for (const eff of tr.effects) {
      if (eff.is(setSkillTokensEffect)) {
        // Identity-stable when the caller re-pushes the same rows, so a parent
        // that forgets to memoise cannot churn the decoration set.
        return sameSkills(value, eff.value) ? value : eff.value;
      }
    }
    return value;
  },
});

// ── Ranges ───────────────────────────────────────────────────────────────────

export interface SkillRange {
  skill: SlashSkill;
  from: number;
  to: number;
}

/** Every standalone occurrence of a skill token in `doc`.
 *
 *  "Standalone" = preceded by start-of-document or whitespace, and followed by
 *  end-of-document or whitespace. That keeps `/atlas-self-configure` from being
 *  carved out of `/atlas-self-configure-v2` (a different command) or out of
 *  prose like `see/atlas`. The mention extension's `@` scan draws the same
 *  line. */
function scanSkillRanges(doc: string, skills: readonly SlashSkill[]): SkillRange[] {
  const out: SkillRange[] = [];
  for (const skill of skills) {
    const token = `/${skill.name}`;
    if (token.length <= 1) continue;
    let at = doc.indexOf(token);
    while (at !== -1) {
      const before = at > 0 ? doc[at - 1] : "";
      const after = at + token.length < doc.length ? doc[at + token.length] : "";
      if ((!before || /\s/.test(before)) && (!after || /\s/.test(after))) {
        out.push({ skill, from: at, to: at + token.length });
      }
      at = doc.indexOf(token, at + 1);
    }
  }
  out.sort((a, b) => a.from - b.from);
  return out;
}

const skillRangesField = StateField.define<SkillRange[]>({
  create: () => [],
  update(value, tr) {
    const tokens = tr.state.field(skillTokensField);
    if (!tr.docChanged && tokens === tr.startState.field(skillTokensField)) return value;
    return scanSkillRanges(tr.state.doc.toString(), tokens);
  },
});

// ── Widget ───────────────────────────────────────────────────────────────────

// Lucide icon markup, kept inline because a CM widget is vanilla DOM and cannot
// render a React icon. Paths copied from lucide-react's `box` — keep in sync
// with the `Box` import in `slash-command-picker.tsx`. `currentColor` lets the
// chip's colour cascade in from globals.css.
function lucideSvg(body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" ` +
    `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );
}

const ICON_BOX = lucideSvg(
  `<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>` +
    `<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>`,
);

class SkillChipWidget extends WidgetType {
  constructor(private readonly skill: SlashSkill) {
    super();
  }

  eq(other: SkillChipWidget): boolean {
    return other.skill.name === this.skill.name;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "atlas-skill-chip";
    el.setAttribute("data-skill-name", this.skill.name);
    // The token is what the agent sees; the chip only hides it, so it stays
    // reachable as a tooltip.
    el.title = `/${this.skill.name}`;

    const icon = document.createElement("span");
    icon.className = "atlas-skill-chip__icon";
    icon.innerHTML = ICON_BOX;
    el.appendChild(icon);

    const label = document.createElement("span");
    label.className = "atlas-skill-chip__label";
    label.textContent = this.skill.displayName;
    el.appendChild(label);

    return el;
  }

  ignoreEvent(): boolean {
    // Let clicks fall through so the user can put the caret on either side.
    return false;
  }
}

// ── Extension assembly ───────────────────────────────────────────────────────

function buildDecorations(ranges: readonly SkillRange[]): DecorationSet {
  const decos: Range<Decoration>[] = ranges.map((r) =>
    Decoration.replace({
      widget: new SkillChipWidget(r.skill),
      inclusive: false,
    }).range(r.from, r.to),
  );
  return Decoration.set(decos, /* sort */ true);
}

/** Anything inside these ranges is one character for cursor motion and
 *  Backspace, so the chip deletes whole — same as a mention. */
function skillAtomicRanges(view: EditorView): RangeSet<Decoration> {
  const ranges = view.state.field(skillRangesField, false) ?? [];
  if (ranges.length === 0) return RangeSet.empty;
  return RangeSet.of(
    ranges.map((r) => Decoration.mark({}).range(r.from, r.to)),
    true,
  );
}

/** Bundle everything the composer needs. Add to its `extensions` array. */
export const skillChipExtension = [
  skillTokensField,
  skillRangesField,
  EditorView.decorations.from(skillRangesField, buildDecorations),
  EditorView.atomicRanges.of(skillAtomicRanges),
];

/** Push a new skill vocabulary into the view. */
export function setSkillTokens(view: EditorView, skills: readonly SlashSkill[]): void {
  view.dispatch({ effects: setSkillTokensEffect.of(skills) });
}

/** The skill chips currently painted. Exported for tests. */
export function skillRangesIn(view: EditorView): SkillRange[] {
  return view.state.field(skillRangesField, false) ?? [];
}
