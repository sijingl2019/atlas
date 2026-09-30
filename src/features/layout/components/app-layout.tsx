import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { useLayoutStore } from "../stores/layout-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { ProjectSidebar } from "@/features/projects/components/project-sidebar";
import { useProjectGitPrefetch } from "@/features/projects/lib/use-project-prefetch";
import { Titlebar } from "@/components/titlebar";
import { cn } from "@/lib/utils";
import { isLinux, isWindows } from "@/lib/platform";
import { LeftPanel } from "./left-panel";
import { RightPanel } from "./right-panel";
import { CenterPanel } from "./center-panel";

// Stable across the v3 -> v4 upgrade on purpose: `useDefaultLayout` reads
// `react-resizable-panels:<id>` out of localStorage and understands the v3
// payload shape, so an existing user's saved column widths are picked up
// rather than reset. Panel ids (`atlas-left` / `atlas-center` / `atlas-right`)
// are load-bearing for the same reason — a layout is a map keyed by them.
const MAIN_LAYOUT_ID = "atlas-main-layout";

/**
 * Padding that keeps the shell on screen while the window is maximized.
 * An undecorated window on Windows (and some Linux WMs) is maximized past the
 * monitor's edges, so the webview's outer pixels are off screen: the cards'
 * `m-1.5` gap and the titlebar's close button were clipped. Measured per side
 * against the monitor's work area rather than assumed, since how far it
 * overhangs depends on the DPI.
 */
