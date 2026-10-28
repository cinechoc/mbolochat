ALTER TABLE "users" ADD COLUMN "notification_sound" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_preview" boolean DEFAULT true NOT NULL;