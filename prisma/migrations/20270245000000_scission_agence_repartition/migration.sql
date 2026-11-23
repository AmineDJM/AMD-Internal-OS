-- LE POSTE NÉ D'UNE SCISSION PAR AGENCE REJOINT LE GROUPE DE SON POSTE D'ORIGINE (recette du 23/11/2026).
-- `retenirLignesDesAgences` créait le poste de la seconde agence sans recopier `repartitionId` : sur un sponsoring indirect, il
-- sortait du bloc « Sponsoring indirect », dont le sous-total l'oubliait (SPO-2026-021 : 1 389 000 DZD affichés au lieu de
-- 1 606 770). Le code le recopie désormais (`scission-agence.ts`) ; ceci rattache les postes déjà scindés.
-- Un poste scindé se reconnaît à la note que la scission lui écrit (« Né de la scission du poste « <libellé d'origine> » : … ») :
-- il rejoint le poste d'origine du même parent et de la même nature, et seulement quand un seul poste répond à ce libellé.
-- Données seules, idempotente : ne touche que les postes encore sans groupe.
UPDATE "AdProItem" AS s
SET "repartitionId" = o."repartitionId"
FROM "AdProItem" AS o
WHERE s."repartitionId" IS NULL
  AND s."notes" LIKE 'Né de la scission du poste « %'
  AND o."id" <> s."id"
  AND o."repartitionId" IS NOT NULL
  AND o."kind" = s."kind"
  AND COALESCE(o."sponsoringId", o."congressNationalId", o."congressInternationalId", o."eventId", o."otherRequestId", o."trainingId")
    = COALESCE(s."sponsoringId", s."congressNationalId", s."congressInternationalId", s."eventId", s."otherRequestId", s."trainingId")
  AND position(('Né de la scission du poste « ' || o."label" || ' » : ') IN s."notes") = 1
  AND NOT EXISTS (
    SELECT 1 FROM "AdProItem" AS autre
    WHERE autre."id" NOT IN (o."id", s."id")
      AND autre."kind" = o."kind"
      AND autre."label" = o."label"
      AND COALESCE(autre."sponsoringId", autre."congressNationalId", autre."congressInternationalId", autre."eventId", autre."otherRequestId", autre."trainingId")
        = COALESCE(o."sponsoringId", o."congressNationalId", o."congressInternationalId", o."eventId", o."otherRequestId", o."trainingId")
  );
