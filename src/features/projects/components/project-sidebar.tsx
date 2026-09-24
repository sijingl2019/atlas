import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectGitStore, type GitSummary } from "../stores/project-git-store";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";
import { recentsForOrg } from "@/features/app/lib/recent-projects";
import {
  FolderPlus,
  Folder,
  FolderOpen,
  X,
  Pin,
  Plus,
  PinOff,
  Gauge,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Trash2,
  Pencil,
  Copy,
  GitBranch,
  TerminalSquare,
  HelpCircle,
  MessageCircle,
  MessageCircleQuestion,
  Keyboard,
  Settings,
  Globe,
  Sparkles,
  BookOpen,
  BrainCircuit,
  Ellipsis,
  Archive,
} from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GithubIcon } from "@/components/github-icon";
import { useFeedbackStore } from "@/features/feedback/stores/feedback-store";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { useProjectStore, type Project, type ProjectGroup } from "../stores/project-store";
import { useRunningChatKeys } from "../lib/agent-activity";
import { openAgentSession, openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import {
  archiveThread,
  onThreadsChanged,
  threadProjects,
  type ThreadProject,
  type ThreadRow,
} from "@/features/chat/lib/history-api";
import { AtlasLoader } from "@/components/atlas-loader";
import { AgentIcons } from "@/components/agent-icons";
import { useSessionPinsStore } from "../stores/session-pins-store";
import { latestWorkspaceSession, workspaceSessions } from "../lib/sidebar-sessions";
import { useAppStore } from "@/features/app/stores/app-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useActiveOrgProjects, useActiveOrgGroups } from "../lib/org-scope";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { AtlasIcon } from "@/components/atlas-icon";
import { cn } from "@/lib/utils";
import { GitDot, NumStatPill } from "./git-summary";
import { useProjectDialogStore } from "../lib/project-dialog";
import { ProjectGlyph } from "./project-glyph";
import { moveProjectId } from "../lib/move-project";
import { agentTypeFromPluginId } from "@/types/agent";

// Slot heights (include the inter-row gap so the virtualizer spaces rows out);
// the visible card is a few px shorter than its slot.
//
// Rows are quiet, not dense. Chats and recents are one 28px line; a project
// keeps two (name, then branch or "no source control") because the second
// line is what tells `api` from `api-v2` — folding the branch onto the name
// line made the two collide on any long name. Section headers carry the
// breathing room (a gap above), not the rows.
const WS_H = 46;
const WS_CARD = 42;
const ROW_H = 30;
const ROW_CARD = 28;
const CHAT_H = 46;
const CHAT_CARD = 42;
const HEADER_H = 28;
/** Section header slot: the header plus the gap that separates sections. */
const SECTION_H = HEADER_H + 10;

/**
 * Drag a project row onto another to reorder. Pointer events, not HTML5 DnD:
 * Tauri's native file-drop handler swallows HTML5 drop events on Windows.
 * The drop marker is a `data-drop` attribute set straight on the DOM, so a
 * drag re-renders no memoised row. Drops only land within the same section
 * (pinned vs not); crossing into another group adopts that group.
 */
function startProjectDrag(e: React.PointerEvent<HTMLDivElement>, ws: Project) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button,input")) return;
  const startY = e.clientY;
  let dragging = false;
  let marked: HTMLElement | null = null;
  let drop: { id: string; after: boolean } | null = null;
  const unmark = () => {
    marked?.removeAttribute("data-drop");
    marked = null;
  };
  const onMove = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(ev.clientY - startY) < 4) return;
      dragging = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
    }
    const el = document
      .elementFromPoint(ev.clientX, ev.clientY)
      ?.closest<HTMLElement>("[data-project-id]");
    unmark();
    drop = null;
    if (!el || el.dataset.projectId === ws.id || el.dataset.pinned !== String(!!ws.pinned)) return;
    const r = el.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    el.setAttribute("data-drop", after ? "after" : "before");
    marked = el;
    drop = { id: el.dataset.projectId!, after };
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    unmark();
    if (!dragging) return;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    // Eat the click that follows the release so the drop doesn't also switch
    // projects; cleared next tick in case no click comes.
    const eat = (ce: MouseEvent) => ce.stopPropagation();
    window.addEventListener("click", eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
    if (!drop) return;
    const { projects, actions } = useProjectStore.getState();
    const target = projects.find((p) => p.id === drop!.id);
    if (!target) return;
    if (!ws.pinned && (target.groupId ?? null) !== (ws.groupId ?? null))
      actions.setGroup(ws.id, target.groupId ?? null);
    actions.reorder(
      moveProjectId(
        projects.map((p) => p.id),
        ws.id,
        target.id,
        drop.after,
      ),
    );
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

// Memoised: every git-summary resolution replaces the summaries map and
// re-rendered EVERY visible row (each carrying a Radix dropdown tree). Props
// are memo-friendly by construction — `ws` objects are only remapped on
// project mutations, `summary` changes only for its own path, `groups` is
// store-stable — so a background summary refresh now re-renders one row.
const ProjectRow = memo(function ProjectRow({
  ws,
  active,
  summary,
  groups,
  indented,
  expanded,
  mounted,
  onToggleProject,
}: {
  ws: Project;
  active: boolean;
  summary?: GitSummary;
  groups: ProjectGroup[];
  indented?: boolean;
  expanded: boolean;
  /** The workspace is MOUNTED (in the hot set) — the store's definition of an
   *  open project. Drives the folder-open badge on the glyph. */
  mounted: boolean;
  onToggleProject: (id: string) => void;
}) {
  const {
    switchTo,
    closeProject,
    pin,
    unpin,
    setGroup,
    addGroup,
    rename,
    beginRenameProject,
    endRenameProject,
  } = useProjectStore.use.actions();
  const { openEdit } = useProjectDialogStore.use.actions();
  // Inline-rename lives in the store (like group rename) so it survives the
  // virtualized row remounting. The name shown is the user-chosen project
  // label (defaults to the directory name) — renaming only relabels the row,
  // it never touches the on-disk path.
  const editing = useProjectStore.use.editingProjectId() === ws.id;
  const switching = useProjectStore.use.switching();
  const [nameDraft, setNameDraft] = useState(ws.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Seed the field AND focus it whenever we enter edit mode. `autoFocus` alone
  // is swallowed when the rename is triggered from the `…` menu: the input
  // mounts while Radix's dropdown is still tearing down its focus scope, which
  // eats the focus. Focusing explicitly on the next frame runs after that
  // teardown settles, so both the menu path and the double-click path land the
  // cursor in the field. (The group rename "just works" because its trigger is
  // a plain button, not inside a closing Radix layer.)
  useEffect(() => {
    if (!editing) return;
    setNameDraft(ws.name);
    const id = requestAnimationFrame(() => {
      const el = nameInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [editing, ws.name]);
  const commitRename = () => {
    const n = nameDraft.trim();
    if (n) rename(ws.id, n);
    endRenameProject();
  };
  return (
    <div
      data-hint
      data-project-id={ws.id}
      data-pinned={String(!!ws.pinned)}
      onPointerDown={editing ? undefined : (e) => startProjectDrag(e, ws)}
      onClick={
        editing
          ? undefined
          : () => {
              if (active || !expanded) onToggleProject(ws.id);
              void switchTo(ws.id);
            }
      }
      style={{ height: WS_CARD, paddingLeft: indented ? 22 : 8 }}
      className={cn(
        // No `transition-colors`, and therefore no `transform-gpu` either.
        //
        // The dot used to jump on hover, and the fix was to pin the row to its
        // own composited layer — but the CAUSE was the transition: Tailwind's
        // `transition-colors` animates `fill` and `stroke` too, so hovering
        // re-rasterised the SVG every frame, at fractional pixels. Dropping it
        // fixes the jump at the source AND lets the promotion go: with overscan
        // there were thirty-plus layers inside the scroller, which is precisely
        // what WKWebView handles worst (the transcript learned the same lesson).
        // The hover fill lands instantly now, which at this row height reads as
        // crisp rather than abrupt.
        "group relative flex items-center gap-2.5 pr-1.5 rounded-md cursor-pointer",
        // Drop marker while another row is dragged over this one.
        "before:pointer-events-none before:absolute before:inset-x-1 before:h-0.5 before:rounded-full before:bg-[var(--primary)] before:hidden",
        "data-[drop]:before:block data-[drop=before]:before:top-0 data-[drop=after]:before:bottom-0",
        active ? "bg-[var(--atlas-element-active)]" : "hover:bg-[var(--atlas-element-hover)]",
      )}
    >
      {/* The configured glyph always shows. A project that is OPEN — its
          workspace is mounted in the hot set — marks itself with a small
          folder-open badge on the glyph's corner rather than swapping the
          glyph out for a folder. The badge rides with the EXPANDED row only:
          a folded row already reads as closed, so a folder-open mark on it
          said the opposite of what the row looked like. */}
      <span className="relative flex size-[13px] shrink-0 items-center justify-center">
        <ProjectGlyph icon={ws.icon} color={ws.color} size={13} />
        {/* Tinted to the glyph's own colour (and left muted when the project
            has none) so the corner mark reads as part of the icon rather than
            as a second, grey one. */}
        {mounted && expanded && (
          <FolderOpen
            size={8}
            strokeWidth={2.5}
            aria-hidden
            style={ws.color ? { color: ws.color } : undefined}
            className={cn(
              "absolute -right-1 -top-1 rounded-sm bg-[var(--sidebar)]",
              ws.color ? undefined : "text-[var(--muted-foreground)]",
            )}
          />
        )}
      </span>
      <GitDot summary={summary} className="size-1.5" />
      {/* `pr-20` clears the right slot (pill at rest, actions on hover) on both
          lines, so neither can run under it. The path tooltip lives here rather
          than on the row so it doesn't stack on the actions' own tooltips. */}
      <div className="flex-1 min-w-0 pr-20" title={ws.path}>
        {editing ? (
          <input
            ref={nameInputRef}
            value={nameDraft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") endRenameProject();
            }}
            className="block w-full bg-transparent outline-none text-sm leading-tight text-[var(--foreground)]"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              beginRenameProject(ws.id);
            }}
            className={cn(
              "block truncate text-sm leading-tight",
              active
                ? "text-[var(--foreground)] font-medium"
                : "text-[var(--secondary-foreground)] group-hover:text-[var(--foreground)]",
            )}
          >
            {ws.name}
          </span>
        )}
        <span className="mt-0.5 block truncate text-2xs leading-tight text-[var(--muted-foreground)]">
          {summary?.isRepo ? summary.branch || "—" : "no source control"}
        </span>
      </div>

      {/* Right slot: the +N/−M at rest, the row actions on hover. Both live in
          one full-height, GPU-promoted box and swap with NO transition: an
          opacity tween on an unpromoted child re-rasterises it mid-fade and the
          icons visibly wobble. This promotion is ONE small box per row and only
          matters while hovering — unlike promoting the whole row, which the
          root above deliberately no longer does. */}
      <span className="absolute inset-y-0 right-1.5 flex items-center transform-gpu [backface-visibility:hidden]">
        <span className="group-hover:opacity-0 group-has-[:focus-visible]:opacity-0">
          <NumStatPill summary={summary} />
        </span>
        <HintGroup>
          <span className="absolute inset-y-0 right-0 flex items-center gap-0.5">
            <HintItem label="New session">
              <button
                type="button"
                disabled={switching}
                onClick={async (event) => {
                  event.stopPropagation();
                  try {
                    await switchTo(ws.id);
                    const state = useProjectStore.getState();
                    if (state.switching || state.activeProjectId !== ws.id) return;
                    openNewAgentChat();
                  } catch (error) {
                    toast.error(
                      `Couldn't start session: ${error instanceof Error ? error.message : error}`,
                    );
                  }
                }}
                aria-label={`New session in ${ws.name}`}
                className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--card)] hover:text-[var(--foreground)] disabled:cursor-wait cursor-pointer"
              >
                <Plus size={11} />
              </button>
            </HintItem>
            <HintItem label={ws.pinned ? "Unpin" : "Pin"}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (ws.pinned) unpin(ws.id);
                  else pin(ws.id);
                }}
                className={cn(
                  "flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] cursor-pointer",
                  ws.pinned
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                {ws.pinned ? <PinOff size={11} /> : <Pin size={11} />}
              </button>
            </HintItem>
            <DropdownMenu.Root>
              <HintItem label="More">
                <DropdownMenu.Trigger
                  render={
                    <button
                      onClick={(e) => e.stopPropagation()}
                      className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--card)] hover:text-[var(--foreground)] outline-none cursor-pointer"
                    >
                      <MoreHorizontal size={12} />
                    </button>
                  }
                />
              </HintItem>
              <DropdownMenu.Portal>
                <DropdownMenu.Positioner className="z-popover" align="end" sideOffset={4}>
                  <DropdownMenu.Popup
                    onClick={(e) => e.stopPropagation()}
                    // On close the menu restores focus to the trigger button.
                    // When the close is caused by selecting "Rename", that
                    // focus-return lands AFTER the rename input has
                    // mounted+autofocused, blurring it instantly →
                    // commitRename → edit mode exits. `finalFocus={false}`
                    // leaves focus alone so the input keeps it.
                    finalFocus={false}
                    className="min-w-[148px] rounded-md border border-[var(--border)] bg-popover py-0.5 shadow-md text-xs text-[var(--secondary-foreground)]"
                  >
                    <DropdownMenu.Item
                      onClick={() => openEdit(ws.id)}
                      className="px-2.5 h-6 flex items-center gap-1.5 outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default"
                    >
                      <Pencil size={11} /> Edit
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(ws.path)
                          .then(() => toast.success("Path copied"))
                          .catch(() => toast.error("Couldn't copy path"));
                      }}
                      className="px-2.5 h-6 flex items-center gap-1.5 outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default"
                    >
                      <Copy size={11} /> Copy path
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-0.5 h-px bg-[var(--border)]" />
                    <DropdownMenu.SubmenuRoot>
                      <DropdownMenu.SubmenuTrigger className="flex items-center justify-between px-2.5 h-6 outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default">
                        Move to group <ChevronRight size={11} />
                      </DropdownMenu.SubmenuTrigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Positioner className="z-popover" side="right" align="start">
                          <DropdownMenu.Popup className="min-w-[140px] rounded-md border border-[var(--border)] bg-popover py-0.5 shadow-md text-xs text-[var(--secondary-foreground)]">
                            {groups.map((g) => (
                              <DropdownMenu.Item
                                key={g.id}
                                onClick={() => setGroup(ws.id, g.id)}
                                className="px-2.5 h-6 flex items-center outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default"
                              >
                                {g.name}
                              </DropdownMenu.Item>
                            ))}
                            <DropdownMenu.Item
                              onClick={() => {
                                const gid = addGroup("New Group");
                                setGroup(ws.id, gid);
                              }}
                              className="px-2.5 h-6 flex items-center gap-1.5 outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default"
                            >
                              <FolderPlus size={11} /> New group
                            </DropdownMenu.Item>
                            {ws.groupId && (
                              <>
                                <DropdownMenu.Separator className="my-0.5 h-px bg-[var(--border)]" />
                                <DropdownMenu.Item
                                  onClick={() => setGroup(ws.id, null)}
                                  className="px-2.5 h-6 flex items-center outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default"
                                >
                                  Remove from group
                                </DropdownMenu.Item>
                              </>
                            )}
                          </DropdownMenu.Popup>
                        </DropdownMenu.Positioner>
                      </DropdownMenu.Portal>
                    </DropdownMenu.SubmenuRoot>
                    <DropdownMenu.Separator className="my-0.5 h-px bg-[var(--border)]" />
                    <DropdownMenu.Item
                      onClick={() => void closeProject(ws.id)}
                      className="px-2.5 h-6 flex items-center gap-1.5 outline-none hover:bg-[var(--atlas-element-hover)] hover:text-error cursor-default"
                    >
                      <X size={11} /> Remove from list
                    </DropdownMenu.Item>
                  </DropdownMenu.Popup>
                </DropdownMenu.Positioner>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </span>
        </HintGroup>
      </span>
    </div>
  );
});

