-- PRISES EN CHARGE — LE CIRCUIT D'ACHAT PAR BONS DE COMMANDE NUMÉROTÉS (Super Admin, 24/11/2026).
--
-- • `circuitAchatAt` sur les deux demandes : posé à la création des demandes nées après ce lot ; nul pour celles en cours
--   (elles gardent le circuit d'avant, leurs devis acceptés et leurs ordres tels quels).
-- • Sur chaque poste (`CareCell`) : le chiffrage de l'assistante (quand, qui, pièce facultative) et la validation de la
--   Direction Marketing (quand, qui, montant validé).
-- • `CareChiffrage` : la demande de chiffrage, ligne du bureau du secrétariat ; `CarePrixHistorique` : qui a changé quel prix.
-- • `CarePecBc` / `CarePecBcLigne` : le BC n°k d'une prise en charge (un `LegalDocument` PURCHASE_ORDER) et ses lignes,
--   avec le retrait (barré avant achat, « Remboursé ? » après) et le paiement (un seul ordre de dépense par BC).
-- Idempotente : chaque objet n'est créé que s'il manque.

DO $$ BEGIN
  CREATE TYPE "CareChiffrageEtat" AS ENUM ('A_PRENDRE', 'EN_COURS', 'TERMINEE', 'ANNULEE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CarePecLigneStatut" AS ENUM ('ACTIVE', 'ACHETEE', 'RETIREE_AVANT_ACHAT', 'RETIREE_APRES_ACHAT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "CongressNational" ADD COLUMN IF NOT EXISTS "circuitAchatAt" TIMESTAMP(3);
ALTER TABLE "CongressInternational" ADD COLUMN IF NOT EXISTS "circuitAchatAt" TIMESTAMP(3);

ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "chiffreLe" TIMESTAMP(3);
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "chiffreParId" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "chiffragePieceId" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "valideLe" TIMESTAMP(3);
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "valideParId" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "montantValideDzd" DECIMAL(14,2);

CREATE TABLE IF NOT EXISTS "CareChiffrage" (
    "id" TEXT NOT NULL,
    "congressNationalId" TEXT,
    "congressInternationalId" TEXT,
    "etat" "CareChiffrageEtat" NOT NULL DEFAULT 'A_PRENDRE',
    "tous" BOOLEAN NOT NULL DEFAULT false,
    "beneficiaryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "demandeParId" TEXT,
    "demandeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priseParId" TEXT,
    "priseLe" TIMESTAMP(3),
    "envoyeeParId" TEXT,
    "envoyeeLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CareChiffrage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CarePrixHistorique" (
    "id" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "ancienDzd" DECIMAL(14,2),
    "nouveauDzd" DECIMAL(14,2),
    "ancienMontant" DECIMAL(14,2),
    "nouveauMontant" DECIMAL(14,2),
    "devise" "CareCurrency" NOT NULL DEFAULT 'DZD',
    "motif" TEXT NOT NULL,
    "auteurId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarePrixHistorique_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CarePecBc" (
    "id" TEXT NOT NULL,
    "congressNationalId" TEXT,
    "congressInternationalId" TEXT,
    "numero" INTEGER NOT NULL,
    "legalDocumentId" TEXT,
    "fournisseur" TEXT NOT NULL,
    "budgetCategoryId" TEXT,
    "creeParId" TEXT,
    "paiementDemandeLe" TIMESTAMP(3),
    "paiementDemandeParId" TEXT,
    "expenseOrderId" TEXT,
    "factureDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CarePecBc_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CarePecBcLigne" (
    "id" TEXT NOT NULL,
    "bcId" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "montantDzd" DECIMAL(14,2) NOT NULL,
    "montantAchatDzd" DECIMAL(14,2),
    "statut" "CarePecLigneStatut" NOT NULL DEFAULT 'ACTIVE',
    "acheteLe" TIMESTAMP(3),
    "acheteParId" TEXT,
    "retireLe" TIMESTAMP(3),
    "retireParId" TEXT,
    "retraitMotif" TEXT,
    "rembourse" BOOLEAN,
    "rembourseDzd" DECIMAL(14,2),
    "rembourseRepondLe" TIMESTAMP(3),
    "rembourseRepondParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CarePecBcLigne_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CareChiffrage_congressNationalId_idx" ON "CareChiffrage"("congressNationalId");
CREATE INDEX IF NOT EXISTS "CareChiffrage_congressInternationalId_idx" ON "CareChiffrage"("congressInternationalId");
CREATE INDEX IF NOT EXISTS "CareChiffrage_etat_idx" ON "CareChiffrage"("etat");
CREATE INDEX IF NOT EXISTS "CarePrixHistorique_cellId_idx" ON "CarePrixHistorique"("cellId");
CREATE UNIQUE INDEX IF NOT EXISTS "CarePecBc_legalDocumentId_key" ON "CarePecBc"("legalDocumentId");
CREATE UNIQUE INDEX IF NOT EXISTS "CarePecBc_expenseOrderId_key" ON "CarePecBc"("expenseOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "CarePecBc_congressNationalId_numero_key" ON "CarePecBc"("congressNationalId", "numero");
CREATE UNIQUE INDEX IF NOT EXISTS "CarePecBc_congressInternationalId_numero_key" ON "CarePecBc"("congressInternationalId", "numero");
CREATE INDEX IF NOT EXISTS "CarePecBcLigne_cellId_idx" ON "CarePecBcLigne"("cellId");
CREATE UNIQUE INDEX IF NOT EXISTS "CarePecBcLigne_bcId_cellId_key" ON "CarePecBcLigne"("bcId", "cellId");

DO $$ BEGIN
  ALTER TABLE "CareChiffrage" ADD CONSTRAINT "CareChiffrage_congressNationalId_fkey" FOREIGN KEY ("congressNationalId") REFERENCES "CongressNational"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CareChiffrage" ADD CONSTRAINT "CareChiffrage_congressInternationalId_fkey" FOREIGN KEY ("congressInternationalId") REFERENCES "CongressInternational"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CarePrixHistorique" ADD CONSTRAINT "CarePrixHistorique_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "CareCell"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CarePecBc" ADD CONSTRAINT "CarePecBc_congressNationalId_fkey" FOREIGN KEY ("congressNationalId") REFERENCES "CongressNational"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CarePecBc" ADD CONSTRAINT "CarePecBc_congressInternationalId_fkey" FOREIGN KEY ("congressInternationalId") REFERENCES "CongressInternational"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CarePecBcLigne" ADD CONSTRAINT "CarePecBcLigne_bcId_fkey" FOREIGN KEY ("bcId") REFERENCES "CarePecBc"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CarePecBcLigne" ADD CONSTRAINT "CarePecBcLigne_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "CareCell"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UN SEUL PARENT, comme les personnes et les devis : une ligne sans demande, ou rattachée à deux, n'a pas de sens.
DO $$ BEGIN
  ALTER TABLE "CareChiffrage" ADD CONSTRAINT "CareChiffrage_one_parent" CHECK (("congressNationalId" IS NULL) <> ("congressInternationalId" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CarePecBc" ADD CONSTRAINT "CarePecBc_one_parent" CHECK (("congressNationalId" IS NULL) <> ("congressInternationalId" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
