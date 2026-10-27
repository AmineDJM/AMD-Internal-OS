-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Ad & Pro — LE CIRCUIT DE LA DEMANDE « AUTRE » EST CELUI DES ÉVÉNEMENTS (Direction, 27/10/2026, #17)
--
-- « Les demandes autres suivent le même circuit. » La catégorie de circuit `OTHER` naît ici comme
-- une COPIE de la définition `EVENTS` telle qu'elle est en base — avec ce que la migration
-- `20270131130500_adpro_circuit_prevalidation` y a écrit (la prévalidation de la Direction Marketing,
-- l'étape du Directeur des opérations et, tant qu'aucun compte actif ne porte ce rôle, la Direction à
-- ses côtés) et ce que le Super Admin y a réglé depuis. Une graine écrite ici à la main aurait été une
-- seconde vérité ; semée paresseusement par le moteur depuis `defaults.ts`, l'étape du Directeur des
-- opérations aurait perdu ce repli et une base sans ce compte aurait arrêté chaque demande « autre »
-- devant une étape que personne ne tient.
--
-- Rien n'est copié si `OTHER` existe déjà (un Super Admin l'a réglée, ou le moteur l'a semée) ni si
-- `EVENTS` n'existe pas (base neuve : le moteur sème alors `OTHER` depuis `defaults.ts`, comme les
-- quatre autres). Additive et idempotente ; elle ne touche à aucune demande ni à aucune instance.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  src_id TEXT;
  new_id TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM "WorkflowDefinition" WHERE "category" = 'OTHER') THEN
    RETURN;
  END IF;
  SELECT "id" INTO src_id FROM "WorkflowDefinition" WHERE "category" = 'EVENTS';
  IF src_id IS NULL OR NOT EXISTS (SELECT 1 FROM "WorkflowStep" WHERE "definitionId" = src_id) THEN
    RETURN;
  END IF;

  new_id := gen_random_uuid()::text;
  INSERT INTO "WorkflowDefinition" ("id", "category", "name", "description", "isActive", "createdAt", "updatedAt")
  VALUES (
    new_id, 'OTHER', 'Circuit Autre demande',
    'Circuit de prise en charge Ad & Pro. Modifiable de bout en bout par le Super Admin (rôles, pouvoirs, étapes).',
    TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

  INSERT INTO "WorkflowStep" (
    "id", "definitionId", "position", "slug", "title", "description", "actorRoles", "actorScope", "powers",
    "assignRole", "requireAmount", "autoSkipMaxAmount", "autoApproveIfRequester", "requireCategory", "requireNote",
    "emitDeclaration", "emitExpenseOrder", "notifyRoles", "optional", "confidential", "legacyStatus", "createdAt"
  )
  SELECT
    gen_random_uuid()::text, new_id, s."position", s."slug", s."title", s."description", s."actorRoles", s."actorScope", s."powers",
    s."assignRole", s."requireAmount", s."autoSkipMaxAmount", s."autoApproveIfRequester", s."requireCategory", s."requireNote",
    s."emitDeclaration", s."emitExpenseOrder", s."notifyRoles", s."optional", s."confidential", s."legacyStatus", CURRENT_TIMESTAMP
  FROM "WorkflowStep" s
  WHERE s."definitionId" = src_id;
END $$;
