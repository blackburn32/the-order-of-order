import Phaser from "phaser";

/**
 * Chain lightning between the dice that fired one effect together — Consensus'
 * matched faces, The Congregation's scoring set. A per-die border flash says
 * "this die did something"; an arc says "these dice did it *together*", which
 * is the whole point of an effect that needs more than one die.
 *
 * Drawn in grid-world coordinates, into the grid container above the dice, so
 * it pans, zooms and shakes with the table. One Graphics carries every arc of a
 * roll and is redrawn per frame while it lives, so the cost is a single draw
 * call however many chains fired — and GameScene only asks for it at the same
 * detail levels that pulse per-die borders, never at summary-card zoom.
 */

/** One group of dice to link, in grid-world coordinates. */
export interface ChainGroup {
  color: number;
  points: { x: number; y: number }[];
}

export interface ChainLightningOptions {
  /** A die's drawn edge length in world units, which every width and offset
   *  scales by so the arcs read the same at any grid density. */
  dieSize: number;
  /** Whether the arcs may flicker and crawl. Off under reduced motion: each
   *  arc keeps one fixed shape and simply fades. */
  motion: boolean;
}

/** Delay between one link lighting and the links hanging off it. */
const HOP_MS = 55;
/** Ceiling on the whole propagation, so a long chain still lands inside the
 *  border pulse rather than crawling on after the dice have calmed. */
const MAX_PROPAGATION_MS = 330;
/** How long a link takes to strike across from one die to the next. */
const STRIKE_MS = 70;
/** How long a link stays lit after it strikes, fade included. */
const LINK_LIFE_MS = 520;
/** Fraction of a link's life spent fading. */
const FADE_FRACTION = 0.45;
/** How often an arc re-rolls its jagged shape. */
const FLICKER_MS = 45;

interface Link {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  color: number;
  startMs: number;
  seed: number;
}

export class ChainLightning {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly links: Link[];
  private readonly startedAt: number;
  private readonly endsAt: number;
  private destroyed = false;

  constructor(
    private readonly scene: Phaser.Scene,
    parent: Phaser.GameObjects.Container,
    groups: ChainGroup[],
    private readonly options: ChainLightningOptions,
  ) {
    this.graphics = scene.add.graphics();
    this.graphics.setBlendMode(Phaser.BlendModes.ADD);
    parent.add(this.graphics);
    this.links = groups.flatMap((group, i) => chainLinks(group, i, options));
    this.startedAt = scene.time.now;
    this.endsAt = this.links.reduce(
      (end, link) => Math.max(end, link.startMs + STRIKE_MS + LINK_LIFE_MS),
      0,
    );
    scene.events.on(Phaser.Scenes.Events.UPDATE, this.draw, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    this.draw();
  }

  /** The object to hide from cameras that should not draw grid content. */
  get object(): Phaser.GameObjects.Graphics {
    return this.graphics;
  }

  get empty(): boolean {
    return this.links.length === 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.events.off(Phaser.Scenes.Events.UPDATE, this.draw, this);
    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    this.graphics.destroy();
  }

  private draw(): void {
    const elapsed = this.scene.time.now - this.startedAt;
    if (elapsed >= this.endsAt) {
      this.destroy();
      return;
    }
    const g = this.graphics;
    g.clear();
    const size = this.options.dieSize;
    const flicker = this.options.motion ? Math.floor(elapsed / FLICKER_MS) : 0;
    for (const link of this.links) {
      const t = elapsed - link.startMs;
      if (t < 0 || t >= STRIKE_MS + LINK_LIFE_MS) continue;
      const reach = Math.min(1, t / STRIKE_MS);
      const life = Math.max(0, t - STRIKE_MS) / LINK_LIFE_MS;
      const fadeFrom = 1 - FADE_FRACTION;
      const alpha =
        life < fadeFrom ? 1 : 1 - (life - fadeFrom) / (1 - fadeFrom);
      // A fresh strike flares before it settles into its steady glow.
      const flare = 1 + 0.6 * Math.max(0, 1 - t / (STRIKE_MS * 2));
      const points = boltPath(link, size, link.seed * 977 + flicker, reach);
      strokeBolt(g, points, link.color, size, alpha, flare);
      // A fork off the main arc, re-rolled with the flicker, so the chain
      // crackles rather than reading as a wobbling wire.
      if (reach === 1 && this.options.motion) {
        const fork = forkPath(points, size, link.seed * 131 + flicker);
        if (fork) strokeBolt(g, fork, link.color, size * 0.6, alpha * 0.8, 1);
      }
      // Sparks where the arc meets each die: small, so they read as contact
      // points on the border rather than washing out the face beside them.
      const head = points[points.length - 1];
      g.fillStyle(link.color, 0.3 * alpha);
      g.fillCircle(points[0].x, points[0].y, size * 0.07 * flare);
      g.fillCircle(head.x, head.y, size * 0.07 * flare);
      g.fillStyle(0xffffff, 0.8 * alpha);
      g.fillCircle(points[0].x, points[0].y, size * 0.025 * flare);
      g.fillCircle(head.x, head.y, size * 0.025 * flare);
    }
  }
}

/**
 * The links for one group: a minimum spanning tree over its dice, so every die
 * is joined to its nearest neighbour in the group rather than strung in index
 * order back and forth across the grid. Each link starts where the tree reaches
 * it, breadth-first from the group's first die, so the arc visibly jumps from
 * die to die.
 */
function chainLinks(
  group: ChainGroup,
  groupIndex: number,
  options: ChainLightningOptions,
): Link[] {
  const pts = group.points;
  const n = pts.length;
  if (n < 2) return [];

  // Prim's algorithm; n is bounded by the caller's pulse budget.
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  const parent = new Array<number>(n).fill(-1);
  const depth = new Array<number>(n).fill(0);
  best[0] = 0;
  const edges: { from: number; to: number }[] = [];
  for (let step = 0; step < n; step++) {
    let next = -1;
    for (let i = 0; i < n; i++) {
      if (!inTree[i] && (next < 0 || best[i] < best[next])) next = i;
    }
    inTree[next] = true;
    if (parent[next] >= 0) {
      depth[next] = depth[parent[next]] + 1;
      edges.push({ from: parent[next], to: next });
    }
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      const d = Math.hypot(pts[i].x - pts[next].x, pts[i].y - pts[next].y);
      if (d < best[i]) {
        best[i] = d;
        parent[i] = next;
      }
    }
  }

