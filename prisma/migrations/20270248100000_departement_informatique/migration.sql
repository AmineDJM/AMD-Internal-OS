-- LE DEPARTEMENT INFORMATIQUE DU GROUPE (Super Admin, 24/11/2026 : « Le cout de l'IA impute au budget des departements. En
-- gros, tu vas creer un departement informatique, avec ses propres modules, bases de donnees, etc. Et il aura son propre
-- budget egalement. »)
--
-- 1. Une CLE STABLE de departement (`Department.cle`) : le code reconnait « le departement Informatique de telle societe »
--    sans dependre de son nom ni de son code, que les RH peuvent changer. Une seule ligne par societe et par cle.
-- 2. Le departement « Informatique » de chaque societe active : un departement deja nomme ainsi recoit la cle (jamais de
--    doublon), sinon il est cree, sans responsable (les RH le designent dans l'organigramme, comme pour les autres).
-- 3. Ses donnees : le registre des abonnements & licences, le parc informatique, et l'imputation mensuelle du cout de l'IA
--    (une ligne par societe et par mois, le detail par fonction IA et par departement demandeur).
-- 4. Le type de piece `IT_SUBSCRIPTION` : le contrat ou la facture d'un abonnement.
--
-- Aucun montant ni aucune fiche n'est precharge. Idempotent : IF NOT EXISTS, NOT EXISTS, EXCEPTION WHEN duplicate_object.

-- ── 1. La cle stable d'un departement ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Department" ADD COLUMN IF NOT EXISTS "cle" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Department_companyId_cle_key" ON "Department"("companyId", "cle");

-- ── 2. Le departement Informatique de chaque societe ─────────────────────────────────────────────────────────────────────
-- Un departement de tete deja nomme « Informatique » devient LE departement Informatique de sa societe.
UPDATE "Department" d
SET "cle" = 'INFORMATIQUE', "updatedAt" = NOW()
WHERE d."cle" IS NULL
  AND d."parentId" IS NULL
  AND d."companyId" IS NOT NULL
  AND lower(btrim(d."name")) = 'informatique'
  AND NOT EXISTS (SELECT 1 FROM "Department" x WHERE x."companyId" = d."companyId" AND x."cle" = 'INFORMATIQUE');

-- Sinon, il est cree (code technique unique : « INFORMATIQUE_ » + un suffixe tire de la societe).
INSERT INTO "Department" ("id", "name", "code", "companyId", "cle", "description", "createdAt", "updatedAt")
SELECT 'dinfo_' || substr(md5(c."id"), 1, 20),
       'Informatique',
       'INFORMATIQUE_' || upper(substr(md5(c."id"), 1, 6)),
       c."id",
       'INFORMATIQUE',
       'Systemes d''information, intelligence artificielle, abonnements et parc informatique du groupe.',
       NOW(), NOW()
FROM "Company" c
WHERE c."isActive" = TRUE
  AND NOT EXISTS (SELECT 1 FROM "Department" x WHERE x."companyId" = c."id" AND x."cle" = 'INFORMATIQUE')
  AND NOT EXISTS (SELECT 1 FROM "Department" y WHERE y."companyId" = c."id" AND y."name" = 'Informatique')
  AND NOT EXISTS (SELECT 1 FROM "Department" z WHERE z."code" = 'INFORMATIQUE_' || upper(substr(md5(c."id"), 1, 6)));

-- ── 3. Les donnees du departement ────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AbonnementInformatique" (
  "id"               TEXT NOT NULL,
  "companyId"        TEXT NOT NULL,
  "fournisseur"      TEXT NOT NULL,
  "objet"            TEXT NOT NULL,
  "periodicite"      TEXT NOT NULL DEFAULT 'MENSUEL',
  "montant"          DECIMAL(14,2) NOT NULL,
  "devise"           TEXT NOT NULL DEFAULT 'DZD',
  "echeance"         TIMESTAMP(3),
  "rappelJours"      INTEGER NOT NULL DEFAULT 30,
  "rappelEnvoyePour" TIMESTAMP(3),
  "budgetCategoryId" TEXT,
  "statut"           TEXT NOT NULL DEFAULT 'ACTIF',
  "notes"            TEXT,
  "createdById"      TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AbonnementInformatique_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AbonnementInformatique_companyId_idx" ON "AbonnementInformatique"("companyId");
CREATE INDEX IF NOT EXISTS "AbonnementInformatique_echeance_idx" ON "AbonnementInformatique"("echeance");

CREATE TABLE IF NOT EXISTS "MaterielInformatique" (
  "id"           TEXT NOT NULL,
  "companyId"    TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  "reference"    TEXT NOT NULL,
  "numeroSerie"  TEXT,
  "employeeId"   TEXT,
  "departmentId" TEXT,
  "dateAchat"    TIMESTAMP(3),
  "finGarantie"  TIMESTAMP(3),
  "etat"         TEXT NOT NULL DEFAULT 'EN_SERVICE',
  "notes"        TEXT,
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MaterielInformatique_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MaterielInformatique_companyId_idx" ON "MaterielInformatique"("companyId");
CREATE INDEX IF NOT EXISTS "MaterielInformatique_employeeId_idx" ON "MaterielInformatique"("employeeId");

CREATE TABLE IF NOT EXISTS "ImputationCoutIa" (
  "id"            TEXT NOT NULL,
  "companyId"     TEXT NOT NULL,
  "mois"          TEXT NOT NULL,
  "categoryId"    TEXT NOT NULL,
  "expenseLineId" TEXT,
  "coutUsd"       DECIMAL(14,6) NOT NULL,
  "tauxUsdDzd"    DECIMAL(12,4) NOT NULL,
  "montantDzd"    DECIMAL(14,2) NOT NULL,
  "appels"        INTEGER NOT NULL DEFAULT 0,
  "sansTarif"     INTEGER NOT NULL DEFAULT 0,
  "detail"        JSONB NOT NULL DEFAULT '{}',
  "calculeLe"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "calculeParId"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImputationCoutIa_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ImputationCoutIa_companyId_mois_key" ON "ImputationCoutIa"("companyId", "mois");
CREATE INDEX IF NOT EXISTS "ImputationCoutIa_mois_idx" ON "ImputationCoutIa"("mois");

-- ── 4. Le type de piece d'un abonnement ──────────────────────────────────────────────────────────────────────────────────
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'IT_SUBSCRIPTION';
