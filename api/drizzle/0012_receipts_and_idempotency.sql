CREATE TABLE "message_receipts" (
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	CONSTRAINT "message_receipts_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_receipts_user_idx" ON "message_receipts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_client_idx" ON "messages" USING btree ("sender_id","client_id");