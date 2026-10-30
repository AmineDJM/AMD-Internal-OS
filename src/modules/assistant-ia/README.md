# Module `assistant-ia` — l'Assistant IA (« Adventum Brain »), ouvert à chacun selon ses droits

Le second produit d'IA du dépôt, à côté d'Adam (le Chief of Staff du Super Admin). Moteur Mastra + `gpt-6.1-terra`,
page `/assistant`, accès par le module RBAC `ASSISTANT_IA` et la console `/admin/ai/acces`. Décisions :
[`docs/assistant/decisions/`](../../../docs/assistant/decisions/) (0001 → 0018, 0021 → 0025 ; 0013 : la séparation d'Adam et le socle IA ;
0017 : l'Atelier ; 0018 : vitesse et mémoire — outils à la demande, consigne stable, résumé roulant, assembleur, modèle par rôle ;
0023 : délégation des travaux, attentes avancées, équipe, livrables au Drive).

[`docs/assistant/decisions/`](../../../docs/assistant/decisions/) (0001 → 0024 ; 0013 : la séparation d'Adam et le socle IA ;
0017 : l'Atelier ; 0018 : vitesse et mémoire — outils à la demande, consigne stable, résumé roulant, assembleur, modèle par rôle ; 0020 : le registre des
capacités ; 0022 : la qualité continue ; 0024 : la proactivité).

| Porte / dossier | Rôle |
|---|---|
| `api.ts` | **Porte serveur** : le fil (`deposerMessage`, `traiterFil`, `lireFil`, `reprendreLesFils`, `jouerTour`), vocaux, mémoire, routines, opérations, accès, consommation |
| `partage.ts` | **Porte pure** : familles d'accès, plafonds, filtre de confidentialité, règles de lecture et de dépôt, MRZ |
| `actions.ts` | clé `assistant-ia-actions` : mémoire, routines, fil, et `confirmerIntentionAssistantIA` (l'exécution d'une carte) |
| `actions-consommation.ts` | clé `assistant-ia-consommation-actions` : réglages de consommation et d'accès (Super Admin) |
| `actions-qualite.ts` | clé `assistant-ia-qualite-actions` (J5 + J14, décision 0022) : calendrier du banc programmé, passage maintenant, banc A/B, modèle d'un rôle (sur banc vert seulement) |
| `actions-atelier.ts` | clé `assistant-ia-atelier-actions` (J3, décision 0017) : l'Atelier — ouvrir, revoir, enregistrer (nouvelle version), comparer, convertir |
| `actions-travaux.ts` | clé `assistant-ia-travaux-actions` (J8, décision 0023) : demandes reçues (lister, répondre, décliner), priorité d'un travail, travaux de mon équipe (si la console l'autorise, audités) |
| `actions-proactivite.ts` | clé `assistant-ia-proactivite-actions` (J12, décision 0024) : ma veille (veilleurs, réglages, retours), mandats, gestes sous mandat (coque), console |
| `domaine/` | règles pures (accès, plafonds, confidentialité, lecture, dépôt, mémoire affichée, MRZ, UI générative) |
| `infra/` | le moteur : fil, tour, outils, opérations, lecture des pièces, voix, mémoire, routines, consommation, modèle ; `testing/` (faux modèle, tests seulement) |
| `ecrans/` | l'interface de `/assistant` (ex-`components/assistant-beta/`) |

- **Tables** : `AssistantIaFil`, `AssistantIaTour`, `AssistantMemoryItem`, `AssistantRoutine`, `AssistantRoutineRun`,
  `AssistantRoleConfig`, `AssistantIaAcces`, `AssistantIaReglage`, `AssistantIaPlafondAtteint` ; J12 : `AssistantVeille`,
  `AssistantVeilleur`, `AssistantSignal`, `AssistantMandat`, `AssistantMandatGeste`. Les intentions
  (`AssistantActionIntent`) sont au socle IA (`src/platform/ia/intentions/`), partagées avec Adam.
