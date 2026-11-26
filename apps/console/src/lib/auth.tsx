import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { requestAccess, signTransaction } from "@stellar/freighter-api";
import { api } from "./api.ts";
import { setUnauthorizedHandler } from "./unauthorized.ts";
import { networkPassphrase } from "./config.ts";

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

/**
 * The stored value is user-writable and its shape can change between releases, so it is checked
 * before use: anything that is not three non-empty strings is discarded rather than rendered.
 */
export function parseSession(raw: string): Session | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { token, partyId, stellarAccount } = value as Record<string, unknown>;
    if (
      typeof token !== "string" || !token ||
      typeof partyId !== "string" || !partyId ||
      typeof stellarAccount !== "string" || !stellarAccount
    ) {
      return null;
    }
    return { token, partyId, stellarAccount };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const restored = parseSession(raw);
    if (!restored) localStorage.removeItem(STORAGE_KEY);
    return restored;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A 401 on any authenticated call means the token lapsed: drop the session so the shell sends
  // the user back to the login page instead of every panel failing with a raw error.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      localStorage.removeItem(STORAGE_KEY);
      setError("Your session expired. Log in again.");
    });
    return () => setUnauthorizedHandler(null);
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
        networkPassphrase: networkPassphrase(),
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
