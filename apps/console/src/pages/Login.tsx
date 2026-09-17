import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isAllowed, isConnected } from "@stellar/freighter-api";
import { useAuth } from "../lib/auth.tsx";
import { Panel } from "../components/Panel.tsx";
import { Button } from "../components/Button.tsx";

type WalletState = "checking" | "not-installed" | "ready";

export function Login() {
  const { login, loading, error } = useAuth();
  const navigate = useNavigate();
  const [walletState, setWalletState] = useState<WalletState>("checking");

  useEffect(() => {
    let cancelled = false;
    async function checkWallet() {
      const connected = await isConnected();
      if (cancelled) return;
      if (connected.error || !connected.isConnected) {
        setWalletState("not-installed");
        return;
      }
      setWalletState("ready");
    }
    checkWallet();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onConnect() {
    // `isAllowed()` primes Freighter's own access-granted state; `login()`'s `requestAccess()`
    // still prompts the user if this origin hasn't been approved yet, so this is best-effort.
    await isAllowed();
    await login();
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
          <div className="flex flex-col gap-3">
            {walletState === "checking" && (
              <p className="text-xs uppercase tracking-wider text-fg-dim">Checking for Freighter...</p>
            )}

            {walletState === "not-installed" && (
              <>
                <p className="text-xs leading-relaxed text-fg-dim">
                  No Stellar wallet extension detected. Install Freighter to authenticate — Ballast
                  never asks for a raw secret key.
                </p>
                <a
                  href="https://www.freighter.app/"
                  target="_blank"
                  rel="noreferrer"
                  className="border border-fg px-3 py-1.5 text-center text-xs uppercase tracking-[0.1em] text-fg transition-transform hover:bg-fg hover:text-bg active:scale-[0.98]"
                >
                  Install Freighter
                </a>
              </>
            )}

            {walletState === "ready" && (
              <Button type="button" onClick={onConnect} disabled={loading}>
                {loading ? "CONNECTING..." : "CONNECT FREIGHTER"}
              </Button>
            )}

            {error && <p className="text-xs text-accent">ERROR: {error}</p>}
          </div>
        </Panel>

        <p className="mt-4 border border-line p-2 text-xs leading-relaxed text-fg-dim">
          Authentication is real SEP-10: Ballast issues a challenge transaction, Freighter signs it
          with your account's own Stellar key, and the signed challenge proves ownership before a
          session is issued. Your key never leaves the extension.
        </p>
      </div>
    </div>
  );
}
