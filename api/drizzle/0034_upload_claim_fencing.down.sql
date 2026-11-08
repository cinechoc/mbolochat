-- Retour arrière manuel, jamais exécuté automatiquement.
ALTER TABLE "upload_idempotency" DROP COLUMN IF EXISTS "attempt_token";
