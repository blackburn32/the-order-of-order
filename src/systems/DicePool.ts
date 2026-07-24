// The dice grid's storage layer, sized to stay cheap at any count.
//
// Below BUCKET_THRESHOLD the pool is backed by an explicit `Die[]` — full per-die
// identity, so the scene can flash individual dice and the shop can target one.
// At/above the threshold it flips (permanently, since dice only ever grow) to
// *buckets* of identical dice keyed by their attributes, holding just a count.
// A run with a million dice still has only a few dozen buckets, so rolling,
// scoring, growth, and serialization all become O(buckets × faces) instead of
// O(dice). Consumers go through this API and never branch on the mode themselves.

import { DiceAgg, sampleFaceCounts } from "./ScoringHistogram";
import {
  canShrink,
  cloneDie,
  Die,
  DIE_LADDER,
  DieOpts,
  DieSides,
  makeDie,
  rollDie,
  windfallFactor,
} from "./Dice";

/** Dice count at which the pool switches from per-die to bucketed storage. Below
 *  this the per-die path is as fast and keeps full fidelity (flashing, targeting);
 *  above it the linear costs start to bite (see src/sim/compareScoring.ts). */
export const BUCKET_THRESHOLD = 2000;

// The live threshold, overridable for tests/tuning (see setBucketThreshold). A
// very large value forces per-die mode everywhere, which the parity harness uses
// to check that bucketed rolls match the per-die path.
let bucketThreshold = BUCKET_THRESHOLD;
export function setBucketThreshold(n: number): void {
  bucketThreshold = n;
}
export function getBucketThreshold(): number {
  return bucketThreshold;
}

/** A group of identical dice. `lastFaces[v-1]` holds how many of this bucket's
 *  dice showed face value `v` on the most recent roll (undefined before any roll);
 *  `lastScoring` caches how many of them scored, for Genesis. */
interface Bucket {
  sides: DieSides;
  maxFaceBonus: number;
  loaded: boolean;
  wildFace: boolean;
  source: string;
  count: number;
  lastFaces?: number[];
  lastScoring?: number;
  shuffleSeed?: number;
}

/** Everything a roll produces that scoring and attribution need, independent of
 *  how the dice were stored. */
interface RollData {
  agg: DiceAgg;
  scoringBySource: Map<string, number>; // scoring dice this roll, credited to their die's source
  windfallTriggers: Map<number, bigint>; // persistent factor -> factor, for each
  // Rollplayer/Centurion effect that hit (drives per-item attribution)
}

/** A die's storable attributes (no rolled value), for save summaries. */
export interface DiceStack {
  sides: DieSides;
  maxFaceBonus: number;
  loaded: boolean;
  wildFace: boolean;
  source: string;
  count: number;
}

/** Counts shown by a spatial summary card. Special counts deliberately overlap
 *  the side counts and each other: a wild loaded d6 contributes to all three. */
export interface DiceRegionSummary {
  total: number;
  bySides: Record<number, number>;
  representatives: Record<number, Die>;
  maxFaceBonus: number;
  loaded: number;
  wildFace: number;
}

export interface DiceGridRegion {
  cols: number;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

function bucketKey(
  sides: number,
  maxFaceBonus: number,
  loaded: boolean,
  wildFace: boolean,
  source: string,
): string {
  return `${sides}|${maxFaceBonus}|${loaded ? 1 : 0}|${wildFace ? 1 : 0}|${source}`;
}

function facesOf(sides: number, loaded: boolean): number {
  return loaded ? Math.max(1, sides - 2) : sides;
}

/**
 * Permute [0, count) without collisions. Cycle-walking an invertible bit-mix
 * keeps the sampled face histogram exact while making adjacent grid offsets
 * land at well-separated positions within its face-count runs.
 */
function shuffledOffset(offset: number, count: number, seed: number): number {
  if (count <= 1) return 0;
  const bits = Math.ceil(Math.log2(count));
  // Current run caps are far below this, but retain a safe fallback if a custom
  // game ever grows beyond the range supported by 31-bit bitwise arithmetic.
  if (bits > 31) {
    const modulus = BigInt(count);
    const gcd = (a: bigint, b: bigint): bigint => {
      while (b !== 0n) [a, b] = [b, a % b];
      return a;
    };
    let multiplier = BigInt((seed | 1) >>> 0);
    while (gcd(multiplier, modulus) !== 1n) multiplier += 2n;
    const shift = BigInt(seed >>> 0);
    return Number((BigInt(offset) * multiplier + shift) % modulus);
  }

  const mask = bits === 31 ? 0x7fffffff : 2 ** bits - 1;
  const halfShift = Math.max(1, Math.floor(bits / 2));
  const thirdShift = Math.max(1, Math.floor(bits / 3));
  let value = offset & mask;
  do {
    value ^= seed & mask;
    value = Math.imul(value, 0x9e3779b1) & mask;
    value ^= value >>> halfShift;
    value = Math.imul(value, 0x85ebca6b) & mask;
    value ^= value >>> thirdShift;
    value &= mask;
  } while (value >= count);
  return value;
}

export class DicePool {
  private mode: "list" | "bucket" = "list";
  private list: Die[] = [];
  private buckets: Bucket[] = [];
  private _count = 0;
  private roll_?: RollData; // cached result of the most recent roll()
  private rolledCount = 0; // grid size at the last roll, so growth passives only
  // clone dice that were present then (not each other)
  private lastScoringNumbers: number[] = [];
  private rollVersion = 0;

