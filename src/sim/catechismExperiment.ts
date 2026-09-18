// The strategy trees' engines against the engine-gated goal curve. Matched
// seeds and simulation-only: the candidate curve and every sim switch are
// restored on exit, so nothing here changes a live goal or the live shop.
//
// The candidate curve keeps rank 1's goals, then grows the goal PER ROLL by a
// fixed factor every trial — ×1.6 through rank 3, ×2.2 in ranks 4-6, ×2.4 to the duel —
// and asks each trial for that rate times its own roll budget, which keeps the
// ladder's sawtooth. See systems/ItemTrees for why the engines grow per roll.
//
// Scenarios, each on one seed stream per field:
//   engine-N-P-S  the Lessons shopper with The Catechism in the shop, its growth
//                 per qualifying roll set to N% before Litany (swept; the card
//                 prints 10%), under plan variant P — before, d1s, guard, both
//                 or nolitany (PLANS) — in shop S: today's, or the strategy
//                 trees at ×1 or ×3 odds
//   no-engine[-S] the same shopper and seeds with the engine withheld
//   smart         today's price-and-theme field, engine withheld — whether any
//                 card outside a tree already outruns the curve
//   smart-reworked[-trees3]  the same, with the cards that compound outside the
//                 trees reworked (systems/CardReworks), in today's shop or the
//                 trees at ×3. The engine scenarios all run reworked too. With
//                 the trees on, each smart shopper commits to one tree and opens
//                 it (sim/bot.ts).
//   curious-P     The Gathering's engine: the swarm shopper, committed to its
//                 tree at ×3 odds with the reworks on, The Curious copying a
//                 qualifying die P% of the time (CURIOUS), prototypes withheld —
//                 so without The Multitude
//   curious-P-gG  the same with the grid multipliers' curse charging every goal
//                 ×G per doubling of the grid (GRID_CURSE; 2 is parity, 0
//                 leaves the multipliers uncursed for a baseline)
//   smart-reworked-trees3-gG  the smart field under that curse
//   curious-multitude  The Gathering whole: The Curious and The Multitude
//   resonance · endowment · plainsong · weight · pyre · vigil
//                 each remaining tree's engine, played by its own shopper
//                 (sim/treeShoppers.ts) at ×3 odds with the reworks and every
//                 tree's prototypes in the shop
//   smart-prototypes  the smart field with every tree's cards in the shop
//   skeptic-E     engine E's scenario above (catechism: engine-10-both-trees3;
//                 curious: curious-multitude) with a shopper that buys none of
//                 its tree's cards on faith — only the engine, the boost, and
//                 cards that pay on the next trial (sim/skeptic.ts). The gap
//                 between the two is how much of a tree is bought on trust
//
// Every scenario reports how far grids got: the share of runs (of builders,
// when an engine is measured) whose grid ever held 10k, 100k and 1M dice.
//
// What the design asks of an engine (the bar The Catechism and The Curious
// were accepted at): builders reach the duel ~35-55% of the time, runs without
// it almost never, a finished engine still spends a third or more of a trial's
// rolls in ranks 7-10, and few late trials clear in two rolls or fewer.
//
// Run: npm run engines:experiment           RUNS=600 for tighter numbers
//      SCENARIOS=resonance,pyre             to run a subset
//      GROWTH=10,14                         the Catechism's growth percents (default 10)
//      MIDDLE=2.2 LATE=2.4                  goal growth in ranks 4-6 / 7-10
//      PLANS=before,both                    Lessons plan variants (default both,nolitany)
//      CURIOUS=100,75,50                    The Curious' copy chances to sweep
//      GRID_CURSE=2,1.6                     goal growth per grid doubling to sweep
//      ENDOWMENT_GOLD=5 WEIGHT_DICE=10 PLAINSONG_FREE=5 PYRE_FACES=100
//      VIGIL_GRID=12 RESONANCE_MULTS=2      the engines' input rates
//      CROWN_FACES=50 CROWN_CAP=5           The Ashen Crown's faces per doubling
//                                           and most doublings
//      OFFERING_CHANCE=0.02 OFFERING_GOLD=3 An Offering's burn chance per die per
//                                           roll, and its most gold a roll
//      PERCENT=vigil:8,pyre:12              an engine's growth or cap before its
//                                           boost (The Catechism's is GROWTH)

import {
  engineGateGoals,
  GOAL_GROWTH_PER_TRIAL,
  rankOf,
  setTrialGoals,
  trialGoal,
  WIN_RANK,
  WIN_TRIAL,
} from "../config";
import type { RunState } from "../state/RunState";
import {
  BOOST_MAX_COPIES,
  setEngineGrowthPercentForSimulation,
  setGrowthTuningForSimulation,
  type GrowthEngineId,
  type GrowthTuning,
} from "../systems/GrowthEngines";
import { setOfferingForSimulation, type ShopItemId } from "../systems/Items";
import { ITEM_TREES } from "../systems/ItemTrees";
import {
  setAshenCrownForSimulation,
  setGildedAltarMaxDoublingsForSimulation,
} from "../systems/Scoring";
import {
  setItemTreesForSimulation,
  setPrototypeItemsForSimulation,
} from "../systems/Shop";
import {
  setCardReworksForSimulation,
  setCuriousCopyChanceForSimulation,
  setGridCurseGoalPerDoublingForSimulation,
} from "../systems/CardReworks";
import { simulateRun, type RunRecord, type StrategyName } from "./bot";
import { DEFAULT_CONFIG, UNLOCK_POOLS, type SimConfig } from "./config";
import { installStorage, seedGlobalRandom } from "./localStorageShim";
import { setLessonsPlan, type LessonsPlan } from "./lessons";
import { setSkepticalShoppersForSimulation } from "./skeptic";
import {
  seedOffsetFor,
  seriesConfig,
  seriesSeed,
  SMART_SERIES,
} from "./series";

