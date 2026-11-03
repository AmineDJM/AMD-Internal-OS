-- O2 (décision 0059) : la FILE D'INTÉGRATION des programmes — une entrée par (chantier, SHA), une seule ACTIVE par
-- (dépôt, cible) : l'index unique partiel est la garantie, quel que soit le nombre de processus. Additive, idempotente.
CREATE TABLE IF NOT EXISTS "IntegrationFile" (
  "id" TEXT NOT NULL,
  "programmeId" TEXT NOT NULL,
  "chantierId" TEXT NOT NULL,
  "tacheCle" TEXT NOT NULL,
  "depot" TEXT NOT NULL,
  "cible" TEXT NOT NULL,
  "branche" TEXT NOT NULL,
  "shaTache" TEXT NOT NULL,
  "statut" TEXT NOT NULL DEFAULT 'EN_FILE',
  "brancheIntegration" TEXT,
  "shaBase" TEXT,
  "shaIntegration" TEXT,
  "tour" INTEGER NOT NULL DEFAULT 0,
  "essais" INTEGER NOT NULL DEFAULT 0,
  "detail" JSONB,
  "bailJusqua" TIMESTAMP(3),
  "bailPar" TEXT,
  "reessayerA" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationFile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationFile_chantierId_shaTache_key" ON "IntegrationFile"("chantierId", "shaTache");
CREATE INDEX IF NOT EXISTS "IntegrationFile_depot_cible_statut_createdAt_idx" ON "IntegrationFile"("depot", "cible", "statut", "createdAt");
CREATE INDEX IF NOT EXISTS "IntegrationFile_programmeId_idx" ON "IntegrationFile"("programmeId");
-- JAMAIS DEUX INTÉGRATIONS CONCURRENTES SUR UNE MÊME CIBLE : la base refuse la seconde entrée active.
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationFile_une_active_par_cible" ON "IntegrationFile"("depot", "cible") WHERE "statut" IN ('EN_COURS', 'CI', 'A_VALIDER');
DO $$ BEGIN
  ALTER TABLE "IntegrationFile" ADD CONSTRAINT "IntegrationFile_programmeId_fkey"
    FOREIGN KEY ("programmeId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