  private constructor() {}

  /** A fresh pool holding the given starter dice (per-die mode). */
  static fromDice(dice: Die[]): DicePool {
    const p = new DicePool();
    p.list = dice;
    p._count = dice.length;
    p.ensureMode();
    return p;
  }

  /** Rebuild a pool from a saved bucket summary (already bucketed). */
  static fromStacks(stacks: DiceStack[]): DicePool {
    const p = new DicePool();
    p.buckets = stacks.map((s) => ({
      ...s,
      maxFaceBonus: windfallFactor(s.maxFaceBonus as number | boolean, s.sides),
    }));
    p._count = stacks.reduce((n, s) => n + s.count, 0);
    p.mode = p._count >= bucketThreshold ? "bucket" : "list";
    if (p.mode === "list") {
      // Small enough to materialise for full fidelity.
      p.list = [];
      for (const s of p.buckets)
        for (let i = 0; i < s.count; i++)
          p.list.push(
            makeDie(
              s.sides,
              {
                maxFaceBonus: s.maxFaceBonus,
                loaded: s.loaded,
                wildFace: s.wildFace,
              },
              s.source,
            ),
          );
      p.buckets = [];
    }
    return p;
  }

  get length(): number {
    return this._count;
  }

  get bucketed(): boolean {
    return this.mode === "bucket";
  }

  // --- transition ----------------------------------------------------------

  /** Flip to bucket storage once the grid is large enough. One-way: dice only
   *  grow past the threshold, and a rare Whetstone shrink never drops the count. */
  private ensureMode(): void {
    if (this.mode === "list" && this._count >= bucketThreshold) this.convert();
  }

  /** Collapse the current per-die list into buckets unconditionally. Callers use
   *  this before a bulk add whose size would otherwise materialise a huge array. */
  private convert(): void {
    if (this.mode === "bucket") return;
    const map = new Map<string, Bucket>();
    for (const d of this.list) {
      const key = bucketKey(
        d.sides,
        d.maxFaceBonus,
        d.loaded,
        d.wildFace,
        d.source,
      );
      const b = map.get(key);
      if (b) b.count += 1;
      else
        map.set(key, {
          sides: d.sides,
          maxFaceBonus: d.maxFaceBonus,
          loaded: d.loaded,
          wildFace: d.wildFace,
          source: d.source,
          count: 1,
        });
    }
    this.buckets = [...map.values()];
    this.list = [];
    this.mode = "bucket";
  }

  private addBucket(
    sides: DieSides,
    maxFaceBonus: number,
    loaded: boolean,
    wildFace: boolean,
    source: string,
    count: number,
  ): void {
    if (count <= 0) return;
    const key = bucketKey(sides, maxFaceBonus, loaded, wildFace, source);
    const b = this.buckets.find(
      (x) =>
        bucketKey(x.sides, x.maxFaceBonus, x.loaded, x.wildFace, x.source) ===
        key,
    );
    if (b) b.count += count;
    else
      this.buckets.push({
        sides,
        maxFaceBonus,
        loaded,
        wildFace,
        source,
        count,
      });
  }

  // --- rolling -------------------------------------------------------------