const RUNS = Math.max(1, Number(process.env.RUNS ?? 300) | 0);

/** Goal growth in ranks 4-6 and 7-10 (config's GOAL_GROWTH_PER_TRIAL), which may be
 *  moved apart from the command line to find which act a tree's builds die in. */
const MIDDLE_GROWTH = Number(
  process.env.MIDDLE ?? GOAL_GROWTH_PER_TRIAL.middle,
);
const LATE_GROWTH = Number(process.env.LATE ?? GOAL_GROWTH_PER_TRIAL.late);

const LIVE_GOALS = Array.from({ length: WIN_TRIAL }, (_, index) =>
  Number(trialGoal(index + 1)),
);

const CANDIDATE_GOALS = engineGateGoals(MIDDLE_GROWTH, LATE_GROWTH);

/** The capped engines' input rates, from the command line. */
function tuningFromEnv(): Partial<GrowthTuning> {
  const read: [string, keyof GrowthTuning][] = [
    ["ENDOWMENT_GOLD", "endowmentGoldPerPercent"],
    ["WEIGHT_DICE", "weightDicePerPercent"],
    ["WEIGHT_FACE", "weightFace"],
    ["PLAINSONG_FREE", "plainsongFreeFaces"],
    ["PYRE_FACES", "pyreFacesPerPercent"],
    ["VIGIL_GRID", "vigilGridLimit"],
    ["RESONANCE_MULTS", "resonanceMultipliers"],
  ];
  const tuning: Partial<GrowthTuning> = {};
  for (const [env, key] of read) {
    const value = Number(process.env[env]);
    if (process.env[env] !== undefined && Number.isFinite(value))
      tuning[key] = value;
  }
  return tuning;
}
const TUNING = tuningFromEnv();

/** The Gilded Altar's most doublings, from the command line (ALTAR_CAP). */
const ALTAR_CAP =
  process.env.ALTAR_CAP !== undefined &&
  Number.isFinite(Number(process.env.ALTAR_CAP))
    ? Number(process.env.ALTAR_CAP)
    : null;

/** The Ashen Crown's figures, from the command line (CROWN_FACES, CROWN_CAP). */
const envNumber = (name: string): number | null =>
  process.env[name] !== undefined && Number.isFinite(Number(process.env[name]))
    ? Number(process.env[name])
    : null;
const CROWN_FACES = envNumber("CROWN_FACES");
const CROWN_CAP = envNumber("CROWN_CAP");
const OFFERING_CHANCE = envNumber("OFFERING_CHANCE");
const OFFERING_GOLD = envNumber("OFFERING_GOLD");
if (OFFERING_CHANCE !== null || OFFERING_GOLD !== null)
  console.log(
    `  an offering burns ${OFFERING_CHANCE ?? "its own"} a die, pays up to ${OFFERING_GOLD ?? "its own"} gold a roll`,
  );
if (CROWN_FACES !== null || CROWN_CAP !== null)
  console.log(
    `  ashen crown ${JSON.stringify({ faces: CROWN_FACES, cap: CROWN_CAP })}`,
  );

/** Engines' growth (or cap) before their boosts, from the command line. The
 *  Catechism's is swept by GROWTH instead, per scenario. */
const PERCENTS: [Exclude<GrowthEngineId, "catechism"> | "vigil", number][] = (
  process.env.PERCENT ?? ""
)
  .split(",")
  .map((pair) => pair.trim().split(":"))
  .filter(
    ([id, value]) =>
      [
        "resonance",
        "endowment",
        "weight",
        "plainsong",
        "pyre",
        "vigil",
      ].includes(id) && Number.isFinite(Number(value)),
  )
  .map(([id, value]) => [
    id as Exclude<GrowthEngineId, "catechism"> | "vigil",
    Number(value),
  ]);

interface Field {
  strategy: StrategyName;
  seedOffset: number;
  config: SimConfig;
}

/** One shopper, fully unlocked, on its own seed stream. */
const fieldFor = (strategy: StrategyName): Field[] => [
  {
    strategy,
    seedOffset: seedOffsetFor(strategy),
    config: {
      ...DEFAULT_CONFIG,
      unlockedAtStart: [...UNLOCK_POOLS.all],
      curseAppetite: 0.5,
    },
  },
];

const LESSONS_FIELD = fieldFor("lessons");

