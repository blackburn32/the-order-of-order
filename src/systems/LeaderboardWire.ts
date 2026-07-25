/** Convert a score boundary value to the exact non-negative integer submitted
 * to the leaderboard. The live game passes bigint; number remains accepted for
 * compatibility with older callers and dev tooling. */
export function normalizeLeaderboardScore(score: bigint | number): bigint {
  if (typeof score === "bigint") return score < 0n ? 0n : score;
  return Number.isFinite(score) && score > 0 ? BigInt(Math.floor(score)) : 0n;
}

// LootLocker's leaderboard `score` field is a signed 64-bit integer, so the
// largest rankable value is this. Real scores now grow far past it (target
// 1e35), and the sortable field only needs to preserve *order* — the exact
// value already rides losslessly in metadata `s` for display.
export const LEADERBOARD_INT64_MAX = 9223372036854775807n;

// Scores at or below this submit as their exact integer value. Every row
// already on the board was submitted raw and sits below the current max
// (~1.93e18), so a threshold safely above that leaves all existing ranks
// untouched: real ≤ LINEAR_MAX stays a pass-through, and everything larger is
// compressed into the headroom *above* it, so a compressed giant always
// outranks every raw row.
export const LEADERBOARD_LINEAR_MAX = 2_000_000_000_000_000_000n; // 2e18

// The real score that maps to the very top of the int64 range; larger scores
// clamp to the max (and tie there). Set well above the 1e35 target so 1e35
// itself lands comfortably below the ceiling.
export const LEADERBOARD_LOG_CEILING = 1e40;

/** Project a true score (bigint, arbitrarily large) onto LootLocker's signed
 * int64 score field so ordering is preserved:
 *   - real ≤ LINEAR_MAX  → the exact value (existing rows are unaffected)
 *   - real > LINEAR_MAX   → log-compressed into (LINEAR_MAX, INT64_MAX]
 * The map is continuous and strictly monotonic across the split. In the
 * compressed region resolution is set by the ~7.2e18 integer buckets of
 * headroom spread over the log span, which distinguishes any scores differing
 * by a meaningful ratio; only integer-adjacent gigascores can share a bucket,
 * and those still display their exact value from metadata. */
export function scoreToWireOrdinal(score: bigint): bigint {
  const real = score < 0n ? 0n : score;
  if (real <= LEADERBOARD_LINEAR_MAX) return real; // exact pass-through
  const d = Number(real);
  if (!Number.isFinite(d)) return LEADERBOARD_INT64_MAX;
  // The compressed region opens at LINEAR_MAX + 1, so any real above the linear
  // ceiling strictly outranks every raw pass-through row even when the log
  // offset rounds to zero right at the boundary.
  const base = LEADERBOARD_LINEAR_MAX + 1n;
  const lo = Number(LEADERBOARD_LINEAR_MAX);
  const headroom = Number(LEADERBOARD_INT64_MAX - base);
  const span = Math.log(LEADERBOARD_LOG_CEILING) - Math.log(lo);
  const frac = (Math.log(d) - Math.log(lo)) / span;
  const clamped = frac >= 1 ? 1 : frac; // frac > 0 since d > lo
  const wire = base + BigInt(Math.round(headroom * clamped));
  return wire > LEADERBOARD_INT64_MAX ? LEADERBOARD_INT64_MAX : wire;
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
