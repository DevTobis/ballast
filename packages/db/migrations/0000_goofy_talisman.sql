CREATE TYPE "public"."asset_standard" AS ENUM('classic_sac', 'sep57');--> statement-breakpoint
CREATE TYPE "public"."custody_mode" AS ENUM('escrow', 'issuer_lien', 'custodian_lien');--> statement-breakpoint
CREATE TYPE "public"."liquidation_route" AS ENUM('redeem', 'transfer', 'rfq');--> statement-breakpoint
CREATE TYPE "public"."party_kind" AS ENUM('borrower', 'lender', 'holder', 'issuer', 'custodian', 'keeper');--> statement-breakpoint
CREATE TYPE "public"."repo_kind" AS ENUM('intraday', 'overnight', 'open', 'term');--> statement-breakpoint
CREATE TYPE "public"."yield_type" AS ENUM('accumulating', 'distributing');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"issuer_g" text NOT NULL,
	"contract_c" text NOT NULL,
	"standard" "asset_standard" NOT NULL,
	"yield_type" "yield_type" NOT NULL,
	"custody_mode" "custody_mode" NOT NULL,
	"ccy" text NOT NULL,
	"redemption_lag_days" integer DEFAULT 0 NOT NULL,
	"redemption_daily_cap" numeric(32, 7),
	"nav_schedule" text NOT NULL,
	"price_band_bps" integer NOT NULL,
	"daily_move_band_bps" integer NOT NULL,
	"haircut_base_bps" integer NOT NULL,
	"haircut_fx_bps" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_param_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executes_at" timestamp with time zone NOT NULL,
	"tx_hash" text,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chain_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"contract" text NOT NULL,
	"topic" text NOT NULL,
	"data" jsonb,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lender_id" uuid NOT NULL,
	"borrower_id" uuid NOT NULL,
	"loan_ccy" text NOT NULL,
	"limit_amount" numeric(32, 7) NOT NULL,
	"rate_bps" integer NOT NULL,
	"fee_bps" integer NOT NULL,
	"cure_window_s" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"contract_line_id" text,
	"agreement_hash" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "draw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_line_id" uuid NOT NULL,
	"amount" numeric(32, 7) NOT NULL,
	"tx_hash" text NOT NULL,
	"ledger" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exit_fill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"tx_hash" text NOT NULL,
	"payout_route" text NOT NULL,
	"payout_memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exit_quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holder_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"units" numeric(32, 7) NOT NULL,
	"price" numeric(32, 7) NOT NULL,
	"spread_bps" integer NOT NULL,
	"usdc_out" numeric(32, 7) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"account" text NOT NULL,
	"debit" numeric(32, 7) DEFAULT '0' NOT NULL,
	"credit" numeric(32, 7) DEFAULT '0' NOT NULL,
	"ccy" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "liquidation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_line_id" uuid NOT NULL,
	"route" "liquidation_route" NOT NULL,
	"units" numeric(32, 7) NOT NULL,
	"proceeds" numeric(32, 7),
	"shortfall" numeric(32, 7),
	"tx_hashes" text[],
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "margin_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_line_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"ltv_bps" integer NOT NULL,
	"price_snapshot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "party_kind" NOT NULL,
	"legal_name" text NOT NULL,
	"jurisdiction" text,
	"kyb_status" text DEFAULT 'pending' NOT NULL,
	"kyb_provider" text,
	"kyb_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "party_account" (
	"party_id" uuid NOT NULL,
	"stellar_account" text NOT NULL,
	"role" text NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "party_account_party_id_stellar_account_pk" PRIMARY KEY("party_id","stellar_account")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pledge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_line_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"units" numeric(32, 7) NOT NULL,
	"custody_mode" "custody_mode" NOT NULL,
	"contract_position_id" text,
	"lien_ref" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_observation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"source" text NOT NULL,
	"value" numeric(32, 7) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"signature" text,
	"stale" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"guarded_value" numeric(32, 7) NOT NULL,
	"status" text NOT NULL,
	"sources" jsonb NOT NULL,
	"ledger" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"breaks" integer DEFAULT 0 NOT NULL,
	"report" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repayment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_line_id" uuid NOT NULL,
	"principal" numeric(32, 7) NOT NULL,
	"interest" numeric(32, 7) NOT NULL,
	"tx_hash" text NOT NULL,
	"ledger" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_margin_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_id" uuid NOT NULL,
	"amount" numeric(32, 7) NOT NULL,
	"ccy" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"cured_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_trade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cash_lender_id" uuid NOT NULL,
	"cash_borrower_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"units" numeric(32, 7) NOT NULL,
	"cash_amount" numeric(32, 7) NOT NULL,
	"rate_bps" integer NOT NULL,
	"kind" "repo_kind" NOT NULL,
	"start_ledger" integer NOT NULL,
	"maturity_at" timestamp with time zone NOT NULL,
	"agreement_hash" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"leg1_tx" text,
	"leg2_tx" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "asset_param_change" ADD CONSTRAINT "asset_param_change_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_line" ADD CONSTRAINT "credit_line_lender_id_party_id_fk" FOREIGN KEY ("lender_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_line" ADD CONSTRAINT "credit_line_borrower_id_party_id_fk" FOREIGN KEY ("borrower_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "draw" ADD CONSTRAINT "draw_credit_line_id_credit_line_id_fk" FOREIGN KEY ("credit_line_id") REFERENCES "public"."credit_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exit_fill" ADD CONSTRAINT "exit_fill_quote_id_exit_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."exit_quote"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exit_quote" ADD CONSTRAINT "exit_quote_holder_id_party_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exit_quote" ADD CONSTRAINT "exit_quote_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_credit_line_id_credit_line_id_fk" FOREIGN KEY ("credit_line_id") REFERENCES "public"."credit_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "margin_event" ADD CONSTRAINT "margin_event_credit_line_id_credit_line_id_fk" FOREIGN KEY ("credit_line_id") REFERENCES "public"."credit_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "margin_event" ADD CONSTRAINT "margin_event_price_snapshot_id_price_snapshot_id_fk" FOREIGN KEY ("price_snapshot_id") REFERENCES "public"."price_snapshot"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "party_account" ADD CONSTRAINT "party_account_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pledge" ADD CONSTRAINT "pledge_credit_line_id_credit_line_id_fk" FOREIGN KEY ("credit_line_id") REFERENCES "public"."credit_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pledge" ADD CONSTRAINT "pledge_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_snapshot" ADD CONSTRAINT "price_snapshot_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repayment" ADD CONSTRAINT "repayment_credit_line_id_credit_line_id_fk" FOREIGN KEY ("credit_line_id") REFERENCES "public"."credit_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repo_margin_call" ADD CONSTRAINT "repo_margin_call_trade_id_repo_trade_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."repo_trade"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repo_trade" ADD CONSTRAINT "repo_trade_cash_lender_id_party_id_fk" FOREIGN KEY ("cash_lender_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repo_trade" ADD CONSTRAINT "repo_trade_cash_borrower_id_party_id_fk" FOREIGN KEY ("cash_borrower_id") REFERENCES "public"."party"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repo_trade" ADD CONSTRAINT "repo_trade_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
