import { timeAgo } from "@/lib/time-ago";
import type { AutoFetchStatus } from "../stores/git-store";

/** The Fetch button's hint: when the remote was last fetched, and why the
 *  latest background fetch failed if it did. Plain "Fetch" until anything
 *  is known. */
export function fetchHint(status: AutoFetchStatus | undefined): string {
  const fetched = status?.lastFetchedAt
    ? `fetched ${timeAgo(new Date(status.lastFetchedAt).toISOString(), { suffix: true })}`
    : null;
  if (status?.lastError) {
    // Git errors can run to several lines of remote chatter; the first says what happened.
    const first = status.lastError.split("\n")[0].trim();
    const reason = first.length > 80 ? `${first.slice(0, 79)}…` : first;
    return `Fetch · auto-fetch failed: ${reason}${fetched ? ` (last ${fetched})` : ""}`;
  }
  return fetched ? `Fetch · ${fetched}` : "Fetch";
}
