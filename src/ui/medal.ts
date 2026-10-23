// The medal a goal tier is shown as: behind the verdict on the trial results,
// and behind the title on the two run-end screens, where it stands for the
// run's rank. Drawn from shapes rather than baked art, so one function serves
// every tier at any size, and the tier's colour (systems/GoalTiers) is the
// only thing that tells bronze from legendary.
//
// It sits behind text, so it is drawn faint: the fills carry the alpha, not the
// container, which leaves the container free for a scene's reveal tween to
// fade in from 0 to 1 like any other object on the screen.

import Phaser from "phaser";
import { GOAL_TIERS } from "../config";
import { TIER_CSS } from "../systems/GoalTiers";

/** How strongly the medal shows through the text laid over it. */
const MEDAL_ALPHA = 0.45;

function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

/** Points around a circle, alternating between two radii from `outer`. */
function starPoints(
  points: number,
  outer: number,
  inner: number,
  rotation = -Math.PI / 2,
): Phaser.Math.Vector2[] {
  const out: Phaser.Math.Vector2[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation + (i * Math.PI) / points;
    out.push(new Phaser.Math.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return out;
}

/**
 * A medal for tier `index` (0 bronze … 3 legendary) centred on (x, y), its
 * disc `radius` across from the centre. Its ribbon hangs below the disc. Each
 * tier above bronze adds a star to the face, and legendary is ringed in rays.
 * Returns null for -1, the absence of a tier.
 */
export function buildMedal(
  scene: Phaser.Scene,
  x: number,
  y: number,
  radius: number,
  index: number,
  alpha = MEDAL_ALPHA,
): Phaser.GameObjects.Container | null {
  if (index < 0) return null;
  const tier = GOAL_TIERS[Math.min(index, GOAL_TIERS.length - 1)];
  const base = Phaser.Display.Color.HexStringToColor(TIER_CSS[tier]).color;
  const dark = shade(base, 0.55);
  const light = shade(base, 1.25);
  const g = scene.add.graphics();

  // Legendary's rays, behind everything else.
  if (tier === "legendary") {
    g.fillStyle(light, alpha * 0.45);
    g.fillPoints(starPoints(16, radius * 1.45, radius * 0.92), true);
  }

  // The ribbon: two tails hanging from behind the disc, notched at the foot.
  const tail = (side: -1 | 1) => {
    const top = radius * 0.35;
    const foot = radius * 1.3;
    const inner = side * radius * 0.08;
    const outer = side * radius * 0.62;
    return [
      new Phaser.Math.Vector2(inner, top),
      new Phaser.Math.Vector2(outer, top),
      new Phaser.Math.Vector2(outer + side * radius * 0.18, foot),
      new Phaser.Math.Vector2((inner + outer) / 2, foot - radius * 0.18),
      new Phaser.Math.Vector2(inner - side * radius * 0.12, foot),
    ];
  };
  // Fainter than the disc: the line under a title runs across it.
  g.fillStyle(dark, alpha * 0.55);
  g.fillPoints(tail(-1), true);
  g.fillPoints(tail(1), true);

  // The disc: a scalloped rim, a face, and a ring between them.
  g.fillStyle(dark, alpha);
  g.fillPoints(starPoints(24, radius, radius * 0.93), true);
  g.fillStyle(base, alpha);
  g.fillCircle(0, 0, radius * 0.86);
  g.lineStyle(Math.max(2, radius * 0.05), light, alpha);
  g.strokeCircle(0, 0, radius * 0.72);

  // The face: one star per tier, set in a row (legendary's four on a curve).
  const stars = index + 1;
  const starR = radius * (stars === 1 ? 0.42 : stars === 2 ? 0.3 : 0.24);
  const spread = starR * 2.05;
  g.fillStyle(dark, alpha);
  for (let i = 0; i < stars; i++) {
    const offset = i - (stars - 1) / 2;
    const sx = offset * spread;
    const sy = stars > 2 ? Math.abs(offset) * starR * 0.55 : 0;
    g.fillPoints(
      starPoints(5, starR, starR * 0.45).map(
        (p) => new Phaser.Math.Vector2(p.x + sx, p.y + sy),
      ),
      true,
    );
  }

  return scene.add.container(x, y, [g]);
}
