import { describe, expect, it } from "vitest";
import type { ThreadProject, ThreadRow } from "@/features/chat/lib/history-api";
import { latestWorkspaceSession, workspaceSessions } from "./sidebar-sessions";

const thread = (threadId: string, createdAt: string, updatedAt = createdAt): ThreadRow => ({
  threadId,
  sessionId: `session-${threadId}`,
  agentId: "codex-acp",
  title: threadId,
  updatedAt,
  createdAt,
  archived: false,
  projectName: "atlas",
  folderPaths: ["C:\\repo\\atlas"],
});

const projects: ThreadProject[] = [
  {
    name: "atlas",
    paths: ["\\\\?\\C:\\repo\\atlas"],
    isCurrent: false,
    threads: [thread("newest", "2026-09-18T10:00:00Z"), thread("older", "2026-09-17T10:00:00Z")],
  },
];

describe("workspace sidebar sessions", () => {
  it("puts pinned sessions first inside their project", () => {
    expect(workspaceSessions(projects, "c:/repo/atlas", new Set(["older"]))).toEqual([
      expect.objectContaining({ threadId: "older" }),
      expect.objectContaining({ threadId: "newest" }),
    ]);
  });

  it("keeps conversations in creation order when an older one is touched", () => {
    const touched = [
      {
        ...projects[0],
        threads: [
          thread("newer", "2026-09-18T10:00:00Z", "2026-09-18T10:00:00Z"),
          thread("older", "2026-09-17T10:00:00Z", "2026-09-20T10:00:00Z"),
        ],
      },
    ];

    expect(workspaceSessions(touched, "c:/repo/atlas", new Set())).toEqual([
      expect.objectContaining({ threadId: "newer" }),
      expect.objectContaining({ threadId: "older" }),
    ]);
  });

  it("uses the actually newest session for Chats even when an older one is pinned", () => {
    expect(latestWorkspaceSession(projects, "C:\\repo\\atlas")?.threadId).toBe("newest");
  });

  it("uses recent activity rather than creation time for Chats", () => {
    const touched = [
      {
        ...projects[0],
        threads: [
          thread("newer", "2026-09-18T10:00:00Z", "2026-09-18T10:00:00Z"),
          thread("older", "2026-09-17T10:00:00Z", "2026-09-20T10:00:00Z"),
        ],
      },
    ];

    expect(latestWorkspaceSession(touched, "C:\\repo\\atlas")?.threadId).toBe("older");
  });
});
