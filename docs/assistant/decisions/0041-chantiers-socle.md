# 0041 — Le socle des chantiers de développement : Adam supervise Claude Code, GitHub et Render (lot C1, 01/11/2026)

**Lot C1** de l'architecture [CHANTIERS-DEV](../../architecture/CHANTIERS-DEV.md) (L1 « socle des chantiers »). Demande de la
Direction : « Je parle à Adventum IA ; il organise et supervise Claude Code de manière autonome, résout les problèmes et me
livre un résultat fonctionnel et VÉRIFIÉ, sans microgestion. » Terra cerveau, MiMo exécutant, Sol raisonnement avancé,
Claude Code développeur ; optimisation maximale des coûts ; missions parallèles sans aucun conflit ; vérifications
proportionnées au risque ; mémoire technique permanente ; autonomie contrôlée.

S'appuie sur le moteur des travaux (J2 [0016](0016-travaux.md), J8 [0023](0023-delegation.md), K3
[0033](0033-sous-missions.md)) — lui-même le Mission Runtime d'Adam — et sur le journal de consommation K8
([0035](0035-consommation.md)). Le lot C2 (connecteurs GitHub, Render, Claude Code) tourne en parallèle : il implémente
les PORTS posés dans `src/platform/dev/ports.ts`, que ce lot consomme sans jamais appeler le réseau.

> Code : moteur `src/lib/missions/chantiers/` — `plan.ts` (DSL, validation, compilation), `etapes.ts` (les huit
> gestionnaires), `conduite.ts` (`conduireChantier`, réveil des attentes datées, juge des preuves, clôture), `service.ts`
> (proposer, approuver, valider, pause, reprise, annulation, « où en est », battement), `reservations.ts`, `perimetre.ts`,
> `regles.ts` (anti-boucle, budgets, délai croissant), `routeur.ts`, `cerveau.ts`, `dossier.ts` (dossier, juge, rapport),
> `memoire.ts`, `ports-dev.ts` (branchement de C2), `faux-test-outils.ts` (doubles en mémoire, tests seulement) ; contrat
> `src/platform/dev/ports.ts` ; passerelle `src/lib/models/mimo.ts` (+ famille `gpt-6` dans `capabilities.ts`, tarif MiMo
> posé dans `platform/ia/telemetry/cout-journal.ts`) ; tableau `src/lib/missions/travaux/tableau.ts` (champ `chantier`),
> boutons aiguillés dans `travaux/service.ts` ; module `src/modules/assistant-ia/` — `infra/chantiers.ts` (quatre outils
> de conversation, console), `infra/fil/tour.ts`, `domaine/selection-outils.ts`, `actions-travaux.ts`
> (`validerMonChantier`), `actions-consommation.ts` (`enregistrerReglagesChantiers`), écrans
> `ecrans/missions/tableau-missions.tsx` (bloc chantier) et `ecrans/reglages-chantiers.tsx` ; console
> `/admin/ai#chantiers`. Tâche de fond `chantiers.balayage` + boucle courte des réveils (`scheduled.ts`). Migration
> additive `20270218100000_chantiers_socle`. Bancs : `chantiers/regles.test.ts`, `chantiers/chantiers.test.ts`,
> `chantiers/processus.test.ts` (+ `scripts/bench/chantier-processus.ts`).

## 1. Un chantier est une mission du moteur EXISTANT

`Mission.kind = "CHANTIER"`, `persona = "ADAM"`, `principalId` = le Super Admin (rôle RELU à chaque passage et à chaque
geste ; perdu → pause `DROITS`). Pas de second moteur : `materialiser` écrit les étapes, `avancer` les conduit (bail,
réservation d'étape, reprise d'une orpheline après `BAIL_MS`, `conclure`), `mettreEnPause` / `reprendre` / `annuler`
(famille `CHANTIER` ajoutée à `FamilleMission`) font les gestes, et le tableau « Missions » de K3 les affiche.

Chaque étape compile en nœud **WORKER** dont le gestionnaire (`etapes.ts`) appelle les ports. Le DSL est FERMÉ :

