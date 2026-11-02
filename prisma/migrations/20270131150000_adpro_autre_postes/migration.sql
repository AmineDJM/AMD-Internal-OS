-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Ad & Pro — LES DEMANDES « AUTRE » PORTENT DES POSTES (Direction, 27/10/2026)
--
-- « Les demandes autres suivent le même circuit » : prévalidation, puis postes acceptés par la
-- Direction Marketing, puis le DG sur le total au-dessus du seuil. Un poste peut donc désormais
-- appartenir à une demande « autre » : une colonne de plus (jamais une colonne polymorphe), avec sa
-- cascade, et la contrainte « un poste, un seul parent » qui compte ce huitième parent.
--
-- Additive et idempotente. La contrainte se REMPLACE par une version plus permissive (elle accepte
-- le nouveau parent) : toute ligne déjà en base la respecte.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "otherRequestId" TEXT;
CREATE INDEX IF NOT EXISTS "AdProItem_otherRequestId_idx" ON "AdProItem"("otherRequestId");

DO $$ BEGIN
    ALTER TABLE "AdProItem" ADD CONSTRAINT "AdProItem_otherRequestId_fkey"
        FOREIGN KEY ("otherRequestId") REFERENCES "AdProOtherRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "AdProItem" DROP CONSTRAINT IF EXISTS "AdProItem_one_parent";
ALTER TABLE "AdProItem"
  ADD CONSTRAINT "AdProItem_one_parent"
  CHECK (
    (CASE WHEN "sponsoringId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "congressNationalId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "congressInternationalId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "eventId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "trainingId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "promoMaterialParentId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "declarationInfoMedId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "otherRequestId" IS NULL THEN 0 ELSE 1 END)
  = 1
  );
