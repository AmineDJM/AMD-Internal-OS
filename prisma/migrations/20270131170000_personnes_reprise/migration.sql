-- Migration : 20270131170000_personnes_reprise
-- Refonte des données, vague 2, lot V2-B « Personnes » (`docs/architecture/refonte-vague-2.md`).
--   1. L'INTERRUPTEUR de la double écriture des Personnes (`AppSetting.refontePersonnesDoubleEcriture`) :
--      éteint par défaut — le Super Admin l'allume depuis Administration › Refonte des données, et l'éteint
--      pour revenir en arrière sans déploiement.
--   2. Les DOUBLONS PROPOSÉS entre deux Personnes (`DoublonPersonne`) : le système propose, une personne
--      tranche (fusionner, tracé par `Personne.fusionneeDansId`, ou écarter). Une paire n'est proposée
--      qu'une fois (clé unique, A < B) ; une paire écartée ne revient pas.
-- ADDITIVE : une colonne avec défaut, une table vide. Rien n'est supprimé ni réécrit.
-- Idempotente : `IF NOT EXISTS`, `duplicate_object`.

ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "refontePersonnesDoubleEcriture" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "DoublonPersonne" (
    "id" TEXT NOT NULL,
    "personneAId" TEXT NOT NULL,
    "personneBId" TEXT NOT NULL,
    "niveau" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "raisons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reserves" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "statut" TEXT NOT NULL DEFAULT 'PROPOSE',
    "gardeeId" TEXT,
    "deplacees" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decideParId" TEXT,
    "decideLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoublonPersonne_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DoublonPersonne_personneAId_personneBId_key" ON "DoublonPersonne"("personneAId", "personneBId");
CREATE INDEX IF NOT EXISTS "DoublonPersonne_statut_niveau_idx" ON "DoublonPersonne"("statut", "niveau");
CREATE INDEX IF NOT EXISTS "DoublonPersonne_personneBId_idx" ON "DoublonPersonne"("personneBId");

DO $$ BEGIN
  ALTER TABLE "DoublonPersonne" ADD CONSTRAINT "DoublonPersonne_personneAId_fkey" FOREIGN KEY ("personneAId") REFERENCES "Personne"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DoublonPersonne" ADD CONSTRAINT "DoublonPersonne_personneBId_fkey" FOREIGN KEY ("personneBId") REFERENCES "Personne"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- Une paire se lit dans un seul sens (A < B) : la même paire ne peut pas être proposée deux fois à l'envers.
DO $$ BEGIN
  ALTER TABLE "DoublonPersonne" ADD CONSTRAINT "DoublonPersonne_ordre_check" CHECK ("personneAId" < "personneBId");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DoublonPersonne" ADD CONSTRAINT "DoublonPersonne_statut_check" CHECK ("statut" IN ('PROPOSE', 'FUSIONNE', 'ECARTE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