  /** Roll every die (per-die) or sample each bucket's face histogram (bucketed),
   *  caching the aggregate scoring view + per-source tallies. Call once per turn
   *  before scoring; scoreRollHistogram then reads `agg()`. */
  roll(
    rng: () => number,
    scoringNumbers: number[],
    royalSealSizes: readonly DieSides[] = [],
  ): void {
    this.rollVersion += 1;
    this.lastScoringNumbers = scoringNumbers;
    this.rolledCount = this._count;
    const scoring = new Set(scoringNumbers);
    const sealed = new Set<DieSides>(royalSealSizes);
    const valueCounts = new Map<number, number>();
    const scoringBySource = new Map<string, number>();
    const windfallFactors = new Set<number>();
    const allSizes = new Set<number>();
    const scoringSizes = new Set<number>();
    let scoringCount = 0;
    let scoringD1Count = 0;
    let extraNumberScoringCount = 0;
    let wildFaceScoringCount = 0;
    let royalSealScoringCount = 0;
    let windfallScoringCount = 0;

    if (this.mode === "list") {
      for (const die of this.list) {
        rollDie(die, rng);
        allSizes.add(die.sides);
        valueCounts.set(die.value, (valueCounts.get(die.value) ?? 0) + 1);
        const windfallHit =
          die.maxFaceBonus > 0 && !die.loaded && die.value === die.sides;
        const royalSealHit =
          sealed.has(die.sides) && die.value === die.sides;
        const numberScores = scoring.has(die.value);
        if (numberScores || die.wildFace || windfallHit || royalSealHit) {
          scoringCount += 1;
          scoringSizes.add(die.sides);
          if (die.sides === 1) scoringD1Count += 1;
          if (numberScores && die.value !== 1) extraNumberScoringCount += 1;
          else if (!numberScores && die.wildFace) wildFaceScoringCount += 1;
          else if (!numberScores && !die.wildFace && windfallHit)
            windfallScoringCount += 1;
          else if (
            !numberScores &&
            !die.wildFace &&
            !windfallHit &&
            royalSealHit
          )
            royalSealScoringCount += 1;
          scoringBySource.set(
            die.source,
            (scoringBySource.get(die.source) ?? 0) + 1,
          );
        }
        if (windfallHit) windfallFactors.add(die.maxFaceBonus);
      }
    } else {
      for (
        let bucketIndex = 0;
        bucketIndex < this.buckets.length;
        bucketIndex++
      ) {
        const b = this.buckets[bucketIndex];
        allSizes.add(b.sides);
        const faces = facesOf(b.sides, b.loaded);
        const faceCounts = sampleFaceCounts(b.count, faces, rng);
        b.lastFaces = faceCounts;
        b.shuffleSeed =
          Math.imul(this.rollVersion, 0x9e3779b1) ^
          Math.imul(bucketIndex + 1, 0x85ebca6b) ^
          Math.imul(b.sides, 0xc2b2ae35);
        let bucketScoring = 0;
        for (let v = 1; v <= faces; v++) {
          const c = faceCounts[v - 1];
          if (c === 0) continue;
          valueCounts.set(v, (valueCounts.get(v) ?? 0) + c);
          const windfallHit = b.maxFaceBonus > 0 && !b.loaded && v === b.sides;
          const royalSealHit = sealed.has(b.sides) && v === b.sides;
          const numberScores = scoring.has(v);
          if (numberScores || b.wildFace || windfallHit || royalSealHit) {
            bucketScoring += c;
            scoringSizes.add(b.sides);
            if (b.sides === 1) scoringD1Count += c;
            if (numberScores && v !== 1) extraNumberScoringCount += c;
            else if (!numberScores && b.wildFace) wildFaceScoringCount += c;
            else if (!numberScores && !b.wildFace && windfallHit)
              windfallScoringCount += c;
            else if (
              !numberScores &&
              !b.wildFace &&
              !windfallHit &&
              royalSealHit
            )
              royalSealScoringCount += c;
          }
          if (windfallHit) windfallFactors.add(b.maxFaceBonus);
        }
        b.lastScoring = bucketScoring;
        scoringCount += bucketScoring;
        if (bucketScoring > 0)
          scoringBySource.set(
            b.source,
            (scoringBySource.get(b.source) ?? 0) + bucketScoring,
          );
      }
    }

    let windfallMult = 1n;
    const windfallTriggers = new Map<number, bigint>();
    for (const factor of windfallFactors) {
      const bigintFactor = BigInt(factor);
      windfallMult *= bigintFactor;
      windfallTriggers.set(factor, bigintFactor);
    }

    this.roll_ = {
      agg: {
        total: this._count,
        valueCounts,
        scoringCount,
        scoringD1Count,
        extraNumberScoringCount,
        wildFaceScoringCount,
        royalSealScoringCount,
        windfallScoringCount,
        allSizes,
        scoringSizes,
        windfallMult,
      },
      scoringBySource,
      windfallTriggers,
    };
  }

  /** The most recent roll's aggregate scoring view. Throws if not yet rolled. */
  agg(): DiceAgg {
    if (!this.roll_) throw new Error("DicePool.agg() called before roll()");
    return this.roll_.agg;
  }

  scoringBySource(): Map<string, number> {
    return this.roll_?.scoringBySource ?? new Map();
  }

  /** Persistent windfall factors that triggered on the last roll (factor ->
   *  factor), for crediting the multiplier to Rollplayer / Centurion. */
  windfallTriggers(): Map<number, bigint> {
    return this.roll_?.windfallTriggers ?? new Map();
  }

  /** Largest number of dice that showed the same face on the last roll (drives
   *  the sameFaceCount unlock). 0 before any roll. */
  maxSameFace(): number {
    let m = 0;
    for (const c of this.roll_?.agg.valueCounts.values() ?? [])
      if (c > m) m = c;
    return m;
  }

  // --- growth (engine passives) -------------------------------------------

