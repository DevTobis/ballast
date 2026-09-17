import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { requestAccess, signTransaction } from "@stellar/freighter-api";
import { api } from "./api.ts";

interface Session {
  token: string;
  partyId: string;
  stellarAccount: string;
}

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  error: string | null;
  login: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "ballast.console.session";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        setSession(JSON.parse(raw));
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, []);

  /**
   * Real SEP-10 flow: connect Freighter for the account -> fetch a challenge transaction ->
   * have Freighter sign it with that account's own Stellar key -> submit the signed challenge
   * for a session JWT. Replaces the old raw-G-address `devLogin` (still reachable server-side
   * behind `ENABLE_DEV_LOGIN`, but not from this UI).
   */
  async function login() {
    setLoading(true);
    setError(null);
    try {
      const access = await requestAccess();
      if (access.error) throw new Error(access.error.message);
      const stellarAccount = access.address;

      const { transaction } = await api.challenge(stellarAccount);

      const signed = await signTransaction(transaction, {
        address: stellarAccount,
        networkPassphrase: import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE,
      });
      if (signed.error) throw new Error(signed.error.message);

      const result = await api.token(signed.signedTxXdr);
      const next: Session = { token: result.token, partyId: result.partyId, stellarAccount };
      setSession(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setSession(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  return (
    <AuthContext.Provider value={{ session, loading, error, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
