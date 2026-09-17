/**
 * Postgres schema (PRD §7), transcribed table-for-table. Every row that reflects on-chain state
 * carries `tx_hash`/`ledger` so the nightly reconciliation job (see `services/ledger`) can diff
 * these tables against `chain_event` (PRD §8 invariant 9: "books match the chain").
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 32, scale: 7 });

export const assetStandard = pgEnum("asset_standard", ["classic_sac", "sep57"]);
export const yieldTypeEnum = pgEnum("yield_type", ["accumulating", "distributing"]);
export const custodyModeEnum = pgEnum("custody_mode", ["escrow", "issuer_lien", "custodian_lien"]);
export const partyKindEnum = pgEnum("party_kind", [
  "borrower",
  "lender",
  "holder",
  "issuer",
  "custodian",
  "keeper",
]);
export const liquidationRouteEnum = pgEnum("liquidation_route", ["redeem", "transfer", "rfq"]);
export const repoKindEnum = pgEnum("repo_kind", ["intraday", "overnight", "open", "term"]);

// --- Assets and parameters ---

export const asset = pgTable("asset", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  issuerG: text("issuer_g").notNull(),
  /** Issuer registry code (e.g. `"spiko"`, `"etherfuse"`, `"franklin"`) — resolves the exact
   * `IssuerNavAdapter` in `services/price-guard/src/adapters/registry.ts`. Added to replace a
   * substring-match-on-asset-code heuristic that silently fell back to "spiko" on no match; every
   * asset row must now explicitly declare which issuer NAV feed it maps to. No seed/fixture data
   * exists in this repo as of this column's addition, so it's `not null` with no default. */
  issuerCode: text("issuer_code").notNull(),
  contractC: text("contract_c").notNull(),
  standard: assetStandard("standard").notNull(),
  yieldType: yieldTypeEnum("yield_type").notNull(),
  custodyMode: custodyModeEnum("custody_mode").notNull(),
  ccy: text("ccy").notNull(),
  redemptionLagDays: integer("redemption_lag_days").notNull().default(0),
  redemptionDailyCap: money("redemption_daily_cap"),
  navSchedule: text("nav_schedule").notNull(),
  priceBandBps: integer("price_band_bps").notNull(),
  dailyMoveBandBps: integer("daily_move_band_bps").notNull(),
  haircutBaseBps: integer("haircut_base_bps").notNull(),
  haircutFxBps: integer("haircut_fx_bps").notNull().default(0),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assetParamChange = pgTable("asset_param_change", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => asset.id),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  executesAt: timestamp("executes_at", { withTimezone: true }).notNull(),
  txHash: text("tx_hash"),
  executedAt: timestamp("executed_at", { withTimezone: true }),
});

// --- Parties ---

export const party = pgTable("party", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: partyKindEnum("kind").notNull(),
  legalName: text("legal_name").notNull(),
  jurisdiction: text("jurisdiction"),
  kybStatus: text("kyb_status").notNull().default("pending"),
  kybProvider: text("kyb_provider"),
  kybRef: text("kyb_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partyAccount = pgTable(
  "party_account",
  {
    partyId: uuid("party_id")
      .notNull()
      .references(() => party.id),
    stellarAccount: text("stellar_account").notNull(),
    role: text("role").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.partyId, t.stellarAccount] })],
);

// --- Price (defined before credit/margin tables, which reference price_snapshot) ---

export const priceObservation = pgTable("price_observation", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => asset.id),
  source: text("source").notNull(),
  value: money("value").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  signature: text("signature"),
  stale: boolean("stale").notNull().default(false),
});

