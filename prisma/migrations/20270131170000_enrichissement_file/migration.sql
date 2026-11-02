-- Migration : 20270131170000_enrichissement_file
-- Refonte des données, vague 2, lot V2-A « Dépôt → enrichissement » (`docs/architecture/refonte-vague-2.md`).
-- LA FILE PERSISTANTE DE L'ENRICHISSEMENT (outbox) : une ligne par (empreinte, rattachement), posée au dépôt,
-- consommée par `traiterLaFile` (battement `runScheduledJobs`, puis le worker V2-F). Et L'INTERRUPTEUR
-- `AppSetting.enrichissementActif`, FAUX par défaut : rien n'est émis, rien n'est traité tant que le Super Admin
-- ne l'a pas ouvert.
-- ADDITIVE : une table neuve, une colonne neuve à défaut sûr. Rien n'est supprimé, rien n'est réécrit.
-- Idempotente : rejouable sans effet (`IF NOT EXISTS`, `duplicate_object`).

ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "enrichissementActif" BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  CREATE TYPE "StatutTacheEnrichissement" AS ENUM ('A_FAIRE', 'EN_COURS', 'FAITE', 'ECHEC', 'IGNOREE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "TacheEnrichissement" (
    "id" TEXT NOT NULL,
    "cle" TEXT NOT NULL,
    "empreinte" TEXT,
    "blobId" TEXT NOT NULL,
    "nomFichier" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "taille" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "confidentiality" "Confidentiality" NOT NULL DEFAULT 'INTERNAL',
    "rattachementType" TEXT NOT NULL,
    "rattachementId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "deposeParId" TEXT,
    "deposeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statut" "StatutTacheEnrichissement" NOT NULL DEFAULT 'A_FAIRE',
    "tentatives" INTEGER NOT NULL DEFAULT 0,
    "prochainEssaiLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verrouilleLe" TIMESTAMP(3),
    "derniereErreur" TEXT,
    "pieceId" TEXT,
    "bilan" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TacheEnrichissement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TacheEnrichissement_cle_key" ON "TacheEnrichissement"("cle");
CREATE INDEX IF NOT EXISTS "TacheEnrichissement_statut_prochainEssaiLe_idx" ON "TacheEnrichissement"("statut", "prochainEssaiLe");
CREATE INDEX IF NOT EXISTS "TacheEnrichissement_empreinte_idx" ON "TacheEnrichissement"("empreinte");
CREATE INDEX IF NOT EXISTS "TacheEnrichissement_pieceId_idx" ON "TacheEnrichissement"("pieceId");
