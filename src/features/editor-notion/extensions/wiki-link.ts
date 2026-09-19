import { Node } from "@tiptap/core";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";

// Small structural type: markdown-it is supplied by tiptap-markdown.
interface InlineState {
  src: string;
  pos: number;
  push(type: string, tag: string, nesting: number): { content: string };
}
interface MarkdownParser {
  inline: {
    ruler: {
      before(
        name: string,
        rule: string,
        fn: (state: InlineState, silent: boolean) => boolean,
      ): void;
    };
  };
  utils: { escapeHtml(text: string): string };
}

export const WikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  content: "text*",
  renderText({ node }) {
    return String(node.attrs.raw).split("|")[1] || String(node.attrs.raw);
  },
  addAttributes() {
    return {
      raw: { default: "", parseHTML: (el) => el.getAttribute("data-wiki-link") },
      embed: { default: false, parseHTML: (el) => el.getAttribute("data-embed") === "true" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-wiki-link]" }];
  },
  renderHTML({ node }) {
    const raw = String(node.attrs.raw);
    return [
      "span",
      { "data-wiki-link": raw, "data-embed": String(node.attrs.embed), class: "atlas-wiki-link" },
      0,
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(text: string): void; inTable?: boolean },
          node: { attrs: { raw: string; embed: boolean } },
        ) {
          const raw = state.inTable ? node.attrs.raw.replace(/\|/g, "\\|") : node.attrs.raw;
          state.write(`${node.attrs.embed ? "!" : ""}[[${raw}]]`);
        },
        parse: {
          setup(md: MarkdownParser) {
            md.inline.ruler.before("link", "atlas_wikilink", (state, silent) => {
              const match = /^(!?)\[\[([^\]\n]+)\]\]/.exec(state.src.slice(state.pos));
              if (!match) return false;
              if (!silent) {
                const raw = match[2].replace(/\\\|/g, "|");
                const token = state.push("html_inline", "", 0);
                token.content = `<span data-wiki-link="${md.utils.escapeHtml(raw)}" data-embed="${match[1] === "!"}">${md.utils.escapeHtml(raw)}</span>`;
              }
              state.pos += match[0].length;
              return true;
            });
          },
        },
      },
    };
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "atlas-wiki-link";
      const raw = String(node.attrs.raw);
      const [destination, alias] = raw.split("|");
      dom.textContent = alias || destination;
      dom.title = destination;
      dom.contentEditable = "false";
      const projectPath = useProjectStore.getState().currentProject?.path;
      const fromId = useKnowledgeStore.getState().activeEntryId;
      let disposed = false;
      if (projectPath && fromId) {
        void invoke<{ entryId: string | null; filePath: string }>("knowledge_resolve_link", {
          projectPath,
          fromId,
          target: destination,
        })
          .then((target) => {
            if (disposed) return;
            dom.onclick = (event) => {
              event.preventDefault();
              if (target.entryId) useKnowledgeStore.getState().actions.requestOpen(target.entryId);
              else
                useLayoutStore.getState().actions.addTab({
                  id: `editor-${target.filePath}`,
                  type: "editor",
                  title: destination,
                  closable: true,
                  dirty: false,
                  data: { filePath: target.filePath },
                });
            };
            if (node.attrs.embed && /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(target.filePath)) {
              const img = document.createElement("img");
              img.src = convertFileSrc(target.filePath);
              img.alt = destination;
              const size = /^(\d+)(?:x(\d+))?$/.exec(alias || "");
              if (size) {
                img.width = Number(size[1]);
                if (size[2]) img.height = Number(size[2]);
              }
              img.style.maxWidth = "100%";
              dom.replaceChildren(img);
            }
          })
          .catch(() => {
            if (!disposed) {
              dom.classList.add("is-unresolved");
              dom.title = `Link target missing or ambiguous: ${destination}`;
            }
          });
      }
      return {
        dom,
        destroy() {
          disposed = true;
        },
      };
    };
  },
});