const SMART_FIELD: Field[] = SMART_SERIES.map((series) => ({
  strategy: series.strategy,
  seedOffset: series.seedOffset,
  config: seriesConfig(DEFAULT_CONFIG, series),
}));

/** The swarm shopper alone, for The Gathering's engine. */
const SWARM_FIELD: Field[] = SMART_FIELD.filter(
  (field) => field.strategy === "swarm",
);

/** Which engine a scenario measures. */
type EngineKind =
  | "catechism"
  | "curious"
  | "resonance"
  | "endowment"
  | "plainsong"
  | "weight"
  | "pyre"
  | "vigil";

interface EngineSpec {
  label: string;
  /** The shopper that plays its tree. */
  field: Field[];
  owns(state: RunState): boolean;
  /** Its boost, whose copies the report groups builders by. */
  boost: ShopItemId;
  /** The per-roll growth counts it keeps; null for the two that grow the grid
   *  or its dice instead. */
  growth: GrowthEngineId | null;
}

const ENGINES: Record<EngineKind, EngineSpec> = {
  catechism: {
    label: "The Catechism",
    field: LESSONS_FIELD,
    owns: (state) => state.hasCatechism,
    boost: "litany",
    growth: "catechism",
  },
  curious: {
    label: "The Curious",
    field: SWARM_FIELD,
    owns: (state) => state.hasDoubleTheFun,
    boost: "the_multitude",
    growth: null,
  },
  resonance: {
    label: "The Resonant Hall",
    field: fieldFor("resonance"),
    owns: (state) => state.hasResonantHall,
    boost: "harmonics",
    growth: "resonance",
  },
  endowment: {
    label: "The Endowment",
    field: fieldFor("treasury"),
    owns: (state) => state.hasEndowment,
    boost: "compound_interest",
    growth: "endowment",
  },
  plainsong: {
    label: "Plainsong",
    field: fieldFor("canticle"),
    owns: (state) => state.hasPlainsong,
    boost: "descant",
    growth: "plainsong",
  },
  weight: {
    label: "The Weight of Ages",
    field: fieldFor("weighing"),
    owns: (state) => state.hasWeightOfAges,
    boost: "gravity_well",
    growth: "weight",
  },
  pyre: {
    label: "The Pyre",
    field: fieldFor("pyre"),
    owns: (state) => state.hasPyre,
    boost: "everflame",
    growth: "pyre",
  },
  vigil: {
    label: "The Vigil",
    field: fieldFor("hermitage"),
    owns: (state) => state.hasVigil,
    boost: "discipline",
    growth: null,
  },
};

/** The engines of the trees that have their own shopper. */
const TREE_ENGINES: EngineKind[] = [
  "resonance",
  "endowment",
  "plainsong",
  "weight",
  "pyre",
  "vigil",
];

interface Scenario {
  id: string;
  label: string;
  field: Field[];
  /** The engine whose builders are reported, or null when none is. */
  engine: EngineKind | null;
  goals: number[] | null;
  /** Whether prototypes enter the shop; only The Catechism's scenarios when
   *  absent, which keeps the earlier scenarios' shops as they were measured. */
  prototypes?: boolean;
  /** The Curious' copy chance for a qualifying die; every time when absent. */
  curiousChance?: number;
  /** The goal growth the grid curse charges per doubling; the default (×1.6)
   *  when absent. */
  gridCurse?: number;
  /** The Catechism's growth per qualifying roll, in percent; the card's own
   *  when absent. */
  growthPercent?: number;
  /** Parts of the Lessons plan switched off; the full plan when absent. */
  plan?: Partial<LessonsPlan>;
  /** The trees' odds for an opened card while they are on; today's shop, which
   *  ignores the trees, when absent. */
  trees?: number;
  /** Whether the cards that compound outside the trees are reworked. */
  reworks?: boolean;
  /** Whether the shopper refuses tree cards that do not pay now. */
  skeptical?: boolean;
}

/** Growth percents The Catechism is swept over. The card prints 10%. */
const GROWTH_SWEEP = (process.env.GROWTH ?? "10")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

/** The Curious' copy chances swept, in percent. The card copies every time. */
const CURIOUS_SWEEP = (process.env.CURIOUS ?? "100,75,50")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 100);

/** Goal growth per grid doubling swept for the grid curse. 2 is parity; 0
 *  leaves the grid multipliers uncursed, as today, for a baseline. */
const GRID_CURSE_SWEEP = (process.env.GRID_CURSE ?? "0,2,1.6")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => value === 0 || (Number.isFinite(value) && value >= 1));

/** The Lessons plan variants each growth is measured under: the removal cards
 *  alone, then each of the two later changes on its own, then the full plan with
 *  and without Litany. */
const PLANS: { id: string; label: string; plan: Partial<LessonsPlan> }[] = [
  {
    id: "before",
    label: "removal only",
    plan: {
      buildsPerfectDice: false,
      guardsPerfection: false,
      buysLitany: false,
    },
  },
  {
    id: "d1s",
    label: "+ d1 cards",
    plan: { guardsPerfection: false, buysLitany: false },
  },
  {
    id: "guard",
    label: "+ guarded bot",
    plan: { buildsPerfectDice: false, buysLitany: false },
  },
  {
    id: "nolitany",
    label: "full plan, no Litany",
    plan: { buysLitany: false },
  },
  { id: "both", label: "full plan + Litany", plan: {} },
];

