// The run's randomness, addressed rather than consumed.
//
// A run carries one 32-bit `seed`, and every random decision in it draws from a
// stream derived from that seed plus a NAME for the decision — "the dice of
// trial 7 roll 3", "the shop offers of visit 12 after 2 rerolls". Nothing draws
// from a single running stream.
//
// That distinction is the whole design, and it is worth being explicit about
// why. A single stream would be perfectly deterministic and almost useless:
//
//   - Draw counts swing wildly. A grid under BUCKET_THRESHOLD rolls one draw
//     per die; above it the buckets are sampled instead, a few draws per bucket
//     per face. So a stream position after ten rolls depends on how big the grid
//     happened to get, and one extra shop reroll shifts every boss for the rest
//     of the run.
//   - It would have to be persisted, exactly, through every save and resume,
//     and any code path that drew one extra number would silently fork the run.
//
// Naming the stream instead makes both problems disappear. `trial` and `roll`
// are already saved state, so a resumed run addresses the same stream it would
// have without the reload — the cursor is reconstructed rather than remembered.
// And a seed comes to describe the CONTENT of a run: rank 4's boss is rank 4's
// boss whatever the player did on the way there.

/** mulberry32 — small, fast, well-distributed, and identical everywhere: it is
 *  all integer ops and one division by a power of two. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The domains a run draws from. One per kind of decision, so that adding a new
 * source of randomness later cannot disturb the streams of the ones already
 * here — a new domain is a new name, not a new position in a shared queue.
 */
export type RngDomain =
  | "roll" // the dice, and everything resolving that roll
  | "boss" // a rank's modifiers, where they are rolled outside a trial end
  | "shop" // a shop visit's card offers
  | "packs" // a shop visit's booster shelf
  | "booster" // the cards inside one opened pack
  | "demands" // the King's writ
  | "trialEnd"; // whatever a trial's resolution has to roll

/** FNV-1a over the domain and key, mixed into the run's seed. Any hash would do;
 *  what matters is that it is pure integer arithmetic (so every engine agrees)
 *  and that neighbouring keys land far apart. */
function streamSeed(seed: number, domain: RngDomain, key: string): number {
  let hash = 0x811c9dc5 ^ (seed >>> 0);
  const label = `${domain}:${key}`;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // One extra avalanche step: FNV-1a alone leaves short, similar labels
  // correlated in the low bits, and mulberry32 seeds directly off them.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return hash >>> 0;
}

/**
 * The generator for one named decision.
 *
 * Callers name a stream by what it IS, never by how many draws came before it:
 * `streamFor(state, "boss", rank)`, not "the next boss". Two calls with the same
 * seed, domain and key return two generators that produce the same numbers —
 * which is exactly what makes a reload safe, and exactly why a key must include
 * everything that distinguishes one draw from the next (see the `roll` domain,
 * keyed by trial AND roll).
 */
export function streamFor(
  seed: number,
  domain: RngDomain,
  key: string | number,
): () => number {
  return mulberry32(streamSeed(seed, domain, String(key)));
}

/** A fresh run's seed. `crypto` where it exists so two runs started in the same
 *  millisecond cannot collide; `Math.random` is a fine fallback, since this is
 *  the one number in the system that is ALLOWED to be unpredictable. */
export function randomSeed(): number {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    return cryptoApi.getRandomValues(new Uint32Array(1))[0] >>> 0;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/** Whether a value is a seed this code could have produced — used when reading
 *  one back off a save or off the network, where it is not to be trusted. */
export function isSeed(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff
  );
}

/** A seed for a run recorded before seeds existed. Derived from the run's start
 *  time rather than rolled fresh, so a save reloaded twice does not get two
 *  different "original" seeds — it is a stable label for a run whose dice are
 *  already spent, not a promise that the run can be replayed. */
export function legacySeed(startedAt: number): number {
  return streamSeed(startedAt >>> 0, "roll", "legacy");
}

// --- Player-facing form -----------------------------------------------------

/** Base 36, uppercased: a 32-bit seed is at most seven characters, which is
 *  short enough to read off a screen and type into another device. */
export function formatSeed(seed: number): string {
  return (seed >>> 0).toString(36).toUpperCase().padStart(7, "0");
}

/** Read a seed back from what a player typed. Tolerant of case, whitespace and
 *  the padding zeroes `formatSeed` adds; null when it is not a seed at all. */
export function parseSeed(text: string): number | null {
  const cleaned = text.trim().replace(/\s+/g, "");
  if (!/^[0-9A-Za-z]{1,7}$/.test(cleaned)) return null;
  const value = parseInt(cleaned, 36);
  return isSeed(value) ? value : null;
}
