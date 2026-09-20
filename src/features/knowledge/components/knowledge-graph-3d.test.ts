import { describe, expect, it } from "vitest";
import { buildSystem, type SolarSystem } from "./knowledge-graph-3d";
import type { GraphNode, ProjectGraph } from "../stores/knowledge-graph-store";

const node = (id: string, inDegree: number, outDegree: number): GraphNode => ({
  id,
  title: id,
  inDegree,
  outDegree,
});

/** `hub` is linked by every `leafN`; `lonelyN` links to nothing. */
function graph(leafCount: number, lonely = 0): ProjectGraph {
  return {
    nodes: [
      node("hub", leafCount, 0),
      ...Array.from({ length: leafCount }, (_, i) => node(`leaf${i}`, 0, 1)),
      ...Array.from({ length: lonely }, (_, i) => node(`lonely${i}`, 0, 0)),
    ],
    edges: Array.from({ length: leafCount }, (_, i) => ({ from: `leaf${i}`, to: "hub" })),
  };
}

/** Distance of a body from the origin at rest — its own orbit plus its parent's. */
function orbitOf(sys: SolarSystem, id: string): number {
  const b = sys.bodies.find((x) => x.id === id)!;
  const own = b.ring < 0 ? 0 : sys.rings[b.ring]!.r;
  return b.parent < 0 ? own : own + orbitOf(sys, sys.bodies[b.parent]!.id);
}

describe("buildSystem", () => {
  it("places every node exactly once", () => {
    const { bodies } = buildSystem(graph(12, 3));
    expect(bodies).toHaveLength(16);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(16);
  });

  it("makes the most-linked node the central star and rings its links around it", () => {
    const sys = buildSystem(graph(6));
    // Highest degree wins the centre. A single-link leaf is never promoted
    // alongside it, however few nodes the graph has.
    expect(sys.bodies.filter((b) => b.isStar).map((b) => b.id)).toEqual(["hub"]);
    const star = sys.bodies[0]!;
    expect(star.ring).toBe(-1); // at the origin

    for (const leaf of sys.bodies.filter((b) => !b.isStar)) {
      expect(leaf.parent).toBe(0);
      // Outside the star's disc, or the moon draws inside it.
      expect(sys.rings[leaf.ring]!.r).toBeGreaterThan(star.radius);
    }
  });

  it("fills a ring before opening the next one out", () => {
    const sys = buildSystem(graph(40));
    const used = new Map<number, number>();
    for (const b of sys.bodies) {
      if (b.isStar) continue;
      used.set(b.ring, (used.get(b.ring) ?? 0) + 1);
    }
    const counts = [...used.entries()].sort((a, b) => sys.rings[a[0]]!.r - sys.rings[b[0]]!.r);
    expect(counts.length).toBeGreaterThan(1);
    for (let i = 1; i < counts.length; i += 1) {
      // Each ring out is wider than the one inside it …
      expect(sys.rings[counts[i]![0]]!.r).toBeGreaterThan(sys.rings[counts[i - 1]![0]]!.r);
      // … and holds more, except the outermost, which takes the remainder.
      if (i < counts.length - 1) {
        expect(counts[i]![1]).toBeGreaterThan(counts[i - 1]![1]);
      }
    }
  });

  it("keeps two hub systems from overlapping", () => {
    // Two hubs, five leaves each, plus a link between the hubs.
    const nodes = [node("a", 6, 1), node("b", 6, 1)];
    const edges = [{ from: "a", to: "b" }];
    for (const hub of ["a", "b"]) {
      for (let i = 0; i < 5; i += 1) {
        nodes.push(node(`${hub}-leaf${i}`, 0, 1));
        edges.push({ from: `${hub}-leaf${i}`, to: hub });
      }
    }
    const sys = buildSystem({ nodes, edges });
    const stars = sys.bodies.filter((b) => b.isStar);
    expect(stars).toHaveLength(2);

    const outerStar = stars[1]!;
    const starOrbit = sys.rings[outerStar.ring]!.r;
    const innerReach = Math.max(
      ...sys.bodies.filter((b) => b.parent === 0 && !b.isStar).map((b) => sys.rings[b.ring]!.r),
    );
    const outerReach = Math.max(
      ...sys.bodies.filter((b) => b.parent === 1).map((b) => sys.rings[b.ring]!.r),
    );
    // The second system's nearest edge still clears the first system's rings.
    expect(starOrbit - outerReach).toBeGreaterThan(innerReach);
  });

  it("belts unlinked nodes outside every system instead of dropping them", () => {
    const sys = buildSystem(graph(8, 3));
    const linkedReach = Math.max(
      ...sys.bodies.filter((b) => !b.id.startsWith("lonely")).map((b) => orbitOf(sys, b.id)),
    );
    for (const lone of sys.bodies.filter((b) => b.id.startsWith("lonely"))) {
      expect(lone.parent).toBe(-1);
      expect(lone.isStar).toBe(false);
      expect(orbitOf(sys, lone.id)).toBeGreaterThan(linkedReach);
    }
  });

  it("survives a graph with no edges at all", () => {
    const sys = buildSystem({ nodes: [node("a", 0, 0)], edges: [] });
    expect(sys.bodies).toHaveLength(1);
    // Degree 0 → nothing qualifies as a star, so it belts rather than crashing.
    expect(sys.bodies[0]!.isStar).toBe(false);
    expect(sys.bodies[0]!.parent).toBe(-1);
  });

  it("reports a finite extent that covers every body", () => {
    for (const g of [graph(1), graph(30, 5), graph(0, 9)]) {
      const sys = buildSystem(g);
      expect(Number.isFinite(sys.extent)).toBe(true);
      expect(sys.extent).toBeGreaterThan(0);
      for (const b of sys.bodies) expect(orbitOf(sys, b.id)).toBeLessThanOrEqual(sys.extent);
      for (const r of sys.rings) expect(Number.isFinite(r.speed)).toBe(true);
    }
  });
});