const GroupHeaderRow = memo(function GroupHeaderRow({
  group,
  collapsed,
  onToggle,
}: {
  group: ProjectGroup;
  collapsed: boolean;
  /** Takes the group id — one stable callback for every group row. */
  onToggle: (id: string) => void;
}) {
  const { pinGroup, unpinGroup, removeGroup, renameGroup, beginRenameGroup, endRenameGroup } =
    useProjectStore.use.actions();
  // Editing lives in the store (not local state) so it survives the virtualized
  // row remounting, and so a freshly-created group opens straight into rename.
  const editing = useProjectStore.use.editingGroupId() === group.id;
  const [name, setName] = useState(group.name);
  // Seed the field each time we enter edit mode.
  useEffect(() => {
    if (editing) setName(group.name);
  }, [editing, group.name]);
  const commit = () => {
    const n = name.trim();
    if (n) renameGroup(group.id, n);
    endRenameGroup();
  };
  return (
    <div
      data-hint
      style={{ height: HEADER_H }}
      className="group/h flex items-center gap-2 pl-2 pr-1.5 rounded-md cursor-pointer hover:bg-[var(--atlas-element-hover)]"
      onClick={editing ? undefined : () => onToggle(group.id)}
    >
      {/* Icon and label are sized together: a 12px folder under an 11px label,
          the same pairing the rows below use. A 12px label over an 11px icon
          read as a heading that had lost its glyph. */}
      {collapsed ? (
        <Folder size={12} className="text-[var(--muted-foreground)] shrink-0" />
      ) : (
        <FolderOpen size={12} className="text-[var(--muted-foreground)] shrink-0" />
      )}
      {editing ? (
        <input
          autoFocus
          value={name}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") endRenameGroup();
          }}
          className="min-w-0 flex-1 bg-transparent outline-none text-xs leading-none text-[var(--foreground)]"
        />
      ) : (
        <span
          onDoubleClick={(e) => {
            e.stopPropagation();
            beginRenameGroup(group.id);
          }}
          className="min-w-0 flex-1 truncate text-xs leading-normal text-[var(--secondary-foreground)] group-hover/h:text-[var(--foreground)]"
        >
          {group.name}
        </span>
      )}

      {/* Actions + disclosure in ONE promoted box with NO opacity transition:
          tweening opacity on an unpromoted icon makes WebKit re-rasterise it
          mid-fade, which is the hover wobble (same lesson as the git dot). */}
      <HintGroup>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 transform-gpu [backface-visibility:hidden]">
          {!editing && (
            <HintItem label="Rename group">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  beginRenameGroup(group.id);
                }}
                className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 hover:bg-[var(--card)] hover:text-[var(--foreground)] group-hover/h:opacity-100 focus-visible:opacity-100 cursor-pointer"
              >
                <Pencil size={10} />
              </button>
            </HintItem>
          )}
          <HintItem label={group.pinned ? "Unpin group" : "Pin group"}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (group.pinned) unpinGroup(group.id);
                else pinGroup(group.id);
              }}
              className={cn(
                "flex size-5 items-center justify-center rounded hover:bg-[var(--card)] cursor-pointer",
                group.pinned
                  ? "opacity-100 text-[var(--primary)]"
                  : "opacity-0 group-hover/h:opacity-100 focus-visible:opacity-100 text-[var(--muted-foreground)]",
              )}
            >
              {group.pinned ? <PinOff size={10} /> : <Pin size={10} />}
            </button>
          </HintItem>
          <HintItem label="Delete group">
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeGroup(group.id);
              }}
              className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 hover:bg-[var(--card)] hover:text-[var(--foreground)] group-hover/h:opacity-100 focus-visible:opacity-100 cursor-pointer"
            >
              <X size={10} />
            </button>
          </HintItem>
          {!editing && (
            <ChevronDown
              size={10}
              className={cn(
                "shrink-0 text-[var(--muted-foreground)] transition-transform",
                collapsed && "-rotate-90",
              )}
            />
          )}
        </span>
      </HintGroup>
    </div>
  );
});

