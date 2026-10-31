-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- K10c — LES ACTIONS MÉTIER RÉVERSIBLES : la fenêtre d'annulation des effets sortants.
--
-- ADDITIVE ET IDEMPOTENTE : une table neuve, une colonne à défaut. Rien d'existant n'est réécrit.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- La durée de la fenêtre d'annulation d'un effet sortant (secondes) — réglée par le Super Admin (console IA › accès).
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "fenetreAnnulationSec" INTEGER NOT NULL DEFAULT 120;

-- Un effet sortant (diffusion de notifications, courriel à une agence…) qui attend la fin de sa fenêtre d'annulation.
CREATE TABLE IF NOT EXISTS "EffetSortantDiffere" (
  "id"          TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "libelle"     TEXT NOT NULL,
  "cible"       TEXT NOT NULL,
  "principalId" TEXT,
  "charge"      JSONB NOT NULL,
  "statut"      TEXT NOT NULL DEFAULT 'EN_ATTENTE',
  "partA"       TIMESTAMP(3) NOT NULL,
  "parti"       TIMESTAMP(3),
  "resultat"    JSONB,
  "erreur"      TEXT,
  "creeLe"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EffetSortantDiffere_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "EffetSortantDiffere_statut_partA_idx" ON "EffetSortantDiffere"("statut", "partA");
