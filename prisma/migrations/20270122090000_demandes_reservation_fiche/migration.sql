-- FICHES DE VOYAGE CHEZ L'ASSISTANTE (Direction, 14/10/2026) — voir src/lib/reservation-fiche/etat.ts.
--
-- Une DEMANDE DE RÉSERVATION par fiche (billet ou hôtel) : voyageur d'un poste Ad & Pro, fiche hôtellerie,
-- ou poste billet / hôtel d'une prise en charge (`CareCell`). Idempotente et additive : types créés s'ils
-- manquent, table et index « IF NOT EXISTS », contraintes dans des blocs DO, reprise « ON CONFLICT DO NOTHING ».
--
-- REPRISE DES ENVOIS EN BLOC D'AVANT (rien n'est deviné au-delà de ce que la base dit) :
--   • un poste de billetterie dont le sujet de réservation est VIVANT : chacun de ses voyageurs est « chez
--     l'assistante » (ENVOYEE) depuis l'ouverture du sujet ; sujet ABOUTI : « réservée » ;
--   • une prise en charge dont le sujet de l'assistante est vivant : chaque billet / hôtel non « sans objet »
--     d'une personne proposée ou accordée est ENVOYEE ; un billet émis déjà déposé (ou un sujet abouti) : RESERVEE ;
--   • l'EMPREINTE reste NULLE : on ne sait pas ce que la fiche disait au moment de l'envoi en bloc — la
--     détection « modifiée après l'envoi » commence au prochain renvoi.