/** Clear-all affordances, by section. Derived from the id INSIDE the row so
 *  the caller passes a boolean and a stable callback rather than minting an
 *  `{icon, title, onClick}` object per render — an object prop defeats `memo`
 *  on every row, every frame. */
const CLEAR_TITLE: Record<string, string> = {
  "sec:recent": "Empty trash",
  "sec:chats": "Clear recent chats",
};

const SectionHeaderRow = memo(function SectionHeaderRow({
  id,
  label,
  collapsed,
  onToggle,
  clearable,
  onClear,
}: {
  /** Collapse key. Handlers take it, so they can be shared by every row. */
  id: string;
  label: string;
  collapsed: boolean;
  onToggle: (id: string) => void;
  clearable?: boolean;
  onClear?: (id: string) => void;
}) {
  const { openCreate } = useProjectDialogStore.use.actions();
  return (
    // Sentence case, bold, in the secondary weight, with a small disclosure
    // AFTER the label. The slot is taller than the row: the extra is the gap
    // between sections.
    <div style={{ height: SECTION_H, paddingTop: SECTION_H - HEADER_H }}>
      <div
        data-hint
        onClick={() => onToggle(id)}
        style={{ height: HEADER_H }}
        className="group/s flex w-full items-center gap-1 rounded-md px-2 outline-none cursor-pointer hover:bg-[var(--atlas-element-hover)]"
      >
        <span className="text-xs font-semibold leading-none text-[var(--secondary-foreground)] group-hover/s:text-[var(--foreground)]">
          {label}
        </span>
        {/* Promoted, and NO opacity tween on the action: fading an unpromoted
            icon makes WebKit re-rasterise it mid-fade, which is the hover
            wobble (same lesson as the git dot). */}
        <span className="flex items-center transform-gpu [backface-visibility:hidden]">
          <ChevronDown
            size={10}
            className={cn(
              "text-[var(--muted-foreground)] transition-transform",
              collapsed && "-rotate-90",
            )}
          />
        </span>
        {id === "sec:projects" && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openCreate();
            }}
            title="New Project"
            aria-label="New Project"
            className="ml-auto flex size-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] outline-none cursor-pointer"
          >
            <Plus size={14} />
          </button>
        )}
        {clearable && onClear && (
          <Hint label={CLEAR_TITLE[id] ?? "Clear"}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClear(id);
              }}
              className="ml-auto flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 group-hover/s:opacity-100 focus-visible:opacity-100 hover:bg-[var(--card)] hover:text-error outline-none cursor-pointer transform-gpu [backface-visibility:hidden]"
            >
              <Trash2 size={11} />
            </button>
          </Hint>
        )}
      </div>
    </div>
  );
});

