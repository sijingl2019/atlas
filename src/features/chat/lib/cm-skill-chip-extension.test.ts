// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { setSkillTokens, skillChipExtension, skillRangesIn } from "./cm-skill-chip-extension";
import type { SlashSkill } from "./slash-skill";

const ATLAS: SlashSkill = {
  name: "$atlas-self-configure",
  displayName: "Atlas Self Configure",
};
const PDF: SlashSkill = { name: "$pdf", displayName: "Pdf" };

function makeView(doc: string, tokens: SlashSkill[] = []): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [...skillChipExtension] }),
  });
  if (tokens.length) setSkillTokens(view, tokens);
  return view;
}

function chips(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll<HTMLElement>(".atlas-skill-chip"));
}

describe("skill chips", () => {
  it("paints a skill token as a glyph + humanized name", () => {
    const view = makeView("/$atlas-self-configure", [ATLAS]);
    const [chip] = chips(view);
    expect(chip).toBeDefined();
    expect(chip.querySelector(".atlas-skill-chip__label")?.textContent).toBe(
      "Atlas Self Configure",
    );
    expect(chip.querySelector(".atlas-skill-chip__icon svg")).not.toBeNull();
    view.destroy();
  });

  it("leaves the wire token untouched", () => {
    // The chip is paint, not a rewrite: Codex resolves `/$skill` as a mention,
    // so the token the agent receives has to stay exactly what it published.
    const view = makeView("run /$atlas-self-configure now", [ATLAS]);
    expect(view.state.doc.toString()).toBe("run /$atlas-self-configure now");
    expect(chips(view)).toHaveLength(1);
    // The raw token stays reachable — it is the chip's tooltip.
    expect(chips(view)[0].title).toBe("/$atlas-self-configure");
    view.destroy();
  });

  it("does not chip a builtin, or a longer token that merely starts the same", () => {
    const view = makeView("/status /$atlas-self-configure-v2", [ATLAS]);
    expect(chips(view)).toHaveLength(0);
    expect(skillRangesIn(view)).toEqual([]);
    view.destroy();
  });

  it("picks up a vocabulary that arrives after mount", () => {
    // The advertisement lands asynchronously, long after the composer mounted.
    const view = makeView("/$pdf summarise this", []);
    expect(chips(view)).toHaveLength(0);
    setSkillTokens(view, [PDF]);
    expect(chips(view)).toHaveLength(1);
    expect(chips(view)[0].querySelector(".atlas-skill-chip__label")?.textContent).toBe("Pdf");
    view.destroy();
  });

  it("drops the paint when the vocabulary goes away", () => {
    const view = makeView("/$pdf", [PDF]);
    expect(chips(view)).toHaveLength(1);
    setSkillTokens(view, []);
    expect(chips(view)).toHaveLength(0);
    view.destroy();
  });

  it("covers the whole token so it deletes in one go", () => {
    const view = makeView("/$atlas-self-configure", [ATLAS]);
    expect(skillRangesIn(view)).toEqual([
      { skill: ATLAS, from: 0, to: "/$atlas-self-configure".length },
    ]);
    view.destroy();
  });
});
