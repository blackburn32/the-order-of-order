/**
 * The turning sigils from the game, redrawn as SVG.
 *
 * This is a direct port of `buildSigil` and `buildSigilRing` in
 * `src/art/textures.ts` — the same radii, tick cadences, gate counts and
 * per-stroke alphas, so the marks the landing page turns are the marks the
 * player sees behind the dice. Keep the two in step: if a variant changes in
 * the game, change it here.
 *
 * Every stroke uses `currentColor`, so the tint is a CSS decision. Rotation is
 * CSS too (see `.sigil-mark` / `.sigil-ring` in styles.css) rather than a
 * requestAnimationFrame loop, which keeps a page-sized ornament on the
 * compositor instead of the main thread.
 */

const NS = "http://www.w3.org/2000/svg";

/** Ink radius of a sigil, as a fraction of half its box. */
export const SIGIL_INK_RADIUS = 248 / 256;
/** Innermost ink radius of a ring, as a fraction of half its box. */
export const SIGIL_RING_INNER_INK_RADIUS = 384 / 512;
const SIGIL_RING_OUTER_INK_RADIUS = 500 / 512;

export const SIGIL_VARIANTS = 3;

function el(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const key in attrs) node.setAttribute(key, String(attrs[key]));
  return node;
}

function stroked(tag, attrs, width, alpha) {
  return el(tag, { ...attrs, "stroke-width": width, opacity: alpha });
}

function circle(cx, cy, r, width, alpha) {
  return stroked("circle", { cx, cy, r }, width, alpha);
}

function line(x1, y1, x2, y2, width, alpha) {
  return stroked("line", { x1, y1, x2, y2 }, width, alpha);
}

/** Regular-polygon vertices, pointy-top by default. */
function polygon(cx, cy, radius, sides, rotationDeg, width, alpha) {
  const points = [];
  for (let i = 0; i < sides; i++) {
    const angle = ((rotationDeg + (360 / sides) * i) * Math.PI) / 180;
    points.push(
      cx + radius * Math.cos(angle) + "," + (cy + radius * Math.sin(angle)),
    );
  }
  return stroked("polygon", { points: points.join(" ") }, width, alpha);
}

/** Equal arc segments separated by small gates. */
function brokenRing(
  parent,
  center,
  radius,
  segments,
  offset,
  gap,
  alpha = 0.7,
  width = 2,
) {
  const step = (Math.PI * 2) / segments;
  for (let i = 0; i < segments; i++) {
    const from = offset + step * i + gap;
    const to = offset + step * (i + 1) - gap;
    const large = to - from > Math.PI ? 1 : 0;
    const d = [
      "M",
      center + Math.cos(from) * radius,
      center + Math.sin(from) * radius,
      "A",
      radius,
      radius,
      0,
      large,
      1,
      center + Math.cos(to) * radius,
      center + Math.sin(to) * radius,
    ].join(" ");
    parent.appendChild(stroked("path", { d }, width, alpha));
  }
}