const RecentProjectRow = memo(function RecentProjectRow({
  name,
  path,
  onOpen,
}: {
  name: string;
  path: string;
  /** Takes the path so the parent can hand every row ONE stable callback. */
  onOpen: (path: string) => void;
}) {
  return (
    <div
      data-hint
      onClick={() => onOpen(path)}
      style={{ height: ROW_CARD, paddingLeft: 8 }}
      className="group flex items-center gap-2.5 pr-1.5 rounded-md cursor-pointer hover:bg-[var(--atlas-element-hover)]"
      title={path}
    >
      <Folder size={13} className="shrink-0 text-[var(--muted-foreground)]" />
      <span className="flex-1 min-w-0 truncate text-sm leading-normal text-[var(--secondary-foreground)] group-hover:text-[var(--foreground)]">
        {name}
      </span>
    </div>
  );
});

/** Compact relative time: "now" / "5m" / "3h" / "2d". */
function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

interface WorkspaceSession {
  workspace: Project;
  thread: ThreadRow;
}

const SessionRow = memo(function SessionRow({
  session,
  pinned,
  running,
  nested,
  onOpen,
  onTogglePin,
  onArchive,
}: {
  session: WorkspaceSession;
  pinned: boolean;
  running: boolean;
  nested: boolean;
  onOpen: (session: WorkspaceSession) => void;
  onTogglePin: (threadId: string) => void;
  onArchive: (threadId: string) => void;
}) {
  // Cersei (the Atlas native agent) gets its own brand mark — falling through
  // to the Claude icon mislabeled Atlas chats in this panel.
  const agentType = agentTypeFromPluginId(session.thread.agentId);
  const AgentIcon =
    agentType === "codex" || agentType === "codex-acp"
      ? AgentIcons.Codex
      : agentType === "opencode"
        ? AgentIcons.OpenCode
        : agentType === "cursor"
          ? AgentIcons.Cursor
          : agentType === "kilo"
            ? AgentIcons.Kilo
            : AgentIcons.Claude;
  return (
    <div
      data-hint
      onClick={() => onOpen(session)}
      style={{ height: nested ? ROW_CARD : CHAT_CARD, paddingLeft: nested ? 28 : 8 }}
      className={cn(
        "group relative flex gap-2.5 pr-2 rounded-md cursor-pointer hover:bg-[var(--atlas-element-hover)]",
        nested ? "items-center" : "items-start pt-1.5",
      )}
      title={`${session.workspace.name} — ${session.workspace.path}`}
    >
      {running ? (
        <AtlasLoader size={12} className="shrink-0 text-[var(--primary)]" />
      ) : agentType === "cersei" ? (
        <AtlasIcon size={13} className="shrink-0" />
      ) : (
        <AgentIcon className="size-[13px] shrink-0 opacity-80" />
      )}
      {/* Two lines, like a project row: the chat list spans every project in
          the org, so a title alone cannot say which one a chat belongs to —
          and the titles are the user's own words, which rarely name it. The
          project goes on the second line, where the branch sits one section
          up. The permanent right padding keeps text clear of row actions. */}
      <div className="min-w-0 flex-1 pr-12">
        <span
          className={cn(
            "block truncate text-sm leading-tight",
            running
              ? "text-[var(--foreground)]"
              : "text-[var(--secondary-foreground)] group-hover:text-[var(--foreground)]",
          )}
        >
          {session.thread.title || session.workspace.name}
        </span>
        {!nested && (
          <span className="mt-0.5 block truncate text-2xs leading-tight text-[var(--muted-foreground)]">
            {session.workspace.name}
          </span>
        )}
      </div>
      {!nested && (
        <span className="absolute right-2 top-2 shrink-0 text-2xs leading-none tabular-nums text-[var(--muted-foreground)] group-hover:opacity-0">
          {relTime(Date.parse(session.thread.updatedAt))}
        </span>
      )}
      <span className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(session.thread.threadId);
          }}
          className={cn(
            "flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]",
            pinned ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          title={pinned ? "Unpin session" : "Pin session"}
        >
          {pinned ? <PinOff size={10} /> : <Pin size={10} />}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onArchive(session.thread.threadId);
          }}
          className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:bg-[var(--card)] hover:text-[var(--foreground)]"
          title="Archive session"
        >
          <Archive size={10} />
        </button>
      </span>
    </div>
  );
});

type Row =
  | { kind: "section"; id: string; label: string; key: string }
  | { kind: "group"; group: ProjectGroup; count: number; key: string }
  | { kind: "ws"; ws: Project; indented: boolean; expanded: boolean; key: string }
  | { kind: "session"; session: WorkspaceSession; pinned: boolean; key: string }
  | { kind: "recent"; name: string; path: string; key: string }
  | { kind: "chat"; session: WorkspaceSession; pinned: boolean; key: string };

