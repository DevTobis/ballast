import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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
  login: (stellarAccount: string) => Promise<void>;
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

  async function login(stellarAccount: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.devLogin(stellarAccount);
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
