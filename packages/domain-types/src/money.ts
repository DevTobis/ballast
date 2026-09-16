/**
 * Conversions between the two money representations that meet at every service boundary in
 * Ballast: Postgres `numeric` columns (`packages/db/src/schema.ts`), which Drizzle/`postgres`
 * round-trip as **decimal strings** (e.g. `"123.4567890"`), and on-chain amounts, which are raw
 * **7-decimal-scaled bigints** (e.g. `1234567890n` for the same value — see `PRICE_SCALE`).
 *
 * A service that reads a money column and passes it straight into a contract-clients call (or
 * vice versa) without going through one of these two functions is off by a factor of 1e7. Both
 * `services/ledger` and `services/api` must use these — do not re-derive a local copy.
 */
import { PRICE_SCALE } from "./price.js";

export function scaledToDecimalString(raw: bigint): string {
  if (raw < 0n) throw new Error("money: amount must not be negative");
  const whole = raw / PRICE_SCALE;
  const frac = (raw % PRICE_SCALE).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

/** Postgres `numeric` money columns round-trip as decimal strings, not numbers — parse by hand. */
export function decimalStringToScaled(decimal: string): bigint {
  const negative = decimal.startsWith("-");
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const fracPadded = (fracPart + "0000000").slice(0, 7);
  const combined = BigInt(wholePart || "0") * PRICE_SCALE + BigInt(fracPadded || "0");
  return negative ? -combined : combined;
}
