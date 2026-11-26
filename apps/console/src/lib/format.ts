/**
 * Two different money-string shapes come back from services/api, and mixing them up produces a
 * value 1e7 off (see the audit fix in services/api/src/routes/credit-lines.ts): `/v1/positions`
 * passes Postgres `numeric` rows straight through as **decimal strings** ("50000000.0000000"),
 * while `/v1/credit-lines/:id` deliberately re-encodes as the on-chain **7-decimal-scaled bigint**
 * convention ("500000000000000"). Each formatter below is named for which shape it expects.
 */

/** Tokens carry 7 decimals on-chain; showing fewer would hide real units (e.g. 0.0004 of a unit). */
const MAX_FRACTION_DIGITS = 7;

export function formatDecimalString(value: string, ccy = ""): string {
  const n = Number(value);
  const formatted = Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: MAX_FRACTION_DIGITS })
    : value;
  return ccy ? `${formatted} ${ccy}` : formatted;
}

const warned = new Set<string>();

/**
 * A field that arrives in the wrong shape (a decimal string where a scaled integer is expected)
 * must not throw during render and blank the whole page: show a placeholder for that one cell.
 */
export function formatScaledBigintString(value: string, ccy = ""): string {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    const key = String(value);
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`formatScaledBigintString: expected a scaled integer string, got ${JSON.stringify(value)}`);
    }
    return "--";
  }
  const scaled = BigInt(value);
  const whole = scaled / 10_000_000n;
  const frac = scaled % 10_000_000n;
  const decimal = Number(whole) + Number(frac) / 1e7;
  const formatted = decimal.toLocaleString(undefined, { maximumFractionDigits: MAX_FRACTION_DIGITS });
  return ccy ? `${formatted} ${ccy}` : formatted;
}

export const AMOUNT_HINT = "Enter an amount like 100 or 100.25 (at most 7 decimal places).";

const AMOUNT_PATTERN = /^(\d+\.?\d{0,7}|\.\d{1,7})$/;

/**
 * Parses a user-typed amount into the on-chain 7-decimal integer. Throws a message fit to show
 * in the UI for anything that is not a plain non-negative decimal, instead of silently dropping
 * digits past the seventh or leaking a raw `BigInt` SyntaxError.
 */
export function toScaled(userInput: string): bigint {
  const text = userInput.trim();
  if (!AMOUNT_PATTERN.test(text)) throw new Error(AMOUNT_HINT);
  const [whole, frac = ""] = text.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole || "0") * 10_000_000n + BigInt(fracPadded);
}

export function shortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 5)}...${addr.slice(-5)}`;
}

export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * The margin band an LTV falls in, at the platform's default thresholds (70% / 80% / 90%, the ones
 * CreditLine and the API's release check use). Per-asset on-chain thresholds can differ, so this
 * labels a figure for the reader and does not decide anything.
 */
export function marginBand(ltvBps: number): "healthy" | "warning" | "margin call" | "liquidation" {
  if (ltvBps >= 9_000) return "liquidation";
  if (ltvBps >= 8_000) return "margin call";
  if (ltvBps >= 7_000) return "warning";
  return "healthy";
}

/** A duration in seconds as the largest whole-ish unit, e.g. 21600 -> "6 h". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${Number((seconds / 3600).toFixed(1))} h`;
  return `${Number((seconds / 86_400).toFixed(1))} d`;
}
