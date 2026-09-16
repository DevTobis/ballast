import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth.tsx";
import { api, type AssetSummary, type CreditLineDetail, type PledgeRow, type PositionsResult } from "../lib/api.ts";
import { Panel } from "../components/Panel.tsx";
import { Button } from "../components/Button.tsx";
import { MarginBadge } from "../components/StatusBadge.tsx";
import { XdrOutput } from "../components/XdrOutput.tsx";
import { bpsToPercent, formatScaledBigintString, toScaled } from "../lib/format.ts";

export function BorrowerView() {
  const { session } = useAuth();
  const [positions, setPositions] = useState<PositionsResult | null>(null);
  const [details, setDetails] = useState<Record<string, CreditLineDetail>>({});
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    if (!session) return;
    setLoading(true);
    try {
      const pos = await api.positions(session.token, session.partyId);
      setPositions(pos);
      const mine = pos.creditLines.filter((l) => l.borrowerId === session.partyId);
      const entries = await Promise.all(mine.map((l) => api.creditLine(session.token, l.id)));
      setDetails(Object.fromEntries(entries.map((d) => [d.id, d])));
      const { assets } = await api.assets(session.token);
      setAssets(assets);
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

  if (!session) return null;
  const myLines = positions?.creditLines.filter((l) => l.borrowerId === session.partyId) ?? [];
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
            return (
              <button
                key={line.id}
                onClick={() => setSelectedId(line.id)}
                className={`flex items-center justify-between py-2 text-left text-xs hover:text-fg ${
                  selectedId === line.id ? "text-fg" : "text-fg-dim"
                }`}
              >
                <span>
                  LINE / {line.id.slice(0, 8)} <span className="text-fg-dim">{line.loanCcy}</span>
                </span>
                {d ? <MarginBadge state={d.marginState} /> : <span>...</span>}
              </button>
            );
          })}
        </div>
      </Panel>

      {selected ? (
        <BorrowerLineDetail
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
  const [xdr, setXdr] = useState<string | null>(null);
  const [drawAmount, setDrawAmount] = useState("");
  const [drawTo, setDrawTo] = useState("");
  const [repayAmount, setRepayAmount] = useState("");
  const [pledgeAssetId, setPledgeAssetId] = useState(assets[0]?.id ?? "");
  const [pledgeUnits, setPledgeUnits] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const headroom = 10_000 - detail.ltvBps;

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
          Headroom before the healthy threshold: <span className="text-fg">{bpsToPercent(Math.max(headroom, 0))}</span>
        </p>
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
            disabled={busy || !drawAmount || !drawTo}
            onClick={() =>
              withBusy(async () => {
                if (!session) return;
                const res = await api.draw(session.token, detail.id, toScaled(drawAmount), drawTo);
                setXdr(res.xdr);
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
            disabled={busy || !repayAmount}
            onClick={() =>
              withBusy(async () => {
                if (!session) return;
                const res = await api.repay(session.token, detail.id, toScaled(repayAmount));
                setXdr(res.xdr);
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
            onChange={(e) => setPledgeAssetId(e.target.value)}
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
            disabled={busy || !pledgeUnits || !pledgeAssetId}
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
                setXdr(res.xdr);
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
                  {p.status} / {p.units} units
                </span>
                <Button
                  disabled={busy}
                  onClick={() =>
                    withBusy(async () => {
                      if (!session) return;
                      const res = await api.releasePledge(session.token, detail.id, p.id);
                      setXdr(res.xdr);
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
      {xdr && <XdrOutput xdr={xdr} onDismiss={() => { setXdr(null); onChanged(); }} />}
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
