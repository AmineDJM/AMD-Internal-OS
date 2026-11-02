-- Lot T3 : le registre des moyens généraux (véhicules, assurances, contrats, entretiens, salles…) et ses réservations.
-- Additive et idempotente.
DO $$ BEGIN
  CREATE TYPE "MoyenGeneralType" AS ENUM ('VEHICULE', 'ASSURANCE', 'CONTRAT_PRESTATAIRE', 'ENTRETIEN', 'FOURNITURE', 'SALLE', 'EQUIPEMENT', 'AUTRE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "MoyenGeneralStatut" AS ENUM ('ACTIF', 'ARCHIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "MoyenGeneralReservationStatut" AS ENUM ('CONFIRMEE', 'ANNULEE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "MoyenGeneral" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "type" "MoyenGeneralType" NOT NULL,
  "libelle" TEXT NOT NULL,
  "description" TEXT,
  "prestataire" TEXT,
  "identifiant" TEXT,
  "montant" DECIMAL(14,2),
  "periodicite" TEXT,
  "dateDebut" TIMESTAMP(3),
  "echeance" TIMESTAMP(3),
  "rappelJours" INTEGER NOT NULL DEFAULT 30,
  "capacite" INTEGER,
  "statut" "MoyenGeneralStatut" NOT NULL DEFAULT 'ACTIF',
  "responsableId" TEXT,
  "parentId" TEXT,
  "companyId" TEXT,
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MoyenGeneral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MoyenGeneral_reference_key" ON "MoyenGeneral"("reference");
CREATE INDEX IF NOT EXISTS "MoyenGeneral_type_statut_idx" ON "MoyenGeneral"("type", "statut");
CREATE INDEX IF NOT EXISTS "MoyenGeneral_echeance_idx" ON "MoyenGeneral"("echeance");
CREATE INDEX IF NOT EXISTS "MoyenGeneral_parentId_idx" ON "MoyenGeneral"("parentId");
DO $$ BEGIN
  ALTER TABLE "MoyenGeneral" ADD CONSTRAINT "MoyenGeneral_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MoyenGeneral"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "MoyenGeneralReservation" (
  "id" TEXT NOT NULL,
  "moyenId" TEXT NOT NULL,
  "debut" TIMESTAMP(3) NOT NULL,
  "fin" TIMESTAMP(3) NOT NULL,
  "objet" TEXT NOT NULL,
  "participants" INTEGER,
  "reserveParId" TEXT NOT NULL,
  "statut" "MoyenGeneralReservationStatut" NOT NULL DEFAULT 'CONFIRMEE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MoyenGeneralReservation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MoyenGeneralReservation_moyenId_debut_idx" ON "MoyenGeneralReservation"("moyenId", "debut");
CREATE INDEX IF NOT EXISTS "MoyenGeneralReservation_reserveParId_idx" ON "MoyenGeneralReservation"("reserveParId");
DO $$ BEGIN
  ALTER TABLE "MoyenGeneralReservation" ADD CONSTRAINT "MoyenGeneralReservation_moyenId_fkey" FOREIGN KEY ("moyenId") REFERENCES "MoyenGeneral"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
