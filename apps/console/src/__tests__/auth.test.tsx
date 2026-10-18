import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { requestAccess, signTransaction } from "@stellar/freighter-api";
import { AuthProvider, useAuth } from "../lib/auth.tsx";
import { api, ApiError } from "../lib/api.ts";

vi.mock("@stellar/freighter-api", () => ({ requestAccess: vi.fn(), signTransaction: vi.fn() }));
vi.mock("../lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.ts")>();
  return { ...actual, api: { ...actual.api, challenge: vi.fn(), token: vi.fn() } };
});

const STORAGE_KEY = "ballast.console.session";
const ACCOUNT = "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC";

const access = vi.mocked(requestAccess);
const sign = vi.mocked(signTransaction);
const challenge = vi.mocked(api.challenge);
const token = vi.mocked(api.token);

/** Every step of the SEP-10 flow succeeds; each test then breaks one of them. */
function happyPath() {
  access.mockResolvedValue({ address: ACCOUNT } as Awaited<ReturnType<typeof requestAccess>>);
  challenge.mockResolvedValue({ transaction: "challenge-xdr" } as Awaited<ReturnType<typeof api.challenge>>);
  sign.mockResolvedValue({ signedTxXdr: "signed-xdr", signerAddress: ACCOUNT } as Awaited<
    ReturnType<typeof signTransaction>
  >);
  token.mockResolvedValue({ token: "jwt", partyId: "party-1" } as Awaited<ReturnType<typeof api.token>>);
}

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  happyPath();
});

afterEach(() => {
  cleanup();
});

describe("AuthProvider.login failure branches", () => {
  const cases: Array<[string, () => void, string]> = [
    [
      "Freighter denies access",
      () => access.mockResolvedValueOnce({ error: { message: "denied" } } as Awaited<ReturnType<typeof requestAccess>>),
      "denied",
    ],
    [
      "the challenge request fails",
      () => challenge.mockRejectedValueOnce(new ApiError(503, "auth service unavailable")),
      "auth service unavailable",
    ],
    [
      "the user declines to sign",
      () =>
        sign.mockResolvedValueOnce({ error: { message: "user declined" } } as Awaited<
          ReturnType<typeof signTransaction>
        >),
      "user declined",
    ],
    ["the token exchange rejects with a non-Error value", () => token.mockRejectedValueOnce("boom"), "login failed"],
  ];

  it.each(cases)("%s: reports the error, leaves no session behind, and a retry recovers", async (_, fail, message) => {
    fail();
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(() => result.current.login());

    expect(result.current.error).toBe(message);
    expect(result.current.session).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    await act(() => result.current.login());

    expect(result.current.error).toBeNull();
    expect(result.current.session).toEqual({ token: "jwt", partyId: "party-1", stellarAccount: ACCOUNT });
    expect(result.current.loading).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual(result.current.session);
  });
});