  const maxDepth = Math.max(...depth);
  const hop = Math.min(HOP_MS, MAX_PROPAGATION_MS / Math.max(1, maxDepth));
  const half = options.dieSize / 2;
  return edges.map(({ from, to }, i) => {
    const a = pts[from];
    const b = pts[to];
    // Run edge to edge: an arc drawn over the faces it is linking would hide
    // the very numbers that matched.
    const [ax, ay] = edgePoint(a, b, half);
    const [bx, by] = edgePoint(b, a, half);
    return {
      ax,
      ay,
      bx,
      by,
      color: group.color,
      startMs: (depth[to] - 1) * hop,
      seed: groupIndex * 7919 + i + 1,
    };
  });
}

/** Where the ray from `from` toward `to` leaves a die of half-width `half`
 *  centred on `from`, pulled in a touch so the arc visibly touches the border. */
function edgePoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
  half: number,
): [number, number] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const reach = half * 0.9;
  const t = Math.min(
    dx === 0 ? Infinity : reach / Math.abs(dx),
    dy === 0 ? Infinity : reach / Math.abs(dy),
  );
  if (!Number.isFinite(t) || t >= 0.5) {
    return [(from.x + to.x) / 2, (from.y + to.y) / 2];
  }
  return [from.x + dx * t, from.y + dy * t];
}

/** A small deterministic generator, so a clip replays the same arcs. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** A jagged path from a link's first die toward its second, `reach` of the
 *  way along. The kinks taper to nothing at both ends so the arc always lands
 *  exactly on the dice it joins. */
function boltPath(
  link: Link,
  size: number,
  seed: number,
  reach: number,
): Phaser.Math.Vector2[] {
  const dx = link.bx - link.ax;
  const dy = link.by - link.ay;
  const length = Math.hypot(dx, dy);
  const segments = Phaser.Math.Clamp(Math.round(length / (size * 0.28)), 3, 14);
  const nx = length > 0 ? -dy / length : 0;
  const ny = length > 0 ? dx / length : 0;
  const amplitude = Math.min(length * 0.16, size * 0.24);
  const rand = random(seed);
  const points: Phaser.Math.Vector2[] = [];
  const last = Math.max(1, Math.ceil(segments * reach));
  for (let i = 0; i <= last; i++) {
    const t = Math.min(reach, i / segments);
    const taper = Math.sin(Math.PI * t);
    const offset =
      i === 0 || t === 1 ? 0 : (rand() * 2 - 1) * amplitude * taper;
    points.push(
      new Phaser.Math.Vector2(
        link.ax + dx * t + nx * offset,
        link.ay + dy * t + ny * offset,
      ),
    );
  }
  return points;
}

/** A short spur leaving the arc at a random kink, or nothing on a quiet frame. */
function forkPath(
  bolt: Phaser.Math.Vector2[],
  size: number,
  seed: number,
): Phaser.Math.Vector2[] | undefined {
  if (bolt.length < 4) return undefined;
  const rand = random(seed);
  if (rand() < 0.45) return undefined;
  const at = 1 + Math.floor(rand() * (bolt.length - 2));
  const from = bolt[at];
  const along = bolt[at + 1]
    .clone()
    .subtract(bolt[at - 1])
    .normalize();
  const angle = (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.5);
  const dir = along.rotate(angle);
  const length = size * (0.25 + rand() * 0.3);
  const points = [from.clone()];
  for (let i = 1; i <= 3; i++) {
    const jitter = (rand() * 2 - 1) * size * 0.06;
    points.push(
      new Phaser.Math.Vector2(
        from.x + dir.x * length * (i / 3) - dir.y * jitter,
        from.y + dir.y * length * (i / 3) + dir.x * jitter,
      ),
    );
  }
  return points;
}

/** Three passes: a wide coloured glow, the coloured arc, a white-hot core. */
function strokeBolt(
  g: Phaser.GameObjects.Graphics,
  points: Phaser.Math.Vector2[],
  color: number,
  size: number,
  alpha: number,
  flare: number,
): void {
  if (points.length < 2) return;
  g.lineStyle(size * 0.16 * flare, color, 0.22 * alpha);
  g.strokePoints(points);
  g.lineStyle(size * 0.065 * flare, color, 0.85 * alpha);
  g.strokePoints(points);
  g.lineStyle(size * 0.025 * flare, 0xffffff, alpha);
  g.strokePoints(points);
}
