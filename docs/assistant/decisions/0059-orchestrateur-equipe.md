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

## 2. Travailleurs — port unique, trois adaptateurs
- **Par défaut : Claude Code cloud** (Routines, relais `claude --cloud`) — abonnement de la Direction (décision du
  01/11 : pas de facturation API), un conteneur et une branche par session, ressources suffisantes pour cet ERP.
- **Managed Agents** (API Anthropic, facturée à l'usage, plafond dollar dur par session) : adaptateur ÉCRIT derrière un
  interrupteur COUPÉ (`EQUIPE_MANAGED_AGENTS=1` et `ANTHROPIC_API_KEY`). Appels HTTP directs (`fetch`), comme le
  connecteur des Routines : le dépôt n'embarque pas `@anthropic-ai/sdk` et ajouter une dépendance pour un chemin coupé
  ne se justifie pas ; à basculer sur le SDK le jour où la Direction l'active.
- **Agent SDK auto-hébergé : NON construit.** Facturation API (contraire à la décision du 01/11) ; le worker Render
  (« standard ») et le relais (« starter ») ne peuvent pas faire tourner 3 agents qui compilent (~5 Go chacun) et testent
  (Postgres, 17 000 tests) ; un processus long meurt à chaque déploiement Render. Documenté comme option.
- Coûts estimés par tâche (ORCHESTRATEUR-EQUIPE.md § 3) : cloud ≈ 0 $ d'API (+ MiMo ≈ 0,01–0,03 $ par programme) ;
  Managed Agents ≈ 3–15 $ (estimation, non mesurée).

**À trancher par la Direction** : activer ou non la facturation API (Managed Agents) — rien ne change tant qu'elle ne le
dit pas.

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
24 h, autonomie sur le rouge, `consigne_chantier`. O2 ajoute : `arreter` au port travailleur (Managed Agents :
`user.interrupt` puis archivage ; cloud : impossible, dit) appelé à l'annulation.

## 9. Preuves
Mises à jour à chaque incrément (O2-2 à O2-5) — voir § 10.

## 10. Journal des incréments
- **O2-1** (ce document + ORCHESTRATEUR-EQUIPE.md) : décision et architecture. Rien de prouvé en code à ce stade.