export function ProjectSidebar() {
  const allProjects = useProjectStore.use.projects();
  // The sidebar shows only the ACTIVE org's projects/groups (strict filter —
  // see org-scope.ts for why there is no null-orgId fallback).
  const projects = useActiveOrgProjects();
  const groups = useActiveOrgGroups();
  const activeProjectId = useProjectStore.use.activeProjectId();
  const optimisticActiveId = useProjectStore.use.optimisticActiveId();
  // Highlight the clicked project INSTANTLY (optimistic), falling back to the
  // real active id once the switch settles.
  const displayActiveId = optimisticActiveId ?? activeProjectId;
  // A project is "open" when it is in the hot set — i.e. mounted in
  // CenterPanel. That is the store's own definition of an open project, and it
  // is what the sidebar's folder-open badge marks.
  const mountedProjectIds = useProjectStore.use.mountedProjectIds();
  const mountedIds = useMemo(() => new Set(mountedProjectIds), [mountedProjectIds]);
  const { addProject } = useProjectStore.use.actions();
  const { addTab, toggleRightPanelMode } = useLayoutStore.use.actions();
  // Which occupant the right slot shows, or null when closed — drives the
  // active state of the Source control item.
  const rightMode = useLayoutStore((s) => (s.rightPanel.visible ? s.rightPanel.mode : null));
  // Source control needs a project (app-layout hides the slot without one), so
  // the item says so instead of toggling a panel that never appears.
  const hasProject = useAppStore((s) => !!s.currentProject);
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const newTabHint = useActionShortcut("nav.newTabPalette")?.label;
  // Mirrors `panels.knowledge` in App.tsx: one Knowledge tab per split column,
  // focused if it already exists.
  const openKnowledge = useCallback(() => {
    const st = useLayoutStore.getState();
    const g = st.focusedGroupId;
    const existing = st.tabs.find((t) => (t.groupId ?? "main") === g && t.type === "knowledge");
    if (existing) {
      st.actions.setActiveTab(existing.id);
      return;
    }
    st.actions.addTab({
      id: `knowledge-${Date.now()}`,
      type: "knowledge",
      title: "Knowledge",
      closable: true,
      dirty: false,
      data: {},
    });
  }, []);
  // Same open-or-focus shape as `openKnowledge`. Deliberately NOT gated on a
  // project: only the panel's Shared tab needs one, and it says so itself —
  // the graph, policy and timeline views are global.
  const openMemory = useCallback(() => {
    const st = useLayoutStore.getState();
    const g = st.focusedGroupId;
    const existing = st.tabs.find((t) => (t.groupId ?? "main") === g && t.type === "memory");
    if (existing) {
      st.actions.setActiveTab(existing.id);
      return;
    }
    st.actions.addTab({
      id: `memory-${Date.now()}`,
      type: "memory",
      title: "Memory",
      closable: true,
      dirty: false,
      data: {},
    });
  }, []);
  const recentProjects = useAppStore.use.recentProjects();
  const { clearRecents } = useAppStore.use.actions();
  const queryClient = useQueryClient();
  const { data: sessionProjects = [] } = useQuery<ThreadProject[]>({
    queryKey: ["thread-projects", ""],
    queryFn: () => threadProjects(""),
    staleTime: 30_000,
  });
  useEffect(() => {
    const unlisten = onThreadsChanged(() => {
      void queryClient.invalidateQueries({ queryKey: ["thread-projects"] });
    });
    return () => void unlisten.then((stop) => stop());
  }, [queryClient]);
  const pinnedThreadIds = useSessionPinsStore.use.pinnedThreadIds();
  const { toggle: toggleSessionPin, remove: removeSessionPin } = useSessionPinsStore.use.actions();
  const pinnedThreadSet = useMemo(() => new Set(pinnedThreadIds), [pinnedThreadIds]);
  const runningChatKeys = useRunningChatKeys();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  // Stable identities, all of them: every row below is memoised, and a fresh
  // closure per render would defeat that on every row of every render.
  const toggle = useCallback((id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] })), []);
  const toggleProject = useCallback(
    (id: string) => setExpandedProjects((current) => ({ ...current, [id]: !current[id] })),
    [],
  );

  // Pinned + Projects (registry order — clicking never reorders; dragging a
  // row does, see `startProjectDrag`).
  const pinned = useMemo(() => projects.filter((w) => w.pinned), [projects]);
  const unpinned = useMemo(() => projects.filter((w) => !w.pinned), [projects]);
  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.order - b.order),
    [groups],
  );

  // Recent projects = picker recents for THIS org, minus anything already in
  // the registry. Excludes projects open in ANY org so nothing double-lists.
  // Recents used to be global, which put other orgs' project names and full
  // paths in this list — see `recentsForOrg`.
  const openPaths = useMemo(() => new Set(allProjects.map((w) => w.path)), [allProjects]);
  const recents = useMemo(
    () =>
      recentsForOrg(recentProjects, allProjects, activeOrganisationId).filter(
        (r) => !openPaths.has(r.path),
      ),
    [recentProjects, allProjects, activeOrganisationId, openPaths],
  );

  const latestSessions = useMemo(
    () =>
      projects.flatMap((workspace) => {
        const thread = latestWorkspaceSession(sessionProjects, workspace.path);
        return thread ? [{ workspace, thread }] : [];
      }),
    [sessionProjects, projects],
  );

  // Flatten everything into one virtualized row list. Sections AND group
  // folders are collapsible; a collapsed section omits all its content rows.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const pushWorkspace = (ws: Project, indented: boolean) => {
      const expanded = !!expandedProjects[ws.id];
      out.push({ kind: "ws", ws, indented, expanded, key: ws.id });
      if (!expanded) return;
      for (const thread of workspaceSessions(sessionProjects, ws.path, pinnedThreadSet)) {
        out.push({
          kind: "session",
          session: { workspace: ws, thread },
          pinned: pinnedThreadSet.has(thread.threadId),
          key: `session:${thread.threadId}`,
        });
      }
    };
    if (pinned.length) {
      out.push({
        kind: "section",
        id: "sec:pinned",
        label: "Pinned",
        key: "s:pinned",
      });
      if (!collapsed["sec:pinned"]) for (const ws of pinned) pushWorkspace(ws, false);
    }
    out.push({
      kind: "section",
      id: "sec:projects",
      label: "Projects",
      key: "s:projects",
    });
    if (!collapsed["sec:projects"]) {
      const inGroup = (gid: string) => unpinned.filter((w) => w.groupId === gid);
      for (const g of sortedGroups) {
        const members = inGroup(g.id);
        out.push({
          kind: "group",
          group: g,
          count: members.length,
          key: `g:${g.id}`,
        });
        if (!collapsed[g.id]) for (const ws of members) pushWorkspace(ws, true);
      }
      for (const ws of unpinned.filter((w) => !w.groupId)) pushWorkspace(ws, false);
    }
    if (recents.length) {
      out.push({
        kind: "section",
        id: "sec:recent",
        label: "Trash",
        key: "s:recent",
      });
      if (!collapsed["sec:recent"])
        for (const r of recents)
          out.push({
            kind: "recent",
            name: r.name,
            path: r.path,
            key: `r:${r.path}`,
          });
    }
    if (latestSessions.length) {
      out.push({
        kind: "section",
        id: "sec:chats",
        label: "Recent",
        key: "s:chats",
      });
      if (!collapsed["sec:chats"])
        for (const session of [...latestSessions].sort(
          (a, b) => Date.parse(b.thread.updatedAt) - Date.parse(a.thread.updatedAt),
        ))
          out.push({
            kind: "chat",
            session,
            pinned: pinnedThreadSet.has(session.thread.threadId),
            key: `chat:${session.thread.threadId}`,
          });
    }
    return out;
  }, [
    pinned,
    unpinned,
    sortedGroups,
    collapsed,
    expandedProjects,
    recents,
    latestSessions,
    sessionProjects,
    pinnedThreadSet,
  ]);

  // ── Git summaries ────────────────────────────────────────────────────
  // Cached at module scope (`project-git-store`) so opening / closing the
  // switcher renders instantly from cache and NEVER recalculates. First sight
  // fetches; a global git-changed listener silently refreshes in the
  // background. WHICH paths get fetched is the list's business (it knows what
  // is on screen), so the map is all this level needs.
  const summaries = useProjectGitStore.use.summaries();

  const openRecent = useCallback((path: string) => void addProject(path), [addProject]);

  const clearSection = useCallback(
    (id: string) => {
      if (id === "sec:recent") {
        clearRecents();
        return;
      }
    },
    [clearRecents],
  );

  const openSession = useCallback(async (session: WorkspaceSession) => {
    // Focus the owning project before loading the selected session.
    await useProjectStore.getState().actions.switchTo(session.workspace.id);
    await openAgentSession({
      acpSessionId: session.thread.sessionId ?? undefined,
      title: session.thread.title,
      cwd: session.thread.folderPaths[0] ?? session.workspace.path,
      agentType: agentTypeFromPluginId(session.thread.agentId),
    });
  }, []);

  const archiveSession = useCallback(
    (threadId: string) => {
      void archiveThread(threadId)
        .then(() => {
          removeSessionPin(threadId);
          return queryClient.invalidateQueries({ queryKey: ["thread-projects"] });
        })
        .catch((error) =>
          toast.error(
            `Couldn't archive session: ${error instanceof Error ? error.message : error}`,
          ),
        );
    },
    [queryClient, removeSessionPin],
  );

  return (
    <aside
      // Transparent — the surface (gradient + blur) lives on the wrapper in
      // app-layout.tsx, not here. Putting the blur on this child would break
      // it: the wrapper's opacity/transform isolates its own layer, leaving a
      // descendant's backdrop-filter nothing to sample.
      className="flex flex-col h-screen w-[244px] shrink-0 bg-transparent"
      data-tauri-drag-region
    >
      {/* Virtualized list. */}
      {/* The rail's interface card — the same recipe as team chat's
          `CommsSurface`: a near-black rounded surface floating on the panel's
          gradient, inset on all sides, its edge carried by a
          hairline ring with a soft shadow behind it. No blur and no transform,
          so it is safe inside a vibrant panel.

          The card is the SCROLL BOUNDARY too, which is what makes it read as
          one object: rows disappear under its rounded top edge rather than
          sliding past a straight seam. */}
      <div
        // Same reasoning as CommsSurface: on a near-black panel the shadow has
        // almost nothing to darken, so the ring carries the edge.
        className="relative m-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-background shadow-lg ring-1 ring-border"
      >
        {/* ONE scroller for the whole rail (see `RailScroll`).
            The navigation used to be pinned above it, which cost ~200px of
            permanently-frozen height — on a short window the project list was
            reduced to a slot a few rows tall while six fixed rows sat above it.
            Nothing is fixed above it now; the nav is handed to the list as
            children and scrolls away with it. */}
        {/* Fades, not a scrollbar: rows enter and leave at the card's rounded
            edges, and a hard cut there reads as clipping. Anchored to the CARD
            (its `relative`), so the bottom one sits above the footer row rather
            than under it. `pointer-events-none` so neither eats a click, and
            plain gradients — no blur, no transform — so they cost a paint and
            nothing else. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-panel h-6 rounded-t-lg"
          style={{
            background:
              "linear-gradient(to bottom, var(--background) 20%, color-mix(in srgb, var(--background) 55%, transparent) 60%, transparent)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-[30px] z-panel h-6"
          style={{
            background:
              "linear-gradient(to top, var(--background) 20%, color-mix(in srgb, var(--background) 55%, transparent) 60%, transparent)",
          }}
        />
        <RailScroll
          rows={rows}
          collapsed={collapsed}
          summaries={summaries}
          groups={groups}
          activeId={displayActiveId}
          runningKeys={runningChatKeys}
          mountedIds={mountedIds}
          onToggle={toggle}
          onToggleProject={toggleProject}
          onOpenRecent={openRecent}
          onOpenSession={openSession}
          onToggleSessionPin={toggleSessionPin}
          onArchiveSession={archiveSession}
          onClearSection={clearSection}
        >
          {/* Project-scoped tools under their own collapsible "Modules"
           *  heading, the same disclosure the list below uses, so the rail
           *  reads as one outline ending in "More". */}
          <nav className="pt-1 pb-1 space-y-px">
            <SectionHeaderRow
              id="sec:tools"
              label="Modules"
              collapsed={!!collapsed["sec:tools"]}
              onToggle={toggle}
            />
            {!collapsed["sec:tools"] && (
              <>
                <NavItem
                  icon={<Sparkles size={14} />}
                  label="Agents"
                  disabled={!hasProject}
                  title={hasProject ? undefined : "Open a project to start an agent"}
                  // Zero-arg wrapper, NOT a bare reference: openNewAgentChat's
                  // optional parameter would otherwise receive the click event.
                  onClick={() => openNewAgentChat()}
                />
                <NavItem
                  icon={<BookOpen size={14} />}
                  label="Knowledge"
                  disabled={!hasProject}
                  title={hasProject ? undefined : "Open a project to open its knowledge base"}
                  onClick={openKnowledge}
                />
                <NavItem
                  icon={<TerminalSquare size={14} />}
                  label="Terminal"
                  onClick={() =>
                    // Mirrors `tabs.newTerminal` in App.tsx: a fresh tab each time.
                    addTab({
                      id: `terminal-${Date.now()}`,
                      type: "terminal",
                      title: "Terminal",
                      closable: true,
                      dirty: false,
                      data: {},
                    })
                  }
                />
                <NavItem
                  icon={<GitBranch size={14} />}
                  label="Source control"
                  active={rightMode === "source-control"}
                  disabled={!hasProject}
                  title={hasProject ? undefined : "Open a project to see its source control"}
                  onClick={() => toggleRightPanelMode("source-control")}
                />
                <NavItem icon={<BrainCircuit size={14} />} label="Memory" onClick={openMemory} />
                {/* Usage is a module, not rail chrome. It was up with the pin
                 *  and collapse-all buttons, which are controls on the SIDEBAR
                 *  ITSELF — Usage opens a tab, like every row here. Same
                 *  singleton id either way, so an open Usage tab is focused
                 *  rather than duplicated. */}
                <NavItem
                  icon={<Gauge size={14} />}
                  label="Usage"
                  onClick={() =>
                    addTab({
                      id: "usage",
                      type: "usage",
                      title: "Usage",
                      closable: true,
                      dirty: false,
                      data: {},
                    })
                  }
                />
                <NavItem
                  icon={<Ellipsis size={14} />}
                  label="More"
                  title={newTabHint ? `Open a module (${newTabHint})` : "Open a module"}
                  onClick={() => window.dispatchEvent(new CustomEvent("atlas:new-tab-palette"))}
                />
              </>
            )}
          </nav>
        </RailScroll>

        {/* Card footer: help on the left, version on the right. Outside the
            scroller so it stays put, inside the card so it belongs to it. */}
        <div className="relative z-panel flex h-[30px] shrink-0 items-center justify-between px-2">
          <HelpMenu />
          <AppVersion />
        </div>
      </div>
    </aside>
  );
}

