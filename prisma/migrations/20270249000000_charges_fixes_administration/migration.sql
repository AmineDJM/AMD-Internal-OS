-- LES CHARGES FIXES DES LOCAUX ET LE BUDGET DE L'ADMINISTRATION (Super Admin, 24/11/2026 — audit des depenses).
--
--   1. « Informations de la societe » (ex-« Coordonnees des entites ») gagne une section « Locaux & charges fixes » :
--      une charge par site et par nature (loyer, electricite, eau…), montant fixe ou « selon facture » (estimation),
--      periodicite, jour d'echeance, debut / fin, beneficiaire et RIB, bail du registre Legal.
--   2. Chaque echeance demandee au paiement par les Finances garde sa trace (`EcheanceChargeFixe`) : elle est la SOURCE de
--      l'ordre (`FIXED_CHARGE`), et son etat se lit sur l'ordre — jamais saisi.
--   3. Le BUDGET DE L'ADMINISTRATION : une enveloppe par societe et par annee (code `ADMINISTRATION`, tenue par les
--      Finances). L'enveloppe « Moyens generaux », unique pour le groupe, y passe PAR SOCIETE : ses categories sont
--      recopiees sous la ligne « Moyens generaux » de chaque societe et chaque depense suit la societe de son
--      departement. Rien n'est supprime : l'ancienne enveloppe reste (active, sans la marque des moyens generaux), avec
--      ses montants alloues et ce qui ne se rattache a aucune societe.
--
-- Idempotent : IF NOT EXISTS partout, contraintes dans un bloc qui ignore le doublon ; la bascule des moyens generaux ne
-- trouve plus rien a basculer au second passage (l'ancienne enveloppe a perdu sa marque).

-- ── 1. LA SOURCE D'UN ORDRE DE DEPENSE ───────────────────────────────────────────────────────────────────────────────
-- Ajoutee seulement : elle n'est pas employee dans cette migration (Postgres refuse une valeur d'enum dans la transaction
-- qui la cree).
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'FIXED_CHARGE';

-- ── 2. LES CHARGES FIXES D'UNE SOCIETE ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ChargeFixeSociete" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "libelle" TEXT,
    "beneficiaire" TEXT NOT NULL,
    "rib" TEXT,
    "legalDocumentId" TEXT,
    "modeMontant" TEXT NOT NULL DEFAULT 'FIXE',
    "montant" DECIMAL(14,2) NOT NULL,
    "periodicite" TEXT NOT NULL DEFAULT 'MENSUELLE',
    "jourEcheance" INTEGER NOT NULL DEFAULT 1,
    "moisEcheance" INTEGER,
    "dateDebut" TIMESTAMP(3) NOT NULL,
    "dateFin" TIMESTAMP(3),
    "echeanceFixe" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeFixeSociete_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChargeFixeSociete_companyId_idx" ON "ChargeFixeSociete"("companyId");
CREATE INDEX IF NOT EXISTS "ChargeFixeSociete_nature_idx" ON "ChargeFixeSociete"("nature");

-- ── 3. LES ECHEANCES DEMANDEES AU PAIEMENT ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "EcheanceChargeFixe" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "periode" TEXT NOT NULL,
    "dateEcheance" TIMESTAMP(3) NOT NULL,
    "montantPrevu" DECIMAL(14,2) NOT NULL,
    "montantFacture" DECIMAL(14,2),
    "expenseOrderId" TEXT,
    "demandeParId" TEXT,
    "demandeLe" TIMESTAMP(3),
    "rappelEnvoyeLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcheanceChargeFixe_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EcheanceChargeFixe_chargeId_periode_key" ON "EcheanceChargeFixe"("chargeId", "periode");
CREATE INDEX IF NOT EXISTS "EcheanceChargeFixe_companyId_idx" ON "EcheanceChargeFixe"("companyId");
CREATE INDEX IF NOT EXISTS "EcheanceChargeFixe_expenseOrderId_idx" ON "EcheanceChargeFixe"("expenseOrderId");

DO $$ BEGIN
  ALTER TABLE "ChargeFixeSociete" ADD CONSTRAINT "ChargeFixeSociete_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ChargeFixeSociete" ADD CONSTRAINT "ChargeFixeSociete_legalDocumentId_fkey"
    FOREIGN KEY ("legalDocumentId") REFERENCES "LegalDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "EcheanceChargeFixe" ADD CONSTRAINT "EcheanceChargeFixe_chargeId_fkey"
    FOREIGN KEY ("chargeId") REFERENCES "ChargeFixeSociete"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4. LES MOYENS GENERAUX PASSENT PAR SOCIETE, DANS LE BUDGET DE L'ADMINISTRATION ───────────────────────────────────
DO $$
DECLARE
  l RECORD;
  c RECORD;
  t RECORD;
  annee INT;
  milieu TIMESTAMP(3);
  env_id TEXT;
  mg_id TEXT;
  fille_id TEXT;
