-- D2 (décision 0057) : l'accès par base — réglages datés par rôle ou par personne, paramètres par base. Additive, idempotente.
DO $$ BEGIN
  CREATE TYPE "NiveauAccesBase" AS ENUM ('LECTURE_SEULE', 'FERMEE', 'OUVERTE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AccesBase" (
  "id" TEXT NOT NULL,
  "base" TEXT NOT NULL,
  "userId" TEXT,
  "role" "UserRole",
  "niveau" "NiveauAccesBase" NOT NULL,
  "ecriture" BOOLEAN NOT NULL DEFAULT false,
  "du" TIMESTAMP(3) NOT NULL,
  "au" TIMESTAMP(3),
  "motif" TEXT NOT NULL,
  "accordeParId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoqueLe" TIMESTAMP(3),
  "revoqueParId" TEXT,
  CONSTRAINT "AccesBase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AccesBase_base_idx" ON "AccesBase"("base");
CREATE INDEX IF NOT EXISTS "AccesBase_userId_idx" ON "AccesBase"("userId");
CREATE INDEX IF NOT EXISTS "AccesBase_role_idx" ON "AccesBase"("role");
-- Exactement un titulaire : une personne OU un rôle.
DO $$ BEGIN
  ALTER TABLE "AccesBase" ADD CONSTRAINT "AccesBase_un_titulaire" CHECK (("userId" IS NULL) <> ("role" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AccesBaseParametre" (
  "base" TEXT NOT NULL,
  "propresDonnees" BOOLEAN NOT NULL,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccesBaseParametre_pkey" PRIMARY KEY ("base")
);
