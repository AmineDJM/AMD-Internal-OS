-- K10b (décision 0038) : la fenêtre d'annulation des effets sortants. Additive et idempotente.
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "fenetreAnnulationSecondes" INTEGER NOT NULL DEFAULT 120;
ALTER TABLE "AssistantEffet" ADD COLUMN IF NOT EXISTS "effetSortantId" TEXT;

CREATE TABLE IF NOT EXISTS "EffetSortantDiffere" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "acte" TEXT NOT NULL,
  "cible" TEXT NOT NULL,
  "apercu" TEXT,
  "charge" JSONB NOT NULL,
  "principalId" TEXT,
  "gesteId" TEXT,
  "objetModele" TEXT,
  "objetId" TEXT,
  "statut" TEXT NOT NULL DEFAULT 'EN_ATTENTE',
  "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "executeLe" TIMESTAMP(3) NOT NULL,
  "parti" TIMESTAMP(3),
  "annuleLe" TIMESTAMP(3),
  "annuleParId" TEXT,
  "compensation" TEXT,
  "compenseLe" TIMESTAMP(3),
  "tentatives" INTEGER NOT NULL DEFAULT 0,
  "erreur" TEXT,
  CONSTRAINT "EffetSortantDiffere_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "EffetSortantDiffere_statut_executeLe_idx" ON "EffetSortantDiffere"("statut", "executeLe");
CREATE INDEX IF NOT EXISTS "EffetSortantDiffere_principalId_creeLe_idx" ON "EffetSortantDiffere"("principalId", "creeLe" DESC);
CREATE INDEX IF NOT EXISTS "EffetSortantDiffere_gesteId_idx" ON "EffetSortantDiffere"("gesteId");
CREATE INDEX IF NOT EXISTS "EffetSortantDiffere_objetModele_objetId_idx" ON "EffetSortantDiffere"("objetModele", "objetId");
