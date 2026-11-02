# Orchestrateur d'équipe — Adam, MiMo et plusieurs travailleurs Claude Code (lot O2)

> Demande de la Direction (02/11/2026) : Adam (Terra) délègue à MiMo 2.6 Pro, superviseur technique qui décompose,
> planifie, coordonne, résout et contrôle, et gère une ÉQUIPE de travailleurs Claude Code en parallèle quand c'est utile ;
> GitHub et Render pour l'intégration et l'infra. Priorités, dans l'ordre : **correction → fiabilité → autonomie → coût →
> vitesse**. Décision : [0059](../assistant/decisions/0059-orchestrateur-equipe.md). Socle réutilisé :
> [CHANTIERS-DEV.md](CHANTIERS-DEV.md), décisions 0042, 0043, 0058.

## 1. Ce qui existe déjà et qu'on ne reconstruit PAS

Le moteur des chantiers (`src/lib/missions/chantiers/`) conduit UNE session Claude Code par chantier, sous le Mission
Runtime : plan contrôlé, étapes `DEV_*`/`RENDER_*`, baux, reçus idempotents (`sousRecu`, `reclamerEcriture`), réservations
atomiques `BRANCHE`/`PERIMETRE` (recouvrement de globs)/`MIGRATIONS`/`DEPLOIEMENT` sous `pg_advisory_xact_lock`,
dépendances entre chantiers, plafonds (dollars, lancements, déploiements), webhooks GitHub/Render qui RÉVEILLENT,
vérification déterministe (CI verte sur le SHA de tête + périmètre), fusion sur carte de validation, revert (jamais de
force-push), déploiement ERP avant app et worker, rapport avec preuves, 24 h d'attente et rouge corrigé seul (0058).

Vérifié dans le code le 02/11 (l'audit du parent, relu) : un chantier = une session, `maxConcurrency` 1 ; jusqu'à
`enParallele` (3) chantiers conduits ensemble par `balayerChantiers` ; outils `lancer_un_chantier`, `ou_en_est_chantier`,
`valider_chantier`, `consigne_chantier`, `annuler_chantier` (Super Admin) ; MiMo résume les extraits de CI de plus de
1 500 caractères, Sol arbitre à la 2ᵉ occurrence d'une même panne ; `Mission.parentMissionId` existe mais aucun chantier
ne s'en servait ; annuler un chantier n'arrête pas une session Claude Code cloud (aucune API ne le permet sur
l'abonnement). Les corrections de C2 (lancement par le relais seul, vraie session du relais, budget du plan appliqué,
migrations destructives dites sur la carte, 24 h, autonomie sur le rouge) sont FUSIONNÉES dans cette branche, pas recodées.

## 2. Ce qu'O2 ajoute : la couche « équipe »

```
Direction ──parle──▶ Adam (Terra) ──outil lancer_un_programme──▶ PROGRAMME (Mission kind PROGRAMME)
                                      │                             │ plan = DAG de tâches (MiMo, validé par le CODE)
                                      │                             ▼
                                      │                 ordonnanceur DÉTERMINISTE (pur)
                                      │      ┌──────────────┬───────┴──────┬──────────────┐
                                      │   chantier A     chantier B     chantier C   (enfants : parentMissionId)
                                      │   session 1      session 2      session 3    (1 travailleur = 1 session = 1 branche)
                                      │      └──────────────┴──────┬───────┴──────────────┘
                                      │               FILE D'INTÉGRATION par branche cible (DB, une à la fois)
                                      │       tête actuelle → branche d'intégration → CI COMPLÈTE du résultat
                                      │       → avance de la cible (CAS) ou carte de validation (main) → libération
                                      └──────── tableau « Missions d'Adam » (SSE) : tâches, travailleurs, file, coûts
```

| Brique | Fichier | Nature |
|---|---|---|
| Plan de programme, validateur | `src/lib/missions/equipe/programme.ts` | **pur** : cycles, périmètres vides, recouvrements, critères vérifiables, budget, regroupement des petites tâches liées |
| Ressources nommées | `src/lib/missions/equipe/ressources.ts` | **pur** : `SCHEMA`, `CONTRAT`, `API`, `DEPENDANCES`, `GENERES`, `MODULE:<m>` déduites des globs ET vérifiées au diff |
| Ordonnanceur | `src/lib/missions/equipe/ordonnanceur.ts` | **pur** : qui part maintenant (dépendances intégrées, aucune ressource commune avec une tâche non intégrée, concurrence, budget) |
| Planificateur MiMo | `src/lib/missions/equipe/planificateur.ts` | JSON strict → validateur ; 2ᵉ essai avec les fautes ; Sol en recours ; jamais seul juge |
| Programme (service, conduite) | `src/lib/missions/equipe/service.ts`, `conduite.ts` | lancer, conduire (événementiel), consigne, état, annuler |
| File d'intégration | `src/lib/missions/equipe/integration.ts` + table `IntegrationFile` | machine à états durable, sérialisée par cible (index unique partiel), reçus |
| Port travailleur | `src/lib/missions/equipe/travailleurs.ts` | Claude Code cloud (défaut) ; Managed Agents derrière un interrupteur COUPÉ |
| Outils d'Adam | `src/lib/missions/equipe/outils.ts` | `lancer_un_programme`, `ou_en_est_programme`, `consigne_programme`, `annuler_programme` |

## 3. Les travailleurs — le choix, chiffré

Un **port unique** `Travailleur` : `lancer`, `envoyer` (message à la MÊME session), `etat`, `arreter`, idempotents (clé),
avec le coût rendu quand le fournisseur le dit. Trois adaptateurs possibles :

| Adaptateur | Isolation | Ressources pour CET ERP (typecheck ~5 Go, Postgres, 17 000 tests) | Coût marginal estimé par tâche | Statut |
|---|---|---|---|---|
| **Claude Code cloud** (Routines / relais `claude --cloud`) | un conteneur et une branche par session — naturelle | suffisantes : c'est l'environnement où ce dépôt est développé et vérifié chaque jour | **0 $ d'API** (abonnement de la Direction ; plafonds d'usage du plan et 30 lancements/h/routine, 100/h/compte) + MiMo ≈ 0,01–0,03 $ par programme (planification ~20 k jetons en entrée, ~4 k en sortie) | **PAR DÉFAUT**, branché |
| **Managed Agents** (API Anthropic, bêta `managed-agents-2026-04-01`) | un conteneur par session | **HYPOTHÈSE non vérifiée** : la taille du conteneur hébergé suffit-elle au typecheck de production et à un Postgres local ? | tokens au prix public + **0,08 $/h** de session active. Ordre de grandeur (Claude Opus 5.5, 4 $/20 $ le M, lecture de cache 0,20 $) pour une tâche ERP moyenne ≈ 5 M jetons lus en cache (1 $) + 0,5 M non cachés (2 $) + 0,2 M en sortie (4 $) + 2 h (0,16 $) ≈ **7 $** ; fourchette **3–15 $**. Plafond DUR par session (`budget.max_list_cost`, en cents) | **ÉCRIT, INTERRUPTEUR COUPÉ** (`EQUIPE_MANAGED_AGENTS=1` + clé API) — attend la décision de facturation de la Direction |
| **Agent SDK auto-hébergé** (`@anthropic-ai/claude-agent-sdk`) | à construire (worktrees, conteneurs) | **insuffisant sur Render** : worker en plan « standard », relais en « starter » ; 3 agents qui compilent et testent en parallèle demandent ≥ 3 × 5 Go + Postgres ; un processus long meurt à chaque déploiement Render | mêmes jetons que Managed Agents (facturation API) **+** une machine dédiée à chiffrer | **NON construit** — option documentée |

