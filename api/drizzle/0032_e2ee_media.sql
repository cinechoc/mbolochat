ALTER TABLE "uploads" ADD COLUMN "encrypted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "encrypted_attachment" jsonb;
--> statement-breakpoint
CREATE TABLE "upload_conversations" (
	"upload_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_conversations" ADD CONSTRAINT "upload_conversations_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upload_conversations" ADD CONSTRAINT "upload_conversations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "upload_conversations_conversation_idx" ON "upload_conversations" USING btree ("conversation_id");