| Étape | Fait | Preuve |
|---|---|---|
| `DEV_LANCER` | dépendances terminées, réservations (tout ou rien), puis UNE session Claude Code sous reçu | session rendue |
| `DEV_ATTENDRE` | sondage de la branche à pas croissant (1 → 10 min), 6 h au plus | SHA neuf |
| `DEV_VERIFIER` | fichiers DANS le périmètre, PR ouverte au besoin, mergeable, checks du SHA de tête | `{ vert, sha, signature }` |
| `DEV_CORRIGER` | si `verifier.vert = false` : boucle bornée « décider (anti-boucle) → relancer (commentaire `@claude` sur la PR, sinon relance) → attendre → contrôler » | `{ vert: true, sha, tours }` |
| `RENDER_DEPLOYER` | preuve verte exigée ; production ou fusion → validation ; fusion, puis **revérification du SHA d'intégration exact** ; service exclusif ; ERP avant app/worker | statut `live` sur le SHA vert |
| `RENDER_VERIFIER` | `healthCheckPath` 200..399 (essais à 30 s croissants), < 3 erreurs au journal depuis le déploiement | `{ sain }` |
| `RENDER_ROLLBACK` | si `sain = false` : production → validation ; dernier déploiement sain antérieur, suivi, **autoDeploy coupé** (dit) | rollback `live` |
| `RAPPORT` | composé par le CODE depuis le dossier ; mémoire technique alimentée ; réservations libérées | SHA, checks, live, santé, coût |

Le plan type (sans `etapes`) est posé par `etapesParDefaut` : services triés ERP d'abord. La compilation refuse : type hors
catalogue, branche = base ou `main`, périmètre vide, déploiement avant `DEV_VERIFIER`, `DEV_CORRIGER` avant
`DEV_VERIFIER`, `RENDER_VERIFIER`/`ROLLBACK` sans déploiement du même service, app avant ERP, première étape autre que
`DEV_LANCER`, dernière autre que `RAPPORT`.

**Le DAG ne boucle pas** : la correction vit DANS `DEV_CORRIGER` (son état — phase, tour, base, échec — est sa sortie
`WAITING`), le rollback est une étape conditionnelle (`when` du moteur sur `sain`). Chaque étape dépend aussi de
`DEV_LANCER` : un amont abouti laisse partir le nœud de synthèse même quand un intermédiaire est mort, et c'est le
**gestionnaire** qui se garde par les preuves (aucun déploiement sans vert : `SKIPPED` dit). Ainsi le RAPPORT part
toujours ; et si le chantier finit autrement (blocage, échec, annulation) sans rapport, `clore` l'écrit quand même.

**Attendre n'est pas échouer** : un check en cours, une réservation tenue, une validation attendue rendent `WAITING` avec
`reessayerA` ; `remettreEnFile` (début de chaque conduite) remet en `READY` les attentes échues, compteur du moteur à
zéro — un sondage n'use pas les tentatives. Les essais MÉTIER (port en échec, santé) se comptent dans la sortie
(`essais`), bornés par la console, à délai croissant.

**Aucun geste deux fois** : lancement, relance (par tour), fusion, déploiement, rollback passent par un reçu
`TravailEcriture` (réclamé avant, clos après). Un reçu INTERROMPU (SIGKILL entre le geste et le résultat) n'est jamais
rejoué à l'aveugle : le lancement s'en remet à GitHub, le déploiement retrouve le sien chez Render par le SHA, la fusion
et le rollback échouent en le disant.

## 2. Réservations — l'absence de conflit Git n'est pas l'absence de conflit fonctionnel

