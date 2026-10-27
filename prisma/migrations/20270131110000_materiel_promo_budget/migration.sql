-- Migration : 20270131110000_materiel_promo_budget
-- Matériel promotionnel au budget (Direction, 27/10 — point 21) : la Direction Marketing impute une catégorie
-- budgétaire au dossier ; ses BC signés comptent en ENGAGÉ, ses ordres fournisseur en CONSOMMÉ, sur cette catégorie.
-- Idempotente : rejouable sans erreur. Additive : trois colonnes nullables, un index, une clé étrangère.

ALTER TABLE "PromoMaterial" ADD COLUMN IF NOT EXISTS "budgetCategoryId" TEXT;
ALTER TABLE "PromoMaterial" ADD COLUMN IF NOT EXISTS "budgetImputeLe" TIMESTAMP(3);
ALTER TABLE "PromoMaterial" ADD COLUMN IF NOT EXISTS "budgetImputeParId" TEXT;

CREATE INDEX IF NOT EXISTS "PromoMaterial_budgetCategoryId_idx" ON "PromoMaterial"("budgetCategoryId");

DO $$ BEGIN
  ALTER TABLE "PromoMaterial" ADD CONSTRAINT "PromoMaterial_budgetCategoryId_fkey"
    FOREIGN KEY ("budgetCategoryId") REFERENCES "BudgetCategoryLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
