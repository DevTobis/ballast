import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExitView } from "../ExitView.tsx";
import { api, type AssetSummary, type BuiltTx, type ExitQuoteResult, type PositionsResult } from "../../lib/api.ts";

const testSession = {
  token: "test-auth-token",
  partyId: "party-borrower-1",
  stellarAccount: "GBORROWER1234567890123456789012345678901234567890123456",
};

vi.mock("../../lib/auth.tsx", () => ({
  useAuth: () => ({
    session: testSession,
    loading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

const mockAsset: AssetSummary = {
  id: "asset-ustry",
  code: "USTRY",
  contractC: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR",
  ccy: "USD",
  standard: "SAC",
  custodyMode: "pool",
  haircutBps: 1000,
  status: "active",
  price: { value: "1.0000000", status: "Ok", asOf: "2026-10-18T11:59:00Z" },
};

const mockPositions: PositionsResult = {
  party: "party-borrower-1",
  creditLines: [],
  pledges: [],
  exitQuotes: [],
  repoTrades: [],
};

const BASE_TIME = new Date("2026-10-18T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  vi.spyOn(api, "assets").mockResolvedValue({ assets: [mockAsset] });
  vi.spyOn(api, "positions").mockResolvedValue(mockPositions);
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function renderExitViewWithQuote(quoteOverrides: Partial<ExitQuoteResult> = {}, expiresInSeconds = 60) {
  const quoteResult: ExitQuoteResult = {
    id: "quote-12345678-abcd-ef01-2345-6789abcdef01",
    assetId: mockAsset.id,
    units: "1000000000",
    price: "10000000",
    spreadBps: 20,
    usdcOut: "1000000000",
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    ...quoteOverrides,
  };

  vi.spyOn(api, "exitQuote").mockResolvedValue(quoteResult);

  const rendered = render(<ExitView />);

  // Flush initial load promises (api.assets, api.positions)
  await act(async () => {
    await Promise.resolve();
  });

  // Fill in units and submit
  fireEvent.change(screen.getByLabelText("Units"), { target: { value: "100" } });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "GET QUOTE" }));
    await Promise.resolve();
  });

  return { quoteResult, ...rendered };
}

describe("ExitView quote countdown, expiry and execute floor calculation", () => {
  it("Quote with expiresAt = now+60s shows 60s then ticks down; at 0 shows EXPIRED in accent and BUILD EXIT TX is disabled", async () => {
    await renderExitViewWithQuote({}, 60);

    // Initial countdown display is 60s in ok text
    const countdown = screen.getByText("60s");
    expect(countdown).toBeTruthy();
    expect(countdown.className).toContain("text-ok");
    expect(countdown.className).not.toContain("text-accent");

    const buildButton = screen.getByRole("button", { name: "BUILD EXIT TX" });
    expect((buildButton as HTMLButtonElement).disabled).toBe(false);

    // Advance 1s -> ticks down to 59s
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("59s")).toBeTruthy();

    // Advance 29s more (30s elapsed) -> ticks down to 30s
    act(() => {
      vi.advanceTimersByTime(29000);
    });
    expect(screen.getByText("30s")).toBeTruthy();

    // Advance remaining 30s -> at 0 shows EXPIRED in accent and BUILD EXIT TX is disabled
    act(() => {
      vi.advanceTimersByTime(30000);
    });

    const expiredLabel = screen.getByText("EXPIRED");
    expect(expiredLabel).toBeTruthy();
    expect(expiredLabel.className).toContain("text-accent");
    expect(expiredLabel.className).not.toContain("text-ok");
    expect((buildButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("Execute with usdcOut='1000000000' posts minUsdcOut === '995000000' (0.5%) and to trimmed", async () => {
    const { quoteResult } = await renderExitViewWithQuote({ usdcOut: "1000000000" });

    const mockBuiltTx: BuiltTx = {
      txHash: "0xdeadbeef1234567890abcdef1234567890abcdef",
      xdr: "AAAAtestxdr==",
    };
    const executeSpy = vi.spyOn(api, "exitExecute").mockResolvedValue(mockBuiltTx);

    // Provide a destination with leading and trailing whitespace
    const toInput = screen.getByLabelText("Pay USDC to");
    fireEvent.change(toInput, { target: { value: "   GDESTINATION1234567890TRIMMED   " } });

    const buildButton = screen.getByRole("button", { name: "BUILD EXIT TX" });
    expect((buildButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(buildButton);
      await Promise.resolve();
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);

    // Floor for 1000000000 with 50 bps (0.5%) slippage is 995000000
    expect(executeSpy).toHaveBeenCalledWith(
      testSession.token,
      quoteResult.id,
      995000000n,
      "GDESTINATION1234567890TRIMMED",
    );
  });

  it("Floor rounds down for odd values ( '999' -> '994' )", async () => {
    const { quoteResult } = await renderExitViewWithQuote({ usdcOut: "999" });

    const mockBuiltTx: BuiltTx = {
      txHash: "0xbeefdead1234567890abcdef1234567890abcdef",
      xdr: "AAAAoddvaluexdr==",
    };
    const executeSpy = vi.spyOn(api, "exitExecute").mockResolvedValue(mockBuiltTx);

    const buildButton = screen.getByRole("button", { name: "BUILD EXIT TX" });
    expect((buildButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(buildButton);
      await Promise.resolve();
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);

    // (999n * 9950n) / 10000n = 9940050n / 10000n = 994n (rounds down)
    expect(executeSpy).toHaveBeenCalledWith(
      testSession.token,
      quoteResult.id,
      994n,
      testSession.stellarAccount,
    );
  });

  it("to empty disables the button", async () => {
    await renderExitViewWithQuote();

    const buildButton = screen.getByRole("button", { name: "BUILD EXIT TX" });
    expect((buildButton as HTMLButtonElement).disabled).toBe(false);

    // Clear the destination field
    const toInput = screen.getByLabelText("Pay USDC to");
    fireEvent.change(toInput, { target: { value: "" } });

    // Button must be disabled when 'to' is empty
    expect((buildButton as HTMLButtonElement).disabled).toBe(true);

    // Re-entering an account re-enables the button
    fireEvent.change(toInput, { target: { value: "GNEWACCOUNT123" } });
    expect((buildButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("Dismissing the resulting tx clears the quote and reloads", async () => {
    await renderExitViewWithQuote();

    const mockBuiltTx: BuiltTx = {
      txHash: "0xabcdef1234567890abcdef1234567890abcdef12",
      xdr: "AAAAunsignedtxdr==",
    };
    vi.spyOn(api, "exitExecute").mockResolvedValue(mockBuiltTx);

    // Click BUILD EXIT TX to produce tx
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "BUILD EXIT TX" }));
      await Promise.resolve();
    });

    // Verify XdrOutput renders
    expect(screen.getByLabelText("Unsigned transaction XDR")).toBeTruthy();
    expect(screen.getByText(/Quote \/ quote-12/i)).toBeTruthy();

    // Clear reload spies to test that dismissing triggers reload()
    vi.mocked(api.assets).mockClear();
    vi.mocked(api.positions).mockClear();

    // Click dismiss button [ X ]
    const dismissButton = screen.getByRole("button", { name: "Dismiss" });
    await act(async () => {
      fireEvent.click(dismissButton);
      await Promise.resolve();
    });

    // XDR output is removed
    expect(screen.queryByLabelText("Unsigned transaction XDR")).toBeNull();

    // Quote panel is cleared
    expect(screen.queryByText(/Quote \/ quote-12/i)).toBeNull();

    // Reload was invoked
    expect(api.assets).toHaveBeenCalledTimes(1);
    expect(api.positions).toHaveBeenCalledTimes(1);
  });

  it("interval cleared on unmount (no timer warnings)", async () => {
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = await renderExitViewWithQuote();

    // Unmount while quote countdown timer is actively ticking
    unmount();

    // Verify clearInterval was called to tear down the timer
    expect(clearIntervalSpy).toHaveBeenCalled();

    // Advance time after unmount to confirm no state updates on unmounted component
    act(() => {
      vi.advanceTimersByTime(10000);
    });
  });
});
