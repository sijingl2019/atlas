/**
 * The KB root for the current panel scope — where `kb-scope-store` (the scope)
 * meets the project store (the workspace path). Kept apart from the store so
 * the workspace layer can read the scope without importing the project store
 * back into it.
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/features/app/stores/app-store";
import {
  ensureGlobalRoot,
  ensureLinkedGlobally,
  kbDirOf,
  useKbScopeStore,
} from "../stores/kb-scope-store";

/** The KB root for the panel scope. `null` until the home dir resolves (global)
 *  or while no workspace is open (view). */
export function useKbRoot(): string | null {
  const scope = useKbScopeStore.use.scope();
  const globalRoot = useKbScopeStore.use.globalRoot();
  const currentProject = useAppStore.use.currentProject();
  useEffect(() => {
    void ensureGlobalRoot().catch(() => {});
  }, []);
  return scope === "global" ? globalRoot : (currentProject?.path ?? null);
}

/** Same thing outside React, for store actions and callbacks. */
export function kbRootPath(): string | null {
  const { scope, globalRoot } = useKbScopeStore.getState();
  if (scope === "global") return globalRoot;
  return useAppStore.getState().currentProject?.path ?? null;
}

/**
 * Mount `<project>/.atlas/knowledge` into the global KB under the project's
 * folder name, so knowledge created in view mode is also global knowledge.
 *
 * Call it AFTER the note/folder is written — Rust refuses to link a folder that
 * doesn't exist yet. Idempotent: the same path returns the existing mount.
 */
export async function ensureProjectKbLinkedGlobally(projectPath: string): Promise<void> {
  const dir = kbDirOf(projectPath);
  const name = projectPath
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  await ensureLinkedGlobally(dir, name || undefined);
}

/** The folders the project's own KB spans: its `.atlas/knowledge` plus every
 *  folder it has linked. Used to work out what to highlight in the graph. */
export async function projectKbSources(projectPath: string) {
  try {
    return await invoke<Array<{ name: string; path: string }>>("list_knowledge_sources", {
      projectPath,
    });
  } catch {
    return [];
  }
}
