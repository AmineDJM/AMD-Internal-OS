-- TOUS LES MODULES AFFICHES SE REGLENT DEPUIS LA CONSOLE (Super Admin, 24/11/2026 : « je peux donner ou revoquer l'acces a
-- TOUT module affiche, y compris Doublons de factures, Comptabilite, Banque & paiements, Finances »).
--
-- PRINCIPE : AU DEPLOIEMENT, PERSONNE NE GAGNE NI NE PERD UN ACCES. Les nouvelles cles ont, role par role, le defaut qui
-- reproduit la regle d'hier (src/lib/rbac/permissions.ts) ; cette migration ne recopie que ce que la CONSOLE avait regle a la
-- main (acces personnalises et blocages), et neutralise les reglages qui, une fois la cle devenue la seule regle, ouvriraient
-- ce qu'ils n'ouvraient pas hier. Ensuite, le Super Admin regle tout depuis la console.
--
-- Une seule exception, demandee en toutes lettres : un BLOCAGE deja pose sur un centre (paiement, Ad & Pro) prend enfin effet —
-- « un bloque ne doit plus voir ni decider » (le Super Admin excepte, au centre de paiement).
--
-- Aucune table ni colonne : `UserAccess.module` est une chaine. Idempotent : les insertions ne reecrivent jamais un acces deja
-- pose (ON CONFLICT DO NOTHING), les neutralisations ne touchent que des lignes encore ouvertes, les delegations ne s'ajoutent
-- qu'une fois.

-- ── 1. LES TROIS ECRANS DES FINANCES ─────────────────────────────────────────────────────────────────────────────────────
-- Banque & paiements, Comptabilite et Doublons de factures vivaient sous FINANCES. Chaque acces personnalise ou bloque pose sur
-- FINANCES est recopie, a l'identique (memes cases, meme portee, meme mode), sur les trois cles.
INSERT INTO "UserAccess" ("id", "userId", "module", "canView", "canCreate", "canUpdate", "canDelete", "canValidate", "canExport", "canUpload", "scope", "sections", "createdAt", "updatedAt")
SELECT 'mc_' || substr(md5(ua."id" || cle."module"), 1, 22), ua."userId", cle."module",
       ua."canView", ua."canCreate", ua."canUpdate", ua."canDelete", ua."canValidate", ua."canExport", ua."canUpload",
       ua."scope", '{}'::text[], NOW(), NOW()
FROM "UserAccess" ua
CROSS JOIN (VALUES ('FINANCES_BANQUE'), ('FINANCES_COMPTABILITE')) AS cle("module")
WHERE ua."module" = 'FINANCES'
ON CONFLICT ("userId", "module") DO NOTHING;

-- Doublons : « examiner » un groupe demandait FINANCES Modifier OU la vue globale (role principal Super Admin ou Direction).
-- La copie rend donc « Modifier » a la vue globale qui ne l'avait pas par son acces personnalise.
INSERT INTO "UserAccess" ("id", "userId", "module", "canView", "canCreate", "canUpdate", "canDelete", "canValidate", "canExport", "canUpload", "scope", "sections", "createdAt", "updatedAt")
SELECT 'mc_' || substr(md5(ua."id" || 'FINANCES_DOUBLONS'), 1, 22), ua."userId", 'FINANCES_DOUBLONS',
       ua."canView", ua."canCreate",
       (ua."canView" AND (ua."canUpdate" OR u."role"::text IN ('SUPER_ADMIN', 'DIRECTION'))),
       ua."canDelete", ua."canValidate", ua."canExport", ua."canUpload",
       ua."scope", '{}'::text[], NOW(), NOW()
FROM "UserAccess" ua
JOIN "User" u ON u."id" = ua."userId"
WHERE ua."module" = 'FINANCES'
ON CONFLICT ("userId", "module") DO NOTHING;

-- ── 2. LA PAIE ───────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Hier : l'entree et la page s'ouvraient a qui MODIFIAIT les RH. Defaut de PAIE = les roles qui modifient les RH par defaut
-- (Super Admin, Direction, Directeur General), role principal ou secondaire. Un acces personnalise ou bloque sur RH changeait
-- la reponse : on le reporte sur PAIE.
--   - RH personnalise AVEC Modifier, sans role (ni autre role) qui ouvre la paie : la paie lui reste ouverte ;
INSERT INTO "UserAccess" ("id", "userId", "module", "canView", "canCreate", "canUpdate", "canDelete", "canValidate", "canExport", "canUpload", "scope", "sections", "createdAt", "updatedAt")
SELECT 'mc_' || substr(md5(ua."id" || 'PAIE'), 1, 22), ua."userId", 'PAIE',
       TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 'ALL', '{}'::text[], NOW(), NOW()