`ChantierReservation` (clé unique) : `BRANCHE:<dépôt>:<branche>`, `PERIMETRE:<dépôt>:<glob>`, `MIGRATIONS:<dépôt>`,
`DEPLOIEMENT:<service>`. La demande entière passe dans UNE transaction sous verrou consultatif (le recouvrement de globs,
jugé CONSERVATEUR par `perimetre.ts`, ne s'exprime pas en contrainte) ; la contrainte d'unicité reste le dernier mot.
Un conflit SÉRIALISE (le chantier attend en file, c'est dit au tableau) ; il n'échoue jamais. Expiration 6 h, prolongée à
chaque passage (un chantier mort libère seul). Un déploiement d'app ou de worker attend tant qu'un AUTRE chantier tient
`MIGRATIONS:<dépôt>` (ERP d'abord). Dépendances entre chantiers : `plan.dependances` (le premier annulé fait échouer le
second, en le disant). Avant tout déploiement d'un service qui suit une autre branche (`main`), la fusion validée est
suivie d'une **revérification des checks sur le SHA d'intégration EXACT** — c'est là qu'apparaît le conflit fonctionnel
de deux chantiers fusionnés ; rouge → blocage dit, rien n'est déployé.

## 3. Routeur de modèles et MiMo

`routeur.ts` (pur) : **déterministe** (statut, HTTP, commit, extrait ≤ 1 500 caractères transmis tel quel) → **MiMo**
(lecture longue, rédaction ; relu par Terra si risque haut) → **Terra** (décision) → **Sol** (escalade ou arbitrage
seulement). Un modèle absent fait DESCENDRE vers le moins cher, jamais monter. Le cerveau (`cerveau.ts`) exécute sous
`sousImputation({ missionId, feature: "chantier" })` : chaque appel entre au journal K8 au nom du chantier ; le coût est
compté sur `Mission.costUsd` (grille `tarifs.ts` pour Terra/Sol).

MiMo (`src/lib/models/mimo.ts`, dans la passerelle — cliquet `passerelle-unique.test.ts` inchangé) : OpenAI-compatible
`POST {base}/chat/completions`, clé `process.env.mimo` (sinon `MIMO`, `MIMO_API_KEY`) jamais rendue (les erreurs sont
expurgées), base `MIMO_BASE_URL` (défaut `https://token-plan-ams.xiaomimimo.com/v1`), modèle `MIMO_MODEL` (défaut
`mimo-v2.6-pro`, **À CONFIRMER** par `sonderMimo` → `/v1/models`, que la page Développement de C2 affiche). Tarif non
publié : `MIMO_PRICE_IN` / `MIMO_PRICE_OUT` s'ils sont posés, sinon coût INCONNU (`null`, jamais 0) — `cout-journal.ts`
lit ces deux variables pour le rôle `mimo`. Sol = `gpt-6.1-sol`, Terra = `gpt-6.1-terra` (déjà sur la grille ; famille
`gpt-6` ajoutée aux fiches de capacités, mêmes paramètres que Terra 5.6, porte Responses).

**Escalade** (`deciderAntiBoucle`) : signature d'échec = étape | check | première ligne d'erreur normalisée (ni SHA, ni
nombres, ni horodatage, ni chemin temporaire). 1ʳᵉ occurrence → corriger ; 2ᵉ → **Sol une fois** (s'il a déjà vu cette
signature → blocage) ; 3ᵉ, ou tours épuisés → **blocage réel**, incident en mémoire, rapport.

## 4. Budgets et anti-boucle — dans la console existante

`AppSetting.chantiersReglages` (Administration › IA › « Chantiers de développement », Super Admin, audité) : dollars par
chantier (défaut 5 $, ou `plan.budget.usd`), lancements Claude Code (4) et déploiements (4) par chantier, tentatives par
étape (3), plafonds GLOBAUX du jour (20 $ — journal K8 `feature = "chantier"` —, 20 lancements, 12 déploiements, heure
d'Alger), chantiers en parallèle (3). Un plafond est relu AVANT chaque vague et AVANT chaque lancement / déploiement ; il
mord → pause **`BUDGET_HOLD`** (le mécanisme des travaux, même état affiché « Plafond atteint ») + notification ; relevé,
le chantier reprend SEUL au passage suivant. Aucune action de réglage n'est appelable par l'IA (exclusions du registre).

## 5. Mémoire technique

`MemoireTechnique` (`type` ∈ depot | service | branche | decision | dependance | incident, `cle`, unique) : écrite à la fin
d'un chantier (dépôt : branche de base et commandes de vérification ; branche : issue), à la santé (service : URL, santé,
autoDeploy), aux blocages, échecs de déploiement et rollbacks (incidents), et par `noterEvenementDev` (point d'entrée des
webhooks de C2). Lue par EXTRAITS (`extraitMemoire` : clés exactes + 5 incidents du dépôt, ≤ 2 000 jetons) dans la
consigne de Claude Code — jamais toute la mémoire.

## 6. Le tableau « Missions » (K3) — pas d'écran parallèle

`tableauDesTravaux` couvre `kind IN (TRAVAIL, CHANTIER)` (même cloisonnement `principalId`, même signature SSE). Un
chantier y porte `chantier` : dépôt, branche, réservations, liens des sessions Claude Code et de la PR, SHA vert,
déploiements (statut, commit, sain, rollback), compteurs, blocage, validations attendues ; chaque étape a son libellé
(« Vérification », « Correction »…) et ses essais ; l'attente dite est celle du moteur (« en file : le périmètre … »,
« checks en cours sur abc1234 »). Pause, reprise, annulation : les MÊMES boutons, aiguillés vers le service des chantiers
(`siChantier`). La carte de validation (Valider / Refuser) s'affiche quand un geste attend.

## 7. Conversation et autonomie contrôlée

Outils de l'Assistant IA (Adventum IA), offerts au **Super Admin seul** : `lancer_un_chantier` (Terra rédige la consigne
technique — objectif, périmètre, critères, commandes ; la demande de la Direction VAUT approbation du plan),
`ou_en_est_chantier`, `valider_chantier` (« valide / déploie / fusionne / refuse », sur les mots EXPLICITES de la
Direction, écrit ou ORAL — canal tracé), `annuler_chantier` (annuler ou suspendre). Validation exigée au moment d'agir :
**déploiement en production, fusion sur main, rollback de production** (et, annoncés sur la carte du plan, la migration ;
une migration destructive se reconnaît par `migrationDestructive`). Seule une validation ATTENDUE peut être donnée.
Autonome : réserver, lancer et relancer Claude Code, ouvrir et commenter une PR, déployer hors production, rollback hors
production. Annuler n'arrête pas une session déjà lancée (aucune API ne le permet) : c'est dit, et rien ne sera déployé.
Le RAPPORT revient par notification et par `ou_en_est_chantier` ; l'envoi par WhatsApp passe par l'outil des canaux (K6)
à la demande.