Les chiffres Managed Agents sont des ESTIMATIONS (aucune tâche réelle mesurée) ; la facturation réelle se lit sur
`session.usage.list_cost` et est journalisée par l'adaptateur.

**Le parallélisme vaut-il le coût ?** Sur l'abonnement, une session de plus ne coûte pas de dollars mais consomme le
plafond d'usage et 1 lancement/h ; l'ordonnanceur ne parallélise que des tâches **indépendantes** (aucune dépendance, aucune
ressource commune) et **regroupe** une chaîne de petites tâches liées (A → B, toutes deux « S », B ne dépend que de A, A
n'a que B pour suite) en UNE seule session : le contexte partagé vaut plus que le temps gagné. Concurrence réglable
(défaut 3), plafonds du programme (dollars, lancements) appliqués AVANT chaque lancement.

## 4. Les invariants (testés — § 7)

1. **Jamais deux intégrations concurrentes sur une même cible** : index unique partiel
   `IntegrationFile(depot, cible) WHERE statut IN ('EN_COURS','CI','A_VALIDER')` — la base refuse le second, quel que soit
   le processus.
2. **Jamais une fusion sans CI verte sur la tête EXACTE** : la cible n'avance que vers le SHA d'intégration dont les checks
   sont verts, ET seulement si sa tête est encore celle sur laquelle l'intégration a été construite — avance
   **fast-forward seulement** (`force: false`), refusée par GitHub si la cible a bougé → on recommence sur la nouvelle tête.
3. **Jamais deux fusions du même travail** : une entrée par (chantier, SHA) ; l'avance est idempotente (avancer une
   branche au SHA où elle est déjà ne change rien) ; chaque geste externe sous reçu ; reprise après coupure par relecture
   de GitHub (la branche d'intégration existe-t-elle ? la cible est-elle déjà au SHA ?).
4. **Les incompatibilités sémantiques** (A renomme une fonction, B l'appelle ; contrat ou schéma régénérés qui divergent)
   sont attrapées par la **CI du résultat intégré**, pas par Git. La CI régénère les fichiers générés et échoue s'ils
   changent (`npm run actions:contrat` + `git diff --exit-code`).
5. **Ressources partagées réservées et VÉRIFIÉES au diff** : une tâche qui touche une ressource nommée qu'elle n'a pas
   réservée (le schéma, le contrat, les dépendances…) est ROUGE ; le programme replanifie.
6. **Les réservations survivent à la fin du chantier** jusqu'à l'intégration : un chantier enfant terminé TRANSFÈRE ses
   réservations au programme (une instruction SQL, sans fenêtre) ; elles sont libérées quand son travail est intégré.
7. **Les travailleurs n'écrivent jamais sur une branche protégée ni en production** : leur branche est `claude/…` et
   jamais la base (plan des chantiers) ; l'adaptateur d'intégration refuse toute écriture de ref hors
   `claude/integration/…` sauf l'avance de la cible déclarée par la file, après CI verte (et carte pour `main`) ; un
   programme ne déploie JAMAIS (le validateur refuse un service) — un déploiement reste un chantier avec sa carte.
8. **MiMo n'est jamais seule autorité** : son plan passe le validateur déterministe ; ses jugements ne déclenchent aucun
   geste critique ; fusion sur `main` et production restent sous carte de la Direction.
9. **Événementiel** : aucune boucle de surveillance par LLM. Le battement des chantiers et les webhooks réveillent le
   programme ; MiMo n'est appelé que pour planifier, replanifier (conflit, échec répété, dépendance cassée) ou relire.
10. **Un redémarrage ne perd rien et ne double rien** : état en base (programme, chantiers, file), bail par programme,
    étapes de la file reprises à l'état écrit.

## 5. La file d'intégration (une à la fois, par cible)

```
EN_FILE ──prise (index unique)──▶ EN_COURS : tête actuelle de la cible → branche claude/integration/<cible>/<n>
   ▲                                  │ fusion de la branche de la tâche (API merges de GitHub)
   │                                  ├─ conflit → RENVOYEE : fichiers générés / lockfile seuls → consigne de
   │                                  │   régénération ; sinon → consigne de fusion ; MÊME session, travail préservé
   │                                  ▼
   │                                 CI : checks du SHA d'intégration (le push sur claude/** la déclenche)
   │                                  ├─ rouge → RENVOYEE (l'incompatibilité sémantique, extrait de CI à l'appui)
   │                                  ├─ vert, cible bougée → EN_FILE (recommence sur la nouvelle tête)
   │                                  ▼
   │                                 vert, cible inchangée : main → A_VALIDER (carte) ; autre cible → avance CAS
   └──── nouveau commit vert du travailleur                  ▼
                                                  FUSIONNEE → réservations libérées, dépendants débloqués
```

La **merge queue native de GitHub** (règles de branche « Require merge queue ») fait la même chose côté GitHub : elle est
une alternative valable pour `main` si la Direction l'active, mais elle n'est ni portable ni testable localement, ne
connaît pas nos ressources nommées et ne renvoie pas le conflit à la session : on garde la nôtre (§ 7 de 0059).

## 6. Pannes couvertes

| Panne | Comportement |
|---|---|
| Superviseur (processus ERP) tué en pleine intégration | bail du programme et de l'entrée échus → repris ; chaque étape relit GitHub avant d'agir ; aucun geste rejoué sans preuve qu'il manque |
| Travailleur mort ou muet | moteur des chantiers (0058) : « où en es-tu ? » à 4 h, relance si la session est morte, consignes à 24 h |
| Deux tâches finies à la même milliseconde | l'index unique partiel ne laisse entrer qu'une intégration ; l'autre reste EN_FILE |
| MiMo indisponible | Sol en recours ; sinon le programme est refusé avec la raison (un plan peut aussi être donné tel quel par Terra) |
| Render coupé | rien ne dépend de Render dans l'intégration ; le battement reprend au redémarrage |
| GitHub en panne / limite de débit | erreurs non définitives → nouvel essai à délai croissant, entrée gardée ; jamais d'échec sec |
| Réservation ou session périmée | réservation d'un chantier FINI reprise par expiration ; celle d'un programme vivant tenue |
| Exécution partielle | reçus `TravailEcriture` + relecture de l'état réel |

## 7. Testé / hypothèse

**Testé** (base locale, ports factices — une forge de test adossée à un VRAI dépôt git local, un vrai `git merge`, une
« CI » qui exécute vraiment le code fusionné) : voir la liste exacte des tests dans la décision 0059 § 9, à jour à chaque
incrément.

**Hypothèses (non prouvées en réel)** : les plafonds d'usage de l'abonnement supportent 3 sessions cloud simultanées sur
ce dépôt ; GitHub déclenche la CI sur `claude/integration/**` en temps utile (le motif `claude/**` de `ci.yml` le couvre,
vérifié par lecture) ; `main` n'autorise pas l'avance fast-forward directe (protection) — alors la fusion passe par la PR
de la branche d'intégration au SHA attendu, précédée du contrôle de tête, avec une fenêtre résiduelle de quelques
millisecondes entre le contrôle et la fusion (la CI de `main` sur le commit de fusion la couvre) ; la taille des conteneurs
Managed Agents pour cet ERP ; les coûts Managed Agents (estimés, § 3). Le banc réel (`scripts/bench/equipe-reel.ts`) est
prêt mais ne se lance qu'avec le feu vert du parent.
