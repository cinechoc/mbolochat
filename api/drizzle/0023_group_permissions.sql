ALTER TABLE "conversations" ADD COLUMN "send_permission" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "add_permission" text DEFAULT 'all' NOT NULL;