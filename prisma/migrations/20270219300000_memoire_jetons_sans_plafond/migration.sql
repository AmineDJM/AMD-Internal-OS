-- M1, décisions de la Direction (01/11/2026) — additive et idempotente.
-- 1. Pas de plafond quotidien par personne : 0 = sans. Une ligne restée au défaut d'avant (600 000) passe à « sans ».
ALTER TABLE "AssistantIaReglage" ALTER COLUMN "plafondJetonsJour" SET DEFAULT 0;
UPDATE "AssistantIaReglage" SET "plafondJetonsJour" = 0 WHERE "plafondJetonsJour" = 600000;
-- 2. La mémoire gérée en JETONS : budget de stockage par personne, consolidation rare et réversible.
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "memoireJetonsBudget" INTEGER NOT NULL DEFAULT 8000;
ALTER TABLE "AssistantIaPreference" ADD COLUMN IF NOT EXISTS "memoireConsolideeLe" TIMESTAMP(3);
ALTER TABLE "AssistantMemoryItem" ADD COLUMN IF NOT EXISTS "consolideDans" TEXT;
CREATE INDEX IF NOT EXISTS "AssistantMemoryItem_userId_consolideDans_idx" ON "AssistantMemoryItem"("userId", "consolideDans");
CREATE INDEX IF NOT EXISTS "AssistantMemoryItem_active_remplaceLe_idx" ON "AssistantMemoryItem"("active", "remplaceLe");
