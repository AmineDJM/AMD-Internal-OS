# 0042 — Le socle des chantiers de développement : Adam supervise Claude Code, GitHub et Render (lot C1, 01/11/2026)

**Lot C1** de l'architecture [CHANTIERS-DEV](../../architecture/CHANTIERS-DEV.md) (L1 « socle des chantiers »). Demande de la
Direction : « Je parle à Adventum IA ; il organise et supervise Claude Code de manière autonome, résout les problèmes et me
livre un résultat fonctionnel et VÉRIFIÉ, sans microgestion. » Terra cerveau, MiMo exécutant, Sol raisonnement avancé,
Claude Code développeur ; optimisation maximale des coûts ; missions parallèles sans aucun conflit ; vérifications
proportionnées au risque ; mémoire technique permanente ; autonomie contrôlée.

S'appuie sur le moteur des travaux (J2 [0016](0016-travaux.md), J8 [0023](0023-delegation.md), K3
[0033](0033-sous-missions.md)) — lui-même le Mission Runtime d'Adam — et sur le journal de consommation K8
([0035](0035-consommation.md)). Le lot C2 (connecteurs GitHub, Render, Claude Code, décision
[0043](0043-connecteurs-chantiers.md)) a publié ses ports dans `src/platform/dev/ports.ts`, plus riches que le contrat
posé au départ : le moteur garde SON contrat (`chantiers/ports-moteur.ts`, le texte d'origine) et une couche
d'adaptation PURE (`chantiers/adaptateur-c2.ts`) y traduit les connecteurs réels — composée dans `scheduled.ts`. Le
moteur n'appelle jamais le réseau lui-même.

> Code : moteur `src/lib/missions/chantiers/` — `plan.ts` (DSL, validation, compilation), `etapes.ts` (les huit
> gestionnaires), `conduite.ts` (`conduireChantier`, réveil des attentes datées, juge des preuves, clôture), `service.ts`
> (proposer, approuver, valider, pause, reprise, annulation, « où en est », battement), `reservations.ts`, `perimetre.ts`,
> `regles.ts` (anti-boucle, budgets, délai croissant), `routeur.ts`, `cerveau.ts`, `dossier.ts` (dossier, juge, rapport),
> `memoire.ts`, `ports-moteur.ts` (contrat du moteur), `adaptateur-c2.ts` (connecteurs C2 → moteur), `ports-dev.ts`
> (point de branchement), `faux-test-outils.ts` (doubles en mémoire, tests seulement) ; connecteurs
> `src/platform/dev/ports.ts` + `src/platform/in-process/chantiers/` (C2) ; passerelle `src/lib/models/mimo.ts` (+ famille `gpt-6` dans `capabilities.ts`, tarif MiMo
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
| `DEV_CORRIGER` | si `verifier.vert = false` : boucle bornée « **Auto-fix d'abord** (une grâce par tour, `autofixMinutes`, 15 min : un commit arrivé SANS relance est vérifié, gratuit) → décider (anti-boucle) → relancer (même session par le relais CLI, sinon commentaire `@claude` dans le fil de la PR, sinon nouvelle session) → attendre → contrôler » | `{ vert: true, sha, tours }` |
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

- **Branchement** : `scheduled.ts` compose `portsDepuisConnecteurs(connecteursDev())` avant chaque balayage. Sans
  `GITHUB_TOKEN`, rien n'est branché et un chantier le dit (« connecteurs non branchés ») ; sans `RENDER_API_KEY`, un
  chantier sans service tourne, un déploiement échoue en le disant ; sans routine pour le dépôt
  (`CLAUDE_ROUTINE_<ALIAS>_DEPOT`, ou une seule routine), le lancement échoue en le disant.
- Ce que les connecteurs C2 n'ont pas : **ouvrir une PR** (Claude Code l'ouvre, sa consigne le dit), **lire un fichier**.
  La **fusion** est faite (§ 10). La santé est un GET public de l'URL du service (adaptateur, 10 s).
- **Relais CLI** (décision de la Direction du 01/11, connecteur de C2) : la correction suit l'ordre décidé — Auto-fix de
  la session (grâce `autofixMinutes`), puis message à la MÊME session par le relais (`envoyerMessage`, s'il est vivant),
  puis commentaire `@claude` dans la PR, puis session neuve ; sans routine pour le dépôt, le lancement passe par le relais
  (`lancerParCli`). Les ordres du relais sont asynchrones : le moteur ne lit pas leur état, il attend le commit (vérité GitHub).
- Webhooks, outils chez Adam, rapport au Drive : faits (§ 10).
- **Parallélisme** : l'unité d'Adam reste « une session principale par chantier, réservations faites » ; les « Projects »
  de Claude Code (une conversation qui coordonne des sessions parallèles) sont une option, non branchée.
- Les sessions Claude Code d'un chantier (id + URL) restent au dossier, au tableau et en mémoire technique (clé
  `branche`), pour leur reparler plus tard ; la consigne demande l'Auto-fix sur la PR (`autoFix` de C2). Relais CLI hors
  ligne sans routine : le lancement attend (essais à délai croissant), il ne bascule pas en échec définitif.
- E2E lourds : jamais par défaut ; la vérification est déterministe (checks CI, santé, journaux).

## 10. Phase 2 (01/11, décisions de la Direction) — la fusion, le réveil par webhook, Adam, le rapport au Drive

**Plafonds par défaut confirmés** : 5 $ par chantier, 20 $ par jour, 4 lancements, 4 déploiements, 3 tentatives, Auto-fix
15 min. **« La fusion sur main : tu la fais une fois que j'approuve. »**

- **Le geste de fusion — `DEV_FUSIONNER`** (au plan type, après `DEV_CORRIGER` ; `fusion: false` le retire ; un service
  qui suit une autre branche que celle du chantier exige une étape `DEV_FUSIONNER` avant son déploiement — refusé à la
  lecture du plan). Quand la PR est verte (checks verts sur le SHA de tête, `mergeable`, tête = SHA vérifié, périmètre
  tenu par `DEV_VERIFIER`), le chantier pose la carte **« Fusionner la PR #n (« titre ») dans <base> — SHA vérifié … »**,
  écrite et ORALE (K4/K9 : la voix relit, « vas-y » suffit — l'outil `valider_chantier` le dit). Validée : l'ERP fusionne
  par l'API GitHub — `fusionnerPr` ajouté au connecteur ForgeGit de C2 (`PUT /repos/{o}/{r}/pulls/{n}/merge` avec
  `sha` = la tête vérifiée → 409 « la tête a bougé » si elle a bougé ; méthode : `CHANTIERS_METHODE_FUSION`, sinon celle
  que le dépôt autorise — merge par défaut). **Refus clair** si la protection de branche l'interdit (405 → « fusion
  refusée : … », blocage, rien n'est déployé). Puis la **CI de la base sur le commit de fusion** : en cours → sondage ;
  aucun check après 6 passages → blocage ; rouge → blocage, incident en mémoire, rien n'est déployé ; verte → le SHA
  vert devient le commit de fusion, et le **déploiement s'enchaîne** : préproduction autonome, **production = sa propre
  carte** (« déployer X en PRODUCTION (SHA vérifié …) »). Un plan qui fusionne ne déploie rien tant que la fusion n'a pas
  abouti ; le juge des preuves refuse « terminé » sans fusion.
- **Réversible (décisions 0040-0044)** : `validerMonChantier` est enveloppée par `actionReversible` et déclarée
  (`effets/declarations/metiers.ts`) ; son inverse métier `lib/chantiers-compensation.ts` : le geste n'a pas encore agi →
  la validation est retirée (ANNULÉ) ; **la fusion a eu lieu → COMPENSÉE par une PR de revert ouverte et proposée**
  (`proposerRevert` du connecteur : mutation GraphQL `revertPullRequest`) — **jamais un force-push** ; sa fusion repasse
  par la validation ; un déploiement / rollback de production fait → IMPOSSIBLE, dit avec le geste qui reste. La même
  compensation est offerte en conversation (`annuler_chantier` avec `annulerFusion`). Reçu `…|revert|<pr>` : une seule PR
  de revert, même demandée deux fois.
- **Le réveil par webhook** : le registre (`events/ledger.ts`) envoie chaque `BusinessEvent` `DEV_*` / `RENDER_*` (C2) à
  `chantiers/reveil.ts` : les chantiers vivants dont le dépôt, la branche (ou la base après fusion), un SHA, la PR, un
  service ou un déploiement est cité voient leurs étapes en attente (`DEV_ATTENDRE`, checks, CI de la base, `RENDER_*`)
  repartir aussitôt, et la boucle courte (10 s) les conduit. Le sondage à pas croissant reste en secours.
- **Les outils chez Adam aussi** : les quatre outils vivent désormais dans `lib/missions/chantiers/outils.ts` (socle) ;
  l'Assistant IA les enveloppe (`infra/chantiers.ts`, une seule arête de dette, celle d'avant), Adam les reçoit en
  `PowerTool` (`lib/assistant/chantier-tools.ts`, `allowed: peutPiloterMissionsAdam`, Super Admin relu par le service).
  **`SOCLE_IA_CEILING` n'est pas relevé** : Adam n'est pas du socle IA de l'Assistant, et le module n'y gagne aucun import.
