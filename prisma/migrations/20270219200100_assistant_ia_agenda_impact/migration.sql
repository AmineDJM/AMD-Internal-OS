-- O1, retour de la Direction (décision 0046 §2-3) : l'IMPACT d'une précision — MAJEUR (réinjectée dans le travail) ou
-- MINEUR (appliquée au rendu, sans relance) — sa forme, sa date d'application, et le rang de l'élément dans l'agenda
-- (l'ordre ne dépend plus de la date de création). Additive et idempotente.
ALTER TABLE "AssistantIaAgenda" ADD COLUMN IF NOT EXISTS "impact" TEXT;
ALTER TABLE "AssistantIaAgenda" ADD COLUMN IF NOT EXISTS "forme" TEXT;
ALTER TABLE "AssistantIaAgenda" ADD COLUMN IF NOT EXISTS "appliqueLe" TIMESTAMP(3);
ALTER TABLE "AssistantIaAgenda" ADD COLUMN IF NOT EXISTS "rang" INTEGER NOT NULL DEFAULT 0;
