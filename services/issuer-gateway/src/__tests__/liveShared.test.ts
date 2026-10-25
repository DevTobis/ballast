import { afterEach, describe, expect, it, vi } from "vitest";
import { SpikoAdapter } from "../adapters/spikoAdapter.js";
import { EtherfuseAdapter } from "../adapters/etherfuseAdapter.js";
import { FranklinAdapter } from "../adapters/franklinAdapter.js";

const TIMEOUT_MS = 20;
const TIMEOUT_ENV = "ISSUER_GATEWAY_TIMEOUT_MS";

const requests = [SpikoAdapter, EtherfuseAdapter, FranklinAdapter].flatMap((Adapter) => {
  const adapter = new Adapter("https://issuer.example", "test-key", "https://approval.example");
  return [
    {
      operation: `${Adapter.name}.requestRedemption`,
      send: () => adapter.requestRedemption("ASSET", 1n, "GDEST"),
    },
    {
      operation: `${Adapter.name}.requestSep8Approval`,
      send: () => adapter.requestSep8Approval("ASSET", "AAAA"),
    },
  ];
});

/** A stalled issuer request that rejects only when fetch's signal is aborted. */
function waitForAbort<T>(signal: AbortSignal | null | undefined): Promise<T> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error("fetch did not receive a timeout signal"));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(requests)("$operation timeout", ({ operation, send }) => {
  it("aborts a stalled fetch and does not retry the POST", async () => {
    vi.stubEnv(TIMEOUT_ENV, String(TIMEOUT_MS));
    const fetchMock = vi.fn<typeof fetch>((_url, init) => waitForAbort<Response>(init?.signal));
    vi.stubGlobal("fetch", fetchMock);

    const startedAt = performance.now();
    await expect(send()).rejects.toMatchObject({
      message: `${operation}: request timed out after ${TIMEOUT_MS} ms`,
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

// Each path is shared by all issuers; the cases above check their diagnostic labels as well.
const sharedRequests = requests.slice(0, 2);

describe.each(sharedRequests)("$operation configuration", ({ send }) => {
  it("defaults to 15 seconds and preserves ordinary network errors", async () => {
    vi.stubEnv(TIMEOUT_ENV, undefined);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const error = new TypeError("connection refused");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    await expect(send()).rejects.toBe(error);
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it("accepts the maximum supported timer delay", async () => {
    vi.stubEnv(TIMEOUT_ENV, "2147483647");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const error = new TypeError("connection refused");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    await expect(send()).rejects.toBe(error);
    expect(timeout).toHaveBeenCalledWith(2_147_483_647);
  });

  it.each(["", "0", "-1", "1.5", "not-a-number", "Infinity", "2147483648"])(
    "rejects invalid timeout %j before contacting an issuer",
    async (value) => {
      vi.stubEnv(TIMEOUT_ENV, value);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(send()).rejects.toThrow(/ISSUER_GATEWAY_TIMEOUT_MS must be an integer/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("preserves malformed JSON errors", async () => {
    vi.stubEnv(TIMEOUT_ENV, "5000");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{", { status: 200 })));

    await expect(send()).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("issuer response body timeouts", () => {
  it.each([
    { ...sharedRequests[0], status: 200 },
    { ...sharedRequests[0], status: 503 },
    { ...sharedRequests[1], status: 200 },
    { ...sharedRequests[1], status: 400 },
  ])("bounds the $operation body read on HTTP $status", async ({ operation, send, status }) => {
    vi.stubEnv(TIMEOUT_ENV, String(TIMEOUT_MS));
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          void waitForAbort(init?.signal).catch((err) => controller.error(err));
        },
      });
      return new Response(body, { status });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(send()).rejects.toMatchObject({
      message: `${operation}: request timed out after ${TIMEOUT_MS} ms`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
