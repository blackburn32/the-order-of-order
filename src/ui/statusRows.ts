import type { RunState } from "../state/RunState";
import {
  extraPointsFor,
  scoringNumbersFor,
  suppresses,
} from "../systems/Afflictions";
import {
  engineGrowthPercent,
  GROWTH_ENGINES,
  growthCounts,
  growthFactorText,
  growthTuning,
  pyrePercent,
  vigilPercent,
  type GrowthEngineDef,
  type GrowthEngineId,
} from "../systems/GrowthEngines";
import { ITEMS, type ShopItemId } from "../systems/Items";
import {
  ASHEN_CROWN_FACES_PER_DOUBLING,
  ASHEN_CROWN_MAX_DOUBLINGS,
  CELL_SEATS,
  DOWNBEAT_INTERVAL,
  DOWNBEAT_MULT,
  GILDED_ALTAR_GOLD_PER_DOUBLING,
  GILDED_ALTAR_MAX_DOUBLINGS,
  GRAVITAS_SIZE_PER_FACTOR,
  solitudePoints,
} from "../systems/Scoring";
import type { NoteTooltipContent } from "./dieTooltip";
import { formatScore } from "./formatScore";
import { formatVigilGrowth, vigilGrowthLog10 } from "./vigilTally";

/** The glyphs a status row may wear; see `drawStatusIcon`. */
export type StatusIcon =
  | "sacred"
  | "bonus"
  | "flat"
  | "rhythm"
  | "bell"
  | "weight"
  | "coin"
  | "endowment"
  | "cell"
  | "candle"
  | "cross"
  | "resonance"
  | "hourglass"
  | "note"
  | "crown"
  | "fire";

/**
 * One line of the game screen's status table: something the run owns whose
 * state the player should be able to read between rolls. The value is short —
 * a number, a list, a multiplier, sometimes a multiplier with a figure in
 * parentheses — and the tooltip is where the nuance goes.
 *
 * Cards that modify one another share a row: The Pyre's row speaks for
 * Embers, Kindling and Everflame too, rather than each taking a line.
 */
export interface StatusRow {
  id: string;
  icon: StatusIcon;
  name: string;
  value: string;
  tooltip: NoteTooltipContent;
}

/** The rows the run's state calls for, Sacred numbers always first; the
 *  rest run from the flat points through the multipliers to the engines. */
export function statusRows(state: RunState): StatusRow[] {
  return [
    sacredRow(state),
    bonusRow(state),
    flatRow(state),
    rhythmRow(state),
    tollRow(state),
    gravitasRow(state),
    altarRow(state),
    cellRow(state),
    vigilRow(state),
    ...GROWTH_ENGINES.filter((def) => def.owns(state)).map((def) =>
      def.id === "pyre" ? pyreRow(state, def) : engineRow(state, def),
    ),
    crownRow(state),
  ].filter((row): row is StatusRow => row !== undefined);
}

// ---- helpers -------------------------------------------------------------------

const ITEM_BY_ID = new Map(ITEMS.map((item) => [item.id, item]));

function itemName(id: ShopItemId): string {
  return ITEM_BY_ID.get(id)?.name ?? id;
}

/** A card's own rule, where it is a fixed sentence. */
function cardRule(id: ShopItemId): string | undefined {
  const desc = ITEM_BY_ID.get(id)?.desc;
  return typeof desc === "string" ? desc : undefined;
}

