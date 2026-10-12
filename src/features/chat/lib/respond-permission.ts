/**
 * The one way a permission request gets answered: send the decision to the
 * agent, then pop the request off the pending queue — whether or not the send
 * worked, so a failed answer never leaves a dead card behind. Shared by the
 * in-app card (`permission-modal.tsx`) and the OS banner's Allow / Deny
 * (`notifications/lib/permission-actions.ts`).
 *
 * Deliberately light on imports (the agents API and the chat store only): the
 * card must not pull the notifier into its module graph.
 */
import type { PendingPermission } from "@/types/acp";
import { agents } from "./agents-api";
import { useChatStore } from "../stores/chat-store";

export type PermissionAnswer = Parameters<typeof agents.respondPermission>[3];

/** Resolves once the request is popped; `onSent` runs after a successful send
 *  (before the pop), `onError` after a failed one. Never rejects. */
export async function respondAndPopPermission(
  request: Pick<PendingPermission, "agentId" | "acpSessionId" | "requestId">,
  decision: PermissionAnswer,
  hooks: { onSent?: () => void; onError?: (error: unknown) => void } = {},
): Promise<void> {
  try {
    await agents.respondPermission(
      request.agentId,
      request.acpSessionId,
      request.requestId,
      decision,
    );
    hooks.onSent?.();
  } catch (e) {
    hooks.onError?.(e);
  } finally {
    useChatStore.getState().actions.popPermission(request.acpSessionId, request.requestId);
  }
}
