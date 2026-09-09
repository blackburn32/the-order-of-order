// Executable spec for seeded runs: systems/Rng.ts, and the promise the whole
// design rests on — that a run is a function of its seed and its unlock
// snapshot, and of nothing else.
//
// Run: npm run rng:check
//
// The assertions come in three groups, and the middle one is the point. Streams
// being deterministic is table stakes. What actually matters is that a run
// survives a save and reload with its dice intact, because that is the property
// a single running cursor could not have given us without persisting the cursor
// exactly — and it is what replaying someone else's run depends on.

import { rankOf } from "../config";
import { newRun, type RunState } from "../state/RunState";
import {
  hydrateRunState,
  serializeRunState,
} from "../systems/ActiveRunPersistence";
import { bossesForRank } from "../systems/Boss";
import {
  formatSeed,
  isSeed,
  legacySeed,
  parseSeed,
  randomSeed,
  streamFor,
} from "../systems/Rng";
import { rollShopOffers } from "../systems/Shop";
import { beginRun, resolveRoll, resolveTrialEnd, rollPool } from "./engine";
import { installStorage } from "./localStorageShim";
import { ITEMS, type ShopItemId } from "../systems/Items";

installStorage([]);

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok     ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL   ${message}`);
  }
}

// --- 1. The streams themselves ---------------------------------------------

console.log("streams are named, not counted");
{
  const draws = (rng: () => number, n = 8) =>
    Array.from({ length: n }, () => rng()).join(",");

  check(
    draws(streamFor(1234, "roll", "3:2")) ===
      draws(streamFor(1234, "roll", "3:2")),
    "the same seed, domain and key give the same numbers",
  );
  check(
    draws(streamFor(1234, "roll", "3:2")) !==
      draws(streamFor(1234, "roll", "3:3")),
    "an adjacent key gives different numbers",
  );
  check(
    draws(streamFor(1234, "roll", "3:2")) !==
      draws(streamFor(1234, "boss", "3:2")),
    "the same key in another domain gives different numbers",
  );
  check(
    draws(streamFor(1234, "roll", "3:2")) !==
      draws(streamFor(1235, "roll", "3:2")),
    "an adjacent seed gives different numbers",
  );

  // Reaching for a stream must never depend on having drawn from an earlier
  // one. This is the whole reason no cursor is persisted anywhere.
  const late = streamFor(99, "shop", "12:0");
  const early = streamFor(99, "shop", "12:0");
  for (let i = 0; i < 500; i++) streamFor(99, "roll", `${i}:0`)();
  check(
    late() === early(),
    "drawing from other streams in between changes nothing",
  );

  let low = 0;
  const uniform = streamFor(7, "roll", "1:1");
  const total = 200_000;
  for (let i = 0; i < total; i++) if (uniform() < 0.5) low += 1;
  check(
    Math.abs(low / total - 0.5) < 0.01,
    `and the numbers are uniform (${((100 * low) / total).toFixed(2)}% below half)`,
  );
}

console.log("seeds survive the round trip a player would put them through");
{
  const seed = randomSeed();
  check(isSeed(seed), `randomSeed() produces a seed (${formatSeed(seed)})`);
  check(parseSeed(formatSeed(seed)) === seed, "format then parse is identity");
  check(
    parseSeed(formatSeed(seed).toLowerCase()) === seed,
    "and tolerates the case a player types it in",
  );
  check(
    parseSeed("  ZIK0ZJ  ") === parseSeed("ZIK0ZJ"),
    "and surrounding space",
  );
  check(parseSeed("not a seed!") === null, "while refusing what is not one");
  check(
    isSeed(legacySeed(1_700_000_000_000)) &&
      legacySeed(1_700_000_000_000) === legacySeed(1_700_000_000_000),
    "a pre-seed save gets a stable seed rather than a fresh one",
  );
}

// --- 2. A whole run, replayed ----------------------------------------------

/** Play `rolls` rolls of a fresh run on `seed`, resolving trials as they end.
 *  Deliberately the same calls, in the same order and with the same stream
 *  keys, that GameScene makes. */
function playRun(seed: number, rolls: number): RunState {
  const state = newRun([], seed);
  beginRun(state, streamFor(state.seed, "boss", rankOf(state.trial)));
  for (let i = 0; i < rolls; i++) {
    rollPool(
      state,
      state.dice,
      streamFor(state.seed, "roll", `${state.trial}:${state.roll}`),
    );
    resolveRoll(
      state,
      streamFor(state.seed, "roll", `${state.trial}:${state.roll}:resolve`),
    );
    if (state.trialCleared)
      resolveTrialEnd(state, streamFor(state.seed, "trialEnd", state.trial));
  }
  return state;
}

/** Everything about a run that a replay has to reproduce. */
function fingerprint(state: RunState): string {
  return JSON.stringify({
    trial: state.trial,
    roll: state.roll,
    score: state.score.toString(),
    total: state.totalScore.toString(),
    gold: state.gold,
    dice: state.dice.summarize(),
    bosses: state.bossModifiers,
    afflictions: state.afflictions,
  });
}

console.log("a run is a function of its seed");
{
  const seed = 0xc0ffee;
  const first = fingerprint(playRun(seed, 40));
  const second = fingerprint(playRun(seed, 40));
  check(first === second, "the same seed plays out identically, twice");
  check(
    fingerprint(playRun(seed + 1, 40)) !== first,
    "a different seed does not",
  );
}

console.log("and it survives being saved and reloaded mid-run");
{
  const seed = 0x5eed;
  const straight = fingerprint(playRun(seed, 40));

  // Play the first half, put the run through the real save format, and finish
  // it from whatever came back.
  const partial = playRun(seed, 18);
  const reloaded = hydrateRunState(
    JSON.parse(JSON.stringify(serializeRunState(partial))),
  );
  check(!!reloaded, "a seeded run hydrates");
  if (reloaded) {
    check(reloaded.seed === seed, "with its seed intact");
    for (let i = 0; i < 22; i++) {
      rollPool(
        reloaded,
        reloaded.dice,
        streamFor(reloaded.seed, "roll", `${reloaded.trial}:${reloaded.roll}`),
      );
      resolveRoll(
        reloaded,
        streamFor(
          reloaded.seed,
          "roll",
          `${reloaded.trial}:${reloaded.roll}:resolve`,
        ),
      );
      if (reloaded.trialCleared)
        resolveTrialEnd(
          reloaded,
          streamFor(reloaded.seed, "trialEnd", reloaded.trial),
        );
    }
    check(
      fingerprint(reloaded) === straight,
      "and finishes exactly where the uninterrupted run finished",
    );
  }
}

console.log("a save written before seeds existed still loads");
{
  const legacy = serializeRunState(newRun([], 0)) as unknown as Record<
    string,
    unknown
  >;
  delete legacy.seed;
  const first = hydrateRunState(JSON.parse(JSON.stringify(legacy)));
  const second = hydrateRunState(JSON.parse(JSON.stringify(legacy)));
  check(!!first && !!second, "it hydrates rather than being discarded");
  check(
    !!first && !!second && first.seed === second.seed && isSeed(first.seed),
    "and gets the same derived seed every time it is read",
  );
  check(
    hydrateRunState(JSON.parse(JSON.stringify({ ...legacy, seed: -1 }))) ===
      null,
    "while a corrupt seed fails hydration outright",
  );
}

// --- 3. What the unlock snapshot is for ------------------------------------

console.log("the unlock snapshot is the other half of a replay");
{
  // The 26 cards behind a persistent unlock are exactly what one player's shop
  // can offer and another's cannot, so they are the whole reason a seed alone
  // does not describe a run.
  const gatedIds = ITEMS.filter((item) => item.unlock !== undefined).map(
    (item) => item.id,
  );
  const shelf = (unlocks: ShopItemId[], seed: number) =>
    rollShopOffers(
      newRun(unlocks, seed),
      3,
      streamFor(seed, "shop", "1:0"),
    ).map((offer) => offer.id);

  check(
    shelf([], 0xfeed).join(",") === shelf([], 0xfeed).join(","),
    "the same seed and unlocks deal the same shop",
  );

  // The hard invariant: a card nobody has unlocked can never be dealt, whatever
  // the seed. A replay handed the wrong snapshot would violate this rather than
  // merely diverge.
  const gated = new Set<string>(gatedIds);
  let leaked = 0;
  for (let seed = 0; seed < 400; seed++)
    for (const id of shelf([], seed)) if (gated.has(id)) leaked += 1;
  check(leaked === 0, "a locked card is never offered, across 400 seeds");

  // And with everything unlocked the shelf genuinely moves. Not on every seed —
  // three draws from a pool of 46 can happen to miss all 26 additions — so this
  // asserts the majority rather than pretending it is universal.
  let moved = 0;
  for (let seed = 0; seed < 400; seed++)
    if (shelf([], seed).join(",") !== shelf(gatedIds, seed).join(","))
      moved += 1;
  check(
    moved > 300,
    `the full unlock set deals a different shop on ${moved} of 400 seeds, which is why it is recorded alongside the seed`,
  );
}

console.log("a rigged tutorial run reproduces too");
{
  // The tutorial forces rolls to come up all ones, and whether it is still doing
  // so depends on how far the player got through its callouts - which is why the
  // run records the rigged rolls rather than leaving a replay to guess. Here the
  // rigging is driven off that record, exactly as a replay would drive it.
  const seed = 0x7107;
  const play = (rolls: number, forcedRolls: string[]) => {
    const state = newRun([], seed);
    state.tutorialArmed = true;
    state.forcedRolls = [...forcedRolls];
    beginRun(state, streamFor(state.seed, "boss", rankOf(state.trial)));
    for (let i = 0; i < rolls; i++) {
      const key = `${state.trial}:${state.roll}`;
      const rigged = state.forcedRolls.includes(key);
      rollPool(
        state,
        state.dice,
        rigged ? () => 0 : streamFor(state.seed, "roll", key),
      );
      resolveRoll(state, streamFor(state.seed, "roll", `${key}:resolve`));
      if (state.trialCleared)
        resolveTrialEnd(state, streamFor(state.seed, "trialEnd", state.trial));
    }
    return state;
  };

  const rigged = ["1:0", "1:3"];
  check(
    fingerprint(play(20, rigged)) === fingerprint(play(20, rigged)),
    "the same seed and the same rigged rolls replay identically",
  );
  check(
    fingerprint(play(20, rigged)) !== fingerprint(play(20, [])),
    "and a run whose rigging is forgotten plays out differently, which is why it is recorded",
  );

  // The record has to survive the save format like everything else.
  const played = play(20, rigged);
  const reloaded = hydrateRunState(
    JSON.parse(JSON.stringify(serializeRunState(played))),
  );
  check(
    !!reloaded &&
      reloaded.tutorialArmed &&
      reloaded.forcedRolls.join(",") === rigged.join(","),
    "and it comes back off a save intact",
  );
  const corrupt = serializeRunState(played) as unknown as Record<
    string,
    unknown
  >;
  corrupt.forcedRolls = ["1:0", { not: "a key" }];
  check(
    hydrateRunState(JSON.parse(JSON.stringify(corrupt))) === null,
    "while a malformed rigging record fails hydration rather than rigging the wrong roll",
  );
}

console.log("a rank's bosses come from the seed, not from the order of play");
{
  const state = newRun([], 0xb055);
  const first = bossesForRank(state, 4, streamFor(state.seed, "boss", 4));
  const again = bossesForRank(state, 4, streamFor(state.seed, "boss", 4));
  check(
    JSON.stringify(first) === JSON.stringify(again),
    "rank 4 is assigned the same modifiers however it is reached",
  );
}

console.log(
  failures === 0
    ? "\nSeeded-run check: ALL PASS"
    : `\nSeeded-run check: ${failures} FAILURE(S)`,
);
if (failures > 0) process.exit(1);
