-- PHARMACOVIGILANCE — LA DÉCLARATION À L'AUTORITÉ ET SON DÉLAI (Super Admin, audit des manques du 24/11/2026).
-- Un cas allait de « Reçu » à « Clos » sans déclaration ni délai. Le circuit devient :
--   Reçu → Évalué (grave / non grave, attendu / inattendu, imputabilité) → Déclaré à l'autorité (date, référence,
--   accusé, pièce) → Suivi (informations complémentaires) → Clos.
-- Idempotente : chaque ordre se rejoue sans effet. Les nouvelles valeurs d'énumération ne sont PAS utilisées ici
-- (une valeur ajoutée ne se lit qu'après la validation de la transaction qui l'a créée).

-- 1. Les trois nouvelles étapes du circuit.
ALTER TYPE "PvCaseStatus" ADD VALUE IF NOT EXISTS 'EVALUE';
ALTER TYPE "PvCaseStatus" ADD VALUE IF NOT EXISTS 'DECLARE';
ALTER TYPE "PvCaseStatus" ADD VALUE IF NOT EXISTS 'SUIVI';

-- 2. LE JOUR ZÉRO du délai : la date à laquelle la société a eu connaissance du cas (la visite quand le cas en part,
--    sinon le signalement). Regulatory peut la corriger à l'évaluation.
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "dateConnaissance" TIMESTAMP(3);
UPDATE "PharmacovigilanceCase" c
   SET "dateConnaissance" = LEAST(c."createdAt", COALESCE((SELECT v."date" FROM "MedicalVisit" v WHERE v."id" = c."visitId"), c."createdAt"))
 WHERE c."dateConnaissance" IS NULL;
ALTER TABLE "PharmacovigilanceCase" ALTER COLUMN "dateConnaissance" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PharmacovigilanceCase" ALTER COLUMN "dateConnaissance" SET NOT NULL;

-- 3. LA CITATION DE L'IA, figée au signalement : le délégué peut corriger son compte rendu ensuite (la lecture de l'IA
--    sur la visite s'efface alors), le cas garde ce qui l'a fait naître.
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "citationIa" TEXT;
UPDATE "PharmacovigilanceCase" c
   SET "citationIa" = v."pvIaExtrait"
  FROM "MedicalVisit" v
 WHERE v."id" = c."visitId" AND c."citationIa" IS NULL AND v."pvIaExtrait" IS NOT NULL;

-- 4. L'ÉVALUATION de Regulatory.
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "evalGrave" BOOLEAN;
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "evalAttendu" BOOLEAN;
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "evalImputabilite" TEXT;
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "evalNote" TEXT;
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "evalueLe" TIMESTAMP(3);
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "evalueParId" TEXT;

-- 5. LA DÉCLARATION À L'AUTORITÉ, faite hors plateforme puis enregistrée : date d'envoi, référence, accusé de réception.
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "declareLe" TIMESTAMP(3);
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "declarationReference" TEXT;
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "declarationEnregistreeLe" TIMESTAMP(3);
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "declareParId" TEXT;
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "accuseLe" TIMESTAMP(3);
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "accuseReference" TEXT;

-- 6. LE VISA du pharmacien responsable désigné pour la société du cas.
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "visaPharmacienLe" TIMESTAMP(3);
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "visaPharmacienParId" TEXT;
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "visaPharmacienNote" TEXT;

-- 7. LES ALERTES D'ÉCHÉANCE : le dernier palier prévenu (J5, J2, J0, DEPASSE) — une alerte par palier, jamais par jour ;
--    et l'information du DG pour un cas grave, une seule fois.
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "alertePalier" TEXT;
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "alertePalierLe" TIMESTAMP(3);
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "dgInformeLe" TIMESTAMP(3);

-- 8. « EN ANALYSE » N'EST PLUS UNE ÉTAPE : ces cas n'ont pas encore d'évaluation, ils redeviennent « Reçu » (à évaluer).
--    Rien ne se perd : le passage s'écrit dans l'échange du cas (identifiant dérivé, rejouable sans doublon).
INSERT INTO "Comment" ("id", "entityType", "entityId", "body", "authorId", "createdAt")
SELECT 'pvmig_' || c."id", 'PHARMACOVIGILANCE_CASE', c."id",
       'Circuit de déclaration à l''autorité (24/11/2026) : l''étape « En analyse » devient « Reçu » — le cas attend son évaluation (gravité, caractère attendu, imputabilité).',
       NULL, CURRENT_TIMESTAMP
  FROM "PharmacovigilanceCase" c
 WHERE c."status" = 'EN_ANALYSE'
ON CONFLICT ("id") DO NOTHING;
UPDATE "PharmacovigilanceCase" SET "status" = 'RECU' WHERE "status" = 'EN_ANALYSE';

-- 9. LES RÉGLAGES (Super Admin) : les délais de déclaration — À CONFIRMER par le pharmacien responsable et la
--    réglementation algérienne en vigueur — et le pharmacien responsable désigné par société ({ companyId: userId }).
CREATE TABLE IF NOT EXISTS "PvReglage" (
    "id"                      TEXT NOT NULL DEFAULT 'global',
    "delaiGraveJours"         INTEGER NOT NULL DEFAULT 15,
    "delaiNonGraveJours"      INTEGER NOT NULL DEFAULT 90,
    "pharmaciensResponsables" JSONB,
    "updatedById"             TEXT,
    "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PvReglage_pkey" PRIMARY KEY ("id")
);
