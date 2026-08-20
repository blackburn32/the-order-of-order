// Projecting a finished run onto LootLocker's single sortable integer.
//
// A run is now ranked by how far it got — the RANK it reached — with total
// points only breaking ties between runs that got equally far. LootLocker sorts
// on one signed 64-bit `score` field, so both keys have to be packed into it:
// the rank goes in the high digits and a compressed points ordinal in the low
// ones, which makes rank always dominate and points never able to overtake it.
//
// The exact point total still rides losslessly in metadata `s` for display; the
// wire value only has to preserve ORDER.

/** Convert a score boundary value to the exact non-negative integer submitted
 * to the leaderboard. The live game passes bigint; number remains accepted for
 * compatibility with older callers and dev tooling. */
export function normalizeLeaderboardScore(score: bigint | number): bigint {
  if (typeof score === "bigint") return score < 0n ? 0n : score;
  return Number.isFinite(score) && score > 0 ? BigInt(Math.floor(score)) : 0n;
}

// LootLocker's leaderboard `score` field is a signed 64-bit integer, so the
// largest rankable value is this.
export const LEADERBOARD_INT64_MAX = 9223372036854775807n;

/** Digits reserved for the points tiebreak within one rank. Sized so that
 *  MAX_WIRE_RANK ranks fit under the int64 ceiling with room to spare. */
export const POINTS_SPAN = 92_000_000_000_000_000n; // 9.2e16

/** Ranks above this all share the top band. Endless runs would have to reach
 *  rank 100 to hit it, which the goal curve makes impossible. */
export const MAX_WIRE_RANK = 99;

/** The point total that maps to the very top of a rank's band; larger totals
 *  clamp there (and tie). Set far above any reachable score. */
export const LEADERBOARD_LOG_CEILING = 1e40;

/** Compress a point total into [0, POINTS_SPAN) preserving order. Logarithmic
 *  throughout: scores span forty orders of magnitude across a run, so a linear
 *  map would put every ordinary run in the same bucket. */
export function pointsToWireOrdinal(score: bigint): bigint {
  const real = score < 0n ? 0n : score;
  if (real === 0n) return 0n;
  const d = Number(real);
  const span = POINTS_SPAN - 1n;
  if (!Number.isFinite(d)) return span;
  const frac = Math.log(1 + d) / Math.log(1 + LEADERBOARD_LOG_CEILING);
  const clamped = frac <= 0 ? 0 : frac >= 1 ? 1 : frac;
  return BigInt(Math.round(Number(span) * clamped));
}

/** Pack a finished run into the one sortable integer: rank first, points as
 *  the tiebreak. Strictly ordered by (rank, points). */
export function runToWireOrdinal(rank: number, score: bigint): bigint {
  const safeRank = BigInt(
    Math.max(0, Math.min(MAX_WIRE_RANK, Math.floor(rank))),
  );
  const wire = safeRank * POINTS_SPAN + pointsToWireOrdinal(score);
  return wire > LEADERBOARD_INT64_MAX ? LEADERBOARD_INT64_MAX : wire;
}

/** The rank a wire ordinal encodes — used to read back rows whose metadata is
 *  missing or unparseable. */
export function rankFromWireOrdinal(wire: bigint | number): number {
  const value = normalizeLeaderboardScore(wire);
  return Number(value / POINTS_SPAN);
}

/** Build a JSON request without narrowing the score through Number or allowing
 * JSON.stringify to switch it to exponent notation at 1e21. The interpolated
 * token comes from bigint.toString(), so it is always a safe decimal integer. */
export function buildLeaderboardSubmissionBody(
  memberId: string,
  score: bigint,
  metadata: string,
): string {
  return (
    `{"member_id":${JSON.stringify(memberId)},` +
    `"score":${score.toString()},` +
    `"metadata":${JSON.stringify(metadata)}}`
  );
}
