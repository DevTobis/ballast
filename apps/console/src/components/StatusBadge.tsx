const MARGIN_COLOR: Record<string, string> = {
  Healthy: "text-ok border-ok",
  Warning: "text-fg border-fg",
  MarginCall: "text-accent border-accent",
  Liquidation: "text-accent border-accent",
};

export function MarginBadge({ state }: { state: string }) {
  const cls = MARGIN_COLOR[state] ?? "text-fg-dim border-line";
  return (
    <span className={`inline-block border px-2 py-0.5 text-xs uppercase tracking-wider ${cls}`}>
      {state}
    </span>
  );
}

const PRICE_COLOR: Record<string, string> = {
  Ok: "text-ok border-ok",
  Degraded: "text-fg border-fg",
  Halted: "text-accent border-accent",
};

export function PriceStatusBadge({ status }: { status: string }) {
  const cls = PRICE_COLOR[status] ?? "text-fg-dim border-line";
  return (
    <span className={`inline-block border px-2 py-0.5 text-xs uppercase tracking-wider ${cls}`}>
      PRICE: {status}
    </span>
  );
}
