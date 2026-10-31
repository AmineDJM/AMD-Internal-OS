-- K3 (décision 0033) : sous-missions en arrière-plan, synthèse dans la conversation, démarrage d'office des plans sans geste.
ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "travaux" JSONB;
ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "syntheseDe" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantIaTour_syntheseDe_key" ON "AssistantIaTour"("syntheseDe");
ALTER TABLE "AssistantIaAcces" ADD COLUMN IF NOT EXISTS "travauxDOffice" BOOLEAN;
CREATE TABLE IF NOT EXISTS "AssistantIaPreference" (
  "userId" TEXT NOT NULL,
  "travauxDOffice" BOOLEAN,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaPreference_pkey" PRIMARY KEY ("userId")
);
