// Map hardcoded neutral hex colors to the token that plays the same role.
// Run after 02-shade.
//
// These are role mappings, not value matches: in Atlas Black most land within
// a few channel steps of the literal they replace, and the ones that move
// further are listed in the plan. Under the other dark themes these surfaces
// start following the theme, which they previously ignored.
//
// Deliberately NOT mapped (they stay literal):
//   bg-[#000] in terminal-panel / block-terminal — must match xterm's own
//     canvas background, which light-mode work themes together with it
//   bg-black in media-lightbox / message-group — media letterboxing
//   bg-white in pdf-viewer (pages) and settings-panel (toggle knob)
//   text-white on colored fills (avatars, danger buttons, cursor labels,
//     the blue capture pill) and in the two "never text-white" comments
//   hover:bg-[#e81123] — the Windows close-button red

import { abs, session } from "./lib.mjs";

const s = session("03-roles");

const F = {
  appCtx: "src/components/app-context-menu.tsx",
  branch: "src/components/branch-popover.tsx",
  statusBar: "src/components/status-bar.tsx",
  titlebar: "src/components/titlebar.tsx",
  dock: "src/components/titlebar-dock.tsx",
  artifactsPanel: "src/features/artifacts/components/artifacts-panel.tsx",
  calendar: "src/features/artifacts/components/calendar-view.tsx",
  checkpoints: "src/features/artifacts/components/checkpoints-picker.tsx",
  sessionStats: "src/features/artifacts/components/session-stats.tsx",
  accountBtn: "src/features/auth/components/account-button.tsx",
  browser: "src/features/browser/components/browser-panel.tsx",
  capture: "src/features/capture/components/capture-popover.tsx",
  transcript: "src/features/chat/components/transcript-rows.tsx",
  commsAvatar: "src/features/comms/components/comms-avatar.tsx",
  composer: "src/features/comms/components/comms-composer.tsx",
  filesTab: "src/features/comms/components/files-tab.tsx",
  feedbackBtn: "src/features/feedback/components/feedback-button.tsx",
  diffView: "src/features/git/components/diff-view.tsx",
  editorFooter: "src/features/knowledge/components/editor-footer.tsx",
  logPanel: "src/features/log/components/log-panel.tsx",
  memTimeline: "src/features/memory/components/memory-timeline-view.tsx",
  mention: "src/features/mentions/components/mention-picker.tsx",
  dashHeader: "src/features/mission-control/components/dashboard/dashboard-header.tsx",
  createOrg: "src/features/organisations/components/create-org-dialog.tsx",
  loadingOrg: "src/features/organisations/components/loading-organisation-overlay.tsx",
  members: "src/features/organisations/components/members-modal.tsx",
  themesSettings: "src/features/settings/components/atlas-themes-settings.tsx",
  editorThemesSettings: "src/features/settings/components/code-editor-themes-settings.tsx",
  spaceChrome: "src/features/spaces/components/space-chrome.tsx",
  spacePages: "src/features/spaces/components/space-pages.tsx",
  terminalPanel: "src/features/terminal/components/terminal-panel.tsx",
  addProject: "src/features/workspaces/components/add-project-menu.tsx",
  wsSidebar: "src/features/workspaces/components/workspace-sidebar.tsx",
  ctxMenu: "src/ui/context-menu.tsx",
};

/**
 * [class, replacement, { fileKey: expectedCount }, linePredicate?]
 * Order matters: variant-prefixed classes first. Bare classes only match when
 * not preceded by a variant (`:`), a word character or `-`.
 */
