/**
 * `packages/db`'s `money` columns are real decimal numerics (e.g. "1.0000000" means one dollar),
 * while the fixed-point convention shared with the contracts (`PRICE_SCALE`) represents the same
 * value as a raw scaled integer (`10_000_000n`). These two converters sit at the DB boundary so
 * the rest of this service can work in raw scaled bigints throughout.
 */
const PRICE_SCALE = 10_000_000n;

export function scaledToDecimalString(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / PRICE_SCALE;
  const frac = (abs % PRICE_SCALE).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export function decimalStringToScaled(decimal: string): bigint {
  const negative = decimal.startsWith("-");
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const fracPadded = (fracPart + "0000000").slice(0, 7);
  const combined = BigInt(wholePart || "0") * PRICE_SCALE + BigInt(fracPadded || "0");
  return negative ? -combined : combined;
}
