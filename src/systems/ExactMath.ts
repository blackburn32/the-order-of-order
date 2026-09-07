// Deterministic stand-ins for the Math functions the language does not pin down.
//
// ECMAScript ties `+`, `-`, `*`, `/` and `Math.sqrt` to IEEE 754: every engine
// computes them bit-for-bit alike, and always will. It ties `Math.log`,
// `Math.cos`, `Math.pow` and the rest of the transcendentals to nothing at all —
// the spec calls them implementation-approximated, and V8, JavaScriptCore and
// SpiderMonkey do genuinely differ in the last place.
//
// That difference is invisible while a run is only ever played once. It stops
// being invisible the moment a run has a seed: a grid past BUCKET_THRESHOLD is
// not rolled die by die but sampled through a normal approximation (see
// ScoringHistogram.sampleFaceCounts), so a single ulp of disagreement inside the
// sampler is a different face histogram, a different score, and a seed that
// proves nothing. A run played on an Android WebView has to replay identically
// on a desktop Firefox or the seed is decoration.
//
// So everything here is built from the four exact operations and `Math.sqrt`,
// plus exact bit inspection of the double itself. Nothing in this file may call
// a transcendental.

/** The double nearest ln 2 — the constant the exponent term is built from. */
const LN2 = 0.6931471805599453;

/** sqrt(2), the point the mantissa is folded around so the series below sees the
 *  smallest possible argument. */
const SQRT2 = 1.4142135623730951;

/** 2 ** 53, the exact scale that lifts a subnormal into the normal range. */
const TWO_53 = 9007199254740992;

// One reusable view: `ln` runs a few hundred times a roll, and allocating an
// ArrayBuffer per call would cost more than the logarithm.
const bits = new DataView(new ArrayBuffer(8));

/**
 * Natural logarithm, to within a few ulps of a correctly-rounded result and
 * identical on every engine.
 *
 * The double is split exactly into `m × 2 ** e` by reading its exponent field,
 * which makes `ln(x) = e·ln2 + ln(m)` with `m` in [1, 2). The mantissa is then
 * folded around sqrt(2) so that `|z| = |(m-1)/(m+1)|` never exceeds 0.1716, and
 * the odd series `ln((1+z)/(1-z)) = 2(z + z³/3 + z⁵/5 + …)` converges inside
 * double precision well before the twelve terms taken here.
 *
 * Defined for finite x > 0; anything else is the caller's error.
 */
export function ln(x: number): number {
  bits.setFloat64(0, x);
  let exponent = ((bits.getUint32(0) >>> 20) & 0x7ff) - 1023;
  if (exponent === -1023) {
    // Subnormal: no implicit leading bit, so scale into the normal range first.
    // Multiplying by a power of two is exact, and the shift comes back off the
    // exponent rather than out of the mantissa.
    bits.setFloat64(0, x * TWO_53);
    exponent = ((bits.getUint32(0) >>> 20) & 0x7ff) - 1076;
  }
  // Dividing by a power of two is exact, so `mantissa` carries every bit of x.
  let mantissa = x / 2 ** exponent;
  if (mantissa > SQRT2) {
    mantissa /= 2;
    exponent += 1;
  }
  const z = (mantissa - 1) / (mantissa + 1);
  const zz = z * z;
  let term = z;
  let sum = z;
  for (let k = 3; k <= 25; k += 2) {
    term *= zz;
    sum += term / k;
  }
  return exponent * LN2 + 2 * sum;
}

/**
 * The inverse standard normal CDF (Wichura's AS241 PPND16), accurate to about
 * 1e-15 across the whole of (0, 1).
 *
 * It is a pair of rational polynomials, which is exactly why it is here: a
 * quotient of polynomials is nothing but the four exact operations, so the
 * central 85% of the distribution is computed without touching a transcendental
 * at all, and the tails need only `sqrt` and the `ln` above.
 *
 * The coefficients are AS241's, written in the exact double each one rounds to
 * rather than at the published width — the same values, in the only form the
 * machine can actually hold.
 */
export function probit(p: number): number {
  const q = p - 0.5;
  if (q >= -0.425 && q <= 0.425) {
    const r = 0.180625 - q * q;
    return (
      (q *
        (((((((2509.0809287301227 * r + 33430.57558358813) * r +
          67265.7709270087) *
          r +
          45921.95393154987) *
          r +
          13731.69376550946) *
          r +
          1971.5909503065513) *
          r +
          133.14166789178438) *
          r +
          3.3871328727963665)) /
      (((((((5226.495278852546 * r + 28729.085735721943) * r +
        39307.89580009271) *
        r +
        21213.794301586597) *
        r +
        5394.196021424751) *
        r +
        687.1870074920579) *
        r +
        42.31333070160091) *
        r +
        1)
    );
  }

  let r = Math.sqrt(-ln(q < 0 ? p : 1 - p));
  let value: number;
  if (r <= 5) {
    r -= 1.6;
    value =
      (((((((0.0007745450142783414 * r + 0.022723844989269184) * r +
        0.2417807251774506) *
        r +
        1.2704582524523684) *
        r +
        3.6478483247632045) *
        r +
        5.769497221460691) *
        r +
        4.630337846156546) *
        r +
        1.4234371107496835) /
      (((((((1.0507500716444169e-9 * r + 0.0005475938084995345) * r +
        0.015198666563616457) *
        r +
        0.14810397642748008) *
        r +
        0.6897673349851) *
        r +
        1.6763848301838038) *
        r +
        2.053191626637759) *
        r +
        1);
  } else {
    r -= 5;
    value =
      (((((((2.0103343992922881e-7 * r + 0.000027115555687434876) * r +
        0.0012426609473880784) *
        r +
        0.026532189526576124) *
        r +
        0.29656057182850487) *
        r +
        1.7848265399172913) *
        r +
        5.463784911164114) *
        r +
        6.657904643501103) /
      (((((((2.0442631033899397e-15 * r + 1.421511758316446e-7) * r +
        0.000018463183175100548) *
        r +
        0.0007868691311456133) *
        r +
        0.014875361290850615) *
        r +
        0.1369298809227358) *
        r +
        0.599832206555888) *
        r +
        1);
  }
  return q < 0 ? -value : value;
}
