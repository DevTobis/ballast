/**
 * Submission and settlement for the unsigned transactions every other route hands out.
 *
 *  - `POST /v1/tx/submit` takes the envelope back once the caller's wallet has signed it, sends
 *    it, waits for the network's verdict and applies the result to the books.
 *  - `POST /v1/tx/:hash/settle` does only the last step, for a transaction the caller submitted
 *    some other way (e.g. `stellar tx send`) or whose submit call timed out before it closed.
 *
 * Both only ever act on a transaction this API built (there's a `tx_intent` row for its hash) for
 * the party asking — this is not a general-purpose relay.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "@ballast/db";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { findIntent, settleIntent } from "../intents.js";

const submitSchema = z.object({ signedXdr: z.string().min(1) });

const POLL_INTERVAL_MS = 1000;
const POLL_ATTEMPTS = 45;

export function registerTxRoutes(
  app: FastifyInstance,
  db: Database,
  chain: ChainGateway,
  contracts: ContractClients,
): void {
  app.post("/v1/tx/submit", async (request, reply) => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "signedXdr is required" });

    let txHash: string;
    try {
      txHash = chain.txHash(parsed.data.signedXdr);
    } catch {
      return reply.code(400).send({ error: "signedXdr is not a valid transaction envelope" });
    }

    const intent = await findIntent(db, txHash);
    if (!intent || intent.partyId !== request.partyId) {
      return reply.code(404).send({ error: "not a transaction this API built for you" });
    }
    if (intent.status !== "pending") {
      return { txHash, kind: intent.kind, refId: intent.refId, status: intent.status, ledger: intent.ledger };
    }

    try {
      await chain.send(parsed.data.signedXdr);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "submission failed" });
    }

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      try {
        const settled = await settleIntent(db, chain, contracts, intent);
        if (settled.status !== "pending") {
          return reply.code(settled.status === "settled" ? 200 : 422).send(settled);
        }
      } catch (err) {
        // The envelope was already sent, so a failure here is not the caller's
        // problem to retry: settleIntent has put the intent back to `pending`
        // and the sweeper will settle it. Answering 5xx would make the wallet
        // user sign and submit again — and possibly double-act. Keep polling
        // and fall through to the honest 202 below.
        request.log.error({ err, txHash }, "settle attempt failed; intent is still pending");
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    // Sent, but not closed within the wait: the caller can poll `/v1/tx/:hash/settle`.
    return reply.code(202).send({ txHash, kind: intent.kind, refId: intent.refId, status: "pending", ledger: null });
  });

  app.post<{ Params: { hash: string } }>("/v1/tx/:hash/settle", async (request, reply) => {
    const intent = await findIntent(db, request.params.hash);
    if (!intent || intent.partyId !== request.partyId) {
      return reply.code(404).send({ error: "not a transaction this API built for you" });
    }
    return settleIntent(db, chain, contracts, intent);
  });
}
