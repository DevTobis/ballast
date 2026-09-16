import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth.tsx";
import { api, type CreditLineDetail, type PositionsResult } from "../lib/api.ts";
import { Panel } from "../components/Panel.tsx";
import { Button } from "../components/Button.tsx";
import { MarginBadge } from "../components/StatusBadge.tsx";
import { XdrOutput } from "../components/XdrOutput.tsx";
import { bpsToPercent, formatScaledBigintString, shortAddress, toScaled } from "../lib/format.ts";

export function LenderView() {
  const { session } = useAuth();
  const [positions, setPositions] = useState<PositionsResult | null>(null);
  const [details, setDetails] = useState<Record<string, CreditLineDetail>>({});
  const [fundAmounts, setFundAmounts] = useState<Record<string, string>>({});
  const [xdr, setXdr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    if (!session) return;
    setLoading(true);
    try {
      const pos = await api.positions(session.token, session.partyId);
      setPositions(pos);
      const mine = pos.creditLines.filter((l) => l.lenderId === session.partyId);
      const entries = await Promise.all(mine.map((l) => api.creditLine(session.token, l.id)));
      setDetails(Object.fromEntries(entries.map((d) => [d.id, d])));
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
                  LINE / {line.id.slice(0, 8)}
                  <br />
                  <span className="text-fg">BORROWER {shortAddress(line.borrowerId)}</span>
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
                    disabled={busyId === line.id || !fundAmounts[line.id]}
                    onClick={async () => {
                      setBusyId(line.id);
                      setError(null);
                      try {
                        const res = await api.fund(session.token, line.id, toScaled(fundAmounts[line.id]));
                        setXdr(res.xdr);
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
              </div>
            );
          })}
        </div>
      </Panel>

      {xdr && <XdrOutput xdr={xdr} onDismiss={() => { setXdr(null); reload(); }} />}
    </div>
  );
}