FROM "UserAccess" ua
JOIN "User" u ON u."id" = ua."userId"
WHERE ua."module" = 'RH' AND ua."canView" AND ua."canUpdate"
  AND u."role"::text NOT IN ('SUPER_ADMIN', 'DIRECTION', 'GENERAL_MANAGER')
  AND COALESCE(u."secondaryRole"::text, '') NOT IN ('SUPER_ADMIN', 'DIRECTION', 'GENERAL_MANAGER')
ON CONFLICT ("userId", "module") DO NOTHING;
--   - RH bloque, ou personnalise SANS Modifier (et sans autre role qui le rendait), chez un role qui ouvre la paie par
--     defaut : la paie lui reste fermee.
INSERT INTO "UserAccess" ("id", "userId", "module", "canView", "canCreate", "canUpdate", "canDelete", "canValidate", "canExport", "canUpload", "scope", "sections", "createdAt", "updatedAt")
SELECT 'mc_' || substr(md5(ua."id" || 'PAIE'), 1, 22), ua."userId", 'PAIE',
       FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 'ASSIGNED', '{}'::text[], NOW(), NOW()
FROM "UserAccess" ua
JOIN "User" u ON u."id" = ua."userId"
WHERE ua."module" = 'RH'
  AND (u."role"::text IN ('SUPER_ADMIN', 'DIRECTION', 'GENERAL_MANAGER')
       OR COALESCE(u."secondaryRole"::text, '') IN ('SUPER_ADMIN', 'DIRECTION', 'GENERAL_MANAGER'))
  AND (
    NOT ua."canView"
    -- (un « autre role » identique au role principal n'ajoute rien : `accesAttribue` l'ignore)
    OR (NOT ua."canUpdate" AND (u."secondaryRole" IS NULL OR u."secondaryRole" = u."role"
        OR u."secondaryRole"::text NOT IN ('SUPER_ADMIN', 'DIRECTION', 'GENERAL_MANAGER')))
  )
ON CONFLICT ("userId", "module") DO NOTHING;

-- ── 3. LES DELEGATIONS D'INTERIM ─────────────────────────────────────────────────────────────────────────────────────────
-- Un absent qui deleguait les Finances deleguait leurs trois ecrans ; qui deleguait les RH deleguait la paie a qui les
-- modifiait. L'interim lit ce que l'absent DETIENT sur chaque cle (`delegationsFor`) : on ajoute les cles, rien de plus.
UPDATE "LeaveRequest"
SET "standInModules" = "standInModules" || ARRAY['FINANCES_BANQUE', 'FINANCES_COMPTABILITE', 'FINANCES_DOUBLONS']
WHERE 'FINANCES' = ANY("standInModules") AND NOT ('FINANCES_BANQUE' = ANY("standInModules"));

UPDATE "LeaveRequest"
SET "standInModules" = "standInModules" || ARRAY['PAIE']
WHERE 'RH' = ANY("standInModules") AND NOT ('PAIE' = ANY("standInModules"));

-- ── 4. LES CENTRES ET LE BUREAU D'ADAM : LA CLE DEVIENT LA SEULE REGLE ──────────────────────────────────────────────────
-- Hier, une liste de roles s'AJOUTAIT au module ; un acces coche dans la console n'ouvrait donc rien. La cle seule decide
-- desormais : un acces qui n'ouvrait rien hier deviendrait une ouverture. On le BLOQUE (le Super Admin le rouvre d'un
-- geste, en connaissance de cause), et l'on bloque de meme le module qu'un « autre role » donne sans qu'il ouvrait rien.

-- Centre de paiement : hier, y siegeaient les roles Direction / Directeur General / Super Admin (principal ou secondaire)
-- et les sieges nommes.
UPDATE "UserAccess" ua
SET "canView" = FALSE, "canCreate" = FALSE, "canUpdate" = FALSE, "canDelete" = FALSE, "canValidate" = FALSE,
    "canExport" = FALSE, "canUpload" = FALSE, "sections" = '{}'::text[], "updatedAt" = NOW()
FROM "User" u
WHERE u."id" = ua."userId" AND ua."module" = 'PAYMENT_CENTRE' AND ua."canView"
  AND u."role"::text NOT IN ('SUPER_ADMIN', 'DIRECTION', 'GENERAL_MANAGER')
  AND COALESCE(u."secondaryRole"::text, '') NOT IN ('SUPER_ADMIN', 'DIRECTION', 'GENERAL_MANAGER')
  AND NOT EXISTS (SELECT 1 FROM "PaymentCentreSeat" s WHERE s."userId" = ua."userId");

-- Centre de validation Ad & Pro : hier, le Directeur General et le Super Admin (principal ou secondaire).
UPDATE "UserAccess" ua
SET "canView" = FALSE, "canCreate" = FALSE, "canUpdate" = FALSE, "canDelete" = FALSE, "canValidate" = FALSE,
    "canExport" = FALSE, "canUpload" = FALSE, "sections" = '{}'::text[], "updatedAt" = NOW()
