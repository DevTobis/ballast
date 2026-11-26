export const LEDGER_CLOSE_SECONDS = 5;
export const DEFAULT_LAG_ALERT_SECONDS = 60;

/**
 * Determines whether the lag between the chain tip (`latest`) and the
 * indexer's scanned/ingested ledger (`from`) exceeds the threshold in `seconds`.
 *
 * Each ledger takes approximately 5 seconds to close.
 * If seconds is NaN, non-finite, or <= 0, it defaults to DEFAULT_LAG_ALERT_SECONDS (60).
 */
export function shouldAlertLag(
  latest: number,
  from: number,
  seconds: number = DEFAULT_LAG_ALERT_SECONDS,
): boolean {
  const effectiveSeconds =
    typeof seconds === "number" && !Number.isNaN(seconds) && Number.isFinite(seconds) && seconds > 0
      ? seconds
      : DEFAULT_LAG_ALERT_SECONDS;

  const thresholdLedgers = Math.ceil(effectiveSeconds / LEDGER_CLOSE_SECONDS);
  const lagLedgers = latest - from;
  return lagLedgers > thresholdLedgers;
}
