-- Migration : 20270130120000_assistant_ia_fil
-- Assistant IA — la conversation GARDÉE (un fil par personne), jouée en arrière-plan, message après message.
-- Idempotente : rejouable sans erreur sur une base qui l'a déjà reçue. Additive : aucune table existante touchée.

CREATE TABLE IF NOT EXISTS "AssistantIaFil" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "consulteLe" TIMESTAMP(3),
    "depuisLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "traitementLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantIaFil_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AssistantIaTour" (
    "id" TEXT NOT NULL,
    "filId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "contenu" TEXT NOT NULL DEFAULT '',
    "etat" TEXT NOT NULL,
    "pieces" JSONB,
    "blocs" JSONB,
    "intent" JSONB,
    "memoireProposee" JSONB,
    "outils" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "etapes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "repondA" TEXT,
    "erreur" TEXT,
    "ms" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantIaTour_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AssistantIaFil_userId_key" ON "AssistantIaFil"("userId");
CREATE INDEX IF NOT EXISTS "AssistantIaTour_filId_createdAt_idx" ON "AssistantIaTour"("filId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantIaTour_etat_createdAt_idx" ON "AssistantIaTour"("etat", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantIaTour_userId_idx" ON "AssistantIaTour"("userId");

DO $$ BEGIN
    ALTER TABLE "AssistantIaFil" ADD CONSTRAINT "AssistantIaFil_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AssistantIaTour" ADD CONSTRAINT "AssistantIaTour_filId_fkey"
        FOREIGN KEY ("filId") REFERENCES "AssistantIaFil"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
