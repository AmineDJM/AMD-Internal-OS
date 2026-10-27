-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Refonte des données, vague 2, lot V2-D « Lieux et coordonnées » (`docs/architecture/refonte-vague-2.md`).
--
-- LA WILAYA DEVIENT UNE CLÉ À CÔTÉ DU TEXTE. Les fiches qui portent un lieu saisi à la main gagnent une colonne
-- `wilayaCode` NULLABLE, clé étrangère vers `Wilaya` (69 lignes, chargées par `20270130110000_lieux_reference`).
-- Le texte (`wilaya`, `city`, `wilayaPivot`) RESTE, inchangé : il est la saisie ; la clé en est la lecture.
--
--   MedicalDoctor       wilaya, city, region   (annuaire des praticiens)
--   MedicalInstitution  wilaya, city, region   (annuaire des établissements)
--   CompanyContact      wilaya, city           (annuaire des partenaires)
--   Supplier            city (+ country)       (fournisseurs ; un fournisseur étranger n'a pas de wilaya)
--   SalesSector         wilayaPivot, city      (secteurs de vente)
-- Non retenus, et pourquoi : `Employee` et `CareBeneficiary` n'ont aucune colonne de lieu (leur adresse passe
-- par `Adresse`) ; `StockCountRequestHospital.wilaya` est une COPIE figée de l'établissement au jour de la
-- demande ; `Event`, `CongressNational`, `SponsoringRequest`… portent le lieu d'un événement, pas d'une fiche.
--
-- Le remplissage n'est PAS fait ici : c'est la reprise « lieux-wilaya », lancée par le Super Admin depuis
-- Administration › Refonte des données (aperçu à blanc, lots, journal). Ensuite, la double écriture
-- (`AppSetting.lieuxDoubleEcriture`, vrai par défaut) pose la clé à chaque saisie.
--
-- `Adresse` reçoit les clés étrangères annoncées par la vague 1 (« la clé étrangère viendra avec lui ») :
-- `wilayaCode` → `Wilaya`, `communeCode` → `Commune` (table vide : aucune adresse ne peut citer une commune
-- tant qu'aucune source officielle n'est chargée — c'est voulu).
--
-- Additive et idempotente : ADD COLUMN IF NOT EXISTS, index IF NOT EXISTS, contraintes en bloc DO … EXCEPTION.
-- Aucune donnée existante n'est modifiée.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "MedicalDoctor"      ADD COLUMN IF NOT EXISTS "wilayaCode" TEXT;
ALTER TABLE "MedicalInstitution" ADD COLUMN IF NOT EXISTS "wilayaCode" TEXT;
ALTER TABLE "CompanyContact"     ADD COLUMN IF NOT EXISTS "wilayaCode" TEXT;
ALTER TABLE "Supplier"           ADD COLUMN IF NOT EXISTS "wilayaCode" TEXT;
ALTER TABLE "SalesSector"        ADD COLUMN IF NOT EXISTS "wilayaCode" TEXT;

CREATE INDEX IF NOT EXISTS "MedicalDoctor_wilayaCode_idx"      ON "MedicalDoctor"("wilayaCode");
CREATE INDEX IF NOT EXISTS "MedicalInstitution_wilayaCode_idx" ON "MedicalInstitution"("wilayaCode");
CREATE INDEX IF NOT EXISTS "CompanyContact_wilayaCode_idx"     ON "CompanyContact"("wilayaCode");
CREATE INDEX IF NOT EXISTS "Supplier_wilayaCode_idx"           ON "Supplier"("wilayaCode");
CREATE INDEX IF NOT EXISTS "SalesSector_wilayaCode_idx"        ON "SalesSector"("wilayaCode");

DO $$ BEGIN
  ALTER TABLE "MedicalDoctor" ADD CONSTRAINT "MedicalDoctor_wilayaCode_fkey"
    FOREIGN KEY ("wilayaCode") REFERENCES "Wilaya"("code") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "MedicalInstitution" ADD CONSTRAINT "MedicalInstitution_wilayaCode_fkey"
    FOREIGN KEY ("wilayaCode") REFERENCES "Wilaya"("code") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CompanyContact" ADD CONSTRAINT "CompanyContact_wilayaCode_fkey"
    FOREIGN KEY ("wilayaCode") REFERENCES "Wilaya"("code") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_wilayaCode_fkey"
    FOREIGN KEY ("wilayaCode") REFERENCES "Wilaya"("code") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "SalesSector" ADD CONSTRAINT "SalesSector_wilayaCode_fkey"
    FOREIGN KEY ("wilayaCode") REFERENCES "Wilaya"("code") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Adresse" ADD CONSTRAINT "Adresse_wilayaCode_fkey"
    FOREIGN KEY ("wilayaCode") REFERENCES "Wilaya"("code") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Adresse" ADD CONSTRAINT "Adresse_communeCode_fkey"
    FOREIGN KEY ("communeCode") REFERENCES "Commune"("code") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- L'INTERRUPTEUR de la double écriture : faux = les formulaires n'écrivent plus `wilayaCode` (le texte, si).
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "lieuxDoubleEcriture" BOOLEAN NOT NULL DEFAULT TRUE;