export const priceSnapshot = pgTable("price_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => asset.id),
  guardedValue: money("guarded_value").notNull(),
  status: text("status").notNull(),
  sources: jsonb("sources").notNull(),
  ledger: integer("ledger").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Credit ---

export const creditLine = pgTable("credit_line", {
  id: uuid("id").primaryKey().defaultRandom(),
  lenderId: uuid("lender_id")
    .notNull()
    .references(() => party.id),
  borrowerId: uuid("borrower_id")
    .notNull()
    .references(() => party.id),
  loanCcy: text("loan_ccy").notNull(),
  limitAmount: money("limit_amount").notNull(),
  rateBps: integer("rate_bps").notNull(),
  feeBps: integer("fee_bps").notNull(),
  cureWindowS: integer("cure_window_s").notNull(),
  status: text("status").notNull().default("open"),
  contractLineId: text("contract_line_id"),
  agreementHash: text("agreement_hash"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const pledge = pgTable("pledge", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditLineId: uuid("credit_line_id")
    .notNull()
    .references(() => creditLine.id),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => asset.id),
  units: money("units").notNull(),
  custodyMode: custodyModeEnum("custody_mode").notNull(),
  contractPositionId: text("contract_position_id"),
  lienRef: text("lien_ref"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const draw = pgTable("draw", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditLineId: uuid("credit_line_id")
    .notNull()
    .references(() => creditLine.id),
  amount: money("amount").notNull(),
  txHash: text("tx_hash").notNull(),
  ledger: integer("ledger").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repayment = pgTable("repayment", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditLineId: uuid("credit_line_id")
    .notNull()
    .references(() => creditLine.id),
  principal: money("principal").notNull(),
  interest: money("interest").notNull(),
  txHash: text("tx_hash").notNull(),
  ledger: integer("ledger").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const marginEvent = pgTable("margin_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditLineId: uuid("credit_line_id")
    .notNull()
    .references(() => creditLine.id),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  ltvBps: integer("ltv_bps").notNull(),
  priceSnapshotId: uuid("price_snapshot_id").references(() => priceSnapshot.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const liquidation = pgTable("liquidation", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditLineId: uuid("credit_line_id")
    .notNull()
    .references(() => creditLine.id),
  route: liquidationRouteEnum("route").notNull(),
  units: money("units").notNull(),
  proceeds: money("proceeds"),
  shortfall: money("shortfall"),
  txHashes: text("tx_hashes").array(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// --- Exit ---

export const exitQuote = pgTable("exit_quote", {
  id: uuid("id").primaryKey().defaultRandom(),
  holderId: uuid("holder_id")
    .notNull()
    .references(() => party.id),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => asset.id),
  units: money("units").notNull(),
  price: money("price").notNull(),
  spreadBps: integer("spread_bps").notNull(),
  usdcOut: money("usdc_out").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("open"),
});

export const exitFill = pgTable("exit_fill", {
  id: uuid("id").primaryKey().defaultRandom(),
  quoteId: uuid("quote_id")
    .notNull()
    .references(() => exitQuote.id),
  txHash: text("tx_hash").notNull(),
  payoutRoute: text("payout_route").notNull(),
  payoutMemo: text("payout_memo"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Repo ---

export const repoTrade = pgTable("repo_trade", {
  id: uuid("id").primaryKey().defaultRandom(),
  cashLenderId: uuid("cash_lender_id")
    .notNull()
    .references(() => party.id),
  cashBorrowerId: uuid("cash_borrower_id")
    .notNull()
    .references(() => party.id),
  assetId: uuid("asset_id")
    .notNull()
    .references(() => asset.id),
  units: money("units").notNull(),
  cashAmount: money("cash_amount").notNull(),
  rateBps: integer("rate_bps").notNull(),
  kind: repoKindEnum("kind").notNull(),
  startLedger: integer("start_ledger").notNull(),
  maturityAt: timestamp("maturity_at", { withTimezone: true }).notNull(),
  agreementHash: text("agreement_hash").notNull(),
  status: text("status").notNull().default("proposed"),
  leg1Tx: text("leg1_tx"),
  leg2Tx: text("leg2_tx"),
});

export const repoMarginCall = pgTable("repo_margin_call", {
  id: uuid("id").primaryKey().defaultRandom(),
  tradeId: uuid("trade_id")
    .notNull()
    .references(() => repoTrade.id),
  amount: money("amount").notNull(),
  ccy: text("ccy").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  curedAt: timestamp("cured_at", { withTimezone: true }),
});

// --- Books and audit ---

export const journalEntry = pgTable("journal_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  refType: text("ref_type").notNull(),
  refId: uuid("ref_id").notNull(),
  account: text("account").notNull(),
  debit: money("debit").notNull().default("0"),
  credit: money("credit").notNull().default("0"),
  ccy: text("ccy").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  payload: jsonb("payload"),
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chainEvent = pgTable("chain_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  ledger: integer("ledger").notNull(),
  txHash: text("tx_hash").notNull(),
  contract: text("contract").notNull(),
  topic: text("topic").notNull(),
  data: jsonb("data"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reconciliationRun = pgTable("reconciliation_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  breaks: integer("breaks").notNull().default(0),
  report: jsonb("report"),
});
