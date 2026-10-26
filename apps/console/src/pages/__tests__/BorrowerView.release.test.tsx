import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BorrowerLineDetail } from "../BorrowerView.tsx";
import { api, type AssetSummary, type CreditLineDetail, type PledgeRow } from "../../lib/api.ts";

const testSession = {
  token: "test-auth-token",
  partyId: "party-borrower-1",
  stellarAccount: "GBORROWER1234567890123456789012345678901234567890123456",
};

vi.mock("../../lib/auth.tsx", () => ({
  useAuth: () => ({ session: testSession, loading: false, error: null, login: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@stellar/freighter-api", () => ({ signTransaction: vi.fn(), requestAccess: vi.fn() }));

const detail: CreditLineDetail = {
  id: "line-1",
  lenderId: "lender-1",
  borrowerId: "party-borrower-1",
  loanCcy: "TUSD",
  limit: "10000000000",
  drawn: "5000000000",
  rateBps: 700,
  feeBps: 0,
  cureWindowS: 86_400,
  status: "open",
  contractLineId: "7",
  ltvBps: 5_000,
  marginState: "Healthy",
  funded: null,
  undrawn: null,
  claimableInterest: null,
  collateralValue: null,
  priceStatus: "Ok",
  liquidation: null,
} as CreditLineDetail;

const pledges: PledgeRow[] = [
  { id: "pledge-1", creditLineId: "line-1", assetId: "asset-1", units: "800.0000000", custodyMode: "escrow", status: "active" },
];
const assets = [{ id: "asset-1", code: "RWA1" }] as AssetSummary[];

beforeEach(() => {
  vi.spyOn(api, "releasePledge").mockResolvedValue({ xdr: "AAAA", txHash: "a".repeat(64), projectedLtvBps: 7_500 });
  vi.spyOn(api, "draw").mockResolvedValue({ xdr: "BBBB", txHash: "b".repeat(64) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The preview line; the transaction panel below it has its own status element, so role alone is ambiguous. */
const previewMatcher = (_: string, el: Element | null) => el?.tagName === "P" && !!el.textContent?.startsWith("LTV after release");

function renderDetail() {
  return render(<BorrowerLineDetail detail={detail} pledges={pledges} assets={assets} onChanged={() => {}} />);
}

describe("release preview", () => {
  it("shows the LTV the release would leave behind, with its band, before signing", async () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Release" }));

    const preview = await screen.findByText(previewMatcher);
    expect(preview.textContent).toContain("LTV after release: 75.00%");
    expect(preview.textContent).toContain("(warning)");
    expect(api.releasePledge).toHaveBeenCalledWith("test-auth-token", "line-1", "pledge-1");
  });

  it("labels a safe projection as healthy", async () => {
    vi.spyOn(api, "releasePledge").mockResolvedValue({ xdr: "AAAA", txHash: "c".repeat(64), projectedLtvBps: 6_250 });
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Release" }));

    const preview = await screen.findByText(previewMatcher);
    expect(preview.textContent).toContain("LTV after release: 62.50% (healthy)");
  });

  it("shows no preview for other transaction kinds", async () => {
    renderDetail();

    fireEvent.change(screen.getAllByPlaceholderText("amount (e.g. 500.00)")[0]!, {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build draw tx" }));

    await waitFor(() => expect(api.draw).toHaveBeenCalled());
    await screen.findByText(/Finish or dismiss the open transaction/);
    expect(screen.queryByText(previewMatcher)).toBeNull();
  });
});
