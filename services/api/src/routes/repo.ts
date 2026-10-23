import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { scaledToDecimalString } from "@ballast/domain-types";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { recordIntent } from "../intents.js";
import { repoProposalSchema, repoTopUpSchema, repoTradeActionSchema } from "../schemas.js";
import { requireAsset, requireStellarAccount } from "./helpers.js";

export function registerRepoRoutes(app: FastifyInstance, db: Database, contracts: ContractClients, chain: ChainGateway): void {
  app.post("/v1/repo/proposals", async (request, reply) => {
    const body = repoProposalSchema.parse(request.body);
    if (body.cashLenderId !== request.partyId) {
      return reply.code(403).send({ error: "a repo can only be proposed by its own cash lender" });
    }
    const asset = await requireAsset(db, body.assetId);
    const [cashLenderAccount, cashBorrowerAccount] = await Promise.all([
      requireStellarAccount(db, body.cashLenderId),
      requireStellarAccount(db, body.cashBorrowerId),
    ]);

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

    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "repo.propose",
      refId: row.id,
      partyId: request.partyId,
    });
    return reply.code(201).send({ xdr, txHash, tradeId: row.id });
  });

  app.post<{ Params: { id: string } }>("/v1/repo/proposals/:id/accept", async (request, reply) => {
    const body = repoTradeActionSchema.parse(request.body ?? {});
    const [trade] = await db.select().from(schema.repoTrade).where(eq(schema.repoTrade.id, request.params.id)).limit(1);
    if (!trade) return reply.code(404).send({ error: "repo proposal not found" });
    if (trade.cashBorrowerId !== request.partyId) {
      return reply.code(403).send({ error: "only the cash borrower can accept a repo proposal" });
    }
    if (trade.status !== "proposed") return reply.code(409).send({ error: `trade is ${trade.status}` });

    const cashBorrowerAccount = await requireStellarAccount(db, trade.cashBorrowerId);
    const contractTradeId = body.contractTradeId ?? (trade.contractTradeId ? BigInt(trade.contractTradeId) : null);
    if (contractTradeId === null) {
      return reply.code(409).send({ error: "repo proposal has not settled on-chain yet" });
    }
    const xdr = await contracts.repoDvp.acceptAndSettle(cashBorrowerAccount, contractTradeId);
    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "repo.accept",
      refId: trade.id,
      partyId: request.partyId,
    });

    return reply.code(201).send({ xdr, txHash, tradeId: trade.id });
  });

  app.post<{ Params: { id: string } }>("/v1/repo/trades/:id/unwind", async (request, reply) => {
    const body = repoTradeActionSchema.parse(request.body ?? {});
    const [trade] = await db.select().from(schema.repoTrade).where(eq(schema.repoTrade.id, request.params.id)).limit(1);
    if (!trade) return reply.code(404).send({ error: "repo trade not found" });
    if (trade.cashBorrowerId !== request.partyId && trade.cashLenderId !== request.partyId) {
      return reply.code(404).send({ error: "repo trade not found" });
    }
    if (trade.status !== "settled") return reply.code(409).send({ error: `trade is ${trade.status}, not settled` });

    const callerAccount = await requireStellarAccount(db, request.partyId);
    const contractTradeId = body.contractTradeId ?? (trade.contractTradeId ? BigInt(trade.contractTradeId) : null);
    if (contractTradeId === null) {
      return reply.code(409).send({ error: "repo proposal has not settled on-chain yet" });
    }
    const xdr = await contracts.repoDvp.unwind(callerAccount, contractTradeId);
    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "repo.unwind",
      refId: trade.id,
      partyId: request.partyId,
    });

    return reply.code(201).send({ xdr, txHash, tradeId: trade.id });
  });

  // The cash borrower's way to cure a margin call: add collateral. If it is enough, the contract
  // clears the call in the same transaction.
  app.post<{ Params: { id: string } }>("/v1/repo/trades/:id/top-ups", async (request, reply) => {
    const body = repoTopUpSchema.parse(request.body);
    const [trade] = await db.select().from(schema.repoTrade).where(eq(schema.repoTrade.id, request.params.id)).limit(1);
    if (!trade) return reply.code(404).send({ error: "repo trade not found" });
    if (trade.cashBorrowerId !== request.partyId) {
      return reply.code(403).send({ error: "only the cash borrower can add collateral to a repo" });
    }
    if (trade.status !== "settled") return reply.code(409).send({ error: `trade is ${trade.status}, not settled` });
    if (!trade.contractTradeId) return reply.code(409).send({ error: "repo has not settled on-chain yet" });

    const cashBorrowerAccount = await requireStellarAccount(db, trade.cashBorrowerId);
    const xdr = await contracts.repoDvp.topUp(cashBorrowerAccount, BigInt(trade.contractTradeId), body.units);
    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "repo.top_up",
      refId: trade.id,
      partyId: request.partyId,
      payload: { units: body.units.toString() },
    });

    return reply.code(201).send({ xdr, txHash, tradeId: trade.id });
  });
}
