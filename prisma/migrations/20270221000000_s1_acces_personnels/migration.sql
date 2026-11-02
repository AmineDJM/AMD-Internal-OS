-- S1 (décision 0048) — un assistant par employé, des accès dérivés du contrat et des avenants. Additive et idempotente.
-- 1. Tutoiement / vouvoiement, préférence de la personne.
ALTER TABLE "AssistantIaPreference" ADD COLUMN IF NOT EXISTS "adresse" TEXT;

-- 2. Les avenants structurés au contrat de travail.
CREATE TABLE IF NOT EXISTS "AvenantContrat" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "objet" TEXT NOT NULL,
  "fonction" TEXT,
  "famille" TEXT,
  "companyId" TEXT,
  "effetLe" TIMESTAMP(3) NOT NULL,
  "finLe" TIMESTAMP(3),
  "motif" TEXT NOT NULL,
  "documentId" TEXT,
  "creeParId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoqueLe" TIMESTAMP(3),
  CONSTRAINT "AvenantContrat_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AvenantContrat_employeeId_idx" ON "AvenantContrat"("employeeId");
DO $$ BEGIN
  ALTER TABLE "AvenantContrat" ADD CONSTRAINT "AvenantContrat_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Les droits explicites et datés de la console, par personne.
CREATE TABLE IF NOT EXISTS "AssistantIaDroitDate" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "famille" TEXT NOT NULL,
  "companyId" TEXT,
  "du" TIMESTAMP(3) NOT NULL,
  "au" TIMESTAMP(3),
  "motif" TEXT NOT NULL,
  "accordeParId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoqueLe" TIMESTAMP(3),
  CONSTRAINT "AssistantIaDroitDate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaDroitDate_userId_idx" ON "AssistantIaDroitDate"("userId");

-- 4. Reprise : une ouverture NOMINATIVE déjà décidée par la Direction (paie, dossier RH) devient un droit daté d'aujourd'hui,
--    sans fin, motif dit — la Direction le voit, le borne ou le révoque dans la console. Une ouverture de RÔLE n'est pas
--    reprise : elle n'ouvre plus les valeurs d'autrui (02/11).
INSERT INTO "AssistantIaDroitDate" ("id", "userId", "famille", "companyId", "du", "au", "motif", "accordeParId")
SELECT 's1rep_' || md5(a."userId" || f.famille), a."userId", f.famille, NULL, CURRENT_TIMESTAMP, NULL,
       'Reprise S1 (décision 0048) de l''ouverture nominative de console existante', a."updatedById"
  FROM "AssistantIaAcces" a
  CROSS JOIN (VALUES ('SALAIRES'), ('CONTRATS_RH')) AS f(famille)
 WHERE a."userId" IS NOT NULL AND f.famille = ANY(a."ouvertes")
   AND NOT EXISTS (SELECT 1 FROM "AssistantIaDroitDate" d WHERE d."id" = 's1rep_' || md5(a."userId" || f.famille));
