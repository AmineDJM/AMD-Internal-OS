-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J7 (décision 0029) — LE JOURNAL DES EFFETS : les gestes de l'assistant et la valeur AVANT de chaque écriture.
--
-- ADDITIVE ET IDEMPOTENTE : deux tables neuves, une colonne à défaut. Rien d'existant n'est réécrit.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "retentionEffetsJours" INTEGER NOT NULL DEFAULT 180;

CREATE TABLE IF NOT EXISTS "AssistantGesteJournal" (
  "id"               TEXT NOT NULL,
  "principalId"      TEXT NOT NULL,
  "origine"          TEXT NOT NULL,
  "capaciteId"       TEXT,
  "libelle"          TEXT NOT NULL,
  "travailId"        TEXT,
  "etape"            TEXT,
  "cleIdempotence"   TEXT,
  "resultat"         TEXT NOT NULL,
  "message"          TEXT,
  "empreinte"        TEXT,
  "empreinteSimulee" TEXT,
  "ecart"            BOOLEAN NOT NULL DEFAULT false,
  "creeLe"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "annuleLe"         TIMESTAMP(3),
  "annuleParId"      TEXT,
  "annulation"       JSONB,
  CONSTRAINT "AssistantGesteJournal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantGesteJournal_principalId_creeLe_idx" ON "AssistantGesteJournal"("principalId", "creeLe" DESC);
CREATE INDEX IF NOT EXISTS "AssistantGesteJournal_creeLe_idx" ON "AssistantGesteJournal"("creeLe");
CREATE INDEX IF NOT EXISTS "AssistantGesteJournal_cleIdempotence_idx" ON "AssistantGesteJournal"("cleIdempotence");

CREATE TABLE IF NOT EXISTS "AssistantEffet" (
  "id"               TEXT NOT NULL,
  "gesteId"          TEXT NOT NULL,
  "ordre"            INTEGER NOT NULL,
  "type"             TEXT NOT NULL,
  "modele"           TEXT,
  "operation"        TEXT,
  "enregistrementId" TEXT,
  "avant"            JSONB,
  "apres"            JSONB,
  "champs"           TEXT[] DEFAULT ARRAY[]::TEXT[],
  "cascade"          INTEGER,
  "nombre"           INTEGER,
  "imbriquee"        BOOLEAN NOT NULL DEFAULT false,
  "acte"             TEXT,
  "cible"            TEXT,
  "apercu"           TEXT,
  CONSTRAINT "AssistantEffet_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantEffet_gesteId_ordre_idx" ON "AssistantEffet"("gesteId", "ordre");
CREATE INDEX IF NOT EXISTS "AssistantEffet_modele_enregistrementId_idx" ON "AssistantEffet"("modele", "enregistrementId");
DO $$ BEGIN
  ALTER TABLE "AssistantEffet" ADD CONSTRAINT "AssistantEffet_gesteId_fkey"
    FOREIGN KEY ("gesteId") REFERENCES "AssistantGesteJournal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
