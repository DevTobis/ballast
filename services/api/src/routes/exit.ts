import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import type { OnChainExitQuote } from "@ballast/contract-clients";
import { decimalStringToScaled, scaledToDecimalString } from "@ballast/domain-types";
import type { ContractClients } from "../contract-clients.js";
import { exitExecuteSchema, exitQuoteRequestSchema } from "../schemas.js";
import { requireAsset, requireStellarAccount } from "./helpers.js";

export function registerExitRoutes(app: FastifyInstance, db: Database, contracts: ContractClients): void {
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
        expiresAt: new Date(onChainQuote.expiresAt * 1000),
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
    if (quote.status !== "open") return reply.code(409).send({ error: `quote is ${quote.status}` });
    if (quote.expiresAt.getTime() < Date.now()) {
      await db.update(schema.exitQuote).set({ status: "expired" }).where(eq(schema.exitQuote.id, quote.id));
      return reply.code(409).send({ error: "quote expired" });
    }

    const asset = await requireAsset(db, quote.assetId);
    const holderAccount = await requireStellarAccount(db, quote.holderId);

    await db.insert(schema.auditLog).values({
      actor: holderAccount,
      action: "exit.execute.requested",
      payload: { quoteId: quote.id, minUsdcOut: body.minUsdcOut.toString(), to: body.to },
    });

    const xdr = await contracts.exitDesk.exit(
      holderAccount,
      asset.contractC,
      decimalStringToScaled(quote.units),
      body.minUsdcOut,
      body.to,
    );

    return reply.code(201).send({ xdr, quoteId: quote.id });
  });
}
