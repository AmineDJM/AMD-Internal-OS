-- Pré-validation des bons de commande depuis « Demandes de validations » (Direction, 10/2026).
-- Tant que `bcPrevalidationAt` est posé, l'aiguillage n'adresse le BC à aucun centre ; la validation finale le libère.
ALTER TABLE "LegalDocument" ADD COLUMN IF NOT EXISTS "bcPrevalidationAt" TIMESTAMP(3);
ALTER TABLE "LegalDocument" ADD COLUMN IF NOT EXISTS "bcPrevalidationRequestId" TEXT;
CREATE INDEX IF NOT EXISTS "LegalDocument_bcPrevalidationRequestId_idx" ON "LegalDocument"("bcPrevalidationRequestId");
