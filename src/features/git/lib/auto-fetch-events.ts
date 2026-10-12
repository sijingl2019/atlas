import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AutoFetchStatus } from "../stores/git-store";

/** Every background (or manual) fetch outcome, as Rust reports it
 *  (`atlas:git-autofetch`). */
export function onAutoFetch(cb: (status: AutoFetchStatus) => void): Promise<UnlistenFn> {
  return listen<AutoFetchStatus>("atlas:git-autofetch", (e) => cb(e.payload));
}