/** Which plan variants to run, by id: the full plan with and without Litany
 *  unless asked otherwise. */
const PLAN_IDS = new Set(
  (process.env.PLANS ?? "both,nolitany").split(",").map((id) => id.trim()),
);

/** The shops each plan is measured in: today's, which ignores the trees; the
 *  trees hiding every card whose parent is not owned, at ordinary odds; and the
 *  trees drawing an opened card three times as often. */
const SHOPS: { id: string; label: string; trees?: number }[] = [
  { id: "shop", label: "today's shop" },
  { id: "trees1", label: "trees ×1", trees: 1 },
  { id: "trees3", label: "trees ×3", trees: 3 },
];

const SCENARIOS: Scenario[] = [
  ...GROWTH_SWEEP.flatMap((growthPercent) =>
    PLANS.filter((variant) => PLAN_IDS.has(variant.id)).flatMap((variant) =>
      SHOPS.map((shop): Scenario => ({
        id: `engine-${growthPercent}-${variant.id}-${shop.id}`,
        label: `Catechism ${growthPercent}%, ${variant.label}, ${shop.label}`,
        field: LESSONS_FIELD,
        engine: "catechism",
        goals: CANDIDATE_GOALS,
        growthPercent,
        plan: variant.plan,
        trees: shop.trees,
        reworks: true,
      })),
    ),
  ),
  ...SHOPS.map((shop): Scenario => ({
    id: shop.trees === undefined ? "no-engine" : `no-engine-${shop.id}`,
    label: `Lessons, no engine, ${shop.label}`,
    field: LESSONS_FIELD,
    engine: null,
    goals: CANDIDATE_GOALS,
    trees: shop.trees,
    reworks: true,
  })),
  {
    id: "smart",
    label: "Smart field",
    field: SMART_FIELD,
    engine: null,
    goals: CANDIDATE_GOALS,
  },
  {
    id: "smart-reworked",
    label: "Smart field, reworked cards",
    field: SMART_FIELD,
    engine: null,
    goals: CANDIDATE_GOALS,
    reworks: true,
  },
  {
    id: "smart-reworked-trees3",
    label: "Smart field, reworked cards, trees ×3",
    field: SMART_FIELD,
    engine: null,
    goals: CANDIDATE_GOALS,
    trees: 3,
    reworks: true,
  },
  ...CURIOUS_SWEEP.map((percent): Scenario => ({
    id: `curious-${percent}`,
    label: `The Curious ${percent}%, swarm, trees ×3`,
    field: SWARM_FIELD,
    engine: "curious",
    goals: CANDIDATE_GOALS,
    curiousChance: percent / 100,
    trees: 3,
    reworks: true,
  })),
  ...GRID_CURSE_SWEEP.flatMap((curse): Scenario[] => [
    {
      id: `smart-reworked-trees3-g${curse}`,
      label: `Smart field, trees ×3, goals ×${curse} per doubling`,
      field: SMART_FIELD,
      engine: null,
      goals: CANDIDATE_GOALS,
      trees: 3,
      reworks: true,
      gridCurse: curse,
    },
    ...CURIOUS_SWEEP.map((percent): Scenario => ({
      id: `curious-${percent}-g${curse}`,
      label: `The Curious ${percent}%, goals ×${curse} per doubling`,
      field: SWARM_FIELD,
      engine: "curious",
      goals: CANDIDATE_GOALS,
      curiousChance: percent / 100,
      trees: 3,
      reworks: true,
      gridCurse: curse,
    })),
  ]),
  {
    id: "curious-multitude",
    label: "The Curious + The Multitude, swarm, trees ×3",
    field: SWARM_FIELD,
    engine: "curious",
    goals: CANDIDATE_GOALS,
    trees: 3,
    reworks: true,
    prototypes: true,
  },
  ...TREE_ENGINES.map((engine): Scenario => ({
    id: engine,
    label: `${ENGINES[engine].label}, its tree's shopper, trees ×3`,
    field: ENGINES[engine].field,
    engine,
    goals: CANDIDATE_GOALS,
    trees: 3,
    reworks: true,
    prototypes: true,
  })),
  ...(Object.keys(ENGINES) as EngineKind[]).map((engine): Scenario => {
    const trusting =
      engine === "catechism"
        ? { field: LESSONS_FIELD, prototypes: false }
        : { field: ENGINES[engine].field, prototypes: true };
    return {
      id: `skeptic-${engine}`,
      label: `${ENGINES[engine].label}, skeptical shopper, trees ×3`,
      engine,
      goals: CANDIDATE_GOALS,
      trees: 3,
      reworks: true,
      skeptical: true,
      ...trusting,
    };
  }),
  {
    id: "smart-prototypes",
    label: "Smart field, trees ×3, every tree's cards",
    field: SMART_FIELD,
    engine: null,
    goals: CANDIDATE_GOALS,
    trees: 3,
    reworks: true,
    prototypes: true,
  },
];

