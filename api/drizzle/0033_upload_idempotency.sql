CREATE TABLE "upload_idempotency" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"conversation_id" text NOT NULL,
	"content_sha256" text NOT NULL,
	"size" integer NOT NULL,
	"stored_url" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"upload_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_idempotency_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "upload_idempotency" ADD CONSTRAINT "upload_idempotency_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upload_idempotency" ADD CONSTRAINT "upload_idempotency_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "upload_idempotency_upload_idx" ON "upload_idempotency" USING btree ("upload_id");
--> statement-breakpoint
CREATE INDEX "upload_idempotency_state_idx" ON "upload_idempotency" USING btree ("state","updated_at");
