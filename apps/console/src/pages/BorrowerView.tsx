import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth.tsx";
import {
  api,
  type AssetSummary,
  type BuiltTx,
  type CreditLineDetail,
  type PledgeRow,
  type PositionsResult,
} from "../lib/api.ts";
import { Panel } from "../components/Panel.tsx";
import { Button } from "../components/Button.tsx";
import { MarginBadge, PriceStatusBadge } from "../components/StatusBadge.tsx";
import { XdrOutput } from "../components/XdrOutput.tsx";
import { usePolling } from "../lib/usePolling.ts";
import {
  bpsToPercent,
  formatDecimalString,
  formatDuration,
  formatScaledBigintString,
  toScaled,
} from "../lib/format.ts";

/** Riskiest first, so the line that needs attention is the one at the top of the list. */
const RISK_ORDER: Record<CreditLineDetail["marginState"], number> = {
  Liquidation: 0,
  MarginCall: 1,
  Warning: 2,
  Healthy: 3,
};

/** How often open positions refresh on their own. */
const REFRESH_MS = 15_000;

export function BorrowerView() {
  const { session } = useAuth();
  const [positions, setPositions] = useState<PositionsResult | null>(null);
  const [details, setDetails] = useState<Record<string, CreditLineDetail>>({});
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // `silent` refreshes in the background without flashing the loading state over the list.
  async function reload(silent = false) {
    if (!session) return;
    if (!silent) setLoading(true);
    try {
      const pos = await api.positions(session.token, session.partyId);
      setPositions(pos);
      const mine = pos.creditLines.filter((l) => l.borrowerId === session.partyId);
      // One bad line must not hide the detail of every other line.
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
      const { assets } = await api.assets(session.token);
      setAssets(assets);
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
  const myLines = [...(positions?.creditLines.filter((l) => l.borrowerId === session.partyId) ?? [])].sort(
    (a, b) =>
      (details[a.id] ? RISK_ORDER[details[a.id].marginState] : 4) -
      (details[b.id] ? RISK_ORDER[details[b.id].marginState] : 4),
  );
  const myPledges = positions?.pledges ?? [];
  const selected = selectedId ? details[selectedId] : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr]">
      <Panel title="My Credit Lines">
        {error && <p className="mb-2 text-xs text-accent">{error}</p>}
        {loading && <p className="text-xs text-fg-dim">LOADING...</p>}
        {!loading && myLines.length === 0 && (
          <p className="text-xs text-fg-dim">No credit lines found for this account.</p>
        )}
        <div className="flex flex-col divide-y divide-line">
          {myLines.map((line) => {
            const d = details[line.id];
            const failure = lineErrors[line.id];
            return (
              <div key={line.id} className="flex items-center justify-between gap-2">
                <button
                  onClick={() => setSelectedId(line.id)}
                  className={`flex flex-1 items-center justify-between gap-3 py-2 text-left text-xs hover:text-fg ${
                    selectedId === line.id ? "text-fg" : "text-fg-dim"
                  }`}
                >
                  <span>
                    LINE / {line.id.slice(0, 8)} <span className="text-fg-dim">{line.loanCcy}</span>
                    {d && (
                      <span className="ml-2 text-fg-dim">
                        {formatScaledBigintString(d.drawn)} / {formatScaledBigintString(d.limit)} / LTV{" "}
                        {bpsToPercent(d.ltvBps)}
                      </span>
                    )}
                  </span>
                  {d ? <MarginBadge state={d.marginState} /> : failure ? null : <span>...</span>}
                </button>
                {failure && (
                  <span className="flex items-center gap-2 text-xs text-accent">
                    could not load
                    <Button onClick={() => reload()}>Retry</Button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Panel>

      {selected ? (
        <BorrowerLineDetail
          key={selected.id}
          detail={selected}
          pledges={myPledges.filter((p) => p.creditLineId === selected.id)}
          assets={assets}
          onChanged={reload}
        />
      ) : (
        <Panel title="Line Detail">
          <p className="text-xs text-fg-dim">Select a credit line to view headroom and take action.</p>
        </Panel>
      )}
    </div>
  );
}

function BorrowerLineDetail({
  detail,
  pledges,
  assets,
  onChanged,
}: {
  detail: CreditLineDetail;
  pledges: PledgeRow[];
  assets: AssetSummary[];
  onChanged: () => void;
}) {
  const { session } = useAuth();
  const [tx, setTx] = useState<BuiltTx | null>(null);
  const [drawAmount, setDrawAmount] = useState("");
  const [drawTo, setDrawTo] = useState(session?.stellarAccount ?? "");
  const [repayAmount, setRepayAmount] = useState("");
  // Assets can arrive after this panel mounts, so the default is derived rather than copied into state.
  const [chosenAssetId, setChosenAssetId] = useState("");
  const pledgeAssetId = chosenAssetId || assets[0]?.id || "";
  const [pledgeUnits, setPledgeUnits] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Distance to 100% LTV, the point where debt equals collateral value. The healthy threshold is
  // set per asset on-chain and is not part of this response, so it is not claimed here.
  const headroom = 10_000 - detail.ltvBps;
  // A second built transaction would replace the one still waiting for a signature or a verdict.
  const txOpen = tx !== null;

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title={`Headroom / ${detail.id.slice(0, 8)}`}>
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <Stat label="Limit" value={formatScaledBigintString(detail.limit, detail.loanCcy)} />
          <Stat label="Drawn" value={formatScaledBigintString(detail.drawn, detail.loanCcy)} />
          <Stat label="LTV" value={bpsToPercent(detail.ltvBps)} />
          <div>
            <div className="text-fg-dim uppercase tracking-wider">State</div>
            <MarginBadge state={detail.marginState} />
          </div>
        </div>
        <p className="mt-3 text-xs text-fg-dim">
          Headroom to 100% LTV: <span className="text-fg">{bpsToPercent(Math.max(headroom, 0))}</span>
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs sm:grid-cols-4">
          <Stat
            label="Funded"
            value={detail.funded ? formatScaledBigintString(detail.funded, detail.loanCcy) : "--"}
          />
          <Stat
            label="Collateral value"
            value={detail.collateralValue ? formatScaledBigintString(detail.collateralValue, "USD") : "--"}
          />
          <div className="col-span-2">
            <div className="text-fg-dim uppercase tracking-wider">Oracle</div>
            {detail.priceStatus ? <PriceStatusBadge status={detail.priceStatus} /> : <span className="text-fg-dim">--</span>}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs sm:grid-cols-4">
          <Stat label="APR" value={bpsToPercent(detail.rateBps)} />
          <Stat label="Fee" value={bpsToPercent(detail.feeBps)} />
          <Stat label="Cure window" value={formatDuration(detail.cureWindowS)} />
        </div>
        {!detail.contractLineId && (
          <p className="mt-3 text-xs text-fg-dim">
            /// NOT ON-CHAIN YET. The lender still has to sign the opening transaction.
          </p>
        )}
      </Panel>

      <Panel title="Draw">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={drawAmount}
            onChange={(e) => setDrawAmount(e.target.value)}
            placeholder="amount (e.g. 500.00)"
            className="flex-1 border border-line bg-bg px-2 py-1.5 text-xs outline-none focus:border-fg"
          />
          <input
            value={drawTo}
            onChange={(e) => setDrawTo(e.target.value)}
            placeholder="destination G..."
            className="flex-1 border border-line bg-bg px-2 py-1.5 text-xs outline-none focus:border-fg"
          />
          <Button
            disabled={busy || txOpen || !drawAmount || !drawTo}
            onClick={() =>
              withBusy(async () => {
                if (!session) return;
                const res = await api.draw(session.token, detail.id, toScaled(drawAmount), drawTo);
                setTx(res);
              })
            }
          >
            Build draw tx
          </Button>
        </div>
      </Panel>

      <Panel title="Repay">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={repayAmount}
            onChange={(e) => setRepayAmount(e.target.value)}
            placeholder="amount (e.g. 500.00)"
            className="flex-1 border border-line bg-bg px-2 py-1.5 text-xs outline-none focus:border-fg"
          />
          <Button
            disabled={busy || txOpen || !repayAmount}
            onClick={() =>
              withBusy(async () => {
                if (!session) return;
                const res = await api.repay(session.token, detail.id, toScaled(repayAmount));
                setTx(res);
              })
            }
          >
            Build repay tx
          </Button>
        </div>
      </Panel>

      <Panel title="Pledge collateral">
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={pledgeAssetId}
            onChange={(e) => setChosenAssetId(e.target.value)}
            className="border border-line bg-bg px-2 py-1.5 text-xs outline-none focus:border-fg"
          >
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code}
              </option>
            ))}
          </select>
          <input
            value={pledgeUnits}
            onChange={(e) => setPledgeUnits(e.target.value)}
            placeholder="units"
            className="flex-1 border border-line bg-bg px-2 py-1.5 text-xs outline-none focus:border-fg"
          />
          <Button
            disabled={busy || txOpen || !pledgeUnits || !pledgeAssetId}
            onClick={() =>
              withBusy(async () => {
                if (!session) return;
                const asset = assets.find((a) => a.id === pledgeAssetId);
                const res = await api.pledge(
                  session.token,
                  detail.id,
                  pledgeAssetId,
                  toScaled(pledgeUnits),
                  asset?.custodyMode ?? "escrow",
                );
                setTx(res);
              })
            }
          >
            Build pledge tx
          </Button>
        </div>
        {pledges.length > 0 && (
          <div className="mt-3 flex flex-col divide-y divide-line text-xs">
            {pledges.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-1.5">
                <span className="text-fg-dim">
                  {p.status} / {formatDecimalString(p.units)} units
                </span>
                <Button
                  disabled={busy || txOpen || p.status !== "active"}
                  onClick={() =>
                    withBusy(async () => {
                      if (!session) return;
                      const res = await api.releasePledge(session.token, detail.id, p.id);
                      setTx(res);
                    })
                  }
                >
                  Release
                </Button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {actionError && <p className="text-xs text-accent">ERROR: {actionError}</p>}
      {txOpen && (
        <p className="text-xs text-fg-dim">Finish or dismiss the open transaction below before building another.</p>
      )}
      {tx && (
        <XdrOutput
          key={tx.txHash}
          tx={tx}
          onDismiss={() => {
            setTx(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-fg-dim uppercase tracking-wider">{label}</div>
      <div className="text-fg">{value}</div>
    </div>
  );
}
