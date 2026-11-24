-- LOT « NATURES » (Super Admin, 24/11/2026) : la nature obligatoire sur la demande de paiement, et les retenues à la
-- source (honoraires de médecins, prestataires étrangers). Idempotente : elle se rejoue sans effet.
-- Les demandes existantes ne sont PAS réécrites : leur nature reste nulle (« non précisée »).

ALTER TABLE "PaymentRequest" ADD COLUMN IF NOT EXISTS "natureDepense" TEXT;

CREATE TABLE IF NOT EXISTS "RetenueSource" (
  "id" TEXT NOT NULL,
  "companyId" TEXT,
  "expenseOrderId" TEXT NOT NULL,
  "paymentRequestId" TEXT,
  "natureDepense" TEXT NOT NULL,
  "regime" TEXT NOT NULL,
  "beneficiaire" TEXT NOT NULL,
  "brut" DECIMAL(14,2) NOT NULL,
  "taux" DECIMAL(5,2) NOT NULL,
  "montant" DECIMAL(14,2) NOT NULL,
  "net" DECIMAL(14,2) NOT NULL,
  "statut" TEXT NOT NULL DEFAULT 'PREVUE',
  "mois" TEXT,
  "payeeLe" TIMESTAMP(3),
  "budgetCategoryId" TEXT,
  "budgetExpenseLineId" TEXT,
  "reverseeLe" TIMESTAMP(3),
  "reverseeParOrdreId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RetenueSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RetenueSource_expenseOrderId_key" ON "RetenueSource"("expenseOrderId");
CREATE INDEX IF NOT EXISTS "RetenueSource_companyId_mois_statut_idx" ON "RetenueSource"("companyId", "mois", "statut");
CREATE INDEX IF NOT EXISTS "RetenueSource_paymentRequestId_idx" ON "RetenueSource"("paymentRequestId");

CREATE TABLE IF NOT EXISTS "TauxRetenueSource" (
  "regime" TEXT NOT NULL,
  "taux" DECIMAL(5,2) NOT NULL,
  "confirmeParCabinet" BOOLEAN NOT NULL DEFAULT false,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TauxRetenueSource_pkey" PRIMARY KEY ("regime")
);
