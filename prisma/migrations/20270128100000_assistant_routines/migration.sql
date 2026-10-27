-- Migration : 20270128100000_assistant_routines
-- Assistant IA — les routines programmées par la personne (lecture seule, sous ses droits).
-- Idempotente : rejouable sans erreur sur une base qui l'a déjà reçue.

CREATE TABLE IF NOT EXISTS "AssistantRoutine" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "titre" TEXT NOT NULL,
    "consigne" TEXT NOT NULL,
    "frequence" TEXT NOT NULL,
    "intervalle" INTEGER NOT NULL DEFAULT 1,
    "jours" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "jourDuMois" INTEGER,
    "heure" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "debutLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finLe" TIMESTAMP(3),
    "maxExecutions" INTEGER,
    "statut" TEXT NOT NULL DEFAULT 'ACTIVE',
    "prochaineLe" TIMESTAMP(3),
    "priseLe" TIMESTAMP(3),
    "executions" INTEGER NOT NULL DEFAULT 0,
    "echecsConsecutifs" INTEGER NOT NULL DEFAULT 0,
    "derniereLe" TIMESTAMP(3),
    "etat" JSONB,
    "notifier" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantRoutine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AssistantRoutineRun" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "debutLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finLe" TIMESTAMP(3),
    "statut" TEXT NOT NULL,
    "declenchement" TEXT NOT NULL DEFAULT 'PLANIFIE',
    "contenu" TEXT,
    "blocs" JSONB,
    "erreur" TEXT,
    "outils" JSONB,
    "luLe" TIMESTAMP(3),
    "ms" INTEGER,
    CONSTRAINT "AssistantRoutineRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssistantRoutine_statut_prochaineLe_idx" ON "AssistantRoutine"("statut", "prochaineLe");
CREATE INDEX IF NOT EXISTS "AssistantRoutine_userId_statut_idx" ON "AssistantRoutine"("userId", "statut");
CREATE INDEX IF NOT EXISTS "AssistantRoutineRun_routineId_debutLe_idx" ON "AssistantRoutineRun"("routineId", "debutLe");

DO $$ BEGIN
    ALTER TABLE "AssistantRoutine" ADD CONSTRAINT "AssistantRoutine_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AssistantRoutineRun" ADD CONSTRAINT "AssistantRoutineRun_routineId_fkey"
        FOREIGN KEY ("routineId") REFERENCES "AssistantRoutine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
