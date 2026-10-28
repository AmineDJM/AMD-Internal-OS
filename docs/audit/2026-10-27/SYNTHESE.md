# Audit profond du 27/10/2026 — synthèse

Dix auditeurs, un périmètre chacun, consignes communes : [`00-CONSIGNES.md`](00-CONSIGNES.md). Chaque constat est
prouvé (`fichier:ligne`), rejoué sur un scénario réel, et les défauts graves au correctif local et testable sont
**corrigés dans le dépôt** (un commit et un test par constat). Le rapport 01 (sécurité) est en cours de finition.

## Notes par périmètre

| # | Périmètre | Note | Ce qui tient | Le risque n° 1 (statut) |
|---|---|---|---|---|
| 02 | [Données, schéma, migrations](02-donnees-schema.md) | 6,5 | Argent en `Decimal`, migrations additives, numérotation atomique | Cascades qui effaçaient des dépenses (corrigé) ; doubles clics → doubles mouvements (4 corrigés, 2 restent) |
| 03 | [Argent](03-argent-finances.md) | 6,5 | Un seul écrivain d'ordres, un seul écrivain de `PAID` | « Vider l'historique » supprimait des ordres réglés → double paiement possible (corrigé) |
| 04 | [Ad & Pro, workflow](04-adpro-workflow.md) | 6 | Route pure gelée à la naissance, porte DG à règle unique | 4 portes latérales émettaient de l'argent hors circuit (corrigées) ; ADPRO-06 portée des acteurs (proposé) |
| 05 | [RH, documents, comms](05-rh-documents-comms.md) | 6 | Coffre chiffré, circuit de congé unique | API v1 lisait des pièces sans contrôle (corrigé) ; solde de congés manipulable (corrigé) |
| 06 | [IA, assistant](06-ia-assistant.md) | 6,5 | Écritures jamais faites par le modèle (intention → carte → confirmation) | Interrupteurs ignorés par l'Assistant IA (corrigé) ; aucun plafond de coût ni journal d'appels (proposé) |
| 07 | [Performance](07-performance-runtime.md) | 5,5 | Rendu serveur, imports lourds à la demande | Sondages de la coque : ~170 SQL/min/onglet (−39 % corrigé) ; icônes Lucide entières sur chaque page |
| 08 | [Architecture](08-architecture-code.md) | 5,5 | Culture des cliquets, peu de duplication | Cliquets aveugles aux imports relatifs ; structure physique illisible (où vit Ad & Pro ?) |
| 09 | [Frontend, UX](09-frontend-ux.md) | 6,5 | Zéro débordement à 375 px, zéro erreur console | 318 appels d'actions sans garde (corrigé sur l'argent + cliquet) ; modales sans gestion du focus (corrigé) |
| 10 | [Infra, CI](10-infra-ci-observabilite.md) | 4,5 | Build documenté, cliquets | Aucune sauvegarde/restauration (proposé) ; Next 14 + dépendances vulnérables ; 1 068 erreurs avalées |

**Lecture d'ensemble : 6/10.** Le cœur métier est rigoureux (écrivains uniques, règles pures, écritures
conditionnelles) ; les défauts sont aux **bords** : portes secondaires qui contournent la règle centrale, tâches de
fond dans le processus web, absence de garde-fous d'exploitation (CI, sauvegardes, observabilité), et une
structure physique qui ne dit pas où vit un métier.

## Ce qui est déjà fait (dans la branche déployée)
- ~40 correctifs vérifiés et testés : doubles paiements, cascades, soldes, portes latérales Ad & Pro, API v1,
  interrupteurs IA, focus des modales, garde des actions d'argent, isolation des étapes du planificateur.
- **CI GitHub Actions** (`.github/workflows/ci.yml`) : migrations, contrat, typecheck, lint, tests en 4 tranches
  sur Postgres 16, build de production à froid.
- **Sonde de santé** `/api/health` qui interroge la base ; optimiseur d'images public fermé.

## Feuille de route — par rentabilité

| Ordre | Chantier | Source | Effort |
|---|---|---|---|
| 1 | ✅ **Sauvegardes et restauration testée** (28/10) : copie nocturne chiffrée hors de Render, rétention, restauration vérifiée chaque dimanche — `docs/readme/37-sauvegardes-restauration.md` ; reste à poser les secrets et, en complément, un Postgres payant avec PITR | 10 | S |
| 2 | **Rendre les cliquets d'architecture vrais** (imports relatifs, `src/app` et `src/components` mesurés) puis les repasser au vert sans relever de plafond | 08, 06 | M |
| 3 | **Monter Next 15 / next-auth stable**, corriger `npm audit` | 10 | M |
| 4 | **Primitives UI** : toast/bandeau, dialogue accessible, `useAction` partout (remplace 125 `confirm()`, 45 `alert()`) | 09 | M |
| 5 | **Session légère** pour les sondages de la coque ; icônes à l'unité | 07 | S |
| 6 | ✅ **Worker séparé** livré (V2-F) et déclaré dans `render.yaml` (28/10), en attente de bascule `TACHES_DE_FOND` | 07, 10 | M |
| 7 | **Plafonds et journal des appels IA** de l'Assistant IA (coût par personne, par jour) | 06 | S |
| 8 | **Erreurs avalées** : remplacer `catch(() => valeur)` par un journal nommé (règle ESLint + cliquet décroissant) | 10 | M |
| 9 | **Séparation des tâches** au centre de paiement (qui demande ≠ qui paie) — décision de Direction | 03 | S |
| 10 | **Monolithe modulaire** : `src/modules/<module>/{api.ts,domaine,infra,ecrans}`, module pilote puis Ad & Pro | 08 | L |

## Système design cible (résumé — référence : rapport 08 et `../../architecture/refonte-donnees-et-monolithe-modulaire.md`)
1. **Un module = un dossier**, une seule porte (`api.ts`), ses tables, ses actions, ses écrans ; imports profonds
   interdits par ESLint (`no-restricted-imports`) et mesurés par un cliquet à zéro par module migré.
2. **Le socle** (référentiels personnes, organisations, lieux, produits, pièces, coffre) est lu par tous et ne lit personne.
3. **Entre modules** : par `api.ts` ou par événement typé (`BusinessEvent` + outbox).
4. **Deux processus** : web (réactif) et worker (tâches de fond, enrichissement, IA différée), même code, verrous en base.
5. **Garde-fous d'exploitation** : CI bloquante, sauvegardes testées, journal structuré, alertes, plafonds de coût IA.
6. **Ordre de découpe** : socle → pièces et enrichissement → Ad & Pro → Finances/BC → RH → Regulatory → Adam.
