# Module `assistant-ia` — l'Assistant IA (« Adventum Brain »), ouvert à chacun selon ses droits

Le second produit d'IA du dépôt, à côté d'Adam (le Chief of Staff du Super Admin). Moteur Mastra + `gpt-6.1-terra`,
page `/assistant`, accès par le module RBAC `ASSISTANT_IA` et la console `/admin/ai/acces`. Décisions :
[`docs/assistant/decisions/`](../../../docs/assistant/decisions/) (0001 → 0018 ; 0013 : la séparation d'Adam et le socle IA ;
0017 : l'Atelier ; 0018 : vitesse et mémoire — outils à la demande, consigne stable, résumé roulant, assembleur, modèle par rôle).

| Porte / dossier | Rôle |
|---|---|
| `api.ts` | **Porte serveur** : le fil (`deposerMessage`, `traiterFil`, `lireFil`, `reprendreLesFils`, `jouerTour`), vocaux, mémoire, routines, opérations, accès, consommation |
| `partage.ts` | **Porte pure** : familles d'accès, plafonds, filtre de confidentialité, règles de lecture et de dépôt, MRZ |
| `actions.ts` | clé `assistant-ia-actions` : mémoire, routines, fil, et `confirmerIntentionAssistantIA` (l'exécution d'une carte) |
| `actions-consommation.ts` | clé `assistant-ia-consommation-actions` : réglages de consommation et d'accès (Super Admin) |
| `actions-atelier.ts` | clé `assistant-ia-atelier-actions` (J3, décision 0017) : l'Atelier — ouvrir, revoir, enregistrer (nouvelle version), comparer, convertir |
| `domaine/` | règles pures (accès, plafonds, confidentialité, lecture, dépôt, mémoire affichée, MRZ, UI générative) |
| `infra/` | le moteur : fil, tour, outils, opérations, lecture des pièces, voix, mémoire, routines, consommation, modèle ; `testing/` (faux modèle, tests seulement) |
| `ecrans/` | l'interface de `/assistant` (ex-`components/assistant-beta/`) |

- **Tables** : `AssistantIaFil`, `AssistantIaTour`, `AssistantMemoryItem`, `AssistantRoutine`, `AssistantRoutineRun`,
  `AssistantRoleConfig`, `AssistantIaAcces`, `AssistantIaReglage`, `AssistantIaPlafondAtteint`. Les intentions
  (`AssistantActionIntent`) sont au socle IA (`src/platform/ia/intentions/`), partagées avec Adam.
- **Tâches de fond** : `assistant.routines`, `assistant.fils` (`src/lib/scheduled.ts`).
- **Frontière** : le module n'importe pas Adam, sauf le catalogue d'outils nommé dans `src/platform/ia/frontieres.test.ts` ;
  ce que les deux partagent vit au socle `src/platform/ia/`.

## Vitesse et mémoire (lot J4, décision 0018)

- **Outils à la demande** — `domaine/selection-outils.ts` (règle pure : socle de 10, présélection plein texte de 6,
  `trouver_outil`), `infra/selection.ts` (fiches = outils offerts sous les droits ; `trouver_outil`). `repondre.ts` ne
  fait partir que les ACTIFS de chaque étape (`prepareStep` → `activeTools`). Corpus de référence : `infra/selection.test.ts`.
- **Consigne stable** — `infra/contexte.ts` : préfixe identique d'un tour à l'autre, règles par famille d'outils
  (`reglesPour`, `reglesAjoutees`), partie variable et heure à la fin ; clé de cache par personne.
- **Mémoire en 4 couches** — (a) carnet d'un travail (J2) ; (b) conversation : 4 échanges mot pour mot + **résumé
  roulant** (`domaine/fil/resume.ts`, `infra/fil/resume.ts`, colonnes `AssistantIaFil.resume*`) ; (c) mémoire
  personnelle ; (d) connaissance : `chercher_documents`, `ouvrir_documents`, `faits_confirmes` (socle,
  `platform/ia/lectures/connaissance.ts`). **Assembleur** : `domaine/assembleur.ts` (enveloppes fixes).
- **Le bon modèle** — `platform/ia/modeles-roles.ts` (rapide / standard / raisonnement, effort adaptatif) ;
  `infra/modele.ts` (`optionsFournisseur` : effort, clé de cache).

## Graphe de l'entreprise (lot J9, décision 0021)

- `explorer_relations`, `etat_a_une_date`, `d_ou_vient` — au socle (`platform/ia/lectures/graphe.ts`, module `graphe-entreprise`),
  branchés dans `infra/outils-v1.ts` : les familles FERMÉES de la console retirent leurs types du graphe (pas de refus de
  l'outil). Fiches de la sélection (`MOTS_CLES`), règle 12 de la consigne (`contexte.ts`) : chaque chiffre cité avec sa source.

## Recettes de la maison (lot J10, décision 0028)

- `recette_pour` (`infra/recettes.ts`, module `recettes`) : la version VALIDÉE d'une recette ou rien ; plan de travail tiré de la
  recette, phrase « selon la recette … validée par … le … », écarts. Fiche de la sélection (`MOTS_CLES`), règle 13 de la consigne
  (`contexte.ts`). Une famille FERMÉE retire les processus qu'elle couvre. Banc : `infra/recettes.test.ts` (faux modèle).
