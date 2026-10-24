-- Retour arrière manuel de 0018_presence.sql.
-- Drizzle ne génère que le sens aller ; exécuter ce fichier avec psql sur la
-- base concernée si un rollback est nécessaire.
ALTER TABLE "users" DROP COLUMN IF EXISTS "online_visibility";
ALTER TABLE "users" DROP COLUMN IF EXISTS "last_seen_visibility";
ALTER TABLE "users" DROP COLUMN IF EXISTS "last_seen_at";
DROP TYPE IF EXISTS "public"."online_visibility";
DROP TYPE IF EXISTS "public"."last_seen_visibility";