- **Le rapport final au Drive (dossier « Travaux »)** : à la fin, le rapport est déposé en VRAI document Word par la
  persona de l'Assistant IA (`deposerLivrable`, reçu `…|rapport|document`, reprise sans doublon), inscrit aux livrables
  du carnet ; un chantier lancé depuis la conversation s'inscrit au tour (`travauxLances`) et la synthèse K3 y écrit le
  rapport **avec son lien** (`conclureTour` lit `TRAVAIL` et `CHANTIER`). Composé par `scheduled.ts` (`depsFinChantier`).

## 9. Preuves

- `adaptateur-c2.test.ts` (8) : relais CLI (même session, lancement sans routine) ; fichiers par comparaison, extrait du journal du job, déploiement en file retrouvé par SHA,
  routine du dépôt et clé d'idempotence, relance dans le fil de la PR, `INCERTAIN` jamais relancé.
- `regles.test.ts` (21) : DSL, enchaînements refusés, compilation et condition du moteur, anti-boucle, délai, budgets,
  réglages bornés, routeur, recouvrement, juge des preuves, rapport, MiMo (URL, clé jamais rendue, journal K8, sonde).
- `chantiers.test.ts` (16, vraie base, vrai moteur, ports factices) : Super Admin seul ; succès de bout en bout ; CI rouge
  corrigée au 2ᵉ tour (commentaire `@claude`, aucun modèle payé pour un extrait court) ; Auto-fix : corrigé sans aucune
  relance ; même échec 3× → Sol une fois,
  blocage réel, rien déployé, rapport ; santé 503 → rollback, autoDeploy coupé, conclusion refusée ; production → carte,
  validation orale, fusion, revérification, déploiement ; conclusion REFUSÉE sans preuve de santé ; lancements épuisés →
  `BUDGET_HOLD`, plafond relevé → reprise seule ; deux périmètres recouvrants → le second en file puis parti ; annulation
  et tableau « Missions ». Phase 2 : carte « Fusionner la PR #1 (« … ») dans main », validée à l'oral, fusion au SHA
  attendu, CI de main, puis carte de production distincte ; préproduction autonome après fusion (une seule carte) ;
  fusion refusée par la protection de branche (dit, rien déployé) ; CI de main rouge → rien déployé, PR de revert
  (salarié refusé, une seule PR même redemandée) ; réveil par un fait `DEV_*` (fait étranger ignoré) ; rapport au Drive,
  une fois, aux livrables, conversation prévenue.
- `effets/reversibles-chantiers.test.ts` (2) : `validerMonChantier` exécutée puis annulée — validation retirée avant la
  fusion ; fusion faite → compensée par une PR de revert.
- `processus.test.ts` (2, vrais processus) : deux processus sur la même branche puis sur deux globs recouvrants à la même
  milliseconde → un seul gagnant ; SIGKILL pendant `DEV_ATTENDRE` → reprise de l'orpheline, aucune seconde session
  Claude Code, chantier terminé, réservations libérées.
