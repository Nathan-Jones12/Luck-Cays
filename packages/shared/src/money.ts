/**
 * Chips are whole integers held in BIGINT columns and carried as `bigint`.
 *
 * They cross the wire as decimal strings, never as JSON numbers: a chip balance
 * can exceed 2^53 and `number` would silently round it. Everything that leaves
 * the API goes through `chipsToJson`, and everything that arrives goes through
 * `chipsFromJson`.
 */

/** A chip amount in flight as JSON: a decimal integer string, e.g. "10000". */
export type ChipString = string;

const DECIMAL_INTEGER = /^-?\d+$/;

export function chipsToJson(value: bigint): ChipString {
  return value.toString(10);
}

export function chipsFromJson(value: ChipString): bigint {
  if (!DECIMAL_INTEGER.test(value)) {
    throw new TypeError(`not a chip amount: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/**
 * Parse anything the boundary might hand us into chips. Accepts a bigint, a
 * decimal string, or a safe integer `number` (so hand-written configs and
 * seed data stay readable). Rejects floats and unsafe integers outright.
 */
export function toChips(value: bigint | number | string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(`chip amounts must be whole: ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`chip amount exceeds safe integer range: ${value}`);
    }
    return BigInt(value);
  }
  return chipsFromJson(value);
}

/** Group digits for display: 1234567n -> "1,234,567". */
export function formatChips(value: bigint | ChipString): string {
  const n = typeof value === "bigint" ? value : chipsFromJson(value);
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString(10);
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/**
 * Multiply chips by a decimal factor (cashback percentages, bonus multipliers)
 * without ever going through a float. `factor` is given with `scale` implied
 * decimal places, so 2.5x is `applyFactor(n, 25n, 1)`.
 */
export function applyFactor(chips: bigint, factor: bigint, scale: number): bigint {
  const divisor = 10n ** BigInt(scale);
  return (chips * factor) / divisor;
}

/** Percentage of an amount, floored. `pct` is basis-point-free: 7 means 7%. */
export function percentOf(chips: bigint, pct: number): bigint {
  if (!Number.isInteger(pct)) throw new TypeError(`pct must be whole: ${pct}`);
  return (chips * BigInt(pct)) / 100n;
}
