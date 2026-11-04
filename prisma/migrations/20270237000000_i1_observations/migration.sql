-- I1 (décision 0063) : les observations d'un tour de l'Assistant IA (contrat Observation), relues au tour suivant.
-- Additive et idempotente.
ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "observations" JSONB;
