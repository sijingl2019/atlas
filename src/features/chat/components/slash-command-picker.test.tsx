// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import {
  SlashCommandPicker,
  type SlashCommand,
  type SlashCommandPickerHandle,
} from "./slash-command-picker";

const COMMANDS: SlashCommand[] = Array.from({ length: 24 }, (_, i) => ({
  name: `cmd-${String(i).padStart(2, "0")}`,
  signature: `/cmd-${i}`,
  description: `Command number ${i}`,
  handler: "passthrough",
}));

/** The picker is capped at 360px with 26px rows, so row 15 is the first one
 *  past the fold: marching the arrow keys down that far has to scroll the
 *  list, or the user is pressing Enter on a row they cannot see. */
describe("SlashCommandPicker keyboard scrolling", () => {
  let scrolled: { el: HTMLElement; options: ScrollIntoViewOptions | undefined }[];

  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function (
      this: HTMLElement,
      options?: ScrollIntoViewOptions,
    ) {
      scrolled.push({ el: this, options });
    }) as unknown as Element["scrollIntoView"];
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** The row the picker scrolled to last. */
  const lastScrolled = () => scrolled[scrolled.length - 1];

  function renderPicker() {
    const ref = createRef<SlashCommandPickerHandle>();
    render(
      <SlashCommandPicker
        ref={ref}
        open
        query=""
        anchor={{ x: 40, y: 400 }}
        onSelect={() => {}}
        onClose={() => {}}
        commands={COMMANDS}
      />,
    );
    return ref;
  }

  it("keeps the highlighted row visible as Down walks past the fold", () => {
    const ref = renderPicker();

    act(() => {
      for (let i = 0; i < 15; i++) ref.current?.moveDown();
    });

    expect(ref.current?.activeCommand()?.name).toBe("cmd-15");
    // The row scrolled to is the highlighted one, and it is scrolled the
    // minimum distance (not centred, not jumped to the top).
    expect(lastScrolled()?.el.textContent).toContain("/cmd-15");
    expect(lastScrolled()?.options).toEqual({ block: "nearest" });
  });

  it("scrolls back up when the highlight wraps around to the top", () => {
    const ref = renderPicker();

    act(() => {
      for (let i = 0; i < 15; i++) ref.current?.moveDown();
    });
    expect(lastScrolled()?.el.textContent).toContain("/cmd-15");

    act(() => {
      // Twelve more steps wrap past the last row and land on row 3.
      for (let i = 0; i < 12; i++) ref.current?.moveDown();
    });
    expect(ref.current?.activeCommand()?.name).toBe("cmd-03");
    expect(lastScrolled()?.el.textContent).toContain("/cmd-03");
  });

  it("scrolls the highlight into view on open, not just on a keypress", () => {
    renderPicker();

    expect(lastScrolled()?.el.textContent).toContain("/cmd-00");
  });
});
