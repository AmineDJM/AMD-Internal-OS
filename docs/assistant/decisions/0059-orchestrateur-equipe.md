# 0059 — Orchestrateur d'équipe : programmes, travailleurs parallèles, file d'intégration (02/11/2026)

**Demande de la Direction (02/11/2026, résumé fidèle)** : Adam (Terra, cerveau, dialogue) délègue à MiMo 2.6 Pro
(superviseur technique : décompose, planifie, délègue, coordonne, résout, contrôle la qualité) qui gère une équipe de
travailleurs Claude Code en parallèle quand c'est utile ; GitHub et Render pour l'intégration et l'infra. Priorités :
correction → fiabilité → autonomie → coût → vitesse. Prévenir les conflits avant qu'ils n'arrivent — « verrous et
worktrees ne suffisent pas » — avec une file d'intégration sérialisée validée contre la dernière révision de la cible.

Elle complète [0042](0042-chantiers-socle.md), [0043](0043-connecteurs-chantiers.md) et
[0058](0058-chantiers-autonomes-et-consignes.md). Architecture : [ORCHESTRATEUR-EQUIPE.md](../../docs/architecture/ORCHESTRATEUR-EQUIPE.md).

## 1. Ne pas reconstruire
Le moteur des chantiers reste le seul moteur d'exécution (une session Claude Code par chantier, baux, reçus,
réservations, webhooks, vérification déterministe). O2 ajoute au-dessus : le **programme** (mission parente), son **DAG**
validé par le code, un **ordonnanceur** déterministe, les **ressources nommées**, la **file d'intégration** et le tableau.

## 2. Travailleurs — sessions cloud Claude Code SEULEMENT (Direction, 02/11 et 03/11)

**Décision de la Direction (verbatim)** : « Abonnement, garde les sessions cloud seulement. »
- **Le seul adaptateur : les sessions cloud Claude Code** — Routines (`/v1/claude_code/routines/{id}/fire`), relais
  `scripts/relais-claude.ts` (`claude --cloud`, `claude -p --cloud <id>`), commentaire `@claude` (lot C2). Abonnement
  de la Direction, un conteneur et une branche par session, ressources suffisantes pour cet ERP.
- Le **port « Travailleur »** (`equipe/travailleurs.ts`) reste une abstraction propre (lancer, envoyer à la même
  session, état, arrêt) avec ce seul adaptateur ; état et arrêt n'existent pas sur l'abonnement : refusés et DITS.
