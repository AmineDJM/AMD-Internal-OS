-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J2 (décision 0016, Direction 29/10/2026) — LES TRAVAUX : le Mission Runtime pour tous.
--
-- Un TRAVAIL est une `Mission` de `kind = 'TRAVAIL'` : même moteur (`avancer`), mêmes étapes, mêmes reçus,
-- mêmes baux. Ce qui s'ajoute : la personne au nom de qui il tourne (`principalId`, n'importe quel
-- collaborateur), la persona qui le conduit (`ADAM` | `ASSISTANT_IA`), son plafond de dépense, son carnet,
-- la liste des gestes approuvés une fois avec le plan, et la date du dernier point quotidien.
--
-- ADDITIVE ET IDEMPOTENTE : colonnes nullables (ou à défaut), une table neuve. Aucune mission existante
-- d'Adam n'est réécrite — `principalId` et `persona` restent NULL sur elles (NULL = mission d'Adam).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "principalId"      TEXT;
ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "persona"          TEXT;
ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "plafondUsd"       DOUBLE PRECISION;
ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "carnet"           JSONB;
ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "gestesAutorises"  JSONB;
ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "planApprouveLe"   TIMESTAMP(3);
ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "planApprouvePar"  TEXT;
ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "pointQuotidienLe" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Mission_principalId_kind_status_idx" ON "Mission"("principalId", "kind", "status");

-- LE REÇU D'UN GESTE ÉCRIT PAR UN TRAVAIL — réclamé AVANT d'agir (clé unique), clos APRÈS. Une reprise
-- qui retrouve un reçu clos rend le résultat sans refaire le geste ; un reçu réclamé jamais clos (processus
-- tué pendant le geste) n'est JAMAIS rejoué : l'étape échoue et le dit.
CREATE TABLE IF NOT EXISTS "TravailEcriture" (
  "id"        TEXT NOT NULL,
  "cle"       TEXT NOT NULL,
  "missionId" TEXT NOT NULL,
  "stepKey"   TEXT NOT NULL,
  "geste"     TEXT NOT NULL,
  "statut"    TEXT NOT NULL DEFAULT 'RECLAME',
  "resultat"  JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TravailEcriture_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TravailEcriture_cle_key" ON "TravailEcriture"("cle");
CREATE INDEX IF NOT EXISTS "TravailEcriture_missionId_idx" ON "TravailEcriture"("missionId");
DO $$ BEGIN
  ALTER TABLE "TravailEcriture" ADD CONSTRAINT "TravailEcriture_missionId_fkey"
    FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- LES PLAFONDS DE DÉPENSE (décision 4 de la Direction) : par travail (20 $ par défaut) et par personne et
-- par mois, réglables dans la console `/admin/ai/acces` — défauts globaux, puis rôle, puis personne.
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "plafondTravailUsd" DOUBLE PRECISION NOT NULL DEFAULT 20;
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "plafondMensuelUsd" DOUBLE PRECISION NOT NULL DEFAULT 50;
ALTER TABLE "AssistantIaAcces"   ADD COLUMN IF NOT EXISTS "plafondTravailUsd" DOUBLE PRECISION;
ALTER TABLE "AssistantIaAcces"   ADD COLUMN IF NOT EXISTS "plafondMensuelUsd" DOUBLE PRECISION;