function frame(size, className) {
  const svg = el("svg", {
    viewBox: "0 0 " + size + " " + size,
    focusable: "false",
    "aria-hidden": "true",
    class: className,
  });
  const g = el("g", {
    fill: "none",
    stroke: "currentColor",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.appendChild(g);
  return { svg, g };
}

/** The inner mark: measured outer rings, a tick cadence, and a variant core. */
export function createSigil(variant = 0) {
  const size = 512;
  const c = size / 2;
  const v = ((variant % SIGIL_VARIANTS) + SIGIL_VARIANTS) % SIGIL_VARIANTS;
  const { svg, g } = frame(size, "sigil-mark");

  g.appendChild(circle(c, c, 248, 3, 0.9));
  g.appendChild(circle(c, c, 232, 1.5, 0.6));

  // Tick ring between the two outer circles, with longer marks at each
  // variant's major divisions.
  const ticks = [36, 48, 30][v];
  const majorEvery = [9, 6, 5][v];
  for (let i = 0; i < ticks; i++) {
    const angle = (Math.PI * 2 * i) / ticks;
    const long = i % majorEvery === 0;
    const inner = long ? 214 : 224;
    g.appendChild(
      line(
        c + Math.cos(angle) * inner,
        c + Math.sin(angle) * inner,
        c + Math.cos(angle) * 232,
        c + Math.sin(angle) * 232,
        long ? 3 : 1.5,
        long ? 0.9 : 0.5,
      ),
    );
  }

  if (v === 0) {
    // Broken inner ring: four arcs with gaps on the diagonals.
    brokenRing(g, c, 168, 4, Math.PI / 4, 0.16);
    g.appendChild(polygon(c, c, 150, 3, -90, 2, 0.55));
    g.appendChild(circle(c, c, 76, 2, 0.45));
    g.appendChild(circle(c, c, 62, 1.5, 0.3));
  } else if (v === 1) {
    // An eight-gated ring around two counter-set squares, with short spokes:
    // this one reads like a mechanical compass as it turns.
    brokenRing(g, c, 174, 8, 0, 0.1);
    g.appendChild(polygon(c, c, 148, 4, 45, 2, 0.58));
    g.appendChild(polygon(c, c, 104, 4, 0, 1.5, 0.42));
    for (let i = 0; i < 4; i++) {
      const angle = (Math.PI / 2) * i;
      g.appendChild(
        line(
          c + Math.cos(angle) * 104,
          c + Math.sin(angle) * 104,
          c + Math.cos(angle) * 148,
          c + Math.sin(angle) * 148,
          1.5,
          0.42,
        ),
      );
    }
    g.appendChild(circle(c, c, 48, 2, 0.42));
    g.appendChild(
      el("circle", { cx: c, cy: c, r: 7, fill: "currentColor", opacity: 0.5 }),
    );
  } else {
    // A six-gated ring and a hexagram: the most ceremonial silhouette of the
    // three, on the same measured bounds.
    brokenRing(g, c, 170, 6, -Math.PI / 6, 0.13);
    g.appendChild(polygon(c, c, 148, 3, -90, 2, 0.52));
    g.appendChild(polygon(c, c, 148, 3, 90, 2, 0.52));
    g.appendChild(polygon(c, c, 72, 6, -90, 1.5, 0.38));
    g.appendChild(circle(c, c, 42, 2, 0.42));
  }

  return svg;
}

/** The outer band, which turns the other way. Deliberately different
 *  symmetries from the inner marks, so the pair stays readable in motion. */
export function createSigilRing(variant = 0) {
  const size = 1024;
  const c = size / 2;
  const v = ((variant % SIGIL_VARIANTS) + SIGIL_VARIANTS) % SIGIL_VARIANTS;
  const outer = c * SIGIL_RING_OUTER_INK_RADIUS;
  const inner = c * SIGIL_RING_INNER_INK_RADIUS;
  const { svg, g } = frame(size, "sigil-ring");

  g.appendChild(circle(c, c, outer, 3, 0.9));
  g.appendChild(circle(c, c, outer - 16, 1.5, 0.6));

  const ticks = [96, 80, 90][v];
  const majorEvery = [8, 10, 9][v];
  for (let i = 0; i < ticks; i++) {
    const angle = (Math.PI * 2 * i) / ticks;
    const long = i % majorEvery === 0;
    const from = long ? outer - 46 : outer - 30;
    g.appendChild(
      line(
        c + Math.cos(angle) * from,
        c + Math.sin(angle) * from,
        c + Math.cos(angle) * (outer - 16),
        c + Math.sin(angle) * (outer - 16),
        long ? 3 : 1.5,
        long ? 0.9 : 0.45,
      ),
    );
  }

  const arcR = (inner + outer - 46) / 2;
  const segments = [6, 8, 5][v];
  const gap = [0.1, 0.08, 0.12][v];
  brokenRing(g, c, arcR, segments, 0, gap);
  if (v === 1) {
    brokenRing(g, c, arcR + 18, segments, Math.PI / segments, gap * 0.8, 0.42);
  }

  // Lozenges, triangles, and pentagons distinguish the three gate patterns.
  const markerSides = [4, 3, 5][v];
  const markerRadius = [9, 10, 8][v];
  for (let i = 0; i < segments; i++) {
    const angle = (Math.PI * 2 * i) / segments;
    const marker = polygon(
      c + Math.cos(angle) * arcR,
      c + Math.sin(angle) * arcR,
      markerRadius,
      markerSides,
      (angle * 180) / Math.PI - 90,
      0,
      0.6,
    );
    marker.setAttribute("fill", "currentColor");
    g.appendChild(marker);
  }

  g.appendChild(circle(c, c, inner + 14, 2, 0.5));
  g.appendChild(circle(c, c, inner, 1.5, 0.3));

  return svg;
}

/**
 * Fill every `[data-sigil]` slot on the page.
 *
 * `data-sigil` picks the variant; `data-sigil-ring` adds the counter-turning
 * band. Sizing and tint stay in CSS so each slot can be tuned per section.
 */
export function mountSigils(root = document) {
  for (const host of root.querySelectorAll("[data-sigil]")) {
    const variant = Number(host.dataset.sigil) || 0;
    host.appendChild(createSigil(variant));
    if (host.hasAttribute("data-sigil-ring")) {
      host.appendChild(createSigilRing(variant));
    }
  }
}
