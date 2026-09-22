/**
 * The create / edit-project dialog.
 *
 * One component serves both modes because the fields are identical: only the
 * title, the footer's primary verb, and the presence of the destructive
 * "Remove local project" differ. Create mode gates on a chosen folder (a
 * project with no path has nothing to open); edit mode additionally allows
 * re-pointing an existing row at a different folder.
 *
 * Open state lives in `useProjectDialogStore` (mounted once in App) rather than
 * local state, because four surfaces trigger it from different subtrees: the
 * sidebar's "+", the Add-project menu, the welcome screen and the hotkey.
 */
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Folder, FolderPlus, Loader2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/paths";
import { useWorkspaceStore } from "../stores/workspace-store";
import { useProjectDialogStore } from "../lib/project-dialog";
import { ProjectIconPicker } from "./project-icon-picker";

/** The app's pill-button language (matches the create-org dialog footer). */
const pillButton =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 py-1.5 text-[11px] font-medium leading-none cursor-pointer transition-colors";

/** Open the native folder picker. Returns null when the user cancels or the
 *  dialog plugin is unavailable (e.g. a non-Tauri context). */
async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true });
    return typeof selected === "string" ? selected : null;
  } catch {
    return null;
  }
}

export function ProjectDialog() {
  const dialog = useProjectDialogStore.use.dialog();
  const { close } = useProjectDialogStore.use.actions();
  const { addWorkspace, updateWorkspace, closeWorkspace } = useWorkspaceStore.use.actions();

  const targetId = dialog.mode === "edit" ? dialog.workspaceId : null;
  const open = dialog.mode !== "closed";

  const [name, setName] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [icon, setIcon] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  /** False until the user types a name, so the field can keep tracking the
   *  chosen folder (create mode); seeded true in edit mode so re-pointing the
   *  folder never clobbers a name the user already curated. */
  const [nameDirty, setNameDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Seed (or clear) every field each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const ws = targetId
      ? useWorkspaceStore.getState().workspaces.find((w) => w.id === targetId)
      : undefined;
    setName(ws?.name ?? "");
    setPath(ws?.path ?? null);
    setIcon(ws?.icon ?? null);
    setColor(ws?.color ?? null);
    setNameDirty(Boolean(ws));
    setSubmitting(false);
  }, [open, targetId]);

  const chooseFolder = async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setPath(picked);
    if (!nameDirty) setName(basename(picked));
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!path || !trimmed || submitting) return;
    setSubmitting(true);
    try {
      if (targetId) {
        updateWorkspace(targetId, {
          name: trimmed,
          path,
          icon: icon ?? undefined,
          color: color ?? undefined,
        });
      } else {
        const id = await addWorkspace(path);
        if (!id) {
          toast.error("Could not create the project");
          setSubmitting(false);
          return;
        }
        updateWorkspace(id, {
          name: trimmed,
          icon: icon ?? undefined,
          color: color ?? undefined,
        });
      }
      close();
    } catch (error) {
      toast.error(
        "Could not save the project: " + (error instanceof Error ? error.message : String(error)),
      );
      setSubmitting(false);
    }
  };

  const removeLocal = async () => {
    if (!targetId) return;
    await closeWorkspace(targetId);
    close();
  };

  if (!open) return null;
  // The row vanished while the dialog was open (removed elsewhere) - nothing
  // left to edit.
  if (targetId && !useWorkspaceStore.getState().workspaces.some((w) => w.id === targetId)) {
    return null;
  }

  const editing = Boolean(targetId);
  const canSubmit = Boolean(path) && name.trim().length > 0 && !submitting;

  return (
    <Dialog.Root open onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        {/* Strong dim + blur, same language as the other app modals. */}
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-max)] bg-black/45 backdrop-blur-xl" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault();
              void submit();
            }
          }}
          className={cn(
            "fixed left-1/2 top-1/2 z-[var(--z-max)] -translate-x-1/2 -translate-y-1/2",
            "w-[440px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border-default)]",
            "bg-[var(--bg-elevated)]/60 backdrop-blur-2xl",
            "shadow-[var(--shadow-overlay)] animate-scale-in",
          )}
        >
          <Dialog.Close
            className="absolute right-2.5 top-2.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]"
            aria-label="Close"
          >
            <X size={13} />
          </Dialog.Close>

          <div className="px-4 pt-3.5 pb-4">
            <Dialog.Title className="text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {editing ? "Edit project" : "New project"}
            </Dialog.Title>

            <div className="mt-3.5 space-y-3">
              {/* Icon + name share one frame: the picker tile is the field's
                  leading adornment, matching the mockup. */}
              <div className="flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-input)] p-1 focus-within:border-[var(--border-strong)]">
                <ProjectIconPicker
                  icon={icon}
                  color={color}
                  onIconChange={setIcon}
                  onColorChange={setColor}
                />
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameDirty(true);
                  }}
                  placeholder="Project name"
                  className="h-8 flex-1 bg-transparent px-1 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
                />
              </div>

              {/* Source folder */}
              <div>
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                  Source folder
                </span>
                <div className="mt-1 overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-input)]">
                  {path && (
                    <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
                      <Folder size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                      <span
                        className="flex-1 truncate text-[12px] text-[var(--text-primary)]"
                        title={path}
                      >
                        {basename(path)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setPath(null)}
                        title="Remove folder"
                        aria-label="Remove folder"
                        className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => void chooseFolder()}
                    className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    <FolderPlus size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                    <span className="flex-1 text-left">
                      {path ? "Change folder" : "Add folder"}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Footer: destructive action on the left, the rest on the right. */}
            <div className="mt-4 flex items-center gap-2">
              {editing && (
                <button
                  onClick={() => void removeLocal()}
                  className={cn(
                    pillButton,
                    "border-transparent bg-error/10 text-error hover:bg-error/15",
                  )}
                >
                  <Trash2 size={12} />
                  Remove local project
                </button>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  onClick={() => close()}
                  className={cn(
                    pillButton,
                    "bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                  )}
                >
                  Cancel
                </button>
                <button
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                  className={cn(
                    pillButton,
                    "bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                  )}
                >
                  {submitting && <Loader2 size={12} className="animate-spin" />}
                  {editing ? "Save" : "Create project"}
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
