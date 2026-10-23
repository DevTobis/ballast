ALTER TABLE "payout_forward" ADD COLUMN "ref_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_forward" ADD COLUMN "quote_id" uuid;