/**
 * Drives a repo through a margin call, a cure, and a default, with only the services acting once
 * the terms are set. Real prices do not fall on demand, so the call is created by tightening the
 * repo's margin thresholds under the trade's real LTV (as the liquidation drill does for credit
 * lines), and the cure window is shortened so the default can be reached in minutes.
 *
 *  1. lender proposes, borrower accepts: 100 RWA1 for 50 TUSD
 *  2. thresholds are tightened under the real LTV -> services/keeper opens a margin call
 *  3. the borrower adds collateral through the API -> the contract clears the call
 *  4. thresholds are tightened again, under the new LTV -> a second call opens
 *  5. the borrower does nothing; once the cure window ends the keeper defaults the trade: the
 *     lender receives just the units that cover what is owed and the rest goes back to the borrower
 *
 * Run via `scripts/e2e-repo-margin.sh`, which restores the thresholds and the cure window on exit.
 * Needs `KEEPER_REPO_MARGIN_CRON` set to every minute (dev-setup.sh does) or it will be slow.
 */
import { execFileSync } from "node:child_process";
import { UNIT, act, assert, borrower, call, lender, login, required, run, seededAsset, step, units, waitFor, type Built } from "./lib.js";

const CURE_GRACE_S = 90;

function stellar(args: string[]): string {
  return execFileSync("stellar", args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
}

const repoId = () => required("REPO_DVP_CID");
const invoke = (fn: string, extra: string[], send = false): string =>
  stellar([
    "contract", "invoke", "--id", repoId(), "--source", "admin", "--network", required("NETWORK"),
    ...(send ? ["--send=yes"] : []), "--", fn, ...extra,
  ]);

function setThresholds(warningBps: number, marginCallBps: number, liquidationBps: number): void {
  invoke("configure_asset", [
    "--admin", required("ADMIN"), "--asset", required("RWA_SAC"), "--price_guard", required("PRICE_GUARD_CID"),
    "--haircut_bps", "500",
    "--thresholds", JSON.stringify({ warning_bps: warningBps, margin_call_bps: marginCallBps, liquidation_bps: liquidationBps }),
    "--max_cash_per_trade", "1000000000000",
    "--max_term_seconds", "2592000",
  ]);
}

interface ChainTrade { status: string; pending_margin_call: boolean; units: string }
const chainTrade = (id: string): ChainTrade => JSON.parse(invoke("trade", ["--id", id]));
const chainLtv = (id: string): number => JSON.parse(invoke("margin_view", ["--id", id])).ltv_bps;
const rwaBalance = (account: string): bigint =>
  BigInt(
    JSON.parse(
      stellar(["contract", "invoke", "--id", required("RWA_SAC"), "--source", "admin", "--network", required("NETWORK"), "--", "balance", "--id", account]),
    ),
  );

async function main() {
  const lenderSession = await login(lender);
  const borrowerSession = await login(borrower);
  const asset = await waitFor("an Ok price", seededAsset, (a) => a.price?.status === "Ok");

  step(`Admin sets a ${CURE_GRACE_S}s cure window for new margin calls`);
  invoke("set_cure_grace", ["--admin", required("ADMIN"), "--seconds", String(CURE_GRACE_S)], true);

  step("Lender proposes a repo (50 TUSD against 100 RWA1, maturing in an hour); borrower accepts");
  const proposed = await act<Built & { tradeId: string }>(lenderSession, lender, "POST", "/v1/repo/proposals", {
    cashLenderId: lenderSession.partyId,
    cashBorrowerId: borrowerSession.partyId,
    assetId: asset.id,
    units: units(100),
    cashAmount: units(50),
    rateBps: 500,
    kind: "term",
    maturityAt: new Date(Date.now() + 3_600_000).toISOString(),
    agreementHash: "00".repeat(32),
  });
  const positions = () =>
    call<{ repoTrades: Array<{ id: string; status: string; contractTradeId: string | null; units: string }> }>(
      "GET", `/v1/positions?party=${borrowerSession.partyId}`, borrowerSession.token,
    );
  const row = async () => (await positions()).repoTrades.find((t) => t.id === proposed.tradeId)!;
  const onChainId = (await row()).contractTradeId;
  assert(onChainId, "the proposal settled on-chain");
  await act(borrowerSession, borrower, "POST", `/v1/repo/proposals/${proposed.tradeId}/accept`);
  assert((await row()).status === "settled", "the trade is settled");

  // --- A margin call, then a cure by topping up -------------------------------------------
  const ltv = chainLtv(onChainId);
  step(`The trade's real LTV is ${ltv} bps; tightening the repo thresholds under it`);
  assert(ltv > 1500, `the trade has a meaningful LTV to breach (got ${ltv})`);
  setThresholds(ltv - 1200, ltv - 700, ltv - 200);

  step("Waiting for services/keeper to open a margin call");
  await waitFor("a margin call", async () => chainTrade(onChainId), (t) => t.pending_margin_call, 6 * 60_000);

  // To land back under the margin-call threshold the collateral has to grow by ltv / (ltv - 700);
  // add half as much again so the cure is not marginal.
  const needed = (100n * BigInt(ltv)) / BigInt(ltv - 700) - 100n;
  const topUp = (needed * 3n) / 2n + 1n;
  step(`Borrower adds ${topUp} RWA1 through the API to cure it`);
  await act(borrowerSession, borrower, "POST", `/v1/repo/trades/${proposed.tradeId}/top-ups`, { units: units(topUp) });
  const cured = chainTrade(onChainId);
  assert(!cured.pending_margin_call, "the contract cleared the margin call in the same transaction");
  assert(BigInt(cured.units) === (100n + topUp) * UNIT, `the trade holds ${100n + topUp} units (got ${cured.units})`);
  await waitFor("the books to show the new collateral", row, (t) => BigInt(Math.round(Number(t.units))) === 100n + topUp);

  // --- A second call, left uncured -> default ----------------------------------------------
  const ltv2 = chainLtv(onChainId);
  step(`After the top-up the LTV is ${ltv2} bps; tightening under it again and leaving the call uncured`);
  setThresholds(ltv2 - 1200, ltv2 - 500, ltv2 - 100);
  const lenderBefore = rwaBalance(lender.publicKey());
  const borrowerBefore = rwaBalance(borrower.publicKey());

  await waitFor("a second margin call", async () => chainTrade(onChainId), (t) => t.pending_margin_call, 6 * 60_000);
  step(`Waiting out the ${CURE_GRACE_S}s cure window for services/keeper to default the trade`);
  await waitFor("the trade to default", async () => chainTrade(onChainId), (t) => t.status === "Defaulted", 10 * 60_000);
  await waitFor("the books to show the default", row, (t) => t.status === "defaulted");

  const lenderGot = rwaBalance(lender.publicKey()) - lenderBefore;
  const borrowerGot = rwaBalance(borrower.publicKey()) - borrowerBefore;
  const total = (100n + topUp) * UNIT;
  assert(lenderGot + borrowerGot === total, `every pledged unit went to one party (${lenderGot} + ${borrowerGot} vs ${total})`);
  assert(lenderGot > 0n && lenderGot < total, `the lender got only what covers the debt, not everything (got ${lenderGot} of ${total})`);
  assert(borrowerGot > 0n, "the excess collateral went back to the borrower");
  step(`  lender received ${lenderGot} stroops of RWA1 and the borrower got ${borrowerGot} back`);

  console.log(">>> Repo margin E2E passed.");
}

run(main);
