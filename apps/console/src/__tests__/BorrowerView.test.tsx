import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BorrowerView } from "../pages/BorrowerView.tsx";
import { api, type AssetSummary, type CreditLineDetail, type PositionsResult } from "../lib/api.ts";

vi.mock("../lib/auth.tsx", () => ({
  useAuth: () => ({
    session: {
      token: "test-token",
      partyId: "party-borrower",
      stellarAccount: "GBORROWER11111111111111111111111111111111111111111111111111",
    },
    loading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const lineA: CreditLineDetail = {
  id: "line-a-111111",
  lenderId: "party-lender",
  borrowerId: "party-borrower",
  loanCcy: "USDC",
  limit: "100000000000",
  drawn: "0",
  rateBps: 500,
  feeBps: 0,
  cureWindowS: 86400,
  status: "active",
  contractLineId: "1",
  ltvBps: 0,
  marginState: "Healthy",
  funded: "100000000000",
  undrawn: "100000000000",
  claimableInterest: "0",
  collateralValue: "200000000000",
  priceStatus: "Ok",
  liquidation: null,
};

const lineB: CreditLineDetail = {
  id: "line-b-222222",
  lenderId: "party-lender",
  borrowerId: "party-borrower",
  loanCcy: "USDC",
  limit: "100000000000",
  drawn: "0",
  rateBps: 500,
  feeBps: 0,
  cureWindowS: 86400,
  status: "active",
  contractLineId: "2",
  ltvBps: 0,
  marginState: "Healthy",
  funded: "100000000000",
  undrawn: "100000000000",
  claimableInterest: "0",
  collateralValue: "200000000000",
  priceStatus: "Ok",
  liquidation: null,
};

const asset: AssetSummary = {
  id: "asset-1",
  code: "USTRY",
  contractC: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR",
  ccy: "USD",
  standard: "sep41",
  custodyMode: "escrow",
  haircutBps: 1000,
  status: "active",
  price: { value: "1.0", status: "Ok", asOf: "2026-10-01T00:00:00Z" },
};

const positionsData: PositionsResult = {
  party: "party-borrower",
  creditLines: [
    {
      id: "line-a-111111",
      lenderId: "party-lender",
      borrowerId: "party-borrower",
      loanCcy: "USDC",
      limitAmount: "100000000000",
      rateBps: 500,
      feeBps: 0,
      cureWindowS: 86400,
      status: "active",
      contractLineId: "1",
      openedAt: "2026-10-01T00:00:00Z",
      closedAt: null,
    },
    {
      id: "line-b-222222",
      lenderId: "party-lender",
      borrowerId: "party-borrower",
      loanCcy: "USDC",
      limitAmount: "100000000000",
      rateBps: 500,
      feeBps: 0,
      cureWindowS: 86400,
      status: "active",
      contractLineId: "2",
      openedAt: "2026-10-01T00:00:00Z",
      closedAt: null,
    },
  ],
  pledges: [],
  exitQuotes: [],
  repoTrades: [],
};

describe("BorrowerView page", () => {
  beforeEach(() => {
    vi.spyOn(api, "positions").mockResolvedValue(positionsData);
    vi.spyOn(api, "creditLine").mockImplementation(async (_token, id) => {
      if (id === lineA.id) return lineA;
      if (id === lineB.id) return lineB;
      throw new Error(`not found: ${id}`);
    });
    vi.spyOn(api, "assets").mockResolvedValue({ assets: [asset] });
  });

  it("still shows the other lines when one line's detail fails to load", async () => {
    vi.spyOn(api, "creditLine").mockImplementation(async (_token, id) => {
      if (id === lineA.id) return lineA;
      throw new Error("boom");
    });

    render(<BorrowerView />);

    expect(await screen.findByRole("button", { name: /line-a/i })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("could not load")).toBeTruthy());
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    // The healthy line kept its margin badge.
    expect(screen.getAllByText(/healthy/i).length).toBeGreaterThan(0);
  });

  it("enables the pledge button when assets arrive after the detail opened", async () => {
    let release!: (value: { assets: AssetSummary[] }) => void;
    vi.spyOn(api, "assets").mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    // Details are available immediately, only the asset list is late.
    render(<BorrowerView />);
    const buttonA = await screen.findByRole("button", { name: /line-a/i });
    fireEvent.click(buttonA);

    const pledgeSection = (await screen.findByText("[ Pledge collateral ]")).closest("section")!;
    fireEvent.change(within(pledgeSection).getByPlaceholderText("units"), { target: { value: "10" } });
    expect((within(pledgeSection).getByRole("button", { name: /build pledge tx/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    release({ assets: [asset] });

    await waitFor(() =>
      expect(
        (within(pledgeSection).getByRole("button", { name: /build pledge tx/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("resets form state when switching between credit lines (Draw amount regression test)", async () => {
    render(<BorrowerView />);

    // Wait for credit lines to load
    const buttonA = await screen.findByRole("button", { name: /line-a/i });
    const buttonB = screen.getByRole("button", { name: /line-b/i });

    // Select line A
    fireEvent.click(buttonA);

    // Find the Draw input
    const drawSectionA = (await screen.findByText("[ Draw ]")).closest("section");
    expect(drawSectionA).toBeTruthy();
    const drawInputA = within(drawSectionA!).getByPlaceholderText("amount (e.g. 500.00)") as HTMLInputElement;

    // Type 5 into Draw amount for line A
    fireEvent.change(drawInputA, { target: { value: "5" } });
    expect(drawInputA.value).toBe("5");

    // Select line B
    fireEvent.click(buttonB);

    // Assert that the Draw amount field is empty on line B
    const drawSectionB = (await screen.findByText("[ Draw ]")).closest("section");
    expect(drawSectionB).toBeTruthy();
    const drawInputB = within(drawSectionB!).getByPlaceholderText("amount (e.g. 500.00)") as HTMLInputElement;
    expect(drawInputB.value).toBe("");
  });

  it("dismisses an active tx panel and resets form fields when selecting another line", async () => {
    vi.spyOn(api, "draw").mockResolvedValue({
      txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      xdr: "AAAAAG...",
    });

    render(<BorrowerView />);

    const buttonA = await screen.findByRole("button", { name: /line-a/i });
    const buttonB = screen.getByRole("button", { name: /line-b/i });

    // Select line A
    fireEvent.click(buttonA);

    const drawSectionA = (await screen.findByText("[ Draw ]")).closest("section");
    const drawInputA = within(drawSectionA!).getByPlaceholderText("amount (e.g. 500.00)");
    const buildDrawBtn = within(drawSectionA!).getByRole("button", { name: /build draw tx/i });

    // Fill amount and click Build draw tx
    fireEvent.change(drawInputA, { target: { value: "500" } });
    fireEvent.click(buildDrawBtn);

    // Assert tx panel is displayed
    expect(await screen.findByLabelText("Unsigned transaction XDR")).toBeTruthy();
    expect(screen.getByText(/UNSIGNED TRANSACTION READY/i)).toBeTruthy();

    // Fill repay amount and pledge units on line A as well
    const repaySectionA = screen.getByText("[ Repay ]").closest("section");
    const repayInputA = within(repaySectionA!).getByPlaceholderText("amount (e.g. 500.00)");
    fireEvent.change(repayInputA, { target: { value: "250" } });

    const pledgeSectionA = screen.getByText("[ Pledge collateral ]").closest("section");
    const pledgeInputA = within(pledgeSectionA!).getByPlaceholderText("units");
    fireEvent.change(pledgeInputA, { target: { value: "10" } });

    // Select line B
    fireEvent.click(buttonB);

    // Assert tx panel is dismissed
    await waitFor(() => {
      expect(screen.queryByLabelText("Unsigned transaction XDR")).toBeNull();
      expect(screen.queryByText(/UNSIGNED TRANSACTION READY/i)).toBeNull();
    });

    // Assert all form fields are reset on line B
    const repaySectionB = screen.getByText("[ Repay ]").closest("section");
    const repayInputB = within(repaySectionB!).getByPlaceholderText("amount (e.g. 500.00)") as HTMLInputElement;
    expect(repayInputB.value).toBe("");

    const pledgeSectionB = screen.getByText("[ Pledge collateral ]").closest("section");
    const pledgeInputB = within(pledgeSectionB!).getByPlaceholderText("units") as HTMLInputElement;
    expect(pledgeInputB.value).toBe("");
  });
});
