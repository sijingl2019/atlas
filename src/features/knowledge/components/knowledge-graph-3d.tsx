import { useEffect, useRef } from "react";
import { Application, Container, Graphics, Text, TextStyle, type Ticker } from "pixi.js";
import { isMac } from "@/lib/platform";
import { useThemeVersion } from "@/features/theme/theme-values";
import { graphPalette } from "@/components/graph-palette";
import type { ProjectGraph } from "../stores/knowledge-graph-store";

/**
 * Solar-system view of the knowledge graph.
 *
 * The heavily-linked nodes become stars; everything that links to one fills
 * concentric rings around it, and the stars themselves orbit the biggest hub —
 * so the whole graph turns as one system. Positions are pure functions of
 * time (no physics, no persistence), which is why this is a separate canvas
 * from the 2D Matter-driven one rather than a mode inside it.
 *
 * Rendered with Pixi + a hand-rolled perspective projection: everything is
 * circles and lines, so a 3D engine would be all weight and no gain.
 */

const RESOLUTION = 2;
/** Fixed downward tilt, so orbits read as ellipses rather than lines. */
const BASE_PITCH = 0.42;
/** Whole-system spin, rad/s. */
const GLOBAL_SPIN = 0.06;
/** Orbital rate: ω = ORBIT_K / r^ORBIT_FALLOFF. Shallower than Kepler's 1.5 so
 *  the outer systems still visibly turn instead of looking frozen. */
const ORBIT_K = 60;
const ORBIT_FALLOFF = 1.1;
const DOUBLE_CLICK_MS = 280;
/** Max labels alive — one Text each, so this is the real per-frame cost. */
const MAX_LABELS = 48;
const STARFIELD_COUNT = 220;

// ── Layout constants, world units ───────────────────────────────
/** Gap from a star's disc to its innermost ring of moons. */
const RING_INSET = 44;
/** Radial distance between successive rings. */
const RING_GAP = 34;
/** Moons in the innermost ring; each ring out holds 3 more. */
const RING_BASE_CAPACITY = 5;
/** Clearance between one star system's outer edge and the next. Not stretched
 *  by `spread` — systems already carry their own size. */
const SYSTEM_GAP = 110;
/** The belt sits this much further out than everything else, proportionally —
 *  a fixed gap let two stray notes quadruple the extent and shrink the real
 *  graph to a speck. */
const BELT_GAP_FACTOR = 1.15;
const BELT_RINGS = 4;
/** Notes per belt ring — a two-note belt gets one ring, not four. */
const BELT_RING_LOAD = 10;
/** Fraction of the viewport's short side the system spans when it opens. */
const FIT_FRACTION = 0.82;
/** Fit cap — past this the discs read as blobs, so a tiny graph stops growing
 *  and simply sits in the middle of the canvas. */
const MAX_FIT_ZOOM = 2.4;

/** Per-system tint, so neighbouring systems read apart at a glance. */
const SYSTEM_HUES = [0xffa53d, 0x4f9dff, 0x5fc96a, 0xb072ff, 0xff6f85, 0x2fc9b8];
const BELT_HUE_DARK = 0x8a8a8a;
const BELT_HUE_LIGHT = 0x9a9a9a;

function nodeRadiusForDegree(degree: number): number {
  return Math.min(3 + Math.sqrt(Math.max(0, degree)) * 1.6, 14);
}

