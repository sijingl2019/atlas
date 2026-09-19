import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/features/chat/lib/mentions", () => ({ publishKnowledgeToMentionCache: vi.fn() }));

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

it("does not save attachment metadata as a markdown note", async () => {
  const entry = {
    id: "photo.jpg",
    title: "photo.jpg",
    source: "file",
    content: "",
    file_path: "/vault/photo.jpg",
    updated_at: "",
  };
  useKnowledgeStore.setState({ entries: [entry] });
  vi.mocked(invoke).mockClear();
  await useKnowledgeStore.getState().actions.saveEntry("/project", entry.id, "accidental edit");
  expect(invoke).not.toHaveBeenCalledWith("save_knowledge_note", expect.anything());
  expect(useKnowledgeStore.getState().entries[0].content).toBe("");
});

it("lists attachments while selecting a markdown note for editing", async () => {
  const note = useKnowledgeStore.getState().entries[0];
  const attachment = {
    ...note,
    id: "photo.jpg",
    title: "photo.jpg",
    content: "",
    source: "file",
    file_path: "/vault/photo.jpg",
  };
  useKnowledgeStore.setState({ activeEntryId: null });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_knowledge" ? [attachment, note] : [],
  );
  await useKnowledgeStore.getState().actions.loadEntries("/project");
  expect(useKnowledgeStore.getState().entries).toEqual([attachment, note]);
  expect(useKnowledgeStore.getState().activeEntryId).toBe(note.id);
  useKnowledgeStore.getState().actions.selectEntry(attachment.id);
  expect(useKnowledgeStore.getState().activeEntryId).toBe(note.id);
  expect(useKnowledgeStore.getState().editContent).toBe("old");
});
