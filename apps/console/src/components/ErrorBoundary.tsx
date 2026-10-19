import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth.tsx";
import { Button } from "./Button.tsx";
import { Panel } from "./Panel.tsx";

interface Props {
  children: ReactNode;
  onDisconnect: () => void;
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Console rendering failed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <Panel title="Console error">
        <div role="alert" className="space-y-3">
          <h1 className="text-sm uppercase tracking-[0.1em] text-accent">Unable to display this page</h1>
          <p className="text-sm text-fg-dim">
            An unexpected error interrupted this view. Reload to try again, or disconnect to return to login.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => window.location.reload()}>Reload</Button>
            <Button variant="danger" onClick={this.props.onDisconnect}>Disconnect</Button>
          </div>
        </div>
      </Panel>
    );
  }
}

/** Keep AuthProvider outside the keyed boundary so navigation preserves the session. */
export function RootErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();

  function disconnect() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <ErrorBoundary key={location.pathname} onDisconnect={disconnect}>
      {children}
    </ErrorBoundary>
  );
}
