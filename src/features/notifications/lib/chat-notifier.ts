/**
 * Chat notifications: the Chat (`comms`) adapter onto the shared pipeline.
 *
 * ENTRY POINT — `notifyChatEnvelope(envelope)`. App.tsx's `atlas:comms` drain
 * calls it after `applyEnvelope`, so the comms store stays a pure mirror (stores
 * never call other stores). Only a live `messageAppended` frame can notify:
 * a reconnect replays as a quiet `resync` and a re-hydrate reads history, so
 * neither re-announces old messages.
 */
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { CommsEnvelope } from "@/features/comms/lib/comms-api";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";
import { decideChatNotification } from "./chat-notifier-rules";
import { computeAway } from "./decide";
import { deliverNotification } from "./deliver";
import { prefsFromSettings } from "./prefs";
import { useSettingsStore } from "@/features/settings/stores/settings-store";

/** Never throws — a notification must not break the comms stream. */
export function notifyChatEnvelope(envelope: CommsEnvelope): void {
  try {
    const ev = envelope.ev;
    if (ev.kind !== "messageAppended") return;
    const s = useCommsStore.getState();
    const conversation = s.conversations.find((c) => c.id === ev.conv_id);
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    const windowFocused = isWindowFocused();
    const sinceInputMs = Date.now() - lastInteraction();
    const decision = decideChatNotification(
      ev.message,
      conversation,
      {
        me: s.me,
        members: new Map(s.members.map((m) => [m.id, m])),
        orgId: useOrgStore.getState().activeOrganisationId ?? undefined,
      },
      {
        windowFocused,
        sinceInputMs,
        targetVisible: s.panelOpen && active?.convId === ev.conv_id,
        projectActive: true,
        away: computeAway(windowFocused, sinceInputMs),
      },
      prefsFromSettings(useSettingsStore.getState().settings),
    );
    if (decision) deliverNotification(decision);
  } catch (err) {
    console.warn("chat notification failed:", err);
  }
}
