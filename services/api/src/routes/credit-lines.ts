import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@ballast/db";
import { classifyMargin, decimalStringToScaled, scaledToDecimalString } from "@ballast/domain-types";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { recordIntent, withTransaction } from "../intents.js";
import {
  createDrawSchema,
  createPledgeSchema,
  createRepaymentSchema,
  fundCreditLineSchema,
  openCreditLineSchema,
  withdrawSchema,
} from "../schemas.js";
import { estimateLtvBps, isLineParty, outstandingDebt, requireAsset, requireCreditLine, requireStellarAccount } from "./helpers.js";

const MARGIN_THRESHOLDS = { warningBps: 7000, marginCallBps: 8000, liquidationBps: 9000 };

export function registerCreditLineRoutes(
  app: FastifyInstance,
  db: Database,
  contracts: ContractClients,
  chain: ChainGateway,
): void {
  app.post("/v1/credit-lines", async (request, reply) => {
    const body = openCreditLineSchema.parse(request.body);
    if (body.lenderId !== request.partyId) {
      return reply.code(403).send({ error: "a credit line can only be opened by its own lender" });
    }

    const [lenderAccount, borrowerAccount] = await Promise.all([
      requireStellarAccount(db, body.lenderId),
      requireStellarAccount(db, body.borrowerId),
    ]);

    const xdr = await contracts.creditLine.open(lenderAccount, {
      borrower: borrowerAccount,
      asset: body.asset,
      limit: body.limit,
      rateBps: body.rateBps,
      cureS: body.cureWindowS,
      agreementHash: body.agreementHash,
    });

    const { row, txHash } = await withTransaction(db, async (trx) => {
      const [row] = await trx
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

      const txHash = await recordIntent(trx, chain, {
        xdr,
        kind: "credit_line.open",
        refId: row.id,
        partyId: request.partyId,
      });
      return { row, txHash };
    });

    return reply.code(201).send({ xdr, txHash, creditLineId: row.id });
  });

  app.get<{ Params: { id: string } }>("/v1/credit-lines/:id", async (request, reply) => {
    let line;
    try {
      line = await requireCreditLine(db, request.params.id);
    } catch {
      return reply.code(404).send({ error: "credit line not found" });
    }
    // Same answer as a line that does not exist: don't confirm another party's line is there.
    if (!isLineParty(line, request.partyId, "either")) {
      return reply.code(404).send({ error: "credit line not found" });
    }

    let [debt, ltvBps] = await Promise.all([
      outstandingDebt(db, line.id),
      estimateLtvBps(db, line.id),
    ]);
    let marginState = classifyMargin(ltvBps, MARGIN_THRESHOLDS);
    let priceStatus: string | null = null;
    let collateralValue: string | null = null;
    let funded: string | null = null;
    let undrawn: string | null = null;
    let claimableInterest: string | null = null;
    let liquidation: {
      closed: boolean;
      debt: string;
      recovered: string;
      surplus: string;
      shortfall: string;
    } | null = null;

    // Once the line exists on-chain the contract's own view is authoritative (it includes accrued
    // interest and uses the live guarded price); the Postgres-derived figures above are only the
    // fallback for a line that hasn't settled yet or an RPC that can't be reached.
    if (line.contractLineId) {
      try {
        const [view, onChain] = await Promise.all([
          contracts.creditLine.ltv(BigInt(line.contractLineId)),
          contracts.creditLine.line(BigInt(line.contractLineId)),
        ]);
        debt = BigInt(view.debt);
        ltvBps = view.ltvBps;
        marginState = view.state;
        priceStatus = view.priceStatus;
        collateralValue = BigInt(view.collateralValue).toString();
        funded = BigInt(onChain.funded).toString();
        undrawn = (BigInt(onChain.funded) - BigInt(onChain.drawn)).toString();
        claimableInterest = BigInt(await contracts.creditLine.claimableInterest(BigInt(line.contractLineId))).toString();
        if (onChain.status !== "Open") {
          const record = await contracts.creditLine.liquidationRecord(BigInt(line.contractLineId));
          liquidation = {
            closed: record.closed,
            debt: BigInt(record.debt).toString(),
            recovered: BigInt(record.recovered).toString(),
            surplus: BigInt(record.surplus).toString(),
            shortfall: BigInt(record.shortfall).toString(),
          };
        }
      } catch (err) {
        request.log.warn({ err, creditLineId: line.id }, "on-chain ltv read failed; using Postgres estimate");
      }
    }

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
      marginState,
      funded,
      undrawn,
      claimableInterest,
      collateralValue,
      priceStatus,
      liquidation,
    };
  });

  // Not in the PRD §9 route list (which covers borrower-facing actions), but `CreditLine.fund`
  // is a real, lender-authed on-chain function with no other way to reach it from this API - a
  // credit line a lender never funds can never be drawn against.
  app.post<{ Params: { id: string } }>("/v1/credit-lines/:id/fund", async (request, reply) => {
    const body = fundCreditLineSchema.parse(request.body);
    let line;
    try {
      line = await requireCreditLine(db, request.params.id);
    } catch {
      return reply.code(404).send({ error: "credit line not found" });
    }
    if (!line.contractLineId) {
      return reply.code(409).send({ error: "credit line has not settled on-chain yet" });
    }
    if (line.lenderId !== request.partyId) {
      return reply.code(403).send({ error: "only this line's lender may fund it" });
    }

    const lenderAccount = await requireStellarAccount(db, line.lenderId);
    const xdr = await contracts.creditLine.fund(lenderAccount, BigInt(line.contractLineId), body.amount);
    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "credit_line.fund",
      refId: line.id,
      partyId: request.partyId,
      payload: { amount: body.amount.toString() },
    });
    return reply.code(201).send({ xdr, txHash });
  });

  // The lender's way out: without these, repaid principal and interest would sit in the contract
  // for good, since `fund` is the only other thing that touches the lender's USDC.
  app.post<{ Params: { id: string } }>("/v1/credit-lines/:id/withdrawals", async (request, reply) => {
    const body = withdrawSchema.parse(request.body);
    let line;
    try {
      line = await requireCreditLine(db, request.params.id);
    } catch {
      return reply.code(404).send({ error: "credit line not found" });
    }
    if (!line.contractLineId) {
      return reply.code(409).send({ error: "credit line has not settled on-chain yet" });
    }
    if (line.lenderId !== request.partyId) {
      return reply.code(403).send({ error: "only this line's lender may withdraw from it" });
    }

    const lenderAccount = await requireStellarAccount(db, line.lenderId);
    const contractLine = BigInt(line.contractLineId);
    const xdr =
      body.kind === "undrawn"
        ? await contracts.creditLine.withdrawUndrawn(lenderAccount, contractLine, body.amount)
        : await contracts.creditLine.withdrawInterest(lenderAccount, contractLine, body.amount);
    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "credit_line.withdraw",
      refId: line.id,
      partyId: request.partyId,
      payload: { kind: body.kind, amount: body.amount.toString() },
    });
    return reply.code(201).send({ xdr, txHash });
  });

  // After the keeper has liquidated a line and sent the collateral to the lender in kind, the
  // lender closes it: the contract books the outcome and, if the collateral was worth more than the
  // debt, pays the borrower the difference out of the lender's USDC in the same transaction.
  app.post<{ Params: { id: string } }>("/v1/credit-lines/:id/close-liquidation", async (request, reply) => {
    let line;
    try {
      line = await requireCreditLine(db, request.params.id);
    } catch {
      return reply.code(404).send({ error: "credit line not found" });
    }
    if (!line.contractLineId) {
      return reply.code(409).send({ error: "credit line has not settled on-chain yet" });
    }
    if (line.lenderId !== request.partyId) {
      return reply.code(403).send({ error: "only this line's lender may close it" });
    }
    if (line.status !== "liquidating") {
      return reply.code(409).send({ error: `credit line is ${line.status}, not liquidating` });
    }

    const lenderAccount = await requireStellarAccount(db, line.lenderId);
    const xdr = await contracts.creditLine.closeLiquidated(lenderAccount, BigInt(line.contractLineId));
    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "credit_line.close_liquidated",
      refId: line.id,
      partyId: request.partyId,
    });
    return reply.code(201).send({ xdr, txHash });
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

    if (!isLineParty(line, request.partyId, "borrower")) {
      return reply.code(403).send({ error: "only this line's borrower may pledge to it" });
    }

    const asset = await requireAsset(db, body.assetId);
    const borrowerAccount = await requireStellarAccount(db, line.borrowerId);

    // Custody mode is a property of the asset (set via `PledgeVault.configure_asset`), not a
    // per-call choice, so it's recorded on the `pledge` row for our own bookkeeping but not sent
    // on-chain here.
    const xdr = await contracts.pledgeVault.pledge(
      borrowerAccount,
      BigInt(line.contractLineId),
      asset.contractC,
      body.units,
    );

    const { row, txHash } = await withTransaction(db, async (trx) => {
      const [row] = await trx
        .insert(schema.pledge)
        .values({
          creditLineId: line.id,
          assetId: asset.id,
          units: scaledToDecimalString(body.units),
          custodyMode: body.custodyMode,
          status: "pending",
        })
        .returning();

      const txHash = await recordIntent(trx, chain, {
        xdr,
        kind: "pledge.create",
        refId: row.id,
        partyId: request.partyId,
      });
      return { row, txHash };
    });

    return reply.code(201).send({ xdr, txHash, pledgeId: row.id });
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

      if (!isLineParty(line, request.partyId, "borrower")) {
        return reply.code(403).send({ error: "only this line's borrower may release its collateral" });
      }

      const [pledge] = await db
        .select()
        .from(schema.pledge)
        .where(eq(schema.pledge.id, request.params.pledgeId))
        .limit(1);
      if (!pledge || pledge.creditLineId !== line.id) {
        return reply.code(404).send({ error: "pledge not found on this credit line" });
      }
      if (pledge.status !== "active") {
        return reply.code(409).send({ error: `pledge is ${pledge.status}, not active` });
      }

      // The Postgres ledger knows principal but not accrued interest, so on its own it understates
      // the debt and lets through a release the contract then rejects. Prefer the contract's own
      // figure and fall back to the estimate only when the read fails.
      let onChainDebt: bigint | undefined;
      try {
        onChainDebt = BigInt((await contracts.creditLine.ltv(BigInt(line.contractLineId))).debt);
      } catch (err) {
        request.log.warn(
          { err, creditLineId: line.id },
          "release: on-chain debt read failed, using the Postgres estimate",
        );
      }
      const debtSource = onChainDebt === undefined ? "estimate" : "on-chain";

      const postReleaseLtvBps = await estimateLtvBps(db, line.id, pledge.id, onChainDebt);
      if (postReleaseLtvBps >= MARGIN_THRESHOLDS.marginCallBps) {
        return reply.code(409).send({
          error: "release would breach the healthy LTV threshold",
          projectedLtvBps: postReleaseLtvBps,
          debtSource,
        });
      }

      const asset = await requireAsset(db, pledge.assetId);
      const borrowerAccount = await requireStellarAccount(db, line.borrowerId);

      const xdr = await contracts.pledgeVault.release(
        borrowerAccount,
        BigInt(line.contractLineId),
        asset.contractC,
        decimalStringToScaled(pledge.units),
      );

      const txHash = await withTransaction(db, async (trx) => {
        await trx.update(schema.pledge).set({ status: "pending_release" }).where(eq(schema.pledge.id, pledge.id));
        return recordIntent(trx, chain, {
          xdr,
          kind: "pledge.release",
          refId: pledge.id,
          partyId: request.partyId,
        });
      });

      return { xdr, txHash, pledgeId: pledge.id, projectedLtvBps: postReleaseLtvBps, debtSource };
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
    if (!isLineParty(line, request.partyId, "borrower")) {
      return reply.code(403).send({ error: "only this line's borrower may draw on it" });
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
    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "credit_line.draw",
      refId: line.id,
      partyId: request.partyId,
      payload: { amount: body.amount.toString(), to: body.to },
    });
    return reply.code(201).send({ xdr, txHash });
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
    if (!isLineParty(line, request.partyId, "borrower")) {
      return reply.code(403).send({ error: "only this line's borrower may repay it" });
    }
    const borrowerAccount = await requireStellarAccount(db, line.borrowerId);

    await db.insert(schema.auditLog).values({
      actor: borrowerAccount,
      action: "credit_line.repayment.requested",
      payload: { creditLineId: line.id, amount: body.amount.toString() },
    });

    const xdr = await contracts.creditLine.repay(borrowerAccount, BigInt(line.contractLineId), body.amount);
    const txHash = await recordIntent(db, chain, {
      xdr,
      kind: "credit_line.repay",
      refId: line.id,
      partyId: request.partyId,
      payload: { amount: body.amount.toString() },
    });
    return reply.code(201).send({ xdr, txHash });
  });
}
