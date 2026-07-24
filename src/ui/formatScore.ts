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
