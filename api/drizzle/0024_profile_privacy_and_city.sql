CREATE TYPE "public"."privacy_visibility" AS ENUM('everyone', 'contacts', 'nobody');--> statement-breakpoint
CREATE TABLE "geo_city_cache" (
	"cell" text PRIMARY KEY NOT NULL,
	"city" text NOT NULL,
	"country" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "last_used_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_visibility" "privacy_visibility" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "write_permission" "privacy_visibility" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "group_add_permission" "privacy_visibility" DEFAULT 'contacts' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "call_permission" "privacy_visibility" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discoverability" "privacy_visibility" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "read_receipts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "typing_indicator" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_messages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_groups" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_mentions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_calls" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_reactions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quiet_hours_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quiet_start_minute" integer DEFAULT 1320 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quiet_end_minute" integer DEFAULT 420 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quiet_utc_offset_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;