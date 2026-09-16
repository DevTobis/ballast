import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth.tsx";
import { shortAddress } from "../lib/format.ts";

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `border px-3 py-1.5 text-xs uppercase tracking-[0.1em] ${
    isActive ? "border-fg bg-fg text-bg" : "border-line text-fg-dim hover:text-fg"
  }`;

export function ConsoleShell() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  if (!session) {
    navigate("/login", { replace: true });
    return null;
  }

  function onLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-4">
          <span className="text-sm font-bold uppercase tracking-tighter">BALLAST</span>
          <nav className="flex gap-2">
            <NavLink to="/borrower" className={tabClass}>
              Borrower
            </NavLink>
            <NavLink to="/lender" className={tabClass}>
              Lender
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-xs text-fg-dim">
          <span>
            UNIT / <span className="text-fg">{shortAddress(session.stellarAccount)}</span>
          </span>
          <button onClick={onLogout} className="border border-line px-2 py-1 hover:text-accent">
            DISCONNECT
          </button>
        </div>
      </header>
      <main className="p-4">
        <Outlet />
      </main>
    </div>
  );
}
