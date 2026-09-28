import { memo, useCallback } from "react";
import { toast } from "sonner";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { PermissionModal } from "@/features/chat/components/permission-modal";
import { subagentTabId } from "@/types/subagents";
import { subagentsApi } from "../lib/subagents-api";
import { useChildrenOf } from "../stores/subagents-store";

/**
 * A child's permission requests, answered where the parent's are: above the
 * parent chat's composer. The child's own column only shows that it waits.
 *
 * One card at a time — the oldest child with a request — and it takes the
 * keyboard only while the parent has no card of its own.
 */
export const SubagentApprovals = memo(function SubagentApprovals({
  parentSessionId,
}: {
  parentSessionId: string | undefined;
}) {
  const children = useChildrenOf(parentSessionId);
  const child = useChatStore((s) =>
    children.find((c) => s.pendingPermissions[c.child_session_id]?.length),
  );
  const parentPending = useChatStore(
    (s) => !!parentSessionId && !!s.pendingPermissions[parentSessionId]?.length,
  );
  const childId = child?.id;
  const onSendMessage = useCallback(
    (text: string) => {
      if (childId) subagentsApi.prompt(childId, text).catch((e) => toast.error(String(e)));
    },
    [childId],
  );
  if (!child) return null;
  return (
    <div>
      <div className="mx-auto w-full max-w-[720px] px-4 pt-2 text-xs text-[var(--muted-foreground)]">
        Subagent <span className="text-[var(--foreground)]">{child.name}</span> needs approval
      </div>
      <PermissionModal
        key={child.id}
        tabId={subagentTabId(child.child_session_id)}
        keyboard={!parentPending}
        // A mirrored child cannot be prompted from Atlas.
        onSendMessage={child.mirror ? undefined : onSendMessage}
      />
    </div>
  );
});
