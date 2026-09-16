import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { scaledToDecimalString } from "@ballast/domain-types";
import type { ContractClients } from "../contract-clients.js";
import { repoProposalSchema, repoTradeActionSchema } from "../schemas.js";
import { requireAsset, requireStellarAccount } from "./helpers.js";

export function registerRepoRoutes(app: FastifyInstance, db: Database, contracts: ContractClients): void {
  app.post("/v1/repo/proposals", async (request, reply) => {
    const body = repoProposalSchema.parse(request.body);
    const asset = await requireAsset(db, body.assetId);
    const [cashLenderAccount, cashBorrowerAccount] = await Promise.all([
      requireStellarAccount(db, body.cashLenderId),
      requireStellarAccount(db, body.cashBorrowerId),
    ]);

    const [row] = await db
      .insert(schema.repoTrade)
      .values({
        cashLenderId: body.cashLenderId,
        cashBorrowerId: body.cashBorrowerId,
        assetId: asset.id,
        units: scaledToDecimalString(body.units),
        cashAmount: scaledToDecimalString(body.cashAmount),
        rateBps: body.rateBps,
        kind: body.kind,
        startLedger: 0,
        maturityAt: new Date(body.maturityAt),
        agreementHash: body.agreementHash.toString("hex"),
        status: "proposed",
      })
      .returning();

    const xdr = await contracts.repoDvp.propose(cashLenderAccount, {
      cashBorrower: cashBorrowerAccount,
      asset: asset.contractC,
      units: body.units,
      cashAmount: body.cashAmount,
      rateBps: body.rateBps,
      kind: body.kind,
      maturityAt: Math.floor(new Date(body.maturityAt).getTime() / 1000),
      agreementHash: body.agreementHash,
    });

    return reply.code(201).send({ xdr, tradeId: row.id });
  });

  app.post<{ Params: { id: string } }>("/v1/repo/proposals/:id/accept", async (request, reply) => {
    const body = repoTradeActionSchema.parse(request.body);
    const [trade] = await db.select().from(schema.repoTrade).where(eq(schema.repoTrade.id, request.params.id)).limit(1);
    if (!trade) return reply.code(404).send({ error: "repo proposal not found" });
    if (trade.status !== "proposed") return reply.code(409).send({ error: `trade is ${trade.status}` });

    const cashBorrowerAccount = await requireStellarAccount(db, trade.cashBorrowerId);
    const xdr = await contracts.repoDvp.acceptAndSettle(cashBorrowerAccount, body.contractTradeId);

    return reply.code(201).send({ xdr, tradeId: trade.id });
  });

  app.post<{ Params: { id: string } }>("/v1/repo/trades/:id/unwind", async (request, reply) => {
    const body = repoTradeActionSchema.parse(request.body);
    const [trade] = await db.select().from(schema.repoTrade).where(eq(schema.repoTrade.id, request.params.id)).limit(1);
    if (!trade) return reply.code(404).send({ error: "repo trade not found" });
    if (trade.status !== "settled") return reply.code(409).send({ error: `trade is ${trade.status}, not settled` });

    const cashBorrowerAccount = await requireStellarAccount(db, trade.cashBorrowerId);
    const xdr = await contracts.repoDvp.unwind(cashBorrowerAccount, body.contractTradeId);

    return reply.code(201).send({ xdr, tradeId: trade.id });
  });
}