  /** Double the Fun: every die that rolled a 5 or 6 spawns a copy of itself.
   *  Returns the number of dice added. Uses the cached roll. */
  doubleTheFun(): number {
    if (this.mode === "list") {
      const copies: Die[] = [];
      for (let k = 0; k < this.rolledCount; k++) {
        const d = this.list[k];
        if (d.value === 5 || d.value === 6)
          copies.push(cloneDie(d, "double_the_fun"));
      }
      for (const d of copies) this.list.push(d);
      this._count += copies.length;
      this.ensureMode();
      return copies.length;
    }
    let added = 0;
    const snapshot = [...this.buckets]; // adding new buckets below; iterate the originals
    for (const b of snapshot) {
      const faces = facesOf(b.sides, b.loaded);
      if (!b.lastFaces) continue;
      const high =
        (faces >= 5 ? (b.lastFaces[4] ?? 0) : 0) +
        (faces >= 6 ? (b.lastFaces[5] ?? 0) : 0);
      if (high > 0) {
        this.addBucket(
          b.sides,
          b.maxFaceBonus,
          b.loaded,
          b.wildFace,
          "double_the_fun",
          high,
        );
        added += high;
      }
    }
    this._count += added;
    return added;
  }

  /** Genesis: each scoring die spawns a copy, capped at `cap` dice total this
   *  roll. Returns the number added. Uses the cached roll. */
  genesis(cap: number): number {
    if (cap <= 0) return 0;
    if (this.mode === "list") {
      // List mode retains rolled values, so recover the scoring dice directly.
      // Bounded to the rolled originals so spawned copies never re-spawn.
      const copies: Die[] = [];
      for (let k = 0; k < this.rolledCount && copies.length < cap; k++) {
        const d = this.list[k];
        if (this.dieScored(d)) copies.push(cloneDie(d, "genesis"));
      }
      for (const d of copies) this.list.push(d);
      this._count += copies.length;
      this.ensureMode();
      return copies.length;
    }
    let remaining = cap;
    let added = 0;
    const snapshot = [...this.buckets];
    for (const b of snapshot) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, b.lastScoring ?? 0);
      if (take > 0) {
        this.addBucket(
          b.sides,
          b.maxFaceBonus,
          b.loaded,
          b.wildFace,
          "genesis",
          take,
        );
        remaining -= take;
        added += take;
      }
    }
    this._count += added;
    return added;
  }

  private dieScored(d: Die): boolean {
    // Only valid immediately after a list-mode roll. scoringNumbers captured then.
    return (
      this.lastScoringNumbers.includes(d.value) ||
      d.wildFace ||
      (d.maxFaceBonus > 0 && !d.loaded && d.value === d.sides)
    );
  }

  /** Foundry: at round start, add `perCopy` copies of the smallest die. Returns
   *  the number added. */
  foundry(perCopy: number): number {
    if (perCopy <= 0 || this._count === 0) return 0;
    if (this.mode === "list") {
      const smallest = this.list.reduce((m, d) => (d.sides < m.sides ? d : m));
      const copies: Die[] = [];
      for (let i = 0; i < perCopy; i++)
        copies.push(cloneDie(smallest, "foundry"));
      for (const d of copies) this.list.push(d);
      this._count += copies.length;
      this.ensureMode();
      return copies.length;
    }
    const smallest = this.buckets.reduce((m, b) => (b.sides < m.sides ? b : m));
    this.addBucket(
      smallest.sides,
      smallest.maxFaceBonus,
      smallest.loaded,
      smallest.wildFace,
      "foundry",
      perCopy,
    );
    this._count += perCopy;
    return perCopy;
  }

  /** Whetstone: shrink one random shrinkable die a step. Returns the grid index
   *  shrunk (for flashing) in list mode, or -1 in bucket mode (no single die to
   *  flash). Returns null when nothing was shrinkable. */
  whetstoneShrink(rng: () => number): number | null {
    if (this.mode === "list") {
      const shrinkable = this.list
        .map((d, i) => ({ d, i }))
        .filter((e) => canShrink(e.d));
      if (shrinkable.length === 0) return null;
      const picked = shrinkable[Math.floor(rng() * shrinkable.length)];
      this.stepDown(picked.d);
      return picked.i;
    }
    const shrinkableTotal = this.buckets.reduce(
      (n, b) => (b.sides > 1 ? n + b.count : n),
      0,
    );
    if (shrinkableTotal === 0) return null;
    let target = Math.floor(rng() * shrinkableTotal);
    for (const b of this.buckets) {
      if (b.sides <= 1) continue;
      if (target < b.count) {
        this.shrinkOneFromBucket(b);
        return -1;
      }
      target -= b.count;
    }
    return -1;
  }

  private stepDown(die: Die): void {
    const i = DIE_LADDER.indexOf(die.sides);
    if (i > 0) {
      die.sides = DIE_LADDER[i - 1];
      die.value = die.sides;
    }
  }

  private shrinkOneFromBucket(b: Bucket): void {
    const i = DIE_LADDER.indexOf(b.sides);
    if (i <= 0) return;
    b.count -= 1;
    this.addBucket(
      DIE_LADDER[i - 1],
      b.maxFaceBonus,
      b.loaded,
      b.wildFace,
      b.source,
      1,
    );
    this.pruneEmpty();
  }

  private pruneEmpty(): void {
    if (this.buckets.some((b) => b.count <= 0))
      this.buckets = this.buckets.filter((b) => b.count > 0);
  }

  // --- shop effects --------------------------------------------------------

  /** Add `count` dice of a size. */
  addDice(
    sides: DieSides,
    count: number,
    opts: DieOpts = {},
    source = "starter",
  ): void {
    if (count <= 0) return;
    // A bulk add that will cross the threshold converts first, so we never
    // materialise the (possibly enormous) new dice as individual objects.
    if (this.mode === "list" && this._count + count < bucketThreshold) {
      for (let i = 0; i < count; i++)
        this.list.push(makeDie(sides, opts, source));
      this._count += count;
      return;
    }
    this.convert();
    this.addBucket(
      sides,
      windfallFactor(opts.maxFaceBonus, sides),
      opts.loaded ?? false,
      opts.wildFace ?? false,
      source,
      count,
    );
    this._count += count;
  }

  /** Duplicate the whole grid `factor`× (Multiply Dice). */
  multiply(factor: number, source: string): void {
    if (factor <= 1) return;
    if (this.mode === "list" && this._count * factor < bucketThreshold) {
      const originals = this.list;
      const copies: Die[] = [];
      for (let f = 1; f < factor; f++)
        for (const d of originals) copies.push(cloneDie(d, source));
      for (const d of copies) this.list.push(d);
      this._count += copies.length;
      return;
    }
    this.convert();
    const snapshot = [...this.buckets];
    for (const b of snapshot)
      this.addBucket(
        b.sides,
        b.maxFaceBonus,
        b.loaded,
        b.wildFace,
        source,
        b.count * (factor - 1),
      );
    this._count *= factor;
  }

  /** Shrink every die `steps` rungs (Refinement). */
  shrinkAll(steps: number): void {
    if (this.mode === "list") {
      for (const d of this.list)
        for (let s = 0; s < steps; s++) this.stepDown(d);
      return;
    }
    // Move whole buckets down the ladder, merging as sizes collide.
    for (let s = 0; s < steps; s++) {
      const old = this.buckets;
      this.buckets = [];
      for (const b of old) {
        const i = DIE_LADDER.indexOf(b.sides);
        const sides = i > 0 ? DIE_LADDER[i - 1] : b.sides;
        this.addBucket(
          sides,
          b.maxFaceBonus,
          b.loaded,
          b.wildFace,
          b.source,
          b.count,
        );
      }
    }
  }

  // --- targeted shop effects (a single chosen die) -------------------------

  /** Shrink the die at grid index `i` by `steps` rungs. Returns false if the
   *  index is invalid or the die can't shrink at all. */
  shrinkAt(i: number, steps: number): boolean {
    return this.mutateAt(i, (d) => {
      if (!canShrink(d)) return false;
      for (let s = 0; s < steps; s++) this.stepDown(d);
      return true;
    });
  }

  // --- size-wide shop effects (a whole die size) ---------------------------
  // These act on every die of a chosen size at once (Loaded Die, Wild Face,
  // Twin, Grindstone), so their value rides the grid instead of touching one
  // die. Paired with the run's loadedSizes/wildSizes auras (see Items.applyEffect),
  // which also stamp the property onto dice added later.

  /** Load every die of `sides` (skips d1 and already-loaded dice). Returns how
   *  many were newly loaded. */
  loadAllOfSize(sides: DieSides): number {
    if (sides <= 1) return 0;
    return this.retagSize(
      sides,
      (d) => !d.loaded,
      (opts) => ({ ...opts, loaded: true }),
    );
  }

  /** Make every die of `sides` score on every face. Returns how many changed. */
  wildAllOfSize(sides: DieSides): number {
    return this.retagSize(
      sides,
      (d) => !d.wildFace,
      (opts) => ({ ...opts, wildFace: true }),
    );
  }

  /** Shrink every die of `sides` down `steps` rungs. Returns how many moved. */
  shrinkAllOfSize(sides: DieSides, steps: number): number {
    if (sides <= 1) return 0;
    const i = DIE_LADDER.indexOf(sides);
    const target = DIE_LADDER[Math.max(0, i - steps)];
    if (target === sides) return 0;
    if (this.mode === "list") {
      let n = 0;
      for (const d of this.list)
        if (d.sides === sides) {
          d.sides = target;
          d.value = target;
          n += 1;
        }
      return n;
    }
    let moved = 0;
    for (const b of [...this.buckets]) {
      if (b.sides !== sides) continue;
      const count = b.count;
      b.count = 0;
      this.addBucket(
        target,
        b.maxFaceBonus,
        b.loaded,
        b.wildFace,
        b.source,
        count,
      );
      moved += count;
    }
    this.pruneEmpty();
    return moved;
  }

  /** Add one copy of every die of `sides` (Twin by size), crediting copies to
   *  `source`. Returns how many were added. */
  twinAllOfSize(sides: DieSides, source: string): number {
    // Tally the distinct (flag) variants of this size, then route each through
    // addDice so the count threshold / bucketing is handled once per variant.
    const variants = new Map<string, { opts: DieOpts; count: number }>();
    const tally = (
      maxFaceBonus: number,
      loaded: boolean,
      wildFace: boolean,
      count: number,
    ) => {
      const key = `${maxFaceBonus}|${loaded ? 1 : 0}|${wildFace ? 1 : 0}`;
      const v = variants.get(key);
      if (v) v.count += count;
      else
        variants.set(key, { opts: { maxFaceBonus, loaded, wildFace }, count });
    };
    if (this.mode === "list") {
      for (const d of this.list)
        if (d.sides === sides) tally(d.maxFaceBonus, d.loaded, d.wildFace, 1);
    } else {
      for (const b of this.buckets)
        if (b.sides === sides)
          tally(b.maxFaceBonus, b.loaded, b.wildFace, b.count);
    }
    let added = 0;
    for (const { opts, count } of variants.values()) {
      this.addDice(sides, count, opts, source);
      added += count;
    }
    return added;
  }

  /** Re-tag every die of `sides` that matches `pred`, moving it to the bucket
   *  produced by `remap`ing its flags. Returns how many changed. */
  private retagSize(
    sides: DieSides,
    pred: (d: { loaded: boolean; wildFace: boolean }) => boolean,
    remap: (opts: DieOpts) => DieOpts,
  ): number {
    if (this.mode === "list") {
      let n = 0;
      for (const d of this.list)
        if (d.sides === sides && pred(d)) {
          const opts = remap({
            maxFaceBonus: d.maxFaceBonus,
            loaded: d.loaded,
            wildFace: d.wildFace,
          });
          d.loaded = opts.loaded ?? false;
          d.wildFace = opts.wildFace ?? false;
          n += 1;
        }
      return n;
    }
    let changed = 0;
    for (const b of [...this.buckets]) {
      if (b.sides !== sides || !pred(b)) continue;
      const count = b.count;
      const opts = remap({
        maxFaceBonus: b.maxFaceBonus,
        loaded: b.loaded,
        wildFace: b.wildFace,
      });
      b.count = 0;
      this.addBucket(
        sides,
        windfallFactor(opts.maxFaceBonus, sides),
        opts.loaded ?? false,
        opts.wildFace ?? false,
        b.source,
        count,
      );
      changed += count;
    }
    this.pruneEmpty();
    return changed;
  }

  /** Apply an in-place attribute change to one die by grid index, working in
   *  either mode (in bucket mode it splits one die out of its bucket). */
  private mutateAt(i: number, fn: (d: Die) => boolean): boolean {
    if (this.mode === "list") {
      const d = this.list[i];
      return d ? fn(d) : false;
    }
    const loc = this.locate(i);
    if (!loc) return false;
    const { bucket } = loc;
    // Materialise one die, mutate it, and re-file it into its (possibly new) bucket.
    const die = makeDie(
      bucket.sides,
      {
        maxFaceBonus: bucket.maxFaceBonus,
        loaded: bucket.loaded,
        wildFace: bucket.wildFace,
      },
      bucket.source,
    );
    if (!fn(die)) return false;
    bucket.count -= 1;
    this.addBucket(
      die.sides,
      die.maxFaceBonus,
      die.loaded,
      die.wildFace,
      die.source,
      1,
    );
    this.pruneEmpty();
    return true;
  }

  private locate(i: number): { bucket: Bucket; offset: number } | null {
    if (i < 0) return null;
    let acc = 0;
    for (const b of this.buckets) {
      if (i < acc + b.count) return { bucket: b, offset: i - acc };
      acc += b.count;
    }
    return null;
  }

  // --- indexed access (rendering, targeting) -------------------------------

  /** The die at grid index `i`, or undefined. In bucket mode this synthesises a
   *  Die (with a plausible rolled value from the last roll) for the window the
   *  scene is drawing — never materialising the whole grid. */
  dieAt(i: number): Die | undefined {
    if (this.mode === "list") return this.list[i];
    const loc = this.locate(i);
    if (!loc) return undefined;
    const { bucket, offset } = loc;
    const die = makeDie(
      bucket.sides,
      {
        maxFaceBonus: bucket.maxFaceBonus,
        loaded: bucket.loaded,
        wildFace: bucket.wildFace,
      },
      bucket.source,
    );
    die.value = this.synthValue(bucket, offset);
    return die;
  }

  /** Pick a face value for the `offset`-th die of a bucket from its last-roll
   *  histogram, so a rendered window looks like a real roll. Falls back to the
   *  top face before any roll. */
  private synthValue(bucket: Bucket, offset: number): number {
    const faces = bucket.lastFaces;
    if (!faces) return bucket.sides;
    offset = shuffledOffset(offset, bucket.count, bucket.shuffleSeed ?? 0);
    let acc = 0;
    for (let v = 1; v <= faces.length; v++) {
      acc += faces[v - 1];
      if (offset < acc) return v;
    }
    return bucket.sides;
  }

  // --- queries (criteria, shop availability, save, sim) --------------------

  /** How many dice can still shrink (sides > 1). */
  shrinkableCount(): number {
    if (this.mode === "list")
      return this.list.reduce((n, d) => (canShrink(d) ? n + 1 : n), 0);
    return this.buckets.reduce((n, b) => (b.sides > 1 ? n + b.count : n), 0);
  }

  /** How many dice can still be loaded (sides > 1 and not already loaded). */
  loadableCount(): number {
    if (this.mode === "list")
      return this.list.reduce(
        (n, d) => (d.sides > 1 && !d.loaded ? n + 1 : n),
        0,
      );
    return this.buckets.reduce(
      (n, b) => (b.sides > 1 && !b.loaded ? n + b.count : n),
      0,
    );
  }

  /** How many dice have exactly this many sides (diceOfSize unlock). */
  countOfSize(sides: number): number {
    if (this.mode === "list")
      return this.list.reduce((n, d) => (d.sides === sides ? n + 1 : n), 0);
    return this.buckets.reduce(
      (n, b) => (b.sides === sides ? n + b.count : n),
      0,
    );
  }

  /** sides -> count, for the sim record and dice summaries. */
  sizeCounts(): Record<number, number> {
    const counts: Record<number, number> = {};
    if (this.mode === "list") {
      for (const d of this.list) counts[d.sides] = (counts[d.sides] ?? 0) + 1;
    } else {
      for (const b of this.buckets)
        counts[b.sides] = (counts[b.sides] ?? 0) + b.count;
    }
    return counts;
  }

  /** Summarise a row-major rectangular grid region without materialising dice.
   *  In bucket mode, a prefix-count formula intersects the rectangle with each
   *  bucket's linear index span, so cost depends only on bucket count rather
   *  than on the potentially enormous number of represented rows. */
  summarizeRegion(region: DiceGridRegion): DiceRegionSummary {
    const summary: DiceRegionSummary = {
      total: 0,
      bySides: {},
      representatives: {},
      maxFaceBonus: 0,
      loaded: 0,
      wildFace: 0,
    };
    const add = (
      sides: number,
      maxFaceBonus: number,
      loaded: boolean,
      wildFace: boolean,
      count: number,
      representative: Die,
    ) => {
      if (count <= 0) return;
      summary.total += count;
      summary.bySides[sides] = (summary.bySides[sides] ?? 0) + count;
      if (maxFaceBonus) summary.maxFaceBonus += count;
      if (loaded) summary.loaded += count;
      if (wildFace) summary.wildFace += count;
      const current = summary.representatives[sides];
      const specificity = (die: Die) =>
        Number(die.maxFaceBonus) + Number(die.loaded) + Number(die.wildFace);
      if (!current || specificity(representative) > specificity(current)) {
        summary.representatives[sides] = { ...representative };
      }
    };

    if (this.mode === "list") {
      for (let row = region.rowStart; row < region.rowEnd; row++) {
        const start = row * region.cols + region.colStart;
        const end = Math.min(
          row * region.cols + region.colEnd,
          this.list.length,
        );
        for (let i = start; i < end; i++) {
          const die = this.list[i];
          add(die.sides, die.maxFaceBonus, die.loaded, die.wildFace, 1, die);
        }
      }
      return summary;
    }

    const regionWidth = region.colEnd - region.colStart;
    const countBefore = (index: number): number => {
      const row = Math.floor(index / region.cols);
      const col = index % region.cols;
      const completedRows = Math.max(
        0,
        Math.min(row, region.rowEnd) - region.rowStart,
      );
      let count = completedRows * regionWidth;
      if (row >= region.rowStart && row < region.rowEnd) {
        count += Math.max(0, Math.min(col, region.colEnd) - region.colStart);
      }
      return count;
    };

    let bucketStart = 0;
    for (const bucket of this.buckets) {
      const bucketEnd = bucketStart + bucket.count;
      const overlap = countBefore(bucketEnd) - countBefore(bucketStart);
      const representative = makeDie(
        bucket.sides,
        {
          maxFaceBonus: bucket.maxFaceBonus,
          loaded: bucket.loaded,
          wildFace: bucket.wildFace,
        },
        bucket.source,
      );
      // Bucket histograms store each face as one contiguous run. Hash the
      // region and bucket positions into that run so adjacent cards settle on
      // varied faces while still selecting a value the roll actually produced.
      const representativeOffset =
        (Math.imul(region.rowStart + 1, 73856093) ^
          Math.imul(region.colStart + 1, 19349663) ^
          Math.imul(bucketStart + 1, 83492791)) >>>
        0;
      representative.value = this.synthValue(
        bucket,
        representativeOffset % bucket.count,
      );
      add(
        bucket.sides,
        bucket.maxFaceBonus,
        bucket.loaded,
        bucket.wildFace,
        overlap,
        representative,
      );
      bucketStart = bucketEnd;
    }
    return summary;
  }

  /** Compact human-readable grid summary without materialising bucketed dice. */
  summary(): string {
    return Object.entries(this.sizeCounts())
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([sides, count]) => `${count}×d${sides}`)
      .join(", ");
  }

  /** Grid indices of shrinkable dice, for target pickers. In bucket mode only the
   *  first `limit` are enumerated (a picker never shows more). */
  shrinkableIndices(limit = Infinity): number[] {
    return this.indicesWhere((d) => canShrink(d), limit);
  }

  loadableIndices(limit = Infinity): number[] {
    return this.indicesWhere((d) => d.sides > 1 && !d.loaded, limit);
  }

  private indicesWhere(pred: (d: Die) => boolean, limit: number): number[] {
    const out: number[] = [];
    if (this.mode === "list") {
      for (let i = 0; i < this.list.length && out.length < limit; i++)
        if (pred(this.list[i])) out.push(i);
      return out;
    }
    let base = 0;
    for (const b of this.buckets) {
      const sample = makeDie(
        b.sides,
        {
          maxFaceBonus: b.maxFaceBonus,
          loaded: b.loaded,
          wildFace: b.wildFace,
        },
        b.source,
      );
      if (pred(sample)) {
        for (let k = 0; k < b.count && out.length < limit; k++)
          out.push(base + k);
      }
      base += b.count;
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Visit every die with its grid index. In bucket mode this synthesises each
   *  die, so only call it when the grid is small (below the windowing threshold);
   *  large grids should use groups() or bucketed queries instead. */
  forEach(cb: (die: Die, i: number) => void): void {
    if (this.mode === "list") {
      this.list.forEach(cb);
      return;
    }
    let i = 0;
    for (const b of this.buckets) {
      for (let k = 0; k < b.count; k++) {
        const die = makeDie(
          b.sides,
          {
            maxFaceBonus: b.maxFaceBonus,
            loaded: b.loaded,
            wildFace: b.wildFace,
          },
          b.source,
        );
        die.value = this.synthValue(b, k);
        cb(die, i++);
      }
    }
  }

  /** Array-like helpers for UI/dev code that is only used on small grids. */
  map<T>(cb: (die: Die, i: number) => T): T[] {
    const out: T[] = [];
    this.forEach((die, i) => out.push(cb(die, i)));
    return out;
  }

  findIndex(pred: (die: Die, i: number) => boolean): number {
    if (this.mode === "list") return this.list.findIndex(pred);
    let found = -1;
    this.forEach((die, i) => {
      if (found < 0 && pred(die, i)) found = i;
    });
    return found;
  }

  /** Distinct dice groups by (sides, flags) — ignoring source — each with a
   *  representative die, its total count, and the grid index of its first member.
   *  O(buckets) in bucket mode, so a target picker can show one icon + a count per
   *  group instead of a sprite per die. */
  groups(
    excludedIndices: readonly number[] = [],
  ): { die: Die; count: number; firstIndex: number }[] {
    const map = new Map<
      string,
      { die: Die; count: number; firstIndex: number }
    >();
    const excluded = new Set(excludedIndices);
    const flagsKey = (
      sides: number,
      mfb: number,
      loaded: boolean,
      wild: boolean,
    ) => `${sides}|${mfb}|${loaded ? 1 : 0}|${wild ? 1 : 0}`;
    if (this.mode === "list") {
      this.list.forEach((die, i) => {
        if (excluded.has(i)) return;
        const key = flagsKey(
          die.sides,
          die.maxFaceBonus,
          die.loaded,
          die.wildFace,
        );
        const g = map.get(key);
        if (g) g.count += 1;
        else map.set(key, { die, count: 1, firstIndex: i });
      });
      return [...map.values()];
    }
    let offset = 0;
    for (const b of this.buckets) {
      const key = flagsKey(b.sides, b.maxFaceBonus, b.loaded, b.wildFace);
      let excludedInBucket = 0;
      let firstIndex = offset;
      while (firstIndex < offset + b.count && excluded.has(firstIndex))
        firstIndex += 1;
      for (const index of excluded) {
        if (index >= offset && index < offset + b.count) excludedInBucket += 1;
      }
      const available = b.count - excludedInBucket;
      if (available <= 0) {
        offset += b.count;
        continue;
      }
      const g = map.get(key);
      if (g) g.count += available;
      else
        map.set(key, {
          die: this.dieAt(firstIndex)!,
          count: available,
          firstIndex,
        });
      offset += b.count;
    }
    return [...map.values()];
  }

  /** Storable per-stack summary (for save + Hall entries), always bucketed and
   *  tiny regardless of grid size. */
  summarize(): DiceStack[] {
    if (this.mode === "bucket") {
      return this.buckets.map((b) => ({
        sides: b.sides,
        maxFaceBonus: b.maxFaceBonus,
        loaded: b.loaded,
        wildFace: b.wildFace,
        source: b.source,
        count: b.count,
      }));
    }
    const map = new Map<string, DiceStack>();
    for (const d of this.list) {
      const key = bucketKey(
        d.sides,
        d.maxFaceBonus,
        d.loaded,
        d.wildFace,
        d.source,
      );
      const s = map.get(key);
      if (s) s.count += 1;
      else
        map.set(key, {
          sides: d.sides,
          maxFaceBonus: d.maxFaceBonus,
          loaded: d.loaded,
          wildFace: d.wildFace,
          source: d.source,
          count: 1,
        });
    }
    return [...map.values()];
  }
}
