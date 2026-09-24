/** `ids` with `dragId` moved to just before (or after) `targetId`. */
export function moveProjectId(
  ids: string[],
  dragId: string,
  targetId: string,
  after: boolean,
): string[] {
  if (dragId === targetId) return ids;
  const out = ids.filter((id) => id !== dragId);
  const at = out.indexOf(targetId);
  if (at < 0) return ids;
  out.splice(after ? at + 1 : at, 0, dragId);
  return out;
}