/** What a run's engine did, read at each trial start — after that trial's shop
 *  and before its first roll, the one moment the bot lets a caller look. */
interface EngineTrace {
  /** The first trial entered with the engine owned. */
  boughtFor: number | null;
  /** The last trial the run entered, and by then the rolls the engine counted
   *  (in all, and at each percent) and the copies of its boost owned. */
  lastTrial: number;
  qualified: number;
  countsAt: number[];
  boost: number;
  /** The grid's size entering the first trial with the engine, and the last. */
  diceAtBuild: number;
  diceAtLast: number;
  /** The most dice the grid ever held at a trial start or the run's end. */
  peakDice: number;
}

interface RunResult {
  strategy: StrategyName;
  record: RunRecord;
  trace: EngineTrace;
}

function runScenario(scenario: Scenario): RunResult[] {
  const spec = scenario.engine ? ENGINES[scenario.engine] : null;
  setTrialGoals(scenario.goals);
  setPrototypeItemsForSimulation(
    scenario.prototypes ?? scenario.engine === "catechism",
  );
  setCuriousCopyChanceForSimulation(scenario.curiousChance ?? null);
  setEngineGrowthPercentForSimulation(
    "catechism",
    scenario.growthPercent ?? null,
  );
  setLessonsPlan(scenario.plan);
  setItemTreesForSimulation(scenario.trees ?? false);
  setCardReworksForSimulation(scenario.reworks ?? false);
  setGridCurseGoalPerDoublingForSimulation(scenario.gridCurse ?? null);
  setSkepticalShoppersForSimulation(scenario.skeptical ?? false);
  const results: RunResult[] = [];
  for (const field of scenario.field) {
    seedGlobalRandom(DEFAULT_CONFIG.seed + field.seedOffset);
    installStorage([...field.config.unlockedAtStart]);
    for (let run = 0; run < RUNS; run++) {
      const trace: EngineTrace = {
        boughtFor: null,
        lastTrial: 1,
        qualified: 0,
        countsAt: [],
        boost: 0,
        diceAtBuild: 0,
        diceAtLast: 0,
        peakDice: 0,
      };
      const config: SimConfig = {
        ...field.config,
        onTrialStart: (state: RunState) => {
          if (spec?.owns(state) && trace.boughtFor === null) {
            trace.boughtFor = state.trial;
            trace.diceAtBuild = state.dice.length;
          }
          trace.lastTrial = state.trial;
          trace.diceAtLast = state.dice.length;
          trace.peakDice = Math.max(trace.peakDice, state.dice.length);
          trace.countsAt = spec?.growth
            ? [...(state.growthRollsAt[spec.growth] ?? [])]
            : [];
          trace.qualified = trace.countsAt.reduce((sum, n) => sum + n, 0);
          trace.boost = spec ? (state.purchases[spec.boost] ?? 0) : 0;
        },
      };
      const record = simulateRun(
        field.strategy,
        seriesSeed(DEFAULT_CONFIG.seed, run, field.seedOffset),
        config,
      );
      trace.peakDice = Math.max(trace.peakDice, record.finalDiceTotal);
      results.push({ strategy: field.strategy, record, trace });
    }
  }
  return results;
}

// ---- measures --------------------------------------------------------------

const mean = (values: number[]): number =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : NaN;

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const pct = (value: number): string =>
  Number.isNaN(value) ? "   —" : `${(value * 100).toFixed(0)}%`.padStart(4);

const reachedDuel = (record: RunRecord): boolean =>
  record.trialReached >= WIN_TRIAL;

/** Ranks 1-3, 4-6, 7-10 — the curve's three acts. */
const actOf = (trial: number): number =>
  rankOf(trial) <= 3 ? 0 : rankOf(trial) <= 6 ? 1 : 2;

/** Share of each cleared trial's rolls spent before its goal was crossed, per
 *  act, and the share of rank 7-10 clears that took two rolls or fewer. */
function rollUse(runs: { record: RunRecord; from: number }[]): {
  use: number[];
  quick: number;
} {
  const shares: number[][] = [[], [], []];
  const quick: number[] = [];
  for (const { record, from } of runs) {
    for (const point of record.trajectory) {
      if (!point.cleared || point.trial >= WIN_TRIAL || point.trial < from)
        continue;
      const used = point.clearedOnRoll ?? point.rollsUsed;
      const act = actOf(point.trial);
      shares[act].push(used / Math.max(1, point.rollBudget));
      if (act === 2) quick.push(used <= 2 ? 1 : 0);
    }
  }
  return { use: shares.map(mean), quick: mean(quick) };
}

/** Share of runs that cleared each rank's Boss Trial (rank 10's is the duel). */
function survival(records: RunRecord[]): number[] {
  return Array.from({ length: WIN_RANK }, (_, index) =>
    mean(
      records.map((record) =>
        record.trajectory.some(
          (point) => point.trial === (index + 1) * 3 && point.cleared,
        )
          ? 1
          : 0,
      ),
    ),
  );
}

