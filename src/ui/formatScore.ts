const SCIENTIFIC_THRESHOLD = 1_000_000_000n;
const SIGNIFICANT_DIGITS = 3;

/**
 * Formats score-like integer values for the UI. Ordinary values stay exact and
 * use locale separators; billion-scale values switch to compact scientific
 * notation so score and target labels remain easy to compare.
 */
export function formatScore(value: bigint | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);

    const rounded = Math.round(value);
    if (Math.abs(rounded) < Number(SCIENTIFIC_THRESHOLD)) {
      return rounded.toLocaleString();
    }
    return rounded.toExponential(SIGNIFICANT_DIGITS - 1).replace("e+", "e");
  }

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  if (absolute < SCIENTIFIC_THRESHOLD) return value.toLocaleString();

  const digits = absolute.toString();
  let exponent = digits.length - 1;
  let significant = Number(digits.slice(0, SIGNIFICANT_DIGITS));

  if (Number(digits[SIGNIFICANT_DIGITS] ?? "0") >= 5) {
    significant += 1;
  }

  const rollover = 10 ** SIGNIFICANT_DIGITS;
  if (significant === rollover) {
    significant /= 10;
    exponent += 1;
  }

  const coefficientDigits = String(significant).padStart(
    SIGNIFICANT_DIGITS,
    "0",
  );
  const coefficient = `${coefficientDigits[0]}.${coefficientDigits.slice(1)}`;
  return `${negative ? "-" : ""}${coefficient}e${exponent}`;
}

const COMPACT_UNITS = ["K", "M", "B", "T"];
/** Below this a separated count is short enough to print in full. */
const COMPACT_THRESHOLD = 10_000;

/**
 * A count for somewhere with a hard width budget — a dice summary card's row
 * label, which has to share its column with a die icon. Small counts stay
 * exact; larger ones drop to three significant digits and a magnitude suffix,
 * and anything past a trillion falls back to `formatScore`'s scientific form.
 */
export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value);
  if (Math.abs(rounded) < COMPACT_THRESHOLD) return rounded.toLocaleString();

  let scaled = rounded / 1000;
  let unit = 0;
  while (Math.abs(scaled) >= 1000 && unit < COMPACT_UNITS.length - 1) {
    scaled /= 1000;
    unit++;
  }
  if (Math.abs(scaled) >= 1000) return formatScore(rounded);

  const digits = (value: number) =>
    Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  // Rounding can carry into the next magnitude — 999,999 is 1000K, not 999.999K.
  if (Math.abs(Number(scaled.toFixed(digits(scaled)))) >= 1000) {
    if (unit === COMPACT_UNITS.length - 1) return formatScore(rounded);
    scaled /= 1000;
    unit++;
  }
  // parseFloat drops a trailing zero, so 4.10K reads as 4.1K.
  return `${parseFloat(scaled.toFixed(digits(scaled)))}${COMPACT_UNITS[unit]}`;
}
