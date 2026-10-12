import { CodeXml } from "lucide-react";
import { CursorIcon, JetBrainsIcon, ZedIcon } from "@/components/editor-icons";
import type { PresetId } from "../lib/presets";

/** The editor's mark for a preset. Decorative: the label beside it already
 *  names the editor. VS Code gets a plain code glyph — it has no mark we can
 *  use (see `editor-icons.tsx`). */
export function PresetIcon({ id, className }: { id: PresetId; className?: string }) {
  switch (id) {
    case "vscode":
      return <CodeXml aria-hidden strokeWidth={2} className={className} />;
    case "cursor":
      return <CursorIcon aria-hidden title="" className={className} />;
    case "zed":
      return <ZedIcon aria-hidden title="" className={className} />;
    case "jetbrains":
      return <JetBrainsIcon aria-hidden title="" className={className} />;
  }
}
