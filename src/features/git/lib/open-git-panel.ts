import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";

/** Bring a project's git panel into view: switch to the project if needed,
 *  then reveal source control on its changes view. */
export async function openGitPanel(projectId: string): Promise<void> {
  const ws = useProjectStore.getState();
  if (ws.projects.some((p) => p.id === projectId) && projectId !== ws.activeProjectId) {
    await ws.actions.switchTo(projectId);
  }
  useLayoutStore.getState().actions.revealRightSection("changes");
}
