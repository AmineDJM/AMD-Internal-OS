-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- « MES NOTES » (décision 0026, Direction 30/10/2026) — l'espace de notes PRIVÉ de chaque personne, dans
-- l'Assistant IA : des pages, des blocs (texte, titre, puce, case à cocher), un historique, une corbeille
-- de 30 jours ; l'IA ne fait que PROPOSER des modifications, que la personne accepte ou refuse.
--
-- ADDITIVE ET IDEMPOTENTE : quatre tables neuves, une colonne nullable sur le tour du fil (la carte).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "notesProposees" JSONB;

CREATE TABLE IF NOT EXISTS "AssistantIaNotePage" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "titre"       TEXT NOT NULL,
  "rang"        INTEGER NOT NULL DEFAULT 0,
  "blocs"       JSONB NOT NULL,
  "version"     INTEGER NOT NULL DEFAULT 1,
  "supprimeeLe" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaNotePage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaNotePage_userId_supprimeeLe_rang_idx" ON "AssistantIaNotePage"("userId", "supprimeeLe", "rang");

CREATE TABLE IF NOT EXISTS "AssistantIaNoteVersion" (
  "id"        TEXT NOT NULL,
  "pageId"    TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "version"   INTEGER NOT NULL,
  "titre"     TEXT NOT NULL,
  "blocs"     JSONB NOT NULL,
  "auteur"    TEXT NOT NULL DEFAULT 'PERSONNE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaNoteVersion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaNoteVersion_pageId_createdAt_idx" ON "AssistantIaNoteVersion"("pageId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantIaNoteVersion_userId_idx" ON "AssistantIaNoteVersion"("userId");

CREATE TABLE IF NOT EXISTS "AssistantIaNoteCorbeille" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "pageId"     TEXT NOT NULL,
  "bloc"       JSONB NOT NULL,
  "position"   INTEGER NOT NULL DEFAULT 0,
  "supprimeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaNoteCorbeille_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaNoteCorbeille_userId_supprimeLe_idx" ON "AssistantIaNoteCorbeille"("userId", "supprimeLe");

CREATE TABLE IF NOT EXISTS "AssistantIaNoteProposition" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "pageId"    TEXT,
  "filId"     TEXT,
  "geste"     TEXT NOT NULL,
  "args"      JSONB NOT NULL,
  "resume"    TEXT NOT NULL,
  "etat"      TEXT NOT NULL DEFAULT 'PROPOSEE',
  "dependDe"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "inverse"   JSONB,
  "canal"     TEXT NOT NULL DEFAULT 'texte',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decideLe"  TIMESTAMP(3),
  CONSTRAINT "AssistantIaNoteProposition_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaNoteProposition_userId_etat_createdAt_idx" ON "AssistantIaNoteProposition"("userId", "etat", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantIaNoteProposition_pageId_idx" ON "AssistantIaNoteProposition"("pageId");
