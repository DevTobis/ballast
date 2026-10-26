import type { ConfigProblem } from "../lib/config.ts";
import { Panel } from "./Panel.tsx";

/** Shown instead of the app when the build's configuration is missing or malformed. */
export function ConfigError({ problems }: { problems: ConfigProblem[] }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center p-4">
      <Panel title="Configuration error">
        <div role="alert" className="space-y-3">
          <h1 className="text-sm uppercase tracking-[0.1em] text-accent">This console was built with invalid settings</h1>
          <ul className="space-y-2 text-sm">
            {problems.map((p) => (
              <li key={p.variable}>
                <code className="text-fg">{p.variable}</code> <span className="text-fg-dim">{p.message}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-fg-dim">
            These are fixed when the console is built. Set them and rebuild; reloading will not help.
          </p>
        </div>
      </Panel>
    </main>
  );
}
