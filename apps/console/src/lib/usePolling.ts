import { useEffect, useRef } from "react";

/**
 * Calls `callback` every `intervalMs` while the tab is visible, and again when the window regains
 * focus, so positions and margin state move on screen after a liquidation or a settled
 * transaction without a manual refresh. The latest `callback` is always the one called.
 */
export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    const timer = setInterval(run, intervalMs);
    window.addEventListener("focus", run);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", run);
    };
  }, [intervalMs, enabled]);
}