BEGIN
  FOR l IN
    SELECT * FROM "BudgetEnvelope"
    WHERE ("module" = 'GENERAL_MEANS' OR 'GENERAL_MEANS' = ANY("modules")) AND "module" IS DISTINCT FROM 'ADMINISTRATION'
  LOOP
    annee := EXTRACT(YEAR FROM l."periodStart")::INT;
    milieu := make_timestamp(annee, 6, 30, 0, 0, 0);
    FOR c IN SELECT "id" FROM "Company" WHERE "isActive" = true AND (l."companyId" IS NULL OR "id" = l."companyId") LOOP
      -- L'enveloppe « Administration <annee> » de la societe : trouvee, sinon ouverte (montant 0, tenue par les Finances).
      env_id := NULL;
      SELECT "id" INTO env_id FROM "BudgetEnvelope"
        WHERE "companyId" = c."id" AND "module" = 'ADMINISTRATION' AND "periodStart" <= milieu AND "periodEnd" >= milieu
        ORDER BY "isActive" DESC, "periodStart" DESC LIMIT 1;
      IF env_id IS NULL THEN
        env_id := 'adm' || md5(random()::TEXT || clock_timestamp()::TEXT || c."id");
        INSERT INTO "BudgetEnvelope" ("id", "companyId", "name", "module", "modules", "managerRoles", "periodStart", "periodEnd",
          "totalAmount", "notes", "isActive", "domaine", "createdAt", "updatedAt")
        VALUES (env_id, c."id", 'Administration ' || annee, 'ADMINISTRATION', ARRAY[]::TEXT[], ARRAY['FINANCE_BUDGET_MANAGER']::TEXT[],
          make_timestamp(annee, 1, 1, 0, 0, 0), make_timestamp(annee, 12, 31, 23, 59, 59), 0,
          'Budget de l''Administration, tenu par les Finances : charges fixes des locaux, moyens generaux, dons et mecenat, reserve pour imprevus, remboursement d''emprunt.',
          true, 'GENERAL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      END IF;

      -- La ligne « Moyens generaux » de cette enveloppe.
      mg_id := NULL;
      SELECT "id" INTO mg_id FROM "BudgetCategoryLine" WHERE "envelopeId" = env_id AND "parentId" IS NULL AND "cle" = 'MOYENS_GENERAUX' LIMIT 1;
      IF mg_id IS NULL THEN
        mg_id := 'amg' || md5(random()::TEXT || clock_timestamp()::TEXT || env_id);
        INSERT INTO "BudgetCategoryLine" ("id", "envelopeId", "name", "module", "cle", "allocated", "createdAt", "updatedAt")
        VALUES (mg_id, env_id, 'Moyens généraux', 'GENERAL_MEANS', 'MOYENS_GENERAUX', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      END IF;

      -- Chaque categorie de l'ancienne enveloppe devient une sous-ligne de « Moyens generaux », reconnue par sa cle (ou
      -- son nom) ; les depenses de la societe la suivent. Une sous-categorie ancienne se range sur la meme sous-ligne.
      FOR t IN SELECT * FROM "BudgetCategoryLine" WHERE "envelopeId" = l."id" AND "parentId" IS NULL LOOP
        fille_id := NULL;
        SELECT "id" INTO fille_id FROM "BudgetCategoryLine"
          WHERE "parentId" = mg_id AND ((t."cle" IS NOT NULL AND "cle" = t."cle") OR (t."cle" IS NULL AND "name" = t."name"))
          LIMIT 1;
        IF fille_id IS NULL THEN
          fille_id := 'amn' || md5(random()::TEXT || clock_timestamp()::TEXT || t."id" || c."id");
          INSERT INTO "BudgetCategoryLine" ("id", "envelopeId", "parentId", "name", "module", "cle", "allocated", "color", "notes", "createdAt", "updatedAt")
          VALUES (fille_id, env_id, mg_id, t."name", 'GENERAL_MEANS', t."cle", 0, t."color", t."notes", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        END IF;

        UPDATE "DepartmentBudgetExpense" e SET "budgetCategoryId" = fille_id
          FROM "Department" d
          WHERE e."departmentId" = d."id" AND d."companyId" = c."id"
            AND e."budgetCategoryId" IN (SELECT "id" FROM "BudgetCategoryLine" WHERE "id" = t."id" OR "parentId" = t."id");

        UPDATE "DepartmentExpenseLine" x SET "budgetCategoryId" = fille_id
          FROM "DepartmentBudgetExpense" e, "Department" d
          WHERE x."expenseId" = e."id" AND e."departmentId" = d."id" AND d."companyId" = c."id"
            AND x."budgetCategoryId" IN (SELECT "id" FROM "BudgetCategoryLine" WHERE "id" = t."id" OR "parentId" = t."id");

        UPDATE "FinanceTransaction" SET "budgetCategoryId" = fille_id
          WHERE "companyId" = c."id"
            AND "budgetCategoryId" IN (SELECT "id" FROM "BudgetCategoryLine" WHERE "id" = t."id" OR "parentId" = t."id");

        UPDATE "ExpenseOrder" SET "budgetCategoryId" = fille_id
          WHERE "companyId" = c."id"
            AND "budgetCategoryId" IN (SELECT "id" FROM "BudgetCategoryLine" WHERE "id" = t."id" OR "parentId" = t."id");
      END LOOP;
    END LOOP;

    -- L'ancienne enveloppe n'est plus celle des moyens generaux : elle garde ses montants et ce qui ne se rattache a
    -- aucune societe (departement sans societe), lisibles dans Budgets.
    UPDATE "BudgetEnvelope"
      SET "module" = NULL,
          "modules" = array_remove("modules", 'GENERAL_MEANS'),
          "notes" = trim(both ' ' FROM coalesce("notes", '') || ' Les moyens generaux sont passes par societe dans le budget de l''Administration (24/11/2026) : cette enveloppe garde l''historique.'),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = l."id";
  END LOOP;
END $$;
