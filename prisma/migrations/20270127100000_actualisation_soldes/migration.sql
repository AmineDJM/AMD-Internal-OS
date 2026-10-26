-- Migration : 20270127100000_actualisation_soldes
-- Demande d'actualisation des soldes (Super Admin → responsables Finance / Budget), par entité,
-- avec une ligne par compte de trésorerie : nouveau solde de relevé + date, ou « pas encore reçu ».
-- Idempotente : rejouable sans effet.

CREATE TABLE IF NOT EXISTS "DemandeActualisationSoldes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "note" TEXT,
    "demandeParId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "termineeLe" TIMESTAMP(3),
    CONSTRAINT "DemandeActualisationSoldes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LigneActualisationSoldes" (
    "id" TEXT NOT NULL,
    "demandeId" TEXT NOT NULL,
    "compteId" TEXT NOT NULL,
    "etat" TEXT NOT NULL DEFAULT 'EN_ATTENTE',
    "ancienSolde" DECIMAL(14,2) NOT NULL,
    "ancienneDate" TIMESTAMP(3) NOT NULL,
    "nouveauSolde" DECIMAL(14,2),
    "nouvelleDate" TIMESTAMP(3),
    "traiteParId" TEXT,
    "traiteLe" TIMESTAMP(3),
    CONSTRAINT "LigneActualisationSoldes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DemandeActualisationSoldes_companyId_termineeLe_idx" ON "DemandeActualisationSoldes"("companyId", "termineeLe");
CREATE UNIQUE INDEX IF NOT EXISTS "LigneActualisationSoldes_demandeId_compteId_key" ON "LigneActualisationSoldes"("demandeId", "compteId");
CREATE INDEX IF NOT EXISTS "LigneActualisationSoldes_compteId_idx" ON "LigneActualisationSoldes"("compteId");

DO $$ BEGIN
    ALTER TABLE "DemandeActualisationSoldes" ADD CONSTRAINT "DemandeActualisationSoldes_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "LigneActualisationSoldes" ADD CONSTRAINT "LigneActualisationSoldes_demandeId_fkey"
        FOREIGN KEY ("demandeId") REFERENCES "DemandeActualisationSoldes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "LigneActualisationSoldes" ADD CONSTRAINT "LigneActualisationSoldes_compteId_fkey"
        FOREIGN KEY ("compteId") REFERENCES "TreasuryAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
