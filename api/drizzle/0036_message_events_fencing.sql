-- Fencing des workers du journal des effets secondaires.
-- Chaque prise de bail pose un jeton unique ; les mutations de fin de
-- traitement le vérifient. Un worker dont le bail a expiré ne peut donc plus
-- clore à la place du nouveau propriétaire.
ALTER TABLE "message_events" ADD COLUMN IF NOT EXISTS "claim_token" text;
