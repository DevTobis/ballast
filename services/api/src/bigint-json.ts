/**
 * `JSON.stringify` has no native bigint support, and Ballast's on-chain amounts (i128 stroops)
 * are represented as `bigint` in TypeScript to avoid precision loss. Rather than hand-convert at
 * every response site, every bigint serializes to its decimal string (e.g. `10000000n` ->
 * `"10000000"`) — safe here because these values are always whole stroop counts, never floats.
 * Import this once, before any route handler runs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export {};
