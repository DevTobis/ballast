import type { ReactNode } from "react";

/** Bracket-framed section container per the industrial-brutalist tactical-telemetry symbology. */
export function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-line bg-bg-raised ${className}`}>
      <header className="border-b border-line px-3 py-2">
        <span className="text-xs uppercase tracking-[0.15em] text-fg-dim">[ {title} ]</span>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}
