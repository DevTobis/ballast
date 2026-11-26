import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App.tsx";
import { AuthProvider } from "../lib/auth.tsx";

vi.mock("../lib/api.ts", () => ({
  api: {
    positions: vi.fn().mockResolvedValue({ creditLines: [], pledges: [] }),
    assets: vi.fn().mockResolvedValue({ assets: [] }),
    creditLine: vi.fn(),
  },
  bpsToPercent: vi.fn(),
  formatDecimalString: vi.fn(),
  formatScaledBigintString: vi.fn(),
  toScaled: vi.fn(),
}));

const STORAGE_KEY = "ballast.console.session";

const sampleSession = {
  token: "valid-jwt-token",
  partyId: "borrower-party-1",
  stellarAccount: "GBZXN7PIRZGNMHGA728RGRFZAPPWN9G8362534567",
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

function renderWithRoute(initialRoute: string) {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("Session restore on reload", () => {
  it("renders <App/> in a MemoryRouter at /borrower with pre-seeded localStorage session, showing Borrower view and never rendering /login", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sampleSession));
    renderWithRoute("/borrower");

    expect(await screen.findByText(/My Credit Lines/)).toBeTruthy();
    expect(screen.queryByText(/Operator Access/)).toBeNull();
  });

  it("reload on /lender with a stored valid session keeps the user on /lender", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sampleSession));
    renderWithRoute("/lender");

    expect(await screen.findByText(/Exposure Summary/)).toBeTruthy();
    expect(screen.queryByText(/Operator Access/)).toBeNull();
  });

  it("reload with no stored session redirects to /login", async () => {
    renderWithRoute("/borrower");

    expect(await screen.findByText(/Operator Access/)).toBeTruthy();
    expect(screen.queryByText(/My Credit Lines/)).toBeNull();
  });

  it("navigating to /login with active stored session redirects away to /", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sampleSession));
    renderWithRoute("/login");

    expect(await screen.findByText(/My Credit Lines/)).toBeTruthy();
    expect(screen.queryByText(/Operator Access/)).toBeNull();
  });
});
