-- C1 (décision 0042) : le socle des chantiers de développement — réservations, mémoire technique, réglages. Additive, idempotente.
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "chantiersReglages" JSONB;

CREATE TABLE IF NOT EXISTS "ChantierReservation" (
  "id" TEXT NOT NULL,
  "cle" TEXT NOT NULL,
  "ressource" TEXT NOT NULL,
  "depot" TEXT,
  "valeur" TEXT NOT NULL,
  "missionId" TEXT NOT NULL,
  "expireLe" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChantierReservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChantierReservation_cle_key" ON "ChantierReservation"("cle");
CREATE INDEX IF NOT EXISTS "ChantierReservation_missionId_idx" ON "ChantierReservation"("missionId");
CREATE INDEX IF NOT EXISTS "ChantierReservation_ressource_depot_idx" ON "ChantierReservation"("ressource", "depot");
DO $$ BEGIN
  ALTER TABLE "ChantierReservation" ADD CONSTRAINT "ChantierReservation_missionId_fkey"
    FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "MemoireTechnique" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "cle" TEXT NOT NULL,
  "contenu" TEXT NOT NULL,
  "source" TEXT,
  "missionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "majLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoireTechnique_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MemoireTechnique_type_cle_key" ON "MemoireTechnique"("type", "cle");
CREATE INDEX IF NOT EXISTS "MemoireTechnique_type_majLe_idx" ON "MemoireTechnique"("type", "majLe");
