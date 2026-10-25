/**
 * Internal Fastify server for `services/payout-hop` (PRD §5 Phase 2, §6.5). Exposes
 * `POST /internal/payout-hop/forward`, the endpoint `services/api`'s exit-execute handler (RWA ->
 * USDC, PRD §5 Phase 2 "Settlement") or credit-line-draw handler would call once the first leg
 * (Ballast contract -> operator G-account) has landed on-chain, to push funds the rest of the way
 * to an anchor with the memo it needs.
 *
 * This endpoint moves the operator's own USDC, so it is locked down three ways: every request must
 * carry the shared `x-internal-token`, the server listens on loopback unless told otherwise, and
 * what a request may ask for is bounded by the operator's `PayoutPolicy` (approved destinations,
 * the configured USDC, a per-payout cap), with each first-leg transaction checked on-chain and
 * payable once.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { createDatabase, type Database } from "@ballast/db";
import {
  internalBindHost,
  loadInternalToken,
  loadNetworkConfig,
  requireInternalToken,
} from "@ballast/network-config";
import { createAlerter, createLogger, type Alerter } from "@ballast/observability";
import { rpc } from "@stellar/stellar-sdk";
import {
  DuplicatePayoutError,
  PayoutRefusedError,
  forwardPayout,
  loadPayoutPolicy,
  type PayoutPolicy,
} from "./hop.js";
import { OperatorPayoutSigner, type PayoutSigner } from "./signer.js";
import { bookPendingPayouts } from "./repair.js";
import {
  FirstLegRefusedError,
  FirstLegUnavailableError,
  RpcFirstLegVerifier,
  type FirstLegVerifier,
} from "./firstLeg.js";

const forwardBody = z.object({
  fromContractPayoutTxHash: z.string().min(1),
  toAnchorAccount: z.string().min(1),
  /** Decimal digits over the wire — bigints don't survive JSON. */
  amount: z.string().regex(/^[0-9]+$/, "amount must be a whole number of stroops"),
  memo: z.string().min(1).max(64),
  usdcAssetAddress: z.string().min(1),
  quoteId: z.string().uuid().optional(),
});

export function buildServer(
  db: Database,
  signer: PayoutSigner,
  options: { internalToken: string; policy: PayoutPolicy; verifier: FirstLegVerifier; alerter?: Alerter },
): FastifyInstance {
  const app = Fastify({ logger: false });
  requireInternalToken(app, options.internalToken);

  app.post("/internal/payout-hop/forward", async (req, reply) => {
    const parsed = forwardBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    const body = parsed.data;
    try {
      const result = await forwardPayout(
        db,
        signer,
        options.verifier,
        {
          fromContractPayoutTxHash: body.fromContractPayoutTxHash,
          toAnchorAccount: body.toAnchorAccount,
          amount: BigInt(body.amount),
          memo: body.memo,
          usdcAssetAddress: body.usdcAssetAddress,
          quoteId: body.quoteId,
        },
        options.policy,
        options.alerter,
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof PayoutRefusedError) return reply.status(403).send({ error: err.message });
      if (err instanceof DuplicatePayoutError) return reply.status(409).send({ error: err.message });
      if (err instanceof FirstLegRefusedError) return reply.status(422).send({ error: err.message });
      if (err instanceof FirstLegUnavailableError) return reply.status(503).send({ error: err.message });
      req.log.error({ err }, "payout-hop: forward failed");
      return reply.status(502).send({ error: err instanceof Error ? err.message : "unknown error" });
    }
  });

  return app;
}

async function main() {
  const logger = createLogger("payout-hop");
  const internalToken = loadInternalToken();
  const policy = loadPayoutPolicy();
  const db = createDatabase();
  const network = loadNetworkConfig();
  const signer = await OperatorPayoutSigner.create(logger, network.rpcUrl, network.networkPassphrase);

  const alerter = createAlerter("payout-hop");

  const verifier = new RpcFirstLegVerifier(
    new rpc.Server(network.rpcUrl, { allowHttp: network.rpcUrl.startsWith("http://") }),
    network.networkPassphrase,
  );

  const app = buildServer(db, signer, { internalToken, policy, verifier, alerter });
  const port = Number(process.env.PAYOUT_HOP_PORT ?? 3002);
  const host = internalBindHost("payout-hop");

  await app.listen({ port, host });
  logger.info({ port, host, operator: signer.publicKey(), destinations: policy.allowedDestinations.size }, "payout-hop: listening");

  // Book anything a previous run sent but could not record, then keep sweeping.
  const repair = async () => {
    try {
      const result = await bookPendingPayouts(db, alerter);
      if (result.booked.length || result.alreadyBooked.length || result.failed.length) {
        logger.info(result, "payout-hop: repaired unbooked payouts");
      }
    } catch (err) {
      logger.error({ err }, "payout-hop: unbooked-payout repair failed");
    }
  };
  await repair();
  setInterval(repair, Number(process.env.PAYOUT_HOP_REPAIR_INTERVAL_S ?? 300) * 1000).unref();
}

if (process.env.VITEST !== "true") {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
