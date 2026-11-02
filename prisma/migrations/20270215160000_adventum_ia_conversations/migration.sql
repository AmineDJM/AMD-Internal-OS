-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- ADVENTUM IA (décision 0027, 30/10/2026) — PLUSIEURS CONVERSATIONS PAR PERSONNE, DOSSIERS.
--
-- La contrainte « un fil unique par personne » (index unique sur "AssistantIaFil"."userId") est levée : le fil
-- existant de chacun DEVIENT sa première conversation — aucune ligne n'est déplacée ni supprimée, ses tours, son
-- résumé roulant et ses réglages restent où ils sont. Il reçoit un titre et la date de son dernier message.
--
-- ADDITIVE ET IDEMPOTENTE : colonnes nullables ou à défaut, une table neuve, des index « IF NOT EXISTS ». Rejouée,
-- elle ne change rien (le titre et la date ne sont posés que là où ils manquent).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- 1. L'unicité levée (index unique créé par Prisma) ; un index ordinaire la remplace pour les lectures par personne.
DROP INDEX IF EXISTS "AssistantIaFil_userId_key";
ALTER TABLE "AssistantIaFil" DROP CONSTRAINT IF EXISTS "AssistantIaFil_userId_key";

-- 2. Les colonnes d'une conversation.
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "titre"       TEXT;
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "titreSource" TEXT;
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "epingleLe"   TIMESTAMP(3);
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "archiveLe"   TIMESTAMP(3);
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "prive"       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "dossierId"   TEXT;
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "dernierLe"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 3. Les dossiers.
CREATE TABLE IF NOT EXISTS "AssistantIaDossier" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "nom"       TEXT NOT NULL,
    "consignes" TEXT NOT NULL DEFAULT '',
    "documents" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssistantIaDossier_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaDossier_userId_idx" ON "AssistantIaDossier"("userId");
DO $$ BEGIN
  ALTER TABLE "AssistantIaDossier" ADD CONSTRAINT "AssistantIaDossier_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AssistantIaFil" ADD CONSTRAINT "AssistantIaFil_dossierId_fkey"
    FOREIGN KEY ("dossierId") REFERENCES "AssistantIaDossier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "AssistantIaFil_userId_dernierLe_idx" ON "AssistantIaFil"("userId", "dernierLe");
CREATE INDEX IF NOT EXISTS "AssistantIaFil_prive_createdAt_idx" ON "AssistantIaFil"("prive", "createdAt");

-- 4. LE FIL EXISTANT DEVIENT LA PREMIÈRE CONVERSATION : la date de son dernier message, et un titre lisible.
UPDATE "AssistantIaFil" f
   SET "dernierLe" = COALESCE((SELECT max(t."createdAt") FROM "AssistantIaTour" t WHERE t."filId" = f."id"), f."updatedAt")
 WHERE f."titre" IS NULL;
UPDATE "AssistantIaFil"
   SET "titre" = 'Ma conversation', "titreSource" = 'provisoire'
 WHERE "titre" IS NULL
   AND EXISTS (SELECT 1 FROM "AssistantIaTour" t WHERE t."filId" = "AssistantIaFil"."id");
