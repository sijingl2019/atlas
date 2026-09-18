import { describe, expect, it } from "vitest";
import { forceLayout } from "./graph-layout";

const WIDTH = 1600;
const HEIGHT = 700;

function nodes(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `n${i}`, degree: 0 }));
}

describe("forceLayout", () => {
  // The repulsion FR derives from k = sqrt(area / n) has only a weak gravity
  // opposing it, and k grows as n shrinks: a 2-node graph used to settle
  // ~4000px from centre, so the graph view opened blank for any small
  // knowledge base. Every seed must land on the canvas, whatever n is.
  it.each([2, 3, 5, 50])("keeps all %i nodes inside the canvas", (count) => {
    const seeded = forceLayout(nodes(count), [], WIDTH, HEIGHT);
    const points = Object.values(seeded);

    expect(points).toHaveLength(count);
    for (const p of points) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(WIDTH);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(HEIGHT);
    }
  });

  it("still separates the nodes it fits", () => {
    const seeded = forceLayout(nodes(2), [], WIDTH, HEIGHT);
    const [a, b] = Object.values(seeded);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(50);
  });

  it("centres a single node", () => {
    expect(forceLayout(nodes(1), [], WIDTH, HEIGHT)).toEqual({
      n0: { x: WIDTH / 2, y: HEIGHT / 2 },
    });
  });
});
