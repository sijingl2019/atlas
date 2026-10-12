/**
 * Answering a permission request from its OS banner (Allow once / Deny).
 *
 * The answer goes down the same path as the in-app card — the shared
 * `respondAndPopPermission` (send, then pop) — so the request resolves identically and the backend's
 * `permission_resolved` delta clears the toast, center item and banner
 * (`resolveAgentPermission`). Which option an action means is decided by the
 * pure `permissionDecisionForAction`, against the request's live options.
 *
 * A response for a request that no longer exists (answered in-app, turn over,
 * cold start with no pending state) is a no-op: nothing is ever sent for an
 * unknown request.
 */
import { respondAndPopPermission } from "@/features/chat/lib/respond-permission";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { permissionForResponse } from "./native-routing";
import { permissionDecisionForAction } from "./permission-actions-rules";
import type { SystemNotificationResponse } from "./notifier-api";

export function answerPermissionFromBanner(response: SystemNotificationResponse): void {
  try {
    const ref = permissionForResponse(response);
    if (!ref || response.actionId === null) return;
    const pending = useChatStore
      .getState()
      .pendingPermissions[ref.sessionId]?.find((p) => p.requestId === ref.requestId);
    if (!pending) return;
    const decision = permissionDecisionForAction(response.actionId, pending.options);
    if (!decision) return;
    void respondAndPopPermission(pending, decision, {
      onError: (e) => console.warn("banner permission answer failed:", e),
    });
  } catch (err) {
    console.warn("banner permission action failed:", err);
  }
}
