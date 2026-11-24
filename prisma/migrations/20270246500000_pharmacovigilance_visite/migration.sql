-- VISITE MÉDICALE — le signalement de pharmacovigilance rattaché à sa visite, la lecture du compte rendu par l'IA
-- (possible cas de pharmacovigilance, priorité pour le superviseur) et la RELECTURE du rapport par le superviseur.
-- Idempotente : chaque ordre se rejoue sans effet.

-- 1. Le cas de pharmacovigilance connaît la visite d'où il part (nul : signalé hors visite, ou cas d'avant).
ALTER TABLE "PharmacovigilanceCase" ADD COLUMN IF NOT EXISTS "visitId" TEXT;
CREATE INDEX IF NOT EXISTS "PharmacovigilanceCase_visitId_idx" ON "PharmacovigilanceCase"("visitId");
DO $$ BEGIN
  ALTER TABLE "PharmacovigilanceCase" ADD CONSTRAINT "PharmacovigilanceCase_visitId_fkey"
    FOREIGN KEY ("visitId") REFERENCES "MedicalVisit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Ce que l'IA a lu dans le compte rendu : AUCUN | POSSIBLE | PROBABLE, sa raison, la citation exacte, la priorité
--    (0-100) pour le superviseur, et quand. Nul : pas (encore) lu — l'IA coupée ne laisse rien derrière elle.
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "pvIa" TEXT;
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "pvIaRaison" TEXT;
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "pvIaExtrait" TEXT;
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "prioriteIa" INTEGER;
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "analyseIaLe" TIMESTAMP(3);

-- 3. La relecture du superviseur : quand, par qui, et son mot au délégué (facultatif).
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "reluLe" TIMESTAMP(3);
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "reluParId" TEXT;
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "reluCommentaire" TEXT;

-- 4. La bascule de la fonction (Administration › Contrôle de l'IA) — COUPÉE par défaut : chaque compte rendu lu est un
--    appel au fournisseur, et l'activer est une décision de la Direction.
ALTER TABLE "AiSetting" ADD COLUMN IF NOT EXISTS "visitePvDetectionEnabled" BOOLEAN NOT NULL DEFAULT false;
