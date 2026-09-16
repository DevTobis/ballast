import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth.tsx";
import { Panel } from "../components/Panel.tsx";
import { Button } from "../components/Button.tsx";

export function Login() {
  const { login, loading, error } = useAuth();
  const [stellarAccount, setStellarAccount] = useState("");
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await login(stellarAccount.trim());
    navigate("/", { replace: true });
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-3xl font-bold uppercase tracking-tighter">BALLAST</h1>
        <p className="mb-6 text-xs uppercase tracking-[0.15em] text-fg-dim">
          Collateral / liquidity terminal
        </p>

        <Panel title="Operator Access">
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wider text-fg-dim">
                Stellar account (G...)
              </span>
              <input
                required
                value={stellarAccount}
                onChange={(e) => setStellarAccount(e.target.value)}
                placeholder="GABCDEF..."
                className="border border-line bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-fg"
              />
            </label>
            <Button type="submit" disabled={loading}>
              {loading ? "CONNECTING..." : "CONNECT"}
            </Button>
            {error && <p className="text-xs text-accent">ERROR: {error}</p>}
          </form>
        </Panel>

        <p className="mt-4 border border-line p-2 text-xs leading-relaxed text-fg-dim">
          DEV MODE. This resolves a party from an already-linked Stellar account with no
          signature check, standing in for a real SEP-10 challenge/response. Local and testnet
          deployments only, never production.
        </p>
      </div>
    </div>
  );
}
