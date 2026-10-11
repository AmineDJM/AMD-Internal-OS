-- FICHES VOYAGEUR DES PRISES EN CHARGE (Direction, 10/2026) — voir src/lib/care-fiches.ts.
--
-- Idempotente et additive : types créés s'ils manquent, colonnes « IF NOT EXISTS », contraintes dans
-- des blocs DO. Rien n'est deviné sur l'existant :
--   • une demande d'avant reste en mode INDIVIDUEL (le seul qui existait) ;
--   • ses montants restent en DZD (devise par défaut) : `amountDzd` est inchangé, `amount` reste vide ;
--   • le taux USD → DZD n'est posé que sur les prises en charge INTERNATIONALES (240, le taux de la
--     Direction) — il ne s'applique qu'aux montants saisis en dollars, qu'aucune demande d'avant ne porte ;
--   • les médecins d'origine d'une « initiative du médecin » d'avant restent des personnes proposées
--     (on ne sait pas, après coup, qui était l'origine et qui était pris en charge).

DO $$ BEGIN
  CREATE TYPE "CareMode" AS ENUM ('INDIVIDUAL', 'GROUP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CareCurrency" AS ENUM ('DZD', 'USD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- La demande : mode, taux figé, médecins d'origine, sujet de l'assistante de direction.
ALTER TABLE "CongressInternational" ADD COLUMN IF NOT EXISTS "careMode" "CareMode" NOT NULL DEFAULT 'INDIVIDUAL';
ALTER TABLE "CongressInternational" ADD COLUMN IF NOT EXISTS "usdDzdRate" DECIMAL(10,4);
ALTER TABLE "CongressInternational" ADD COLUMN IF NOT EXISTS "initiativeDoctorIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CongressInternational" ADD COLUMN IF NOT EXISTS "careReservationDossierId" TEXT;
ALTER TABLE "CongressNational" ADD COLUMN IF NOT EXISTS "careMode" "CareMode" NOT NULL DEFAULT 'INDIVIDUAL';
ALTER TABLE "CongressNational" ADD COLUMN IF NOT EXISTS "usdDzdRate" DECIMAL(10,4);
ALTER TABLE "CongressNational" ADD COLUMN IF NOT EXISTS "initiativeDoctorIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CongressNational" ADD COLUMN IF NOT EXISTS "careReservationDossierId" TEXT;

UPDATE "CongressInternational" SET "usdDzdRate" = 240 WHERE "usdDzdRate" IS NULL;

-- Le poste d'une fiche : dates, trajet, hôtel, montant saisi et sa devise.
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "dateStart" TIMESTAMP(3);
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "dateEnd" TIMESTAMP(3);
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "trajet" "AdProTrajet";
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "transport" "AdProTransport";
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "fromCity" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "toCity" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "segments" JSONB;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "hotelName" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "roomType" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "amount" DECIMAL(14,2);
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "currency" "CareCurrency" NOT NULL DEFAULT 'DZD';

-- Le billet émis / la confirmation d'hôtel, et le détail horaire — ce que lira le livret de séjour.
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "issuedDocumentId" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "bookingRef" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "legDetails" JSONB;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "timeStart" TEXT;
ALTER TABLE "CareCell" ADD COLUMN IF NOT EXISTS "address" TEXT;

-- Le devis : montant saisi et devise, catégorie, proposition retenue, BC demandé.
ALTER TABLE "CareQuote" ADD COLUMN IF NOT EXISTS "amount" DECIMAL(14,2);
ALTER TABLE "CareQuote" ADD COLUMN IF NOT EXISTS "currency" "CareCurrency" NOT NULL DEFAULT 'DZD';
ALTER TABLE "CareQuote" ADD COLUMN IF NOT EXISTS "serviceKind" "CareServiceKind";
ALTER TABLE "CareQuote" ADD COLUMN IF NOT EXISTS "retainedAt" TIMESTAMP(3);
ALTER TABLE "CareQuote" ADD COLUMN IF NOT EXISTS "retainedById" TEXT;
ALTER TABLE "CareQuote" ADD COLUMN IF NOT EXISTS "bcRequestedAt" TIMESTAMP(3);
ALTER TABLE "CareQuote" ADD COLUMN IF NOT EXISTS "bcRequestedById" TEXT;

-- Le poste de groupe : un coût par personne, appliqué à chacun sauf les exclus.
CREATE TABLE IF NOT EXISTS "CareGroupPoste" (
  "id"                      TEXT NOT NULL,
  "congressNationalId"      TEXT,
  "congressInternationalId" TEXT,
  "serviceKind"             "CareServiceKind" NOT NULL,
  "label"                   TEXT NOT NULL,
  "notes"                   TEXT,
  "date"                    TIMESTAMP(3),
  "timeStart"               TEXT,
  "address"                 TEXT,
  "unitAmount"              DECIMAL(14,2),
  "currency"                "CareCurrency" NOT NULL DEFAULT 'DZD',
  "unitAmountDzd"           DECIMAL(14,2),
  "excludedBeneficiaryIds"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"                  "CareCellStatus" NOT NULL DEFAULT 'REQUESTED',
  "position"                INTEGER NOT NULL DEFAULT 0,
  "createdById"             TEXT,
  "updatedById"             TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CareGroupPoste_pkey" PRIMARY KEY ("id")
);

-- (Une base où la table existait déjà sans ces deux colonnes les reçoit ici.)
ALTER TABLE "CareGroupPoste" ADD COLUMN IF NOT EXISTS "timeStart" TEXT;
ALTER TABLE "CareGroupPoste" ADD COLUMN IF NOT EXISTS "address" TEXT;

CREATE INDEX IF NOT EXISTS "CareGroupPoste_congressNationalId_idx" ON "CareGroupPoste"("congressNationalId");
CREATE INDEX IF NOT EXISTS "CareGroupPoste_congressInternationalId_idx" ON "CareGroupPoste"("congressInternationalId");

DO $$ BEGIN
  ALTER TABLE "CareGroupPoste" ADD CONSTRAINT "CareGroupPoste_congressNationalId_fkey"
    FOREIGN KEY ("congressNationalId") REFERENCES "CongressNational"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CareGroupPoste" ADD CONSTRAINT "CareGroupPoste_congressInternationalId_fkey"
    FOREIGN KEY ("congressInternationalId") REFERENCES "CongressInternational"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Exactement un parent, comme les personnes et les devis.
DO $$ BEGIN
  ALTER TABLE "CareGroupPoste" ADD CONSTRAINT "CareGroupPoste_one_parent"
    CHECK (("congressNationalId" IS NOT NULL)::int + ("congressInternationalId" IS NOT NULL)::int = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
