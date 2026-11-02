-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Refonte des données, vague 2, lot V2-E — LE COFFRE EN DOUBLE LECTURE.
--
-- Les colonnes en clair (`Employee.iban`, `nationalId`, salaires, `CompanyContact.rib`,
-- `CompanyLegalIdentity.rib/iban`) sont COPIÉES au coffre ; elles RESTENT (les effacer = palier P5,
-- accord exprès de la Direction — procédure rédigée dans docs/architecture/refonte-v2e-coffre.md).
--
-- 1. `DonneeSensible` sait de quelle colonne elle est la copie (`origineModele`, `origineId`,
--    `origineChamp`) : c'est ce qui rend la reprise rejouable et la double écriture exacte. Le titulaire
--    (Personne / Organisation) devient FACULTATIF : il est posé quand la fiche du référentiel existe
--    (reprises V2-B / V2-C), et la reprise rejouée le rattache ensuite. Une donnée a toujours au moins
--    l'un des deux (contrainte `DonneeSensible_titulaire_ou_origine`).
-- 2. Une copie remplacée n'est pas effacée : `remplaceeLe` la date ; une seule copie COURANTE par
--    colonne d'origine (unicité partielle, inexprimable en Prisma — exception du contrôle de dérive).
-- 3. `cleId` : l'identifiant public de la clé maîtresse qui a chiffré (rotation, refus explicite).
-- 4. `AccesDonneeSensible` journalise aussi un REFUS (`autorise`), une lecture faite avant qu'une copie
--    existe (`donneeSensibleId` nul, origine renseignée), et le nom d'un modèle d'IA refusé (`lecteurNom`).
-- 5. Deux interrupteurs du Super Admin sur `AppSetting`, FERMÉS par défaut : `coffreEcriture` (double
--    écriture) et `coffreLecture` (double lecture).
--
-- Additive et idempotente : aucune colonne retirée, aucune donnée réécrite ; des NOT NULL relâchés.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "DonneeSensible" ADD COLUMN IF NOT EXISTS "origineModele" TEXT;
ALTER TABLE "DonneeSensible" ADD COLUMN IF NOT EXISTS "origineId" TEXT;
ALTER TABLE "DonneeSensible" ADD COLUMN IF NOT EXISTS "origineChamp" TEXT;
ALTER TABLE "DonneeSensible" ADD COLUMN IF NOT EXISTS "remplaceeLe" TIMESTAMP(3);
ALTER TABLE "DonneeSensible" ADD COLUMN IF NOT EXISTS "cleId" TEXT;
ALTER TABLE "DonneeSensible" ALTER COLUMN "titulaireType" DROP NOT NULL;
ALTER TABLE "DonneeSensible" ALTER COLUMN "titulaireId" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "DonneeSensible" ADD CONSTRAINT "DonneeSensible_titulaire_ou_origine"
    CHECK ("titulaireId" IS NOT NULL OR "origineId" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "DonneeSensible_origineModele_origineId_idx" ON "DonneeSensible"("origineModele", "origineId");
-- Une seule copie COURANTE par colonne d'origine : la reprise et la double écriture ne peuvent pas en créer deux.
CREATE UNIQUE INDEX IF NOT EXISTS "DonneeSensible_origine_courante_key"
  ON "DonneeSensible"("origineModele", "origineId", "origineChamp")
  WHERE "remplaceeLe" IS NULL AND "origineId" IS NOT NULL;

ALTER TABLE "AccesDonneeSensible" ADD COLUMN IF NOT EXISTS "origineModele" TEXT;
ALTER TABLE "AccesDonneeSensible" ADD COLUMN IF NOT EXISTS "origineId" TEXT;
ALTER TABLE "AccesDonneeSensible" ADD COLUMN IF NOT EXISTS "origineChamp" TEXT;
ALTER TABLE "AccesDonneeSensible" ADD COLUMN IF NOT EXISTS "autorise" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AccesDonneeSensible" ADD COLUMN IF NOT EXISTS "lecteurNom" TEXT;
ALTER TABLE "AccesDonneeSensible" ALTER COLUMN "titulaireType" DROP NOT NULL;
ALTER TABLE "AccesDonneeSensible" ALTER COLUMN "titulaireId" DROP NOT NULL;
ALTER TABLE "AccesDonneeSensible" ALTER COLUMN "userId" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "AccesDonneeSensible_createdAt_idx" ON "AccesDonneeSensible"("createdAt");
CREATE INDEX IF NOT EXISTS "AccesDonneeSensible_origineModele_origineId_idx" ON "AccesDonneeSensible"("origineModele", "origineId");

ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "coffreEcriture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "coffreLecture" BOOLEAN NOT NULL DEFAULT false;
