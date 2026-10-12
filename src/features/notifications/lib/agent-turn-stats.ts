/**
 * What a finished turn produced, read from the chat store's messages — pure.
 * Reuses what the store already stamps rather than recomputing it: `workedMs`
 * (turn wall time) and `turnSummary.files` (the per-turn files frozen onto the
 * trailing assistant message at turn_finished, the same data the turn footer
 * shows). Both exist only once the store has applied `turn_finished`, so the
 * caller must flush the delta buffer first.
 */
import { stripNextSteps } from "@/features/chat/lib/next-steps";
import type { ChatMessage } from "@/types/agent";
import { firstSentence } from "./agent-summary";

export interface TurnStats {
  /** Wall time of the turn, when it can be told. */
  durationMs?: number;
  /** Distinct files the turn edited (reads do not count). */
  filesEdited: number;
  /** Tier-0 summary of the final assistant message, or null. */
  summary: string | null;
}

/** Index of the last user message, or -1. */
function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

export function turnStats(messages: ChatMessage[], now: number): TurnStats {
  const from = lastUserIndex(messages);
  const turn = messages.slice(from + 1);

  let durationMs: number | undefined;
  let filesEdited = 0;
  for (let i = turn.length - 1; i >= 0; i--) {
    const m = turn[i];
    if (m.role !== "assistant") continue;
    if (durationMs === undefined && m.workedMs !== undefined) durationMs = m.workedMs;
    if (m.turnSummary) {
      filesEdited = m.turnSummary.files.filter((f) => f.kind === "edit").length;
      break;
    }
  }
  if (durationMs === undefined && from >= 0) {
    const sentAt = Date.parse(messages[from].timestamp);
    if (Number.isFinite(sentAt)) durationMs = Math.max(0, now - sentAt);
  }

  // The final message is the last assistant prose of the turn; tool and
  // thinking rows carry no answer.
  let summary: string | null = null;
  for (let i = turn.length - 1; i >= 0 && summary === null; i--) {
    const m = turn[i];
    if (m.role !== "assistant" || (m.mode && m.mode !== "text")) continue;
    summary = firstSentence(stripNextSteps(m.content ?? ""));
  }
  return { durationMs, filesEdited, summary };
}

/** "850ms" is noise on a banner, so < 1 s yields null. "45s", "4m 12s", "1h 5m". */
export function formatTurnDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1000) return null;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

export function formatFileCount(n: number): string | null {
  return n > 0 ? `${n} ${n === 1 ? "file" : "files"}` : null;
}
