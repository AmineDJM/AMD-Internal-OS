-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J10 (décision 0028) — LES RECETTES : la mémoire procédurale de la maison.
--
-- Une recette est tirée des circuits réels (dossiers clos et acceptés, au-delà d'un seuil d'occurrences) et validée par le
-- responsable du processus que la Direction désigne. Quatre tables neuves, rien de modifié ailleurs :
--   RecetteResponsable  le responsable d'un processus (rôle ou personne), le seuil d'occurrences ;
--   Recette             un circuit, son statut, la version en usage ;
--   RecetteVersion      les versions (jamais réécrites une fois validées) ;
--   RecetteUsage        chaque plan proposé par l'assistant depuis une recette validée.
--
-- ADDITIVE ET IDEMPOTENTE : « IF NOT EXISTS » partout, clés étrangères posées seulement si absentes.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "RecetteResponsable" (
  "processus"        TEXT NOT NULL,
  "role"             "UserRole",
  "userId"           TEXT,
  "seuilOccurrences" INTEGER,
  "designeParId"     TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecetteResponsable_pkey" PRIMARY KEY ("processus")
);

CREATE TABLE IF NOT EXISTS "Recette" (
  "id"                 TEXT NOT NULL,
  "circuit"            TEXT NOT NULL,
  "processus"          TEXT NOT NULL,
  "titre"              TEXT NOT NULL,
  "statut"             TEXT NOT NULL DEFAULT 'PROPOSEE',
  "versionValideeId"   TEXT,
  "derniereExtraction" TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Recette_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Recette_circuit_key" ON "Recette" ("circuit");
CREATE INDEX IF NOT EXISTS "Recette_processus_statut_idx" ON "Recette" ("processus", "statut");

CREATE TABLE IF NOT EXISTS "RecetteVersion" (
  "id"          TEXT NOT NULL,
  "recetteId"   TEXT NOT NULL,
  "numero"      INTEGER NOT NULL,
  "statut"      TEXT NOT NULL DEFAULT 'PROPOSEE',
  "contenu"     JSONB NOT NULL,
  "signature"   TEXT NOT NULL,
  "occurrences" INTEGER NOT NULL,
  "origine"     TEXT NOT NULL DEFAULT 'EXTRACTION',
  "auteurId"    TEXT,
  "decideParId" TEXT,
  "decideLe"    TIMESTAMP(3),
  "motif"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecetteVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RecetteVersion_recetteId_numero_key" ON "RecetteVersion" ("recetteId", "numero");
CREATE INDEX IF NOT EXISTS "RecetteVersion_recetteId_statut_idx" ON "RecetteVersion" ("recetteId", "statut");

CREATE TABLE IF NOT EXISTS "RecetteUsage" (
  "id"            TEXT NOT NULL,
  "recetteId"     TEXT NOT NULL,
  "versionId"     TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "intention"     TEXT NOT NULL,
  "planSignature" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecetteUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RecetteUsage_recetteId_createdAt_idx" ON "RecetteUsage" ("recetteId", "createdAt");
CREATE INDEX IF NOT EXISTS "RecetteUsage_userId_createdAt_idx" ON "RecetteUsage" ("userId", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RecetteVersion_recetteId_fkey') THEN
    ALTER TABLE "RecetteVersion" ADD CONSTRAINT "RecetteVersion_recetteId_fkey" FOREIGN KEY ("recetteId") REFERENCES "Recette"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RecetteUsage_recetteId_fkey') THEN
    ALTER TABLE "RecetteUsage" ADD CONSTRAINT "RecetteUsage_recetteId_fkey" FOREIGN KEY ("recetteId") REFERENCES "Recette"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
