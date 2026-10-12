// A first launch: no keybindings.json on disk yet, so Atlas asks which editor
// the user is coming from. Picking an answer "writes" the file, and the
// question stays answered until the page reloads.

import type { KeybindingsLoadResult } from "@/features/keybindings/lib/keybindings-api";
import { DEFAULT_KEYBINDINGS_FILE, type KeybindingsFile } from "@/features/keybindings/lib/types";
import type { Scenario } from "../types";

let written: KeybindingsFile | null = null;

export const keymapFirstRun: Scenario = {
  name: "keymap-first-run",
  description: "First launch — the “which editor are you coming from?” keymap picker.",
  commands: {
    keybindings_load: (): KeybindingsLoadResult => ({
      file: written ?? DEFAULT_KEYBINDINGS_FILE,
      path: "~/.config/atlas/keybindings.json",
      exists: written !== null,
      warnings: [],
    }),
    keybindings_save: ({ file }): KeybindingsFile => {
      written = file as KeybindingsFile;
      return written;
    },
  },
};