const TABLE = [
  // ── hover / focus variants ──
  ["hover:text-[#aaa]", "hover:text-text-secondary", { branch: 1, titlebar: 2, accountBtn: 1 }],
  ["hover:text-[#ccc]", "hover:text-text-primary", { dock: 1 }],
  ["hover:text-[#fff]", "hover:text-text-primary", { appCtx: 1, browser: 6 }],
  ["hover:text-white", "hover:text-text-primary", { titlebar: 1, terminalPanel: 1 }],
  ["hover:bg-[#1a1a1a]", "hover:bg-bg-hover", { appCtx: 1, browser: 6 }],
  ["hover:bg-[#141414]", "hover:bg-bg-hover", { diffView: 1 }],
  ["hover:bg-[#1f1f1f]", "hover:bg-bg-active", { titlebar: 1 }],
  // Controls pair a resting border (#303030) with a focus/selected border
  // (#4a4a4a). Both must keep distinct tokens, or focus stops showing.
  ["focus:border-[#4a4a4a]", "focus:border-border-focus", { capture: 1, createOrg: 1 }],
  ["focus-within:border-[#4a4a4a]", "focus-within:border-border-focus", { createOrg: 1 }],

  // ── text ──
  ["text-[#aaa]", "text-text-secondary", { appCtx: 1, browser: 6 }],
  ["text-[#999]", "text-text-secondary", { titlebar: 1 }],
  ["text-[#ccc]", "text-text-primary", { titlebar: 1, accountBtn: 1 }],
  ["text-[#777]", "text-text-tertiary", { branch: 1 }],
  ["text-[#888]", "text-text-tertiary", { feedbackBtn: 1 }],
  ["text-[#8a8a8a]", "text-text-tertiary", { sessionStats: 1 }],
  // `text-text-muted` is not a generated utility (@theme has no
  // --color-text-muted), so the var is referenced directly.
  ["text-[#555]", "text-[var(--text-muted)]", { appCtx: 1, statusBar: 1, titlebar: 2, accountBtn: 1, browser: 6 }],
  ["text-[#666]", "text-[var(--text-muted)]", { dock: 1 }],
  ["text-[#444]", "text-[var(--text-muted)] opacity-75", { appCtx: 1 }],
  ["text-[#e0af68]", "text-[var(--status-warning)]", { transcript: 1 }],
  ["text-white", "text-text-primary", { titlebar: 1, sessionStats: 1 }, (l) => l.includes("text-[7px]") || l.includes("text-[28px]")],
  // A white check on the accent fill — which is #fff in Atlas Black, so the
  // check was invisible. The foreground-on-accent token is text-inverse.
  ["text-white", "text-text-inverse", { logPanel: 1 }],

  // ── surfaces ──
  ["bg-[#000]", "bg-bg-base", { statusBar: 1, artifactsPanel: 1, calendar: 1, checkpoints: 1, dashHeader: 1, addProject: 1 }],
  ["bg-black", "bg-bg-base", { dock: 1, composer: 1, editorFooter: 1, mention: 1, members: 2, wsSidebar: 2, ctxMenu: 2 }],
  ["bg-[#050505]", "bg-bg-base", { sessionStats: 1, loadingOrg: 1 }],
  ["bg-[#090909]", "bg-bg-sidebar", { spacePages: 1 }],
  ["bg-[#0C0C0C]", "bg-bg-input", { titlebar: 1, capture: 3, createOrg: 6 }],
  ["bg-[#0D0E0D]", "bg-[var(--panel-bg-2)]", { filesTab: 1 }],
  ["bg-[#0f0f0f]", "bg-bg-elevated", { appCtx: 1, browser: 1 }],
  ["bg-[#0F0F0F]", "bg-bg-elevated", { diffView: 1 }],
  // Not bg-bg-raised: @theme registers no --color-bg-raised, so that utility is never generated.
  ["bg-[#121212]", "bg-[var(--bg-raised)]", { dock: 1 }],
  ["bg-[#141414]/95", "bg-[var(--bg-elevated)]/95", { memTimeline: 1 }],
  ["bg-[#1f1f1f]", "bg-bg-active", { capture: 1, createOrg: 2 }],
  ["bg-[#1a1a1a]", "bg-border-default", { appCtx: 2, browser: 2 }],
  ["bg-[#3d3d3d]", "bg-border-strong", { sessionStats: 1, commsAvatar: 1 }],
  ["bg-[#3fb950]", "bg-[var(--stat-added)]", { themesSettings: 1, editorThemesSettings: 1 }],
  ["bg-[#22c55e]", "bg-[var(--stat-added)]", { spaceChrome: 1 }],
  ["bg-white", "bg-text-primary", { titlebar: 1, sessionStats: 1 }],

  // ── borders ──
  ["border-[#1a1a1a]", "border-border-default", { appCtx: 1, browser: 1 }],
  ["border-[#242424]", "border-border-default", { capture: 1, createOrg: 2 }],
  ["border-[#303030]", "border-border-default", { titlebar: 1, capture: 2, createOrg: 5 }],
  ["border-[#4a4a4a]", "border-border-focus", { capture: 1, createOrg: 2 }],
];

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
for (const [cls, to, perFile, pred = () => true] of TABLE) {
  const re = new RegExp(`(?<![\\w:-])${esc(cls)}(?![\\w/\\]-])`, "g");
  for (const [key, expected] of Object.entries(perFile)) {
    let n = 0;
    s.lines([abs(F[key])], (line) => (pred(line) ? line.replace(re, () => (n++, to)) : line));
    s.expect(`${cls} -> ${to} in ${key}`, n, expected);
  }
}

// ── plain CSS and style objects ─────────────────────────────────────────────
const globals = abs("src/styles/globals.css");

const cssLit = [
  ["background-color: #0f0f0f;", "background-color: var(--bg-elevated);", 1],
  ["background: #0f0f0f;", "background: var(--bg-elevated);", 1],
  ["color: #aaa;", "color: var(--text-secondary);", 2],
  ["border: 1px solid #1a1a1a;", "border: 1px solid var(--border-default);", 1],
  ["border-color: #3d3d3d;", "border-color: var(--border-strong);", 1],
  // the workspace rail's opaque base under its sheen
  ["    #0b0b0b;", "    var(--panel-rail-bg);", 1],
];
for (const [from, to, n] of cssLit) s.expect(`globals.css ${from}`, s.literal(globals, from, to, n), n);

s.expect(
  "editor-panel container",
  s.literal(abs("src/features/editor/components/editor-panel.tsx"), `background: "#000000"`, `background: "var(--bg-base)"`, 1),
  1,
);
const eb = abs("src/features/telemetry/error-boundary.tsx");
s.expect("error-boundary background", s.literal(eb, `background: "#000",`, `background: "var(--bg-base, #000)",`, 1), 1);
s.expect("error-boundary text", s.literal(eb, `color: "#fff",`, `color: "var(--text-primary, #fff)",`, 2), 2);

s.commit();
