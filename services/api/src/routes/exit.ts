import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import type { OnChainExitQuote } from "@ballast/contract-clients";
import { decimalStringToScaled, scaledToDecimalString } from "@ballast/domain-types";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { recordIntent } from "../intents.js";
import { exitExecuteSchema, exitQuoteRequestSchema } from "../schemas.js";
import { requireAsset, requireStellarAccount } from "./helpers.js";

/**
 * The lowest `minUsdcOut` an execute may carry, as a share of the quoted payout (9,900 = 99%, so
 * at most 1% slippage). Without a floor a client can send 0 and fill at spot, ignoring the price
 * the holder was shown, and the API cannot tell a quoted fill from a stale one.
 */
export const EXIT_MIN_OUT_FLOOR_BPS = 9_900n;

export function registerExitRoutes(app: FastifyInstance, db: Database, contracts: ContractClients, chain: ChainGateway): void {
  app.post("/v1/exit/quotes", async (request, reply) => {
    const body = exitQuoteRequestSchema.parse(request.body);
    const asset = await requireAsset(db, body.assetId);

    const onChainQuote: OnChainExitQuote = await contracts.exitDesk.quote(asset.contractC, body.units);

    const [row] = await db
      .insert(schema.exitQuote)
      .values({
        holderId: request.partyId,
        assetId: asset.id,
        units: scaledToDecimalString(body.units),
        price: scaledToDecimalString(onChainQuote.price),
        spreadBps: onChainQuote.spreadBps,
        usdcOut: scaledToDecimalString(onChainQuote.usdcOut),
        // `expiresAt` on-chain is Unix *seconds* (ledger timestamp); `Date` wants milliseconds.
        expiresAt: new Date(Number(onChainQuote.expiresAt) * 1000),
        status: "open",
      })
      .returning();

    return reply.code(201).send({
      id: row.id,
      assetId: asset.id,
      // Returned as raw 7-decimal-scaled-bigint strings (the on-chain/request-body convention),
      // not the Postgres decimal-string form these columns are stored as.
      units: decimalStringToScaled(row.units).toString(),
      price: decimalStringToScaled(row.price).toString(),
      spreadBps: row.spreadBps,
      usdcOut: decimalStringToScaled(row.usdcOut).toString(),
      expiresAt: row.expiresAt,
    });
  });

  app.post<{ Params: { id: string } }>("/v1/exit/quotes/:id/execute", async (request, reply) => {
    const body = exitExecuteSchema.parse(request.body);
    const [quote] = await db.select().from(schema.exitQuote).where(eq(schema.exitQuote.id, request.params.id)).limit(1);
    if (!quote) return reply.code(404).send({ error: "quote not found" });
    if (quote.holderId !== request.partyId) return reply.code(404).send({ error: "quote not found" });
    if (quote.status !== "open") return reply.code(409).send({ error: `quote is ${quote.status}` });
    if (quote.expiresAt.getTime() < Date.now()) {
      await db.update(schema.exitQuote).set({ status: "expired" }).where(eq(schema.exitQuote.id, quote.id));
      return reply.code(409).send({ error: "quote expired" });
    }

    // `ExitDesk.exit` takes units and a minimum, not a quote id, so the quote is bookkeeping only:
    // it moves to `filled` when a transaction settles. Until then a second execute would build a
    // second envelope, and both could be signed and settle for one quote.
    const inFlight = await db
      .select()
      .from(schema.txIntent)
      .where(
        and(
          eq(schema.txIntent.refId, quote.id),
          eq(schema.txIntent.kind, "exit.execute"),
          eq(schema.txIntent.status, "pending"),
        ),
      );
    if (inFlight.some((i) => i.refId === quote.id && i.kind === "exit.execute" && i.status === "pending")) {
      return reply.code(409).send({ error: "an execute for this quote is already pending" });
    }

    const quotedOut = decimalStringToScaled(quote.usdcOut);
    const floor = (quotedOut * EXIT_MIN_OUT_FLOOR_BPS) / 10_000n;
    const minUsdcOut = body.minUsdcOut ?? quotedOut;
    if (minUsdcOut < floor) {
      return reply.code(400).send({
        error: "minUsdcOut is below the allowed slippage floor for this quote",
        minUsdcOutFloor: floor.toString(),
        quotedUsdcOut: quotedOut.toString(),
      });
    }

    const asset = await requireAsset(db, quote.assetId);
    const holderAccount = await requireStellarAccount(db, quote.holderId);

    await db.insert(schema.auditLog).values({
      actor: holderAccount,
      action: "exit.execute.requested",
      payload: { quoteId: quote.id, minUsdcOut: minUsdcOut.toString(), to: body.to },
    });

    const xdr = await contracts.exitDesk.exit(
      holderAccount,
      asset.contractC,
      decimalStringToScaled(quote.units),
      minUsdcOut,
      body.to,
    );

    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "exit.execute",
      refId: quote.id,
      partyId: request.partyId,
    });
    return reply.code(201).send({ xdr, txHash, quoteId: quote.id });
  });
}
