ALTER TABLE "messages" ADD COLUMN "type" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sticker_ref" text;