/** Deterministic 0..1 from an id, so a re-render never re-rolls an orbit. */
function hash01(s: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** A shared orbital plane. Every body on one moves as a ring, and the ring is
 *  drawn once rather than per body. */
export interface Ring {
  /** Index into `bodies` of the body this ring circles; -1 = the origin. */
  parent: number;
  r: number;
  /** Inclination + ascending node of the plane. */
  tilt: number;
  node: number;
  speed: number;
  color: number;
  /** Star orbits are drawn brighter and sampled finer than moon rings. */
  major: boolean;
}

export interface Orbiter {
  id: string;
  title: string;
  /** Index into `rings`. */
  ring: number;
  /** Index into `bodies` of the body this one circles; -1 = the origin. */
  parent: number;
  phase: number;
  radius: number;
  isStar: boolean;
  color: number;
  /** Live position, refreshed once per frame. */
  x: number;
  y: number;
  z: number;
  /** Live projection, for hit-testing and drawing. */
  sx: number;
  sy: number;
  sr: number;
  depth: number;
}

export interface SolarSystem {
  bodies: Orbiter[];
  rings: Ring[];
  /** Farthest any body gets from the origin, discs included. Drives the fit. */
  extent: number;
}

/**
 * Lay the graph out as nested orbits: the biggest hub is the central star,
 * the next hubs orbit it far enough out that their systems never overlap,
 * every other node fills a ring around the hub it links to most strongly, and
 * anything unattached drifts in an outer belt.
 */
export function buildSystem(graph: ProjectGraph, beltColor = BELT_HUE_DARK): SolarSystem {
  const degree = new Map<string, number>();
  for (const n of graph.nodes) degree.set(n.id, n.inDegree + n.outDegree);

  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of graph.edges) {
    if (!degree.has(e.from) || !degree.has(e.to)) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }

  const byDegree = [...graph.nodes].sort(
    (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0),
  );
  const starCount = Math.max(1, Math.min(8, Math.round(Math.sqrt(byDegree.length) / 1.6)));
  // A node with a single link is a leaf, not a hub — it would get a whole
  // system of its own and the view would read as noise. With no hub at all
  // (every node isolated) nothing qualifies and the belt takes everything.
  const stars = byDegree.slice(0, starCount).filter((n) => (degree.get(n.id) ?? 0) >= 2);
  const starIndex = new Map<string, number>();
  stars.forEach((n, i) => starIndex.set(n.id, i));

  const bodies: Orbiter[] = [];
  const rings: Ring[] = [];

  const speedFor = (r: number) => (r <= 0 ? 0 : ORBIT_K / Math.pow(r, ORBIT_FALLOFF));
  // A handful of notes in a full-window canvas looked like a speck, so small
  // graphs get their orbits stretched. Big ones stay tight — they have no
  // room to spare once every hub has a system.
  const spread = Math.max(1, Math.min(3, 3 - graph.nodes.length / 25));
  const ringInset = RING_INSET * spread;
  const ringGap = RING_GAP * spread;

  // ── Stars, at the origin for now; their own orbits come after we know how
  //    wide each system grows. ──
  stars.forEach((n, i) => {
    bodies.push({
      id: n.id,
      title: n.title,
      ring: -1,
      parent: -1,
      phase: hash01(n.id, 1) * Math.PI * 2,
      radius: nodeRadiusForDegree(degree.get(n.id) ?? 0) * 1.8,
      isStar: true,
      color: SYSTEM_HUES[i % SYSTEM_HUES.length]!,
      x: 0,
      y: 0,
      z: 0,
      sx: 0,
      sy: 0,
      sr: 0,
      depth: 0,
    });
  });

  // ── Assign every remaining node to the strongest star it links to ──
  const moonsOf: (typeof byDegree)[] = stars.map(() => []);
  const belt: typeof byDegree = [];
  for (const n of byDegree) {
    if (starIndex.has(n.id)) continue;
    let best = -1;
    let bestDeg = -1;
    for (const other of adj.get(n.id) ?? []) {
      const si = starIndex.get(other);
      if (si === undefined) continue;
      const d = degree.get(other) ?? 0;
      if (d > bestDeg) {
        bestDeg = d;
        best = si;
      }
    }
    if (best >= 0) moonsOf[best]!.push(n);
    else belt.push(n);
  }

  /** Fill concentric rings around `parent`, returning the system's outer edge. */
  const fillRings = (
    parent: number,
    members: typeof byDegree,
    inset: number,
    seed: string,
    color: number,
    tiltSpread: number,
  ): number => {
    let edge = inset;
    let placed = 0;
    let ringIdx = 0;
    while (placed < members.length) {
      const capacity = RING_BASE_CAPACITY + ringIdx * 3;
      const take = Math.min(capacity, members.length - placed);
      const r = inset + ringIdx * ringGap;
      const key = `${seed}#${ringIdx}`;
      rings.push({
        parent,
        r,
        // Each ring gets its own plane — that tilt is what makes the system
        // read as a volume rather than a flat disc.
        tilt: (hash01(key, 21) - 0.5) * tiltSpread,
        node: hash01(key, 22) * Math.PI * 2,
        speed: speedFor(r),
        color,
        major: false,
      });
      const ringId = rings.length - 1;
      for (let k = 0; k < take; k += 1) {
        const n = members[placed + k]!;
        const radius = nodeRadiusForDegree(degree.get(n.id) ?? 0);
        bodies.push({
          id: n.id,
          title: n.title,
          ring: ringId,
          parent,
          // Spread evenly around the ring, nudged so rings don't line up.
          phase: ((k + hash01(n.id, 23) * 0.55) / capacity) * Math.PI * 2,
          radius,
          isStar: false,
          color,
          x: 0,
          y: 0,
          z: 0,
          sx: 0,
          sy: 0,
          sr: 0,
          depth: 0,
        });
        edge = Math.max(edge, r + radius);
      }
      placed += take;
      ringIdx += 1;
    }
    return edge;
  };

  // ── Each star's moons, then how wide that system ended up ──
  const systemRadius = stars.map((n, i) => {
    const star = bodies[i]!;
    const moons = moonsOf[i]!;
    if (moons.length === 0) return star.radius;
    return fillRings(i, moons, star.radius + ringInset, n.id, star.color, 1.0);
  });

  // ── Star orbits: hub 0 holds the centre, the rest share one wide band
  //    around it. Stepping each one further out than the last (the obvious
  //    way) makes the radius grow with the hub count — eight hubs put the
  //    outermost thousands of units out and the fit shrank everything to
  //    specks. A band sized by total arc needed keeps the whole thing compact
  //    however many hubs there are. ──
  let outer = systemRadius[0] ?? 0;
  if (stars.length > 1) {
    const rest = systemRadius.slice(1);
    const arcNeeded = rest.reduce((sum, sr) => sum + 2 * sr + SYSTEM_GAP, 0);
    const widest = Math.max(...rest);
    const band = Math.max(
      // Enough circumference that neighbouring systems can't touch …
      (arcNeeded / (2 * Math.PI)) * 1.2,
      // … and enough clearance from the central system.
      outer + SYSTEM_GAP + widest,
    );
    for (let i = 1; i < stars.length; i += 1) {
      const k = i - 1;
      // A ±10% radial stagger gives each hub its own period, so the band
      // drifts apart over time instead of turning as a rigid wheel.
      const r = band * (1 + ((k % 3) - 1) * 0.1);
      rings.push({
        parent: -1,
        r,
        tilt: (hash01(stars[i]!.id, 24) - 0.5) * 0.55,
        node: hash01(stars[i]!.id, 25) * Math.PI * 2,
        speed: speedFor(r),
        color: bodies[i]!.color,
        major: true,
      });
      bodies[i]!.ring = rings.length - 1;
      bodies[i]!.phase = (k / rest.length) * Math.PI * 2;
      outer = Math.max(outer, r + systemRadius[i]!);
    }
  }

  // ── Belt: unlinked notes, spread over a few wide rings around everything ──
  if (belt.length > 0) {
    // With no system at all (every note isolated) the belt is the whole view,
    // so it starts close in rather than orbiting an empty centre.
    const inset = outer > 0 ? outer * BELT_GAP_FACTOR + ringInset : ringInset;
    const beltRings = Math.max(1, Math.min(BELT_RINGS, Math.ceil(belt.length / BELT_RING_LOAD)));
    let placed = 0;
    for (let k = 0; k < beltRings && placed < belt.length; k += 1) {
      const take = Math.ceil((belt.length - placed) / (beltRings - k));
      // A ring must have the circumference to seat everyone on it.
      const r = Math.max(inset + k * ringGap * 1.6, (take * 26) / (2 * Math.PI));
      rings.push({
        parent: -1,
        r,
        tilt: (hash01(`belt${k}`, 26) - 0.5) * 0.3,
        node: hash01(`belt${k}`, 27) * Math.PI * 2,
        speed: speedFor(r),
        color: beltColor,
        major: false,
      });
      const ringId = rings.length - 1;
      for (let j = 0; j < take; j += 1) {
        const n = belt[placed + j]!;
        const radius = nodeRadiusForDegree(degree.get(n.id) ?? 0);
        bodies.push({
          id: n.id,
          title: n.title,
          ring: ringId,
          parent: -1,
          phase: ((j + hash01(n.id, 28) * 0.6) / take) * Math.PI * 2,
          radius,
          isStar: false,
          color: beltColor,
          x: 0,
          y: 0,
          z: 0,
          sx: 0,
          sy: 0,
          sr: 0,
          depth: 0,
        });
        outer = Math.max(outer, r + radius);
      }
      placed += take;
    }
  }

  return { bodies, rings, extent: Math.max(1, outer) };
}

