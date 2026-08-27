// Gold — the shop currency.
//
// Gold is deliberately NOT the score. Score is progress toward the current
// trial's goal and resets to 0 every trial; gold is a small, slow-growing purse
// that persists across the whole run and is the only thing the shop takes. That
// split is why `RunState.gold` is a plain `number` while every score field is a
// `bigint`: gold lives in the single and low double digits by design, and if it
// ever needs bigint the economy has already gone wrong.
//
// Earned in two places:
//   • On clearing a trial — `trialPayout`, from the trial's level, the rolls
//     left in hand, interest on what is already banked, and gold items.
//   • During a trial — `rollGold`, from Tithe Bowl and Lucky Coin.

import { isBossTrial, trialInRank } from "../config";
import type { RunState } from "../state/RunState";
import { afflictionsFor } from "./Afflictions";
import { bossGoldMultMilli } from "./Boss";
import { trialRollTarget } from "./Trial";

/** Base payout for clearing each trial in a rank, by `trialInRank() - 1`. */
export const TRIAL_GOLD_BASE = [3, 4, 6];

/** Gold per roll still in hand when the goal was met. */
export const GOLD_PER_UNUSED_ROLL = 1;
/** At most this many unused rolls are paid for, so a runaway build that clears
 *  the Greater Trial on roll 2 does not out-earn the whole rest of the economy. */
export const UNUSED_ROLL_GOLD_CAP = 5;

/** Interest pays 1 gold per this much banked, at every trial clear. */
export const GOLD_PER_INTEREST = 5;
export const INTEREST_CAP = 5;
/** Vault raises the interest cap, making banking worth more than spending. */
export const VAULT_INTEREST_CAP = 10;

export const STARTING_GOLD = 4;

/** Extra gold for clearing a Boss Trial, alongside the boosted shop odds. */
export const BOSS_CLEAR_GOLD = 2;

/** Prospector: 1 gold per this many dice held at the clear, up to its own cap. */
export const PROSPECTOR_DICE_PER_GOLD = 25;
export const PROSPECTOR_CAP = 5;

/** Reliquary's share of every trial payout. A percentage rather than the flat
 *  three gold it used to pay on Boss Trials only: a fixed sum in a purse that
 *  grows all run stops being felt, where a share of it never does. Interest is
 *  excluded for the same reason The Hoard excludes it — it is earned on the
 *  bank, not on the trial. */
export const RELIQUARY_BONUS_PERCENT = 25;
const RELIQUARY_MULT_MILLI = 1_000 + RELIQUARY_BONUS_PERCENT * 10;

/** Lucky Coin's per-copy chance, each roll, of turning up a gold piece. */
export const LUCKY_COIN_CHANCE = 0.1;

export interface GoldBreakdown {
  /** The trial's level payout. */
  base: number;
  /** Rolls left in hand when the goal was met (plus Reserve). */
  rolls: number;
  /** Interest on gold already banked. */
  interest: number;
  /** Gold items that pay out on a clear. */
  items: number;
  total: number;
}

export const EMPTY_BREAKDOWN: GoldBreakdown = {
  base: 0,
  rolls: 0,
  interest: 0,
  items: 0,
  total: 0,
};

/** How much banked gold earns interest before the cap bites. */
export function interestCap(state: RunState): number {
  return state.hasVault ? VAULT_INTEREST_CAP : INTEREST_CAP;
}

export function interestOn(state: RunState): number {
  return Math.min(
    interestCap(state),
    Math.floor(state.gold / GOLD_PER_INTEREST),
  );
}

/** Rolls the player did not need. Uses the trial's own budget including
 *  Metronome/Overtime and any boss roll delta, so "cleared with rolls to
 *  spare" means the same thing on every trial. */
export function unusedRolls(state: RunState): number {
  return Math.max(0, trialRollTarget(state) - state.roll);
}