FROM "User" u
WHERE u."id" = ua."userId" AND ua."module" = 'AD_PRO_CENTRE' AND ua."canView"
  AND u."role"::text NOT IN ('SUPER_ADMIN', 'GENERAL_MANAGER')
  AND COALESCE(u."secondaryRole"::text, '') NOT IN ('SUPER_ADMIN', 'GENERAL_MANAGER');

-- Centre de validations : hier, le role PRINCIPAL Directeur General ou Super Admin (et le module).
UPDATE "UserAccess" ua
SET "canView" = FALSE, "canCreate" = FALSE, "canUpdate" = FALSE, "canDelete" = FALSE, "canValidate" = FALSE,
    "canExport" = FALSE, "canUpload" = FALSE, "sections" = '{}'::text[], "updatedAt" = NOW()
FROM "User" u
WHERE u."id" = ua."userId" AND ua."module" = 'VALIDATION_CENTRE' AND ua."canView"
  AND u."role"::text NOT IN ('SUPER_ADMIN', 'GENERAL_MANAGER');

INSERT INTO "UserAccess" ("id", "userId", "module", "canView", "canCreate", "canUpdate", "canDelete", "canValidate", "canExport", "canUpload", "scope", "sections", "createdAt", "updatedAt")
SELECT 'mc_' || substr(md5(u."id" || 'VALIDATION_CENTRE'), 1, 22), u."id", 'VALIDATION_CENTRE',
       FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 'ASSIGNED', '{}'::text[], NOW(), NOW()
FROM "User" u
WHERE u."role"::text NOT IN ('SUPER_ADMIN', 'GENERAL_MANAGER')
  AND u."secondaryRole"::text IN ('SUPER_ADMIN', 'GENERAL_MANAGER')
ON CONFLICT ("userId", "module") DO NOTHING;

-- Bureau d'Adam (« My Chief of Staff ») : hier, le module ET le role PRINCIPAL Super Admin. La Direction n'a plus le module
-- par defaut (permissions.ts) ; un acces coche, ou un « autre role » de Super Admin, ne s'ouvrait pas : on le bloque.
UPDATE "UserAccess" ua
SET "canView" = FALSE, "canCreate" = FALSE, "canUpdate" = FALSE, "canDelete" = FALSE, "canValidate" = FALSE,
    "canExport" = FALSE, "canUpload" = FALSE, "sections" = '{}'::text[], "updatedAt" = NOW()
FROM "User" u
WHERE u."id" = ua."userId" AND ua."module" = 'CHIEF_OF_STAFF' AND ua."canView"
  AND u."role"::text <> 'SUPER_ADMIN';

INSERT INTO "UserAccess" ("id", "userId", "module", "canView", "canCreate", "canUpdate", "canDelete", "canValidate", "canExport", "canUpload", "scope", "sections", "createdAt", "updatedAt")
SELECT 'mc_' || substr(md5(u."id" || 'CHIEF_OF_STAFF'), 1, 22), u."id", 'CHIEF_OF_STAFF',
       FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 'ASSIGNED', '{}'::text[], NOW(), NOW()
FROM "User" u
WHERE u."role"::text <> 'SUPER_ADMIN' AND u."secondaryRole"::text = 'SUPER_ADMIN'
ON CONFLICT ("userId", "module") DO NOTHING;

-- Prospection d'agences, Controles de conformite et Corbeille : hier, une liste de roles (principal ou secondaire) et rien
-- d'autre — aucun acces de console n'existait sur ces cles. Leur defaut reproduit cette liste : rien a recopier. Une seule
-- exception : un « autre role » de Super Admin recoit TOUS les modules par defaut, Corbeille comprise, alors qu'hier la
-- corbeille des modules n'etait qu'au directeur des operations (le Super Admin a la sienne, dans l'Administration). On la
-- bloque a qui ne l'avait pas.
INSERT INTO "UserAccess" ("id", "userId", "module", "canView", "canCreate", "canUpdate", "canDelete", "canValidate", "canExport", "canUpload", "scope", "sections", "createdAt", "updatedAt")
SELECT 'mc_' || substr(md5(u."id" || 'CORBEILLE'), 1, 22), u."id", 'CORBEILLE',
       FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 'ASSIGNED', '{}'::text[], NOW(), NOW()
FROM "User" u
WHERE u."role"::text NOT IN ('SUPER_ADMIN', 'DIRECTION', 'OPERATIONS_DIRECTOR') AND u."secondaryRole"::text = 'SUPER_ADMIN'
ON CONFLICT ("userId", "module") DO NOTHING;
