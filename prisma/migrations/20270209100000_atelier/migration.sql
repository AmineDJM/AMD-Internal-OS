-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J3 (décision 0017, Direction 30/10/2026) — L'ATELIER : afficher et modifier des documents en direct.
--
-- 1. Chaque opération du Live Office garde les zones qu'elle a TOUCHÉES (l'écran les surligne pendant que
--    l'assistant travaille) et la REVUE de la personne (accepter / refuser, comme le suivi des modifications).
--    Refuser = l'opération est annulée (`undone`) et le reste ; la revue dit pourquoi.
-- 2. Les CONVERSIONS demandées (Word → PDF, PowerPoint → PDF, tableau → Excel, PDF → Word) : une file, que le
--    worker (LibreOffice) prend quand il bat, et la VOIE réellement suivie, dite à l'écran.
--
-- ADDITIVE ET IDEMPOTENTE : deux colonnes nullables, une table neuve.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "ArtifactOperation" ADD COLUMN IF NOT EXISTS "touches" JSONB;
ALTER TABLE "ArtifactOperation" ADD COLUMN IF NOT EXISTS "revue"   TEXT;

CREATE TABLE IF NOT EXISTS "AtelierConversion" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "nodeId"      TEXT NOT NULL,
  "version"     INTEGER NOT NULL,
  "sessionId"   TEXT,
  "vers"        TEXT NOT NULL,
  "voie"        TEXT NOT NULL,
  "etat"        TEXT NOT NULL DEFAULT 'EN_FILE',
  "resultatId"  TEXT,
  "resultatNom" TEXT,
  "note"        TEXT,
  "erreur"      TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AtelierConversion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AtelierConversion_userId_createdAt_idx" ON "AtelierConversion"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AtelierConversion_etat_voie_idx" ON "AtelierConversion"("etat", "voie");
