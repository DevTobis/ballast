import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth.tsx";
import { api, type AssetSummary, type BuiltTx, type CreditLineDetail, type PositionsResult } from "../lib/api.ts";
import { Panel } from "../components/Panel.tsx";
import { Button } from "../components/Button.tsx";
import { MarginBadge } from "../components/StatusBadge.tsx";
import { XdrOutput } from "../components/XdrOutput.tsx";
import { INPUT } from "../components/Field.tsx";
import { usePolling } from "../lib/usePolling.ts";
import { bpsToPercent, formatScaledBigintString, shortAddress, toScaled } from "../lib/format.ts";

/** How often open positions refresh on their own. */
const REFRESH_MS = 15_000;

export function LenderView() {
  const { session } = useAuth();
  const [positions, setPositions] = useState<PositionsResult | null>(null);
  const [details, setDetails] = useState<Record<string, CreditLineDetail>>({});
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [fundAmounts, setFundAmounts] = useState<Record<string, string>>({});
  const [withdrawAmounts, setWithdrawAmounts] = useState<Record<string, string>>({});
  const [tx, setTx] = useState<BuiltTx | null>(null);
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // `silent` refreshes in the background without flashing the loading state over the list.
  async function reload(silent = false) {
    if (!session) return;
    if (!silent) setLoading(true);
    try {
      const pos = await api.positions(session.token, session.partyId);
      setPositions(pos);
      const mine = pos.creditLines.filter((l) => l.lenderId === session.partyId);
      // One bad line must not hide the margin status of the rest of the book.
      const results = await Promise.allSettled(mine.map((l) => api.creditLine(session.token, l.id)));
      const loaded: Record<string, CreditLineDetail> = {};
      const failed: Record<string, string> = {};
      results.forEach((r, i) => {
        if (r.status === "fulfilled") loaded[r.value.id] = r.value;
        else failed[mine[i].id] = r.reason instanceof Error ? r.reason.message : "could not load";
      });
      // A line whose refresh failed keeps its last good detail rather than blanking.
      setDetails((prev) => ({
        ...Object.fromEntries(Object.entries(prev).filter(([id]) => id in failed)),
        ...loaded,
      }));
      setLineErrors(failed);
      setAssets((await api.assets(session.token)).assets);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load positions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.partyId]);

  usePolling(() => reload(true), REFRESH_MS, Boolean(session));

  if (!session) return null;
  const myLines = positions?.creditLines.filter((l) => l.lenderId === session.partyId) ?? [];

  const atRisk = myLines.filter((l) => {
    const state = details[l.id]?.marginState;
    return state === "MarginCall" || state === "Liquidation";
  });

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-xs text-accent">ERROR: {error}</p>}

      <Panel title="Exposure Summary">
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
          <div>
            <div className="text-fg-dim uppercase tracking-wider">Lines</div>
            <div className="text-fg">{myLines.length}</div>
          </div>
          <div>
            <div className="text-fg-dim uppercase tracking-wider">In default watch</div>
            <div className={atRisk.length > 0 ? "text-accent" : "text-ok"}>{atRisk.length}</div>
          </div>
        </div>
      </Panel>

      <OpenLineForm assets={assets} onBuilt={setTx} />

      <Panel title="Lines / margin status">
        {loading && <p className="text-xs text-fg-dim">LOADING...</p>}
        {!loading && myLines.length === 0 && (
          <p className="text-xs text-fg-dim">No lines lent from this account.</p>
        )}
        <div className="flex flex-col divide-y divide-line">
          {myLines.map((line) => {
            const d = details[line.id];
            return (
              <div key={line.id} className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-center">
                <span className="text-xs text-fg-dim">
                  LINE / {line.id.slice(0, 8)} <span className="text-fg">{line.status.toUpperCase()}</span>
                  <br />
                  <span className="text-fg">BORROWER {shortAddress(line.borrowerId)}</span>
                  {lineErrors[line.id] && (
                    <span className="mt-1 flex items-center gap-2 text-accent">
                      could not load details
                      <Button onClick={() => reload()}>Retry</Button>
                    </span>
                  )}
                </span>
                <span className="text-xs">
                  LIMIT <span className="text-fg">{d ? formatScaledBigintString(d.limit, d.loanCcy) : "..."}</span>
                </span>
                <span className="text-xs">
                  DRAWN <span className="text-fg">{d ? formatScaledBigintString(d.drawn, d.loanCcy) : "..."}</span>
                </span>
                <span className="text-xs">
                  LTV <span className="text-fg">{d ? bpsToPercent(d.ltvBps) : "..."}</span>
                  {d && (
                    <>
                      {" "}
                      <MarginBadge state={d.marginState} />
                    </>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <input
                    value={fundAmounts[line.id] ?? ""}
                    onChange={(e) => setFundAmounts((prev) => ({ ...prev, [line.id]: e.target.value }))}
                    placeholder="fund amt"
                    className="w-24 border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-fg"
                  />
                  <Button
                    disabled={busyId === line.id || tx !== null || !fundAmounts[line.id] || !line.contractLineId}
                    onClick={async () => {
                      setBusyId(line.id);
                      setError(null);
                      try {
                        const res = await api.fund(session.token, line.id, toScaled(fundAmounts[line.id]));
                        setTx(res);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "fund failed");
                      } finally {
                        setBusyId(null);
                      }
                    }}
                  >
                    Fund
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2 sm:col-span-5">
                  <span className="text-xs uppercase tracking-wider text-fg-dim">
                    Undrawn{" "}
                    <span className="text-fg">{d && d.undrawn !== null ? formatScaledBigintString(d.undrawn, d.loanCcy) : "..."}</span>
                    {" / "}Interest{" "}
                    <span className="text-fg">
                      {d && d.claimableInterest !== null ? formatScaledBigintString(d.claimableInterest, d.loanCcy) : "..."}
                    </span>
                  </span>
                  <input
                    value={withdrawAmounts[line.id] ?? ""}
                    onChange={(e) => setWithdrawAmounts((prev) => ({ ...prev, [line.id]: e.target.value }))}
                    placeholder="withdraw amt"
                    inputMode="decimal"
                    className="w-28 border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-fg"
                  />
                  {(["undrawn", "interest"] as const).map((kind) => (
                    <Button
                      key={kind}
                      disabled={busyId === line.id || tx !== null || !withdrawAmounts[line.id] || !line.contractLineId}
                      onClick={async () => {
                        setBusyId(line.id);
                        setError(null);
                        try {
                          setTx(await api.withdraw(session.token, line.id, kind, toScaled(withdrawAmounts[line.id])));
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "withdraw failed");
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      Withdraw {kind}
                    </Button>
                  ))}
                </div>
                {line.status === "liquidating" && (
                  <div className="flex flex-wrap items-center gap-3 border border-accent p-2 sm:col-span-5">
                    <p className="flex-1 text-xs leading-relaxed text-fg-dim">
                      LIQUIDATED. The collateral has been sent to you in kind. Closing books it at the price
                      confirmed when the breach was flagged. If it is worth more than the debt you pay the
                      difference to the borrower in USDC in the same transaction.
                    </p>
                    <Button
                      disabled={busyId === line.id || tx !== null}
                      onClick={async () => {
                        setBusyId(line.id);
                        setError(null);
                        try {
                          setTx(await api.closeLiquidation(session.token, line.id));
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "close failed");
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      Close liquidated line
                    </Button>
                  </div>
                )}
                {d?.liquidation?.closed && (
                  <dl className="grid grid-cols-2 gap-px bg-line text-xs sm:col-span-5 sm:grid-cols-4">
                    {(
                      [
                        ["Debt at liquidation", d.liquidation.debt],
                        ["Collateral value", d.liquidation.recovered],
                        ["Paid to borrower", d.liquidation.surplus],
                        ["Shortfall (loss)", d.liquidation.shortfall],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="bg-bg-raised p-2">
                        <dt className="uppercase tracking-wider text-fg-dim">{label}</dt>
                        <dd className={label.startsWith("Shortfall") && /^\d+$/.test(value) && BigInt(value) > 0n ? "text-accent" : "text-fg"}>
                          {formatScaledBigintString(value, d.loanCcy)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      </Panel>

      {tx && (
        <XdrOutput
          key={tx.txHash}
          tx={tx}
          onDismiss={() => {
            setTx(null);
            reload();
          }}
        />
      )}
    </div>
  );
}


/** Opens a new line: the lender names the borrower by Stellar account, the API resolves the party. */
function OpenLineForm({ assets, onBuilt }: { assets: AssetSummary[]; onBuilt: (tx: BuiltTx) => void }) {
  const { session } = useAuth();
  const [borrower, setBorrower] = useState("");
  const [assetId, setAssetId] = useState("");
  const [limit, setLimit] = useState("");
  const [ratePct, setRatePct] = useState("7");
  const [cureHours, setCureHours] = useState("24");
  const [loanCcy, setLoanCcy] = useState("USDC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const asset = assets.find((a) => a.id === assetId) ?? assets[0];
  const rateBps = Math.round(Number(ratePct) * 100);
  const cureWindowS = Math.round(Number(cureHours) * 3600);
  const valid = Boolean(asset && borrower.trim() && limit && rateBps >= 0 && cureWindowS > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !asset) return;
    setBusy(true);
    setError(null);
    try {
      const party = await api.partyByAccount(session.token, borrower.trim());
      onBuilt(
        await api.openCreditLine(session.token, {
          lenderId: session.partyId,
          borrowerId: party.partyId,
          loanCcy: loanCcy.trim().toUpperCase(),
          limit: toScaled(limit),
          rateBps,
          cureWindowS,
          asset: asset.contractC,
        }),
      );
      setBorrower("");
      setLimit("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not build the opening transaction");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Open credit line">
      <form onSubmit={submit} className="grid grid-cols-1 gap-2 sm:grid-cols-6">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-fg-dim sm:col-span-3">
          Borrower account
          <input
            value={borrower}
            onChange={(e) => setBorrower(e.target.value)}
            placeholder="G..."
            spellCheck={false}
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-fg-dim sm:col-span-2">
          Collateral asset
          <select value={asset?.id ?? ""} onChange={(e) => setAssetId(e.target.value)} className={INPUT}>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} / haircut {bpsToPercent(a.haircutBps)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-fg-dim">
          Loan ccy
          <input value={loanCcy} onChange={(e) => setLoanCcy(e.target.value)} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-fg-dim sm:col-span-2">
          Limit
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="10000.00"
            inputMode="decimal"
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-fg-dim">
          APR %
          <input value={ratePct} onChange={(e) => setRatePct(e.target.value)} inputMode="decimal" className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-fg-dim">
          Cure window h
          <input value={cureHours} onChange={(e) => setCureHours(e.target.value)} inputMode="decimal" className={INPUT} />
        </label>
        <div className="flex items-end sm:col-span-2">
          <Button type="submit" disabled={busy || !valid} className="w-full">
            {busy ? "BUILDING..." : "BUILD OPEN TX"}
          </Button>
        </div>
      </form>
      {error && <p className="mt-2 text-xs text-accent">ERROR: {error}</p>}
      {assets.length === 0 && <p className="mt-2 text-xs text-fg-dim">No collateral assets are listed yet.</p>}
    </Panel>
  );
}
