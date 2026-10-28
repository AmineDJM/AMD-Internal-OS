-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- PALIER P5 — EFFACER LE CLAIR DES COLONNES COPIÉES AU COFFRE.
--
-- ⚠️  RÉDIGÉE, NON APPLIQUÉE. Ce fichier vit dans `docs/`, PAS dans `prisma/migrations/` : `migrate deploy`
--     ne le voit pas. Il ne s'applique qu'avec l'ACCORD EXPLICITE ET ÉCRIT DE LA DIRECTION, en suivant la
--     procédure de `docs/architecture/refonte-v2e-coffre.md` §7 (le code doit d'abord lire la copie quand la
--     colonne est vide — étape P5-1 — sinon les écrans afficheraient des fiches vides).
--
-- Pour l'appliquer : copier ce fichier en `prisma/migrations/<horodatage > au plus récent>_coffre_p5_effacer_clair/
-- migration.sql`, dans le même commit que l'étape P5-1, puis déployer.
--
-- Ce que fait la migration :
--   1. VÉRIFIE, colonne par colonne, que chaque valeur en clair non vide a une copie COURANTE au coffre ; s'il en
--      manque une seule, elle S'ARRÊTE (RAISE EXCEPTION) et rien n'est effacé — rejouer la reprise « coffre »,
--      corriger les valeurs mal formées qu'elle liste, puis recommencer ;
--   2. VIDE (NULL) les colonnes RIB / IBAN / NIN. Les colonnes ne sont PAS supprimées (retrait = palier P6) ;
--   3. NE TOUCHE PAS aux salaires : ils nourrissent les calculs (masse salariale, budget, simulations) qui lisent
--      les colonnes ; les effacer exige d'abord de faire passer ces calculs par le coffre (décision n° 3 du rapport).
--
-- Idempotente : rejouée, les colonnes sont déjà vides, la vérification passe, rien ne change.
-- Irréversible SANS la clé : la seule source restante est le coffre, déchiffrable par `COFFRE_KEY`. Sauvegarder la
-- base ET la clé (séparément) avant d'appliquer.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  manquants INTEGER;
  detail TEXT := '';
BEGIN
  SELECT count(*) INTO manquants FROM "Employee" e
   WHERE e."iban" IS NOT NULL AND btrim(e."iban") <> ''
     AND NOT EXISTS (SELECT 1 FROM "DonneeSensible" d WHERE d."origineModele" = 'Employee' AND d."origineId" = e."id" AND d."origineChamp" = 'iban' AND d."remplaceeLe" IS NULL);
  IF manquants > 0 THEN detail := detail || format(' Employee.iban : %s ;', manquants); END IF;

  SELECT count(*) INTO manquants FROM "Employee" e
   WHERE e."nationalId" IS NOT NULL AND btrim(e."nationalId") <> ''
     AND NOT EXISTS (SELECT 1 FROM "DonneeSensible" d WHERE d."origineModele" = 'Employee' AND d."origineId" = e."id" AND d."origineChamp" = 'nationalId' AND d."remplaceeLe" IS NULL);
  IF manquants > 0 THEN detail := detail || format(' Employee.nationalId : %s ;', manquants); END IF;

  SELECT count(*) INTO manquants FROM "CompanyContact" c
   WHERE c."rib" IS NOT NULL AND btrim(c."rib") <> ''
     AND NOT EXISTS (SELECT 1 FROM "DonneeSensible" d WHERE d."origineModele" = 'CompanyContact' AND d."origineId" = c."id" AND d."origineChamp" = 'rib' AND d."remplaceeLe" IS NULL);
  IF manquants > 0 THEN detail := detail || format(' CompanyContact.rib : %s ;', manquants); END IF;

  SELECT count(*) INTO manquants FROM "CompanyLegalIdentity" l
   WHERE l."rib" IS NOT NULL AND btrim(l."rib") <> ''
     AND NOT EXISTS (SELECT 1 FROM "DonneeSensible" d WHERE d."origineModele" = 'CompanyLegalIdentity' AND d."origineId" = l."id" AND d."origineChamp" = 'rib' AND d."remplaceeLe" IS NULL);
  IF manquants > 0 THEN detail := detail || format(' CompanyLegalIdentity.rib : %s ;', manquants); END IF;

  SELECT count(*) INTO manquants FROM "CompanyLegalIdentity" l
   WHERE l."iban" IS NOT NULL AND btrim(l."iban") <> ''
     AND NOT EXISTS (SELECT 1 FROM "DonneeSensible" d WHERE d."origineModele" = 'CompanyLegalIdentity' AND d."origineId" = l."id" AND d."origineChamp" = 'iban' AND d."remplaceeLe" IS NULL);
  IF manquants > 0 THEN detail := detail || format(' CompanyLegalIdentity.iban : %s ;', manquants); END IF;

  IF detail <> '' THEN
    RAISE EXCEPTION 'P5 refusé : des valeurs en clair n''ont pas de copie courante au coffre —%  Rejouer la reprise « coffre » (Administration › Refonte des données) et corriger les valeurs qu''elle signale.', detail;
  END IF;
END $$;

UPDATE "Employee"             SET "iban" = NULL       WHERE "iban" IS NOT NULL;
UPDATE "Employee"             SET "nationalId" = NULL WHERE "nationalId" IS NOT NULL;
UPDATE "CompanyContact"       SET "rib" = NULL        WHERE "rib" IS NOT NULL;
UPDATE "CompanyLegalIdentity" SET "rib" = NULL        WHERE "rib" IS NOT NULL;
UPDATE "CompanyLegalIdentity" SET "iban" = NULL       WHERE "iban" IS NOT NULL;
