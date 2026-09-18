// Deterministic Fruchterman–Reingold force-directed layout. Produces the
// hub-and-spoke / spider arrangement (à la Obsidian's graph view) instead of a
// flat ring. Used to SEED both the KB and memory graphs on first open (before
// the user has a persisted layout); the live Matter sim then takes over.
//
// Deterministic (no Math.random) so the seed is stable across reloads.

export interface LayoutNode {
  id: string;
  degree?: number;
}
export interface LayoutEdge {
  from: string;
  to: string;
}
export interface Pt {
  x: number;
  y: number;
}

export interface ForceLayoutOpts {
  /** Multiplier on the ideal edge length (k). Smaller = tighter clusters. */
  spacing?: number;
  iterations?: number;
}

/**
 * Whether a persisted node position can still be used as-is.
 *
 * Saved positions win over the seed, so a layout written before the
 * fit-to-canvas rescale below — nodes thousands of px out, a blank graph —
 * would survive the fix forever on any machine that had opened the graph once.
 * The Matter walls pen live nodes inside the canvas anyway, so anything beyond
 * it (or non-finite) is damage, not a user's arrangement: drop it and let the
 * caller re-seed that node.
 */
export function usablePosition(p: Pt | undefined, width: number, height: number): boolean {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  const slackX = width * 0.05;
  const slackY = height * 0.05;
  return p.x >= -slackX && p.x <= width + slackX && p.y >= -slackY && p.y <= height + slackY;
}

export function forceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  width: number,
  height: number,
  opts: ForceLayoutOpts = {},
): Record<string, Pt> {
  const out: Record<string, Pt> = {};
  const n = nodes.length;
  if (n === 0) return out;
  const cx = width / 2;
  const cy = height / 2;
  if (n === 1) {
    out[nodes[0].id] = { x: cx, y: cy };
    return out;
  }

  const k = Math.sqrt((width * height) / n) * (opts.spacing ?? 0.85);
  const maxDeg = Math.max(1, ...nodes.map((nd) => nd.degree ?? 0));
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));

  // Seed on a golden-angle spiral, biasing high-degree nodes toward the center
  // so they become hubs — gives FR a head start toward the spider shape.
  const GA = Math.PI * (3 - Math.sqrt(5));
  const R = Math.min(width, height) * 0.46;
  const pos: Pt[] = nodes.map((nd, i) => {
    const degNorm = (nd.degree ?? 0) / maxDeg;
    const rad = R * (1 - 0.6 * degNorm) * Math.sqrt((i + 0.5) / n);
    const ang = i * GA;
    return { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad };
  });

  const E: Array<[number, number]> = [];
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) E.push([a, b]);
  }

  const disp: Pt[] = pos.map(() => ({ x: 0, y: 0 }));
  const iterations = opts.iterations ?? (n > 400 ? 120 : 300);
  let temp = Math.min(width, height) * 0.1;
  const cool = temp / (iterations + 1);

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      disp[i].x = 0;
      disp[i].y = 0;
    }
    // Repulsion (every pair).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // Deterministic nudge so coincident nodes separate.
          dx = ((i % 7) - 3) * 0.1 + 0.05;
          dy = ((j % 7) - 3) * 0.1 + 0.05;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = (k * k) / d;
        const ux = dx / d;
        const uy = dy / d;
        disp[i].x += ux * f;
        disp[i].y += uy * f;
        disp[j].x -= ux * f;
        disp[j].y -= uy * f;
      }
    }
    // Attraction (along edges).
    for (const [a, b] of E) {
      const dx = pos[a].x - pos[b].x;
      const dy = pos[a].y - pos[b].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / k;
      const ux = dx / d;
      const uy = dy / d;
      disp[a].x -= ux * f;
      disp[a].y -= uy * f;
      disp[b].x += ux * f;
      disp[b].y += uy * f;
    }
    // Weak gravity toward center keeps disconnected bits from drifting off.
    for (let i = 0; i < n; i++) {
      disp[i].x -= (pos[i].x - cx) * 0.012;
      disp[i].y -= (pos[i].y - cy) * 0.012;
    }
    // Apply, capped by the cooling temperature.
    for (let i = 0; i < n; i++) {
      const dx = disp[i].x;
      const dy = disp[i].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const m = Math.min(d, temp);
      pos[i].x += (dx / d) * m;
      pos[i].y += (dy / d) * m;
    }
    temp = Math.max(temp - cool, 0);
  }

  // Fit the finished layout into the canvas. FR's ideal edge length k grows as
  // sqrt(area / n), so a SMALL graph repels itself apart until only the weak
  // gravity balances it — at n = 2 that equilibrium sits ~4000px from centre,
  // i.e. every node off a 1600x700 canvas and a blank graph view. Rescaling
  // here fixes it for every n without hand-tuning k, gravity or the cooling
  // schedule against each other. Shrink only: a graph that already fits keeps
  // the spacing FR chose.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pos) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const fit = Math.min(
    spanX > 0 ? (width * 0.8) / spanX : 1,
    spanY > 0 ? (height * 0.8) / spanY : 1,
    1,
  );
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  nodes.forEach((nd, i) => {
    out[nd.id] = {
      x: cx + (pos[i].x - midX) * fit,
      y: cy + (pos[i].y - midY) * fit,
    };
  });
  return out;
}
