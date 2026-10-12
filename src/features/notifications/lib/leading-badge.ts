/**
 * The status badge on a notification's leading icon — derived from the catalog
 * (toast variant, tier), never from a list of kinds, so a new kind gets the
 * right badge by declaring its tier. Pure.
 */
import { catalogEntry, type NotificationKind } from "./catalog";

export type LeadingBadge = "done" | "failed" | "needs-you" | "warning";

/** Failure first (an error-variant kind may also be needs-you), then blocked on
 *  the user, then a finished outcome, then a heads-up. Team-tier kinds carry
 *  no badge. */
export function leadingBadge(kind: NotificationKind): LeadingBadge | null {
  const { tier, toast } = catalogEntry(kind);
  if (toast.variant === "error") return "failed";
  if (tier === "needs-you") return "needs-you";
  if (toast.variant === "success") return "done";
  if (tier === "warning") return "warning";
  return null;
}
