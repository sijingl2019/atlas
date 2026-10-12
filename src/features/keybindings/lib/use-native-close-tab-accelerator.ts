import { useEffect } from "react";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { setCloseTabAccelerator } from "./keybindings-api";
import { toNativeAccelerator } from "./native-accelerator";

/**
 * Keep the native Window ▸ Close Tab item on whatever `tabs.close` is bound
 * to. That item is the only way the chord works while the embedded browser —
 * a separate native webview — has focus, so it is the one binding that has to
 * exist in two places. See `src-tauri/src/menu.rs`.
 */
export function useNativeCloseTabAccelerator(): void {
  // Select the string, not the combo: it is stable across every store update
  // that rebuilds binding objects without changing the chord, so this costs
  // one IPC call per actual rebind. A menu item carries one chord; the first
  // is the one Settings shows.
  const loaded = useKeybindingsStore.use.loaded();
  const accelerator = useKeybindingsStore((s) => {
    const first = s.resolved.byAction.get("tabs.close")?.[0];
    return first ? toNativeAccelerator(first.combo) : null;
  });

  useEffect(() => {
    // Before load the menu already carries the default; don't flap it.
    if (!loaded) return;
    setCloseTabAccelerator(accelerator).catch((e) =>
      console.warn("could not update the native Close Tab accelerator:", e),
    );
  }, [loaded, accelerator]);
}
