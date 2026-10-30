-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J8 (décision 0023) — LES TRAVAUX POUR TOUS, SUITE : délégation, attentes avancées, équipe, réveil rapide.
--
-- ADDITIVE ET IDEMPOTENTE : une table neuve, des colonnes nullables (ou à défaut). Rien d'existant n'est réécrit.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- LA DEMANDE D'UN TRAVAIL À UNE AUTRE PERSONNE (`DEMANDER_A`) — déposée dans l'espace du destinataire, qui ne voit que
-- la question et les pièces partagées, jamais le carnet. Une par étape (clé unique) : un redémarrage ne la double pas.
CREATE TABLE IF NOT EXISTS "TravailDemande" (
  "id"               TEXT NOT NULL,
  "missionId"        TEXT NOT NULL,
  "stepKey"          TEXT NOT NULL,
  "demandeurId"      TEXT NOT NULL,
  "destinataireId"   TEXT NOT NULL,
  "question"         TEXT NOT NULL,
  "piecesAttendues"  JSONB NOT NULL DEFAULT '[]',
  "piecesPartagees"  JSONB NOT NULL DEFAULT '[]',
  "echeance"         TIMESTAMP(3) NOT NULL,
  "relanceA"         TIMESTAMP(3),
  "escaladeA"        TIMESTAMP(3),
  "abandonA"         TIMESTAMP(3) NOT NULL,
  "statut"           TEXT NOT NULL DEFAULT 'OUVERTE',
  "relances"         INTEGER NOT NULL DEFAULT 0,
  "derniereRelanceLe" TIMESTAMP(3),
  "escaladeLe"       TIMESTAMP(3),
  "reponse"          TEXT,
  "piecesFournies"   JSONB NOT NULL DEFAULT '[]',
  "reponduLe"        TIMESTAMP(3),
  "reponduPar"       TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TravailDemande_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TravailDemande_missionId_stepKey_key" ON "TravailDemande"("missionId", "stepKey");
CREATE INDEX IF NOT EXISTS "TravailDemande_destinataireId_statut_idx" ON "TravailDemande"("destinataireId", "statut");
CREATE INDEX IF NOT EXISTS "TravailDemande_statut_echeance_idx" ON "TravailDemande"("statut", "echeance");
DO $$ BEGIN
  ALTER TABLE "TravailDemande" ADD CONSTRAINT "TravailDemande_missionId_fkey"
    FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- LE RÉVEIL RAPIDE : un fait (événement, réponse, minuterie) qui règle l'attente d'un travail le signale ici ; la
-- boucle courte des réveils le reprend en quelques secondes au lieu d'attendre le battement d'une minute.
ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "reveilDemandeLe" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Mission_kind_reveilDemandeLe_idx" ON "Mission"("kind", "reveilDemandeLe");

-- LA CONSOLE : un responsable voit-il les travaux de son équipe ? Défaut : NON (Direction, J8).
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "managerVoitEquipe" BOOLEAN NOT NULL DEFAULT false;
