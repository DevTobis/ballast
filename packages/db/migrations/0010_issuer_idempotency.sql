CREATE TABLE IF NOT EXISTS "issuer_idempotency" (
	"issuer_code" text NOT NULL,
	"route" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'in_flight' NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "issuer_idempotency_issuer_code_route_idempotency_key_pk" PRIMARY KEY("issuer_code","route","idempotency_key")
);
