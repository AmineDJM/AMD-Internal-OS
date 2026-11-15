-- LE PARCOURS AGENCE D'UN POSTE AD & PRO ET LA SIGNATURE EN LIGNE DES BC (Direction, 15/11/2026).
-- Prospection d'agences → choix → BC signé et cacheté (Direction Marketing puis Finances) → exécution → conformité →
-- réception → facture. Le bloc principal d'un sponsoring se nomme. Additive et idempotente.

DO $$ BEGIN
  CREATE TYPE "AdProVoiePoste" AS ENUM ('AGENCE', 'DIRECT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "principal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "voie" "AdProVoiePoste";
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "conformiteRequise" BOOLEAN NOT NULL DEFAULT false;

-- Le bloc principal des sponsorings existants : le poste né avec la demande (position 1, dans l'enveloppe).
UPDATE "AdProItem" i SET "principal" = true
WHERE i."sponsoringId" IS NOT NULL AND i."position" = 1 AND i."budgetKind" = 'INCLUDED' AND i."principal" = false
  AND NOT EXISTS (SELECT 1 FROM "AdProItem" j WHERE j."sponsoringId" = i."sponsoringId" AND j."principal" = true);

CREATE TABLE IF NOT EXISTS "AdProExecutionPoste" (
  "id" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "prospectionDemandeeAt" TIMESTAMP(3),
  "prospectionDemandeeParId" TEXT,
  "cahierDesCharges" TEXT,
  "assistanteId" TEXT,
  "devisTransmisAt" TIMESTAMP(3),
  "devisTransmisParId" TEXT,
  "agenceDevisId" TEXT,
  "agenceRetenueAt" TIMESTAMP(3),
  "agenceRetenueParId" TEXT,
  "bcSoumisAt" TIMESTAMP(3),
  "bcSoumisParId" TEXT,
  "bcEnvoyeAt" TIMESTAMP(3),
  "bcEnvoyeParId" TEXT,
  "conformiteStatut" TEXT,
  "conformiteDemandeeAt" TIMESTAMP(3),
  "conformiteDemandeeParId" TEXT,
  "conformiteDecideeAt" TIMESTAMP(3),
  "conformiteParId" TEXT,
  "conformiteNote" TEXT,
  "receptionAt" TIMESTAMP(3),
  "receptionParId" TEXT,
  "receptionNote" TEXT,
  "receptionReserve" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdProExecutionPoste_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdProExecutionPoste_itemId_key" ON "AdProExecutionPoste"("itemId");
CREATE INDEX IF NOT EXISTS "AdProExecutionPoste_assistanteId_idx" ON "AdProExecutionPoste"("assistanteId");
CREATE INDEX IF NOT EXISTS "AdProExecutionPoste_conformiteStatut_idx" ON "AdProExecutionPoste"("conformiteStatut");
DO $$ BEGIN
  ALTER TABLE "AdProExecutionPoste" ADD CONSTRAINT "AdProExecutionPoste_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "AdProItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "SignatureBC" (
  "id" TEXT NOT NULL,
  "legalDocumentId" TEXT NOT NULL,
  "qualite" TEXT NOT NULL,
  "userId" TEXT,
  "signataireNom" TEXT NOT NULL,
  "signataireTitre" TEXT,
  "methode" TEXT NOT NULL,
  "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "empreinte" TEXT,
  "documentId" TEXT,
  "jeton" TEXT NOT NULL,
  "ip" TEXT,
  "agent" TEXT,
  CONSTRAINT "SignatureBC_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureBC_jeton_key" ON "SignatureBC"("jeton");
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureBC_legalDocumentId_qualite_key" ON "SignatureBC"("legalDocumentId", "qualite");
CREATE INDEX IF NOT EXISTS "SignatureBC_userId_idx" ON "SignatureBC"("userId");

CREATE TABLE IF NOT EXISTS "SignatureVisuelle" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "nature" TEXT NOT NULL,
  "fichierCle" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoqueeLe" TIMESTAMP(3),
  CONSTRAINT "SignatureVisuelle_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SignatureVisuelle_userId_nature_idx" ON "SignatureVisuelle"("userId", "nature");

CREATE TABLE IF NOT EXISTS "SecondFacteur" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "secretChiffre" TEXT NOT NULL,
  "activeLe" TIMESTAMP(3),
  "dernierPas" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SecondFacteur_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SecondFacteur_userId_key" ON "SecondFacteur"("userId");
