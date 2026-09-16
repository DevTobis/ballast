import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { classifyMargin, decimalStringToScaled, scaledToDecimalString } from "@ballast/domain-types";
import type { ContractClients } from "../contract-clients.js";
import {
  createDrawSchema,
  createPledgeSchema,
  createRepaymentSchema,
  openCreditLineSchema,
} from "../schemas.js";
import { estimateLtvBps, outstandingDebt, requireAsset, requireCreditLine, requireStellarAccount } from "./helpers.js";

const MARGIN_THRESHOLDS = { warningBps: 7000, marginCallBps: 8000, liquidationBps: 9000 };

export function registerCreditLineRoutes(
  app: FastifyInstance,
  db: Database,
  contracts: ContractClients,
): void {
  app.post("/v1/credit-lines", async (request, reply) => {
    const body = openCreditLineSchema.parse(request.body);

    const [lenderAccount, borrowerAccount] = await Promise.all([
      requireStellarAccount(db, body.lenderId),
      requireStellarAccount(db, body.borrowerId),
    ]);

    const [row] = await db
      .insert(schema.creditLine)
      .values({
        lenderId: body.lenderId,
        borrowerId: body.borrowerId,
        loanCcy: body.loanCcy,
        limitAmount: scaledToDecimalString(body.limit),
        rateBps: body.rateBps,
        feeBps: body.feeBps,
        cureWindowS: body.cureWindowS,
        status: "pending_open",
        agreementHash: body.agreementHash.toString("hex"),
      })
      .returning();

    const xdr = await contracts.creditLine.open(lenderAccount, {
      borrower: borrowerAccount,
      asset: body.asset,
      limit: body.limit,
      rateBps: body.rateBps,
      cureS: body.cureWindowS,
      agreementHash: body.agreementHash,
    });

    return reply.code(201).send({ xdr, creditLineId: row.id });
  });

  app.get<{ Params: { id: string } }>("/v1/credit-lines/:id", async (request, reply) => {
    let line;
    try {
      line = await requireCreditLine(db, request.params.id);
    } catch {
      return reply.code(404).send({ error: "credit line not found" });
    }

    const [debt, ltvBps] = await Promise.all([
      outstandingDebt(db, line.id),
      estimateLtvBps(db, line.id),
    ]);

    return {
      id: line.id,
      lenderId: line.lenderId,
      borrowerId: line.borrowerId,
      loanCcy: line.loanCcy,
      // Both returned as raw 7-decimal-scaled-bigint strings (the on-chain/request-body
      // convention), not the Postgres decimal-string form `limitAmount` is stored as — a
      // response that mixed the two conventions for the same kind of quantity was a real bug.
      limit: decimalStringToScaled(line.limitAmount).toString(),
      drawn: debt.toString(),
      rateBps: line.rateBps,
      feeBps: line.feeBps,
      cureWindowS: line.cureWindowS,
      status: line.status,
      contractLineId: line.contractLineId,
      ltvBps,
      marginState: classifyMargin(ltvBps, MARGIN_THRESHOLDS),
    };
  });

  app.post<{ Params: { id: string } }>("/v1/credit-lines/:id/pledges", async (request, reply) => {
    const body = createPledgeSchema.parse(request.body);
    let line;
    try {
      line = await requireCreditLine(db, request.params.id);
    } catch {
      return reply.code(404).send({ error: "credit line not found" });
    }
    if (!line.contractLineId) {
      return reply.code(409).send({ error: "credit line has not settled on-chain yet" });
    }

    const asset = await requireAsset(db, body.assetId);
    const borrowerAccount = await requireStellarAccount(db, line.borrowerId);

    const [row] = await db
      .insert(schema.pledge)
      .values({
        creditLineId: line.id,
        assetId: asset.id,
        units: scaledToDecimalString(body.units),
        custodyMode: body.custodyMode,
        status: "pending",
      })
      .returning();

    // Custody mode is a property of the asset (set via `PledgeVault.configure_asset`), not a
    // per-call choice, so it's recorded on the `pledge` row for our own bookkeeping but not sent
    // on-chain here.
    const xdr = await contracts.pledgeVault.pledge(
      borrowerAccount,
      BigInt(line.contractLineId),
      asset.contractC,
      body.units,
    );

    return reply.code(201).send({ xdr, pledgeId: row.id });
  });

  app.delete<{ Params: { id: string; pledgeId: string } }>(
    "/v1/credit-lines/:id/pledges/:pledgeId",
    async (request, reply) => {
      let line;
      try {
        line = await requireCreditLine(db, request.params.id);
      } catch {
        return reply.code(404).send({ error: "credit line not found" });
      }
      if (!line.contractLineId) {
        return reply.code(409).send({ error: "credit line has not settled on-chain yet" });
      }

      const [pledge] = await db
        .select()
        .from(schema.pledge)
        .where(eq(schema.pledge.id, request.params.pledgeId))
        .limit(1);
      if (!pledge || pledge.creditLineId !== line.id) {
        return reply.code(404).send({ error: "pledge not found on this credit line" });
      }

      const postReleaseLtvBps = await estimateLtvBps(db, line.id, pledge.id);
      if (postReleaseLtvBps >= MARGIN_THRESHOLDS.marginCallBps) {
        return reply.code(409).send({
          error: "release would breach the healthy LTV threshold",
          projectedLtvBps: postReleaseLtvBps,
        });
      }

      const asset = await requireAsset(db, pledge.assetId);
      const borrowerAccount = await requireStellarAccount(db, line.borrowerId);

      await db.update(schema.pledge).set({ status: "pending_release" }).where(eq(schema.pledge.id, pledge.id));

      const xdr = await contracts.pledgeVault.release(
        borrowerAccount,
        BigInt(line.contractLineId),
        asset.contractC,
        decimalStringToScaled(pledge.units),
      );

      return { xdr, pledgeId: pledge.id, projectedLtvBps: postReleaseLtvBps };
    },
  );

  app.post<{ Params: { id: string } }>("/v1/credit-lines/:id/draws", async (request, reply) => {
    const body = createDrawSchema.parse(request.body);
    let line;
    try {
      line = await requireCreditLine(db, request.params.id);
    } catch {
      return reply.code(404).send({ error: "credit line not found" });
    }
    if (!line.contractLineId) {
      return reply.code(409).send({ error: "credit line has not settled on-chain yet" });
    }
    const borrowerAccount = await requireStellarAccount(db, line.borrowerId);

    // `draw` rows require a real `tx_hash`/`ledger` (populated by the indexer once the signed tx
    // lands on-chain), so the pending request itself is recorded in `audit_log` instead.
    await db.insert(schema.auditLog).values({
      actor: borrowerAccount,
      action: "credit_line.draw.requested",
      payload: { creditLineId: line.id, amount: body.amount.toString(), to: body.to },
    });

    const xdr = await contracts.creditLine.draw(borrowerAccount, BigInt(line.contractLineId), body.amount, body.to);
    return reply.code(201).send({ xdr });
  });

  app.post<{ Params: { id: string } }>("/v1/credit-lines/:id/repayments", async (request, reply) => {
    const body = createRepaymentSchema.parse(request.body);
    let line;
    try {
      line = await requireCreditLine(db, request.params.id);
    } catch {
      return reply.code(404).send({ error: "credit line not found" });
    }
    if (!line.contractLineId) {
      return reply.code(409).send({ error: "credit line has not settled on-chain yet" });
    }
    const borrowerAccount = await requireStellarAccount(db, line.borrowerId);

    await db.insert(schema.auditLog).values({
      actor: borrowerAccount,
      action: "credit_line.repayment.requested",
      payload: { creditLineId: line.id, amount: body.amount.toString() },
    });

    const xdr = await contracts.creditLine.repay(borrowerAccount, BigInt(line.contractLineId), body.amount);
    return reply.code(201).send({ xdr });
  });
}
