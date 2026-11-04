-- C1 (décision 0068) : une carte à valider appartient à SA conversation et à SA réponse, et porte ce que l'écran affiche.
-- La table des intentions devient la SEULE source de l'écran : toutes les cartes d'un tour (pas seulement la première),
-- relues à chaque ouverture, quel que soit le chemin (texte, voix, app). Additive et idempotente.
ALTER TABLE "AssistantActionIntent" ADD COLUMN IF NOT EXISTS "filId" TEXT;
ALTER TABLE "AssistantActionIntent" ADD COLUMN IF NOT EXISTS "tourId" TEXT;
ALTER TABLE "AssistantActionIntent" ADD COLUMN IF NOT EXISTS "carte" JSONB;
CREATE INDEX IF NOT EXISTS "AssistantActionIntent_filId_status_idx" ON "AssistantActionIntent"("filId", "status");
