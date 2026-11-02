-- LA RÉSERVATION PAR FICHE, SEULE (Direction, 27/10) — voir src/lib/reservation-fiche/etat.ts.
--
-- Deux mécanismes coexistaient : l'ANCIEN ENVOI EN BLOC (un sujet unique chez l'assistante qui listait tous les
-- voyageurs d'un poste de billetterie, ou toutes les fiches d'une prise en charge) et la RÉSERVATION PAR FICHE
-- (`DemandeReservation`, un état par billet ou hôtel). La Direction garde la fiche : les gestes de l'envoi en bloc
-- n'écrivent plus rien (`demanderReservation`, `retirerReservation`, `demanderReservationPriseEnCharge`).
--
-- Cette migration REPREND en fiches les envois en bloc faits APRÈS la première reprise (20270122090000), là où
-- la base PROUVE l'envoi — rien n'est deviné :
--   • Ad & Pro : le sujet porte le titre que SEUL l'envoi en bloc écrivait (« Réservation billets — … ») ; un
--     voyageur n'est repris que s'il existait au dernier envoi (création du sujet, ou dernier message « Demande
--     de réservation mise à jour. ») ;
--   • prise en charge : le journal d'audit porte « Réservation demandée pour … » sur la demande ; une fiche
--     (billet / hôtel non « sans objet » d'une personne proposée ou accordée) n'est reprise que si elle existait
--     à cet envoi. Billet émis déjà déposé, ou sujet abouti : RESERVEE ; sinon ENVOYEE.
-- Un sujet ARCHIVÉ (demande retirée) n'est pas repris. L'EMPREINTE reste NULLE (on ne sait pas ce que la fiche
-- disait à l'envoi) : la détection « modifiée après l'envoi » commence au prochain renvoi.
--
-- Idempotente et ADDITIVE : uniquement des INSERT « ON CONFLICT DO NOTHING » (une fiche porte au plus une demande,
-- index uniques) ; aucune colonne, table ni ligne supprimée ou modifiée. Ce qui n'a pas de correspondance sûre
-- (un sujet en bloc sans voyageur, un envoi en bloc sans trace d'audit) reste en lecture seule, sur son sujet.

-- ── Ad & Pro : les voyageurs des postes de billetterie envoyés en bloc ──
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
WHERE d."title" LIKE 'Réservation billets — %'
  AND d."status" IN ('OPEN', 'IN_PROGRESS', 'ON_HOLD', 'DONE')
  AND COALESCE(d."createdById", i."createdById") IS NOT NULL
  AND COALESCE(i."sponsoringId", i."congressNationalId", i."congressInternationalId", i."eventId") IS NOT NULL
  AND v."createdAt" <= GREATEST(d."createdAt", COALESCE((
    SELECT MAX(m."createdAt") FROM "DossierMessage" m
    WHERE m."dossierId" = d."id" AND m."body" LIKE 'Demande de réservation mise à jour.%'
  ), d."createdAt"))
ON CONFLICT DO NOTHING;

-- ── Prise en charge nationale : les fiches envoyées en bloc ──
INSERT INTO "DemandeReservation" (
  "id", "nature", "careCellId", "careBeneficiaryId", "operationType", "operationId", "companyId", "dossierId",
  "etat", "demandeurId", "envoyeeLe", "premierEnvoiLe", "reserveeLe", "pieceIds", "createdAt", "updatedAt"
)
SELECT
  'reprise_' || c."id",
  (CASE WHEN c."serviceKind" = 'TICKET' THEN 'BILLET' ELSE 'HOTEL' END)::"NatureFicheReservation",
  c."id", b."id", 'CONGRESS_NATIONAL'::"EntityType", r."id", r."companyId", d."id",
  (CASE WHEN c."issuedDocumentId" IS NOT NULL OR d."status" = 'DONE' THEN 'RESERVEE' ELSE 'ENVOYEE' END)::"EtatDemandeReservation",
  COALESCE(a."actorId", d."createdById", r."requesterId"),
  a."createdAt", a."createdAt",
  CASE WHEN c."issuedDocumentId" IS NOT NULL OR d."status" = 'DONE' THEN d."updatedAt" END,
  CASE WHEN c."issuedDocumentId" IS NOT NULL THEN ARRAY[c."issuedDocumentId"] ELSE ARRAY[]::TEXT[] END,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "CareCell" c
JOIN "CareBeneficiary" b ON b."id" = c."beneficiaryId"
JOIN "CongressNational" r ON r."id" = b."congressNationalId"
JOIN "Dossier" d ON d."id" = r."careReservationDossierId"
JOIN LATERAL (
  SELECT x."actorId", x."createdAt" FROM "AuditLog" x
  WHERE x."entityType" = 'CONGRESS_NATIONAL' AND x."entityId" = r."id"
    AND x."summary" LIKE 'Réservation demandée pour %' AND x."createdAt" >= c."createdAt"
  ORDER BY x."createdAt" ASC LIMIT 1
) a ON TRUE
WHERE c."kind" = 'SERVICE' AND c."serviceKind" IN ('TICKET', 'HOTEL') AND c."status" <> 'WAIVED'
  AND b."status" IN ('PROPOSED', 'APPROVED')
  AND d."status" IN ('OPEN', 'IN_PROGRESS', 'ON_HOLD', 'DONE')
  AND COALESCE(a."actorId", d."createdById", r."requesterId") IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── Prise en charge internationale : les fiches envoyées en bloc ──
INSERT INTO "DemandeReservation" (
  "id", "nature", "careCellId", "careBeneficiaryId", "operationType", "operationId", "companyId", "dossierId",
  "etat", "demandeurId", "envoyeeLe", "premierEnvoiLe", "reserveeLe", "pieceIds", "createdAt", "updatedAt"
)
SELECT
  'reprise_' || c."id",
  (CASE WHEN c."serviceKind" = 'TICKET' THEN 'BILLET' ELSE 'HOTEL' END)::"NatureFicheReservation",
  c."id", b."id", 'CONGRESS_INTERNATIONAL'::"EntityType", r."id", r."companyId", d."id",
  (CASE WHEN c."issuedDocumentId" IS NOT NULL OR d."status" = 'DONE' THEN 'RESERVEE' ELSE 'ENVOYEE' END)::"EtatDemandeReservation",
  COALESCE(a."actorId", d."createdById", r."requesterId"),
  a."createdAt", a."createdAt",
  CASE WHEN c."issuedDocumentId" IS NOT NULL OR d."status" = 'DONE' THEN d."updatedAt" END,
  CASE WHEN c."issuedDocumentId" IS NOT NULL THEN ARRAY[c."issuedDocumentId"] ELSE ARRAY[]::TEXT[] END,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "CareCell" c
JOIN "CareBeneficiary" b ON b."id" = c."beneficiaryId"
JOIN "CongressInternational" r ON r."id" = b."congressInternationalId"
JOIN "Dossier" d ON d."id" = r."careReservationDossierId"
JOIN LATERAL (
  SELECT x."actorId", x."createdAt" FROM "AuditLog" x
  WHERE x."entityType" = 'CONGRESS_INTERNATIONAL' AND x."entityId" = r."id"
    AND x."summary" LIKE 'Réservation demandée pour %' AND x."createdAt" >= c."createdAt"
  ORDER BY x."createdAt" ASC LIMIT 1
) a ON TRUE
WHERE c."kind" = 'SERVICE' AND c."serviceKind" IN ('TICKET', 'HOTEL') AND c."status" <> 'WAIVED'
  AND b."status" IN ('PROPOSED', 'APPROVED')
  AND d."status" IN ('OPEN', 'IN_PROGRESS', 'ON_HOLD', 'DONE')
  AND COALESCE(a."actorId", d."createdById", r."requesterId") IS NOT NULL
ON CONFLICT DO NOTHING;