/**
 * The gold a cleared trial pays, itemised for the payout banner. Call only for
 * a trial the player actually cleared — a failed trial pays nothing.
 *
 * The Hoard's doubling applies to the trial's own payout (level, rolls, items)
 * but not to interest, which is earned on the bank rather than on the trial.
 */
export function trialPayout(state: RunState): GoldBreakdown {
  const base = TRIAL_GOLD_BASE[trialInRank(state.trial) - 1];

  // Reserve adds to the per-roll rate rather than the cap, so it stays useful
  // on a trial cleared with only a roll or two to spare.
  const paidRolls = Math.min(unusedRolls(state), UNUSED_ROLL_GOLD_CAP);
  const rolls = paidRolls * (GOLD_PER_UNUSED_ROLL + state.reserve);

  let items = state.countingHouse;
  if (state.hasProspector) {
    items += Math.min(
      PROSPECTOR_CAP,
      Math.floor(state.dice.length / PROSPECTOR_DICE_PER_GOLD),
    );
  }
  if (isBossTrial(state.trial)) items += BOSS_CLEAR_GOLD;

  // The Hoard's doubling, Reliquary's share, and any affliction that garnishes
  // a clear (Iron Debt pays none of it) all meet in one per-mille factor.
  let multMilli = bossGoldMultMilli(state);
  if (state.hasReliquary)
    multMilli = Math.floor((multMilli * RELIQUARY_MULT_MILLI) / 1_000);
  multMilli = Math.floor(
    (multMilli * afflictionsFor(state).clearGoldMultMilli) / 1_000,
  );
  const scale = (n: number) => Math.floor((n * multMilli) / 1000);

  const scaled = {
    base: scale(base),
    rolls: scale(rolls),
    items: scale(items),
    interest: interestOn(state),
  };

  return {
    ...scaled,
    total: scaled.base + scaled.rolls + scaled.items + scaled.interest,
  };
}

/**
 * Gold earned during a roll, from the two mid-trial gold items. `scored` is
 * whether the roll put any points on the board — Tithe Bowl pays for the rolls
 * that did not.
 */
export function rollGold(
  state: RunState,
  scored: boolean,
  rng: () => number = Math.random,
): number {
  return rollGoldBreakdown(state, scored, rng).total;
}

/** Source-level version used by the live engine so the Results screen can
 * explain gold earned during rolls. `rollGold` stays as the compact numeric API
 * used by checks and callers that only need the total. */
export function rollGoldBreakdown(
  state: RunState,
  scored: boolean,
  rng: () => number = Math.random,
): { titheBowl: number; luckyCoin: number; total: number } {
  const titheBowl = scored ? 0 : state.titheBowl;
  let luckyCoin = 0;
  for (let c = 0; c < state.luckyCoin; c++) {
    if (rng() < LUCKY_COIN_CHANCE) luckyCoin += 1;
  }
  return { titheBowl, luckyCoin, total: titheBowl + luckyCoin };
}

/**
 * Take back whatever a standing affliction will not let the run carry out of a
 * trial (Pauper's Vow leaves seven). Called as a trial ends, after its payout
 * has been banked, so the ceiling is what the player walks into the shop with —
 * and returns the gold lost, which the results receipt reports.
 */
export function applyGoldCeiling(state: RunState): number {
  const ceiling = afflictionsFor(state).goldCeiling;
  if (!Number.isFinite(ceiling) || state.gold <= ceiling) return 0;
  const lost = state.gold - ceiling;
  state.gold = ceiling;
  return lost;
}

/** Bank gold on the run, keeping the lifetime and peak tallies in step. The
 *  peak drives the `goldHeld` unlock criterion, which would otherwise be
 *  unreachable for a player who spends everything the moment they earn it. */
export function grantGold(state: RunState, amount: number): void {
  if (amount <= 0) return;
  state.gold += amount;
  state.goldEarned += amount;
  if (state.gold > state.peakGold) state.peakGold = state.gold;
}
