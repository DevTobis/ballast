import { useState } from "react";
import { Button } from "./Button.tsx";

/**
 * Ballast never holds customer signing keys (PRD §9) - every state-changing API call returns
 * unsigned XDR for the caller to sign with their own wallet. This panel is the console's entire
 * "submission" story: show the envelope, let the operator copy it, tell them how to sign and send
 * it themselves (stellar-cli or a wallet). No secret key is ever handled in this browser.
 */
export function XdrOutput({ xdr, onDismiss }: { xdr: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(xdr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="border border-ok bg-bg p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.15em] text-ok">
          &gt;&gt;&gt; UNSIGNED TRANSACTION READY
        </span>
        <button
          onClick={onDismiss}
          className="text-xs text-fg-dim hover:text-fg"
          aria-label="Dismiss"
        >
          [ X ]
        </button>
      </div>
      <textarea
        readOnly
        value={xdr}
        rows={4}
        className="w-full resize-none border border-line bg-bg-raised p-2 text-xs text-fg-dim"
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-fg-dim">
          Sign with your own key (never paste it here), e.g.{" "}
          <code className="text-fg">stellar tx sign --sign-with-key &lt;your-key&gt;</code>, then{" "}
          <code className="text-fg">stellar tx send</code>.
        </p>
        <Button onClick={copy}>{copied ? "COPIED" : "COPY XDR"}</Button>
      </div>
    </div>
  );
}
