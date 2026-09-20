import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "C:\\Users\\dev\\" }));

const { ensureLinkedGlobally, projectMountNames } = await import("./kb-scope-store");

/** The global KB has one linked vault; everything else is uncovered. Paths use
 *  the OS separator on purpose — the comparison must survive `\` vs `/`. */
const globalSources = [{ name: "Vault", path: "E:\\Obsidian\\Vault" }];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) =>
    cmd === "list_knowledge_sources" ? Promise.resolve(globalSources) : Promise.resolve(undefined),
  );
});

describe("ensureLinkedGlobally", () => {
  const linkCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "link_knowledge_folder");

  it("skips a folder already inside one of the global KB's folders", async () => {
    await ensureLinkedGlobally("E:/Obsidian/Vault/sub");
    expect(linkCalls()).toHaveLength(0);
  });

  it("skips the global knowledge dir itself", async () => {
    await ensureLinkedGlobally("C:/Users/dev/.atlas/knowledge");
    expect(linkCalls()).toHaveLength(0);
  });

  it("links a folder the global KB does not cover, under the given name", async () => {
    await ensureLinkedGlobally("E:/Workspace/atlas/.atlas/knowledge", "atlas");
    expect(linkCalls()).toHaveLength(1);
    expect(linkCalls()[0]?.[1]).toMatchObject({
      projectPath: "C:\\Users\\dev",
      path: "E:/Workspace/atlas/.atlas/knowledge",
      name: "atlas",
    });
  });
});

describe("projectMountNames", () => {
  it("claims the project's own KB mount and the mounts of folders it linked", () => {
    const names = projectMountNames(
      [
        // the project's own KB, mounted under the project name
        { name: "atlas", path: "E:/Workspace/atlas/.atlas/knowledge" },
        // a vault this project links, and a subfolder of it
        { name: "Vault", path: "E:/Obsidian/Vault" },
        { name: "Notes", path: "E:/Obsidian/Vault/Notes" },
        // another workspace's knowledge
        { name: "qiko", path: "E:/Workspace/qiko/.atlas/knowledge" },
      ],
      [{ name: "Vault", path: "E:/Obsidian/Vault" }],
      "E:/Workspace/atlas",
    );
    expect([...names].sort()).toEqual(["Notes", "Vault", "atlas"]);
  });

  it("claims nothing when the project has no knowledge in the global KB", () => {
    const names = projectMountNames(
      [{ name: "qiko", path: "E:/Workspace/qiko/.atlas/knowledge" }],
      [],
      "E:/Workspace/atlas",
    );
    expect(names.size).toBe(0);
  });
});
