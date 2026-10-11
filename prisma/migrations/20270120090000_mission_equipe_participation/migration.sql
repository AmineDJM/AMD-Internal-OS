-- MISSIONS DE L'ÉQUIPE ADVENTUM : demande de participation, versions négociées, billet / hôtel par membre,
-- notes de frais en lignes, rapport et clôture (Direction, 10/2026) — voir src/lib/missions-equipe/participation.ts.
--
-- Idempotente et additive. Une assignation d'avant n'a aucune version : elle garde son circuit d'avant
-- (« confirmée » = mission ouverte, étapes facultatives), rien n'est deviné.

ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "accordVersionId" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "accordAt" TIMESTAMP(3);
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "billetDocumentId" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "billetReference" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "billetTrajets" JSONB;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "billetDeposeParId" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "billetDeposeLe" TIMESTAMP(3);
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "hotelNom" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "hotelConfirmation" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "hotelDocumentId" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "hotelDeposeParId" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "hotelDeposeLe" TIMESTAMP(3);
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "reservationDossierId" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "reservationDemandeeLe" TIMESTAMP(3);
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "budgetCategoryId" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "budgetChoisiParId" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "budgetChoisiLe" TIMESTAMP(3);
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "rapportDeroule" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "rapportMedecins" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "rapportRetombees" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "rapportSuites" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "rapportLe" TIMESTAMP(3);
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "clotureLe" TIMESTAMP(3);
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "clotureParId" TEXT;
ALTER TABLE "MissionAssignment" ADD COLUMN IF NOT EXISTS "noteFraisRequestId" TEXT;

CREATE TABLE IF NOT EXISTS "MissionParticipationVersion" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "numero" INTEGER NOT NULL,
  "auteurId" TEXT NOT NULL,
  "cote" TEXT NOT NULL,
  "nature" TEXT NOT NULL,
  "contenu" JSONB NOT NULL,
  "motif" TEXT,
  "statut" TEXT NOT NULL DEFAULT 'EN_ATTENTE',
  "decideParId" TEXT,
  "decideLe" TIMESTAMP(3),
  "motifDecision" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MissionParticipationVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MissionParticipationVersion_assignmentId_numero_key" ON "MissionParticipationVersion"("assignmentId", "numero");
DO $$ BEGIN
  ALTER TABLE "MissionParticipationVersion" ADD CONSTRAINT "MissionParticipationVersion_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "MissionAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "MissionExpenseLine" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "nature" TEXT NOT NULL,
  "detail" TEXT,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" "CareCurrency" NOT NULL DEFAULT 'DZD',
  "amountDzd" DECIMAL(14,2),
  "documentId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MissionExpenseLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MissionExpenseLine_assignmentId_idx" ON "MissionExpenseLine"("assignmentId");
DO $$ BEGIN
  ALTER TABLE "MissionExpenseLine" ADD CONSTRAINT "MissionExpenseLine_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "MissionAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;