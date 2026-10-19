ALTER TABLE "conversation_members" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "muted_at" timestamp with time zone;