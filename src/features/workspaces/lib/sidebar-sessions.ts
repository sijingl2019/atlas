import type { ThreadProject, ThreadRow } from "@/features/chat/lib/history-api";

function comparablePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function projectForWorkspace(
  projects: ThreadProject[],
  workspacePath: string,
): ThreadProject | undefined {
  const target = comparablePath(workspacePath);
  return projects.find((project) =>
    [...project.paths, ...project.threads.flatMap((thread) => thread.folderPaths)].some(
      (path) => comparablePath(path) === target,
    ),
  );
}

export function workspaceSessions(
  projects: ThreadProject[],
  workspacePath: string,
  pinnedThreadIds: ReadonlySet<string>,
): ThreadRow[] {
  const threads = projectForWorkspace(projects, workspacePath)?.threads ?? [];
  return threads
    .filter((thread) => !!thread.sessionId && !thread.archived)
    .sort(
      (a, b) =>
        Number(pinnedThreadIds.has(b.threadId)) - Number(pinnedThreadIds.has(a.threadId)) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
}

export function latestWorkspaceSession(
  projects: ThreadProject[],
  workspacePath: string,
): ThreadRow | undefined {
  return workspaceSessions(projects, workspacePath, new Set())[0];
}
