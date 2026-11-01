-- M1 (décision 0045) : une vraie mémoire pour Adventum IA — capture automatique réversible, historique des faits
-- remplacés, origine (conversation, message), plongement pour le rappel par pertinence, réglage par personne.
-- Additive et idempotente.
ALTER TABLE "AssistantMemoryItem" ADD COLUMN IF NOT EXISTS "origine" TEXT NOT NULL DEFAULT 'manuel';
ALTER TABLE "AssistantMemoryItem" ADD COLUMN IF NOT EXISTS "sujet" TEXT;
ALTER TABLE "AssistantMemoryItem" ADD COLUMN IF NOT EXISTS "remplaceId" TEXT;
ALTER TABLE "AssistantMemoryItem" ADD COLUMN IF NOT EXISTS "remplaceLe" TIMESTAMP(3);
ALTER TABLE "AssistantMemoryItem" ADD COLUMN IF NOT EXISTS "sourceTourId" TEXT;
ALTER TABLE "AssistantMemoryItem" ADD COLUMN IF NOT EXISTS "vecteur" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[];
CREATE INDEX IF NOT EXISTS "AssistantMemoryItem_userId_sujet_idx" ON "AssistantMemoryItem"("userId", "sujet");

ALTER TABLE "AssistantIaPreference" ADD COLUMN IF NOT EXISTS "memoireAuto" BOOLEAN;

ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "memoiresRetenues" JSONB;
ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "memoireEtat" TEXT;