- **Écartés, et pourquoi** : **Managed Agents** (API Anthropic facturée à l'usage) et **Agent SDK auto-hébergé**
  (facturation API, et le worker Render « standard » comme le relais « starter » ne peuvent pas faire tourner 3 agents
  qui compilent (~5 Go chacun) et testent (Postgres, 17 000 tests) ; un processus long meurt à chaque déploiement).
  Raison de la Direction : l'**abonnement**. Un premier adaptateur Managed Agents, écrit derrière un interrupteur coupé
  au début de ce lot, a été RETIRÉ entièrement (03/11) ; un plan qui demande un autre travailleur est refusé.
- **Coûts** : une session cloud n'a pas de coût en dollars par appel. Ce qui se mesure et se plafonne : les sessions
  lancées (quota glissant des Routines : 30/h par routine, 100/h par compte — l'ordonnanceur ne dépasse jamais
  `EQUIPE_SESSIONS_HEURE_MAX`, défaut 25, borné à 90), leur durée, les tentatives (relances et renvois), et à part les
  DOLLARS de MiMo/Sol/Terra (journal K8 `ModelCallLog`) : planification (programme) et résumés/arbitrages (chantiers).
  Affichés séparément, jamais additionnés.

## 3. MiMo = planificateur et juge APPELÉ À LA DEMANDE
Décompose un programme en tâches (DAG) avec critères d'acceptation, commandes de vérification, périmètres et ressources ;
replanifie sur événement (conflit, échec répété, dépendance cassée). Sortie JSON stricte, relue par un **validateur
déterministe** (cycles, clés, périmètres vides, recouvrements, critères vérifiables, budget, aucun déploiement). Deux
essais (le second reçoit les fautes), puis **Sol en recours**. Terra seul parle à la Direction. Aucune boucle de
surveillance par LLM.

## 4. Programme = mission parente
`Mission.kind = "PROGRAMME"`, enfants = chantiers (`parentMissionId`). L'ordonnanceur lance en parallèle les tâches sans
dépendance non intégrée ni ressource commune avec une tâche non intégrée, dans la limite de concurrence (défaut 3) et du
budget ; sérialise sinon ; regroupe une chaîne de petites tâches liées en une seule session. Un chantier enfant n'a pas
d'étape de fusion ni de déploiement : son travail passe par la file.

## 5. Ressources partagées nommées
Au-delà des globs : `SCHEMA` (prisma/schema.prisma, migrations), `CONTRAT` (contrat des actions, capacités), `API`
(src/app/api), `DEPENDANCES` (package.json, lockfile), `GENERES` (fichiers générés), `MODULE:<m>` (src/modules/<m>).
Déclarées par le plan (et déduites des globs), **réservées** (`RESSOURCE:<dépôt>:<nom>`, exclusives), **vérifiées au
diff** : toucher une ressource non réservée rend la tâche rouge (« hors ressources réservées ») et le programme replanifie.

## 6. File d'intégration par branche cible
Table `IntegrationFile`. Une entrée par (chantier, SHA). Une seule entrée active par (dépôt, cible) — index unique
partiel, la base tranche. Étapes : tête actuelle → branche `claude/integration/<cible>/<n>` → fusion de la branche de la
tâche → CI complète sur le résultat (dont régénération des fichiers générés sans écart) → si vert et cible inchangée :
avance fast-forward (CAS) de la cible, ou carte de validation pour `main` ; cible bougée → on recommence ; conflit limité
aux fichiers générés / lockfile → consigne de régénération ; autre conflit ou CI rouge → la tâche retourne à la MÊME
session avec le conflit, travail préservé. Jamais deux fusions concurrentes, jamais une fusion sans CI verte sur la tête
exacte. La merge queue native de GitHub est une alternative documentée, non retenue (portabilité, tests, ressources
nommées, retour au travailleur).

## 7. Sécurité et permissions — par contrôle d'exécution
Super Admin seul (relu à chaque geste) ; les travailleurs n'ont que leur branche `claude/…` ; l'écriture de refs par la
file est gardée (`gardeEcritureRef`) ; un programme ne déploie pas ; production et `main` sous carte ; MiMo n'est jamais
seule autorité ; budgets (dollars, lancements) appliqués avant chaque lancement ; réversibilité K10 : un programme
s'annule (enfants annulés, réservations libérées) et une intégration se compense par une PR de revert.

## 8. Correctifs de l'audit
Pris de C2 (fusionnée) : lancement par le relais seul, identifiant de session réel, budget du plan, migrations gardées,
24 h, autonomie sur le rouge, `consigne_chantier`. Annuler une session cloud reste impossible (aucune API) : c'est dit,
et rien de ce qu'elle pousse n'est intégré.

## 9. Preuves — ce qui est TESTÉ (base locale, ports factices, aucun appel réel à Anthropic, GitHub ou Render)

La forge de test est un **vrai dépôt git** sur disque (`chantiers/integration-test-outils.ts`) : vrais commits, vraie
fusion (`git merge-tree`), avance en compare-et-échange (`git update-ref <ref> <neuf> <ancien>`), et une « CI » qui
EXÉCUTE le code du SHA (`node verif.mjs` : chaque module se charge, le fichier généré est à jour).

| Exigence | Test | Ce qui est vérifié |
|---|---|---|
| (1) 3 travailleurs indépendants en parallèle | `equipe/programme-base.test.ts` « TROIS travailleurs… » | 3 chantiers enfants ; le faux agent mesure **3 lancements simultanés** ; repasser ne lance rien de plus ; réservations passées au programme |
| (2) tâches qui se recouvrent coordonnées | `programme-base.test.ts` « deux tâches qui SE RECOUVRENT », `programme.test.ts` (ordonnanceur) | une seule part, l'autre « sérialisée après … » jusqu'à l'INTÉGRATION de la première ; ressources nommées (CONTRAT) et migrations sérialisées aussi |
| (3) complétions simultanées sans course | `equipe/processus.test.ts` « DEUX complétions simultanées, deux processus » ; `integration.test.ts` « deux prises SIMULTANÉES » | deux PROCESSUS à la même milliseconde : la seconde intégration commence après l'avance de la première, 2 avances, 1 fusion, cible linéaire et verte ; la base refuse une 2ᵉ entrée active (P2002) |
| (4) reprise après coupure | `processus.test.ts` « SIGKILL après la fusion… » | processus tué entre la fusion et l'écriture de l'état ; le suivant (bail échu) retrouve la fusion dans git, **aucune seconde fusion**, une seule avance |
| (5) incompatibilité que Git ne signale pas | `integration.test.ts` « A renomme `f`, B appelle `f` » ; `programme-integration.test.ts` | chacun vert seul, `merge-tree` sans conflit ; la CI du résultat intégré échoue (« does not provide an export named 'f' ») → RENVOYÉE, la cible ne reçoit jamais B ; de bout en bout : renvoi à la MÊME session, correction, réintégration |
| (5 bis) fichiers générés | `integration.test.ts` « deux tâches qui ne se gênent qu'au fichier GÉNÉRÉ » | conflit limité au contrat → renvoyé avec la recette `npm run actions:contrat` ; la CI réelle régénère contrat ET classement et échoue s'ils changent (`ci.yml`) |
| (6) budget, permissions, interdiction de déployer | `programme-integration.test.ts` « BUDGET », `programme-base.test.ts` « PERMISSIONS », `travailleurs.test.ts`, `integration.test.ts` « main PROTÉGÉE », « la GARDE », `programme.test.ts` « refuse tout déploiement » | plafond atteint → BUDGET_HOLD, aucun lancement ; salarié refusé (lancer, valider) ; tout travailleur autre que les sessions cloud refusé ; quota horaire des sessions ; un programme ne déploie ni ne fusionne seul (chantier sans service ni DEV_FUSIONNER) ; main n'avance qu'après la carte ; la garde refuse toute écriture hors `claude/integration/…` et de la cible |
| (7) intégré aux Missions d'Adam | `programme-integration.test.ts` | lancé par l'outil `lancer_un_programme` ; `tableauDesTravaux` montre le programme (tâches, file, avancement 3/3) et ses 3 chantiers enfants |
| Validateur et planificateur | `programme.test.ts` | cycles, dépendances inconnues, périmètres vides, critères vagues, budget, déploiement ; MiMo refusé → 2ᵉ essai AVEC les fautes → Sol ; dépôt et cible imposés par la demande |
| Connecteur GitHub (gestes neufs) | `platform/in-process/chantiers/connecteurs.test.ts` « les gestes de la file d'intégration » | chemins, corps et codes exacts (201/204/409/422), fast-forward seul (`force: false`), branche protégée = INTERDIT |

**Non prouvé en réel (hypothèses)** : sessions Claude Code cloud simultanées sur l'abonnement (plafonds d'usage) ; CI
GitHub déclenchée sur `claude/integration/**` (motif `claude/**` de `ci.yml`, lu, pas observé) ; avance de `main`
(protégée ?) — sinon fusion par la PR de la branche d'intégration, qui suppose que la PR existe (la file ne l'ouvre pas :
`ouvrirPr` n'est pas porté par les connecteurs) ; webhooks qui réveillent un programme (le battement d'une minute et la boucle courte des réveils le
conduisent ; les faits `DEV_*` réveillent ses chantiers, dont la fin réveille le programme). Banc réel prêt, non lancé :
`scripts/bench/equipe-reel.ts` (feu vert, dépôt de banc dédié, jamais main).