/** What the engine paid per roll TAKEN once owned. A growth engine: the share
 *  of rolls it counted, and its growth with each counted roll at its own
 *  percent. The Curious: how fast the grid grew, from every source of dice —
 *  the engine's share of it is not separable from a trial-start reading. The
 *  Vigil keeps its counts on the dice, where a trial-start reading cannot sum
 *  them, so it reports neither. */
function engineRate(
  kind: EngineKind,
  results: RunResult[],
): { grewOn: number; perRoll: number } {
  const spec = ENGINES[kind];
  if (kind === "vigil") return { grewOn: NaN, perRoll: NaN };
  let qualified = 0;
  let logGrowth = 0;
  let rolls = 0;
  for (const { record, trace } of results) {
    if (trace.boughtFor === null) continue;
    if (spec.growth === null) {
      logGrowth += Math.log(
        Math.max(1, trace.diceAtLast) / Math.max(1, trace.diceAtBuild),
      );
    } else {
      qualified += trace.qualified;
      trace.countsAt.forEach((count, percent) => {
        logGrowth += count * Math.log1p(percent / 100);
      });
    }
    for (const point of record.trajectory)
      if (point.trial >= trace.boughtFor && point.trial < trace.lastTrial)
        rolls += point.rollsUsed;
  }
  if (rolls === 0) return { grewOn: NaN, perRoll: NaN };
  return {
    grewOn: spec.growth ? qualified / rolls : NaN,
    perRoll: Math.exp(logGrowth / rolls),
  };
}

/** The grid sizes the report counts runs past. */
const GRID_MARKS = [10_000, 100_000, 1_000_000];

const markLabel = (size: number): string =>
  size >= 1_000_000 ? `${size / 1_000_000}M` : `${size / 1_000}k`;

/** The share of these runs whose grid ever held `size` dice. */
const gridReach = (group: RunResult[], size: number): number =>
  mean(group.map((result) => (result.trace.peakDice >= size ? 1 : 0)));

/** The cards that earned these runs' points: each card's mean share of a run's
 *  score, dice and bonus points together, largest first. */
