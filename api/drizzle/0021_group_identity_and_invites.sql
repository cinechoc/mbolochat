CREATE TYPE "public"."join_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "conversation_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"created_by_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "conversation_join_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"invite_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" "join_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" text
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "emoji" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_invites" ADD CONSTRAINT "conversation_invites_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_invites" ADD CONSTRAINT "conversation_invites_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_join_requests" ADD CONSTRAINT "conversation_join_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_join_requests" ADD CONSTRAINT "conversation_join_requests_invite_id_conversation_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."conversation_invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_join_requests" ADD CONSTRAINT "conversation_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_join_requests" ADD CONSTRAINT "conversation_join_requests_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_invites_conversation_idx" ON "conversation_invites" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_join_requests_invite_user_idx" ON "conversation_join_requests" USING btree ("invite_id","user_id");--> statement-breakpoint
CREATE INDEX "conversation_join_requests_conversation_status_idx" ON "conversation_join_requests" USING btree ("conversation_id","status");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "conversations" SET "updated_at" = "created_at";--> statement-breakpoint
UPDATE "conversations" AS c
SET "owner_id" = (
  SELECT cm."user_id"
  FROM "conversation_members" AS cm
  WHERE cm."conversation_id" = c."id"
  ORDER BY (cm."role" = 'admin') DESC, cm."joined_at" ASC
  LIMIT 1
)
WHERE c."type" = 'GROUP' AND c."owner_id" IS NULL;