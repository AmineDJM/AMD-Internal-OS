-- LA CAMPAGNE BUDGÉTAIRE PRÉVOIT LES RECETTES ET LES DÉPENSES (Super Admin, 24/11/2026).
--   1. Les recettes prévues : par société, par mois, par produit et/ou BU, pour un client (« PCH » aujourd'hui) —
--      quantité × prix unitaire quand le prix existe, montant direct sinon. Saisies par le Super Admin et la Direction
--      générale seuls ; les directions les lisent. Une ligne par clé de rapprochement (société, mois, produit/BU, client) :
--      c'est la même clé qui, au lancement de l'exercice, rapprochera le prévu du réalisé.
--   2. La date à laquelle les recettes sont devenues la RÉFÉRENCE de l'exercice (clôture de la campagne).
--   3. Le volet « Impôts & taxes » (Super Admin, 24/11/2026 : la TVA nette reversée et les impôts de fin d'année sont DANS
--      le budget) : un taux de TVA par ligne de recette et de dépense (nul = le défaut de sa nature), les paramètres de la
--      campagne (TVA par nature, taux d'IBS par société, calendrier des acomptes, taux IRG/CNAS — préréglés « à confirmer
--      par le cabinet »), et les montants AJUSTÉS ou SAISIS par le Super Admin / la DG, avec le calcul qu'ils remplacent.
--
-- Idempotente : rejouée, elle ne change plus rien.

CREATE TABLE IF NOT EXISTS "BudgetCampaignRevenue" (
  "id"             TEXT NOT NULL,
  "campaignId"     TEXT NOT NULL,
  "companyId"      TEXT NOT NULL,
  "month"          INTEGER NOT NULL,
  "productId"      TEXT,
  "businessUnitId" TEXT,
  "client"         TEXT NOT NULL DEFAULT 'PCH',
  "label"          TEXT NOT NULL,
  "quantity"       DECIMAL(16,2),
  "unitPrice"      DECIMAL(16,2),
  "amount"         DECIMAL(16,2) NOT NULL DEFAULT 0,
  "vatRate"        DECIMAL(5,2),
  "priceSource"    TEXT,
  "matchKey"       TEXT NOT NULL,
  "createdById"    TEXT,
  "updatedById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BudgetCampaignRevenue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetCampaignRevenue_campaignId_matchKey_key" ON "BudgetCampaignRevenue" ("campaignId", "matchKey");
CREATE INDEX IF NOT EXISTS "BudgetCampaignRevenue_campaignId_companyId_idx" ON "BudgetCampaignRevenue" ("campaignId", "companyId");

DO $$ BEGIN
  ALTER TABLE "BudgetCampaignRevenue" ADD CONSTRAINT "BudgetCampaignRevenue_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "BudgetCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "BudgetCampaign" ADD COLUMN IF NOT EXISTS "recettesFigeesLe" TIMESTAMP(3);

-- 3. IMPÔTS & TAXES ───────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "BudgetCampaignRevenue" ADD COLUMN IF NOT EXISTS "vatRate" DECIMAL(5,2);
ALTER TABLE "BudgetProposalLine" ADD COLUMN IF NOT EXISTS "vatRate" DECIMAL(5,2);
-- Les poids des douze mois d'une ligne (masse salariale : net + primes au mois de leur versement) ; nul = douzièmes.
ALTER TABLE "BudgetProposalLine" ADD COLUMN IF NOT EXISTS "monthlyProfile" JSONB;
ALTER TABLE "BudgetCampaign" ADD COLUMN IF NOT EXISTS "taxSettings" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS "BudgetCampaignTaxLine" (
  "id"             TEXT NOT NULL,
  "campaignId"     TEXT NOT NULL,
  "companyId"      TEXT NOT NULL,
  "month"          INTEGER NOT NULL,
  "key"            TEXT NOT NULL,
  "computedAmount" DECIMAL(16,2),
  "amount"         DECIMAL(16,2) NOT NULL DEFAULT 0,
  "reason"         TEXT,
  "setById"        TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BudgetCampaignTaxLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetCampaignTaxLine_campaignId_companyId_month_key_key" ON "BudgetCampaignTaxLine" ("campaignId", "companyId", "month", "key");

DO $$ BEGIN
  ALTER TABLE "BudgetCampaignTaxLine" ADD CONSTRAINT "BudgetCampaignTaxLine_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "BudgetCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
