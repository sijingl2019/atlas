import { describe, expect, it } from "vitest";

import { humanizeSkillName, skillInfoOf, skillTokensOf, type SlashSkill } from "./slash-skill";

describe("humanizeSkillName", () => {
  it("turns a slug into words", () => {
    expect(humanizeSkillName("atlas-self-configure")).toBe("Atlas Self Configure");
  });

  it("strips the sigils the name arrived with", () => {
    expect(humanizeSkillName("$atlas-self-configure")).toBe("Atlas Self Configure");
    expect(humanizeSkillName("/atlas-self-configure")).toBe("Atlas Self Configure");
  });

  it("splits on underscores and spaces too", () => {
    expect(humanizeSkillName("release_notes for v0.4")).toBe("Release Notes For V0.4");
  });

  it("keeps casing the author chose past the first letter", () => {
    // Only the first letter is touched, so an acronym survives.
    expect(humanizeSkillName("PDF-Tools")).toBe("PDF Tools");
    expect(humanizeSkillName("iOS-Builds")).toBe("IOS Builds");
  });

  it("leaves a single word alone", () => {
    expect(humanizeSkillName("pdf")).toBe("Pdf");
  });
});

describe("skillInfoOf", () => {
  it("reads Codex's `$` prefix as a skill", () => {
    // @agentclientprotocol/codex-acp's buildAvailableCommands.
    expect(skillInfoOf({ name: "$atlas-self-configure", description: "x" })).toEqual({
      name: "$atlas-self-configure",
      displayName: "Atlas Self Configure",
    });
  });

  it("reads the native agent's _meta marker as a skill", () => {
    expect(
      skillInfoOf({
        name: "atlas-self-configure",
        description: "x",
        _meta: { atlas: { kind: "skill" } },
      }),
    ).toEqual({
      name: "atlas-self-configure",
      displayName: "Atlas Self Configure",
    });
  });

  it("does not claim a builtin", () => {
    expect(skillInfoOf({ name: "status", description: "x" })).toBeNull();
    expect(skillInfoOf({ name: "plan", description: "x", _meta: {} })).toBeNull();
    expect(
      skillInfoOf({ name: "goal", _meta: { commandAction: { kind: "prefixPrompt" } } }),
    ).toBeNull();
  });

  it("ignores a malformed marker rather than guessing", () => {
    expect(skillInfoOf({ name: "x", _meta: { atlas: "skill" } })).toBeNull();
    expect(skillInfoOf({ name: "x", _meta: { atlas: { kind: "command" } } })).toBeNull();
    expect(skillInfoOf({ name: "x", _meta: { atlas: { kind: "" } } })).toBeNull();
    expect(skillInfoOf({ name: "", _meta: { atlas: { kind: "skill" } } })).toBeNull();
  });

  it("is null for non-objects and nameless rows", () => {
    expect(skillInfoOf(null)).toBeNull();
    expect(skillInfoOf(undefined)).toBeNull();
    expect(skillInfoOf("$pdf")).toBeNull();
    expect(skillInfoOf({})).toBeNull();
  });
});

describe("skillTokensOf", () => {
  it("keeps only the rows that are skills, in order", () => {
    const pdf = { name: "$pdf", displayName: "Pdf" };
    // The rows are the picker's own shape — a name and a description, with the
    // skill marker on the ones the agent flagged. Only the marker is read.
    const rows: { name: string; description: string; skill?: SlashSkill }[] = [
      { name: "status", description: "Show the session's state" },
      { name: "$pdf", description: "Work with PDFs", skill: pdf },
      {
        name: "$docx",
        description: "Work with DOCX",
        skill: { name: "$docx", displayName: "Docx" },
      },
      { name: "fork", description: "Branch from here" },
    ];
    const out = skillTokensOf(rows);
    expect(out).toEqual([pdf, { name: "$docx", displayName: "Docx" }]);
  });

  it("is empty when nothing advertised is a skill", () => {
    const rows: { name: string; description: string; skill?: SlashSkill }[] = [
      { name: "status", description: "Show the session's state" },
      { name: "fork", description: "Branch from here" },
    ];
    expect(skillTokensOf(rows)).toEqual([]);
  });
});