function topEarners(group: RunResult[], count = 8): [string, number][] {
  const shares = new Map<string, number>();
  let runs = 0;
  for (const { record } of group) {
    const entries = [
      ...Object.entries(record.dicePoints),
      ...Object.entries(record.itemPoints),
    ].filter(([, points]) => Number.isFinite(points));
    const total = entries.reduce((sum, [, points]) => sum + points, 0);
    if (!(total > 0) || !Number.isFinite(total)) continue;
    runs += 1;
    for (const [id, points] of entries)
      shares.set(id, (shares.get(id) ?? 0) + points / total);
  }
  return [...shares.entries()]
    .map(([id, sum]): [string, number] => [id, sum / Math.max(1, runs)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);
}

/** The cards these runs bought most: mean copies per run, largest first. */
/** For each tree branch any of these runs bought: the share owning it, and how
 *  often its owners and the rest reached the duel. For an engine's builders,
 *  how often its multipliers and fuel were found, and what finding them did. */
function branchesOwned(
  group: RunResult[],
): { id: string; share: number; duelOwned: number; duelNot: number }[] {
  const duel = (runs: RunResult[]) =>
    runs.filter(({ record }) => reachedDuel(record)).length /
    Math.max(1, runs.length);
  return ITEM_TREES.flatMap((tree) => tree.branches.map((branch) => branch.id))
    .map((id) => {
      const owners = group.filter(
        ({ record }) => (record.purchases[id] ?? 0) > 0,
      );
      const rest = group.filter(({ record }) => !(record.purchases[id] ?? 0));
      return {
        id,
        share: owners.length / Math.max(1, group.length),
        duelOwned: duel(owners),
        duelNot: duel(rest),
      };
    })
    .filter((entry) => entry.share >= 0.2)
    .sort((a, b) => b.share - a.share);
}

function topPurchases(group: RunResult[], count = 14): [string, number][] {
  const copies = new Map<string, number>();
  for (const { record } of group)
    for (const [id, owned] of Object.entries(record.purchases))
      copies.set(id, (copies.get(id) ?? 0) + (owned ?? 0));
  return [...copies.entries()]
    .map(([id, sum]): [string, number] => [id, sum / Math.max(1, group.length)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);
}

/** The tree an engine belongs to, by its engine card. */
const ENGINE_TREE: Record<EngineKind, string> = {
  catechism: "lessons",
  curious: "gathering",
  resonance: "resonance",
  endowment: "treasury",
  plainsong: "canticle",
  weight: "weighing",
  pyre: "pyre",
  vigil: "hermitage",
};

/** Share of ALL runs that bought each card of the engine's chain, root first —
 *  where a chain loses the runs that never commit to it. */
function chainBought(kind: EngineKind, group: RunResult[]): number[] {
  const tree = ITEM_TREES.find((t) => t.id === ENGINE_TREE[kind])!;
  return tree.nodes.map(
    (node) =>
      group.filter(({ record }) => (record.purchases[node.id] ?? 0) > 0)
        .length / Math.max(1, group.length),
  );
}

interface Summary {
  scenario: Scenario;
  /** Share of all runs that bought each chain card, root first. */
  chain: number[];
  /** Share of the measured runs whose grid reached each of GRID_MARKS. */
  grid: number[];
  duel: number;
  win: number;
  built: number;
  duelIfBuilt: number;
  duelIfNot: number;
  grewOn: number;
  perRoll: number;
  /** Builders' share holding each count of the boost at their last trial. */
  boost: number[];
  pacing: { use: number[]; quick: number };
}

function report(
  scenario: Scenario,
  results: RunResult[],
  seconds: number,
): Summary {
  const kind = scenario.engine;
  const spec = kind ? ENGINES[kind] : null;
  const records = results.map((result) => result.record);
  const built = results.filter((result) => result.trace.boughtFor !== null);
  const notBuilt = results.filter((result) => result.trace.boughtFor === null);
  const duelShare = (group: RunResult[]) =>
    mean(group.map((result) => (reachedDuel(result.record) ? 1 : 0)));

  console.log(
    `\n== ${scenario.label} — ${results.length} runs (${seconds.toFixed(1)}s) ==`,
  );
  console.log(
    `  reach duel ${pct(duelShare(results))} · win ${pct(mean(records.map((r) => (r.won ? 1 : 0))))}`,
  );
  const rate = kind ? engineRate(kind, built) : { grewOn: NaN, perRoll: NaN };
  const boostGroups = Array.from({ length: BOOST_MAX_COPIES + 1 }, (_, n) =>
    built.filter(
      (result) => Math.min(BOOST_MAX_COPIES, result.trace.boost) === n,
    ),
  );
  if (spec) {
    const buildRanks = built.map((result) =>
      rankOf(Math.max(1, result.trace.boughtFor! - 1)),
    );
    const tree = ITEM_TREES.find((t) => t.id === ENGINE_TREE[kind!])!;
    console.log(
      "  chain bought (all runs): " +
        chainBought(kind!, results)
          .map((share, index) => `${tree.nodes[index].id} ${pct(share)}`)
          .join(" → "),
    );
    console.log(
      `  engine built ${pct(built.length / results.length)} (median rank ${median(buildRanks)}) · ` +
        `reach duel if built ${pct(duelShare(built))}, if not ${pct(duelShare(notBuilt))}`,
    );
    if (spec.growth) {
      console.log(
        `  engine grew on ${pct(rate.grewOn)} of rolls taken since → ×${rate.perRoll.toFixed(3)} per roll`,
      );
    } else if (!Number.isNaN(rate.perRoll)) {
      console.log(
        `  grid grew ×${rate.perRoll.toFixed(3)} per roll taken since, from every source of dice`,
      );
    }
    console.log(
      `  ${spec.boost} copies at the last trial (builders): ` +
        boostGroups
          .map(
            (group, n) =>
              `${n}: ${pct(group.length / Math.max(1, built.length))} (reach duel ${pct(duelShare(group))})`,
          )
          .join("  "),
    );
    const byRank = new Map<number, RunResult[]>();
    for (const result of built) {
      const rank = rankOf(Math.max(1, result.trace.boughtFor! - 1));
      byRank.set(rank, [...(byRank.get(rank) ?? []), result]);
    }
    console.log(
      "  reach duel by build rank: " +
        [...byRank.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(
            ([rank, group]) =>
              `r${rank} ${pct(duelShare(group))} (n=${group.length})`,
          )
          .join("  "),
    );
  }

  // A builder's pacing counts only the trials it entered with the engine owned:
  // an engine bought in rank 5 says nothing about how ranks 1-4 were played.
  const pacing = rollUse(
    spec
      ? built.map((r) => ({ record: r.record, from: r.trace.boughtFor! }))
      : records.map((record) => ({ record, from: 1 })),
  );
  console.log(
    `  roll use (${spec ? "builders, engine owned" : "all runs"}): r1-3 ${pct(pacing.use[0])} · ` +
      `r4-6 ${pct(pacing.use[1])} · r7-10 ${pct(pacing.use[2])} · ` +
      `r7-10 clears in ≤2 rolls ${pct(pacing.quick)}`,
  );
  const gridGroup = spec ? built : results;
  const grid = GRID_MARKS.map((size) => gridReach(gridGroup, size));
  console.log(
    `  grid reached (${spec ? "builders" : "all runs"}): ` +
      GRID_MARKS.map(
        (size, index) => `${markLabel(size)} ${pct(grid[index])}`,
      ).join(" · ") +
      ` · median at the last trial ${median(gridGroup.map((r) => r.trace.diceAtLast))}` +
      ` (${median(gridGroup.filter((r) => reachedDuel(r.record)).map((r) => r.trace.diceAtLast))} for runs reaching the duel)`,
  );
  console.log(
    `  points by card (${spec ? "builders" : "all runs"}): ` +
      topEarners(gridGroup)
        .map(([id, share]) => `${id} ${pct(share)}`)
        .join(" · "),
  );
  console.log(
    `  branches owned by ≥20% (${spec ? "builders" : "all runs"}; reach duel owned/not): ` +
      branchesOwned(gridGroup)
        .map(
          (entry) =>
            `${entry.id} ${pct(entry.share)} (${pct(entry.duelOwned)}/${pct(entry.duelNot)})`,
        )
        .join(" · "),
  );
  console.log(
    `  cards bought per run (${spec ? "builders" : "all runs"}): ` +
      topPurchases(gridGroup)
        .map(([id, mean]) => `${id} ${mean.toFixed(1)}`)
        .join(" · "),
  );
  if (spec)
    console.log(
      "  cleared rank (builders): " +
        survival(built.map((result) => result.record))
          .map((share, index) => `r${index + 1} ${pct(share)}`)
          .join(" "),
    );
  console.log(
    "  cleared rank: " +
      survival(records)
        .map((share, index) => `r${index + 1} ${pct(share)}`)
        .join(" "),
  );
  if (scenario.field.length > 1) {
    for (const strategy of new Set(results.map((result) => result.strategy))) {
      const group = results.filter((result) => result.strategy === strategy);
      console.log(
        `    ${strategy.padEnd(10)} reach duel ${pct(duelShare(group))} · ` +
          `cleared r6 ${pct(survival(group.map((r) => r.record))[5])} · ` +
          `grid 10k ${pct(gridReach(group, 10_000))}`,
      );
    }
  }

  return {
    scenario,
    chain: kind ? chainBought(kind, results) : [],
    grid,
    duel: duelShare(results),
    win: mean(records.map((record) => (record.won ? 1 : 0))),
    built: built.length / results.length,
    duelIfBuilt: duelShare(built),
    duelIfNot: duelShare(notBuilt),
    grewOn: rate.grewOn,
    perRoll: rate.perRoll,
    boost: boostGroups.map((group) => group.length / Math.max(1, built.length)),
    pacing,
  };
}

// ---- run -------------------------------------------------------------------

const requested = new Set(
  (process.env.SCENARIOS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
const selected = requested.size
  ? SCENARIOS.filter((scenario) => requested.has(scenario.id))
  : SCENARIOS;

console.log(
  `Strategy engines vs the engine-gate curve — ${RUNS} runs per series`,
);
console.log(
  "  goals  " +
    [3, 6, 9, 12, 15, 18, 21, 24, 27, 29]
      .map(
        (trial) =>
          `t${trial} ${CANDIDATE_GOALS[trial - 1].toExponential(1)} (live ${LIVE_GOALS[trial - 1].toExponential(1)})`,
      )
      .join("  "),
);
if (Object.keys(TUNING).length > 0 || PERCENTS.length > 0 || ALTAR_CAP !== null)
  console.log(
    `  engine tuning ${JSON.stringify({ ...TUNING, percents: Object.fromEntries(PERCENTS), altarCap: ALTAR_CAP })}`,
  );

const summaries: Summary[] = [];
try {
  setGrowthTuningForSimulation(TUNING);
  setGildedAltarMaxDoublingsForSimulation(ALTAR_CAP);
  setAshenCrownForSimulation(CROWN_FACES, CROWN_CAP);
  setOfferingForSimulation(OFFERING_CHANCE, OFFERING_GOLD);
  for (const [id, percent] of PERCENTS)
    setEngineGrowthPercentForSimulation(id, percent);
  for (const scenario of selected) {
    const started = Date.now();
    const results = runScenario(scenario);
    summaries.push(report(scenario, results, (Date.now() - started) / 1_000));
  }
} finally {
  setTrialGoals(null);
  setPrototypeItemsForSimulation(false);
  setEngineGrowthPercentForSimulation("catechism", null);
  setGrowthTuningForSimulation(null);
  setGildedAltarMaxDoublingsForSimulation(null);
  setAshenCrownForSimulation(null, null);
  setOfferingForSimulation(null, null);
  for (const [id] of PERCENTS) setEngineGrowthPercentForSimulation(id, null);
  setLessonsPlan();
  setItemTreesForSimulation(null);
  setCardReworksForSimulation(true);
  setCuriousCopyChanceForSimulation(null);
  setGridCurseGoalPerDoublingForSimulation(null);
  setSkepticalShoppersForSimulation(false);
}

const swept = summaries.filter((summary) => summary.scenario.engine);
if (swept.length > 1) {
  console.log("\n== Summary — every engine scenario ==");
  console.log(
    `${"scenario".padEnd(54)} t1   t2   built  duel|built  duel|not  grows on  ×/roll  max boost  use r4-6  use r7-10  ≤2 rolls  win   10k+  1M+`,
  );
  for (const summary of swept) {
    console.log(
      `${summary.scenario.label.padEnd(54)} ${pct(summary.chain[0])} ${pct(summary.chain[1])} ${pct(summary.built)}   ${pct(summary.duelIfBuilt)}        ` +
        `${pct(summary.duelIfNot)}      ${pct(summary.grewOn)}     ` +
        `${Number.isNaN(summary.perRoll) ? "    —" : summary.perRoll.toFixed(3)}   ${pct(summary.boost[BOOST_MAX_COPIES])}       ` +
        `${pct(summary.pacing.use[1])}      ${pct(summary.pacing.use[2])}       ` +
        `${pct(summary.pacing.quick)}      ${pct(summary.win)}  ` +
        `${pct(summary.grid[0])}  ${pct(summary.grid[2])}`,
    );
  }
}
