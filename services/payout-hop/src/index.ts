/**
 * Internal Fastify server for `services/payout-hop` (PRD §5 Phase 2, §6.5). Exposes
 * `POST /internal/payout-hop/forward`, the endpoint `services/api`'s exit-execute handler (RWA ->
 * USDC, PRD §5 Phase 2 "Settlement") or credit-line-draw handler would call once the first leg
 * (Ballast contract -> operator G-account) has landed on-chain, to push funds the rest of the way
 * to an anchor with the memo it needs. Wiring that caller is `services/api`'s job, not this
 * service's — this endpoint only needs to be clean and well-documented for them to call.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { createDatabase, type Database } from "@ballast/db";
import { loadNetworkConfig } from "@ballast/network-config";
import { createLogger } from "@ballast/observability";
import { forwardPayout } from "./hop.js";
import { OperatorPayoutSigner, type PayoutSigner } from "./signer.js";

interface ForwardPayoutRequestBody {
  fromContractPayoutTxHash: string;
  toAnchorAccount: string;
  /** Decimal string over the wire — bigints don't survive JSON. */
  amount: string;
  memo: string;
  usdcAssetAddress: string;
  quoteId?: string;
}

export function buildServer(db: Database, signer: PayoutSigner): FastifyInstance {
  const app = Fastify({ logger: false });

  app.post<{ Body: ForwardPayoutRequestBody }>("/internal/payout-hop/forward", async (req, reply) => {
    const body = req.body;
    try {
      const result = await forwardPayout(db, signer, {
        fromContractPayoutTxHash: body.fromContractPayoutTxHash,
        toAnchorAccount: body.toAnchorAccount,
        amount: BigInt(body.amount),
        memo: body.memo,
        usdcAssetAddress: body.usdcAssetAddress,
        quoteId: body.quoteId,
      });
      return reply.send(result);
    } catch (err) {
      req.log.error({ err }, "payout-hop: forward failed");
      return reply.status(502).send({ error: err instanceof Error ? err.message : "unknown error" });
    }
  });

  return app;
}

async function main() {
  const logger = createLogger("payout-hop");
  const db = createDatabase();
  const network = loadNetworkConfig();
  const signer = await OperatorPayoutSigner.create(logger, network.rpcUrl, network.networkPassphrase);

  const app = buildServer(db, signer);
  const port = Number(process.env.PAYOUT_HOP_PORT ?? 3002);

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port, operator: signer.publicKey() }, "payout-hop: listening");
}

if (process.env.VITEST !== "true") {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