DO $$ BEGIN
  CREATE TYPE "EtatDemandeReservation" AS ENUM ('ENVOYEE', 'PRISE', 'DEVIS_RECU', 'RESERVEE', 'MANQUE_SIGNALE', 'MODIFIEE_APRES_ENVOI', 'RETIREE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "NatureFicheReservation" AS ENUM ('BILLET', 'HOTEL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "DemandeReservation" (
  "id" TEXT NOT NULL,
  "nature" "NatureFicheReservation" NOT NULL,
  "voyageurId" TEXT,
  "hebergementId" TEXT,
  "careCellId" TEXT,
  "itemId" TEXT,
  "careBeneficiaryId" TEXT,
  "operationType" "EntityType" NOT NULL,
  "operationId" TEXT NOT NULL,
  "companyId" TEXT,
  "dossierId" TEXT,
  "etat" "EtatDemandeReservation" NOT NULL DEFAULT 'ENVOYEE',
  "demandeurId" TEXT NOT NULL,
  "envoyeeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "premierEnvoiLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "envois" INTEGER NOT NULL DEFAULT 1,
  "empreinte" JSONB,
  "priseParId" TEXT,
  "priseLe" TIMESTAMP(3),
  "relances" INTEGER NOT NULL DEFAULT 0,
  "derniereRelanceLe" TIMESTAMP(3),
  "manqueMotif" TEXT,
  "manqueLe" TIMESTAMP(3),
  "manqueParId" TEXT,
  "modifieeLe" TIMESTAMP(3),
  "devisRecuLe" TIMESTAMP(3),
  "devisRef" TEXT,
  "reserveeLe" TIMESTAMP(3),
  "reserveeParId" TEXT,
  "referenceReservation" TEXT,
  "pieceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "retireeLe" TIMESTAMP(3),
  "retraitMotif" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DemandeReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DemandeReservation_voyageurId_key" ON "DemandeReservation"("voyageurId");
CREATE UNIQUE INDEX IF NOT EXISTS "DemandeReservation_hebergementId_key" ON "DemandeReservation"("hebergementId");
CREATE UNIQUE INDEX IF NOT EXISTS "DemandeReservation_careCellId_key" ON "DemandeReservation"("careCellId");
CREATE INDEX IF NOT EXISTS "DemandeReservation_etat_idx" ON "DemandeReservation"("etat");
CREATE INDEX IF NOT EXISTS "DemandeReservation_itemId_idx" ON "DemandeReservation"("itemId");
CREATE INDEX IF NOT EXISTS "DemandeReservation_operationType_operationId_idx" ON "DemandeReservation"("operationType", "operationId");
CREATE INDEX IF NOT EXISTS "DemandeReservation_priseParId_idx" ON "DemandeReservation"("priseParId");

DO $$ BEGIN
  ALTER TABLE "DemandeReservation" ADD CONSTRAINT "DemandeReservation_voyageurId_fkey"
    FOREIGN KEY ("voyageurId") REFERENCES "AdProVoyageur"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DemandeReservation" ADD CONSTRAINT "DemandeReservation_hebergementId_fkey"
    FOREIGN KEY ("hebergementId") REFERENCES "AdProHebergement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DemandeReservation" ADD CONSTRAINT "DemandeReservation_careCellId_fkey"
    FOREIGN KEY ("careCellId") REFERENCES "CareCell"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- EXACTEMENT UNE FICHE : une demande sans fiche serait une ligne de file que personne ne peut ouvrir ;
-- deux fiches, deux voyages sous un seul état.
DO $$ BEGIN
  ALTER TABLE "DemandeReservation" ADD CONSTRAINT "DemandeReservation_une_fiche"
    CHECK ((("voyageurId" IS NOT NULL)::int + ("hebergementId" IS NOT NULL)::int + ("careCellId" IS NOT NULL)::int) = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Reprise : les voyageurs des postes de billetterie déjà envoyés en bloc ──
INSERT INTO "DemandeReservation" (
  "id", "nature", "voyageurId", "itemId", "operationType", "operationId", "companyId", "dossierId",
  "etat", "demandeurId", "envoyeeLe", "premierEnvoiLe", "reserveeLe", "createdAt", "updatedAt"
)
SELECT
  'reprise_' || v."id", 'BILLET', v."id", i."id",
  (CASE
    WHEN i."sponsoringId" IS NOT NULL THEN 'SPONSORING'
    WHEN i."congressNationalId" IS NOT NULL THEN 'CONGRESS_NATIONAL'
    WHEN i."congressInternationalId" IS NOT NULL THEN 'CONGRESS_INTERNATIONAL'
    ELSE 'EVENT'
  END)::"EntityType",
  COALESCE(i."sponsoringId", i."congressNationalId", i."congressInternationalId", i."eventId"),
  d."companyId", d."id",
  (CASE WHEN d."status" = 'DONE' THEN 'RESERVEE' ELSE 'ENVOYEE' END)::"EtatDemandeReservation",
  COALESCE(d."createdById", i."createdById"),
  d."createdAt", d."createdAt",
  CASE WHEN d."status" = 'DONE' THEN d."updatedAt" END,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "AdProVoyageur" v
JOIN "AdProItem" i ON i."id" = v."itemId"
JOIN "Dossier" d ON d."id" = i."reservationDossierId"
WHERE d."status" IN ('OPEN', 'IN_PROGRESS', 'ON_HOLD', 'DONE')
  AND COALESCE(d."createdById", i."createdById") IS NOT NULL
  AND COALESCE(i."sponsoringId", i."congressNationalId", i."congressInternationalId", i."eventId") IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── Reprise : les billets et hôtels des prises en charge (national puis international) ──
INSERT INTO "DemandeReservation" (
  "id", "nature", "careCellId", "careBeneficiaryId", "operationType", "operationId", "companyId", "dossierId",
  "etat", "demandeurId", "envoyeeLe", "premierEnvoiLe", "reserveeLe", "pieceIds", "createdAt", "updatedAt"
)
SELECT
  'reprise_' || c."id",
  (CASE WHEN c."serviceKind" = 'TICKET' THEN 'BILLET' ELSE 'HOTEL' END)::"NatureFicheReservation",
  c."id", b."id", 'CONGRESS_NATIONAL'::"EntityType", r."id", r."companyId", d."id",
  (CASE WHEN c."issuedDocumentId" IS NOT NULL OR d."status" = 'DONE' THEN 'RESERVEE' ELSE 'ENVOYEE' END)::"EtatDemandeReservation",
  COALESCE(d."createdById", r."requesterId"),
  d."createdAt", d."createdAt",
  CASE WHEN c."issuedDocumentId" IS NOT NULL OR d."status" = 'DONE' THEN d."updatedAt" END,
  CASE WHEN c."issuedDocumentId" IS NOT NULL THEN ARRAY[c."issuedDocumentId"] ELSE ARRAY[]::TEXT[] END,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "CareCell" c
JOIN "CareBeneficiary" b ON b."id" = c."beneficiaryId"
JOIN "CongressNational" r ON r."id" = b."congressNationalId"
JOIN "Dossier" d ON d."id" = r."careReservationDossierId"
WHERE c."kind" = 'SERVICE' AND c."serviceKind" IN ('TICKET', 'HOTEL') AND c."status" <> 'WAIVED'
  AND b."status" IN ('PROPOSED', 'APPROVED')
  AND d."status" IN ('OPEN', 'IN_PROGRESS', 'ON_HOLD', 'DONE')
  AND COALESCE(d."createdById", r."requesterId") IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "DemandeReservation" (
  "id", "nature", "careCellId", "careBeneficiaryId", "operationType", "operationId", "companyId", "dossierId",
  "etat", "demandeurId", "envoyeeLe", "premierEnvoiLe", "reserveeLe", "pieceIds", "createdAt", "updatedAt"
)
SELECT
  'reprise_' || c."id",
  (CASE WHEN c."serviceKind" = 'TICKET' THEN 'BILLET' ELSE 'HOTEL' END)::"NatureFicheReservation",
  c."id", b."id", 'CONGRESS_INTERNATIONAL'::"EntityType", r."id", r."companyId", d."id",
  (CASE WHEN c."issuedDocumentId" IS NOT NULL OR d."status" = 'DONE' THEN 'RESERVEE' ELSE 'ENVOYEE' END)::"EtatDemandeReservation",
  COALESCE(d."createdById", r."requesterId"),
  d."createdAt", d."createdAt",
  CASE WHEN c."issuedDocumentId" IS NOT NULL OR d."status" = 'DONE' THEN d."updatedAt" END,
  CASE WHEN c."issuedDocumentId" IS NOT NULL THEN ARRAY[c."issuedDocumentId"] ELSE ARRAY[]::TEXT[] END,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "CareCell" c
JOIN "CareBeneficiary" b ON b."id" = c."beneficiaryId"
JOIN "CongressInternational" r ON r."id" = b."congressInternationalId"
JOIN "Dossier" d ON d."id" = r."careReservationDossierId"
WHERE c."kind" = 'SERVICE' AND c."serviceKind" IN ('TICKET', 'HOTEL') AND c."status" <> 'WAIVED'
  AND b."status" IN ('PROPOSED', 'APPROVED')
  AND d."status" IN ('OPEN', 'IN_PROGRESS', 'ON_HOLD', 'DONE')
  AND COALESCE(d."createdById", r."requesterId") IS NOT NULL
ON CONFLICT DO NOTHING;