/** One row of the fixed navigation: 28px, icon in the quiet weight, label in
 *  the body weight, both stepping up together on hover. `active` is the
 *  resting fill of the row whose panel is open. */
function NavItem({
  icon,
  label,
  onClick,
  active,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        "group/nav flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm leading-none outline-none transition-colors cursor-pointer",
        "disabled:cursor-default disabled:opacity-40",
        active
          ? "bg-[var(--atlas-element-active)] text-[var(--foreground)]"
          : "text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center",
          active
            ? "text-[var(--foreground)]"
            : "text-[var(--muted-foreground)] group-hover/nav:text-[var(--secondary-foreground)]",
        )}
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

// ── The scrolling list ─────────────────────────────────────────────────────
//
// Split out of `ProjectSidebar` for one reason: a virtualizer re-renders its
// OWNER on every scroll event. With the hook at the top of the rail, a fling
// re-ran fifteen store selectors, the whole navigation and every visible row
// wrapper per frame, all to produce identical output. Down here the
// only thing a frame can touch is the list.

/** Above this many rows the list virtualizes; below it, plain DOM.
 *
 *  Virtualization is not free — it trades a render per scroll frame for DOM it
 *  does not create. Under a hundred-odd rows that is a bad trade: WebKit
 *  scrolls a composited layer with no main-thread work at all, so plain rows
 *  scroll at zero cost while the virtualized ones cost a React render per
 *  frame. The rail is normally well under this (one org's projects, at most
 *  fifteen chats, the unopened recents), so the fast path is the usual one. */
