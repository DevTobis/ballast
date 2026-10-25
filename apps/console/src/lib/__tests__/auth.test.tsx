import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "../auth.tsx";
import { api, type TokenResult } from "../api.ts";
import { requestAccess, signTransaction } from "@stellar/freighter-api";

vi.mock("@stellar/freighter-api", () => ({
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));

const PASSPHRASE = "Test SDF Network ; September 2015";
const ACCOUNT = "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC";
const CHALLENGE_XDR = "challenge-transaction-xdr";
const SIGNED_XDR = "wallet-signed-transaction-xdr";

/** Renders nothing but the auth state, so the test drives login() like a page would. */
function Probe() {
  const { session, loading, error, login } = useAuth();
  return (
    <div>
      <button onClick={() => void login()}>login</button>
      <output data-testid="loading">{String(loading)}</output>
      <output data-testid="error">{error ?? ""}</output>
      <output data-testid="session">{session ? JSON.stringify(session) : ""}</output>
    </div>
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("AuthProvider.login success path", () => {
  it("connects Freighter, signs the challenge and stores the session, toggling loading", async () => {
    vi.stubEnv("VITE_STELLAR_NETWORK_PASSPHRASE", PASSPHRASE);
    vi.mocked(requestAccess).mockResolvedValue({ address: ACCOUNT } as never);
    vi.mocked(signTransaction).mockResolvedValue({ signedTxXdr: SIGNED_XDR } as never);
    const challenge = vi
      .spyOn(api, "challenge")
      .mockResolvedValue({ transaction: CHALLENGE_XDR });
    // Held open until the test releases it, so the loading=true phase is observable
    // instead of racing the microtask queue.
    let releaseToken!: (result: TokenResult) => void;
    const token = vi.spyOn(api, "token").mockImplementation(
      () =>
        new Promise<TokenResult>((resolve) => {
          releaseToken = resolve;
        }),
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "login" }));

    // loading flips on while the wallet round-trip is in flight…
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("true"));

    releaseToken({ token: "jwt-abc", partyId: "party-7" });

    // …and off again once the session has landed.
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));

    expect(requestAccess).toHaveBeenCalledTimes(1);
    expect(challenge).toHaveBeenCalledWith(ACCOUNT);
    expect(signTransaction).toHaveBeenCalledWith(CHALLENGE_XDR, {
      address: ACCOUNT,
      networkPassphrase: PASSPHRASE,
    });
    expect(token).toHaveBeenCalledWith(SIGNED_XDR);

    const expected = { token: "jwt-abc", partyId: "party-7", stellarAccount: ACCOUNT };
    expect(JSON.parse(screen.getByTestId("session").textContent ?? "")).toEqual(expected);
    expect(JSON.parse(localStorage.getItem("ballast.console.session") ?? "")).toEqual(expected);
    expect(screen.getByTestId("error").textContent).toBe("");
  });
});