function useMaximizedInsets(): CSSProperties | undefined {
  const [insets, setInsets] = useState<CSSProperties>();
  useEffect(() => {
    if (!isWindows && !isLinux) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const { getCurrentWindow, currentMonitor } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const measure = async () => {
          const monitor = await currentMonitor();
          if (!monitor || !(await win.isMaximized())) return setInsets(undefined);
          const [pos, size, scale] = await Promise.all([
            win.innerPosition(),
            win.innerSize(),
            win.scaleFactor(),
          ]);
          const work = monitor.workArea;
          // Left/top from where the window sits. Right/bottom from what the
          // webview actually lays out against the visible work area: the
          // window's reported size can fit while the webview still overhangs.
          const left = Math.max(0, (work.position.x - pos.x) / scale);
          const top = Math.max(0, (work.position.y - pos.y) / scale);
          const visibleW = work.size.width / scale;
          const visibleH = work.size.height / scale;
          const right = Math.max(0, window.innerWidth - left - visibleW);
          const bottom = Math.max(0, window.innerHeight - top - visibleH);
          if (import.meta.env.DEV) {
            console.debug("[maximized-insets]", {
              pos,
              size,
              scale,
              work,
              inner: [window.innerWidth, window.innerHeight],
              insets: { left, top, right, bottom },
            });
          }
          setInsets({
            paddingLeft: `${left}px`,
            paddingTop: `${top}px`,
            paddingRight: `${right}px`,
            paddingBottom: `${bottom}px`,
          });
        };
        await measure();
        const stop = await win.onResized(() => void measure());
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        // not in Tauri context
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return insets;
}

export function AppLayout() {
  const leftPanel = useLayoutStore.use.leftPanel();
  const rightPanel = useLayoutStore.use.rightPanel();
  const currentProject = useAppStore.use.currentProject();
  const sidebarOpen = useProjectStore.use.sidebarOpen();
  const personalSync = useSettingsStore((s) => s.settings.personalSync);

  // Warm the project-pane git data at startup so the first slide is smooth.
  useProjectGitPrefetch();

  // v4 replaced `autoSaveId` with this hook: it owns the localStorage read and
  // write, and the Group takes the result as `defaultLayout` + `onLayoutChanged`.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: MAIN_LAYOUT_ID });
  const maximizedInsets = useMaximizedInsets();

  const showLeft = leftPanel.visible && !!currentProject;

  // The left panel stays mounted and is collapsed/expanded imperatively (see the
  // Panel below). `defaultSize` is only read on first mount, so the initial
  // visibility is captured once — otherwise a panel that starts hidden would
  // render at full width for a frame and then snap shut.
  const leftPanelRef = usePanelRef();
  const leftInitiallyVisible = useRef(showLeft);
  useEffect(() => {
    const panel = leftPanelRef.current;
    if (!panel) return;
    if (showLeft && panel.isCollapsed()) panel.expand();
    else if (!showLeft && !panel.isCollapsed()) panel.collapse();
  }, [showLeft]);
  // Source control needs a project; team chat is org-scoped and is reachable
  // with no project open, so the slot stays available in chat mode — unless
  // Chat Sync is off, where chat has nothing to show but "not connected".
  const showRight =
    rightPanel.visible && (rightPanel.mode === "chat" ? personalSync : !!currentProject);
  return (
    <div className="flex h-screen bg-sidebar" style={maximizedInsets}>
      {/* DOCKED project sidebar — an in-flow left column that pushes the
          whole shell right. Full-height so it sits beside the titlebar; the
          sidebar's own top bar already dodges the traffic lights. */}
      {sidebarOpen && (
        <div className="atlas-project-rail h-full w-[244px] shrink-0">
          <ProjectSidebar />
        </div>
      )}

      {/*
       * NOT keyed by project: keying forced a full unmount/remount of the
       * whole shell on every switch (rebuilding CodeMirror/xterm/virtualizer)
       * — the dominant switch cost. Instead, `switchTo` swaps Zustand state in
       * place from an in-RAM snapshot (see project-snapshot.ts), so the shell
       * stays mounted and switching is near-instant.
       */}
      {/* `min-w-0` is load-bearing, not decoration. This column is a flex item
          of the row above, so without it its automatic minimum size is its
          MIN-CONTENT width — and min-content propagates up from the deepest
          `whitespace-nowrap` text in any panel (e.g. a 400-char commit subject
          in the git History list). The column then grows PAST the window,
          the `Group`'s `width: 100%` resolves against that inflated width, and
          every panel scales with it: the left panel balloons and the right
          panel is pushed off-screen entirely. `overflow: hidden` on the panels
          does NOT prevent this — it stops a panel's USED size being overridden
          by its content, but the content still contributes to the group's
          intrinsic width. Capping the column here is what keeps the shell
          inside the window no matter what any panel renders. */}
      {/* Same floating-card recipe as the sidebar's rail card. With the rail
          open its own `m-1.5` already supplies the gap on the left. */}
      <div
        className={cn(
          "flex flex-col flex-1 min-h-0 min-w-0 m-1.5 overflow-hidden rounded-lg bg-background shadow-lg ring-1 ring-border",
          sidebarOpen && "ml-0",
        )}
      >
        <Titlebar />

        <div className="flex-1 min-h-0">
          <Group
            id={MAIN_LAYOUT_ID}
            orientation="horizontal"
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
          >
            {/* The left panel is ALWAYS MOUNTED and collapsed to zero width when
                hidden — never conditionally rendered.

                Toggling it used to unmount the whole subtree, so every ⌘B paid to
                rebuild the file tree from scratch: re-flatten the loaded tree,
                rebuild the git status/dirty-dir maps, re-create the virtualizer,
                and force react-resizable-panels to re-derive the whole group's
                layout because a Panel had appeared. None of that paints
                progressively, which is why opening showed nothing and then
                everything at once.
                This is what VS Code does — `explorerView.ts` overrides
                `setVisible()` and guards work with `isBodyVisible()`, but never
                destroys the tree. Showing the panel becomes a paint.
                (Panels still carry a stable `id`: RRP matches panels by id, and
                without one its layout state corrupts.) */}
            <Panel
              id="atlas-left"
              panelRef={leftPanelRef}
              collapsible
              collapsedSize="0"
              defaultSize={leftInitiallyVisible.current ? "18" : "0"}
              minSize="14"
              maxSize="28"
            >
              <LeftPanel />
            </Panel>
            <Separator
              className={cn(
                "w-px bg-border hover:bg-primary data-[separator=active]:bg-primary transition-colors cursor-col-resize",
                // Kept in the tree (removing it would re-derive the layout, the
                // very thing we're avoiding) but inert while collapsed.
                showLeft ? "w-px" : "w-0 pointer-events-none invisible",
              )}
            />

            <Panel id="atlas-center" defaultSize="64" minSize="30">
              <CenterPanel />
            </Panel>

            {showRight && (
              <>
                <Separator className="w-px bg-border hover:bg-primary data-[separator=active]:bg-primary transition-colors cursor-col-resize" />
                <Panel id="atlas-right" defaultSize="18" minSize="12" maxSize="50">
                  <RightPanel />
                </Panel>
              </>
            )}
          </Group>
        </div>
      </div>
    </div>
  );
}
