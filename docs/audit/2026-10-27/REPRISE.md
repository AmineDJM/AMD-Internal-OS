# Reprise de session — état au 28/10/2026 ~01h UTC

Branche déployée : `claude/hopeful-goodall-phd0nb` (Render). Règles : base locale seulement
(`postgresql://amd:amd@localhost:5432/amd_internal_os`), typecheck + lint + tests + `rm -rf .next && npm run build` avant push,
toujours `git fetch` + merge avant push, pas de Co-Authored-By, `Claude-Session:` en fin de commit.

## Fait et poussé
- Circuit Ad & Pro du 27/10 (prévalidation, postes, DG sur le total, PEC devis comptés) — `docs/architecture/adpro-circuit-2026-10-27.md`.
- Demandes « Autre » dans le circuit (+ délégué, portée ses demandes).
- Refonte vague 1 intégrée (11 branches `refonte/*`), plan vague 2 : `docs/architecture/refonte-vague-2.md`.

## En cours (sessions cloud, tag)
- Audits `audit-2026-10-27` → branches `audit/{securite-acces,donnees-schema,argent-finances,adpro-workflow,rh-documents-comms,ia-assistant,performance-runtime,architecture-code,frontend-ux,infra-ci-observabilite}`, rapports `docs/audit/2026-10-27/NN-*.md`.
  PR ouvertes par l'utilisateur : #44 (donnees-schema), #45 (infra-ci) → à fusionner dans la branche déployée.
- Refonte V2 `refonte-v2` → branches `refonte/v2-{depot-enrichissement,personnes,organisations,lieux,coffre,worker}`
  (contrat commun des reprises : `src/lib/referentiels/reprises/{types,index}.ts`, page `admin/refonte-donnees`, actions `refonte-reprise-actions.ts`).

## Mis à jour le 28/10 ~01h
- Intégrés et poussés : audits 02→10 (PR #42 #43 #44 #45 #46 + commits directs), refonte V2-C organisations, V2-D lieux,
  V2-F worker. Suite complète : 0 échec (cliquets frontière 422 et domaines 67 au vert), build propre.
- Encore en cours (sessions cloud relancées après la limite d'usage) : V2-A enrichissement (`refonte/v2-depot-enrichissement`),
  V2-B personnes (`refonte/v2-personnes`), V2-E coffre (`refonte/v2-coffre`), audit 01 sécurité (`audit/securite-acces`).
  À fusionner comme les autres : registre commun `src/lib/referentiels/reprises/index.ts` (ordre : organisations →
  personnes → lieux → coffre), page et action de la version organisations (journal `reprises/journal.ts`).

## Reste à faire
1. Fusionner chaque branche audit/* et refonte/v2-* terminée (conflits, `npx prisma generate`, `npm run actions:contrat`, tests ciblés, suite complète, build), push.
2. Rendre la CI verte : les cliquets `src/platform/boundary.test.ts` (430 > 425) et `src/platform/domains.test.ts` (71 > 68) échouent depuis avant ce lot — les ramener sous leur plafond (contrat de plateforme / api des modules), jamais en relevant le plafond.
3. Consolider `docs/audit/2026-10-27/SYNTHESE.md` + système design cible (rapport 08 = référence d'architecture).
4. Utilisateur : rôle OPERATIONS_DIRECTOR au Directeur des opérations puis retirer DIRECTION de l'étape ; recopier `buildCommand` de render.yaml dans le tableau Render si surchargé ; accord P5 (effacer le clair) en attente.
