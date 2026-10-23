import { afterEach, describe, expect, it, vi } from "vitest";
import { createAlerter } from "../metrics.js";

afterEach(() => vi.restoreAllMocks());

function setup(options: Parameters<typeof createAlerter>[1] = {}) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let now = 1_000_000;
  const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
  const alerter = createAlerter("price-guard", {
    webhookUrl: "https://hooks.example.com/alerts",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => now,
    cooldownMs: 60_000,
    ...options,
  });
  return { alerter, fetchImpl, advance: (ms: number) => (now += ms) };
}

describe("createAlerter", () => {
  it("posts a readable message and the structured alert, with bigints made JSON-safe", async () => {
    const { alerter, fetchImpl } = setup();
    alerter.fire("price_halted", { assetId: "a1", code: "USTRY", value: 10_764_250n, reason: "moved 7.6% in a day" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/alerts");
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("[ballast/price-guard] price_halted (a1) - moved 7.6% in a day");
    expect(body.content).toBe(body.text);
    expect(body).toMatchObject({ service: "price-guard", kind: "price_halted", context: { value: "10764250" } });
  });

  it("sends a repeating condition once per cooldown, per kind and subject", () => {
    const { alerter, fetchImpl, advance } = setup();
    alerter.fire("price_degraded", { assetId: "a1" });
    alerter.fire("price_degraded", { assetId: "a1" }); // same subject: suppressed
    alerter.fire("price_degraded", { assetId: "a2" }); // another asset: sent
    alerter.fire("price_halted", { assetId: "a1" }); // another kind: sent
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    advance(61_000);
    alerter.fire("price_degraded", { assetId: "a1" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("sends state escalation from MarginCall to Liquidation within cooldown, but deduplicates same state", () => {
    const { alerter, fetchImpl } = setup();
    alerter.fire("margin_call", { creditLineId: "line-1", state: "MarginCall", ltvBps: 8500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Escalation from MarginCall to Liquidation within cooldown MUST be sent
    alerter.fire("margin_call", { creditLineId: "line-1", state: "Liquidation", ltvBps: 9500 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Repeated alert for the same state remains deduplicated within cooldown
    alerter.fire("margin_call", { creditLineId: "line-1", state: "Liquidation", ltvBps: 9600 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("only logs when no webhook is configured", () => {
    const { alerter, fetchImpl } = setup({ webhookUrl: undefined, env: {} });
    alerter.fire("rpc_lag_high", { lagLedgers: 40 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("never throws when the webhook is down, and still logs", async () => {
    const { alerter, fetchImpl } = setup();
    fetchImpl.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(() => alerter.fire("price_halted", { assetId: "a1" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("webhook failed: ECONNREFUSED"));
  });

  it("reports a non-2xx answer from the webhook", async () => {
    const { alerter, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(new Response("bad", { status: 404 }));
    alerter.fire("margin_call", { creditLineId: "l1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("webhook responded 404"));
  });
});
