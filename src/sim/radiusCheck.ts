// The radius dice (systems/RadiusDice), asserted: their reach, each of the
// three rules, the order they resolve in, and the points they score.
//
//   npm run radius:check

import "./localStorageShim";
import { newRun } from "../state/RunState";
import {
  makeDie,
  sizeAbove,
  sizeBelow,
  type Die,
  type DieSides,
} from "../systems/Dice";
import { DicePool } from "../systems/DicePool";
import {
  RADIUS_DICE,
  RADIUS_OFFSETS,
  gridColumnsFor,
  radiusNeighbours,
  type RadiusKind,
} from "../systems/RadiusDice";
import { scoreRollHistogram } from "../systems/ScoringHistogram";
import { applyOffer, offerFor } from "../systems/Shop";
import { ITEMS } from "../systems/Items";
import { dieEffects } from "../systems/DieEffects";
import { arrangeRadiusDice } from "./arrange";
import {
  markMoveTipDone,
  markMoveTipShown,
  moveTipPending,
  pendingGridHints,
} from "../systems/Tutorial";

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ok  ${message}`);
}

const plain = (sides: DieSides) => makeDie(sides);
const radius = (kind: RadiusKind) =>
  makeDie(RADIUS_DICE[kind].sides, {}, RADIUS_DICE[kind].source);

/** An rng that lands each roll on the face asked for: the grid's dice in
 *  order, then each reroll Grace asks for. */
function facesRng(rolls: [face: number, sides: number][]): () => number {
  let k = 0;
  return () => {
    const roll = rolls[k++];
    if (!roll) throw new Error("rng ran past the faces given");
    return (roll[0] - 0.5) / roll[1];
  };
}

function rollGrid(
  dice: Die[],
  faces: number[],
  rerolls: { sides: number; face: number }[] = [],
  aspect = 1,
  inert = 0,
): DicePool {
  const pool = DicePool.fromDice(dice);
  pool.setGridAspect(aspect);
  pool.roll(
    facesRng([
      ...dice.map((d, i) => [faces[i], d.sides] as [number, number]),
      ...rerolls.map((r) => [r.face, r.sides] as [number, number]),
    ]),
    [1],
    [],
    inert,
  );
  return pool;
}

console.log("Reach");
check(
  RADIUS_OFFSETS.length === 20,
  "a circle reaches the 5×5 block less its four corners",
);
check(
  gridColumnsFor(25, 1) === 5 && gridColumnsFor(3, 4) === 3,
  "columns follow the frame, never wider than the dice",
);
check(
  radiusNeighbours(12, 25, 5).length === 20 &&
    !radiusNeighbours(12, 25, 5).includes(0) &&
    radiusNeighbours(12, 25, 5).includes(1),
  "the centre of a 5×5 grid reaches every die but the four corners",
);
check(
  radiusNeighbours(0, 25, 5).join() === "1,2,5,6,7,10,11",
  "a corner die reaches only what lies inside the grid",
);

console.log("Sizes");
check(
  sizeBelow(12) === 10 && sizeAbove(12) === 20,
  "a d12 steps down to a d10 and up to a d20",
);
check(
  sizeBelow(12, 2) === 8 && sizeAbove(12, 2) === 100,
  "and keeps walking the ladder from there",
);

console.log("The Halo");
{
  // 3×3: a Halo in the middle on its 8, every other die showing a 1.
  const dice = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
    i === 4 ? radius("halo") : plain(6),
  );
  const pool = rollGrid(dice, [1, 1, 1, 1, 8, 1, 1, 1, 1]);
  const agg = pool.agg();
  check(agg.scoringCount === 8, "eight dice score on their 1");
  check(agg.haloBonus === 8 * 3, "each pays ×4: three more points apiece");
  const result = scoreRollHistogram(newRun(), agg);
  check(result.points === 32n, "the roll scores 8 × 4 = 32");
  check(
    result.modifiers.some((m) => m.id === "halo" && m.points === 24n),
    "and names The Halo for the 24 it added",
  );
  const quiet = rollGrid(
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
      i === 4 ? radius("halo") : plain(6),
    ),
    [1, 1, 1, 1, 7, 1, 1, 1, 1],
  );
  check(
    !quiet.agg().haloBonus && quiet.lastRadius() === null,
    "off its top face, it does nothing",
  );
}
{
  // Two Halos reaching the same die multiply: ×16.
  const dice = [radius("halo"), plain(6), radius("halo")];
  const pool = rollGrid(dice, [8, 1, 8]);
  check(pool.agg().haloBonus === 15, "two Halos over one die make it ×16");
}

console.log("Grace");
{
  // A Grace on its 6 beside a d6 that missed on a 4: both roll once more.
  const dice = [radius("grace"), plain(6), plain(6)];
  const pool = rollGrid(
    dice,
    [6, 4, 1],
    [
      { sides: 6, face: 1 },
      { sides: 6, face: 1 },
    ],
  );
  const report = pool.lastRadius()!;
  check(
    report.rerolled.map((r) => `${r.index}:${r.from}`).join() === "0:6,1:4",
    "the dice that missed roll again, Grace itself included, and the die that scored does not",
  );
  check(pool.agg().scoringCount === 3, "all three now score");
}
{
  // A die two Graces reach still rolls only once.
  const dice = [radius("grace"), plain(6), radius("grace")];
  const pool = rollGrid(
    dice,
    [6, 3, 6],
    [
      { sides: 6, face: 2 },
      { sides: 6, face: 5 },
      { sides: 6, face: 2 },
    ],
  );
  check(
    pool.lastRadius()!.rerolled.length === 3,
    "every miss rolls once, however many Graces reach it",
  );
}

console.log("The Censer");
{
  // A Censer on its 12 next to a Centurion on a 7: the Centurion turns to its
  // 100, scores, and quadruples the roll.
  const centurion = makeDie(100, { maxFaceBonus: true }, "centurion");
  const dice = [radius("censer"), centurion, plain(6)];
  const pool = rollGrid(dice, [12, 7, 1]);
  check(dice[1].value === 100, "the Centurion is turned to its highest face");
  check(pool.agg().windfallMult === 4n, "and its ×4 goes off");
  check(dice[2].value === 1, "a plain die is left as it rolled");
}
{
  // Censer -> Censer -> Halo, as a chain along a row of five.
  const dice = [
    radius("censer"),
    plain(6),
    radius("censer"),
    plain(6),
    radius("halo"),
  ];
  const pool = rollGrid(dice, [12, 1, 3, 1, 2], [], 5); // one row of five
  const report = pool.lastRadius()!;
  check(
    report.fired.map((f) => `${f.kind}@${f.index}`).join() ===
      "censer@0,censer@2,halo@4",
    "a Censer sets off a Censer, which sets off a Halo",
  );
  check(
    pool.agg().haloBonus === 3,
    "and the Halo multiplies the one scoring die in its reach",
  );
}
{
  // A loaded Centurion never shows its top face, so a Censer passes it by.
  const loaded = makeDie(
    100,
    { maxFaceBonus: true, loaded: true },
    "centurion",
  );
  const dice = [radius("censer"), loaded];
  rollGrid(dice, [12, 7]);
  check(dice[1].value === 7, "a loaded die is never turned");
}

console.log("Inert dice");
{
  // The inert head is out of reach and never fires.
  const dice = [radius("halo"), plain(6), plain(6)];
  const pool = rollGrid(dice, [8, 1, 1], [], 1, 1);
  check(pool.lastRadius() === null, "an inert Halo does not go off");
}

console.log("Cards");
for (const kind of ["halo", "grace", "censer"] as const) {
  const def = RADIUS_DICE[kind];
  const item = ITEMS.find((it) => it.id === def.source);
  check(item, `${def.name} is a card`);
  const state = newRun();
  state.gold = 1000;
  check(
    applyOffer(state, offerFor(item!.id, state)),
    `${def.name} can be bought`,
  );
  const added = state.dice.dieAt(state.dice.length - 1)!;
  check(
    added.sides === def.sides && dieEffects(added).includes(kind),
    `${def.name} adds a d${def.sides} that wears its effect`,
  );
}

console.log("The move tip");
{
  const state = newRun();
  state.gold = 1000;
  check(!moveTipPending(state), "a plain run owes no move tip");
  applyOffer(state, offerFor("the_halo", state));
  check(moveTipPending(state), "buying a radius die owes it");
  check(pendingGridHints(state).includes("move"), "as the felt's move hint");
  markMoveTipShown(state);
  check(moveTipPending(state), "it stays up for the trial it shows on");
  state.trial += 1;
  check(!moveTipPending(state), "and goes when that trial ends");
  applyOffer(state, offerFor("the_grace", state));
  check(!moveTipPending(state), "never to come back in the run");

  const held = newRun();
  held.gold = 1000;
  applyOffer(held, offerFor("the_censer", held));
  markMoveTipShown(held);
  markMoveTipDone(held);
  check(!moveTipPending(held), "picking a die up takes it off");
  applyOffer(held, offerFor("the_halo", held));
  check(!moveTipPending(held), "for good");

  const plainBuy = newRun();
  plainBuy.gold = 1000;
  const other = ITEMS.find(
    (it) => !it.id.startsWith("the_") && offerFor(it.id, plainBuy),
  );
  if (other) applyOffer(plainBuy, offerFor(other.id, plainBuy));
  check(!moveTipPending(plainBuy), "another card does not owe it");

  const dieanne = newRun([], 0, "dieanne");
  check(
    !moveTipPending(dieanne),
    "Dieanne's lone Grace has nothing to trade places with",
  );
  dieanne.dice.addDice(6, 1);
  check(
    moveTipPending(dieanne),
    "but the tip is owed for it once she has a second die",
  );
}

console.log("The headless player's arrangement");
{
  // Twenty-five dice, the radius dice and a Centurion at the front where they
  // reach least: the bot stands them in the middle, the Centurion beside the
  // Censer.
  const dice: Die[] = [
    radius("censer"),
    radius("halo"),
    makeDie(100, { maxFaceBonus: true }, "centurion"),
    ...Array.from({ length: 22 }, () => plain(6)),
  ];
  const pool = DicePool.fromDice(dice);
  pool.setGridAspect(1);
  arrangeRadiusDice(pool);
  const at = (source: string) => {
    for (let i = 0; i < pool.length; i++)
      if (pool.dieAt(i)!.source === source) return i;
    return -1;
  };
  const censer = at("the_censer");
  const halo = at("the_halo");
  const centurion = at("centurion");
  check(pool.length === 25, "nothing is lost or added");
  check(censer === 12, "the Censer takes the middle of a 5×5 grid");
  check(
    radiusNeighbours(censer, 25, 5).includes(centurion) &&
      radiusNeighbours(censer, 25, 5).includes(halo),
    "with the Centurion and the Halo in its reach",
  );
  check(
    radiusNeighbours(halo, 25, 5).length >= 14,
    "and the Halo where it reaches most of the grid",
  );
}

console.log("Radius dice check: ALL PASS");
