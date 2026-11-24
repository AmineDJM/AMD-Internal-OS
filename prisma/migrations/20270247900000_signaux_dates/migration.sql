-- LOT « MÉMOIRE » (24/11/2026) — arrêter de perdre les données produites par les IA, réparer les clés orphelines.
--
--   1. LA TABLE DES SIGNAUX DATÉS (`SignalDate`, module `src/modules/pilotage`) : une ligne = une observation datée d'une
--      source (Voix du terrain, l'essentiel Produits 360, l'instantané des finances, une proposition d'IA et la décision
--      humaine qui la suit, le contrôle des clés…), avec ses dimensions (société, BU, wilaya, produit, médecin, enveloppe,
--      dossier), une valeur et une charge utile. La clé d'unicité (source, nature, cle, jour) rend tout rejeu idempotent.
--      Les dimensions n'ont PAS de clé étrangère, comme `BudgetEnvelope.businessUnitId` : c'est un HISTORIQUE — retirer un
--      produit ne doit ni effacer ni « anonymiser » ce qu'on a observé de lui (la clé `cle` garde l'identifiant).
--   2. L'ÉTUDE DE MARCHÉ → NOTRE PRODUIT (lien L10 du recensement) : `MarketResearchRow.productId`, posé seulement quand la
--      molécule saisie désigne CERTAINEMENT un de nos produits (`resolveProductId`) ; ON DELETE SET NULL.
--   3. LE GRAPHE D'INFLUENCE (L4) : les clés étrangères vers le praticien existent depuis `20270118120000_intelligence_terrain`
--      — elles sont re-garanties ici (NOT VALID : une base où elles manqueraient les reçoit sans échouer sur l'existant,
--      que le contrôle des clés signale ensuite) et désormais déclarées en relation dans le schéma.
--
-- Idempotente : rejouée, elle ne change plus rien.

-- 1. LES SIGNAUX DATÉS ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SignalDate" (
  "id"               TEXT NOT NULL,
  "jour"             TEXT NOT NULL,
  "source"           TEXT NOT NULL,
  "nature"           TEXT NOT NULL,
  "cle"              TEXT NOT NULL,
  "producteur"       TEXT NOT NULL DEFAULT 'regle',
  "companyId"        TEXT,
  "buId"             TEXT,
  "wilayaCode"       TEXT,
  "productId"        TEXT,
  "doctorId"         TEXT,
  "budgetEnvelopeId" TEXT,
  "entiteType"       TEXT,
  "entiteId"         TEXT,
  "valeur"           DOUBLE PRECISION,
  "unite"            TEXT,
  "gravite"          TEXT,
  "charge"           JSONB NOT NULL DEFAULT '{}',
  "statut"           TEXT NOT NULL DEFAULT 'CONSTATE',
  "auteurId"         TEXT,
  "retenu"           JSONB,
  "decideParId"      TEXT,
  "decideLe"         TIMESTAMP(3),
  "creeLe"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "majLe"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SignalDate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SignalDate_source_nature_cle_jour_key" ON "SignalDate" ("source", "nature", "cle", "jour");
CREATE INDEX IF NOT EXISTS "SignalDate_companyId_jour_idx" ON "SignalDate" ("companyId", "jour");
CREATE INDEX IF NOT EXISTS "SignalDate_source_nature_jour_idx" ON "SignalDate" ("source", "nature", "jour");
CREATE INDEX IF NOT EXISTS "SignalDate_source_statut_auteurId_idx" ON "SignalDate" ("source", "statut", "auteurId");
CREATE INDEX IF NOT EXISTS "SignalDate_entiteType_entiteId_idx" ON "SignalDate" ("entiteType", "entiteId");
CREATE INDEX IF NOT EXISTS "SignalDate_productId_idx" ON "SignalDate" ("productId");
CREATE INDEX IF NOT EXISTS "SignalDate_doctorId_idx" ON "SignalDate" ("doctorId");
CREATE INDEX IF NOT EXISTS "SignalDate_buId_idx" ON "SignalDate" ("buId");

-- 2. L'ÉTUDE DE MARCHÉ → NOTRE PRODUIT ───────────────────────────────────────────────────────────────────────────────
ALTER TABLE "MarketResearchRow" ADD COLUMN IF NOT EXISTS "productId" TEXT;
CREATE INDEX IF NOT EXISTS "MarketResearchRow_productId_idx" ON "MarketResearchRow" ("productId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketResearchRow_productId_fkey') THEN
    ALTER TABLE "MarketResearchRow"
      ADD CONSTRAINT "MarketResearchRow_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 3. LE GRAPHE D'INFLUENCE : LES CLÉS VERS LE PRATICIEN ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PraticienRelation_fromDoctorId_fkey') THEN
    ALTER TABLE "PraticienRelation"
      ADD CONSTRAINT "PraticienRelation_fromDoctorId_fkey" FOREIGN KEY ("fromDoctorId") REFERENCES "MedicalDoctor" ("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PraticienRelation_toDoctorId_fkey') THEN
    ALTER TABLE "PraticienRelation"
      ADD CONSTRAINT "PraticienRelation_toDoctorId_fkey" FOREIGN KEY ("toDoctorId") REFERENCES "MedicalDoctor" ("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InfluenceScore_doctorId_fkey') THEN
    ALTER TABLE "InfluenceScore"
      ADD CONSTRAINT "InfluenceScore_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "MedicalDoctor" ("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;
