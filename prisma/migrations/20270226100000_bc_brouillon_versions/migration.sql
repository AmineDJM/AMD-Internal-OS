-- Migration : 20270226100000_bc_brouillon_versions
-- L'historique du brouillon du BC d'un devis de poste Ad & Pro : une ligne par geste (créé, modifié, retiré, validé),
-- avec ce qui a changé avant → après. Le Super Admin le lit ; on ajoute, on n'efface jamais.
-- Idempotente : rejouable sans effet.

CREATE TABLE IF NOT EXISTS "BcBrouillonVersion" (
  "id" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "devisLegalDocumentId" TEXT NOT NULL,
  "bcLegalDocumentId" TEXT,
  "numero" INTEGER NOT NULL,
  "geste" TEXT NOT NULL,
  "auteurId" TEXT,
  "auteurNom" TEXT,
  "changements" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BcBrouillonVersion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BcBrouillonVersion_itemId_idx" ON "BcBrouillonVersion"("itemId");
CREATE INDEX IF NOT EXISTS "BcBrouillonVersion_devisLegalDocumentId_idx" ON "BcBrouillonVersion"("devisLegalDocumentId");
CREATE INDEX IF NOT EXISTS "BcBrouillonVersion_bcLegalDocumentId_idx" ON "BcBrouillonVersion"("bcLegalDocumentId");
