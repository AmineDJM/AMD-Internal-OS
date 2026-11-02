-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J12 (décision 0024) — LA PROACTIVITÉ SOUS MANDAT de l'Assistant IA.
--
-- Veilleurs par personne (règles de code), constats dits une fois (clé unique), budget d'interruptions
-- (heures calmes d'Alger, week-end vendredi-samedi, plafond par jour), retours « utile / pas utile »,
-- mandats bornés et révocables avec le reçu de chaque geste. Deux réglages de console.
--
-- ADDITIVE ET IDEMPOTENTE : cinq tables neuves, deux colonnes à défaut. Aucune donnée existante touchée.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "interruptionsMaxJour" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "proactiviteCoupee" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "AssistantVeille" (
  "userId"                 TEXT NOT NULL,
  "interruptionsMax"       INTEGER NOT NULL DEFAULT 5,
  "calmeDebut"             INTEGER NOT NULL DEFAULT 19,
  "calmeFin"               INTEGER NOT NULL DEFAULT 8,
  "weekendCalme"           BOOLEAN NOT NULL DEFAULT true,
  "pointDuMatin"           BOOLEAN NOT NULL DEFAULT true,
  "derniereVeilleLe"       TIMESTAMP(3),
  "dernierMatinLe"         TIMESTAMP(3),
  "derniereInterruptionLe" TIMESTAMP(3),
  "derniersGestesLe"       TIMESTAMP(3),
  "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantVeille_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "AssistantVeilleur" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "code"      TEXT NOT NULL,
  "actif"     BOOLEAN NOT NULL DEFAULT true,
  "seuil"     INTEGER,
  "facteur"   DOUBLE PRECISION NOT NULL DEFAULT 1,
  "utiles"    INTEGER NOT NULL DEFAULT 0,
  "inutiles"  INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantVeilleur_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantVeilleur_userId_code_key" ON "AssistantVeilleur"("userId", "code");

CREATE TABLE IF NOT EXISTS "AssistantSignal" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "veilleur"   TEXT NOT NULL,
  "cle"        TEXT NOT NULL,
  "titre"      TEXT NOT NULL,
  "detail"     TEXT NOT NULL,
  "gravite"    TEXT NOT NULL,
  "lien"       TEXT,
  "entiteType" TEXT,
  "entiteId"   TEXT,
  "etat"       TEXT NOT NULL DEFAULT 'EN_ATTENTE',
  "canal"      TEXT,
  "detecteLe"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "livreLe"    TIMESTAMP(3),
  "resoluLe"   TIMESTAMP(3),
  "retour"     TEXT,
  "retourLe"   TIMESTAMP(3),
  CONSTRAINT "AssistantSignal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantSignal_userId_veilleur_cle_key" ON "AssistantSignal"("userId", "veilleur", "cle");
CREATE INDEX IF NOT EXISTS "AssistantSignal_userId_etat_idx" ON "AssistantSignal"("userId", "etat");
CREATE INDEX IF NOT EXISTS "AssistantSignal_userId_entiteType_entiteId_idx" ON "AssistantSignal"("userId", "entiteType", "entiteId");

CREATE TABLE IF NOT EXISTS "AssistantMandat" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "capacite"      TEXT NOT NULL,
  "statut"        TEXT NOT NULL DEFAULT 'ACTIF',
  "destinataires" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "montantMax"    DOUBLE PRECISION,
  "gestesParJour" INTEGER NOT NULL DEFAULT 3,
  "expireLe"      TIMESTAMP(3) NOT NULL,
  "accordeLe"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consoleParId"  TEXT,
  "consoleLe"     TIMESTAMP(3),
  "revoqueLe"     TIMESTAMP(3),
  "revoqueParId"  TEXT,
  CONSTRAINT "AssistantMandat_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantMandat_userId_statut_idx" ON "AssistantMandat"("userId", "statut");

CREATE TABLE IF NOT EXISTS "AssistantMandatGeste" (
  "id"       TEXT NOT NULL,
  "mandatId" TEXT NOT NULL,
  "userId"   TEXT NOT NULL,
  "signalId" TEXT NOT NULL,
  "statut"   TEXT NOT NULL,
  "resume"   TEXT NOT NULL,
  "lien"     TEXT,
  "faitLe"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantMandatGeste_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantMandatGeste_mandatId_signalId_key" ON "AssistantMandatGeste"("mandatId", "signalId");
CREATE INDEX IF NOT EXISTS "AssistantMandatGeste_userId_faitLe_idx" ON "AssistantMandatGeste"("userId", "faitLe");
DO $$ BEGIN
  ALTER TABLE "AssistantMandatGeste" ADD CONSTRAINT "AssistantMandatGeste_mandatId_fkey"
    FOREIGN KEY ("mandatId") REFERENCES "AssistantMandat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
