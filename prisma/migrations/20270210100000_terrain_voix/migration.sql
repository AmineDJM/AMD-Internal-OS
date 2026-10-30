-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J13 (décision 0025) — TERRAIN ET VOIX : les captations de terrain (vocal, photo) d'un délégué.
--
-- La matière des cartes (compte rendu pré-rempli, demande d'échantillons, tournée du lendemain, pièce
-- rattachée) : rien de métier n'est écrit sans confirmation. `cle` = clé d'idempotence de la file hors ligne.
--
-- ADDITIVE ET IDEMPOTENTE : une table neuve.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "AssistantIaTerrainCapture" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "cle"           TEXT NOT NULL,
  "sorte"         TEXT NOT NULL,
  "etat"          TEXT NOT NULL DEFAULT 'RECU',
  "blobId"        TEXT,
  "nom"           TEXT NOT NULL,
  "mime"          TEXT NOT NULL,
  "taille"        INTEGER NOT NULL,
  "dureeS"        INTEGER,
  "transcription" TEXT,
  "langue"        TEXT,
  "modeleStt"     TEXT,
  "analyse"       JSONB,
  "cartes"        JSONB,
  "fieldReportId" TEXT,
  "erreur"        TEXT,
  "msTotal"       INTEGER,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaTerrainCapture_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AssistantIaTerrainCapture_userId_cle_key" ON "AssistantIaTerrainCapture"("userId", "cle");
CREATE INDEX IF NOT EXISTS "AssistantIaTerrainCapture_userId_createdAt_idx" ON "AssistantIaTerrainCapture"("userId", "createdAt");
