// @vitest-environment happy-dom
//
// Comments as composer references: every visible comment on the chat's own
// recorded session, newest first, searchable by `@`, and linkable from the
// popover into the composer of the tab that owns it.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import type { Comment } from "@/features/artifacts/lib/comments-api";
import type { OrgMember } from "@/features/auth/lib/auth-api";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

import { EMPTY_ANCHOR_MAP } from "./comment-anchors";
import {
  COMMENT_LINK_EVENT,
  commentExcerpt,
  commentToMention,
  linkCommentToComposer,
  listCommentMentions,
  searchCommentMentions,
  type CommentLinkDetail,
} from "./comment-mentions";
import { categoryForKind, toShortForm } from "./mentions";
import { useChatCommentsStore, type TabComments } from "../stores/chat-comments-store";

function comment(over: Partial<Comment> & { id: string }): Comment {
  return {
    sessionId: "rs-1",
    anchorKind: "message",
    anchorId: "am-p",
    parentId: null,
    authorId: "u-grace",
    guestName: null,
    body: "hi",
    mentions: [],
    createdAt: "2026-09-26T10:00:00Z",
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...over,
  };
}

const directory: OrgDirectory = {
  byId: new Map([
    ["u-grace", { userId: "u-grace", name: "Grace Hopper" } as OrgMember],
    ["u-ada", { userId: "u-ada", name: "Ada Lovelace" } as OrgMember],
  ]),
  currentUserId: "u-ada",
};

const actions = { post: async () => {}, resolve: async () => {}, remove: async () => {} };

function tab(over: Partial<TabComments> = {}): TabComments {
  return {
    target: { remoteProjectId: "ws-atlas", sessionId: "rs-1" },
    entries: [
      { rowId: "am-p", kind: "prompt", turnSeq: 1, nativeId: null, toolName: null },
      { rowId: "tc-1", kind: "tool_call", turnSeq: 1, nativeId: "call-1", toolName: "Bash" },
    ],
    anchors: EMPTY_ANCHOR_MAP,
    byAnchor: {
      "am-p": [
        comment({ id: "c-old", body: "first thought", createdAt: "2026-09-26T09:00:00Z" }),
        comment({
          id: "c-reply",
          parentId: "c-old",
          authorId: "u-ada",
          body: "agreed <@u-grace>",
          createdAt: "2026-09-26T11:00:00Z",
        }),
      ],
      "tc-1": [
        comment({
          id: "c-tool",
          anchorKind: "tool_call",
          anchorId: "tc-1",
          body: "this retry loop never backs off",
          createdAt: "2026-09-26T12:00:00Z",
          resolvedAt: "2026-09-26T12:30:00Z",
        }),
        comment({ id: "c-gone", body: null, deletedAt: "2026-09-26T13:00:00Z" }),
      ],
    },
    byChatKey: {},
    session: [
      comment({
        id: "c-session",
        anchorKind: "session",
        anchorId: "rs-1",
        guestName: "Visitor",
        authorId: "g-1",
        body: "overall looks good",
        createdAt: "2026-09-26T10:00:00Z",
      }),
    ],
    commentCount: 4,
    actions,
    directory,
    ...over,
  };
}

describe("listing comments to reference", () => {
  it("lists every visible comment, newest first, replies and resolved included", () => {
    expect(listCommentMentions(tab()).map((m) => m.id)).toEqual([
      "c-tool",
      "c-reply",
      "c-session",
      "c-old",
    ]);
  });

  it("describes each one: author, what it hangs off, reply, resolved", () => {
    const byId = new Map(listCommentMentions(tab()).map((m) => [m.id, m]));
    expect(byId.get("c-tool")).toMatchObject({
      authorName: "Grace Hopper",
      anchorLabel: "a Bash call",
      resolved: true,
      parentId: null,
      workspaceId: "ws-atlas",
      sessionId: "rs-1",
    });
    expect(byId.get("c-reply")).toMatchObject({
      authorName: "Ada Lovelace",
      anchorLabel: "a prompt",
      parentId: "c-old",
      displayName: "Ada Lovelace: agreed @Grace Hopper",
    });
    expect(byId.get("c-session")).toMatchObject({
      authorName: "Visitor",
      anchorLabel: "the session",
    });
  });

  it("offers nothing for a tab whose session is not in the cloud", () => {
    expect(listCommentMentions(tab({ target: null }))).toEqual([]);
    expect(commentToMention(comment({ id: "x" }), tab({ target: null }))).toBeNull();
  });
});

describe("searching comments with @", () => {
  beforeEach(() => useChatCommentsStore.setState({ byTab: {} }));

  it("reads the tab's own comments and filters by author, body or anchor", () => {
    useChatCommentsStore.setState({ byTab: { "tab-1": tab() } });
    expect(searchCommentMentions("", "tab-1", 30).map((m) => m.id)).toEqual([
      "c-tool",
      "c-reply",
      "c-session",
      "c-old",
    ]);
    expect(searchCommentMentions("ada", "tab-1", 30).map((m) => m.id)).toEqual(["c-reply"]);
    expect(searchCommentMentions("RETRY", "tab-1", 30).map((m) => m.id)).toEqual(["c-tool"]);
    expect(searchCommentMentions("bash", "tab-1", 30).map((m) => m.id)).toEqual(["c-tool"]);
    expect(searchCommentMentions("", "tab-1", 2).map((m) => m.id)).toEqual(["c-tool", "c-reply"]);
  });

  it("offers nothing without a tab, or for another tab", () => {
    useChatCommentsStore.setState({ byTab: { "tab-1": tab() } });
    expect(searchCommentMentions("", undefined, 30)).toEqual([]);
    expect(searchCommentMentions("", "tab-2", 30)).toEqual([]);
  });
});

describe("a comment mention", () => {
  it("has its own category and a quoted short form the renderer reads whole", () => {
    expect(categoryForKind("comment").label).toBe("Comments");
    const mention = commentToMention(comment({ id: "c-1", body: 'says "stop"\n  here' }), tab())!;
    expect(mention.displayName).toBe("Grace Hopper: says 'stop' here");
    expect(toShortForm(mention)).toBe(`@comment:"Grace Hopper: says 'stop' here"`);
  });

  it("clips a long body to an excerpt", () => {
    const excerpt = commentExcerpt("word ".repeat(40), null);
    expect(excerpt.length).toBeLessThanOrEqual(48);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("is linked into the composer of the tab that owns it", () => {
    const seen: CommentLinkDetail[] = [];
    const onLink = (e: Event) => seen.push((e as CustomEvent<CommentLinkDetail>).detail);
    window.addEventListener(COMMENT_LINK_EVENT, onLink);
    const mention = commentToMention(comment({ id: "c-1" }), tab())!;
    linkCommentToComposer("tab-1", mention);
    window.removeEventListener(COMMENT_LINK_EVENT, onLink);
    expect(seen).toEqual([{ tabId: "tab-1", mention }]);
  });
});
