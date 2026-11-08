-- Jeton de fencing des réservations d'idempotence d'upload : une tentative qui
-- a perdu sa propriété ne doit plus pouvoir valider ni nettoyer.
ALTER TABLE "upload_idempotency" ADD COLUMN "attempt_token" text;
--> statement-breakpoint
UPDATE "upload_idempotency" SET "attempt_token" = gen_random_uuid()::text WHERE "attempt_token" IS NULL;
--> statement-breakpoint
ALTER TABLE "upload_idempotency" ALTER COLUMN "attempt_token" SET NOT NULL;
