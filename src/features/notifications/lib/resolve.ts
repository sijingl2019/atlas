/**
 * Clearing — the effectful half (see `resolve-rules.ts`): dismiss toasts,
 * remove OS banners (capability-gated inside `native-notify`), mark center
 * items read and refresh the dock badge. One helper for every "this
 * notification no longer applies" path.
 */
import { toast } from "sonner";
import { setDockBadge } from "@/lib/dock-badge";
import {
  nativeCapabilities,
  removeNativeNotification,
  removeNativeNotificationGroup,
} from "@/lib/native-notify";
import { useNotificationsStore } from "../stores/notifications-store";
import {
  isEmptyPlan,
  matchesScope,
  planOpened,
  planResolved,
  type ClearPlan,
  type OpenedSource,
  type ResolvedEvent,
} from "./resolve-rules";

function applyClearPlan(plan: ClearPlan): void {
  if (isEmptyPlan(plan)) return;
  for (const id of plan.toastIds) toast.dismiss(id);
  for (const tag of plan.tags) removeNativeNotification(tag);
  for (const group of plan.groups) removeNativeNotificationGroup(group);
  const store = useNotificationsStore.getState();
  if (plan.markRead.length > 0) {
    store.actions.markReadWhere((i) => matchesScope(i, plan.markRead));
  }
  setDockBadge(useNotificationsStore.getState().items.filter((i) => !i.read).length);
}

/** A notification no longer applies. Never throws. */
export function clearResolved(e: ResolvedEvent): void {
  try {
    applyClearPlan(planResolved(e, nativeCapabilities()));
  } catch (err) {
    console.warn("notification clear failed:", err);
  }
}

/** The user brought a thread, terminal or conversation on screen. Never throws. */
export function clearOpened(src: OpenedSource): void {
  try {
    applyClearPlan(planOpened(src, nativeCapabilities()));
  } catch (err) {
    console.warn("notification clear failed:", err);
  }
}
