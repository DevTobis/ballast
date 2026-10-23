CREATE TABLE IF NOT EXISTS "indexer_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"last_ledger" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
