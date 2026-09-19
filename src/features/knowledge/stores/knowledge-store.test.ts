import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: vi.fn() }));

const { useKnowledgeStore } = await import("./knowledge-store");

beforeEach(() => {
  useKnowledgeStore.setState({
    entries: [
      {
        id: "Qiko/常见问题与排查指南",
        title: "常见问题与排查指南",
        content: "old",
        source: "note",
        file_path: "E:/Obsidian/Qiko/常见问题与排查指南.md",
        updated_at: "2026-09-17T00:00:00Z",
      },
    ],
  });
});

describe("saveEntry", () => {
  it("does not clear the current note when a graph target does not exist", () => {
    const id = useKnowledgeStore.getState().entries[0].id;
    useKnowledgeStore.getState().actions.selectEntry(id);
    useKnowledgeStore.getState().actions.selectEntry("Missing");
    expect(useKnowledgeStore.getState().activeEntryId).toBe(id);
    expect(useKnowledgeStore.getState().editContent).toBe("old");
  });
  it("keeps the filename title when markdown starts with frontmatter", async () => {
    await useKnowledgeStore
      .getState()
      .actions.saveEntry("E:/project", "Qiko/常见问题与排查指南", "---\ntitle: Qiko FAQ\n---\n");

    expect(useKnowledgeStore.getState().entries[0]?.title).toBe("常见问题与排查指南");
  });
});
