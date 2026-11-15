-- DONNÉES MARCHÉ IMPORTÉES (11/2026) : nomenclature nationale et audit IQVIA déposés comme fichiers.
-- Additive et idempotente.
CREATE TABLE IF NOT EXISTS "MarcheImport" (
  "id" TEXT NOT NULL,
  "nature" TEXT NOT NULL,
  "nomFichier" TEXT NOT NULL,
  "empreinte" TEXT NOT NULL,
  "taille" INTEGER NOT NULL,
  "fichier" BYTEA NOT NULL,
  "periode" TEXT,
  "lignes" INTEGER NOT NULL DEFAULT 0,
  "rapport" JSONB,
  "auteurId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarcheImport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MarcheImport_empreinte_key" ON "MarcheImport"("empreinte");
CREATE INDEX IF NOT EXISTS "MarcheImport_nature_createdAt_idx" ON "MarcheImport"("nature", "createdAt");

CREATE TABLE IF NOT EXISTS "NomenclatureLigne" (
  "id" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "onglet" TEXT NOT NULL,
  "numero" INTEGER,
  "numEnregistrement" TEXT NOT NULL,
  "code" TEXT,
  "dci" TEXT NOT NULL,
  "marque" TEXT,
  "forme" TEXT,
  "dosage" TEXT,
  "conditionnement" TEXT,
  "liste" TEXT,
  "p1" TEXT,
  "p2" TEXT,
  "obs" TEXT,
  "laboratoire" TEXT,
  "paysLaboratoire" TEXT,
  "dateInitiale" DATE,
  "dateFinale" DATE,
  "type" TEXT,
  "statut" TEXT,
  "stabilite" TEXT,
  "dateRetrait" DATE,
  "motifRetrait" TEXT,
  CONSTRAINT "NomenclatureLigne_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "NomenclatureLigne_importId_onglet_idx" ON "NomenclatureLigne"("importId", "onglet");
CREATE INDEX IF NOT EXISTS "NomenclatureLigne_code_idx" ON "NomenclatureLigne"("code");
DO $$ BEGIN
  ALTER TABLE "NomenclatureLigne" ADD CONSTRAINT "NomenclatureLigne_importId_fkey" FOREIGN KEY ("importId") REFERENCES "MarcheImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "IqviaLigne" (
  "id" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "atc4" TEXT NOT NULL,
  "produit" TEXT NOT NULL,
  "presentation" TEXT NOT NULL,
  "molecules" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "laboratoire" TEXT NOT NULL,
  "matUnites" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "matValeur" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "matCroissance" DOUBLE PRECISION,
  "ytdUnites" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "ytdValeur" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "moisUnites" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "moisValeur" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "IqviaLigne_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "IqviaLigne_importId_idx" ON "IqviaLigne"("importId");
DO $$ BEGIN
  ALTER TABLE "IqviaLigne" ADD CONSTRAINT "IqviaLigne_importId_fkey" FOREIGN KEY ("importId") REFERENCES "MarcheImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