## 8. Ce qui reste hors de ce lot (dit, pas caché)

- **Les adaptateurs réels** (GitHub, Render, Routines Claude Code, commentaire `@claude`) sont le lot C2 : ils se
  branchent par `brancherPortsDev(() => ({ agent, forge, hebergeur }))` (`chantiers/ports-dev.ts`). Tant que rien n'est
  branché, un chantier ne part pas et le dit (« connecteurs non branchés »).
- Les webhooks signés GitHub/Render → `BusinessEvent` → réveil : C2 ; ce lot sonde (pas croissant) et expose
  `noterEvenementDev` + `signalerReveilChantier`.
- Adam (persona `ADAM` historique, `src/lib/assistant/`) n'a pas encore les quatre outils : ils sont dans l'Assistant IA,
  la conversation de la Direction (Adventum IA). L'oral passe par la délégation vocale existante.
- Le dépôt du rapport au Drive en document (comme un livrable de travail) n'est pas fait : le rapport est au dossier, au
  tableau et en notification.
- E2E lourds : jamais par défaut ; la vérification est déterministe (checks CI, santé, journaux).

## 9. Preuves

- `regles.test.ts` (21) : DSL, enchaînements refusés, compilation et condition du moteur, anti-boucle, délai, budgets,
  réglages bornés, routeur, recouvrement, juge des preuves, rapport, MiMo (URL, clé jamais rendue, journal K8, sonde).
- `chantiers.test.ts` (10, vraie base, vrai moteur, ports factices) : Super Admin seul ; succès de bout en bout ; CI rouge
  corrigée au 2ᵉ tour (commentaire `@claude`, aucun modèle payé pour un extrait court) ; même échec 3× → Sol une fois,
  blocage réel, rien déployé, rapport ; santé 503 → rollback, autoDeploy coupé, conclusion refusée ; production → carte,
  validation orale, fusion, revérification, déploiement ; conclusion REFUSÉE sans preuve de santé ; lancements épuisés →
  `BUDGET_HOLD`, plafond relevé → reprise seule ; deux périmètres recouvrants → le second en file puis parti ; annulation
  et tableau « Missions ».
- `processus.test.ts` (2, vrais processus) : deux processus sur la même branche puis sur deux globs recouvrants à la même
  milliseconde → un seul gagnant ; SIGKILL pendant `DEV_ATTENDRE` → reprise de l'orpheline, aucune seconde session
  Claude Code, chantier terminé, réservations libérées.
