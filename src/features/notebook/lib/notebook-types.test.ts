import { describe, expect, it } from "vitest";
import {
  codeFence,
  imageOutputSrc,
  joinSource,
  notebookLanguage,
  parseNotebook,
  pickOutputMime,
  stripAnsi,
} from "./notebook-types";

describe("parseNotebook", () => {
  it("accepts an nbformat v4 document", () => {
    const nb = parseNotebook('{"cells": [], "nbformat": 4}');
    expect(nb.cells).toEqual([]);
  });

  it("rejects a v3 notebook, whose cells live under worksheets", () => {
    expect(() => parseNotebook('{"worksheets": [{"cells": []}], "nbformat": 3}')).toThrow(
      /nbformat v4/,
    );
  });

  it("rejects JSON that is not an object", () => {
    expect(() => parseNotebook("null")).toThrow(/cells/);
  });
});

describe("joinSource", () => {
  it("joins the line-array form without adding separators", () => {
    expect(joinSource(["a = 1\n", "b = 2"])).toBe("a = 1\nb = 2");
  });

  it("passes a plain string through and treats undefined as empty", () => {
    expect(joinSource("x")).toBe("x");
    expect(joinSource(undefined)).toBe("");
  });
});

describe("notebookLanguage", () => {
  it("prefers language_info, collapsing python versions", () => {
    expect(
      notebookLanguage({
        cells: [],
        metadata: { language_info: { name: "Python3" }, kernelspec: { language: "r" } },
      }),
    ).toBe("python");
  });

  it("falls back to the kernelspec, then to python", () => {
    expect(notebookLanguage({ cells: [], metadata: { kernelspec: { language: "Julia" } } })).toBe(
      "julia",
    );
    expect(notebookLanguage({ cells: [] })).toBe("python");
  });
});

describe("codeFence", () => {
  it("uses a three-backtick fence for ordinary source", () => {
    expect(codeFence("print(1)", "python")).toBe("```python\nprint(1)\n```");
  });

  it("outgrows any backtick run inside the source so it cannot close early", () => {
    const src = 'md = """\n```js\nx\n```\n"""';
    const fenced = codeFence(src, "python");
    expect(fenced.startsWith("````python\n")).toBe(true);
    expect(fenced.endsWith("\n````")).toBe(true);
  });
});

describe("pickOutputMime", () => {
  it("prefers an image over text", () => {
    expect(pickOutputMime({ "text/plain": "<Figure>", "image/png": "iVBOR" })).toBe("image/png");
  });

  it("never picks html or javascript, falling back to text/plain", () => {
    expect(
      pickOutputMime({
        "text/html": "<script>alert(1)</script>",
        "application/javascript": "alert(1)",
        "text/plain": "<IPython.core.display.HTML object>",
      }),
    ).toBe("text/plain");
  });

  it("returns undefined when nothing is renderable", () => {
    expect(pickOutputMime({ "text/html": "<b>hi</b>" })).toBeUndefined();
  });
});

describe("imageOutputSrc", () => {
  it("strips the line wrapping some writers put in base64", () => {
    expect(imageOutputSrc("image/png", ["iVBO\n", "Rw0K\n"])).toBe(
      "data:image/png;base64,iVBORw0K",
    );
  });

  it("URL-encodes SVG, which nbformat stores as markup rather than base64", () => {
    expect(imageOutputSrc("image/svg+xml", "<svg/>")).toBe("data:image/svg+xml,%3Csvg%2F%3E");
  });
});

describe("stripAnsi", () => {
  it("removes colour codes from a traceback line", () => {
    expect(stripAnsi("\u001b[0;31mZeroDivisionError\u001b[0m: division by zero")).toBe(
      "ZeroDivisionError: division by zero",
    );
  });

  it("removes cursor-control sequences too", () => {
    expect(stripAnsi("50%\u001b[K\u001b[1A100%")).toBe("50%100%");
  });
});
