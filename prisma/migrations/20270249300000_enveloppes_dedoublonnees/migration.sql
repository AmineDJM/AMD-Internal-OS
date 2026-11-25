-- LES ENVELOPPES BUDGETAIRES DEDOUBLONNEES, SANS RIEN PERDRE (Super Admin, 25/11/2026).
--
-- Releve de production (25/11) : « Administration » (Adventum, creee a la main le 10/08, module NULL) et « Administration
-- 2026 » (ouverte d'office par les charges fixes, une par societe) ; « Operations & Sales 2026 » d'Adventum (30 M DZD) et
-- la meme sans societe (0 DZD) ; l'ancienne enveloppe « Moyens generaux » du groupe, restee alors que les moyens generaux
-- passent par societe dans l'Administration (migration 20270249000000_charges_fixes_administration).
--
-- Trois regles, dans cet ordre :
--   1. ADMINISTRATION — par (societe, annee), quand il y en a plusieurs : on garde l'enveloppe creee a la main (module
--      NULL, la plus ancienne : c'est elle qui porte peut-etre des references), on y rapatrie les lignes des autres en
--      fusionnant par cle de ligne (meme `cle`, ou meme nom, au meme niveau et pour la meme BU -> une seule ligne, montants
--      additionnes ; sinon la ligne est deplacee), on repointe TOUT ce qui designe les lignes ou l'enveloppe, puis on
--      aligne ses champs (module ADMINISTRATION, nom « Administration <annee> », gestionnaires Finances).
--   2. LA REGLE DU DOUBLON — une enveloppe SANS societe qui a le meme nom, le meme domaine et la meme annee qu'UNE SEULE
--      enveloppe de societe : si rien ne la designe (aucune depense, engagement, consommation, lot, proposition), ses
--      lignes vides disparaissent avec elle apres repointage par cle ; sinon elle est fusionnee (rien n'est perdu). Aucune
--      autre societe n'est devinee.
--   3. MOYENS GENERAUX — l'ancienne enveloppe du groupe (marquee par la migration des charges fixes) : ce qui designe
--      encore ses lignes passe sur la sous-ligne correspondante de « Moyens generaux » dans l'Administration de la societe
--      de la depense ou de l'element (a defaut Adventum) ; ses montants alloues et son total passent a Adventum ; elle est
--      retiree. Si une Administration manque, elle reste et un NOTICE le dit.
--
-- DEFENSIVE ET REJOUABLE : chaque regle ne fait rien quand l'etat ne correspond pas (deja dedoublonne, conflit sur une
-- proposition ou un lot d'integration -> NOTICE et rien n'est touche pour ce couple). Tout tient dans UN bloc DO (une
-- transaction). Chaque fusion laisse une ligne au journal d'audit (module Budgets) et un NOTICE.

-- ── LES COLONNES QUI DESIGNENT UNE LIGNE BUDGETAIRE ─────────────────────────────────────────────────────────────────
-- Lues dans le schema (toute colonne `budgetCategoryId` / `categoryLineId`, plus les deux `categoryId` budgetaires) :
-- une table ajoutee demain est repointee sans que personne y pense.
CREATE OR REPLACE FUNCTION pg_temp.amd_refs_lignes() RETURNS TABLE (t TEXT, c TEXT) LANGUAGE sql AS $f$
  SELECT table_name::TEXT, column_name::TEXT FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND (column_name IN ('budgetCategoryId', 'categoryLineId')
         OR (table_name IN ('BudgetExpenseLine', 'ImputationCoutIa') AND column_name = 'categoryId'))
$f$;

-- Repointe une ligne vers une autre, partout (colonnes + instantanes JSON des propositions budgetaires).
CREATE OR REPLACE FUNCTION pg_temp.amd_repointer_ligne(p_de TEXT, p_vers TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM pg_temp.amd_refs_lignes() LOOP
    EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = $2', r.t, r.c, r.c) USING p_vers, p_de;
  END LOOP;
  UPDATE "BudgetProposalVersion" SET "lines" = replace("lines"::TEXT, p_de, p_vers)::JSONB WHERE strpos("lines"::TEXT, p_de) > 0;
END $f$;

-- Une ligne est-elle designee par quoi que ce soit ?
CREATE OR REPLACE FUNCTION pg_temp.amd_ligne_designee(p_id TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $f$
DECLARE r RECORD; n INT;
BEGIN
  FOR r IN SELECT * FROM pg_temp.amd_refs_lignes() LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', r.t, r.c) INTO n USING p_id;
    IF n > 0 THEN RETURN TRUE; END IF;
  END LOOP;
  RETURN EXISTS (SELECT 1 FROM "BudgetProposalVersion" WHERE strpos("lines"::TEXT, p_id) > 0);
END $f$;

-- Ce qui designe l'enveloppe elle-meme passe sur la cible.
CREATE OR REPLACE FUNCTION pg_temp.amd_repointer_enveloppe(p_de TEXT, p_vers TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  UPDATE "AdProIntegrationLot" SET "envelopeId" = p_vers WHERE "envelopeId" = p_de;
  UPDATE "BudgetProposal" SET "envelopeId" = p_vers WHERE "envelopeId" = p_de;
  UPDATE "SignalDate" SET "budgetEnvelopeId" = p_vers WHERE "budgetEnvelopeId" = p_de;
  UPDATE "AdProRapprochement" SET "enveloppeSuggeree" = p_vers WHERE "enveloppeSuggeree" = p_de;
END $f$;

-- Deux liens uniques ne se fusionnent pas : une proposition par enveloppe, un lot d'integration actif par enveloppe.
CREATE OR REPLACE FUNCTION pg_temp.amd_conflit(p_source TEXT, p_cible TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM "BudgetProposal" WHERE "envelopeId" = p_source) AND EXISTS (SELECT 1 FROM "BudgetProposal" WHERE "envelopeId" = p_cible) THEN
    RETURN 'les deux enveloppes sont liees chacune a une proposition de la campagne budgetaire';
  END IF;
  IF EXISTS (SELECT 1 FROM "AdProIntegrationLot" WHERE "envelopeId" = p_source AND "annuleLe" IS NULL)
     AND EXISTS (SELECT 1 FROM "AdProIntegrationLot" WHERE "envelopeId" = p_cible AND "annuleLe" IS NULL) THEN
    RETURN 'les deux enveloppes portent chacune un lot d''integration Ad & Pro actif';
  END IF;
  RETURN NULL;
END $f$;

CREATE OR REPLACE FUNCTION pg_temp.amd_journal(p_entite TEXT, p_resume TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO "AuditLog" ("id", "action", "module", "entityType", "entityId", "summary", "createdAt")
  VALUES ('dedup' || md5(random()::TEXT || clock_timestamp()::TEXT || p_entite), 'UPDATE', 'Budgets', 'BUDGET', p_entite, p_resume, CURRENT_TIMESTAMP);
  RAISE NOTICE '%', p_resume;
END $f$;

-- ── FUSIONNER UNE ENVELOPPE DANS UNE AUTRE ───────────────────────────────────────────────────────────────────────────
-- Parents d'abord : une ligne qui a son pareil dans la cible (meme niveau, meme BU, meme cle ou meme nom) s'y fond
-- (montant additionne, references repointees) ; sinon elle est deplacee — ou, si `p_deplacer` est faux, supprimee
-- quand rien ne la designe et qu'elle ne porte aucun montant. Rend le resume, ou NULL si la fusion est refusee.
CREATE OR REPLACE FUNCTION pg_temp.amd_fusionner(p_source TEXT, p_cible TEXT, p_deplacer BOOLEAN) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE
  l RECORD;
  s RECORD;
  parent_cible TEXT;
  pareil TEXT;
  conflit TEXT;
  fondues INT := 0;
  deplacees INT := 0;
  retirees INT := 0;
BEGIN
  conflit := pg_temp.amd_conflit(p_source, p_cible);
  IF conflit IS NOT NULL THEN
    RAISE NOTICE 'Enveloppe % non fusionnee dans % : %', p_source, p_cible, conflit;
    RETURN NULL;
  END IF;
  SELECT * INTO s FROM "BudgetEnvelope" WHERE "id" = p_source;
  CREATE TEMP TABLE IF NOT EXISTS amd_carte (source TEXT PRIMARY KEY, cible TEXT, sort TEXT);
  TRUNCATE amd_carte;

  FOR l IN
    WITH RECURSIVE arbre AS (
      SELECT c."id", c."name", c."cle", c."parentId", c."businessUnitId", c."allocated", c."createdAt", 0 AS profondeur
        FROM "BudgetCategoryLine" c WHERE c."envelopeId" = p_source AND c."parentId" IS NULL
      UNION ALL
      SELECT c."id", c."name", c."cle", c."parentId", c."businessUnitId", c."allocated", c."createdAt", a.profondeur + 1
        FROM "BudgetCategoryLine" c JOIN arbre a ON c."parentId" = a."id"
    )
    SELECT * FROM arbre ORDER BY profondeur, "createdAt", "id"
  LOOP
    parent_cible := NULL;
    IF l."parentId" IS NOT NULL THEN SELECT cible INTO parent_cible FROM amd_carte WHERE source = l."parentId"; END IF;
    pareil := NULL;
    SELECT x."id" INTO pareil FROM "BudgetCategoryLine" x
      WHERE x."envelopeId" = p_cible AND x."parentId" IS NOT DISTINCT FROM parent_cible
        AND x."businessUnitId" IS NOT DISTINCT FROM l."businessUnitId"
        AND ((l."cle" IS NOT NULL AND x."cle" = l."cle") OR lower(btrim(x."name")) = lower(btrim(l."name")))
      ORDER BY (x."cle" IS NOT DISTINCT FROM l."cle") DESC, x."createdAt", x."id" LIMIT 1;
    IF pareil IS NOT NULL THEN
      UPDATE "BudgetCategoryLine" SET "allocated" = "allocated" + l."allocated", "cle" = COALESCE("cle", l."cle"), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = pareil;
      PERFORM pg_temp.amd_repointer_ligne(l."id", pareil);
      INSERT INTO amd_carte VALUES (l."id", pareil, 'FONDUE');
      fondues := fondues + 1;
    ELSIF p_deplacer OR l."allocated" <> 0 OR pg_temp.amd_ligne_designee(l."id")
          OR EXISTS (SELECT 1 FROM "BudgetCategoryLine" e WHERE e."parentId" = l."id") THEN
      UPDATE "BudgetCategoryLine" SET "envelopeId" = p_cible, "parentId" = parent_cible, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = l."id";
      INSERT INTO amd_carte VALUES (l."id", l."id", 'DEPLACEE');
      deplacees := deplacees + 1;
    ELSE
      INSERT INTO amd_carte VALUES (l."id", NULL, 'RETIREE');
      retirees := retirees + 1;
    END IF;
  END LOOP;

  -- Une ligne hors arbre (parent dans une autre enveloppe : ne devrait pas exister) suit l'enveloppe, telle quelle.
  UPDATE "BudgetCategoryLine" SET "envelopeId" = p_cible WHERE "envelopeId" = p_source AND "id" NOT IN (SELECT source FROM amd_carte);
  -- Les enfants d'une ligne fondue ont deja ete places (fondus ou deplaces sous son pareil) : elle part seule.
  DELETE FROM "BudgetCategoryLine" WHERE "id" IN (SELECT source FROM amd_carte WHERE sort IN ('FONDUE', 'RETIREE'));

  PERFORM pg_temp.amd_repointer_enveloppe(p_source, p_cible);
  UPDATE "BudgetEnvelope" t SET
      "totalAmount" = t."totalAmount" + s."totalAmount",
      "modules" = ARRAY(SELECT DISTINCT unnest(t."modules" || s."modules")),
      "accessRoles" = ARRAY(SELECT DISTINCT unnest(t."accessRoles" || s."accessRoles")),
      "accessUserIds" = ARRAY(SELECT DISTINCT unnest(t."accessUserIds" || s."accessUserIds")),
      "managerRoles" = ARRAY(SELECT DISTINCT unnest(t."managerRoles" || s."managerRoles")),
      "managerUserIds" = ARRAY(SELECT DISTINCT unnest(t."managerUserIds" || s."managerUserIds")),
      "isActive" = t."isActive" OR s."isActive",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE t."id" = p_cible;
  DELETE FROM "BudgetEnvelope" WHERE "id" = p_source;
  RETURN format('« %s » (%s) fondue dans l''enveloppe %s : %s ligne(s) fondue(s), %s deplacee(s), %s ligne(s) vide(s) retiree(s), %s DZD reportes',
    s."name", p_source, p_cible, fondues, deplacees, retirees, s."totalAmount");
END $f$;

-- La sous-ligne de « Moyens generaux » de l'Administration d'une societe pour une annee, reconnue par la cle (ou le nom)
-- de l'ancienne categorie — creee si elle manque (comme l'avait fait la migration des charges fixes). NULL : pas
-- d'Administration ou pas de ligne « Moyens generaux » pour cette societe.
CREATE OR REPLACE FUNCTION pg_temp.amd_sous_ligne_mg(p_societe TEXT, p_annee INT, p_nom TEXT, p_cle TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE env TEXT; mg TEXT; fille TEXT;
BEGIN
  SELECT "id" INTO env FROM "BudgetEnvelope"
    WHERE "companyId" = p_societe AND "module" = 'ADMINISTRATION' AND EXTRACT(YEAR FROM "periodStart")::INT = p_annee
    ORDER BY "isActive" DESC, "createdAt" LIMIT 1;
  IF env IS NULL THEN RETURN NULL; END IF;
  SELECT "id" INTO mg FROM "BudgetCategoryLine" WHERE "envelopeId" = env AND "parentId" IS NULL AND "cle" = 'MOYENS_GENERAUX' LIMIT 1;
  IF mg IS NULL THEN RETURN NULL; END IF;
  SELECT "id" INTO fille FROM "BudgetCategoryLine"
    WHERE "parentId" = mg AND ((p_cle IS NOT NULL AND "cle" = p_cle) OR lower(btrim("name")) = lower(btrim(p_nom)))
    ORDER BY ("cle" IS NOT DISTINCT FROM p_cle) DESC, "createdAt" LIMIT 1;
  IF fille IS NULL THEN
    fille := 'dmg' || md5(random()::TEXT || clock_timestamp()::TEXT || mg || p_nom);
    INSERT INTO "BudgetCategoryLine" ("id", "envelopeId", "parentId", "name", "module", "cle", "allocated", "createdAt", "updatedAt")
    VALUES (fille, env, mg, p_nom, 'GENERAL_MEANS', p_cle, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  END IF;
  RETURN fille;
END $f$;

DO $$
DECLARE
  adventum TEXT;
  g RECORD;
  e RECORD;
  m RECORD;
  t RECORD;
  r RECORD;
  soc RECORD;
  gardee TEXT;
  cible TEXT;
  resume TEXT;
  designe BOOLEAN;
  annee INT;
  arbre TEXT[];
  dest TEXT;
  dest_adv TEXT;
  env_adv TEXT;
  mg_adv TEXT;
  manque BOOLEAN;
BEGIN
  -- Adventum : par son identifiant, a defaut par son nom (meme regle que 20270113090000_finance_rattache_adventum).
  SELECT c."id" INTO adventum FROM "Company" c
    WHERE c."id" = 'company_adventum' OR c."name" ILIKE 'adventum%'
    ORDER BY (c."id" = 'company_adventum') DESC, c."sortOrder", c."createdAt" LIMIT 1;

  -- ── 1. ADMINISTRATION : une enveloppe par (societe, annee) ──────────────────────────────────────────────────────
  FOR g IN
    SELECT "companyId" AS societe, EXTRACT(YEAR FROM "periodStart")::INT AS an
      FROM "BudgetEnvelope"
      WHERE "companyId" IS NOT NULL AND "domaine" = 'GENERAL'
        AND ("module" = 'ADMINISTRATION' OR ("module" IS NULL AND lower(btrim("name")) ~ '^administration( [0-9]{4})?$'))
      GROUP BY 1, 2 HAVING count(*) > 1
  LOOP
    -- L'enveloppe creee a la main (module NULL) d'abord, la plus ancienne : c'est elle qui porte peut-etre des references.
    SELECT "id" INTO gardee FROM "BudgetEnvelope"
      WHERE "companyId" = g.societe AND EXTRACT(YEAR FROM "periodStart")::INT = g.an AND "domaine" = 'GENERAL'
        AND ("module" = 'ADMINISTRATION' OR ("module" IS NULL AND lower(btrim("name")) ~ '^administration( [0-9]{4})?$'))
      ORDER BY ("module" IS NULL) DESC, "createdAt", "id" LIMIT 1;
    FOR e IN
      SELECT "id" FROM "BudgetEnvelope"
        WHERE "companyId" = g.societe AND EXTRACT(YEAR FROM "periodStart")::INT = g.an AND "domaine" = 'GENERAL' AND "id" <> gardee
          AND ("module" = 'ADMINISTRATION' OR ("module" IS NULL AND lower(btrim("name")) ~ '^administration( [0-9]{4})?$'))
        ORDER BY "createdAt", "id"
    LOOP
      resume := pg_temp.amd_fusionner(e."id", gardee, TRUE);
      IF resume IS NOT NULL THEN PERFORM pg_temp.amd_journal(gardee, 'Dedoublonnage (Administration) — ' || resume); END IF;
    END LOOP;
    -- Alignee : c'est l'enveloppe de l'Administration, reconnue par son code, tenue par les Finances.
    UPDATE "BudgetEnvelope" SET
        "module" = 'ADMINISTRATION',
        "name" = 'Administration ' || g.an,
        "managerRoles" = ARRAY(SELECT DISTINCT unnest("managerRoles" || ARRAY['FINANCE_BUDGET_MANAGER']::TEXT[])),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = gardee AND ("module" IS DISTINCT FROM 'ADMINISTRATION' OR "name" <> 'Administration ' || g.an OR NOT ('FINANCE_BUDGET_MANAGER' = ANY("managerRoles")));
  END LOOP;

  -- ── 2. LA REGLE DU DOUBLON : une enveloppe sans societe, jumelle d'UNE seule enveloppe de societe ─────────────────
  FOR e IN
    SELECT n."id", n."name", n."domaine", EXTRACT(YEAR FROM n."periodStart")::INT AS an
      FROM "BudgetEnvelope" n WHERE n."companyId" IS NULL
      ORDER BY n."createdAt", n."id"
  LOOP
    IF (SELECT count(*) FROM "BudgetEnvelope" x
          WHERE x."companyId" IS NOT NULL AND x."domaine" = e."domaine" AND EXTRACT(YEAR FROM x."periodStart")::INT = e.an
            AND lower(btrim(x."name")) = lower(btrim(e."name"))) <> 1 THEN
      CONTINUE;
    END IF;
    SELECT x."id" INTO cible FROM "BudgetEnvelope" x
      WHERE x."companyId" IS NOT NULL AND x."domaine" = e."domaine" AND EXTRACT(YEAR FROM x."periodStart")::INT = e.an
        AND lower(btrim(x."name")) = lower(btrim(e."name"));
    -- Porte-t-elle une depense, un engagement, une consommation, un lot, une proposition ?
    designe := EXISTS (SELECT 1 FROM "AdProIntegrationLot" WHERE "envelopeId" = e."id")
            OR EXISTS (SELECT 1 FROM "BudgetProposal" WHERE "envelopeId" = e."id");
    IF NOT designe THEN
      FOR t IN SELECT "id" FROM "BudgetCategoryLine" WHERE "envelopeId" = e."id" LOOP
        IF pg_temp.amd_ligne_designee(t."id") THEN designe := TRUE; EXIT; END IF;
      END LOOP;
    END IF;
    resume := pg_temp.amd_fusionner(e."id", cible, designe);
    IF resume IS NOT NULL THEN
      PERFORM pg_temp.amd_journal(cible, CASE WHEN designe THEN 'Dedoublonnage (doublon sans societe, fusionne) — ' ELSE 'Dedoublonnage (doublon sans societe et sans depense, retire) — ' END || resume);
    END IF;
  END LOOP;

  -- ── 3. L'ANCIENNE ENVELOPPE « MOYENS GENERAUX » DU GROUPE ─────────────────────────────────────────────────────────
  FOR m IN
    SELECT * FROM "BudgetEnvelope"
      WHERE "companyId" IS NULL AND "module" IS NULL AND lower("name") LIKE 'moyens g%n%raux%'
        AND coalesce("notes", '') LIKE '%passes par societe dans le budget de l''Administration%'
      ORDER BY "createdAt"
  LOOP
    annee := EXTRACT(YEAR FROM m."periodStart")::INT;
    IF adventum IS NULL THEN
      RAISE NOTICE 'Moyens generaux (%) laissee : Adventum introuvable.', m."id";
      CONTINUE;
    END IF;
    SELECT "id" INTO env_adv FROM "BudgetEnvelope"
      WHERE "companyId" = adventum AND "module" = 'ADMINISTRATION' AND EXTRACT(YEAR FROM "periodStart")::INT = annee
      ORDER BY "isActive" DESC, "createdAt" LIMIT 1;
    mg_adv := NULL;
    IF env_adv IS NOT NULL THEN
      SELECT "id" INTO mg_adv FROM "BudgetCategoryLine" WHERE "envelopeId" = env_adv AND "parentId" IS NULL AND "cle" = 'MOYENS_GENERAUX' LIMIT 1;
    END IF;
    IF mg_adv IS NULL OR pg_temp.amd_conflit(m."id", env_adv) IS NOT NULL THEN
      RAISE NOTICE 'Moyens generaux (%) laissee : pas d''Administration % d''Adventum avec sa ligne « Moyens generaux », ou un lien unique en conflit.', m."id", annee;
      CONTINUE;
    END IF;

    FOR t IN SELECT * FROM "BudgetCategoryLine" WHERE "envelopeId" = m."id" AND "parentId" IS NULL ORDER BY "createdAt", "id" LOOP
      -- La categorie et toute sa descendance vont sur la MEME sous-ligne (regle de la migration des charges fixes).
      WITH RECURSIVE d AS (
        SELECT "id" FROM "BudgetCategoryLine" WHERE "id" = t."id"
        UNION ALL SELECT c."id" FROM "BudgetCategoryLine" c JOIN d ON c."parentId" = d."id"
      ) SELECT array_agg("id") INTO arbre FROM d;
      dest_adv := pg_temp.amd_sous_ligne_mg(adventum, annee, t."name", t."cle");

      -- La societe de chaque depense / element, quand la table la dit ; sinon Adventum.
      FOR soc IN SELECT "id" FROM "Company" WHERE "id" <> adventum LOOP
        dest := pg_temp.amd_sous_ligne_mg(soc."id", annee, t."name", t."cle");
        CONTINUE WHEN dest IS NULL;
        FOR r IN SELECT * FROM pg_temp.amd_refs_lignes() LOOP
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = r.t AND column_name = 'companyId') THEN
            EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = ANY($2) AND "companyId" = $3', r.t, r.c, r.c) USING dest, arbre, soc."id";
          ELSIF r.t = 'DepartmentBudgetExpense' THEN
            UPDATE "DepartmentBudgetExpense" x SET "budgetCategoryId" = dest FROM "Department" dp
              WHERE x."departmentId" = dp."id" AND dp."companyId" = soc."id" AND x."budgetCategoryId" = ANY(arbre);
          ELSIF r.t = 'DepartmentExpenseLine' THEN
            UPDATE "DepartmentExpenseLine" x SET "budgetCategoryId" = dest FROM "DepartmentBudgetExpense" de, "Department" dp
              WHERE x."expenseId" = de."id" AND de."departmentId" = dp."id" AND dp."companyId" = soc."id" AND x."budgetCategoryId" = ANY(arbre);
          END IF;
        END LOOP;
      END LOOP;
      -- Le reste (Adventum, sans societe, ou une table qui ne dit pas de societe) : Adventum.
      FOR r IN SELECT * FROM pg_temp.amd_refs_lignes() LOOP
        EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = ANY($2)', r.t, r.c, r.c) USING dest_adv, arbre;
      END LOOP;
      FOR i IN 1 .. coalesce(array_length(arbre, 1), 0) LOOP
        UPDATE "BudgetProposalVersion" SET "lines" = replace("lines"::TEXT, arbre[i], dest_adv)::JSONB WHERE strpos("lines"::TEXT, arbre[i]) > 0;
      END LOOP;
      -- Le montant alloue de l'ancienne categorie passe a Adventum : sur la sous-ligne, et sur « Moyens generaux ».
      UPDATE "BudgetCategoryLine" SET "allocated" = "allocated" + t."allocated", "updatedAt" = CURRENT_TIMESTAMP WHERE "id" IN (dest_adv, mg_adv);
    END LOOP;

    PERFORM pg_temp.amd_repointer_enveloppe(m."id", env_adv);
    UPDATE "BudgetEnvelope" SET "totalAmount" = "totalAmount" + m."totalAmount", "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = env_adv;
    -- Plus rien ne designe ses lignes : elle part avec elles.
    manque := FALSE;
    FOR t IN SELECT "id" FROM "BudgetCategoryLine" WHERE "envelopeId" = m."id" LOOP
      IF pg_temp.amd_ligne_designee(t."id") THEN manque := TRUE; EXIT; END IF;
    END LOOP;
    IF manque THEN
      RAISE EXCEPTION 'Moyens generaux (%) : une ligne est encore designee apres repointage — migration annulee, rien n''est change.', m."id";
    END IF;
    DELETE FROM "BudgetEnvelope" WHERE "id" = m."id";
    PERFORM pg_temp.amd_journal(env_adv, format('Dedoublonnage (Moyens generaux) — l''ancienne enveloppe du groupe « %s » (%s) est retiree : ses references passent par societe sur « Moyens generaux » de l''Administration %s, ses montants (%s DZD) a Adventum.', m."name", m."id", annee, m."totalAmount"));
  END LOOP;
END $$;

DROP TABLE IF EXISTS amd_carte;
