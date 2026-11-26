CREATE TABLE IF NOT EXISTS "chain_event_gap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_ledger" integer NOT NULL,
	"to_ledger" integer NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chain_event_gap_range_uq" ON "chain_event_gap" USING btree ("from_ledger","to_ledger");