/**
 * The identity of a board row.
 *
 * A Session id alone is not unique across an Organisation: connecting a Local
 * Project to an existing Project, or moving a Project's sync to another one,
 * re-sends the same Sessions under the same ids to a second Project while the
 * first keeps its copy. Both copies are real rows on the board, so a row is
 * identified by its Project as well — the server Project id when it has one,
 * the local checkout path when it has not.
 */
export interface BoardRowRef {
  id: string;
  projectPath: string;
  remoteProjectId: string | null;
}

export function boardKey(row: BoardRowRef): string {
  return `${row.remoteProjectId ?? ""}\u0000${row.projectPath}\u0000${row.id}`;
}