- **Tâches de fond** : `assistant.routines`, `assistant.fils`, `assistant.veilleurs` (J12) (`src/lib/scheduled.ts`).
- **Frontière** : le module n'importe pas Adam — plus aucune exception depuis J6 (`RESIDUS` vide dans
  `src/platform/ia/frontieres.test.ts`) ; ce que les deux partagent vit au socle `src/platform/ia/`.

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

## Le registre des capacités (lot J6, décision 0020)

- **Registre** (socle, pur) : `src/platform/ia/capacites/` — une fiche par action du contrat (`contrat.genere.json`), par outil
  du module et par commande de l'Atelier ; risque R0 → R4, famille, simulable, annulation, contenu tiers, porte d'écran.
  Cliché relu `classement.genere.json` (`npm run capacites:classement`).
- **Branché** : `infra/capacites.ts` — `registreDesCapacites` (les ports : refus générique, annulation, modules), `porteOuverte`,
  `outilsCapacites` (un outil par capacité offerte, `fichier__fonction`), `executerCapacite` (la confirmation) ;
  `domaine/capacites.ts` (charge `assistant_ia_capacite`, niveau de carte, ressaisie, anciens noms d'outils).
  `outilsV1(…, { capacites: true })` ne sert qu'à la CONVERSATION (`fil/tour.ts`) : ni les routines ni les travaux.
- **Lectures propres** (plus d'emprunt à Adam) : `infra/lectures-erp.ts` (tâches, demandes, aperçu, catalogue Regulatory,
  recherche fédérée, agenda, file des décisions), `operations/budget.ts` (`read_budget`), `lectures.ts` (`read_hr_overview`,
  `finance_totals`), `outils-v1.ts` (`read_workflow`) ; `operations/quotidien.ts` : `send_message` (opération propre).
- **Preuves** : `capacites.test.ts`, `infra/selection-capacites.test.ts` (300 demandes), `infra/banc-selection.test.ts` (banc 26).
- **Aucune régression** (0020 § 8) : `infra/equivalents-avant-j6.json` (écrit par `npm run capacites:inventaire`) — chaque geste
  qu'Adam prêtait avant J6 et son équivalent ; `equivalents-avant-j6.test.ts` le rejoue (appelable, porte ouverte par rôle).
  La fiche employé passe par `executerAction(…, "assistant-ia")` (`GESTES_DE_FICHE`, sans `userId`) ; `updateEmployee` est
  relue et rejouée à la confirmation (`FUSIONS`).


## Travaux, suite (lot J8, décision 0023)

- **Persona** (`infra/travaux.ts`) : en plus de J2, `pieces` (`PIECES_TRAVAUX` : voir / accorder la lecture d'une
  pièce du Drive, à l'audit), `responsable` (N+1 de l'organigramme, pour les escalades), `deposerLivrable`
  (`infra/travaux-livrables.ts` : Word / Excel de la fabrique au Drive « Travaux », inscrit à la Bibliothèque ; PDF par
  l'Atelier).
- **Côté sollicité** (`infra/operations/delegation.ts`) : lecture `mes_demandes_recues` (contenu non fiable), carte
  `preparer_reponse_demande` — fiches MOTS_CLES de la sélection (pas le socle) ; exclue des gestes de travail.
- **Équipe** (`lib/missions/travaux/equipe.ts`, par la porte `service.ts`) : option console `managerVoitEquipe` (défaut non), résumé et étapes seulement,
  chaque consultation à l'audit.
- **Écrans** : `ecrans/demandes-recues.tsx`, `ecrans/travaux-equipe.tsx`, onglets du panneau « Travaux ».

## Graphe de l'entreprise (lot J9, décision 0021)

- `explorer_relations`, `etat_a_une_date`, `d_ou_vient` — au socle (`platform/ia/lectures/graphe.ts`, module `graphe-entreprise`),
  branchés dans `infra/outils-v1.ts` : les familles FERMÉES de la console retirent leurs types du graphe (pas de refus de
  l'outil). Fiches de la sélection (`MOTS_CLES`), règle 12 de la consigne (`contexte.ts`) : chaque chiffre cité avec sa source.

## Proactivité sous mandat (lot J12, décision 0024)

- **Veilleurs** — `domaine/proactivite/veilleurs.ts` (12 règles pures, signature anti-répétition), lectures sous l'identité
  de la personne `infra/proactivite/sources.ts` (module d'écran + famille de console). Passage `infra/proactivite/veille.ts`
  (tâche `assistant.veilleurs`) : constater, résoudre, livrer ; point du matin (seul appel au modèle, texte de secours).
- **Budget d'interruptions** — `domaine/proactivite/budget.ts` : heures calmes d'Alger, vendredi-samedi, regroupement,
  ≤ 5 par jour (console), retours « utile / pas utile » qui ajustent le seuil et rendent un veilleur discret.
- **Mandats** — `domaine/proactivite/mandats.ts` (niveaux R1→R4, bornes, contrôle avant chaque geste) ;
  `infra/proactivite/mandats.ts` : gestes par `proposer` + `executerOperationIA`, **dans la requête de la personne**
  (`ecrans/executeur-mandats.tsx`, monté par la coque), reçu pris avant, audit.
- **Écrans** — `ecrans/veille-panel.tsx` (« Ce que mon assistant surveille »), `ecrans/suggestions-dossier.tsx`
  (`/validations/[id]`, `/sponsoring/[id]`), `ecrans/console-proactivite.tsx` (`/admin/ai/acces`).

## Qualité continue (lots J5 + J14, décision 0022)

- **Banc programmé** — `infra/qualite/banc.ts` (tâche `qualite.banc`, worker seul ; processus `scripts/bench/banc-programme.ts`
  contre la base d'essai déclarée `BANC_ESSAI_DATABASE_URL`, marqueur `BancBaseEssai`) ; règles pures `domaine/qualite/`
  (calendrier, régression +30 %, base d'essai, résultat). Tables `AssistantIaBancReglage`, `AssistantIaBancPassage`,
  `AssistantIaBancScenario`. Écran `/admin/ai/qualite`.
- **Traces rejouables** — `infra/qualite/traces.ts` (enregistrement du modèle et des outils, `AssistantIaTrace` gzip, 30 j),
  `infra/qualite/rejeu.ts`, `npm run assistant:rejouer`.
- **Provenance tierce** — `domaine/provenance-tierce.ts` (pur), `infra/provenance.ts` (sur chaque carte) ; corpus de 240
  pièges `infra/testing/corpus-pieges.ts`, preuves `infra/qualite/pieges-regles.test.ts`, `pieges.test.ts`.
- **A/B des modèles** — `infra/qualite/modeles.ts` (`AssistantIaModeleRole` au-dessus de l'environnement ; garde
  `domaine/qualite/ab-modele.ts` : banc vert pour ce candidat exact, < 14 jours).

## Terrain et voix (lot J13, décision 0025)

- **Terrain** — `domaine/terrain/` (compte rendu dicté, résolution dans l'annuaire, file hors ligne, photos, règles de la
  voix — pur), `infra/terrain/captation.ts` (vocal / photo → cartes, idempotent), `infra/operations/terrain.ts`
  (`terrain_*`), `ecrans/terrain/` (écran mobile, file IndexedDB), page `/medical/terrain`, confirmation
  `confirmerCarteTerrain`. Table `AssistantIaTerrainCapture`.
- **Voix temps réel (GPT-Live)** — `infra/voix/temps-reel.ts` (session ouverte par le serveur, délégation au même
  assistant par le fil, journal et transcription), `ecrans/voix-temps-reel.tsx` ; socle `platform/ia/voix/`. Aucune
  confirmation à la voix ; valeurs sensibles jamais lues ; modèle `gpt-live-1` réglable (Consommation IA).

## Recettes de la maison (lot J10, décision 0028)

- `recette_pour` (`infra/recettes.ts`, module `recettes`) : la version VALIDÉE d'une recette ou rien ; plan de travail tiré de la
  recette, phrase « selon la recette … validée par … le … », écarts. Fiche de la sélection (`MOTS_CLES`), règle 13 de la consigne
  (`contexte.ts`). Une famille FERMÉE retire les processus qu'elle couvre. Banc : `infra/recettes.test.ts` (faux modèle).