export function KnowledgeGraph3D({
  graph,
  width,
  height,
  selectedId,
  onSelect,
  onActivate,
  highlightIds,
}: {
  graph: ProjectGraph;
  width: number;
  height: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
  highlightIds: Set<string>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Pushed in by ref so selection / highlight changes repaint without tearing
  // the Pixi scene down (same trick the 2D canvas uses).
  const stateRef = useRef({ selectedId, highlightIds, neighbors: new Set<string>() });

  useEffect(() => {
    const neighbors = new Set<string>();
    if (selectedId) {
      for (const e of graph.edges) {
        if (e.from === selectedId) neighbors.add(e.to);
        else if (e.to === selectedId) neighbors.add(e.from);
      }
    }
    stateRef.current = { selectedId, highlightIds, neighbors };
  }, [selectedId, highlightIds, graph.edges]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedId !== null) onSelect(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, onSelect]);

  // Colours are baked into the pixi scene, so a theme switch rebuilds it.
  const themeVersion = useThemeVersion();
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let teardown: (() => void) | null = null;

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    const app = new Application();
    void app
      .init({
        canvas,
        width,
        height,
        resolution: RESOLUTION,
        antialias: true,
        backgroundAlpha: 0,
        autoDensity: true,
        // Same WKWebView / WebView2 split as the 2D canvas.
        preferWebGLVersion: isMac ? 1 : 2,
      })
      .then(() => {
        if (disposed) {
          try {
            app.destroy(true, { children: true });
          } catch {
            /* ignore */
          }
          return;
        }
        teardown = buildOrbitScene(app, graph, width, height, stateRef, onSelect, onActivate);
      })
      .catch(() => {
        /* disposal below cleans up */
      });

    return () => {
      disposed = true;
      try {
        teardown?.();
      } catch {
        /* ignore */
      }
      try {
        app.destroy(true, { children: true });
      } catch {
        /* ignore */
      }
      try {
        host.removeChild(canvas);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, width, height, themeVersion]);

  return <div ref={hostRef} className="h-full w-full" />;
}