function plural(n: number, word: string): string {
  return `${formatScore(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** ×2^n, the way the doubling cards print it. */
function doubled(times: number): string {
  return `×${formatScore(2n ** BigInt(Math.max(0, times)))}`;
}

/** A growth engine's whole growth so far, as the factor the cards print. */
function engineGrowth(state: RunState, id: GrowthEngineId) {
  const counts = growthCounts(state, id);
  return {
    grown: formatVigilGrowth(vigilGrowthLog10(counts)),
    rolls: counts.reduce((sum, count) => sum + count, 0),
  };
}

/** What a run's copies of an engine's boost have done to it. */
function boostLine(state: RunState, def: GrowthEngineDef): string | undefined {
  const copies = def.boosts(state);
  if (copies <= 0) return undefined;
  const cap = engineGrowthPercent(def.id, copies);
  return `${itemName(def.boost)} ×${copies}: up to ×${growthFactorText(cap)} a roll.`;
}

function grownLine(grown: string, rolls: number): string {
  return rolls > 0
    ? `Your multiplier has grown ${grown} over ${plural(rolls, "counted roll")}.`
    : "No roll has counted yet.";
}

// ---- rows ----------------------------------------------------------------------

function sacredRow(state: RunState): StatusRow {
  const numbers = scoringNumbersFor(state);
  const silenced = suppresses(state, "extraNumber");
  return {
    id: "sacred",
    icon: "sacred",
    name: "Sacred numbers",
    value: numbers.join(", "),
    tooltip: {
      title: "Sacred numbers",
      lines: [
        "A die scores when it shows one of these faces.",
        ...(silenced
          ? ["The Silence: only 1s score, whatever the Order has decreed."]
          : []),
      ],
    },
  };
}

/** The flat points every scoring die adds (Deeper Stillness, and the cursed
 *  cards that pay the same way). Absent while it is nothing. */
function bonusRow(state: RunState): StatusRow | undefined {
  const extra = extraPointsFor(state);
  if (extra <= 0) return undefined;
  return {
    id: "bonus",
    icon: "bonus",
    name: "Bonus",
    value: `+${extra} per die`,
    tooltip: {
      title: "Bonus points",
      lines: [`Each scoring die grants ${1 + extra} points instead of 1.`],
    },
  };
}

/** Small Mercies and Strength in Numbers: the points every roll pays whatever
 *  the dice do. */
function flatRow(state: RunState): StatusRow | undefined {
  const mercies = 2 * state.pocketChange;
  const numbers = state.dividend * Math.floor(state.dice.length / 3);
  if (state.pocketChange <= 0 && state.dividend <= 0) return undefined;
  const lines: string[] = [];
  if (state.pocketChange > 0)
    lines.push(`${itemName("pocket_change")}: +${mercies} every roll.`);
  if (state.dividend > 0)
    lines.push(
      `${itemName("dividend")}: +${state.dividend} for every 3 dice you hold — +${numbers} with ${plural(state.dice.length, "die")}.`,
    );
  return {
    id: "flat",
    icon: "flat",
    name: "Every roll",
    value: `+${formatScore(mercies + numbers)}`,
    tooltip: {
      title: "Points every roll",
      lines,
      aside: "Paid whatever the dice show.",
    },
  };
}

/** Rhythm: the streak, and what the next scoring roll would pay on it. */
function rhythmRow(state: RunState): StatusRow | undefined {
  if (state.momentum <= 0) return undefined;
  const streak = state.momentumStreak;
  const next = (streak + 1) * 2 * state.momentum;
  return {
    id: "rhythm",
    icon: "rhythm",
    name: itemName("momentum"),
    value: `+${formatScore(next)} (${streak} streak)`,
    tooltip: {
      title: itemName("momentum"),
      lines: [
        `Each scoring roll in a row pays ${2 * state.momentum} more than the last.`,
        `${plural(streak, "scoring roll")} in a row: the next one that scores pays +${formatScore(next)}.`,
        "A roll that scores nothing starts the streak over.",
      ],
    },
  };
}

/** The Toll: how far off its beat is. */
function tollRow(state: RunState): StatusRow | undefined {
  if (state.downbeat <= 0) return undefined;
  // `roll` is the rolls taken this trial; the next is roll + 1, and the beat
  // falls on every DOWNBEAT_INTERVAL-th.
  const away =
    ((DOWNBEAT_INTERVAL - ((state.roll + 1) % DOWNBEAT_INTERVAL)) %
      DOWNBEAT_INTERVAL) +
    1;
  const mult = `×${formatScore(DOWNBEAT_MULT ** BigInt(state.downbeat))}`;
  return {
    id: "toll",
    icon: "bell",
    name: itemName("downbeat").replace(/^The /, ""),
    value: away === 1 ? `${mult} (next roll)` : `${mult} (in ${away})`,
    tooltip: {
      title: itemName("downbeat"),
      lines: [
        `Every ${DOWNBEAT_INTERVAL}th roll of a trial scores ${mult}.`,
        away === 1
          ? "The next roll is on the beat."
          : `The beat falls ${away} rolls from now.`,
      ],
    },
  };
}

/** Gravitas: the grid's mean size, and the factor it makes. */
function gravitasRow(state: RunState): StatusRow | undefined {
  if (state.gravitas <= 0) return undefined;
  const dice = state.dice.length;
  let sides = 0;
  for (const [size, count] of Object.entries(state.dice.sizeCounts()))
    sides += Number(size) * count;
  const mean = dice > 0 ? sides / dice : 0;
  const factor =
    dice > 0 ? Math.floor(sides / (GRAVITAS_SIZE_PER_FACTOR * dice)) : 0;
  const mult =
    factor > 1
      ? `×${formatScore(BigInt(factor) ** BigInt(state.gravitas))}`
      : "×1";
  return {
    id: "gravitas",
    icon: "weight",
    name: itemName("gravitas"),
    value: `${mult} (avg ${Math.floor(mean)})`,
    tooltip: {
      title: itemName("gravitas"),
      lines: [
        `Points ×(average die size ÷ ${GRAVITAS_SIZE_PER_FACTOR}), rounded down${state.gravitas > 1 ? `, once per copy (${state.gravitas})` : ""}.`,
        `Your dice average d${mean.toFixed(1).replace(/\.0$/, "")}.`,
        ...(factor < 2
          ? [
              `It pays once they average d${2 * GRAVITAS_SIZE_PER_FACTOR} or more.`,
            ]
          : []),
      ],
    },
  };
}

/** The Gilded Altar: doublings from the purse, and the gold to the next. */
function altarRow(state: RunState): StatusRow | undefined {
  if (!state.hasGildedAltar) return undefined;
  const per = GILDED_ALTAR_GOLD_PER_DOUBLING;
  const times = Math.min(
    GILDED_ALTAR_MAX_DOUBLINGS,
    Math.floor(state.gold / per),
  );
  const maxed = times >= GILDED_ALTAR_MAX_DOUBLINGS;
  return {
    id: "altar",
    icon: "coin",
    name: "Gilded Altar",
    value: maxed
      ? `${doubled(times)} (max)`
      : `${doubled(times)} (${state.gold}/${(times + 1) * per})`,
    tooltip: {
      title: itemName("gilded_altar"),
      lines: [
        cardRule("gilded_altar") ?? "",
        maxed
          ? "Your purse already pays the most it can."
          : `${(times + 1) * per - state.gold} more gold doubles it again.`,
      ],
      aside: "Spending gold in the shop lowers it.",
    },
  };
}

/** The Cell and Solitude: the empty seats below eight dice, which both read. */
function cellRow(state: RunState): StatusRow | undefined {
  if (!state.hasCell && state.solitude <= 0) return undefined;
  const dice = state.dice.length;
  const seats = Math.max(0, CELL_SEATS - dice);
  const points = solitudePoints(state, dice);
  const lines: string[] = [];
  if (state.hasCell)
    lines.push(
      `${itemName("the_cell")}: points ×2 per empty seat — ${doubled(seats)} now.`,
    );
  if (state.solitude > 0)
    lines.push(
      `${itemName("solitude")}: +${points} every roll from the empty seats.`,
    );
  lines.push(
    seats > 0
      ? `You hold ${plural(dice, "die")}: ${plural(seats, "seat")} of ${CELL_SEATS} empty.`
      : `You hold ${plural(dice, "die")}: every seat is full, so nothing pays.`,
  );
  return {
    id: "cell",
    icon: "cell",
    name: state.hasCell ? "Cell" : itemName("solitude"),
    value: state.hasCell
      ? `${doubled(seats)} (${seats} empty)`
      : `+${points} (${seats} empty)`,
    tooltip: {
      title: state.hasCell ? itemName("the_cell") : itemName("solitude"),
      lines,
    },
  };
}

/** The Vigil: the grid against its limit, and how far the dice have grown. */
function vigilRow(state: RunState): StatusRow | undefined {
  if (!state.hasVigil) return undefined;
  const dice = state.dice.length;
  const limit = growthTuning().vigilGridLimit;
  const awake = dice <= limit;
  // The mean growth across every die, unscored ones at ×1, summed in log
  // space: a long vigil runs past what a float can hold.
  const logs: { log: number; count: number }[] = [];
  let tallied = 0;
  let best = 0;
  for (const stack of state.dice.summarize()) {
    if (!stack.scores || stack.count <= 0) continue;
    const log = vigilGrowthLog10(stack.scores);
    logs.push({ log, count: stack.count });
    tallied += stack.count;
    best = Math.max(best, log);
  }
  if (dice > tallied) logs.push({ log: 0, count: dice - tallied });
  const top = Math.max(0, ...logs.map((entry) => entry.log));
  const sum = logs.reduce((acc, e) => acc + e.count * 10 ** (e.log - top), 0);
  const meanLog = dice > 0 ? top + Math.log10(sum / dice) : 0;
  const mean = formatVigilGrowth(meanLog);

  const lines = [
    cardRule("the_vigil") ?? "",
    `Your dice average ${mean}; the most grown is at ${formatVigilGrowth(best)}.`,
  ];
  if (state.discipline > 0)
    lines.push(
      `${itemName("discipline")} ×${state.discipline}: each score now grows a die ×${growthFactorText(vigilPercent(state))}.`,
    );
  lines.push(
    awake
      ? `You hold ${dice} of ${limit} dice.`
      : `You hold ${dice} dice — over ${limit}, The Vigil sleeps: nothing grows, and grown dice pay nothing extra until you are back to ${limit}.`,
  );
  return {
    id: "vigil",
    icon: "candle",
    name: "Vigil",
    value: awake ? `${mean} (${dice}/${limit})` : `asleep (${dice}/${limit})`,
    tooltip: { title: itemName("the_vigil"), lines },
  };
}

const ENGINE_ICON: Record<GrowthEngineId, StatusIcon> = {
  catechism: "cross",
  resonance: "resonance",
  endowment: "endowment",
  weight: "hourglass",
  plainsong: "note",
  pyre: "fire",
};

/** The cards that change how an engine reads a roll, besides its boost. */
const ENGINE_KIN: Partial<Record<GrowthEngineId, ShopItemId[]>> = {
  weight: ["the_anvil"],
  plainsong: ["antiphon"],
};

/** Every engine but The Pyre: its growth so far, and — The Endowment, whose
 *  input is held between rolls — how full that input is. */
function engineRow(state: RunState, def: GrowthEngineDef): StatusRow {
  const { grown, rolls } = engineGrowth(state, def.id);
  const lines = [cardRule(def.item) ?? "", grownLine(grown, rolls)];
  const boost = boostLine(state, def);
  if (boost) lines.push(boost);
  for (const kin of ENGINE_KIN[def.id] ?? [])
    if (state.ownedUnique.includes(kin))
      lines.push(`${itemName(kin)}: ${cardRule(kin) ?? ""}`);

  let detail = plural(rolls, "roll");
  if (def.id === "endowment") {
    const per = growthTuning().endowmentGoldPerPercent;
    const cap = engineGrowthPercent(def.id, def.boosts(state));
    const next = Math.min(cap, Math.floor(state.gold / per));
    detail = `${state.gold}/${cap * per}`;
    lines.push(
      next > 0
        ? `Holding ${state.gold} gold, the next roll grows it ×${growthFactorText(next)}; ${cap * per} gold grows it the most.`
        : `Hold ${per} gold or more for the next roll to grow it.`,
    );
  }
  return {
    id: def.id,
    icon: ENGINE_ICON[def.id],
    name: def.name.replace(/^The /, ""),
    value: `${grown} (${detail})`,
    tooltip: { title: def.name, lines },
  };
}

/** The Pyre, Embers, Kindling and Everflame in one row: what the fire has
 *  grown so far, and — under Embers — how much is still burning out of the
 *  most one roll can use. */
function pyreRow(state: RunState, def: GrowthEngineDef): StatusRow {
  const { grown, rolls } = engineGrowth(state, "pyre");
  const perPercent = growthTuning().pyreFacesPerPercent;
  const cap = engineGrowthPercent("pyre", def.boosts(state));
  const capFaces = cap * perPercent;
  const faces = state.pyreFaces;

  const lines = [
    rolls > 0
      ? `Your multiplier has grown ${grown} over the ${plural(rolls, "roll")} the fire paid for.`
      : "The fire has not paid for a roll yet.",
    `Faces that burn or shatter feed the fire. After each roll it grows your multiplier ×${growthFactorText(1)} for every ${perPercent} faces, up to ×${growthFactorText(cap)} at ${capFaces} — then it goes out.`,
  ];
  if (state.kindling > 0)
    lines.push(`Kindling: every burned face counts ×${2 ** state.kindling}.`);
  if (state.hasEmbers) {
    const promised = Math.min(cap, pyrePercent(faces));
    lines.push(
      promised > 0
        ? `Embers keep half the fire lit: ${faces} faces now, so the next roll grows at least ×${growthFactorText(promised)}.`
        : `Embers keep half the fire lit: ${plural(faces, "face")} now, ${perPercent - faces} short of the next ×${growthFactorText(1)}.`,
    );
  }

  return {
    id: "pyre",
    icon: "fire",
    name: "Pyre",
    value: grown + (state.hasEmbers ? ` (${faces}/${capFaces})` : ""),
    tooltip: {
      title: "The Pyre",
      lines,
      aside: state.hasEmbers
        ? `(${faces}/${capFaces}) is the fire still burning, out of the most faces one roll can use.`
        : undefined,
    },
  };
}

/** The Ashen Crown: doublings from every face burned this run, and the faces
 *  toward the next. */
function crownRow(state: RunState): StatusRow | undefined {
  if (!state.hasAshenCrown) return undefined;
  const per = ASHEN_CROWN_FACES_PER_DOUBLING;
  const burned = state.facesBurned;
  const times = Math.min(ASHEN_CROWN_MAX_DOUBLINGS, Math.floor(burned / per));
  const maxed = times >= ASHEN_CROWN_MAX_DOUBLINGS;
  const lines = [
    cardRule("the_ashen_crown") ?? "",
    `${plural(burned, "face")} burned or shattered this run.`,
  ];
  if (state.kindling > 0)
    lines.push(`Kindling: every burned face counts ×${2 ** state.kindling}.`);
  return {
    id: "crown",
    icon: "crown",
    name: "Ashen Crown",
    value: maxed
      ? `${doubled(times)} (max)`
      : `${doubled(times)} (${burned - times * per}/${per})`,
    tooltip: { title: itemName("the_ashen_crown"), lines },
  };
}