const VIRTUALIZE_ABOVE = 120;

interface RailRowCtx {
  collapsed: Record<string, boolean>;
  summaries: Record<string, GitSummary>;
  groups: ProjectGroup[];
  activeId: string | null;
  runningKeys: Set<string>;
  /** Ids of workspaces currently MOUNTED (open) — the row badges these. */
  mountedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleProject: (id: string) => void;
  onOpenRecent: (path: string) => void;
  onOpenSession: (session: WorkspaceSession) => void;
  onToggleSessionPin: (threadId: string) => void;
  onArchiveSession: (threadId: string) => void;
  onClearSection: (id: string) => void;
}

/** One row, with every prop reduced to a primitive or a stable identity — so
 *  the memo on each row component actually bails. Collapsing a section, for
 *  instance, changes the `collapsed` MAP, but only one row's boolean. */
function renderRailRow(row: Row, ctx: RailRowCtx) {
  switch (row.kind) {
    case "section":
      return (
        <SectionHeaderRow
          id={row.id}
          label={row.label}
          collapsed={!!ctx.collapsed[row.id]}
          onToggle={ctx.onToggle}
          clearable={row.id === "sec:recent"}
          onClear={ctx.onClearSection}
        />
      );
    case "group":
      return (
        <GroupHeaderRow
          group={row.group}
          collapsed={!!ctx.collapsed[row.group.id]}
          onToggle={ctx.onToggle}
        />
      );
    case "ws":
      return (
        <ProjectRow
          ws={row.ws}
          active={row.ws.id === ctx.activeId}
          summary={ctx.summaries[row.ws.path]}
          groups={ctx.groups}
          indented={row.indented}
          expanded={row.expanded}
          mounted={ctx.mountedIds.has(row.ws.id)}
          onToggleProject={ctx.onToggleProject}
        />
      );
    case "session":
      return (
        <SessionRow
          session={row.session}
          pinned={row.pinned}
          running={
            !!row.session.thread.sessionId && ctx.runningKeys.has(row.session.thread.sessionId)
          }
          nested
          onOpen={ctx.onOpenSession}
          onTogglePin={ctx.onToggleSessionPin}
          onArchive={ctx.onArchiveSession}
        />
      );
    case "recent":
      return <RecentProjectRow name={row.name} path={row.path} onOpen={ctx.onOpenRecent} />;
    case "chat":
      return (
        <SessionRow
          session={row.session}
          pinned={row.pinned}
          running={
            !!row.session.thread.sessionId && ctx.runningKeys.has(row.session.thread.sessionId)
          }
          nested={false}
          onOpen={ctx.onOpenSession}
          onTogglePin={ctx.onToggleSessionPin}
          onArchive={ctx.onArchiveSession}
        />
      );
  }
}

/**
 * Fetch the git summaries for a set of paths, a few per frame.
 *
 * `ensure` is idempotent (the store keeps fetched/in-flight sets), so the cost
 * of a repeat call is a Set lookup — but the FIRST pass over a fresh list
 * spawns one `git` per path, and firing a hundred at once on mount is a stall
 * the rail does not need to cause. Eight per frame drains a full list in a
 * handful of frames and never blocks one.
 *
 * Keyed by a joined string so the effect re-runs when the SET changes, not when
 * an array identity does.
 */
function useEnsureSummaries(pathsKey: string) {
  const { ensure } = useProjectGitStore.use.actions();
  useEffect(() => {
    if (!pathsKey) return;
    const paths = pathsKey.split("\n");
    let i = 0;
    let raf = 0;
    const step = () => {
      for (let n = 0; n < 8 && i < paths.length; n++, i++) ensure(paths[i]);
      raf = i < paths.length ? requestAnimationFrame(step) : 0;
    };
    step();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pathsKey, ensure]);
}

/** Shared scroller chrome. The nav (`children`) rides INSIDE it, so it scrolls
 *  away with the lists rather than freezing a fifth of the rail. */
const SCROLLER_CLASS = "flex-1 min-h-0 overflow-y-auto hide-scrollbar px-2 py-1.5";

const RailScroll = memo(function RailScroll({
  rows,
  children,
  ...ctx
}: { rows: Row[]; children: React.ReactNode } & RailRowCtx) {
  // Component-level branch, not a conditional hook: each body owns its own
  // hooks, and crossing the threshold remounts the scroller (a scroll position
  // lost on a list that just grew past 120 rows is not worth a design for).
  return rows.length > VIRTUALIZE_ABOVE ? (
    <VirtualRail rows={rows} {...ctx}>
      {children}
    </VirtualRail>
  ) : (
    <PlainRail rows={rows} {...ctx}>
      {children}
    </PlainRail>
  );
});

/** The fast path: no virtualizer, so NOTHING runs on a scroll frame. */
function PlainRail({
  rows,
  children,
  ...ctx
}: { rows: Row[]; children: React.ReactNode } & RailRowCtx) {
  const pathsKey = useMemo(
    () =>
      rows
        .filter((r): r is Extract<Row, { kind: "ws" }> => r.kind === "ws")
        .map((r) => r.ws.path)
        .join("\n"),
    [rows],
  );
  useEnsureSummaries(pathsKey);
  return (
    <div className={SCROLLER_CLASS}>
      {children}
      {rows.length === 0 ? (
        <EmptyRail />
      ) : (
        rows.map((row) => <div key={row.key}>{renderRailRow(row, ctx)}</div>)
      )}
    </div>
  );
}

