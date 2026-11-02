-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Refonte des données, vague 2, lot V2-C « Organisations » (`docs/architecture/refonte-vague-2.md`).
--
-- 1. `PropositionDoublonOrganisation` : deux organisations qui sont PEUT-ÊTRE la même. Le système
--    propose, une personne tranche (fusion tracée par `Organisation.fusionneeDansId`, jamais d'office).
-- 2. `AppSetting.doubleEcritureOrganisations` : l'interrupteur de la double écriture (faux par défaut).
--
-- ADDITIVE et IDEMPOTENTE : une table et une colonne créées si elles manquent. Aucune donnée n'est
-- écrite ici — la reprise est un service lancé par le Super Admin (Administration › Refonte des données).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "PropositionDoublonOrganisation" (
    "id" TEXT NOT NULL,
    "organisationAId" TEXT NOT NULL,
    "organisationBId" TEXT NOT NULL,
    "niveau" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "raisons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reserves" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "statut" TEXT NOT NULL DEFAULT 'PROPOSEE',
    "decideeParId" TEXT,
    "decideeLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropositionDoublonOrganisation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PropositionDoublonOrganisation_organisationAId_organisation_key"
    ON "PropositionDoublonOrganisation"("organisationAId", "organisationBId");
CREATE INDEX IF NOT EXISTS "PropositionDoublonOrganisation_statut_niveau_idx"
    ON "PropositionDoublonOrganisation"("statut", "niveau");
CREATE INDEX IF NOT EXISTS "PropositionDoublonOrganisation_organisationBId_idx"
    ON "PropositionDoublonOrganisation"("organisationBId");

DO $$ BEGIN
  ALTER TABLE "PropositionDoublonOrganisation" ADD CONSTRAINT "PropositionDoublonOrganisation_organisationAId_fkey"
    FOREIGN KEY ("organisationAId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PropositionDoublonOrganisation" ADD CONSTRAINT "PropositionDoublonOrganisation_organisationBId_fkey"
    FOREIGN KEY ("organisationBId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "doubleEcritureOrganisations" BOOLEAN NOT NULL DEFAULT false;
