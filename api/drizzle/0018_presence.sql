CREATE TYPE "public"."last_seen_visibility" AS ENUM('everyone', 'contacts', 'nobody');--> statement-breakpoint
CREATE TYPE "public"."online_visibility" AS ENUM('everyone', 'same_as_last_seen');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_visibility" "last_seen_visibility" DEFAULT 'contacts' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "online_visibility" "online_visibility" DEFAULT 'same_as_last_seen' NOT NULL;