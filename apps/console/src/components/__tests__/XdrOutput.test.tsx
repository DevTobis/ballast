import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { XdrOutput } from "../XdrOutput.tsx";
import { AuthProvider } from "../../lib/auth.tsx";
import { signTransaction } from "@stellar/freighter-api";
import { api } from "../../lib/api.ts";

vi.mock("@stellar/freighter-api", () => ({
  signTransaction: vi.fn(),
  requestAccess: vi.fn(),
}));

vi.mock("../../lib/api.ts", () => ({
  api: {
    submitTx: vi.fn(),
    settleTx: vi.fn(),
    challenge: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockTx = {
  xdr: "AAAA_TEST_XDR_UNSIGNED",
  txHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
};

const mockSession = {
  token: "test-jwt-token",
  partyId: "test-party-id",
  stellarAccount: "GBZXN7PIRZGNMHGA728R46OP7J3DTLGS245QSEIN6KZ2M",
};

describe("XdrOutput component", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("ballast.console.session", JSON.stringify(mockSession));
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("completes happy path: sign -> submit -> settled -> dismiss and asserts phase labels in order", async () => {
    const onDismiss = vi.fn();

    const signDeferred = deferred<{ signedTxXdr: string; error?: { message?: string } }>();
    const submitDeferred = deferred<{ status: "settled"; ledger: number; txHash: string }>();

    vi.mocked(signTransaction).mockImplementation(() => signDeferred.promise as any);
    vi.mocked(api.submitTx).mockImplementation(() => submitDeferred.promise as any);

    render(
      <AuthProvider>
        <XdrOutput tx={mockTx} onDismiss={onDismiss} />
      </AuthProvider>,
    );

    // Initial state: UNSIGNED TRANSACTION READY
    expect(screen.getByText(">>> UNSIGNED TRANSACTION READY")).toBeTruthy();
    expect(screen.getByRole("button", { name: "SIGN + SUBMIT" })).toBeTruthy();

    // Click SIGN + SUBMIT
    fireEvent.click(screen.getByRole("button", { name: "SIGN + SUBMIT" }));

    // Phase 1: AWAITING WALLET SIGNATURE
    await waitFor(() => {
      expect(screen.getByText(">>> AWAITING WALLET SIGNATURE")).toBeTruthy();
    });
    expect(signTransaction).toHaveBeenCalledWith(mockTx.xdr, {
      address: mockSession.stellarAccount,
      networkPassphrase: import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE,
    });

    // Resolve wallet signing
    const signedXdr = "AAAA_TEST_XDR_SIGNED";
    signDeferred.resolve({ signedTxXdr: signedXdr });

    // Phase 2: SUBMITTED / AWAITING LEDGER CLOSE
    await waitFor(() => {
      expect(screen.getByText(">>> SUBMITTED / AWAITING LEDGER CLOSE")).toBeTruthy();
    });
    expect(api.submitTx).toHaveBeenCalledWith(mockSession.token, signedXdr);

    // Resolve submission with settled state and ledger number
    submitDeferred.resolve({
      status: "settled",
      ledger: 1234567,
      txHash: mockTx.txHash,
    });

    // Phase 3: SETTLED ON-CHAIN
    await waitFor(() => {
      expect(screen.getByText(">>> SETTLED ON-CHAIN")).toBeTruthy();
    });

    // Ledger number is rendered
    expect(screen.getByText("1234567")).toBeTruthy();

    // Clicking DONE calls onDismiss
    const doneButton = screen.getByRole("button", { name: "DONE" });
    expect(doneButton).toBeTruthy();
    fireEvent.click(doneButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows an expired result instead of a blank status", async () => {
    vi.mocked(signTransaction).mockResolvedValue({ signedTxXdr: "SIGNED" } as any);
    vi.mocked(api.submitTx).mockResolvedValue({ status: "expired", ledger: null, txHash: mockTx.txHash } as any);

    render(
      <AuthProvider>
        <XdrOutput tx={mockTx} onDismiss={vi.fn()} />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "SIGN + SUBMIT" }));

    await waitFor(() => expect(screen.getByText(">>> EXPIRED / NEVER SIGNED")).toBeTruthy());
    expect(screen.getByRole("button", { name: "DONE" })).toBeTruthy();
  });

  it("shows the full transaction hash", () => {
    render(
      <AuthProvider>
        <XdrOutput tx={mockTx} onDismiss={vi.fn()} />
      </AuthProvider>,
    );
    expect(screen.getByText(mockTx.txHash)).toBeTruthy();
  });

  it("calls onDismiss when [ X ] is clicked", () => {
    const onDismiss = vi.fn();

    render(
      <AuthProvider>
        <XdrOutput tx={mockTx} onDismiss={onDismiss} />
      </AuthProvider>,
    );

    const closeButton = screen.getByRole("button", { name: "Dismiss" });
    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
