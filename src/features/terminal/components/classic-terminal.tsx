import { memo, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { terminalSessions } from "../lib/terminal-session";
import { useTerminalStore } from "../stores/terminal-store";
import type { BlockTerminalProps } from "./block-terminal";

/**
 * Classic terminal — xterm is the whole view and takes keyboard input
 * directly (the VS Code shape). Used where the block UI has no shell
 * integration to work with (Windows: PowerShell / cmd). Same session registry
 * as `BlockTerminal`, so remounts and workspace switches keep the shell.
 */
export const ClassicTerminal = memo(function ClassicTerminal({
  isActive,
  visible,
  onFocus,
  tabId,
  terminalKey,
}: BlockTerminalProps) {
  const session = useMemo(
    () =>
      terminalSessions.acquire(terminalKey, {
        tabId,
        cwd: useProjectStore.getState().currentProject?.path ?? "~",
      }),
    [terminalKey, tabId],
  );
  const { surfaceReady } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useTerminalStore((s) => s.pendingFocus);
  const { clearPendingTerminalFocus } = useTerminalStore.use.actions();

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return session.attach(host);
  }, [session]);

  useEffect(() => {
    session.setVisible(visible);
    return () => session.setVisible(false);
  }, [session, visible]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => session.requestFit());
    ro.observe(el);
    session.requestFit();
    return () => ro.disconnect();
  }, [session]);

  useEffect(() => {
    if (isActive && visible && surfaceReady) session.focusXterm();
  }, [isActive, visible, surfaceReady, session]);

  // External focus request (⌘J / focus-terminal shortcut / a notification).
  useEffect(() => {
    if (!pendingFocus || pendingFocus.tabId !== tabId || !isActive || !visible || !surfaceReady) {
      return;
    }
    session.focusXterm();
    clearPendingTerminalFocus();
  }, [pendingFocus, tabId, isActive, visible, surfaceReady, session, clearPendingTerminalFocus]);

  return (
    <div
      className="relative h-full w-full bg-[var(--term-bg,#000)] px-2 py-1"
      onClick={() => {
        onFocus();
        session.focusXterm();
      }}
    >
      <div ref={hostRef} className="relative h-full w-full" />
    </div>
  );
});
