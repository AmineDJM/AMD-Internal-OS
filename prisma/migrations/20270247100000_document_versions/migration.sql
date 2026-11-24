-- VERSIONS DES DOCUMENTS ET ENREGISTREMENTS FORCÉS DE L'ÉDITEUR OFFICE (audit du Drive, 24/11, points A3-A4).
-- Idempotente : chaque ordre se rejoue sans effet.

-- 1. Chaque enregistrement d'un Document (éditeur Office, éditeur de texte) écrit une NOUVELLE clé de stockage : la ligne
--    garde la clé de chaque version, l'ancienne reste lisible et n'est rendue qu'à la destruction réelle. Pas de clé
--    étrangère vers "Document" : une pièce mise en corbeille garde ses versions, qui la retrouvent à la restauration.
CREATE TABLE IF NOT EXISTS "DocumentVersion" (
  "id"          TEXT NOT NULL,
  "documentId"  TEXT NOT NULL,
  "version"     INTEGER NOT NULL,
  "fileKey"     TEXT NOT NULL,
  "size"        DOUBLE PRECISION,
  "forcesave"   BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");
CREATE INDEX IF NOT EXISTS "DocumentVersion_documentId_idx" ON "DocumentVersion"("documentId");

-- 2. Une version du Drive née d'un enregistrement FORCÉ (statut 6) : la session d'édition continue, sa clé ne change pas.
ALTER TABLE "FileVersion" ADD COLUMN IF NOT EXISTS "forcesave" BOOLEAN NOT NULL DEFAULT false;
