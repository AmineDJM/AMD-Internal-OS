-- C2 (décision 0041) : les lancements de Claude Code, avec la clé d'idempotence côté Adventum (la Routines API n'en a pas).
CREATE TABLE IF NOT EXISTS "DevLancement" (
  "id" TEXT NOT NULL,
  "cleIdempotence" TEXT NOT NULL,
  "moyen" TEXT NOT NULL,
  "cible" TEXT NOT NULL,
  "missionId" TEXT,
  "statut" TEXT NOT NULL DEFAULT 'EN_COURS',
  "empreinte" TEXT NOT NULL,
  "sessionId" TEXT,
  "sessionUrl" TEXT,
  "commentaireId" TEXT,
  "erreur" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DevLancement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DevLancement_cleIdempotence_key" ON "DevLancement"("cleIdempotence");
CREATE INDEX IF NOT EXISTS "DevLancement_moyen_cible_createdAt_idx" ON "DevLancement"("moyen", "cible", "createdAt");
CREATE INDEX IF NOT EXISTS "DevLancement_statut_createdAt_idx" ON "DevLancement"("statut", "createdAt");
CREATE INDEX IF NOT EXISTS "DevLancement_missionId_idx" ON "DevLancement"("missionId");