function buildOrbitScene(
  app: Application,
  graph: ProjectGraph,
  width: number,
  height: number,
  stateRef: React.MutableRefObject<{
    selectedId: string | null;
    highlightIds: Set<string>;
    neighbors: Set<string>;
  }>,
  onSelect: (id: string | null) => void,
  onActivate: (id: string) => void,
): () => void {
  const light = document.documentElement.dataset.themeAppearance === "light";
  const { bodies, rings, extent } = buildSystem(graph, light ? BELT_HUE_LIGHT : BELT_HUE_DARK);
  const indexById = new Map<string, number>();
  bodies.forEach((b, i) => indexById.set(b.id, i));

  const cx = width / 2;
  const cy = height / 2;

  // Camera distance scales with the system, so perspective stays mild and
  // nothing ever crosses the near plane however big the graph gets.
  const focal = Math.max(900, extent * 2.4);
  /** Zoom that puts the whole system on screen — also the zoom range's anchor. */
  const fitZoom = Math.min(MAX_FIT_ZOOM, (Math.min(width, height) * FIT_FRACTION) / (extent * 2));
  const minZoom = fitZoom * 0.3;
  const maxZoom = fitZoom * 8;

  // ── Layers ───────────────────────────────────────────────────
  const starfield = new Graphics();
  const starInk = light ? 0x000000 : 0xffffff;
  for (let i = 0; i < STARFIELD_COUNT; i += 1) {
    const sx = hash01(`star${i}`, 11) * width;
    const sy = hash01(`star${i}`, 12) * height;
    const sr = 0.4 + hash01(`star${i}`, 13) * 1.1;
    starfield
      .circle(sx, sy, sr)
      .fill({ color: starInk, alpha: (0.05 + hash01(`star${i}`, 14) * 0.2) * (light ? 0.5 : 1) });
  }
  const ringLayer = new Graphics();
  const edgeLayer = new Graphics();
  const nodeLayer = new Graphics();
  const labelLayer = new Container();
  app.stage.addChild(starfield, ringLayer, edgeLayer, nodeLayer, labelLayer);

  const labelStyles = new Map<string, TextStyle>();
  const styleFor = (fill: string): TextStyle => {
    let s = labelStyles.get(fill);
    if (!s) {
      s = new TextStyle({
        fontFamily: "Inter, -apple-system, system-ui, sans-serif",
        // pixi rasterises label text into a WebGL atlas.
        // ratchet-allow: TextStyle takes a number, and no CSS is in this path.
        fontSize: 11,
        fontWeight: "500",
        fill,
        align: "center",
      });
      labelStyles.set(fill, s);
    }
    return s;
  };
  const labelPool: Text[] = [];

  // ── Camera ───────────────────────────────────────────────────
  let yaw = 0;
  let pitch = BASE_PITCH;
  let zoom = fitZoom;
  let panX = 0;
  let panY = 0;
  let t = 0;

  /** Rotate a world point into camera space, then project it. Returns null
   *  behind the camera. */
  const project = (x: number, y: number, z: number) => {
    const cyaw = Math.cos(yaw);
    const syaw = Math.sin(yaw);
    const x1 = x * cyaw + z * syaw;
    const z1 = -x * syaw + z * cyaw;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const denom = focal + z2;
    if (denom < 60) return null;
    const persp = focal / denom;
    const s = persp * zoom;
    return { sx: cx + panX + x1 * s, sy: cy + panY + y2 * s, persp, depth: z2 };
  };

  /** Position on `ring` at `angle`, in the ring's own tilted plane. */
  const ringPoint = (ring: Ring, angle: number) => {
    const lx = ring.r * Math.cos(angle);
    const lz = ring.r * Math.sin(angle);
    const ct = Math.cos(ring.tilt);
    const st = Math.sin(ring.tilt);
    const y1 = -lz * st;
    const z1 = lz * ct;
    const cn = Math.cos(ring.node);
    const sn = Math.sin(ring.node);
    return { x: lx * cn + z1 * sn, y: y1, z: -lx * sn + z1 * cn };
  };

  // ── Interaction ──────────────────────────────────────────────
  const canvas = app.canvas as HTMLCanvasElement;
  let drag: { x: number; y: number; mode: "rotate" | "pan"; moved: boolean } | null = null;
  let lastTapAt = 0;
  let lastTapId: string | null = null;

  const pick = (clientX: number, clientY: number): string | null => {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let hit: string | null = null;
    let bestDepth = Infinity;
    for (const b of bodies) {
      if (b.sr <= 0) continue;
      const dx = px - b.sx;
      const dy = py - b.sy;
      const reach = Math.max(b.sr + 4, 7);
      if (dx * dx + dy * dy > reach * reach) continue;
      // Nearest to camera wins when discs overlap.
      if (b.depth < bestDepth) {
        bestDepth = b.depth;
        hit = b.id;
      }
    }
    return hit;
  };

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    drag = {
      x: e.clientX,
      y: e.clientY,
      mode: e.button === 1 || e.button === 2 || e.shiftKey ? "pan" : "rotate",
      moved: false,
    };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    if (drag.mode === "pan") {
      panX += dx;
      panY += dy;
    } else {
      yaw += dx * 0.006;
      pitch = Math.max(-1.45, Math.min(1.45, pitch + dy * 0.005));
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
  };
  const onPointerUp = (e: PointerEvent) => {
    const wasDrag = drag;
    drag = null;
    canvas.style.cursor = "default";
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!wasDrag || wasDrag.moved || wasDrag.mode === "pan") return;
    const id = pick(e.clientX, e.clientY);
    const now = performance.now();
    if (id && id === lastTapId && now - lastTapAt < DOUBLE_CLICK_MS) {
      lastTapAt = 0;
      lastTapId = null;
      onActivate(id);
      return;
    }
    // Double-click empty space re-frames the system, the 2D view's gesture.
    if (!id && now - lastTapAt < DOUBLE_CLICK_MS && lastTapId === null) {
      zoom = fitZoom;
      panX = 0;
      panY = 0;
      pitch = BASE_PITCH;
    }
    lastTapAt = now;
    lastTapId = id;
    onSelect(id);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoom = Math.min(maxZoom, Math.max(minZoom, zoom * Math.exp(-e.deltaY * 0.0016)));
  };
  const onContext = (e: Event) => e.preventDefault();

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContext);

  // ── Frame ────────────────────────────────────────────────────
  const order: number[] = bodies.map((_, i) => i);
  /** Live angle per ring, so bodies and the ring they sit on stay locked. */
  const ringAngle = new Float64Array(rings.length);
  const hazeSpan = extent * 1.6;

  const tick = (ticker: Ticker) => {
    const dt = Math.min(ticker.deltaMS, 50) / 1000;
    t += dt;
    yaw += GLOBAL_SPIN * dt;

    const P = graphPalette();
    const { selectedId, highlightIds, neighbors } = stateRef.current;
    const hasFocus = selectedId !== null;
    const hasHighlight = !hasFocus && highlightIds.size > 0;
    const dim = light ? 0xa8a8a8 : 0x6b6b6b;
    // Discs track zoom, but only within a readable band — see `b.sr` below.
    const discZoom = Math.max(0.8, Math.min(2, zoom));

    for (let i = 0; i < rings.length; i += 1) ringAngle[i] = rings[i]!.speed * t;

    // Stars come first in `bodies`, so a moon always reads its parent's
    // already-updated position.
    for (const b of bodies) {
      const base = b.parent >= 0 ? bodies[b.parent]! : null;
      if (b.ring < 0) {
        b.x = base?.x ?? 0;
        b.y = base?.y ?? 0;
        b.z = base?.z ?? 0;
      } else {
        const ring = rings[b.ring]!;
        const p = ringPoint(ring, b.phase + ringAngle[b.ring]!);
        b.x = (base?.x ?? 0) + p.x;
        b.y = (base?.y ?? 0) + p.y;
        b.z = (base?.z ?? 0) + p.z;
      }
      const pr = project(b.x, b.y, b.z);
      if (!pr) {
        b.sr = 0;
        b.depth = Infinity;
        continue;
      }
      b.sx = pr.sx;
      b.sy = pr.sy;
      // Disc size is screen-space, not world-space: a wide graph fits by
      // shrinking its orbits, and scaling the discs with it made them
      // sub-pixel. Perspective still sizes them by depth.
      b.sr = Math.max(1.5, b.radius * pr.persp * discZoom);
      b.depth = pr.depth;
    }

    // ── Orbit rings ──
    ringLayer.clear();
    for (const ring of rings) {
      const origin = ring.parent >= 0 ? bodies[ring.parent]! : null;
      const ox = origin?.x ?? 0;
      const oy = origin?.y ?? 0;
      const oz = origin?.z ?? 0;
      const steps = ring.major ? 72 : 40;
      let started = false;
      for (let k = 0; k <= steps; k += 1) {
        const p = ringPoint(ring, (k / steps) * Math.PI * 2);
        const pr = project(ox + p.x, oy + p.y, oz + p.z);
        if (!pr) {
          started = false;
          continue;
        }
        if (!started) {
          ringLayer.moveTo(pr.sx, pr.sy);
          started = true;
        } else {
          ringLayer.lineTo(pr.sx, pr.sy);
        }
      }
      ringLayer.stroke({
        width: 1,
        color: ring.color,
        alpha: (ring.major ? 0.2 : 0.11) * (light ? 1.5 : 1),
      });
    }

    // ── Edges ──
    edgeLayer.clear();
    for (const e of graph.edges) {
      const ai = indexById.get(e.from);
      const bi = indexById.get(e.to);
      if (ai === undefined || bi === undefined) continue;
      const a = bodies[ai]!;
      const b = bodies[bi]!;
      if (a.sr <= 0 || b.sr <= 0) continue;
      const touchesFocus = hasFocus && (selectedId === e.from || selectedId === e.to);
      let color = P.edgeDefault;
      let alpha = 0.22;
      if (hasFocus) {
        color = touchesFocus ? P.edgeSelected : P.edgeDim;
        alpha = touchesFocus ? 0.85 : 0.08;
      } else if (hasHighlight) {
        const inWorkspace = highlightIds.has(e.from) && highlightIds.has(e.to);
        color = inWorkspace ? P.edgeSelected : P.edgeDim;
        alpha = inWorkspace ? 0.5 : 0.08;
      }
      edgeLayer.moveTo(a.sx, a.sy);
      edgeLayer.lineTo(b.sx, b.sy);
      edgeLayer.stroke({ width: touchesFocus ? 1.6 : 1, color, alpha });
    }

    // ── Nodes, painter's order (far → near) ──
    order.sort((i, j) => bodies[j]!.depth - bodies[i]!.depth);
    nodeLayer.clear();
    for (const i of order) {
      const b = bodies[i]!;
      if (b.sr <= 0) continue;
      const isFocused = selectedId === b.id;
      const isNeighbor = neighbors.has(b.id);
      // Haze with distance so depth reads without a z-buffer.
      let alpha = Math.max(0.3, Math.min(1, 1.15 - b.depth / hazeSpan));
      let color = b.color;
      if (hasFocus && !isFocused && !isNeighbor) {
        color = dim;
        alpha *= 0.35;
      } else if (hasHighlight && !highlightIds.has(b.id)) {
        color = dim;
        alpha *= 0.4;
      }
      if (b.isStar || isFocused) {
        // Corona — two soft rings, cheaper and steadier than a blur filter.
        nodeLayer.circle(b.sx, b.sy, b.sr * 2.6).fill({ color, alpha: alpha * 0.08 });
        nodeLayer.circle(b.sx, b.sy, b.sr * 1.6).fill({ color, alpha: alpha * 0.16 });
      }
      nodeLayer.circle(b.sx, b.sy, b.sr).fill({ color, alpha });
      if (isFocused) {
        nodeLayer.circle(b.sx, b.sy, b.sr + 4).stroke({ width: 1.5, color: P.primary, alpha: 0.8 });
      }
    }

    // ── Labels: stars + whatever is in focus, nearest first ──
    const wanted: Orbiter[] = [];
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const b = bodies[order[i]!]!;
      if (b.sr <= 0) continue;
      if (b.isStar || selectedId === b.id || neighbors.has(b.id)) wanted.push(b);
    }
    const shown = wanted.slice(0, MAX_LABELS);
    while (labelPool.length < shown.length) {
      const text = new Text({ text: "", style: styleFor(P.labelSecondary) });
      text.anchor.set(0.5, 0);
      labelLayer.addChild(text);
      labelPool.push(text);
    }
    shown.forEach((b, i) => {
      const label = labelPool[i]!;
      if (label.text !== b.title) label.text = b.title;
      label.visible = true;
      label.position.set(b.sx, b.sy + b.sr + 5);
      const focused = selectedId === b.id || neighbors.has(b.id);
      label.style = styleFor(focused ? P.labelPrimary : P.labelSecondary);
      label.alpha = focused ? 1 : hasFocus ? 0.3 : 0.75;
    });
    for (let i = shown.length; i < labelPool.length; i += 1) labelPool[i]!.visible = false;
  };

  app.ticker.add(tick);

  return () => {
    app.ticker.remove(tick);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContext);
  };
}
