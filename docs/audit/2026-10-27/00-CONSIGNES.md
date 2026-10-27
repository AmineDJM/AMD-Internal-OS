# Audit profond — AMD Internal OS (ERP Adventum Pharma) — consignes communes

Tu es un auditeur senior (staff engineer). La Direction veut que ce dépôt devienne un code EXEMPLAIRE : un système
qu'on pourrait enseigner, efficace, rapide, que n'importe quel développeur comprend et modifie demain, quelle que soit
la taille de l'ERP. Ton audit doit être CONCRET, VÉRIFIÉ et ACTIONNABLE — pas de généralités.

## Cadre
- Dépôt : https://github.com/AmineDJM/AMD-Internal-OS, branche de base `claude/hopeful-goodall-phd0nb` (déployée en prod
  sur Render). Crée et pousse TA branche `audit/<slug>` (donnée dans ta consigne) (donnée plus bas). NE POUSSE JAMAIS sur `claude/hopeful-goodall-phd0nb`
  ni sur `main`. N'ouvre PAS de PR.
- Lis d'abord `CLAUDE.md`, puis `docs/knowledge-base/00-INDEX.md` et le chapitre de ton périmètre, puis `docs/readme/INDEX.md`.
  Graphify : `npm run graphify:query -- "<symbole>"` (le graphe peut avoir du retard sur HEAD).
- Base de données : UNIQUEMENT une base Postgres LOCALE (crée-la si besoin : rôle/base `amd`/`amd`, puis
  `DATABASE_URL=postgresql://amd:amd@localhost:5432/amd_internal_os npx prisma migrate deploy`). Jamais d'URL distante.
  Si `node_modules` manque : `npm ci`.
- Aucune migration destructive (pas de DROP/ALTER qui perd des données). Migrations = SQL manuel idempotent additif.
- Échecs de tests PRÉ-EXISTANTS à ignorer : `src/platform/boundary.test.ts` (430 > 425), `src/platform/domains.test.ts` (71 > 68).

## Livrable 1 — le rapport (obligatoire)
`docs/audit/2026-10-27/<NN>-<slug>.md`, en français, structuré :
1. **Synthèse** (10 lignes max) : note /10 du périmètre et les 3 risques majeurs.
2. **Constats** — un tableau puis une fiche par constat : ID (`<SLUG>-01`…), sévérité (CRITIQUE / HAUTE / MOYENNE / BASSE),
   catégorie (sécurité, correction, intégrité des données, performance, maintenabilité, UX…), **preuve** (`fichier:ligne`,
   extrait court), **scénario réel** (qui fait quoi → quel mauvais résultat), **correctif concret** (quoi changer, où),
   effort (S/M/L), statut (CORRIGÉ dans le commit X / PROPOSÉ).
   Chaque constat est VÉRIFIÉ : trace un chemin réel depuis un appelant ou une entrée utilisateur. Un soupçon non vérifié
   va dans une section « À vérifier », pas dans les constats. Pas de doublon de ce qui est déjà documenté comme dette connue
   sans valeur ajoutée.
3. **Restructuration proposée** pour ton périmètre : la structure cible (dossiers, frontières, contrats, noms), le chemin
   de migration par petites étapes sûres, et ce qu'on gagne. Concret (arborescence, signatures, exemples de code).
4. **Bonnes pratiques à graver** : les règles que la base devrait imposer (lint, test-cliquet, convention) pour que
   le défaut ne revienne pas.

## Livrable 2 — les correctifs (quand c'est sûr)
Corrige toi-même les constats CRITIQUES / HAUTS dont le correctif est local, sûr et testable : un commit par constat
(message en français, sans ligne Co-Authored-By, sans nom de modèle, terminé par
`Claude-Session: https://claude.ai/code/session_01Da1iKCatANvfQwtoV1NBX2`), avec un test qui échoue avant et passe après.
Ne fais PAS de grande refonte toi-même : propose-la dans le rapport. Avant de pousser : `npm run typecheck`,
`npx next lint`, les tests du périmètre touché (`DATABASE_URL=… npx vitest run <dossiers>`), et `npm run actions:contrat`
si tu ajoutes/modifies une server action (puis classe-la dans `src/lib/assistant/action-registry.ts`).
Respecte la frontière client/serveur décrite dans CLAUDE.md (le test `src/lib/client-bundle-guard.test.ts` doit rester vert).

## Fin
Pousse `audit/<slug>` (donnée dans ta consigne) (rapport + correctifs). Termine par un résumé : note, nombre de constats par sévérité, correctifs
commités (hash + une ligne), et les 5 recommandations structurelles les plus rentables.
