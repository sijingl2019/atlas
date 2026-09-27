// A parent chat that has started three subagents — one per agent kind — in
// the three states the Subagents panel exists to show: one finished, one
// still working, one blocked on a permission only the user can answer.

import type { Scenario } from "../types";
import { tool, tools, user, t, text } from "../fixtures/chat";
import { snapshotMessageToWire } from "@/features/chat/lib/snapshot-message";
import {
  inSession,
  latestSessionId,
  openFakeSession,
  playTranscript,
  requestPermission,
  setSeedTranscript,
} from "../fake-agent";
import {
  parentOf,
  setSubagentStatus,
  spawnFakeSubagent,
  subagentSays,
  updateSubagent,
} from "../fixtures/subagents";

const parentTurn = [
  user("Split the release checklist across a few agents and report back.", t(0)),
  text("Starting three subagents: `lister` (codex), `reviewer` (claude) and `toucher` (pi).", t(2)),
];

const children: Record<string, string> = {};
let spawned = 0;

/** A bound chat tab for the parent, opened the way the app would. The stores
 *  are imported lazily: loading them at module scope subscribes to Tauri
 *  events, which the contract tests (no Tauri runtime) can't satisfy. */
async function openParentChat(): Promise<void> {
  const { useChatStore } = await import("@/features/chat/stores/chat-store");
  const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
  const cwd = "/Users/dev/acme-app";
  const key = openFakeSession("codex-acp", cwd);
  const chat = useChatStore.getState().actions;
  chat.createSession(PARENT_TAB, "codex");
  chat.setAcpBinding(PARENT_TAB, key.agent_id, key.session_id, cwd);
  chat.setSessionTitle(PARENT_TAB, "Release checklist");
  chat.replaceMessages(PARENT_TAB, parentTurn.map(snapshotMessageToWire));
  useLayoutStore.getState().actions.addTab({
    id: PARENT_TAB,
    type: "chat",
    title: "Release checklist",
    closable: true,
    dirty: false,
    data: {},
  });
}

const PARENT_TAB = "chat-subagents-parent";

async function start(): Promise<void> {
  const parent = latestSessionId();
  if (!parent) {
    console.warn("[mock-backend] subagents: no parent session bound yet");
    return;
  }
  children.lister = await spawnFakeSubagent({
    parentSessionId: parent,
    name: "lister",
    kind: "codex-acp",
    task: "List the top-level files of this repo and summarize them in 5 bullets.",
  });
  children.reviewer = await spawnFakeSubagent({
    parentSessionId: parent,
    name: "reviewer",
    kind: "claude-acp",
    task: "Review src/lib/api.ts for error handling gaps.",
  });
  children.toucher = await spawnFakeSubagent({
    parentSessionId: parent,
    name: "toucher",
    kind: "pi-acp",
    task: "Clean the build output so the next build starts fresh.",
  });

  await inSession(children.lister, () =>
    playTranscript([
      tools([
        tool.run("ls", { result: "README.md\npackage.json\nsrc\ntests\n" }),
        tool.read("README.md"),
      ]),
    ]),
  );
  await updateSubagent("lister", { tool_count: 2 });
  await subagentSays(
    "lister",
    "- README.md: project overview\n- package.json: scripts and deps\n- src/: the app\n- tests/: contract tests\n- no build output checked in",
    true,
  );

  await inSession(children.reviewer, () =>
    playTranscript([tools([tool.read("src/lib/api.ts"), tool.search("catch")])]),
  );
  await updateSubagent("reviewer", { tool_count: 2 });
  await subagentSays(
    "reviewer",
    "Reading the fetch wrapper; two call sites swallow errors so far…",
  );

  await blockToucher();
}

async function blockToucher(): Promise<void> {
  const session = children.toucher;
  if (!session) return;
  await inSession(session, () => requestPermission());
  await updateSubagent("toucher", {
    status: "blocked",
    tool_count: 1,
    pending_approvals: [{ request_id: "perm", title: "rm -rf .turbo dist" }],
  });
}

export const subagents: Scenario = {
  name: "subagents",
  description:
    "Send the chat anything: it starts three subagents (codex, claude, pi) — done, working, blocked.",
  init: () => setSeedTranscript(parentTurn),
  setup: async () => {
    // The parent is whichever chat binds first. When none does (an agent that
    // needs sign-in, say), the scenario opens a parent chat of its own.
    for (let i = 0; i < 6 && !latestSessionId(); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!latestSessionId()) await openParentChat();
    await new Promise((r) => setTimeout(r, 800));
    await start();
  },
  actions: {
    /** Another child: `__atlasMock.actions.spawnSubagent()`. */
    spawnSubagent: async () => {
      const parent = parentOf(children.lister) ?? latestSessionId();
      if (!parent) return;
      const name = `extra-${++spawned}`;
      children[name] = await spawnFakeSubagent({
        parentSessionId: parent,
        name,
        kind: "codex-acp",
        task: "Count the TypeScript files under src.",
      });
    },
    blockSubagent: () => blockToucher(),
    finishSubagent: () => subagentSays("reviewer", "Found 2 gaps; details above.", true),
    failSubagent: async () => {
      await setSubagentStatus("reviewer", "error");
      await updateSubagent("reviewer", { last_error: "agent process exited: (mock)" });
    },
  },
};
