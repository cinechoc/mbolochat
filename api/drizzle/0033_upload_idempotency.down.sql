-- Retour arrière manuel, jamais exécuté automatiquement.
-- Les clients qui rejouent une requête après un timeout cesseront simplement
-- d'être dédupliqués ; aucun message ni média déjà envoyé n'est affecté.
DROP TABLE IF EXISTS "upload_idempotency";
