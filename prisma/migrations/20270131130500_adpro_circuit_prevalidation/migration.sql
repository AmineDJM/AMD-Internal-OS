-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Ad & Pro — LE CIRCUIT DU 27/10/2026 : PRÉVALIDATION, POSTES, PUIS LE DG SUR LE TOTAL
--
-- La Direction : « Peu importe le créateur, la demande passe d'abord par son N+1 — le National
-- Sales si c'est un délégué, sinon le Directeur des opérations —, puis la Direction Marketing, qui
-- prévalide le fond et le montant. Tant qu'il n'y a pas cette prévalidation, aucun budget n'est
-- ouvert. Ensuite les postes sont ajoutés par les parties prenantes, acceptés par la Direction
-- Marketing ; le DG valide le TOTAL à la fin, seulement s'il dépasse le seuil. Pareil pour le
-- sponsoring, les prises en charge, les événements et les autres. »
--
-- ── CE QUE CETTE MIGRATION NE FAIT PAS ───────────────────────────────────────────────────
--
-- Elle ne change le statut d'AUCUNE demande ni d'AUCUNE instance de circuit, ne recalcule aucun
-- montant, ne supprime aucune étape : une demande posée sur la porte du DG avant la règle peut en
-- sortir comme avant. Seules les décisions À VENIR suivent la nouvelle règle.
--
-- Elle n'agit que sur les étapes qui portent encore le titre de la graine précédente : un Super
-- Admin qui les a remodelées a pris une décision, ce n'est pas une migration qui la défait.
--
-- Idempotente : chaque instruction est sans effet au second passage (le titre change au premier).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ─── 1. L'étape `final` est celle du DIRECTEUR DES OPÉRATIONS (rôle OPERATIONS_DIRECTOR) ────
--
-- Elle était tenue par le rôle DIRECTION. Si AUCUN compte actif ne porte encore le rôle
-- OPERATIONS_DIRECTOR (principal ou secondaire), DIRECTION reste à ses côtés : sans quoi chaque
-- demande s'arrêterait devant une étape que personne ne peut tenir. Le Super Admin retire
-- DIRECTION depuis Administration › Circuits dès que le compte du Directeur des opérations existe.
UPDATE "WorkflowStep" s
SET "title"       = 'Validation (Directeur des opérations)',
    "description" = 'Le Directeur des opérations valide la demande : il est le N+1 de tout demandeur hors délégué médical, et le second filtre après le National Sales pour un délégué. Il ne fixe aucun montant — la Direction Marketing prévalide ensuite, puis l''argent se décide poste par poste.',
    "actorScope"  = 'ROLE',
    "actorRoles"  = CASE
                      WHEN EXISTS (
                        SELECT 1 FROM "User" u
                        WHERE u."isActive" = TRUE
                          AND (u."role"::TEXT = 'OPERATIONS_DIRECTOR' OR u."secondaryRole"::TEXT = 'OPERATIONS_DIRECTOR')
                      ) THEN ARRAY['OPERATIONS_DIRECTOR']::TEXT[]
                      ELSE ARRAY['OPERATIONS_DIRECTOR','DIRECTION']::TEXT[]
                    END,
    "notifyRoles" = ARRAY['OPERATIONS_DIRECTOR','SUPER_ADMIN']::TEXT[]
FROM "WorkflowDefinition" d
WHERE s."definitionId" = d."id"
  AND d."category" IN ('SPONSORING','CONGRESS_NATIONAL','CONGRESS_INTERNATIONAL','EVENTS')
  AND s."slug" = 'final'
  AND s."title" = 'Validation (Direction des opérations)';

-- ─── 2. L'étape `marketing` des PEC et événements devient la PRÉVALIDATION ──────────────────
--
-- Plus de montant ni de catégorie budgétaire à cette étape, plus d'ordre de dépense global : ce
-- sont les postes qui portent la dépense (le sponsoring suit cette règle depuis §118.151). La
-- déclaration d'information médicale part toujours ici : l'événement se déclare avant d'avoir lieu.
UPDATE "WorkflowStep" s
SET "title"            = 'Prévalidation (Direction Marketing)',
    "description"      = 'La Direction Marketing prévalide le fond de la demande et le montant demandé — aucun budget n''est ouvert avant. Prévalidée, la demande passe aux postes, ajoutés par les parties prenantes et acceptés par la Direction Marketing (montant et budget) ; le Directeur Général valide le total à la fin s''il dépasse le seuil.',
    "powers"           = ARRAY['APPROVE','REJECT','COMMENT']::TEXT[],
    "requireAmount"    = FALSE,
    "requireCategory"  = FALSE,
    "emitExpenseOrder" = FALSE,
    "emitDeclaration"  = TRUE,
    "confidential"     = FALSE
FROM "WorkflowDefinition" d
WHERE s."definitionId" = d."id"
  AND d."category" IN ('CONGRESS_NATIONAL','CONGRESS_INTERNATIONAL','EVENTS')
  AND s."slug" = 'marketing'
  AND s."title" = 'Décision et budget (Direction Marketing)';

-- ─── 3. La porte du DG dit qu'elle est HORS CIRCUIT ──────────────────────────────────────────
UPDATE "WorkflowStep" s
SET "description" = 'Hors circuit depuis le 27/10/2026 : le Directeur Général ne valide plus la demande ici, mais le total de ses postes, à la fin, quand il dépasse le seuil réglé en Administration › Réglages. Seules des demandes nées avant cette règle peuvent encore attendre à cette étape.'
FROM "WorkflowDefinition" d
WHERE s."definitionId" = d."id"
  AND d."category" IN ('SPONSORING','CONGRESS_NATIONAL','CONGRESS_INTERNATIONAL','EVENTS')
  AND s."slug" = 'dg'
  AND s."title" = 'Validation du Directeur Général'
  AND s."description" IS DISTINCT FROM 'Hors circuit depuis le 27/10/2026 : le Directeur Général ne valide plus la demande ici, mais le total de ses postes, à la fin, quand il dépasse le seuil réglé en Administration › Réglages. Seules des demandes nées avant cette règle peuvent encore attendre à cette étape.';
