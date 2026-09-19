// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "tiptap-markdown";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("missing")),
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));
vi.mock("@/features/project/stores/project-store", () => ({
  useProjectStore: { getState: () => ({ currentProject: { path: "/project" } }) },
}));
const { addTab } = vi.hoisted(() => ({ addTab: vi.fn() }));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: { getState: () => ({ actions: { addTab } }) },
}));
vi.mock("@/features/log/lib/log", () => ({ logEvent: vi.fn() }));
import { WikiLink } from "./wiki-link";

it("renders an image at the requested dimensions and navigates a resolved note", async () => {
  useKnowledgeStore.setState({ activeEntryId: "Vault/Hello/Advance", pendingOpenId: null });
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const target = (args as { target: string }).target;
    return (
      target === "Base"
        ? { entryId: "Vault/Hello/Base", filePath: "/vault/Hello/Base.md" }
        : { entryId: null, filePath: "/vault/Attachments/Engelbart.jpg" }
    ) as never;
  });
  const editor = new Editor({
    extensions: [StarterKit, WikiLink, Markdown],
    content: "[[Base|Basics]] ![[Engelbart.jpg|100x145]]",
  });
  await vi.waitFor(() =>
    expect(editor.view.dom.querySelector("img")?.getAttribute("width")).toBe("100"),
  );
  const img = editor.view.dom.querySelector("img")!;
  expect(img.getAttribute("height")).toBe("145");
  expect(img.getAttribute("src")).toBe("asset://localhost/vault/Attachments/Engelbart.jpg");
  (editor.view.dom.querySelector(".atlas-wiki-link") as HTMLElement).click();
  expect(useKnowledgeStore.getState().pendingOpenId).toBe("Vault/Hello/Base");
  editor.destroy();
  useKnowledgeStore.setState({ activeEntryId: null, pendingOpenId: null });
});

it("parses Obsidian links and sized embeds inside tables and preserves their syntax", () => {
  const editor = new Editor({
    extensions: [StarterKit, Table, TableRow, TableCell, TableHeader, WikiLink, Markdown],
    content:
      "| Note | Image |\n| --- | --- |\n| [[Base\\|Basics]] | ![[Engelbart.jpg\\|100x145]] |",
  });
  const links: Record<string, unknown>[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "wikiLink") links.push(node.attrs);
  });
  expect(links.map((n) => n.raw)).toEqual(["Base|Basics", "Engelbart.jpg|100x145"]);
  expect(links[1].embed).toBe(true);
  expect(editor.getText()).not.toContain("[[Base");
  const md = (
    editor.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown();
  expect(md).toContain("[[Base\\|Basics]]");
  expect(md).toContain("![[Engelbart.jpg\\|100x145]]");
  editor.destroy();
});

it("leaves inline and fenced code containing wikilinks untouched", () => {
  const editor = new Editor({
    extensions: [StarterKit, WikiLink, Markdown],
    content: "`[[Base]]`\n\n```md\n![[image.png]]\n```",
  });
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "wikiLink") count++;
  });
  expect(count).toBe(0);
  editor.destroy();
});

it("opens image attachment links in the media viewer", async () => {
  useKnowledgeStore.setState({ activeEntryId: "Vault/Advance" });
  vi.mocked(invoke).mockResolvedValue({ entryId: null, filePath: "/vault/Engelbart.jpg" });
  addTab.mockClear();
  const editor = new Editor({
    extensions: [StarterKit, WikiLink, Markdown],
    content: "[[Engelbart.jpg]]",
  });
  await vi.waitFor(() =>
    expect(editor.view.dom.querySelector(".atlas-wiki-link")?.getAttribute("title")).toBeTruthy(),
  );
  await vi.waitFor(() =>
    expect((editor.view.dom.querySelector(".atlas-wiki-link") as HTMLElement).onclick).toBeTypeOf(
      "function",
    ),
  );
  (editor.view.dom.querySelector(".atlas-wiki-link") as HTMLElement).click();
  await vi.waitFor(() =>
    expect(addTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media",
        data: { filePath: "/vault/Engelbart.jpg", fileKind: "image" },
      }),
    ),
  );
  editor.destroy();
});
