/** Small helpers shared by the mock issuer adapters — not part of the `IssuerAdapter` contract. */

export const SECONDS_PER_DAY = 24 * 60 * 60;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomRef(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