## 10. Journal des incréments
- **O2-1** : cette décision + ORCHESTRATEUR-EQUIPE.md (C2 fusionnée, non recodée).
- **O2-2** : programme (mission parente `kind PROGRAMME`), plan + validateur déterministe, ressources nommées
  (réservées, vérifiées au diff), ordonnanceur, planificateur MiMo (repli Sol), port travailleur (sessions cloud seulement ;
  l'adaptateur Managed Agents un temps écrit derrière un interrupteur coupé est retiré, décision du 03/11), quota horaire
  des sessions, coûts par nature, plafond relevé par consigne, outils `lancer_un_programme`, `ou_en_est_programme`, `consigne_programme`, `annuler_programme` ; migration
  `20270232000000_o2_file_integration`.
- **O2-3** : file d'intégration (`integration.ts`, `integrateur.ts`), gestes GitHub (`creerBranche`, `supprimerBranche`,
  `fusionnerBranches`, `avancerBranche`), outil `valider_programme`, CI des fichiers générés.
- **O2-4** : tableau « Missions d'Adam » — bloc programme (tâches, travailleurs, dépendances, conflits, file, coûts par
  rôle), signature du flux SSE qui suit la file.
- **O2-5** : preuves (§ 9), banc multi-processus `scripts/bench/equipe-processus.ts`, banc réel prêt.

**Décisions à prendre par la Direction** : (a) tranchée le 02-03/11 : sessions cloud seulement ; (b) protection de
`main` : autoriser l'avance fast-forward par le jeton de l'ERP, ou exiger la PR (alors une PR d'intégration à ouvrir) ;
(c) la merge queue native de GitHub n'est pas activée — la nôtre la remplace.
