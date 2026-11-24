-- IMPOTS & COTISATIONS (maquette validee par le Super Admin, 24/11/2026) — un sous-module des Finances : les Finances
-- demandent au centre de paiement le paiement des obligations fiscales et sociales de chaque societe (G50, CNAS, acompte
-- d'IBS, paiements ponctuels). La plateforme ne calcule aucun impot : elle recopie, propose l'IRG et la CNAS depuis les
-- fiches salaries, et cree l'ordre par l'unique ecrivain (`createExpenseOrder`, source `TAX_PAYMENT`).
--
-- Idempotent : IF NOT EXISTS partout, contraintes dans un bloc qui ignore le doublon, acces recopies sans jamais reecrire
-- un acces deja pose (ON CONFLICT DO NOTHING).

-- ── 1. LA SOURCE D'UN ORDRE DE DEPENSE ──────────────────────────────────────────────────────────────────────────────────
-- Ajoutee seulement : elle n'est pas employee dans cette migration (Postgres refuse une valeur d'enum dans la transaction
-- qui la cree).
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'TAX_PAYMENT';

-- ── 2. LE CALENDRIER DES OBLIGATIONS, PAR SOCIETE ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ObligationFiscale" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "organisme" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "composition" TEXT NOT NULL DEFAULT 'MONTANT',
    "periodicite" TEXT NOT NULL DEFAULT 'MENSUELLE',
    "jourLimite" INTEGER,
    "moisLimite" INTEGER,
    "jourConfirmeLe" TIMESTAMP(3),
    "jourConfirmeParId" TEXT,
    "rappel" BOOLEAN NOT NULL DEFAULT true,
    "retireeLe" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObligationFiscale_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ObligationFiscale_companyId_idx" ON "ObligationFiscale"("companyId");

-- ── 3. LES ECHEANCES A PAYER (une periode d'une obligation, ou un paiement ponctuel) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "EcheanceFiscale" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "obligationId" TEXT,
    "organisme" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "composition" TEXT NOT NULL DEFAULT 'MONTANT',
    "periode" TEXT,
    "periodeLibelle" TEXT NOT NULL,
    "echeance" TIMESTAMP(3),
    "saisies" JSONB,
    "propositions" JSONB,
    "decomposition" JSONB,
    "montant" DECIMAL(14,2),
    "expenseOrderId" TEXT,
    "ordresIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "justificatifId" TEXT,
    "justificatifNom" TEXT,
    "quittanceId" TEXT,
    "quittanceNumero" TEXT,
    "motifRefusPrecedent" TEXT,
    "envoyeLe" TIMESTAMP(3),
    "envoyeParId" TEXT,
    "rappelEnvoyeLe" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcheanceFiscale_pkey" PRIMARY KEY ("id")
);

-- (colonnes ajoutées en cours de lot : une base qui a vu la première écriture du script les reçoit ici)
ALTER TABLE "ObligationFiscale" ADD COLUMN IF NOT EXISTS "moisLimite" INTEGER;
ALTER TABLE "EcheanceFiscale" ADD COLUMN IF NOT EXISTS "ordresIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE UNIQUE INDEX IF NOT EXISTS "EcheanceFiscale_expenseOrderId_key" ON "EcheanceFiscale"("expenseOrderId");
CREATE INDEX IF NOT EXISTS "EcheanceFiscale_companyId_idx" ON "EcheanceFiscale"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "EcheanceFiscale_obligationId_periode_key" ON "EcheanceFiscale"("obligationId", "periode");

DO $$ BEGIN
  ALTER TABLE "ObligationFiscale" ADD CONSTRAINT "ObligationFiscale_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "EcheanceFiscale" ADD CONSTRAINT "EcheanceFiscale_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "EcheanceFiscale" ADD CONSTRAINT "EcheanceFiscale_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "ObligationFiscale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4. LA CLE DU MODULE : FINANCES_IMPOTS ───────────────────────────────────────────────────────────────────────────────
-- Meme principe que `modules_configurables` : au deploiement, PERSONNE NE GAGNE NI NE PERD UN ACCES. Le defaut de chaque
-- role reproduit ses gestes de FINANCES (src/lib/rbac/permissions.ts) ; un acces personnalise ou bloque pose sur FINANCES
-- est recopie a l'identique sur la nouvelle cle. Ensuite, le Super Admin la regle depuis la console. `UserAccess.module`
-- est une chaine : aucune colonne a ajouter.
INSERT INTO "UserAccess" ("id", "userId", "module", "canView", "canCreate", "canUpdate", "canDelete", "canValidate", "canExport", "canUpload", "scope", "sections", "createdAt", "updatedAt")
SELECT 'mc_' || substr(md5(ua."id" || 'FINANCES_IMPOTS'), 1, 22), ua."userId", 'FINANCES_IMPOTS',
       ua."canView", ua."canCreate", ua."canUpdate", ua."canDelete", ua."canValidate", ua."canExport", ua."canUpload",
       ua."scope", '{}'::text[], NOW(), NOW()
FROM "UserAccess" ua
WHERE ua."module" = 'FINANCES'
ON CONFLICT ("userId", "module") DO NOTHING;

-- Un absent qui deleguait les Finances delegue aussi leurs impots et cotisations.
UPDATE "LeaveRequest"
SET "standInModules" = "standInModules" || ARRAY['FINANCES_IMPOTS']
WHERE 'FINANCES' = ANY("standInModules") AND NOT ('FINANCES_IMPOTS' = ANY("standInModules"));
