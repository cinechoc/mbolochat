-- Journal durable des effets secondaires d'un message (socket + push).
-- Écrit dans la même transaction que le message : aucune perte entre
-- l'écriture et la diffusion, aucun doublon si la requête est répétée.
CREATE TABLE IF NOT EXISTS "message_events" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_events_dedupe_idx" ON "message_events" ("message_id","kind","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_events_pending_idx" ON "message_events" ("status","next_attempt_at");
