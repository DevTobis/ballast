import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { XdrOutput } from "../components/XdrOutput.tsx";
import { signTransaction } from "@stellar/freighter-api";
import { api, type BuiltTx } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";

vi.mock("@stellar/freighter-api", () => ({
  signTransaction: vi.fn(),
}));

vi.mock("../lib/api.ts", () => ({
  api: {
    submitTx: vi.fn(),
    settleTx: vi.fn(),
  },
  shortAddress: (addr: string) => addr.slice(0, 4) + "..." + addr.slice(-4),
}));

vi.mock("../lib/auth.tsx", () => ({
  useAuth: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sampleTx: BuiltTx = {
  xdr: "AAAAAGFkZHJlc3N4ZHI=",
  txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const activeSession = {
  token: "jwt-token-123",
  partyId: "party-1",
  stellarAccount: "GBZXN7PIRZGNMHGA728RGRFZAPPWN9G8362534567",
};

describe("XdrOutput error branches", () => {
  it("handles wallet decline with message: shows error, returns to ready phase, and re-enables submit button", async () => {
    vi.mocked(useAuth).mockReturnValue({
      session: activeSession,
      loading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
    });
    vi.mocked(signTransaction).mockResolvedValue({
      error: { message: "User declined" },
    } as any);

    render(<XdrOutput tx={sampleTx} onDismiss={vi.fn()} />);

    const submitBtn = screen.getByRole("button", { name: "SIGN + SUBMIT" });
    fireEvent.click(submitBtn);

    expect(await screen.findByText("ERROR: User declined")).toBeTruthy();
    expect(screen.getByText(/>>> UNSIGNED TRANSACTION READY/)).toBeTruthy();
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("SIGN + SUBMIT")).toBeTruthy();
  });

  it("handles wallet decline without message: defaults error to 'wallet declined to sign'", async () => {
    vi.mocked(useAuth).mockReturnValue({
      session: activeSession,
      loading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
    });
    vi.mocked(signTransaction).mockResolvedValue({
      error: {},
    } as any);

    render(<XdrOutput tx={sampleTx} onDismiss={vi.fn()} />);

    const submitBtn = screen.getByRole("button", { name: "SIGN + SUBMIT" });
    fireEvent.click(submitBtn);

    expect(await screen.findByText("ERROR: wallet declined to sign")).toBeTruthy();
    expect(screen.getByText(/>>> UNSIGNED TRANSACTION READY/)).toBeTruthy();
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("handles network submission failure: catches submitTx rejection, displays error, and resets phase to ready", async () => {
    vi.mocked(useAuth).mockReturnValue({
      session: activeSession,
      loading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
    });
    vi.mocked(signTransaction).mockResolvedValue({
      signedTxXdr: "AAAAZXhhbXBsZXNpZ25lZA==",
    } as any);
    vi.mocked(api.submitTx).mockRejectedValue(new Error("Connection refused"));

    render(<XdrOutput tx={sampleTx} onDismiss={vi.fn()} />);

    const submitBtn = screen.getByRole("button", { name: "SIGN + SUBMIT" });
    fireEvent.click(submitBtn);

    expect(await screen.findByText("ERROR: Connection refused")).toBeTruthy();
    expect(screen.getByText(/>>> UNSIGNED TRANSACTION READY/)).toBeTruthy();
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("handles on-chain failure: displays FAILED ON-CHAIN with accent tone and nothing moved notice", async () => {
    vi.mocked(useAuth).mockReturnValue({
      session: activeSession,
      loading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
    });
    vi.mocked(signTransaction).mockResolvedValue({
      signedTxXdr: "AAAAZXhhbXBsZXNpZ25lZA==",
    } as any);
    vi.mocked(api.submitTx).mockResolvedValue({
      status: "failed",
      txHash: sampleTx.txHash,
      kind: "credit_line.repay",
      refId: null,
      ledger: 123456,
    });

    const { container } = render(<XdrOutput tx={sampleTx} onDismiss={vi.fn()} />);

    const submitBtn = screen.getByRole("button", { name: "SIGN + SUBMIT" });
    fireEvent.click(submitBtn);

    expect(await screen.findByText(/>>> FAILED ON-CHAIN/)).toBeTruthy();
    expect(screen.getByText("The network rejected this transaction; nothing moved.")).toBeTruthy();
    const panel = container.firstChild as HTMLElement;
    expect(panel.className).toContain("border-accent");
    expect(screen.getByRole("button", { name: "DONE" })).toBeTruthy();
  });

  it("does nothing when there is no active session", async () => {
    vi.mocked(useAuth).mockReturnValue({
      session: null,
      loading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
    });

    render(<XdrOutput tx={sampleTx} onDismiss={vi.fn()} />);

    const submitBtn = screen.getByRole("button", { name: "SIGN + SUBMIT" });
    fireEvent.click(submitBtn);

    expect(signTransaction).not.toHaveBeenCalled();
    expect(screen.getByText(/>>> UNSIGNED TRANSACTION READY/)).toBeTruthy();
    expect(screen.queryByText(/ERROR:/)).toBeNull();
  });
});
