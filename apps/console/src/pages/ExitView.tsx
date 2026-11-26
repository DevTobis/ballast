import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth.tsx";
import { api, type AssetSummary, type BuiltTx, type ExitQuoteResult, type ExitQuoteRow } from "../lib/api.ts";
import { Panel } from "../components/Panel.tsx";
import { Button } from "../components/Button.tsx";
import { Field, INPUT, Stat } from "../components/Field.tsx";
import { PriceStatusBadge } from "../components/StatusBadge.tsx";
import { XdrOutput } from "../components/XdrOutput.tsx";
import { bpsToPercent, formatDecimalString, formatScaledBigintString, toScaled } from "../lib/format.ts";

/** How far below the quote the payout may land before the contract refuses the exit. */
const SLIPPAGE_BPS = 50n;

/**
 * Instant exit: sell an RWA position to the desk for USDC in one transaction. A quote is a
 * read of the desk's current price and lasts about a minute; executing it re-quotes on-chain and
 * only goes through if the payout is still within the slippage bound.
 */
export function ExitView() {
  const { session } = useAuth();
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [history, setHistory] = useState<ExitQuoteRow[]>([]);
  const [assetId, setAssetId] = useState("");
  const [units, setUnits] = useState("");
  const [to, setTo] = useState(session?.stellarAccount ?? "");
  const [quote, setQuote] = useState<ExitQuoteResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [tx, setTx] = useState<BuiltTx | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (!session) return;
    try {
      const [{ assets }, positions] = await Promise.all([
        api.assets(session.token),
        api.positions(session.token, session.partyId),
      ]);
      setAssets(assets);
      setHistory(positions.exitQuotes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.partyId]);

  useEffect(() => {
    if (!quote) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.round((new Date(quote.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [quote]);

  if (!session) return null;
  const asset = assets.find((a) => a.id === assetId) ?? assets[0];
  const expired = quote !== null && secondsLeft === 0;
  // The quote is for the asset it was requested for, not whatever the selector shows now.
  const quotedAsset = quote ? assets.find((a) => a.id === quote.assetId) : undefined;
  // What the seller actually nets per unit once the spread is taken out of the desk price.
  const effectiveRate =
    quote && /^\d+$/.test(quote.usdcOut) && /^\d+$/.test(quote.units) && BigInt(quote.units) > 0n
      ? formatScaledBigintString(((BigInt(quote.usdcOut) * 10_000_000n) / BigInt(quote.units)).toString())
      : null;

  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="flex flex-col gap-4">
        <Panel title="Exit desk / quote">
          <form
            className="grid grid-cols-1 gap-2 sm:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              guarded(async () => {
                if (!asset) return;
                setTx(null);
                setQuote(await api.exitQuote(session.token, asset.id, toScaled(units)));
              });
            }}
          >
            <Field label="Asset" className="sm:col-span-2">
              <select value={asset?.id ?? ""} onChange={(e) => setAssetId(e.target.value)} className={INPUT}>
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Units">
              <input
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                placeholder="100.00"
                inputMode="decimal"
                className={INPUT}
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={busy || !asset || !units} className="w-full">
                {busy ? "WORKING..." : "GET QUOTE"}
              </Button>
            </div>
          </form>
          {asset && (
            <div className="mt-3 flex items-center gap-3 text-xs text-fg-dim">
              <span>ORACLE</span>
              {asset.price ? <PriceStatusBadge status={asset.price.status} /> : <span>NO PRICE YET</span>}
            </div>
          )}
          {assets.length === 0 && <p className="mt-2 text-xs text-fg-dim">No assets are listed yet.</p>}
        </Panel>

        {quote && (
          <Panel title={`Quote / ${quote.id.slice(0, 8)}`}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="You sell">{formatScaledBigintString(quote.units, quotedAsset?.code)}</Stat>
              <Stat label="You receive">{formatScaledBigintString(quote.usdcOut, "USDC")}</Stat>
              <Stat label="Desk price">{formatScaledBigintString(quote.price, "USD")}</Stat>
              <Stat label="Effective rate">{effectiveRate ? `${effectiveRate} USDC / unit` : "--"}</Stat>
              <Stat label="Spread">{bpsToPercent(quote.spreadBps)}</Stat>
              <Stat label="Valid for">
                <span className={expired ? "text-accent" : "text-ok"}>{expired ? "EXPIRED" : `${secondsLeft}s`}</span>
              </Stat>
            </dl>
            <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-end">
              <Field label="Pay USDC to" className="flex-1">
                <input value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} className={INPUT} />
              </Field>
              <Button
                disabled={busy || expired || !to}
                onClick={() =>
                  guarded(async () => {
                    const floor = (BigInt(quote.usdcOut) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
                    setTx(await api.exitExecute(session.token, quote.id, floor, to.trim()));
                  })
                }
              >
                BUILD EXIT TX
              </Button>
            </div>
            <p className="mt-2 text-xs text-fg-dim">
              /// The contract re-prices at execution and refuses to pay less than{" "}
              {bpsToPercent(Number(SLIPPAGE_BPS))} below this quote.
            </p>
          </Panel>
        )}

        {error && <p className="text-xs text-accent">ERROR: {error}</p>}
        {tx && (
          <XdrOutput
            key={tx.txHash}
            tx={tx}
            onDismiss={() => {
              setTx(null);
              setQuote(null);
              reload();
            }}
          />
        )}
      </div>

      <Panel title="Quote log">
        {history.length === 0 && <p className="text-xs text-fg-dim">No exits requested from this account.</p>}
        <div className="flex flex-col divide-y divide-line">
          {[...history].reverse().map((q) => (
            <div key={q.id} className="grid grid-cols-[1fr_1fr_auto] gap-2 py-2 text-xs">
              <span className="text-fg-dim">
                {formatDecimalString(q.units)} {assets.find((a) => a.id === q.assetId)?.code ?? "UNITS"}
              </span>
              <span className="text-fg">{formatDecimalString(q.usdcOut, "USDC")}</span>
              <span className={`uppercase tracking-wider ${q.status === "filled" ? "text-ok" : "text-fg-dim"}`}>
                {q.status}
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
