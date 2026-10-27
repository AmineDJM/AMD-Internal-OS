-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Refonte vague 2, lot V2-F — LES TÂCHES DE FOND ONT UN BAIL ET UN BATTEMENT VISIBLE.
--
-- Une ligne par tâche planifiée (`src/lib/scheduled.ts`, `TACHES_PLANIFIEES`). Le bail garantit
-- qu'UN seul exécutant tient une tâche à la fois, même quand le web et le worker tournent ensemble
-- (`TACHES_DE_FOND=les-deux`) ; un bail expiré se reprend (reprise après plantage). Les colonnes
-- de passage nourrissent `/api/health/worker` et le Diagnostic.
--
-- Additive et idempotente : une table neuve, rien n'est modifié ni effacé. Les lignes naissent au
-- premier passage de chaque tâche.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE "StatutTacheDeFond" AS ENUM ('EN_COURS', 'OK', 'ECHEC', 'IGNOREE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "TacheDeFond" (
  "cle"             TEXT NOT NULL,
  "detenteur"       TEXT,
  "executeur"       TEXT,
  "bailJusqua"      TIMESTAMP(3),
  "dernierDebutA"   TIMESTAMP(3),
  "dernierFinA"     TIMESTAMP(3),
  "derniereDureeMs" INTEGER,
  "dernierStatut"   "StatutTacheDeFond",
  "dernierMessage"  TEXT,
  "executions"      INTEGER NOT NULL DEFAULT 0,
  "echecs"          INTEGER NOT NULL DEFAULT 0,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TacheDeFond_pkey" PRIMARY KEY ("cle")
);