/** The long-list path. Re-renders per scroll frame by design — which is why it
 *  is this small, and why nothing above it is in the frame. */
function VirtualRail({
  rows,
  children,
  ...ctx
}: { rows: Row[]; children: React.ReactNode } & RailRowCtx) {
  const parentRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  // The rows do not start at the scroller's top — the nav sits above them
  // inside the same scroll element. Without `scrollMargin` the virtualizer maps
  // `scrollTop` straight onto row offsets and materialises the wrong window
  // (rows blank out early at the top, arrive late at the bottom). Measured off
  // the two rects rather than `offsetTop`, which answers relative to the
  // nearest POSITIONED ancestor — the card, not the scroller.
  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    const nav = navRef.current;
    const scroller = parentRef.current;
    if (!nav || !scroller) return;
    const measure = () =>
      setScrollMargin(
        nav.getBoundingClientRect().bottom -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      );
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    scrollMargin,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const k = rows[i]?.kind;
      if (k === "ws") return WS_H;
      if (k === "session") return ROW_H;
      if (k === "chat") return CHAT_H;
      if (k === "recent") return ROW_H;
      if (k === "section") return SECTION_H;
      return HEADER_H + 2; // group headers
    },
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  const items = virtualizer.getVirtualItems();
  // The visible RANGE, not the visible paths: building and diffing a path
  // string per frame is exactly the work this component exists to avoid. Two
  // numbers as deps means the walk runs when the window moves, not when it is
  // merely redrawn at a new offset.
  const first = items.length ? items[0].index : 0;
  const last = items.length ? items[items.length - 1].index : -1;
  const pathsKey = useMemo(() => {
    const out: string[] = [];
    for (let i = first; i <= last; i++) {
      const r = rows[i];
      if (r?.kind === "ws") out.push(r.ws.path);
    }
    return out.join("\n");
  }, [rows, first, last]);
  useEnsureSummaries(pathsKey);

  return (
    <div ref={parentRef} className={SCROLLER_CLASS}>
      <div ref={navRef}>{children}</div>
      {rows.length === 0 ? (
        <EmptyRail />
      ) : (
        <div style={{ height: virtualizer.getTotalSize() - scrollMargin, position: "relative" }}>
          {items.map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            return (
              <div
                key={row.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  // `scrollMargin` is baked into `v.start` (measured from the
                  // SCROLLER's top, past the nav); subtract it for the offset
                  // within this wrapper.
                  transform: `translateY(${v.start - scrollMargin}px)`,
                }}
              >
                {renderRailRow(row, ctx)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyRail() {
  return <div className="px-2 py-3 text-xs text-[var(--muted-foreground)]">No projects yet.</div>;
}

/** Where the help menu points. Grouped as they render: docs and support, then
 *  the public channels, then the app's own surfaces. */
const DOCS_URL = "https://docs.tryatlas.cc/docs/getting-started";
const GITHUB_URL = "https://github.com/pacifio/atlas";
const DISCORD_URL = "https://discord.gg/GmnFggaPfP";
const X_URL = "https://x.com/tryatlas_cc";
const SITE_URL = "https://tryatlas.cc/";

function HelpItem({
  icon,
  label,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onClick={onSelect}
      className="flex h-control-md items-center gap-2 rounded-md px-1.5 text-xs text-[var(--secondary-foreground)] outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-[var(--muted-foreground)]">
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
    </DropdownMenu.Item>
  );
}

/** Help, community and the app's own destinations. A dropdown rather than a
 *  row of links: the rail's footer has room for one control, and this is the
 *  drawer everything that is neither a project nor a module lives in. */
function HelpMenu() {
  return (
    <DropdownMenu.Root>
      <Hint label="Help & community" side="top">
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              aria-label="Help and community"
              className="flex size-[22px] items-center justify-center rounded-full border border-border-subtle text-[var(--muted-foreground)] outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer"
            >
              <HelpCircle size={12} />
            </button>
          }
        />
      </Hint>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="start" side="top" sideOffset={6}>
          <DropdownMenu.Popup className="w-[212px] overflow-hidden rounded-xl border border-border-subtle bg-[var(--card)]/95 p-1 backdrop-blur-2xl shadow-md select-none">
            <HelpItem
              icon={<BookOpen size={12} />}
              label="Docs"
              onSelect={() => void openUrl(DOCS_URL)}
            />
            <HelpItem
              icon={<MessageCircleQuestion size={12} />}
              label="Send feedback"
              // The panel is non-modal and anchored bottom-right; `toggle` is what
              // the status-bar button uses, and the source tags the report.
              onSelect={() => useFeedbackStore.getState().actions.toggle("status-bar")}
            />
            <HelpItem
              icon={<Keyboard size={12} />}
              label="Keyboard shortcuts"
              onSelect={() => openSettingsSection("keybindings")}
            />

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <HelpItem
              icon={<GithubIcon className="size-3" />}
              label="GitHub repo"
              onSelect={() => void openUrl(GITHUB_URL)}
            />
            <HelpItem
              icon={<MessageCircle size={12} />}
              label="Discord community"
              onSelect={() => void openUrl(DISCORD_URL)}
            />
            <HelpItem icon={<XIcon />} label="Follow on X" onSelect={() => void openUrl(X_URL)} />

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <HelpItem
              icon={<Settings size={12} />}
              label="Settings"
              onSelect={() => openSettingsSection("general")}
            />
            <HelpItem
              icon={<Globe size={12} />}
              label="Our website"
              onSelect={() => void openUrl(SITE_URL)}
            />
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** X's mark. Not in lucide (it ships the pre-rebrand bird), and `currentColor`
 *  on a `fill` so it tracks the row's hover step like every other icon here. */
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** The running build's version. Read from Tauri rather than `package.json`:
 *  the bundle carries its own version, and a stale import would claim the
 *  wrong one after an update. Renders nothing until it resolves. */
function AppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void getVersion()
      .then((v) => {
        if (live) setVersion(v);
      })
      .catch(() => {
        // Not worth surfacing: a missing version number costs the reader
        // nothing, and this runs on every rail mount.
      });
    return () => {
      live = false;
    };
  }, []);
  if (!version) return null;
  return (
    // A button, not a span, so the version can be lifted into a bug report
    // without retyping it. The class list is unchanged except for the hover
    // colour and the cursor: Tailwind's preflight already strips a button's
    // padding, border and background, and both elements are flex items of the
    // footer row, so the box and the alignment are exactly what they were.
    <button
      type="button"
      title="Copy version"
      onClick={() => {
        // The bare number is what a version field or a release tag wants; the
        // toast repeats it so there is no doubt about what was copied.
        // `copyText` RESOLVES false on failure rather than rejecting, so the
        // result has to be read — a `.catch()` alone would report success on a
        // copy that never landed.
        void copyText(version).then((ok) => {
          if (ok) toast.success(`Copied ${version}`);
          else toast.error("Could not copy the version.");
        });
      }}
      className="cursor-pointer select-none pr-1 font-mono text-2xs tabular-nums text-[var(--muted-foreground)] transition-colors hover:text-[var(--secondary-foreground)]"
    >
      v{version}
    </button>
  );
}
