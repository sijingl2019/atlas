/**
 * KB scope — which `.atlas/knowledge` root the Knowledge panel and the graph
 * read and write.
 *
 *  - "view"   → the current workspace's `<project>/.atlas/knowledge`
 *  - "global" → `<home>/.atlas/knowledge`
 *
 * Nothing changes on the Rust side: every KB command already takes the root as
 * `projectPath`, so "global" is simply that argument pointed at the home dir.
 * The panel and the graph keep independent scopes (they're separate tabs and
 * the user thinks of them separately); both default to "view".
 *
 * This module deliberately does NOT import the project store — `lib/kb-root.ts`
 * is where the two are joined, so the workspace layer can read the scope
 * without a cycle.
 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { createSelectors } from "@/lib/create-selectors";
import type { KnowledgeSource } from "./knowledge-store";

export type KbScope = "view" | "global";

interface KbScopeState {
  /** Knowledge panel scope. */
  scope: KbScope;
  /** Graph tab scope. */
  graphScope: KbScope;
  /** Home dir, resolved once via `ensureGlobalRoot()`. */
  globalRoot: string | null;
  actions: {
    setScope: (s: KbScope) => void;
    setGraphScope: (s: KbScope) => void;
  };
}

export const useKbScopeStore = createSelectors(
  create<KbScopeState>()((set) => ({
    scope: "view",
    graphScope: "view",
    globalRoot: null,
    actions: {
      setScope: (scope) => set({ scope }),
      setGraphScope: (graphScope) => set({ graphScope }),
    },
  })),
);

let rootPromise: Promise<string> | null = null;

/** Resolve (once) and cache the global KB root. */
export function ensureGlobalRoot(): Promise<string> {
  rootPromise ??= homeDir()
    .then((h) => {
      const root = h.replace(/[\\/]+$/, "");
      useKbScopeStore.setState({ globalRoot: root });
      return root;
    })
    .catch((e) => {
      rootPromise = null;
      throw e;
    });
  return rootPromise;
}

// ── Path comparison ─────────────────────────────────────────────────────────

/** Normalize to `/` separators, no trailing slash, lower case. Case folding is
 *  right on Windows/macOS and only over-matches on a case-sensitive Linux FS,
 *  where the worst case is skipping a redundant global link. */
const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** True when `child` is `parent` or lives underneath it. */
export const isUnder = (child: string, parent: string): boolean => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
};

/** `<root>/.atlas/knowledge` — the KB dir of any root, with `/` separators. */
export const kbDirOf = (root: string): string => `${norm(root)}/.atlas/knowledge`;

// ── Global mirror of view-mode links ────────────────────────────────────────

/** Every folder the global KB already covers: its own knowledge dir plus each
 *  linked source. Empty when the home dir can't be resolved. */
export async function globalKbFolders(): Promise<string[]> {
  try {
    const root = await ensureGlobalRoot();
    const sources = await invoke<KnowledgeSource[]>("list_knowledge_sources", {
      projectPath: root,
    });
    return [kbDirOf(root), ...sources.map((s) => s.path)];
  } catch {
    return [];
  }
}

/** Default folder for the "Link folder…" picker in view mode: the first folder
 *  linked into the global KB, so the user lands where the shared vault lives.
 *  `undefined` (the OS decides) when nothing is linked yet — index 0 is the
 *  global KB's own store dir, which need not exist on disk, and a default path
 *  that isn't there is worse than none. */
export async function defaultLinkDir(): Promise<string | undefined> {
  return (await globalKbFolders())[1];
}

/** Mirror a folder into the global KB unless it already lives under a folder the
 *  global KB covers. `name` overrides the mount name (the folder's own basename
 *  otherwise). Best-effort: a failure here must not fail the view-mode action
 *  the user actually asked for. */
export async function ensureLinkedGlobally(dir: string, name?: string): Promise<void> {
  try {
    const root = await ensureGlobalRoot();
    const folders = await globalKbFolders();
    if (folders.some((f) => isUnder(dir, f))) return;
    await invoke("link_knowledge_folder", { projectPath: root, path: dir, name: name ?? null });
  } catch {
    // silent — the view-mode action succeeded, the mirror is a convenience
  }
}

// ── Graph highlight ─────────────────────────────────────────────────────────

/**
 * Which top-level mount names in the GLOBAL KB belong to `projectPath`.
 *
 * A project's knowledge reaches the global KB as mounted subtrees, so global
 * node ids look like `<mount name>/…` — the project's own ids (`note-123`)
 * never match them directly. A mount belongs to the project when its path is
 * the project's own KB dir, or when it is (or sits under) one of the folders
 * the project itself has linked.
 */
export function projectMountNames(
  globalSources: KnowledgeSource[],
  projectSources: KnowledgeSource[],
  projectPath: string,
): Set<string> {
  const own = kbDirOf(projectPath);
  const names = new Set<string>();
  for (const g of globalSources) {
    if (isUnder(g.path, own) || projectSources.some((p) => isUnder(g.path, p.path))) {
      names.add(g.name);
    }
  }
  return names;
}
