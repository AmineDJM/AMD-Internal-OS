-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J5 + J14 (décision 0022) — LA QUALITÉ CONTINUE DE L'ASSISTANT IA.
--
-- 1. Le BANC PROGRAMMÉ : son calendrier (Super Admin), ses passages, le résultat de chaque scénario.
-- 2. Le MODÈLE D'UN RÔLE choisi à l'écran, seulement sur un banc vert (protocole A/B).
-- 3. Les TRACES REJOUABLES : chaque tour, ce que le modèle a reçu et rendu (gzip).
-- 4. Le MARQUEUR d'une base d'essai — posé par le semis dans la base d'essai seulement.
--
-- ADDITIVE ET IDEMPOTENTE : six tables neuves, aucune colonne touchée.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "AssistantIaBancReglage" (
  "id"          TEXT NOT NULL DEFAULT 'global',
  "actif"       BOOLEAN NOT NULL DEFAULT true,
  "frequence"   TEXT NOT NULL DEFAULT 'HEBDOMADAIRE',
  "jour"        INTEGER NOT NULL DEFAULT 5,
  "heure"       INTEGER NOT NULL DEFAULT 3,
  "plafondUsd"  DOUBLE PRECISION NOT NULL DEFAULT 1,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedById" TEXT,
  CONSTRAINT "AssistantIaBancReglage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AssistantIaBancPassage" (
  "id"                 TEXT NOT NULL,
  "declencheur"        TEXT NOT NULL,
  "statut"             TEXT NOT NULL DEFAULT 'DEMANDE',
  "raison"             TEXT,
  "demandeParId"       TEXT,
  "modeles"            JSONB,
  "candidat"           JSONB,
  "plafondUsd"         DOUBLE PRECISION NOT NULL DEFAULT 1,
  "reussis"            INTEGER NOT NULL DEFAULT 0,
  "total"              INTEGER NOT NULL DEFAULT 0,
  "erreurs"            INTEGER NOT NULL DEFAULT 0,
  "ecrituresSansCarte" INTEGER NOT NULL DEFAULT 0,
  "latenceP50Ms"       INTEGER,
  "latenceP95Ms"       INTEGER,
  "premierMotP50Ms"    INTEGER,
  "premierMotP95Ms"    INTEGER,
  "jetonsEntree"       INTEGER NOT NULL DEFAULT 0,
  "jetonsCache"        INTEGER NOT NULL DEFAULT 0,
  "jetonsSortie"       INTEGER NOT NULL DEFAULT 0,
  "coutUsd"            DOUBLE PRECISION NOT NULL DEFAULT 0,
  "budgetAtteint"      BOOLEAN NOT NULL DEFAULT false,
  "referenceId"        TEXT,
  "regressions"        JSONB,
  "vert"               BOOLEAN,
  "notifieLe"          TIMESTAMP(3),
  "demandeLe"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "debutLe"            TIMESTAMP(3),
  "finLe"              TIMESTAMP(3),
  CONSTRAINT "AssistantIaBancPassage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaBancPassage_statut_demandeLe_idx" ON "AssistantIaBancPassage"("statut", "demandeLe");
CREATE INDEX IF NOT EXISTS "AssistantIaBancPassage_finLe_idx" ON "AssistantIaBancPassage"("finLe");

CREATE TABLE IF NOT EXISTS "AssistantIaBancScenario" (
  "id"           TEXT NOT NULL,
  "passageId"    TEXT NOT NULL,
  "scenario"     TEXT NOT NULL,
  "famille"      TEXT NOT NULL,
  "verdict"      TEXT NOT NULL,
  "motifs"       TEXT[] DEFAULT ARRAY[]::TEXT[],
  "ms"           INTEGER,
  "premierMotMs" INTEGER,
  "appels"       INTEGER NOT NULL DEFAULT 0,
  "jetonsEntree" INTEGER NOT NULL DEFAULT 0,
  "jetonsCache"  INTEGER NOT NULL DEFAULT 0,
  "jetonsSortie" INTEGER NOT NULL DEFAULT 0,
  "coutUsd"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "AssistantIaBancScenario_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaBancScenario_passageId_idx" ON "AssistantIaBancScenario"("passageId");
CREATE INDEX IF NOT EXISTS "AssistantIaBancScenario_scenario_idx" ON "AssistantIaBancScenario"("scenario");
DO $$ BEGIN
  ALTER TABLE "AssistantIaBancScenario" ADD CONSTRAINT "AssistantIaBancScenario_passageId_fkey"
    FOREIGN KEY ("passageId") REFERENCES "AssistantIaBancPassage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AssistantIaModeleRole" (
  "role"        TEXT NOT NULL,
  "modelId"     TEXT NOT NULL,
  "effort"      TEXT NOT NULL,
  "passageId"   TEXT NOT NULL,
  "decideParId" TEXT NOT NULL,
  "decideLe"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaModeleRole_pkey" PRIMARY KEY ("role")
);

CREATE TABLE IF NOT EXISTS "AssistantIaTrace" (
  "id"        TEXT NOT NULL,
  "tourId"    TEXT NOT NULL,
  "messageId" TEXT,
  "userId"    TEXT NOT NULL,
  "version"   INTEGER NOT NULL DEFAULT 1,
  "appels"    INTEGER NOT NULL DEFAULT 0,
  "octets"    INTEGER NOT NULL DEFAULT 0,
  "donnees"   BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaTrace_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantIaTrace_tourId_key" ON "AssistantIaTrace"("tourId");
CREATE INDEX IF NOT EXISTS "AssistantIaTrace_userId_createdAt_idx" ON "AssistantIaTrace"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantIaTrace_createdAt_idx" ON "AssistantIaTrace"("createdAt");

CREATE TABLE IF NOT EXISTS "BancBaseEssai" (
  "id"         TEXT NOT NULL DEFAULT 'base-essai',
  "nom"        TEXT NOT NULL,
  "declareeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BancBaseEssai_pkey" PRIMARY KEY ("id")
);
