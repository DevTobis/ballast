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
  uniqueIndex,
  index,
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

export const priceObservation = pgTable(
  "price_observation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => asset.id),
    source: text("source").notNull(),
    value: money("value").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    signature: text("signature"),
    stale: boolean("stale").notNull().default(false),
  },
  // A source that has not moved reports the same reading every cycle; one row per reading.
  (t) => [uniqueIndex("price_observation_asset_source_observed_uq").on(t.assetId, t.source, t.observedAt)],
);

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
    .unique()
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
  /** On-chain `RepoDvp` trade id (the u64 `propose` returns), set once the propose tx settles —
   * mirrors `credit_line.contract_line_id`. */
  contractTradeId: text("contract_trade_id"),
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

/**
 * One row per unsigned transaction `services/api` hands out. Ballast never holds customer keys
 * (PRD §9), so every state-changing route returns unsigned XDR and the caller signs it — which
 * means the API can't know on its own whether, or with what result, that transaction landed.
 * A transaction's hash covers its body but not its signatures, so it's known at build time: the
 * API records what the transaction *means* (`kind` + `ref_id` + `payload`) under that hash, and
 * `POST /v1/tx/submit` (or `POST /v1/tx/:hash/settle` for a transaction submitted elsewhere, e.g.
 * with the CLI) looks the intent back up once the network reports a final status and applies it
 * to the books. `CreditLine` emits no contract events, so this — not `chain_event` — is the only
 * way `credit_line.contract_line_id`, `draw` and `repayment` rows ever get written.
 */
export const txIntent = pgTable("tx_intent", {
  txHash: text("tx_hash").primaryKey(),
  kind: text("kind").notNull(),
  refId: uuid("ref_id"),
  partyId: uuid("party_id")
    .notNull()
    .references(() => party.id),
  payload: jsonb("payload"),
  /** `pending` | `settled` | `failed` (closed, rejected on-chain) | `expired` (never submitted). */
  status: text("status").notNull().default("pending"),
  ledger: integer("ledger"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
});

export const chainEvent = pgTable(
  "chain_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The RPC's own unique id for the event; makes re-ingesting a ledger range idempotent. Null on
     * rows ingested before this column existed. */
    eventId: text("event_id"),
    ledger: integer("ledger").notNull(),
    txHash: text("tx_hash").notNull(),
    contract: text("contract").notNull(),
    topic: text("topic").notNull(),
    data: jsonb("data"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chain_event_event_id_uq").on(t.eventId)],
);

/** Scanned-up-to cursor for the event indexer so quiet periods do not re-request already-scanned ledgers. */
export const indexerCursor = pgTable("indexer_cursor", {
  id: text("id").primaryKey(),
  lastLedger: integer("last_ledger").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Compliance ---

/** One sanctions screening of a party (its legal name and every Stellar account it uses). A
 * `match` is a hold: the party is blocked until a person reviews the hit. */
export const complianceCheck = pgTable(
  "compliance_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => party.id),
    kind: text("kind").notNull().default("sanctions"),
    result: text("result").notNull(),
    matches: jsonb("matches"),
    /** Where the list came from and how old it was, so a decision can be reconstructed later. */
    listSource: text("list_source"),
    listLoadedAt: timestamp("list_loaded_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("compliance_check_party_idx").on(t.partyId, t.checkedAt)],
);

// --- Payout hop ---

/** One row per first-leg transaction the payout hop has been asked to forward, claimed before any
 * money moves. The primary key is what makes a replayed or duplicated request unable to pay twice. */
export const payoutForward = pgTable("payout_forward", {
  fromTxHash: text("from_tx_hash").primaryKey(),
  toAccount: text("to_account").notNull(),
  amount: money("amount").notNull(),
  memo: text("memo").notNull(),
  /** `claimed` while in flight, `sent` once the network accepted it and the journal pair is booked,
   * `bookkeeping_pending` if it was accepted but the bookkeeping writes failed (the repair books
   * those), `failed` if the network did not accept it (a failed forward may be retried). */
  status: text("status").notNull().default("claimed"),
  txHash: text("tx_hash"),
  /** The `journal_entry.ref_id` the payout is booked under, fixed at claim time so a repair books
   * under the same id the original attempt would have. */
  refId: uuid("ref_id").notNull().defaultRandom(),
  /** The `exit_quote` this payout fulfils, if any; kept so a repair can write the `exit_fill` row. */
  quoteId: uuid("quote_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Issuer gateway ---

/** One row per `Idempotency-Key` the issuer gateway has seen on a lien-freeze or redeem, so a
 * retried request returns the first result instead of creating a second lien or redemption at the
 * issuer. The key is scoped to (issuer, route): the same key on another issuer or route is unrelated. */
export const issuerIdempotency = pgTable(
  "issuer_idempotency",
  {
    issuerCode: text("issuer_code").notNull(),
    route: text("route").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** sha256 of the request's parameters; a reuse of the key with other parameters is refused. */
    requestHash: text("request_hash").notNull(),
    /** `in_flight` while the issuer call runs, `completed` once `response` holds its result. A
     * failed call deletes the row, so the key can be retried. */
    status: text("status").notNull().default("in_flight"),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.issuerCode, t.route, t.idempotencyKey] })],
);

// --- Institution API keys ---

/** A party's API credential for the signed-request auth path. `keyId` is the public half sent in
 * `x-api-key`; the signing secret is stored encrypted and shown once, at creation. A key acts as
 * `stellarAccount` (the session account that created it). Revoked keys stay for the audit trail. */
export const partyApiKey = pgTable(
  "party_api_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => party.id),
    stellarAccount: text("stellar_account").notNull(),
    keyId: text("key_id").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    label: text("label"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("party_api_key_key_id_uq").on(t.keyId)],
);

/** Nonces seen on signed requests, so a captured request cannot be replayed inside the
 * timestamp window. Rows older than the window are purged. */
export const apiKeyNonce = pgTable(
  "api_key_nonce",
  {
    keyId: text("key_id").notNull(),
    nonce: text("nonce").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.nonce] })],
);

// --- Webhooks (outbox) ---

/** A party's registered webhook endpoint. `secretCiphertext` is the signing secret, encrypted
 * with the API's WEBHOOK_SECRET_KEY; it is shown to the party once, at creation. */
export const webhookSubscription = pgTable("webhook_subscription", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id")
    .notNull()
    .references(() => party.id),
  url: text("url").notNull(),
  events: jsonb("events").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One event for one subscription. `eventKey` identifies the source row (e.g.
 * `margin_event:<id>`), so fanning out the same event twice cannot enqueue it twice. A delivery
 * that exhausts its retries stays as `dead` (the dead-letter queue) rather than being dropped. */
export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => webhookSubscription.id),
    eventKey: text("event_key").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("webhook_delivery_sub_event_uq").on(t.subscriptionId, t.eventKey)],
);

export const reconciliationRun = pgTable("reconciliation_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  breaks: integer("breaks").notNull().default(0),
  report: jsonb("report"),
});
