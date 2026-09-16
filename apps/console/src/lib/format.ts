/**
 * Two different money-string shapes come back from services/api, and mixing them up produces a
 * value 1e7 off (see the audit fix in services/api/src/routes/credit-lines.ts): `/v1/positions`
 * passes Postgres `numeric` rows straight through as **decimal strings** ("50000000.0000000"),
 * while `/v1/credit-lines/:id` deliberately re-encodes as the on-chain **7-decimal-scaled bigint**
 * convention ("500000000000000"). Each formatter below is named for which shape it expects.
 */

export function formatDecimalString(value: string, ccy = ""): string {
  const n = Number(value);
  const formatted = Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : value;
  return ccy ? `${formatted} ${ccy}` : formatted;
}

export function formatScaledBigintString(value: string, ccy = ""): string {
  const scaled = BigInt(value);
  const whole = scaled / 10_000_000n;
  const frac = scaled % 10_000_000n;
  const decimal = Number(whole) + Number(frac) / 1e7;
  const formatted = decimal.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return ccy ? `${formatted} ${ccy}` : formatted;
}

export function toScaled(userInput: string): bigint {
  const [whole, frac = ""] = userInput.trim().split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole || "0") * 10_000_000n + BigInt(fracPadded || "0");
}

export function shortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 5)}...${addr.slice(-5)}`;
}

export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
