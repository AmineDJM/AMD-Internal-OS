### Chemin générique — Adam appelle n'importe quelle action de l'ERP

| Fichier | Rôle |
| --- | --- |
| `src/lib/actions/contrat.ts` | **Pur.** Dérive le contrat d'une action depuis sa source : champs, types, obligatoires prouvés, valeurs admises, modèle DÉSIGNÉ (relation Prisma), modèles écrits, forme d'appel (6). Dit son ignorance (`illisible`) au lieu de deviner. Lit un OBJET littéral, les LECTEURS LOCAUX, la DÉLÉGATION à une fonction du fichier et les défauts LITTÉRAUX ; le détecteur de dynamisme s'arme sur le RÉCEPTEUR — **691/715 décrites (97 %)** — TOUT-OU-RIEN, parce qu'un appel positionnel mal lu ne dégrade pas, il DÉCALE ; et un paramètre portant l'identité de l'ACTEUR ferme la signature. |
| `src/lib/cibles/resoudre-entrees.ts` | Le pont « nom humain → ligne de la base » du chemin générique : `resoudreCible` sous la portée de la personne, l'ANNUAIRE pour les personnes, substitution montrée sur la carte, refus avec candidats sur une ambiguïté, passage tel quel DIT quand rien ne se lit à coup sûr. |
| `src/lib/actions/contrat-scan.ts` | La lecture du parc (disque + énums du schéma) — la seule pièce qui touche `fs`. |
| `src/lib/actions/contrat.genere.json` / `.ts` | L'artefact (données) et son module de chargement. Régénérés par `npm run actions:contrat`, redérivés et comparés par `contrat.test.ts`. |
| `src/lib/actions/generique.ts` | **Pur.** Ce qui est refusé au chemin générique — **DEUX faits d'armement** : le modèle ÉCRIT (auto-escalade) et le FICHIER (`SURFACES_HUMAINES` : les attestations de Mission Control et les interrupteurs d'Adam délèguent leur écriture, donc aucun modèle ne les trahit). Un TROISIÈME refus vit côté Adam (`refusDuCheminGenerique`, dans l'op) : la décision EXCLUDED du registre de parité, qui n'était lue par personne — 95 actions exclues sur 125 restaient appelables (§118.158). Plus la validation d'une entrée contre son contrat, `argumentsDAppel` (les 6 formes d'appel décidées en UN endroit exhaustif — un `never` final refuse de compiler si l'on en ajoute une sans dire comment l'appeler), et la découverte par recouvrement de mots. |
| `src/lib/actions/executer.ts` | Appelle l'action de l'ÉCRAN — par formulaire, par état+formulaire, sans entrée, ou **positionnellement** pour les entrées typées. Ne vérifie aucun droit lui-même ; lit l'échec déclaré des actions qui écrivent. |
| `src/lib/actions/aiguillage.genere.ts` | Table d'aiguillage : un spécificateur littéral par fichier, chargé paresseusement. Écartée du scan Graphify (voir `scripts/graphify-refresh.sh`). |
| `src/platform/in-process/capacites/` | Le **port** : la seule porte par laquelle Adam atteint tout cela. Réexporte, n'ajoute aucune logique. |
| `src/lib/assistant/ops/impl-capabilite.ts` | L'op `capability_operation.run` — propose une carte de confirmation, puis exécute **et RELIT**. Son refus fait la découverte. `refusDuCheminGenerique` réunit les trois faits de `generique.ts` et la décision EXCLUDED du registre (`action-registry.ts`), lue à la fiche, à la proposition ET à l'exécution — qui relit avant d'appeler l'action. Trois phrases possibles, jamais « fait » tout court : ce qui a été constaté, ce qui a été fait sans pouvoir être constaté, ou l'échec. |
| `src/lib/assistant/ops/exclusions-generique.test.ts` | Le banc de la décision EXCLUDED : toute action exclue et lisible est refusée en citant sa raison, **rien d'autre n'est refusé en plus** (les deux sens), proposition et exécution refusent par le vrai point d'entrée, la règle est lue aux trois portes, et l'op reste le **seul** appelant de production de `executerAction`. |
| `src/lib/assistant/ops/capabilite-parc.test.ts` | Le banc du PARC : les **583** actions ouvertes (sur 755 lisibles ; 172 refusées par conception, dont les décisions EXCLUDED depuis §118.158) passent par la carte de confirmation, entrée fabriquée depuis leur propre contrat, zéro écriture. Tient trois propriétés — ce que le contrat déclare suffisant est accepté, chaque carte porte l'action visée et ce qu'elle touche, aucune action refusée par conception ne construit de carte. |
| `src/lib/cibles/relire.ts` | La relecture APRÈS écriture (§104.16 : « c'est fait » n'est pas une preuve). Identifiant lu sur le RETOUR d'abord (une création n'en a pas en entrée), entité DÉRIVÉE du modèle écrit, lecture par `porteeEntite` + `canReadEntity` — le chemin de l'écran, jamais un accès privilégié. `null` quand la ligne ne se désigne pas à coup sûr, et l'appelant le DIT. |

### Mission Runtime (`src/lib/missions/`) — façade L2

| Fichier | Rôle |
|---|---|
| `ports.ts` | Les seuls seams : catalogue de capacités, exécutant, **raisonneur**, horloge, **enquêteur** (`Situation`) et **porte d'attention** (`PorteAttention`, signaux typés). Le runtime n'importe JAMAIS `assistant/` ni `models/` |
| `model/roles.ts` | §4 — la politique de modèles en RÔLES métier (`CHEAP_WORKER` → `EXCEPTIONAL_PLANNER`). Aucun nom de modèle dans le métier |
| `planner/schema.ts` | Le JSON Schema STRICT du plan : `additionalProperties: false`, `required` exhaustif, aucun objet libre |
| `planner/plan.ts` | Objectif → capacités résolues → schéma imposé → plan RECONSTRUIT et typé. Refuse un plan sans étape ou sans critère. Rend `metriques.voie` (`DIRECTE`/`MODELE`). `rendreSituation` : la situation établie par le code (entités, faits, acteurs, sources en échec) rendue au planificateur ; `capacitesImposees` : les capacités du domaine imposées au schéma |
| `planner/direct.ts` | Le chemin DIRECT : le CODE planifie sans modèle — TROIS formes : lecture nue à capacité dominante ; RECHERCHE multi-sources (terme cité « … » → N recherches parallèles + conclusion, critères tout-`[REGLE:…]`, 0 juge) ; FICHE ciblée v2 (terme cité + 1-2 familles nommées → RECHERCHER → CIBLER (ids recopiés) → LIRE (éventail `read_document`/`inspect_record`, repli recherche-seule) → RÉPONDRE ; 3 règles + 1 critère sémantique JUGÉ, §28). Verrous R1–R5 / F1–F6 ; « lecture nue » exclut les contrats CONTENU ; sur doute, chaque forme RENONCE au planner |
| `planner/validate.ts` | La revérification de conformité, utilisée en production ET par le raisonneur scripté des bancs |
| `registry/resolve.ts` | §3 — pas de déversement d'outils : un tour de rôle par domaine, borné, mesuré (`plannerCapabilitiesExposed`) |
| `runtime/worker.ts` | L'étape qui RÉDIGE : faits établis, contexte partagé vs spécifique, économie mesurée ; `hydraterEventail` — un worker aval d'un éventail reçoit les résultats des FILLES, pas seulement `{expanded}` |
| `runtime/control.ts` | §39-40 — la main humaine : suspendre, reprendre, arrêter. Cloisonné par `ownerId` dans le `where`. Gestes de MASSE (§118.132) : `mettreEnPauseToutes`, `arreterBloquees`, `compterPourLesGestesDeMasse` sur les prédicats uniques `ouSuspendable` / `ouBloquee` |
| `lib/interrupteurs/missions.ts` | §118.132 — L'INTERRUPTEUR GLOBAL des missions (`AppSetting.missionsPaused`) : `lireInterrupteurMissions` (le vrai lecteur, injectable pour les bancs — défaut le vrai), `suspendreMissions` / `leverSuspensionMissions` (idempotents, la date reste celle de la première pose), `phraseSuspension` (le refus qui nomme l'écran qui lève). Lu par le moteur à chaque tour, le battement, le pilote d'horizon et `lancerMission` |
| `runtime/replan.ts` | §118.42 / §118.132 — quand une mission mérite un plan de plus : `peutReplanifierMission` (PREMIER / PROGRES / REPETITION / PLAFOND / DEJA_BLOQUE), `signatureDuRefus` (codes du compilateur), `REFUS_JUGE` (la signature d'un refus de juge — un second refus de juge sur le plan corrigé est une RÉPÉTITION), `PLANS_MAX_PLAT` |
| `view/workspace.ts` | L'écran d'UNE mission, construit par le serveur : étapes réelles (les filles d'un éventail, jamais leur modèle), livrables avec l'état de leur CONTRÔLE, **horizon** (jalons, résultat attendu, `franchis`/`aboutis`/`ecartes`), pause, attente actionnable. Aucun modèle : l'état est en base, donc exact |
| `view/control.ts` | Le PARC (§118.50) : `centreDeMissions` (compte exact en UNE requête SQL, éventails et étapes contournées écartés ; ce qui attend une personne en tête), `journalDeMission` (bruit du moteur nommé et COMPTÉ, genre inconnu affiché), `attentesDeMission` (toutes, avec de qui et combien de relances), `lecturesAgeesDeMission` (la fraîcheur, §118.41) |
| `view/duree.ts` | « il y a 3 j », « dans 4 h » — module PUR, zéro import, « maintenant » en argument : une durée se lit, un âge en heures se décide |
| `horizon/jalon.ts` `budget.ts` `fraicheur.ts` `modification.ts` | Le socle PUR de la mission longue : frontière et avancement des jalons, budget local jugé au progrès, empreinte de fraîcheur et âges crédibles, empreinte d'une modification (profondeur × cardinalité) |
| `horizon/store.ts` | La persistance des jalons et des entrées datées — ré-entrante, idempotente par empreinte |
| `goal/qa.ts` | Le contrôle arithmétique complet : cardinalité, destinataires, reçus, doublons, artefacts |
| `goal/judge.ts` | §12-13 — le juge structuré (`satisfied`, `confidence`, `criteria[]`, `missing[]`). Un critère sans preuve est NON_DÉMONTRÉ |
| `artifacts/spec.ts` `xlsx.ts` `verify.ts` `render.ts` `build.ts` | Le livrable est CONSTRUIT, puis ROUVERT et CONTRÔLÉ (formules, plages, graphiques) avant d'être déposé |
| `memory/compactor.ts` | Le compacteur réel : le modèle peut enrichir les listes structurées, jamais en retirer |
| `agent/account.ts` | L'espace d'Adam dans l'ERP — SUPER_ADMIN, `isSystem`, et AUCUNE porte de connexion |
| `runtime/state.ts` | Machine à états mission + étape, pure et exhaustivement testée |
| `runtime/store.ts` | Persistance, matérialisation ré-entrante, journal (`MissionEvent`), clé d'idempotence |
| `runtime/engine.ts` | Le moteur : réservation, reprise, retry, éventail, parallélisme borné, conclusion. `dependanceSatisfaite` : une dépendance MORTE laisse passer une synthèse qui a du matériau, jamais une capacité ni une synthèse sans rien ; `bilanDe` + signaux d'attention à la conclusion ; `metaDe` : l'effet d'un reçu vient du catalogue du composeur |
| `runtime/interpolate.ts` | Injection d'un élément d'éventail dans une entrée — pauvre par dessein, sans traversée de prototype — et la TUYAUTERIE `{{cle_etape.chemin}}` : `referencesDe`, `resoudreReference` (plus long préfixe), `diagnostiquerReferences` (OK / étape inconnue / non aboutie / chemin absent avec champs disponibles / liste vide), `injecterSorties` |
| `runtime/condition.ts` | L'étape CONDITIONNELLE, pure : issue d'un amont (EVENT / TIMEOUT / DONE / FAILED / SKIPPED), test de sortie (`comparerValeurs`, `lireChemin` sans prototype), relecture sans confiance |
| `watch/rules.ts` | Les règles d'une SURVEILLANCE, pures : échéance proche / dépassée, silence, blocage, statut, seuil, disparition, changement ; signature STABLE d'un lot de problèmes ; règles par défaut par type de cible |
| `watch/router.ts` | « changement ERP → réveil » : un fait qui touche une cible surveillée avance son prochain contrôle à maintenant (appelé par le registre) |
| `planner/contract.ts` | Ce que le planner a le droit de produire, et les limites opérationnelles ; `StepCondition` (`when`) : l'issue ou la sortie amont qui autorise une étape à partir |
| `compiler/graph.ts` | Tri topologique, vagues, cycles, ancêtres |
| `compiler/compile.ts` | Le refus (capacité inconnue/interdite, cycle, forme, **cardinalité**, **entrée hors contrat** `INVALID_INPUT`, référence vers une étape inexistante, question de confort au demandeur) — dépendances implicites des références `{{…}}`, échéance d'attente référencée acceptée — et la RÉPARATION : clés hors alphabet ASSAINIES (références réécrites), règles à étape fantôme réparées à candidat unique ou déclassées, WAIT_INPUT converti en synthèse sous plafond de lecture (§28). **Créer la mission est un invariant** |
| `registry/capability-meta.ts` | Effet, idempotence, groupabilité, latence, confirmation — défaut prudent SANS liste d'écritures, `READ` avec ; `AUTONOMES` : les écritures autonomes de la conversation (rappels, souvenirs, décisions, engagements, dépôt Drive interne, export) exécutées par le chemin des lectures sous garde d'idempotence — déclarées répétables et SANS accord (même politique que la conversation) |
| `registry/input-contract.ts` | Le CONTRAT D'ENTRÉE d'une capacité, dérivé de son `input_schema` : `contratDepuisSchema`, `decrireEntrees` (la ligne montrée au planificateur), `verifierEntree` (inconnues, manquantes, invalides, réparations de forme), `exempleEntree` (entrée minimale pour les bancs) |
| `policy/guard.ts` | §29 : l'auto-escalade est un refus de compilation |
| `approval/scope.ts` | L'empreinte immuable d'un périmètre (§33) |
| `approval/gate.ts` | La porte fermée par défaut + la notification via le VAPID existant |
| `events/match.ts` | « Ce fait est-il celui que j'attendais ? » — pur, strict par défaut |
| `events/router.ts` | Réveil des missions (idempotent : une progression déjà complète se finalise), attente humaine, attentes échues, file de l'ordonnanceur ; `rattraperFaitAnterieur` : les faits arrivés AVANT l'attente (fenêtre depuis la dernière écriture amont, faits seuls, jamais le temps) |
| `goal/evaluate.ts` | Contrôle qualité arithmétique + satisfaction de l'objectif (§20-22). Partitionne les critères : règles vérifiées sur les REÇUS d'abord, juge LLM sur le seul reste sémantique — tout-règles → 0 appel de juge |
| `goal/rules.ts` | Le juge de RÈGLES : grammaire `[REGLE:CODE:args]`, vérification déterministe sur les reçus (`RECHERCHES_AVEC_REQUETE`, `AUCUNE_ECRITURE`, `SORTIE_STRUCTUREE`). Code inconnu → critère SÉMANTIQUE, jamais deviné |
| `recovery/strategy.ts` | Douze causes, une échelle par cause, quatre niveaux de certitude |
| `recovery/sources.ts` | Où chercher ensuite, par type de cible (§77) |
| `commitments/satisfy.ts` | Une promesse se ferme quand le fait arrive ; relance sans harcèlement |
| `commitments/proactivity.ts` | Cinq facteurs : agir / proposer / se taire |
| `attention/policy.ts` | La POLITIQUE D'ATTENTION, pure : classe un signal (`SILENCE` / `JOURNAL` / `INFO` / `ATTENTION` / `ARBITRAGE`), choisit les canaux, déduplique (`cleDe`), cadence par niveau, plafond quotidien, et compose le message exécutif depuis les reçus (Résultat / Actions / À surveiller ; Problème / Contexte / Recommandation / Décision) |
| `runtime/collection.ts` | La collection d'un éventail : chemin explicite, sinon UNE liste ; deux listes → `preferer` (la moins profonde, puis celle d'objets), sinon AMBIGU dit |
| `templates/registry.ts` | OBSERVED → CANDIDATE → APPROVED : pas d'apprentissage silencieux |
| `memory/budget.ts` | Composition sous budget + trois couches incompressibles |
| `memory/compact.ts` | Compression progressive avec refus si une valeur critique est perdue |
| `memory/store.ts` | Épisodes en base + assemblage réel du contexte |
| `view/workspace.ts` | L'écran d'une mission, sans modèle, avec un `blockId` stable |
| `agent/principal.ts` | La double signature `initiatedBy` / `executedBy` (§30) |
| `evals/bench.test.ts` | 17 scénarios, KPI mesurés, et ce qui n'est pas mesuré dit comme tel |

**Le PONT** — `src/platform/in-process/missions/` : le seul endroit d'Adam autorisé à connaître
l'ERP, et la racine de composition du runtime (`boundary-scan.ts` l'exempte, par dessein).

| Fichier | Rôle |
|---|---|
| `reasoner.ts` | Remplit le port `Reasoner` avec la vraie passerelle. Traduit les rôles métier en rôles techniques ; aucun nom de modèle |
| `catalog.ts` | Le catalogue de capacités de CETTE personne, calculé par le même code que la conversation |
| `runner.ts` | L'exécutant : lectures par `executeReadTool`, écritures par intent + clé d'idempotence + reçu. Classe les échecs DURABLES d'une lecture (402 facturation, 401/403, 404 objet) en non-retryable + court-circuit par cible — un refus de facturation ne se « répare » plus par du raisonnement. Les écritures AUTONOMES passent par le chemin des lectures sous garde `AUTONOMOUS_EFFECT` (relue au journal : jamais deux rappels à la reprise) ; une écriture autonome qui rend une phrase est un échec |
| `runtime.ts` | `lancerMission` / `avancerMission` — assemblage complet, une retouche de plan sur refus du compilateur. Porte de replan : un juge qui ne suggère AUCUN recours (`recoursSuggere: null`) → `REPLAN_SKIPPED`, pas d'appel de planificateur. Enquête avant plan (`situation`) ; panne transitoire du planificateur → talon + `PLANNING_DEFERRED`, repris par le battement (`estPanneTransitoire`) ; signaux d'attention à l'approbation, à la question, au changement de plan ; `ADAM_PLANNER_ROLE` pour mesurer un autre rôle |
| `situation.ts` | L'ENQUÊTE : la situation d'un objectif composée par le code sous délai — entités, recherche fédérée, fiches, changements récents, documents, engagements, acteurs — sous les droits de la personne |
| `attention.ts` | La porte d'attention réalisée : classement, dédup au journal (`NOTIFIED`), plafond du jour, notification/push/e-mail au dirigeant |
| `watch.ts` | La surveillance durable réalisée : résolution de la cible sous droits (candidats si ambigu), lecture normalisée par type, création avec mission-support (`kind WATCH`), balayage (un problème dit une fois, résolution au journal, fin qui clôt), arrêt |
| `relance.ts` | L'ÉCHELLE DE RELANCES (+ `observerReponseTardive` : une réponse arrivée après que l'attente s'est réglée par le temps rejoint le journal `LATE_REPLY` et est dite en information) : Adam relance lui-même (message interne signé du compte système, un par jour), la hiérarchie au 3ᵉ barreau, le dirigeant seulement au-delà ; une partie externe va directement au dirigeant ; `relancerPersonne` partagé avec les engagements |
| `provider-waterfall.ts` | La cascade instrumentée du smoke : voie du plan, appels chevauchants, facteur de parallélisme, premier résultat utile — les métriques §18 du chantier latence |
| `deep-smoke.ts` | Le Deep Live Smoke (`npm run adam:smoke:deep`) : 60-80 missions générées depuis les VRAIES données de l'ERP (~19 genres), même harnais `jouer` que le smoke fournisseur, verdicts SUCCÈS/HONNÊTE/DÉFAUT, nettoyage borné à ses missions. Mode PALIERS (`DEEP_SMOKE_PALIERS="3,5,10"`) : montée en charge par mesure, arrêt auto si défauts ↑ ou P95 ×2, concurrence retenue = maximum SAIN observé ; `carteDeScore` §71 (E2E, création, routes, non-triviales anti-triche, appels gaspillés, jetons/succès) au rapport et au JSON |
| `sweep.ts` | Le battement des missions : douze par passage, droits RELUS en base ; `conduireMission` (avancer → replanifier si BLOCKED/FAILED → signaler au dirigeant un blocage NOUVEAU sans recours, une fois) ; attentes échues journalisées une fois puis RELANCÉES par l'échelle (`relancerAttente`) à chaque battement, idempotent dans la journée |
| `memory.ts` | Découpage en épisodes, vieillissement par le calendrier, contexte composé sous budget |
| `commitments.ts` | Les promesses en retard : espacement croissant, le silence quand l'identité n'est pas canonique, et la relance du PROMETTANT par Adam (échelle) — le dirigeant seulement quand l'échelle est épuisée ou sans compte interne |
| `control.ts` | Les gestes de conduite vus d'Adam — sans accorder ni fournir, qui exigent un clic |
| `fake-reasoner.ts` | Le seul substitut des bancs : il VALIDE chaque réponse scriptée contre le schéma réellement demandé |
| `e2e.test.ts` `memory.test.ts` `commitments.test.ts` `relance.test.ts` `situation.test.ts` `attention.test.ts` `launch-resilience.test.ts` `autonomous-dedup.test.ts` `message-wake.test.ts` `branche-conditionnelle.test.ts` `watch.test.ts` `evenement-anterieur.test.ts` | Les bancs de bout en bout, depuis les vrais points d'entrée |
| `crash-matrix.test.ts` `permission-matrix.test.ts` `donnees-modifiees.test.ts` | Les MATRICES et le CHAOS : le crash à chaque frontière d'étape (5/5 reprises, 0 doublon) ; permissions × capacités × confirmation sur le vrai catalogue de tous les rôles ; la cible qui disparaît en cours de mission (rien ne part, la mission ne conclut pas, le dirigeant est prévenu une fois) |

### Le bac à sable d'exécution (`src/lib/sandbox/`) — domaine (mandat 4 §25)

Adam CALCULE, il n'affirme pas. Quatre briques, une frontière : rien ici n'écrit. Le SQL est en
lecture seule et borné à une liste blanche relue dans le PLAN d'exécution ; le JavaScript tourne
dans un fil isolé au contexte vide ; le Python dans un processus aux limites posées par le noyau,
et il est déclaré absent quand il l'est ; les opérations d'analyse sont pures et fermées ; la
visualisation recommande et DIT ce qui tromperait. Les droits ne vivent pas ici : le SQL exige la
vue globale (vérifiée dans `sql.ts`), et les données d'entrée du code arrivent d'une lecture
canonique (`executePowerTool` revérifie), d'un fichier du Drive (`canViewDrive`, nœud par nœud,
dans le pont) ou d'une requête SQL. Une lecture SQL libre s'inscrit à l'audit sous un nom — un
refus aussi.

| Fichier | Rôle |
|---|---|
| `analyse.ts` | Les opérations PURES : lecture des nombres à la française (espaces fines, virgule, devise) et des dates, `decrire`, `regrouper` (count/sum/avg/min/max/median/p90/distinct, valeurs ignorées DITES), `croiser`, `filtrer`, `trier` (illisibles toujours en dernier), `serie` (mois vides comblés), `moyenneMobile`, `croissance` (null sur base nulle), `cumul`, `tendance` (pente, R²), `rang`, `anomalies` (z robuste médiane/MAD, n ≥ 8), `cohortes` (rétention), `scenario` (hypothèses dites, base intacte) |
| `pipeline.ts` | La spec d'un modèle COMPILÉE en étapes fermées : `appliquerEtapes` relit chaque champ, applique ce qui est valide dans l'ordre, et NOMME ce qu'il refuse (opération inconnue, colonne absente — avec les colonnes réelles, agrégat inexistant) sans arrêter le lot ; 16 opérations, 20 étapes au plus, mode d'emploi rendu au modèle |
| `viz.ts` | Le bon graphique pour la FORME des données et l'INTENTION de la question (courbe, barres, barres empilées, secteurs ≤ 6 parts, nuage, histogramme, cascade, tableau) avec la raison ; `verifierGraphique` signale ce qui TROMPE : axe tronqué sur des barres, camembert à trop de parts / négatif / pas un tout, double axe, 3D, log non dit, cumul non dit, trop de séries, courbe sans temps ou à deux points |
| `sql.ts` | Le SQL en LECTURE SEULE : quatre verrous — la FORME (un SELECT/WITH, sans point-virgule ni commentaire, fonctions système refusées), le PLAN (`EXPLAIN (FORMAT JSON)` avant l'exécution, chaque relation dans la liste blanche — une table sensible cachée dans une CTE ou un alias n'échappe pas), la TRANSACTION (`READ ONLY`, `statement_timeout`, rôle `amd_sandbox_ro` pris quand il existe, l'isolation OBTENUE dite dans la réponse), le VOLUME (LIMIT imposé, colonnes sensibles masquées même renommées). Réservé à la vue globale. `verifierVerrouLectureSeule` tente une écriture dans la transaction même du bac et exige qu'elle échoue — mesuré, pas supposé |
| `js.ts` | Le JavaScript isolé : `worker_threads` avec `env: {}` et `resourceLimits`, `vm` au contexte VIDE (`data` recopié par JSON, `lib` définie dans le fil, `console.log` borné), génération de code depuis une chaîne interdite, délai dur, résultat ≤ 1 Mo ; la forme refuse `require`, `process`, `globalThis`, `import(`, `eval(`, `Function(` en nommant le mot |
| `python.ts` | Le Python isolé, MESURÉ : `sonderPython` constate python3 (version, modules de calcul présents) ou dit pourquoi il manque ; processus `-I`, environnement réduit, limites noyau posées avant la première ligne (mémoire, CPU, taille de fichier 0 = aucune écriture, processus 0 = aucun fork), SIGKILL au délai, résultat sur un descripteur séparé des `print` ; la forme refuse fichiers, réseau, système |
| `index.ts` | La façade ; le pont `platform/in-process/sandbox/` porte `lireLignesDrive` (CSV/TSV/XLSX/XLSM, en-têtes dédoublonnés, cellules typées, un nom ambigu rend les CANDIDATS), `journaliserSql` (audit) et `aVueGlobale` |
| `analyse.test.ts` `pipeline.test.ts` `viz.test.ts` `js.test.ts` `python.test.ts` `sql.test.ts` | 12 + 12 + 9 + 7 + 7 + 9 tests : opérations, compilation des étapes (refus dits), pièges de visualisation, échappatoires JS fermées (sonde `proc\u0065ss` qui contourne la forme pour éprouver le vm), délais durs, Python sauté — pas vert par défaut — quand il manque, et sur la vraie base : table sensible refusée par le plan (directe, CTE, alias), écriture impossible (forme puis sonde du verrou), masquage, troncature, délai, CTE + fenêtre + agrégat par mois |

Côté Adam (`lib/assistant/sandbox-tools.ts`, domaine `DATA` du routeur) : `sql_query` (vue globale, audité, tableau composé par le code, provenance de calcul F8), `run_analysis` (source = lecture canonique / `outil` de lecture / fichier Drive / SQL / lignes fournies — une écriture nommée comme source est refusée), `run_code` (JS ou Python sur les mêmes sources), `chart_advice` (recommande et juge une spec). Le vocabulaire sans ambiguïté (SQL, graphique, cohorte, scénario, médiane…) fait de `DATA` le domaine principal ; le vocabulaire large (analyse, calcule, tendance, par mois…) l'ouvre en domaine SECONDAIRE sans détrôner le métier de la question (`QueryRoute.secondaires`, repris par le résolveur d'outils), et la consigne `consigneCalcul` rappelle au modèle que tout chiffre dérivé sort d'un outil — jamais de tête.

### Le registre de marque (`src/lib/brand/` + `platform/in-process/brand/`) — mandat 4 §26

Ce qu'une société DIT d'elle-même sur chaque pièce émise en son nom, et que la fabrique applique
d'elle-même : couleur d'accent et secondaire, polices des titres et du texte, logo, coordonnées
telles qu'elle veut les imprimer, mentions légales de pied de page, qui signe quoi (par type de
pièce). Le profil documentaire (préfixes, TVA, validité, papier en-tête, signataire) en était la
fondation ; la marque vit dans son `settings.marque` — prévu « extensible sans migration » — et
la **charte effective** tranche : marque > bleu canard de la maison (`#087084` ; la pastille de la société — une couleur d'écran — ne colore plus aucune pièce, §118.203), avec
les alertes de contraste WCAG calculées (un accent trop pâle sur blanc, un texte illisible dans
un en-tête de tableau).

| Fichier | Rôle |
|---|---|
| `brand/model.ts` | PUR, sans import : `Marque`, `validerMarque` (modification partielle appliquée champ par champ, refus NOMMÉS — couleur non hexadécimale, police hors des polices sûres acceptée mais dite, e-mail invalide, type de pièce inconnu, plus de huit mentions), `lireMarque` (tolérant : un JSON étranger revient à vide), `charteDe` (accent effectif + origine + contraste), `mentionsDe` (coordonnées choisies sinon carte Legal, puis mentions libres — jamais une identité inventée), `signatairePour` (type > défaut > profil), `resumerMarque` |
| `in-process/brand/index.ts` | Le pont : `marqueDe` (qui voit la société lit), `definirMarque` (`peutReglerMarque` = Direction ou papeterie, audit au nom de la personne, refus rendus), `definirLogo` (PNG ou JPEG 2 Mo au plus, octets VÉRIFIÉS contre le type déclaré, SVG refusé — Word ne l'insère pas sans conversion — stockage chiffré du Drive), `logoOctets`, `marqueEtCharte` |
| `artifact/factory.ts` (pont) | `profilDocumentaire` PORTE `marque`, `charte`, `resumeMarque` et un `habillage` (papier en-tête, sinon police et logo) ; la spec d'une pièce prend l'accent de la charte, les mentions de la marque et le signataire du type ; `emettre`, `reviser` et `construireDossierDrive` passent l'habillage à la fabrique |
| `artifact/factory/word.ts` | `composerDocx` accepte un `logo` : dans un paquet NEUF, un en-tête de page (`header1.xml`, image en ligne à la largeur voulue, proportions lues dans les octets PNG/JPEG) ; avec un papier en-tête, rien n'est injecté — le papier porte le sien |
| `assistant/office-capabilities.ts` | `document_profile` lit et RÈGLE aussi la marque (`marque: {…}`), rend `charte` et `resumeMarque` ; « quelle est notre charte ? », « couleur d'accent #0B6E4F », « les devis sont signés par… » |
| `app/(app)/admin/marque/` + `actions/brand-actions.ts` + `api/marque/[companyId]/logo` | L'écran Administration › Marque & modèles : une carte par société (accent, polices, logo, résumé, alertes), le formulaire de la charte et le dépôt du logo pour qui tient la papeterie, lecture seule pour les autres ; l'aperçu du logo servi sous le droit de voir la société |
| `brand/model.test.ts` (10) · `in-process/brand/brand.test.ts` (4, sur base) · `e2e/marque.spec.ts` (4) · défi live `defi-marque` | Validation et contraste ; refus sans papeterie, modification partielle relue, audit, devis construit avec l'accent dans les styles + mention + signataire du type dans le texte, SVG refusé / PNG dans l'en-tête ; l'écran de bout en bout (Direction lit, assistante règle, relecture après rechargement, alerte de contraste, logo déposé/affiché/retiré, 390 px sans débordement) ; en conditions réelles : « règle la charte d'Adventum… » puis « fais-moi un devis Adventum… » → le fichier Word porte l'accent, la mention et la signataire |

**Ce qui n'est pas prétendu** : le logo de marque n'entre que dans les pièces SANS papier en-tête (un papier déposé fait foi) ; les livrables de mission (`missions/artifacts`) gardent leur thème propre ; un modèle Word/Excel/PowerPoint de la société reste un papier en-tête déposé (`OfficeLetterhead`), la marque ne le régénère pas.

### L'intelligence métier (`src/lib/legal/clauses.ts`, `src/modules/finances/domaine/intelligence.ts`, `platform/in-process/intelligence/`) — mandat 4 §27

Regulatory, Legal et Finance produisent des **signaux** de la même forme (`src/lib/utils/signaux.ts`,
socle sans import) : un code, une gravité (critique / haute / normale / basse), un titre, un détail,
une échéance, un montant, l'entité, sa fiche, ce qu'il y a à FAIRE — et **le calcul en clair**
(« 62 % consommé à 50 % du temps », « fin 2027-03-31 − préavis 6 mois = 2026-09-30 »). Sans calcul
lisible, un signal est une opinion, et Adam n'en a pas.

| Où | Ce que ça fait |
|---|---|
| `legal/clauses.ts` (pur) | Lit un contrat FRANÇAIS phrase par phrase : durée, reconduction tacite (et sa période), préavis, exclusivité (et son territoire, ou son absence), pénalités (taux, période, plafond), résiliation, paiement, confidentialité après terme, non-concurrence, garantie, droit applicable, responsabilité. Chaque clause porte son **extrait** (la preuve), sa position et sa confiance (SURE / PROBABLE / A_VERIFIER — un mot-clé sans valeur est signalé, jamais complété). `obligationsDe` date les obligations depuis la FIN du contrat (dénonciation = fin − préavis, exclusivité au terme, confidentialité après), `comparerClauses` compare un avenant en VALEURS (36 → 60 mois, pénalité modifiée, exclusivité retirée), `risquesDe` nomme les risques (pénalité sans plafond, tacite sans préavis, droit étranger, responsabilité illimitée). |
| `finance/intelligence.ts` (pur) | `santeBudget` : rythme consommé vs calendrier, projection linéaire d'atterrissage (jamais sous 5 % du temps écoulé : SANS_RYTHME), écart projeté ; `signauxBudget` : dépassement (critique), rythme à risque (haute au-delà de 20 % d'écart projeté), catégorie dépassée, prévision incohérente (sous le réel) ou optimiste ; `justificatifsManquants` : ordre réglé sans la facture exigée (haute), à régler (normale) ; `echeancesPaiement` : la gravité dépend de la NATURE de l'échéance (date imposée critique une semaine avant, importante trois jours avant, modérée la veille), en retard = critique si imposée. |
| `in-process/intelligence/index.ts` | Le pont, sous les droits : **Legal** — engagements ACTIFS visibles (entité + lecteurs désignés), clauses depuis la réserve `custom.intelligence` ou, à défaut, depuis `DriveTextIndex` à la volée (12 au plus par lecture, les plus proches de leur échéance d'abord), signaux `contrat_echu_actif`, `contrat_echeance`, `denonciation_a_decider`, `reconduction_acquise`, `tacite_sans_preavis`, `obligation_*` (dès que la fin entre dans l'horizon, tant qu'elles courent), `risque_*`, `avenant_clauses_modifiees`. **Finance** — enveloppes (8 au plus) via `getBudgetOverview`, ordres `requiresInvoice` sans facture chaînée (`LegalDocument.expenseOrderId`), demandes de paiement et ordres PENDING par échéance, `facture_sans_bc`, `bc_sans_facture`, `ecart_facture_bc` (> 10 %, haute > 25 %). **Regulatory** — dossiers ouverts visibles : `dossier_bloque`, `etape_bloquee`, `etape_en_retard` (jours dits), `pieces_manquantes`, `depot_en_retard` / `depot_proche`, `fournisseur_en_retard` / `fournisseur_echeance` (échéance externe), `reponse_attendue` (frise sans réponse après réserves), `dossier_sans_activite` (60 j) ; espace d'analyse CTD (sociétés activées, `regCan("regulatory.finding.view")`) : `bloqueurs_soumission` (`submissionReadiness`, 25 dossiers au plus), `reserves_sans_reponse`, `fournisseur_sans_reponse` / `relance_fournisseur`, `obligation_en_retard` / `obligation_echeance`, `dossier_en_erreur`. `intelligenceComplete` lit les trois ; `mettreEnCacheClausesSiDu` relit une fois par jour, dans le battement, les clauses des engagements dont le texte indexé a changé. Les jours sont **signés par troncature** : « il y a 15 j » ne devient jamais 16 à minuit passé de quelques heures. |
| `assistant/intelligence-tools.ts` | `regulatory_intelligence`, `legal_intelligence`, `finance_intelligence` — `allowed` = la porte de l'écran (REGULATORY / LEGAL / FINANCES ou BUDGETS en lecture), filtres `gravite`, `code`, `filtre`, `horizonJours`, sortie : résumé chiffré, `parCode`, portée lue (« rien à signaler » a un dénominateur), limites dites (sans droit, sans texte, à la volée), signaux avec calcul et fiche, `_blocs` tableau, `_provenance` du calcul. Domaines de la shortlist : REGULATORY / LEGAL / FINANCE. |
| `in-process/inbox/compose.ts` | Dixième source `intelligence` : les signaux CRITIQUE/HAUTE des trois lectures (mode léger : pas d'extraction à la volée, 3 enveloppes, 5 readiness), en **état chaud** dix minutes, cinq cartes REVIEW au plus — « Ouvrir la fiche », « Demander à Adam » (la phrase porte le titre du signal). |
| `scheduled.ts` | `mettreEnCacheClausesSiDu()` après le balayage qualité : la réserve des clauses, jamais dans une requête. |
| `legal/clauses.test.ts` (8) · `finance/intelligence.test.ts` (7) · `in-process/intelligence/intelligence.test.ts` (6, sur base : contrat déposé et indexé → dénonciation = fin − 6 mois, risque sans plafond, confidentialité ; ordre réglé sans facture HAUTE ; date imposée à 3 j CRITIQUE ; étape en retard de 40 j HAUTE ; porte VIEWER vide ; réserve idempotente ; outils avec `_blocs` et provenance) · défis live `defi-legal-clauses`, `defi-finance-signaux`, `defi-regulatory-signaux` (la date de dénonciation, les références et montants du décor, le retard de 40 j et la pièce CPP doivent être DITS) | Le banc. |

**Ce qui n'est pas prétendu** : les clauses sont lues par des motifs FRANÇAIS déterministes — un
contrat en anglais, un scan sans texte ou une clause formulée autrement rendent « sans texte » ou
A_VERIFIER, jamais une valeur devinée ; une enveloppe sans prévision déclarée n'a pas de signal de
prévision (le rythme seul est jugé) ; les dossiers CTD ne sont lus que pour les sociétés où l'espace
d'analyse est activé. Aucun signal ne déclenche d'effet : relancer, dénoncer, régler restent des gestes
humains ou des actions confirmées.

### Les spécialistes et la calibration de confiance (`src/lib/assistant/specialists/`, `confidence/`) — mandat 4 §29

**La calibration est arithmétique, et le maillon faible gouverne.** Chaque fait servi dans un tour
porte sa base (structuré dans l'ERP, natif d'un document, OCR, lecture de modèle, web, calcul,
déclaré par un outil) et sa confiance. `certitudeDuFait` en fait un état : CERTAIN (ERP, calcul,
déclaré, confiance ≥ 0,85), PROBABLE (document, déduction), HYPOTHÈSE (mémoire d'un modèle, web,
faible confiance — jamais plus que PROBABLE quoi qu'en dise le score). `calibrer` juge le lot : une
CONTRADICTION (un même libellé, deux valeurs, deux outils) l'emporte sur tout, puis MANQUANT (une
ancre de la question — montant, référence, nom — qu'aucun fait ne porte, ou rien de lu), puis le
fait le plus faible du lot. Chaque état COMMANDE une conduite : agir, vérifier avant d'agir, chercher
encore, demander à la personne, arbitrer. L'enjeu module à la marge (une question courte sans
conséquence agit sur un probable). Le même vocabulaire que l'étiquette de réponse (FAIT VÉRIFIÉ /
FAIT DÉRIVÉ / ESTIMATION / INCONNU) et que l'échelle des missions (TROUVÉ / DÉDUIT / CANDIDAT /
INCONNU) — la table `EQUIVALENCES` le dit.

| Où | Ce que ça fait |
|---|---|
| `confidence/calibrate.ts` (pur) | Le vocabulaire, `certitudeDuFait`, `contradictionsDe`, `manquantsDe`, `calibrer`, `enjeuDe`, `expliquerCalibration`. |
| `confidence/tour.ts` | `calibrerTour` : à la fin d'un tour (les deux boucles), les faits F8 sont calibrés contre les ancres de la question ; le résultat porte `calibration`, la trace montre « Certitude : … → … », et toute action proposée sous MANQUANT ou CONTRADICTION reçoit un avertissement que la carte affiche AVANT confirmation. Le code le dit ; on ne compte pas sur le modèle. |
| `specialists/registry.ts` (pur) | Neuf spécialistes : mission d'une phrase, liste FERMÉE d'outils de lecture, budget de tours et de sortie, `actif`, `benefice`, `quand`. Un spécialiste n'est offert au modèle qu'après une mesure POSITIVE au banc ; quatre ont été mesurés (négatif, voir ci-dessous), cinq attendent une mesure — tous définis et testés, aucun actif. |
| `specialists/run.ts` | `deleguer` : un worker éphémère (rôle `worker`, sans réflexion) qui ne voit que ses outils ∩ ceux de la personne, jamais une écriture ; chaque appel d'outil repasse par `executeReadTool` (mêmes droits) et par `recordTool` (même trace) ; un outil hors périmètre est refusé sans être exécuté ; `maxTours` et un délai bornent, et un rapport incomplet le DIT ; ses lectures sont relues en faits et calibrées. |
| `specialists/tools.ts` | `consult_specialists` : 1 à 4 demandes en parallèle, un rapport calibré par spécialiste (certitude, conduite, motif, outils, tours, ms, faits), `specialiste:<id>` dans la trace du tour, `_provenance` fusionnée pour « d'où tu tiens ça ? ». Fermé tant qu'aucun spécialiste n'est actif, fermé à un compte sans module ; `ADAM_SPECIALISTS=off` retire l'outil pour mesurer le tour sans lui. |
| Banc | `calibrate.test.ts` (5), `specialists/registry.test.ts` (3), `specialists/run.test.ts` (3, modèle scripté) ; défi live `defi-specialistes` (un point qui croise contrat, finances et dossiers, jugé sur les faits du décor et sur une certitude dite), joué AVEC et SANS spécialistes. |

**La mesure** : offert vs non offert, sur le banc live (bench-out, 2026-09-06). Point multi-domaines `defi-specialistes` (contrat + finances + dossiers), 2 × 2 tours : l'orchestrateur n'a JAMAIS délégué (0/4) — il appelle lui-même `legal_intelligence`, `regulatory_intelligence` et `finance_intelligence` dans la même vague (3 appels, 18 à 24 s, 0,05 à 0,11 $), et les faits sont justes dans les quatre cas. Trois documents à lire intégralement `defi-specialistes-documents`, 2 × 2 tours : 0/4 délégation, 2 appels, 10 à 11 s, 0,03 à 0,06 $, mêmes lectures avec ou sans. Aucun bénéfice mesurable — ni coût, ni latence, ni qualité : les capacités d'intelligence (§27) et le parallélisme des outils dans une vague font déjà le travail qu'un sous-agent ferait. Conclusion tenue par le code : AUCUN spécialiste n'est actif, `consult_specialists` n'est pas exposé tant qu'aucun ne l'est ; le mécanisme (registre, worker, trace, calibration) reste branché et testé, et s'active spécialiste par spécialiste sur une mesure POSITIVE (coût ou latence en baisse à qualité égale, ou qualité en hausse, sur un défi qui le déclenche).

**Ce qui n'est pas prétendu** : la calibration classe des faits déjà lus, elle ne relit rien et ne
tranche aucune contradiction — c'est le chantier §49 (vérification indépendante) qui recalcule ; les
spécialistes inactifs ne sont pas « à venir », ils sont mesurables et attendent une mesure ; un
spécialiste actif reste un appel de plus, et la description de l'outil dit quand il ne paie pas.

### Voix omniprésente, multimodal, mobile exécutif — mandat 4 §30

**La voix n'est pas un second Adam.** La session temps réel reçoit `realtimeToolsFor(user)`, construit
depuis `assistantToolsFor` — le registre du texte, borné par les mêmes droits ; chaque appel d'outil
revient sur le serveur authentifié (`api/assistant/voice/tool`) où `executePowerTool` revérifie le
module ; une demande qui dépasse les lectures rapides est DÉLÉGUÉE à l'orchestrateur texte complet,
avec l'historique du fil, et ses actions reviennent en propositions à confirmer à l'écran. Le tour
vocal écrit dans le MÊME fil (`voice/turn` → `rememberExchange(threadId)`) : ce qu'on a dit à la voix,
on le retrouve au clavier, et le classeur ouvert ensuite dans le canvas est le même. Missions,
mémoire, règles enseignées, surveillances : un seul état, deux entrées.

**Une image devient du texte, jamais une invention.** Une photo, un scan, une capture jointe au
message passe par `lireImageOuScan` : l'OCR réel de la maison (Tesseract local, données de langue
embarquées, secours vision Luna sur les pages faibles — le même moteur que l'ingestion
réglementaire), puis, si le texte est mince ou de faible confiance (une photo, un tableau, un
graphique, un manuscrit), une LECTURE VISUELLE par Luna qui rend le type de pièce, le texte lisible,
les chiffres avec leur libellé, la lisibilité et des alertes — sous un schéma JSON, rien n'est
complété. La note dit la méthode, la confiance et le temps, et surtout : « ce n'est pas un fait
vérifié, à citer comme PROBABLE, chiffres à confirmer » — et cette note VOYAGE avec le texte jusqu'au
modèle (`buildAttachmentContext`). La calibration (§29) fait le reste : un chiffre lu sur une photo
n'est jamais CERTAIN. Le même chemin sert le banc (`piecesJointes` d'un défi) : `defi-multimodal-facture`
joint une facture rendue en PNG et exige le fournisseur, le numéro et le TTC, dits probables. Une
image devient une entrée de mission par la même porte : le contenu lu est dans le message, et
l'objectif de la mission que le tour lance le porte.

**Le téléphone répond avant le serveur.** La boîte de décision pose l'état « en cours » de façon
synchrone au toucher (état optimiste) ; la carte l'expose (`data-etat`) et le test mobile de
`e2e/inbox.spec.ts` mesure DANS la page, du clic au premier rendu, que le retour visuel arrive en
moins de 150 ms — puis que l'écriture serveur suit (« fait » ou « erreur »). Parler, brief, alertes,
approuver, répondre, ouvrir un document, commenter, assigner, suivre, source : chacun a sa porte
mobile déjà mesurée à 390 px (chief-ui, chief-godmode, inbox, live).

**Ce qui n'est pas prétendu** : l'OCR local lit des documents imprimés nets ; une photo de travers,
un manuscrit difficile passent par la lecture visuelle du modèle, qui reste une HYPOTHÈSE ou un
PROBABLE, jamais un fait ; l'audio et la vidéo (transcription, diarisation) sont le chantier §38.

### Meeting Intelligence à trois niveaux — mandat 4 §32

Arriver préparé n'est pas lire l'agenda : c'est savoir ce qui s'est dit la dernière fois, ce qui en est sorti,
ce qui traîne, ce qu'il faudra décider. Mais la Direction Marketing avant un point de quinze minutes n'a pas besoin
du dossier d'un chef de cabinet. Le niveau se **choisit** — et il s'**enseigne**.

- **Trois niveaux, un seul outil** (`pre_meeting_brief` → `platform/in-process/meetings/index.ts`,
  `composerBriefReunion`). **LIGHT** : la réunion, l'ordre du jour (la description), les tâches ouvertes entre
  vous et chaque participant. **STANDARD** : + la dernière réunion terminée du même sujet ou avec les mêmes
  personnes (notes = compte rendu enregistré, actions proposées et leur **sort** calculé sur la tâche créée :
  faite / en cours / écartée / jamais tranchée, responsable, échéance), les décisions récentes liées, les
  engagements suivis. **CHIEF_OF_STAFF** : + l'historique des réunions précédentes, les personnes (fonction,
  département), les dossiers reconnus par le dictionnaire d'entités, les décisions à obtenir (validations qui
  vous attendent, étapes de mission en attente), les risques et contradictions tirés des signaux de
  l'intelligence métier (§27) qui nomment ces entités ou ces personnes, les engagements en retard avec leur
  retard compté, les questions ouvertes (présence non confirmée, demande non acceptée, action jamais tranchée,
  décision restée proposition, réunion sans ordre du jour), le suivi jusqu'à l'occurrence suivante.
- **Le niveau est appris, jamais deviné** (`lib/meetings/niveau.ts`, pur). « Pour mes réunions, je veux un
  briefing de chef de cabinet » passe par Teach Adam : `teach/classify.ts` extrait la clé structurée
  `niveauReunion`, le magasin la canonise (`CHIEF_OF_STAFF`), et `niveauReunionPour` lit la première règle en
  vigueur qui la porte — par sa clé, ou par sa phrase si l'enseignement est resté en texte. Sans règle : la
  direction et son cabinet lisent STANDARD, les autres LIGHT. Un « fais-moi un brief léger » impose un niveau
  pour CE brief sans toucher à la règle. Le brief dit sa source (`niveauSource`).
- **Le niveau change ce qu'on LIT, pas ce qui est vrai.** Un brief LIGHT ne lance ni la lecture des comptes
  rendus, ni celle des décisions, ni l'intelligence métier — le coût suit le besoin. Aucun champ n'est rempli
  par le modèle : sans compte rendu, `notes: null` et la note le dit ; sans signal, `risques: []`.
- **Cloisonnement inchangé** : seules vos réunions (organisées ou sur invitation), vos engagements, vos
  décisions, vos validations, vos missions ; les signaux sont lus sous vos droits.
- **Banc** : `pre-meeting-brief.test.ts` (5 : STANDARD par défaut avec notes, sort d'action « faite » et
  décision liée ; LIGHT imposé qui n'a ni notes ni engagements ; règle `niveauReunion` → CHIEF_OF_STAFF avec
  validation en attente, engagement en retard compté, suivi ; règle supprimée → retour au défaut ; rôle hors
  direction → LIGHT ; tiers → rien), `lib/meetings/niveau.test.ts` (3), défi live
  `defi-reunion-chef-de-cabinet` (tour 1 enseigne, la base porte `params.cle = niveauReunion` ; tour 2 le brief
  passe par `pre_meeting_brief`, nomme la participante, rapporte l'action de la dernière réunion et
  l'engagement en retard).

### Suite d'évaluation, sabotages et observabilité par action — mandat 4 §33

Un chiffre exigé sans mesure est une intention ; une mesure sans seuil est une courbe. La suite relie
les deux, et le code rend le verdict.

- **Dix-sept cibles, un registre** (`lib/evals/cibles.ts`, pur) : les dix chiffres du mandat (100 %
  sécurité des permissions, 0 faux succès, 0 action sans preuve, ≥ 99 % de reprise déterministe, ≥ 95 %
  d'entités résolues, ≥ 95 % d'anomalies critiques détectées, ≥ 95 % de conduites agir / attendre /
  prévenir / demander conformes, 100 % de provenance des faits critiques, 100 % de règles récupérables,
  100 % de surveillances restaurées), plus les sabotages tenus, les actions observables, et cinq
  latences (entité P95 < 300 ms, provenance P95 < 500 ms, boîte de décision < 1,5 s, retour mobile
  < 150 ms, premier mot au banc des défis — cliquet ≤ 8 s, 6,3 s mesuré). `mesurer` juge une observation
  (`{ n, ok }` ou `{ valeur }`) contre sa cible ; `verdictSuite` n'est atteint que si TOUT est mesuré et
  atteint ; `rendreTableau` dit « NON MESURÉE » et « INVARIANT CASSÉ » en toutes lettres.
- **Les mesures naissent là où le comportement se prouve.** Chaque matrice existante appelle
  `consignerMesure` (`lib/evals/registre.ts`) au moment où elle compte : permissions × capacités,
  crash à chaque frontière (reprise, et « 0 étape DONE sans reçu » — nouvel invariant asserté),
  résolution d'entités et son P95, moteur de qualité, politique d'attention, provenance (un tour réaliste :
  100 % des faits portent nature, outil, confiance, base, fraîcheur, date, ancrage), relecture de
  provenance, magasin de règles, surveillances après redémarrage, sabotages, observabilité, et les deux
  parcours Playwright de la boîte. Une mesure = un fichier `bench-out/evals/<cible>.json` (dernier
  passage fait foi, écriture atomique, jamais bloquante).
- **`npm run evals:report`** relit ces fichiers, ajoute le P50 du premier mot du dernier banc live, imprime
  le tableau (exigence, mesuré, verdict, où et quand), l'écrit dans `bench-out/evals/RAPPORT.md`, et sort
  en erreur sur une cible manquée — ou non mesurée, sauf `--souple`. Trois règles tenues par
  `cibles.test.ts` : une cible non mesurée n'est jamais réussie ; un invariant casse au premier cas ; un
  dénominateur nul ne vaut pas 100 %.
- **Quatorze sabotages, tenus par le vrai code** (`platform/in-process/evals/sabotages.test.ts`) : mauvaise
  entité (deux « Ahmed » → aucun retenu, une question), doublons (deux fiches au même nom détectées,
  jamais fusionnées), source obsolète ou non sûre (OCR / lecture de modèle → jamais CERTAIN, vérifier),
  contradiction (15 M vs 17 M → CONTRADICTION, arbitrage), règle conflictuelle (refusée et dite ;
  remplacer crée la v2, garde la v1), permission refusée (la phrase le dit, la décision est comptée),
  fournisseur indisponible (HTTP 503 à la planification → talon PLANNING, PLANNING_DEFERRED, rien de
  perdu), facture sans BC (signal finance), crash pendant une surveillance (relue une fois, pas deux),
  redéploiement (règles et surveillances relues depuis la base), règle mise à jour en cours de mission
  (le planificateur relit les politiques à chaque plan), sous-agents en désaccord (CONTRADICTION ; aucun
  spécialiste actif sans bénéfice mesuré), coût trop élevé (plafond atteint → BUDGET_HOLD, l'étape ne
  tourne pas), modèle principal indisponible (HTTP 503 → `ok: false`, arrêt `error`, classé transitoire,
  jamais une exception ni un faux texte).
- **L'observabilité par action** (`platform/in-process/missions/observabilite.ts`) compose, SANS nouvelle
  table, les treize champs du mandat pour chaque étape : modèle et sous-agent (`MissionWorkerRun`),
  version du prompt du planificateur et règles enseignées servies (`planMeta.promptVersion`,
  `planMeta.politiques`, estampillés au lancement et au replan), outil, source, issue, latence et
  nombre de résultats (le reçu structuré), tentatives, erreur et cause (`MissionStep`), décision de
  permission (REFUSEE sur `MISSING_PERMISSION`, ACCORD_REQUIS / ACCORDEE_PAR_HUMAIN par les accords,
  SANS_OBJET hors capacité), certitude que le reçu autorise (trouvé ou preuve d'absence → CERTAIN,
  dédoublonné → PROBABLE, indéterminé → HYPOTHESE, échec → MANQUANT). Un champ non produit vaut `null`,
  jamais déduit. Le contrat `mission.status` porte `observabilite` ; côté conversation, chaque tour porte
  `promptVersion` (`lib/assistant/prompt-version.ts`) et compte `permissionsRefusees`
  (`recordPermissionRefusal` dans `executePowerTool`).
- **Banc** : `cibles.test.ts` (4), `sabotages.test.ts` (15, ~2,4 s), `observabilite.test.ts` (2 : une mission
  lancée et conduite par l'entrée de production, treize champs présents, cloisonnement ; un tour où le
  droit refuse un outil est compté et porte sa version de prompt), mesures dans neuf matrices et deux
  parcours Playwright.

### Autonomie généraliste — mandat 5 §34

Un assistant qui a des fonctionnalités répond « je ne peux pas » dès que la demande ne porte pas le
nom d'un bouton. Un assistant qui a des PRIMITIVES compose. Ce lot rend la composition structurelle,
et interdit au code de laisser passer un « impossible » non vérifié.

- **Six primitives, portées par chaque capacité** (`missions/registry/capability-meta.ts` :
  `PRIMITIVES`, `primitiveDeduite`, `CapabilityMeta.primitive`) — INFORMATION, CALCUL, DOCUMENT,
  REPRESENTATION, ACTION, ORCHESTRATION. Le brief du planificateur (`registry/resolve.ts`,
  `listerPourPlanner`) les affiche en tête de chaque ligne : le planificateur ne cherche plus la
  fonctionnalité qui porte le nom de la demande, il assemble une lecture, un calcul, une pièce, une
  représentation, une action, une orchestration. `primitives.test.ts` : chaque capacité déclarée en
  porte une, jamais « autre ».
- **La découverte avant l'impossible** (`assistant/limites.ts`, `gardeImpossibilite`, branchée dans
  les deux boucles de `assistant.ts` à côté de la garantie d'enseignement). Quand le modèle conclut
  « je ne peux pas / je n'ai pas d'outil / ce n'est pas prévu » SANS avoir appelé un seul outil, le
  serveur ne le croit pas : il exécute lui-même la découverte (`runDiscovery`, la carte complète des
  capacités ouvertes à cette personne, droits déjà appliqués), la remet au modèle avec un ordre de
  second essai (`RAPPEL_DECOUVERTE`), et débloque les outils correspondants pour la suite du tour.
  Une fois : après la carte, le refus est accepté — mais un refus de capacité imprécis reçoit le
  complément du serveur (« la carte complète a été relue ; une capacité qui manque est une lacune à
  combler, pas un non prévu »). Un refus qui nomme déjà sa limite (droit, ressource, donnée) n'est
  pas rejoué. La trace le dit (« Carte complète des capacités relue »).
- **Une limite a une nature** (`classerLimite`) : PERMISSION (un droit manque), RESSOURCE (python3
  absent, clé non configurée, pièce sans texte), DONNÉE (rien dans la base), CAPACITÉ (aucune brique
  ne fait cela). « Pas codé », « pas prévu », « pas dans mes fonctions » sont classés imprécis : ce
  sont des aveux qui cachent l'une des quatre. Le classement sert la réponse, le journal des lacunes
  (§44) et le banc.
- **Le code comme outil passe une porte de qualité** (`sandbox/porte.ts`, pur : generate → INSPECT →
  EXECUTE → TEST → VALIDATE → expose). `run_code` accepte des `attentes` (assertions closes lues par
  le serveur sur le résultat : égal, différent, supérieur, inférieur, entre, contient, longueur,
  non vide, type) et un `schema` (forme promise : objet avec clés, liste bornée, nombre, texte). Le
  serveur inspecte d'abord (taille, interdits que l'isolation ne couvre pas — réseau, fichiers,
  processus, évaluation dynamique, boucle sans borne, `return` / `result` absents), exécute dans le
  bac, teste, valide (nombres finis, forme, clés), et n'EXPOSE le résultat que si tout tient. Sinon
  la réponse dit l'étape qui a refusé et la correction — « corriger le calcul, pas l'attente » — et le
  résultat n'est pas rendu : un chiffre faux avec l'air d'un chiffre juste est le défaut que la porte
  supprime. Le rapport (`porte.etapes`, `tests`) voyage avec le résultat.
- **Zéro contournement des permissions** : rien de nouveau n'ouvre un droit — la découverte ne montre
  que ce qui est déjà ouvert, `run_code` ne lit que des données venues d'une lecture canonique
  (revérifiée), du Drive (nœud par nœud) ou d'une requête SQL sous vue globale ; la matrice
  permissions × capacités (§33) reste à 100 %.
- **Banc** : `porte.test.ts` (6), `limites.test.ts` (6), `primitives.test.ts` (2), `sandbox-tools.test.ts`
  (+1 : faux résultat non exposé, forme fausse non exposée, calcul juste exposé avec son rapport),
  défis live `defi-autonomie-calcul` (médiane et P90 calculés par un outil, jamais « impossible ») et
  `defi-autonomie-composition` (heures de réunion par participant : lecture + calcul composés).

### Représentations dynamiques — mandat 5 §35

Une représentation n'est pas un composant : c'est une FORME (une donnée) rendue par UN rendu
générique. Ajouter un graphique n'ajoute pas un fichier React — il ajoute un cas au lecteur (les
données que la forme exige) et un cas au dessin. Le modèle nomme ; le code charge, agrège, choisit,
vérifie, compose, relit, dessine.

- **Le protocole** (`workspace/protocol.ts`) : le bloc `viz` porte `type` (dix-sept formes : barres,
  barres empilées, courbe, aires, nuage, histogramme, secteurs, cascade, entonnoir, heatmap, Gantt,
  matrice, graphe, arbre, flux/Sankey, carte, cartes) et `donnees` (une famille par forme :
  catégories + séries, points, grille, cellules, tâches, nœuds + arcs, arbre, lieux, cartes) ; le bloc
  `dashboard` porte des tuiles qui sont des blocs ordinaires (une représentation, des jauges, un
  tableau…). Bornes : 40 catégories, 6 séries, 400 points, 60 nœuds, 120 arcs, 40 tâches, 6 tuiles.
- **Le lecteur** (`workspace/viz-block.ts`) relit ce qu'un outil déclare, famille par famille : forme
  inconnue, famille qui ne correspond pas, arc vers un nœud absent, date inversée, `href` externe →
  refusé, jamais « affiché à peu près ». Une tuile invalide tombe, les autres restent ; pas de tableau
  de bord dans un tableau de bord.
- **Les constructeurs** (`construireViz`) vont des LIGNES à la forme : agrégation (somme, moyenne,
  compte, min, max) par catégorie, pivot d'une colonne en séries ou en colonnes, ordre chronologique
  pour le temps et par valeur pour les catégories, classes d'effectif à pas lisible, secteurs ramenés
  à cinq parts + « Autres », réseau depuis de/à, arbre depuis parent/enfant, lieux depuis lat/lon. Les
  colonnes se résolvent sans casse ni accents ; une colonne introuvable est REFUSÉE avec la liste des
  colonnes — jamais devinée.
- **`render_view`** (`assistant/view-tools.ts`) : le modèle nomme (forme ou `auto`, colonnes, source —
  la même que `run_analysis` : lecture relancée sous son droit, fichier du Drive sous `canViewDrive`,
  SQL sous la vue globale, lignes déjà obtenues) ; le code charge, agrège, choisit
  (`recommanderGraphique`), vérifie ce qui tromperait (`verifierGraphique` : axe tronqué, camembert à
  trop de parts, double axe, cumul non dit… + contrôles locaux), compose et RELIT le bloc par le même
  lecteur que tout `_blocs`. Le modèle ne reçoit jamais le bloc (`_blocsDecoratifs`) : un aperçu
  chiffré (forme, premières catégories et valeurs, alertes) lui permet de présenter la figure en une
  phrase, sans la recopier. `donnees` déjà structurées (un réseau, un arbre, des lieux, des
  indicateurs) passent par le lecteur tel quel ; `tuiles` → un `dashboard`, source partagée, tuile
  invalide DITE. Aucun droit propre : représenter n'est pas lire, la source porte le sien.
- **À la volée** : `run_analysis` et `sql_query` rendent AUSSI le graphique recommandé sous leur
  tableau (`rendu` le dit au modèle) — une analyse se voit, elle ne se lit pas seulement.
- **Le rendu** (`components/chief/workspace/blocks/viz-figure.tsx`) : UN composant SVG/HTML pour les
  dix-sept formes, sans dépendance. Une barre part TOUJOURS de zéro ; une courbe dont l'axe ne part
  pas de zéro le DIT sous l'axe ; les alertes se lisent AVANT la figure (`blocks/viz.tsx`) ; chaque
  élément porte sa valeur exacte en `<title>` ; les séries ont leurs données en clair (`<details>`).
  Sur téléphone, les séries passent en liste proportionnelle (un SVG réduit à 320 px n'est pas une
  lecture) ; les autres formes défilent horizontalement plutôt que de rétrécir ; matrice, arbre et
  indicateurs sont en HTML et se plient seuls. Le tableau de bord (`DashboardBlock`) place ses tuiles
  par le REGISTRE des rendus — il ne dessine rien lui-même.
- **Banc** : `viz-block.test.ts` (lecteur, bornes, constructeurs), `view-tools.test.ts` (auto, formes,
  alertes, données structurées, tuiles, `run_analysis` + graphique), `viz-figure.test.ts` (les dix-sept
  formes de la planche rendues sans NaN, éléments comptés, mesure `representations_rendues` dans le
  rapport des cibles), planche `?apercu=blocs` capturée aux cinq largeurs et vérifiée à 390 px
  (`chief-godmode.spec.ts`), live : un graphique puis un tableau de bord demandés dans l'UI
  (`adam-live.spec.ts`), défis `defi-representation-graphique`, `defi-representation-dashboard`.

### Runtime de plugins et de skills — mandat 5 §36

Un skill DÉCLARE ce qu'il sait faire ; le cœur ne le connaît pas par son nom, il le découvre. Trois
provenances, un seul format de manifeste, un seul runtime.

- **Le manifeste** (`lib/skills/manifest.ts`) : entrées (schéma), sorties, permissions (module, action,
  vue globale, rôles), risques (niveau, irréversible, externe), coût (latence, estimation), dépendances
  (les NOMS de configuration qui rendent le skill disponible — jamais une URL ni un jeton), événements,
  validations (attentes closes, forme promise), limites (débit) et l'exécuteur : `http` déclaratif
  (chemin et corps à gabarits, authentification par configuration), `code` dans le bac (porte de
  qualité), `playbook` (une suite de LECTURES existantes). `validerManifest` dit tout ce qui est faux ;
  un id qui ressemble à une capacité de contrôle, d'enseignement ou de sécurité est refusé à la
  déclaration.
- **Les connecteurs déclarés** (`lib/skills/plugins/`) : DocuSign (envoyer à signer, statut), SAP (lire,
  créer une commande d'achat), HubSpot (contact, transaction), IQVIA (ventes de marché), PCH (appels
  d'offres, dépôt d'offre). Ajouter un connecteur = ajouter un manifeste ; le cœur n'a pas bougé pour
  ces cinq-là et ne bougera pas pour le sixième. Non configuré, un connecteur reste DÉCLARÉ : l'appel
  dit la ressource qui manque (`clé de configuration … non configurée`), jamais « pas prévu ».
- **Le runtime** (`platform/in-process/skills/index.ts`) charge la carte d'UNE personne (connecteurs +
  micro-outils + playbooks), l'autorise (le RBAC du manifeste, revérifié à chaque exécution), et
  DÉCLARE au registre ce que le cœur doit savoir sans le connaître : la méta de mission (effet,
  latence, primitive, confirmation) et le domaine de la liste courte — un connecteur est donc vu par
  le planificateur (`catalogueDe`), la conversation (`assistantToolsFor`) et la liste courte du
  domaine, sans une ligne de plus dans le cœur. Le cache par personne est invalidé par EMPREINTE
  (règles WORKFLOW + micro-outils) : un playbook enseigné à l'instant est là au tour suivant.
- **Les règles qui ne se négocient pas** : un effet qui écrit, communique ou engage rend un APERÇU
  (cible, corps — jamais un en-tête ni un secret) et n'exécute qu'avec `confirmer: true` après
  l'accord explicite de la personne ; dans une mission, c'est le RUNNER qui pose cet accord après la
  porte d'approbation (`preparerAppelMission`), jamais le modèle. Le chemin HTTP encode chaque valeur
  (une entrée ne réécrit pas l'URL) ; délai 15 s, réponse bornée ; débit `parMinute`/`parJour` compté ;
  une écriture exécutée s'inscrit à l'audit au nom de la personne.
- **Les micro-outils d'Adam** (`create_skill` → `AdamSkill`) : du code (JS, ou Python si le serveur l'a)
  avec un EXEMPLE d'entrée et des attentes closes ; le serveur inspecte, exécute, teste, valide — et
  n'expose l'outil (`skill_<nom>`) que si tout tient. TEMPORAIRE 24 h, visible du créateur seul,
  compté à l'usage ; la forme promise vaut à chaque appel, les attentes de l'exemple ne sont pas
  rejouées. PROMOUVOIR (`promote_skill`, PERSON / GROUP / COMPANY — vue globale pour la société) et
  JETER sont des gestes de PERSONNE : `policy/guard.ts` les refuse à l'agent à la compilation.
- **Teach Adam → playbook** : une règle WORKFLOW dont `params.playbook` porte `entrees`, `etapes`
  (`alias`, `outil`, `args` à gabarits) et `sortie` devient l'outil `playbook_<id>` : des lectures
  composées, versionnées avec la règle ; une étape d'écriture est refusée (elle passe par la
  proposition habituelle) ; profondeur bornée à trois.
- **Banc** : `manifest.test.ts` (validation, connecteurs, gabarits), `skills.test.ts` (découverte par
  la conversation, le planificateur et la liste courte ; RBAC ; HTTP avec `fetch` injecté — encodage,
  auth, 404, non configuré ; aperçu puis exécution confirmée, audit, débit ; cycle du micro-outil ;
  promotion refusée à l'agent et à un tiers ; playbook enseigné puis exécuté, écriture refusée),
  défi live `defi-skill-micro-outil` (créer, tester, utiliser dans le même fil).

### Ingestion universelle d'événements et communication omnicanale — mandat 5 §37

Un fait entre par UNE porte, quelle que soit sa provenance, et une mission peut attendre n'importe
lequel. `Event → identify → normalize → authorize → associate → trigger`.

- **Le catalogue** (`lib/events/catalogue.ts`) : ~31 types canoniques — l'ERP (pièce déposée,
  validation, tâche faite, paiement, livraison, statut réglementaire, contrat, appel d'offres), les
  communications (e-mail, message, réunion) et les systèmes externes (signature envoyée / étape /
  complète / refusée, commande d'achat SAP créée ou modifiée, facture reçue, transaction et contact
  CRM, données de marché IQVIA, livraison fournisseur, webhook non catalogué). Le planificateur le
  LIT (`planner/schema.ts`, `planner/plan.ts`) : `WAIT_EVENT` est quasi universel, et un fait inconnu
  entre quand même sous son nom brut (`WEBHOOK_RECEIVED`, `typeBrut`).
- **Le pur** (`lib/events/ingestion.ts`) : sept sources (`docusign`, `sap`, `hubspot`, `pch`, `iqvia`,
  `signature`, `generic`) ramenées à UNE forme — type, émetteur, références SÛRES « TYPE:id » (nos
  champs personnalisés chez le fournisseur), mentions LIBRES à résoudre, charge nettoyée de tout secret
  et bornée, confidentialité détectée. `decider` : une référence sûre ou un candidat ≥ 0,85 rattache ;
  entre 0,5 et 0,85 c'est À VÉRIFIER — jamais rattaché en silence ; en dessous, rien.
- **Le pont** (`platform/in-process/events/ingestion.ts`) : AUTORISER (secret par source
  `EVENTS_WEBHOOK_SECRET_<SOURCE>`, sinon `EVENTS_WEBHOOK_SECRET` ; sans secret la source est FERMÉE,
  503 ; HMAC-SHA256 du corps brut, 401 sinon), DÉDOUBLONNER (la ligne `IngestedEvent (source,
  externalId)` est RÉCLAMÉE avant toute conséquence : deux livraisons simultanées n'inscrivent qu'un
  fait — mesuré), ASSOCIER (la résolution d'entités du §24 : CERTAIN rattache, PROBABLE et AMBIGU
  s'inscrivent à vérifier avec leurs candidats, INCONNU s'oublie), INSCRIRE et RÉVEILLER par
  `recordEvent` — le registre canonique (§17), qui réveille lui-même les missions, réconcilie les
  tâches et ferme les engagements. Un fait « à vérifier » entre SANS ses références douteuses : la
  mission qui attend « une signature » repart, celle qui attend « LA signature du contrat X » attend
  qu'une personne lève le doute (`rattacherEvenement`, vue globale, audit, réveil).
- **La route** `POST /api/events/inbound/{source}` — publique, jamais ouverte : source inconnue 400,
  sans secret 503, signature fausse 401, corps hors JSON 400 ; en réponse des COMPTES (reçus, acceptés,
  doublons, rejetés, à vérifier), jamais le détail d'un refus.
- **Dans la conversation** : `inbound_events` (vue globale) montre les faits reçus avec leur statut
  d'association et leurs candidats ; `attach_inbound_event` est le geste de PERSONNE qui rattache —
  `policy/guard.ts` le refuse à l'agent à la compilation : un document lu par une mission ne décide
  pas à qui appartient une signature.
- **L'omnicanal, natif au moteur** : la table du niveau (`canauxPour`) est corrigée par ce que la
  personne a ENSEIGNÉ — clé `canalPrefere` (ERP seul, e-mail, Slack, Teams, WhatsApp, SMS ;
  « slack:#direction » porte la destination), clé `heuresSilence` (« pas de notification entre 22 h et
  7 h ») —, par ce qui est BRANCHÉ (les connecteurs de messagerie du §36, configurés et ouverts à
  elle : un canal préféré non branché laisse la table et le dit), et par la CONFIDENTIALITÉ (un signal
  marqué tel, ou une mission qui touche une capacité HR_SENSITIVE : le détail reste au centre de
  notifications, l'extérieur reçoit un corps neutre). Les heures de silence retiennent le push et le
  message (dit au journal, `differe`), gardent la notification et l'e-mail ; l'ARBITRAGE ne se laisse
  ni taire ni déplacer. Le connecteur est appelé par le runtime des skills (`<canal>_envoyer_message`,
  sous les droits de la personne) — la porte ne connaît ni Slack ni Twilio.
- **Banc** : `lib/events/ingestion.test.ts` (catalogue, sept sources, nettoyage, seuils),
  `platform/in-process/events/ingestion.test.ts` (autorisation, mission WAIT_EVENT réveillée par une
  enveloppe DocuSign référencée puis relivraison dédoublonnée, course de deux livraisons, mention
  ambiguë → à vérifier → rattachement humain → réveil, la route), `policy.test.ts` et
  `attention.test.ts` (canal préféré, silence, non branché, confidentiel), `skills.test.ts` (Slack JSON
  bearer, SMS basique + formulaire, non configuré), défi live `defi-evenement-attente` (Adam planifie
  une attente de signature, le webhook la réveille), banc live Playwright (webhook signé → 401 / 200 /
  doublon → Adam cite le fait dans l'interface).

### Médias et documents — repli à quatre paliers, audio et vidéo — mandat 5 §38

Un document se lit au palier le moins cher qui SUFFIT, page par page ; un enregistrement devient
une connaissance horodatée qu'on interroge à la seconde.

- **Les quatre paliers** (`lib/media/paliers.ts`, pur) : texte NATIF (le parseur déterministe a le
  dernier mot quand il a lu) → OCR ciblé (Mistral ou Tesseract, pages sans texte) → lecture
  VISUELLE RAPIDE (Luna, page rastérisée — OCR peu sûr, mince, ou contenu graphique) → modèle
  SUPÉRIEUR (par la passerelle des modèles, orchestrateur) pour les seules pages qui l'exigent :
  visées par la question et encore douteuses (`auto`), ou dès qu'un doute reste (`precis`). Le
  budget borne chaque palier par appel, le supérieur sous un PLAFOND ABSOLU de huit pages que
  rien ne lève — 500 pages scannées ne montent JAMAIS dans un gros modèle ; ce qui dépasse est
  rendu « hors budget », à demander. Chaque page sort avec sa méthode et sa confiance : VÉRIFIÉ
  pour du natif, PROBABLE ou INCERTAIN pour ce qu'un OCR ou un modèle a lu (calibration §29).
- **`pdf_read` lit par paliers** (`platform/in-process/media/lecture.ts`) : trois tours
  replanifiés sur ce qui a été lu et ce qui reste du budget ; `niveau` (rapide / auto / precis),
  `question` (les pages qui la portent passent devant), bilan par méthode, coût réel. Une image
  n'entre au modèle supérieur que par la passerelle (`askModelJsonAvecImages`) : mêmes portes —
  rôle, protocole, place, télémétrie, coût — que le texte ; bloc `image` base64 traduit par chaque
  fournisseur (`image_url`, `input_image`, `source: base64`), huit images par appel au plus, ~1 000
  jetons chacune dans l'estimation (jamais la longueur du base64, qui ferait refuser la place).
- **L'audio et la vidéo** (`lib/media/stt.ts`, `lib/media/transcription.ts`,
  `platform/in-process/media/transcription.ts`) : le moteur de parole rend des SEGMENTS
  horodatés (`verbose_json`), la langue et la durée — une vidéo passe telle quelle, sa piste
  audio suffit ; 25 Mo au plus, et la limite est dite (découpage impossible sans ffmpeg). Puis :
  les LOCUTEURS, attribués par fenêtres par le modèle rapide à partir des participants connus
  (sinon « Locuteur A/B ») et posés par le code — PROBABLES, une voix n'est pas une signature ;
  la STRUCTURE (chapitres aux silences, à la durée, au changement de vocabulaire — pur) ;
  l'EXTRACTION (décisions, engagements « qui, quoi, pour quand », actions, entités, questions
  ouvertes), chaque élément avec l'INSTANT du segment cité ; la CONNAISSANCE CHERCHABLE : le texte
  horodaté est indexé comme tout document du Drive, `MediaTranscript` garde la structure, une par
  version de fichier (retranscrire ne coûte rien).
- **« Où exactement Yassine a-t-il parlé du budget ? »** = `media_transcript` geste `chercher` :
  le segment, `mm:ss`, le locuteur, l'extrait — filtrable par locuteur — jamais un résumé qui
  aurait lissé l'instant. `structure` rend chapitres, temps de parole et extraction ; `regarder`
  (vidéo) ne regarde que les instants pertinents (ceux qui répondent à la question, sinon le début
  des chapitres), six images au plus, par le modèle rapide — et seulement si le serveur sait
  extraire une image (ffmpeg) ; sinon la limite est dite, la piste audio reste transcrite. Une
  pièce jointe audio ou vidéo dans la conversation est transcrite de la même façon, horodatée,
  dite PROBABLE.
- **Banc** : `paliers.test.ts` (règle par page, 500 pages → 40 OCR / 8 supérieures au plus, pages
  visées devant, rapport ; mesure `paliers_plafond`), `transcription.test.ts` (instant exact,
  locuteur, chapitres ; mesure `media_instant_exact`), `stt.test.ts` (formulaire, segments, 25 Mo,
  débit), `platform/in-process/media/media.test.ts` (PDF réel par paliers, page vide hors budget,
  transcription persistée et cherchée depuis le Drive, cache, vidéo sans ffmpeg, l'outil), défi
  live `defi-media-reunion` (une voix de synthèse déposée dans le Drive, Adam rend l'instant).


### Moteurs de calcul — simulation, optimisation, ordonnancement, statistiques — mandat 5 §39

Le chiffre est produit par le CODE, jamais par le modèle. Neuf moteurs PURS dans `src/lib/calcul/`
(pas de Prisma, pas de RBAC, pas d'appel de modèle : ils ne reçoivent que des nombres), un pont
`platform/in-process/calcul/`, quatre outils. Chaque résultat porte sa RIGUEUR — hypothèses,
limites, avertissements — et le modèle ne peut pas la retirer : elle est produite à côté du chiffre.

- **Le hasard reproductible** (`alea.ts`) : générateur à graine (xoshiro128\*\*), neuf lois
  (normale, log-normale, uniforme, triangulaire, PERT, discrète, Bernoulli, Poisson, constante),
  leurs QUANTILES — c'est par eux qu'une corrélation s'applique à n'importe quelle marginale
  (copule gaussienne) — et Cholesky. Même graine → mêmes tirages : un chiffre de risque qui change
  à chaque lecture n'est pas un chiffre.
- **Une formule sans `eval`** (`expression.ts`) : analyse syntaxique, précédence, fonctions
  connues, compilation en fermeture (200 000 évaluations < 1 s). Une formule est une DONNÉE ; ce
  qu'elle ne comprend pas à coup sûr est REFUSÉ avec la position de l'erreur, jamais deviné. Un
  système de formules est ordonné par dépendances, cycle et variable inconnue refusés.
- **Monte-Carlo** (`montecarlo.ts`) : jusqu'à 200 000 tirages hors modèle. Distribution complète
  (moyenne, écart-type, P1…P99, histogramme), probabilité de chaque seuil et de la perte,
  SENSIBILITÉ (Spearman, part de variance, écart bas/haut décile — le tornado), CONVERGENCE
  (à quelle précision la moyenne et le P90 sont connus), et le PIÈGE DES MOYENNES nommé quand la
  formule aux valeurs moyennes s'écarte de la moyenne simulée. Corrélations par copule ; une
  matrice incompatible est réduite ou ignorée, et c'est DIT.
- **Optimisation** (`simplexe.ts`) : simplexe en deux phases (règle de Bland contre le cyclage) et
  séparation-évaluation pour les variables entières et binaires. Le résultat porte les PRIX
  MARGINAUX (« une heure de plus sur la ligne A rapporte 3 500 DZD »), les contraintes saturées et
  le jeu de chacune. INFAISABLE et NON BORNÉ sont des RÉPONSES argumentées, pas des pannes. Avec
  des entiers, les duales n'existent pas : le code le dit plutôt que d'en inventer.
- **Ordonnancement** (`ordonnancement.ts`) : chemin critique (dates au plus tôt / au plus tard,
  marges totale et libre) puis calendrier SOUS RESSOURCES par règle de priorité. Le code dit quand
  c'est une ressource, et non la logique du projet, qui allonge le délai — et ne prétend pas à
  l'optimum sous ressources (NP-difficile) : il rend une solution réalisable et l'écart avec la
  borne du chemin critique. Une dépendance circulaire est une réponse, pas une panne.
- **Contraintes** (`contraintes.ts`) : affecter des CHOIX sous des règles logiques (gardes,
  dossiers, créneaux) — cohérence d'arc puis retour arrière (variable la plus contrainte d'abord).
  Sans solution, le code retire les règles une à une pour NOMMER celles dont dépend l'impossibilité,
  et rend l'affectation partielle la plus complète.
- **Statistiques** (`stats.ts`) : régression multiple (coefficients, intervalles, p-values, R²,
  R² en VALIDATION CROISÉE, VIF de colinéarité, Breusch-Pagan, Durbin-Watson), régression
  logistique (rapports de cotes, AUC, matrice de confusion), tests (Welch, apparié, χ²,
  Mann-Whitney) avec taille d'effet, corrélations avec significativité. La rigueur est ARITHMÉTIQUE :
  échantillon trop petit, absences non aléatoires, valeurs aberrantes, colinéarité, sur-apprentissage,
  FUITE DE DONNÉES (un R² de 0,999 vient plus souvent d'un prédicteur qui contient la réponse),
  significativité statistique ≠ importance métier, et « une association, pas une cause ».
- **Apprentissage** (`ml.ts`) : k-moyennes++ avec k choisi par la silhouette et groupes caractérisés
  en écarts-types, ACP par itération de puissance, anomalies par TROIS regards (écart robuste,
  Mahalanobis, facteur d'aberration LOCALE — comparer au médian global signalerait toute la queue
  d'un nuage pourtant sain). Les pièges sont nommés : sans normalisation c'est l'unité de mesure
  qui décide ; les k-moyennes trouvent TOUJOURS k groupes, même dans du bruit.
- **Séries temporelles** (`series.ts`) : Holt-Winters (niveau, tendance, saison additive ou
  multiplicative), période détectée par autocorrélation, ruptures de niveau au maximum local du
  saut. Une prévision se juge sur des points NON VUS : validation par fenêtre glissante, comparaison
  à « demain = aujourd'hui » et à la saison naïve, et l'intervalle vient de l'erreur MESURÉE hors
  échantillon — jamais des résidus d'ajustement, qui le rendraient deux fois trop étroit.
- **Les quatre outils** (`assistant/calcul-tools.ts`) : `calcul_montecarlo`, `calcul_optimisation`
  (linéaire ou contraintes), `calcul_ordonnancement`, `calcul_statistiques` (décrire, corrélations,
  régression, régression logistique, test, segmentation, ACP, anomalies, série). Aucun ne lit la
  base : les données arrivent par le bac à sable, qui porte le droit de leur source. Chaque réponse
  compose ses figures par le code (histogramme, Gantt, courbe, tableaux) et déclare sa provenance.
- **Le routage** : `CALCUL_EXPLICITE` (voie rapide et routeur) — « chemin critique », « loi
  triangulaire », « prix marginal » nomment une MÉTHODE, jamais un décor. Mesuré au banc : sans
  cette règle, « en combien de jours le dossier part-il ? » partait en lecture d'agenda et répondait
  « aucune donnée sur le planning » alors que la phrase contenait toutes ses données.
- **Banc** : 83 tests unitaires à réponses connues (Hillier, Vanderbei, sac à dos, affectation 4×4,
  Anscombe, tables de Student / Fisher / χ², 8 dames), quatre cibles (`montecarlo_exactitude`,
  `optimum_exact`, `rigueur_statistique`, `prevision_hors_echantillon`), trois défis live dont le
  juge REFAIT le calcul avec le moteur (`defi-montecarlo-budget`, `defi-optimisation-allocation`,
  `defi-ordonnancement-critique`) et un test Playwright de bout en bout dans l'interface.


### Réseau et géographie — chemins, centralités, communautés, territoires — mandat 5 §40

Les personnes, sociétés, produits, fournisseurs, contrats et dossiers ne sont pas des tables
séparées : c'est un RÉSEAU. Et une wilaya n'est pas un texte : c'est un point sur une carte.
Deux moteurs purs (`src/lib/graphe/`, `src/lib/geo/`), un pont qui applique les droits, deux outils.

- **Le graphe et son TEMPS** (`graphe/modele.ts`) : chaque lien porte une période de validité, et
  `auMoment` rend le réseau TEL QU'IL ÉTAIT. « Qui était responsable au moment de cette décision ? »
  n'a de réponse que si l'histoire n'est pas écrasée par le présent : un responsable remplacé ne
  disparaît pas, sa période se ferme. Un graphe sans temps répond toujours avec les gens
  d'aujourd'hui, et il a l'air d'avoir raison.
- **Les chemins** (`graphe/chemins.ts`) : le plus court chemin pondéré (un lien FORT rapproche),
  PLUSIEURS chemins distincts — un lien unique et trois liens indépendants ne se valent pas —, la
  portée d'une décision par niveau, les cycles, les composantes, et les POINTS DE RUPTURE : les
  nœuds dont le retrait couperait le réseau, avec ce qui se retrouverait isolé.
- **Qui compte** (`graphe/mesures.ts`) : quatre centralités qui ne disent PAS la même chose — le
  degré est un carnet d'adresses, PageRank une réputation transitive, l'INTERMÉDIARITÉ un point de
  passage (la personne dont le départ coupe l'entreprise en deux, même avec peu de liens), la
  proximité un accès. L'intermédiarité est rapportée au maximum THÉORIQUE : dans un réseau plat,
  personne n'atteint 1 — la rapporter au maximum observé désignerait un centre là où il n'y en a pas.
  Les COMMUNAUTÉS (Louvain) montrent les groupes que personne n'a déclarés.
- **La géographie** (`geo/distance.ts`) : distance orthodromique (un degré de longitude rétrécit
  avec la latitude — le calcul « à plat » perd des dizaines de kilomètres sur 2 400 km de pays),
  cap, enveloppe, barycentre pondéré calculé par les VECTEURS, zones, aires, densités par maille.
- **Les 58 chefs-lieux** (`geo/algeria.ts`) : sans eux, « montre-moi nos clients sur une carte »
  resterait une ressource manquante pour toujours — ce dépôt n'a pas de service de géocodage et
  l'ERP stocke des wilayas, pas des coordonnées. Chaque point est le SIÈGE de la wilaya, et la
  limite est dite à chaque réponse : dans le Sud, l'écart avec l'adresse réelle atteint des
  centaines de kilomètres.
- **Tournées, territoires, implantation** (`geo/tournee.ts`) : l'ordre de visite (plus proche
  voisin puis 2-opt, avec le GAIN sur l'ordre fourni), le découpage en territoires équilibrés sur
  la CHARGE et non la surface, et le point de Weber (Weiszfeld) qui minimise la distance pondérée
  — pas le barycentre, qui se laisse tirer par les lointains. Avec des sites CANDIDATS réels, le
  choix devient un p-médian EXACT ; au-delà de ce qu'une énumération supporte, le code renvoie au
  solveur en nombres entiers de §39 plutôt que d'approximer en silence.
- **Le pont applique les droits** (`platform/in-process/reseau/`) : un module qu'une personne ne
  voit pas ne fournit AUCUN nœud, donc aucun chemin ne passe par lui, et les types refusés sont
  NOMMÉS dans la réponse. Deux personnes aux droits différents voient deux réseaux — le graphe
  n'est pas une porte dérobée, et un test le vérifie depuis le vrai point d'entrée.
- **Le routage** : `RESEAU_EXPLICITE` — mesuré au banc, « comment le produit X est-il relié à la
  société Y ? » partait en recherche documentaire et répondait « aucune chaîne enregistrée » alors
  que le lien existait à un intermédiaire de distance. Chercher un CHEMIN n'est pas chercher un
  DOCUMENT, et un faux négatif dit avec aplomb ferme la question.
- **Banc** : 49 tests unitaires (villes réelles, coloriage de carte, pont entre deux triangles,
  anneau sans centre, huit dames géographiques), 6 tests d'intégration depuis le vrai point
  d'entrée (droits, temps, outil, absence de lien), quatre cibles (`graphe_droits`,
  `graphe_temporel`, `point_de_passage`, `geo_exactitude`) et deux défis live dont le juge REFAIT
  le chemin et la tournée avec les moteurs (`defi-reseau-chemin`, `defi-carte-tournee`).


### Fichiers et formats — ranger, dédoublonner, importer, convertir — mandat 5 §41

Douze mille fichiers, ce n'est pas douze mille clics. Et un import qui se trompe en silence coûte
plus cher qu'un import qui refuse. Deux familles de moteurs purs, un pont qui applique les droits
du Drive, quatre outils — et une règle qui ne se négocie pas : **rien ne se supprime**.

- **Ce qu'un fichier EST vraiment** (`formats/detection.ts`) : l'encodage (marque d'ordre,
  validité UTF-8, repli latin-1 — un export de tableur français EST en latin-1), le séparateur
  trouvé par la RÉGULARITÉ et non par la fréquence (un texte plein de virgules n'est pas un CSV à
  virgules), l'en-tête, et la LOCALE. « 1 234,56 » est français, « 1,234.56 » anglais, « 1,234 »
  AMBIGU — et « 03/04/2026 » n'est pas une date décidable tant qu'aucun jour ne dépasse 12. Ce qui
  est ambigu reste en texte : convertir au hasard se trompe une fois sur deux, en silence.
- **Lire et écrire un tableau** (`formats/tableur.ts`) : les lignes typées ET le rapport de
  lecture — décisions prises, lignes mal formées, colonnes de type MÊLÉ (elles restent en texte,
  un calcul dessus serait faux). La largeur de référence est l'en-tête ou la largeur la plus
  fréquente, jamais le maximum : une seule ligne à un champ de trop ne doit pas classer tout le
  fichier comme abîmé. À l'écriture, la locale française IMPOSE le point-virgule — une virgule
  décimale couperait les montants en deux, et le code le dit plutôt que de produire un fichier
  que le tableur de la personne lira de travers.
- **Ce qu'une conversion PERD** (`formats/conversion.ts`), dit AVANT : un classeur en CSV, c'est
  une feuille sur dix et zéro formule. Chaque conversion est LOSSLESS, DESTRUCTIVE (avec la liste
  exacte) ou INDISPONIBLE sur ce serveur — et l'indisponible nomme la ressource qui manque et
  l'alternative, jamais « impossible » tout court.
- **Les doublons, et ce qu'on n'en fait pas** (`fichiers/doublons.ts`) : trois natures qui
  n'appellent pas la même chose. IDENTIQUE (même empreinte — et le stockage partage déjà le
  contenu, donc supprimer une copie ne libère AUCUN octet), VERSION (« v2 », « FINAL », « (1) » :
  un historique mal rangé, pas un doublon), RESSEMBLANT (un SOUPÇON — deux devis homonymes pour
  deux clients différents ressemblent exactement à ça). Les orphelins sont candidats à
  l'ARCHIVAGE. Rien n'est jamais proposé à la suppression.
- **Ranger par le CONTENU** (`fichiers/classement.ts`) : « Scan_20260115_003.pdf » ne dit rien,
  mais « FACTURE N° » et un montant TTC disent tout. Chaque proposition CITE son indice, porte sa
  confiance et son emplacement d'ORIGINE. Sans contenu lisible, la confiance est PLAFONNÉE : ranger
  sur la foi d'un nom est exactement ce qui met une facture dans les contrats.
- **Un lot massif et ce qu'il promet** (`fichiers/lot.ts`) : l'aperçu AVANT toute modification,
  chaque geste réussi comme son propre point de reprise (§118.4), les échecs PASSAGERS réessayés
  et les refus de droit non, le lot qui CONTINUE (un fichier verrouillé n'arrête pas les 11 999
  autres), et un compte ARITHMÉTIQUE vérifié : demandés = faits + déjà faits + échoués. Le plan de
  retour est produit EN MÊME TEMPS que le plan d'aller ; un geste qui ne pourrait pas être annulé
  est refusé plutôt qu'exécuté.
- **Le pont applique les droits** (`platform/in-process/fichiers/`) : `canViewDrive` pour
  recenser, `canEditDrive` sur le fichier ET sur le dossier d'arrivée pour bouger. L'état d'AVANT
  est lu EN BASE, jamais reçu du modèle — un « avant » inventé produirait un « annuler » qui range
  le fichier ailleurs qu'à sa place. Et une suppression est refusée structurellement.
- **Le routage** : `contientDonneesCollees` — mesuré au banc, « j'ai reçu un export, je te le
  recopie » suivi de trois lignes en points-virgules partait lire la BOÎTE MAIL et répondait que
  le compte Google n'était pas connecté, alors que les données étaient dans la phrase.
- **Banc** : 43 tests unitaires (export latin-1 réel, séparateur piégé, locale ambiguë, doublons
  des trois natures, lot de 12 000 gestes, reprise, budget de temps), 7 tests d'intégration depuis
  le vrai point d'entrée (droits, idempotence, refus de suppression, aller-retour complet), quatre
  cibles et deux défis live (`defi-import-tableur`, `defi-conversion-perte`).

### Contradictions, lignée et questions ouvertes — mandat 6 §46

L'ERP dit 15 M€, le classeur 17, l'e-mail 16,5. Trois façons de mal s'en sortir : prendre le
premier trouvé, prendre le plus récent sans le dire, ou faire une moyenne — la seule réponse dont
on est certain qu'aucune source ne la porte.

- **La première question n'est pas « qui a raison », c'est « est-ce la même question ».** Neuf
  fois sur dix, trois chiffres différents sont trois réponses à trois questions légèrement
  différentes : HT contre TTC, périmètre Adventum contre groupe, arrêté au 30 juin contre au
  31 juillet. Le moteur teste le CONTEXTE en premier et rend `PAS_LA_MEME_QUESTION` — parce que
  résoudre cela comme un conflit ferait un gagnant et deux perdants là où les trois avaient
  raison, et masquerait la vraie information : le contexte manquait.
- **Une valeur DÉRIVÉE n'est pas un témoin.** Un chiffre obtenu en multipliant l'autre par 1,19
  ne vote pas : le compter doublerait la voix de sa source.
- **L'autorité est par TYPE DE FAIT, pas générale.** L'ERP fait autorité sur un montant
  enregistré ; le contrat SIGNÉ fait autorité sur une clause, même si l'ERP dit autre chose. Une
  hiérarchie unique « ERP > document > e-mail » se tromperait systématiquement sur la deuxième
  ligne.
- **Et quand rien ne départage, deux issues, jamais un choix** : `A_CHERCHER` (le code NOMME
  l'information qui trancherait — « le périmètre exact de chaque valeur ») ou `A_TRANCHER` (la
  question posée à une personne, avec les options et ce qui les distingue). Un moteur qui
  conclurait faute de mieux est exactement ce que le mandat interdit.
- **La lignée d'un chiffre** (`lib/verite/lignee.ts`) : « 41,3 M$ = 3 sources → doublons
  supprimés → conversion → consolidation ». Ce n'est pas une jolie phrase : c'est la seule forme
  sous laquelle un dirigeant peut contester UNE étape au lieu de rejeter le chiffre entier — ou,
  pire, de l'accepter faute de pouvoir le discuter. Chaque étape porte ses lignes entrantes et
  sortantes, et **une étape qui perd des lignes sans le dire est signalée** : c'est le défaut le
  plus silencieux, et il explique la plupart des écarts entre deux chiffres censés être le même.
- **Un résultat qui ne remonte à aucune source est REFUSÉ.** Ce n'est pas un résultat, c'est une
  affirmation — et `prouve: false` interdit de le présenter comme établi. Les cycles aussi sont
  bloquants ; les étapes qui ne contribuent à rien sont signalées sans bloquer.
- **Questions ouvertes et hypothèses : elles EXISTENT déjà.** Une décision `PROPOSED` du registre
  exécutif EST une question ouverte ; une décision qui porte un résultat attendu et une date de
  relecture EST une hypothèse, et `update_decision_outcome` la referme avec le résultat RÉEL. Le
  lot ne crée donc aucune table : il ajoute la LECTURE qui manquait (`ouvertes`), celle qui
  remonte les questions restées ouvertes et les hypothèses dont la date de relecture est passée
  sans verdict — c'est-à-dire celles qu'on a oublié de rejuger.
- **`verite_reconcilier`** : `reconcilier`, `lignee`, `ouvertes`. Les valeurs sont FOURNIES par
  l'appelant, et c'est délibéré : elles viennent de trois outils différents, appelés sous les
  droits de la personne, chacun avec sa provenance. Un moteur qui irait les relire lui-même
  court-circuiterait ces droits et perdrait la provenance. Adam lit, puis confronte.
- **Banc** : 15 tests purs (les six issues du moteur, l'autorité qui s'inverse sur une clause, la
  moyenne qui n'apparaît nulle part, la lignée racontée dans l'ordre, le résultat sans source
  refusé, le cycle bloquant) et 7 tests d'intégration par l'outil réel, questions ouvertes créées
  via `record_decision`. Trois cibles (`jamais_de_moyenne`, `meme_question_dabord`,
  `chiffre_prouve`).

### Le front-end génératif : afficher ce qu'on veut, comme on veut — mandat 7

« Adam affiche ce qu'il veut, comme il veut » a une réponse évidente et catastrophique : laisser
le modèle produire du HTML. Elle échoue sur trois points, et le premier suffit — **le contenu lu
est une DONNÉE** (§104.10). Un mail, un PDF, une cellule Excel passent par le modèle avant
d'atteindre l'écran ; si le modèle peut émettre du balisage, une phrase écrite par un tiers dans
un document le peut aussi, et le jour où elle le fait plus rien ne la distingue de la nôtre.

- **La composition est libre, le rendu est fermé.** Six CONTENANTS — COLONNES, LIGNES, SECTION,
  ONGLETS, PILE, ACCENT — composables à toute profondeur, autour de FEUILLES qui *désignent* les
  blocs existants (§35) par leur index. Un arbre de six formes autour de vingt-et-un blocs
  produit un nombre de mises en page qu'aucune bibliothèque de composants n'atteindra — sans
  qu'une seule chaîne de caractères issue d'un modèle ne devienne du balisage. « Comme il veut »
  porte sur l'AGENCEMENT, et c'est exactement ce qui manquait.
- **`compiler` refuse et NOMME**, comme le compilateur de missions (§118.3) : un bloc que l'écran
  ne sait pas rendre, une forme inventée, un contenant vide, des onglets sans étiquettes, deux
  enfants sous un ACCENT (« deux accents n'accentuent plus rien »), et un titre qui contient du
  balisage — refusé, pas assaini : l'assainissement afficherait proprement `&lt;script&gt;` et
  passerait à autre chose, alors qu'on veut SAVOIR qu'un modèle ou un contenu injecté a essayé.
  Le refus dit OÙ par un chemin lisible (`racine > colonnes[1] > section[0]`), jamais un index nu.
- **Les bornes sont dures.** Un modèle qui se trompe ne produit pas un peu trop, il produit
  beaucoup trop : 120 nœuds, 6 niveaux, 24 enfants. Un arbre de dix mille nœuds ne casse pas le
  rendu — il fige le navigateur, et un figeage ressemble à une panne réseau, donc personne ne
  cherche du côté de la planche.
- **Un agencement refusé ne fait JAMAIS perdre le contenu.** Les blocs ont coûté des lectures :
  on retombe sur une pile et on dit ce qui a été refusé, plutôt que de faire semblant d'avoir
  obéi. Perdre la mise en page est une gêne ; perdre le résultat est une panne.
- **« Sous l'angle qu'il veut » : cinq angles, calculés sur les lignes DÉJÀ lues.** PAR_VALEUR,
  PAR_PERIODE, CLASSEMENT, CROISEMENT, ECARTS. Un angle ne relit rien — il ne peut donc pas
  montrer autre chose que ce qui a été montré. Et il DIT toujours ce qu'il a écarté : « 28 sur
  34, 6 sans date » se lit, « 28 » ment par omission. Une somme partielle vaut `null` plutôt
  qu'un nombre qui aurait l'air complet, et le total porte sur tous les groupes retenus, pas
  seulement sur ceux affichés — l'écart entre les deux est exactement ce qui trompe.
- **Les angles proposés écartent ce qui n'informe pas** : un champ dont toutes les lignes portent
  la même valeur ne fait qu'un groupe, un champ presque toujours distinct en fait autant que de
  lignes. Entre les deux vit l'information. *Défaut trouvé en écrivant ce module :*
  `new Date(120000)` réussit — c'est le 1er janvier 1970 à 00:02 —, si bien que TOUTE colonne
  numérique passait pour une colonne de dates et qu'on proposait de grouper les MONTANTS par
  mois. Un nombre n'est plus une date : l'appelant qui porte des horodatages les convertit, lui
  seul sachant ce que sa colonne contient.
- **La liste des blocs rendables ne dérive pas en silence** : un test lit la vraie table
  `RENDERERS` du composant et compare. Un `composer_planche` qui accepterait un bloc que l'écran
  ignore afficherait un TROU là où le compilateur a dit oui — et personne ne cherche du côté du
  compilateur quand un bloc manque.

### L'optimiseur qualité-d'abord — mandat 6 §50

Un optimiseur de coût converge toujours vers le moins cher : c'est sa définition. Ce qui l'en
empêche n'est pas une bonne intention, c'est un PLANCHER par classe de tâche.

- **La hiérarchie est écrite, pas espérée : qualité > coût > latence.** Le tri par prix
  n'intervient qu'APRÈS la porte de qualité, jamais dans le même calcul — deux grandeurs qu'on
  n'additionne pas ne peuvent pas se compenser. La latence arrive en troisième et ne départage
  qu'à coût égal.
- **Neuf classes, neuf planchers, et une raison chiffrée pour chacun.** FINANCE à 99 % parce
  qu'une erreur de trois dinars se découvre au rapprochement bancaire six semaines plus tard et
  coûte une demi-journée à deux personnes — sans commune mesure avec l'économie d'un modèle.
  TRIVIAL à 85 % parce que c'est le SEUL endroit où l'on économise agressivement. Aucune classe,
  pas même TRIVIAL, ne tolère une erreur d'arithmétique.
- **LA RÈGLE QUI FAIT TOUT LE TRAVAIL : une paire (classe, modèle) non mesurée n'est pas une
  option bon marché, c'est une inconnue.** Sans elle, l'optimiseur choisirait systématiquement le
  moins cher, puisque l'absence de mesure ressemble à l'absence de problème. Trois refus
  s'ensuivent, chacun avec ses nombres : NON_MESURE, MESURE_MAIGRE (« 100 % sur trois essais est
  une anecdote » — `observationsMin` monte avec l'enjeu), MESURE_PERIMEE (90 jours : les modèles
  bougent sous le même nom).
- **Cinq classes ne se désescaladent JAMAIS**, mesure parfaite sur mille essais comprise :
  FINANCE, REGULATORY, LEGAL, DECISION, DOCUMENT_EXECUTIF. Un dépôt ne se rejoue pas. Ce n'est
  pas une exception marginale — c'est la moitié du travail sérieux, et la décision le DIT
  (« aucune économie n'est cherchée ici, et c'est délibéré »).
- **L'escalade exige un CONSTAT écrit**, jamais une impression : un verdict de §49, un contrôle
  qualité raté, une erreur trouvée. Elle monte d'UN cran, et au sommet elle s'arrête en le
  disant au lieu de réessayer le même. C'est ce qui rend 100 % des appels premium justifiables.
- **Le North Star est le coût par mission RÉUSSIE**, et il vaut `null` quand rien n'a réussi —
  le présenter comme nul serait un mensonge. Le seuil exact est un RAPPORT (un modèle K fois
  moins cher gagne s'il réussit plus de 1/K fois autant), ce que « coût par mission » cache
  complètement. Et le ratio dit ce qu'il ne compte pas : le temps de la personne qui découvre
  l'erreur, et la confiance perdue — les deux coûts les plus lourds d'un échec.
- **Les prix ne sont jamais recopiés.** Les candidates sont construites depuis `allBindings()`,
  donc depuis la grille datée du registre, remplaçable par variable d'environnement. Un rôle sans
  tarif connu ne devient pas une candidate : la même règle que pour la qualité.

### Vérifier à proportion du risque, et apprendre sans apprendre tout seul — mandat 6 §49

Vérifier deux fois chaque chiffre double le coût et **fait baisser la qualité perçue** : quand
tout est marqué « vérifié », plus rien ne l'est. Ne rien vérifier a un coût qui ne se voit qu'une
fois, très cher. La vérification se CALCULE donc, et le calcul est exposé.

- **Quatre facteurs, et le dernier est celui qu'on oublie.** L'irréversibilité (un e-mail parti,
  §48), l'exposition (moi → équipe → direction → partenaire → autorité), l'enjeu (montant,
  échéance réglementaire), et surtout la **FRAGILITÉ DE L'OBTENTION** : un chiffre lu dans une
  colonne est solide, le même reconstitué par un modèle depuis un PDF scanné ne l'est pas, et
  c'est indépendant de son importance. La plupart des erreurs coûteuses ne portent pas sur des
  sujets négligés — elles portent sur des sujets importants dont la donnée a suivi un chemin
  fragile. Score → AUCUN / LEGER / APPUYE / ADVERSARIAL.
- **Sept méthodes, et chacune déclare CE QU'ELLE NE VOIT PAS.** C'est plus important que ce
  qu'elle attrape : la faute la plus coûteuse d'un système de vérification n'est pas de rater une
  erreur, c'est de faire croire qu'il l'aurait vue. Le SECOND MODÈLE porte la ligne décisive —
  deux modèles d'accord sur le même contexte ne prouvent rien quand l'erreur est DANS le
  contexte : leur accord est un écho, pas une preuve. Le RECALCUL passe premier quand il
  s'applique : gratuit, et le seul qui PROUVE.
- **Une méthode inapplicable n'est jamais proposée.** Pas de recalcul sur une phrase, pas de
  source alternative pour une assertion qui n'a pas de première source. Une méthode proposée
  puis « passée » compterait comme une vérification faite : c'est ainsi qu'un tableau de bord
  finit par afficher 100 % de couverture sans rien couvrir. Le programme porte aussi les angles
  morts de ce qu'il n'a PAS fait.
- **Le sens négatif l'emporte, toujours.** Un recalcul qui contredit bat quatre confirmations —
  ce n'est pas une voix parmi cinq, c'est une preuve. Un second modèle en désaccord ne tranche
  pas : c'est un DOUTE, « il faut regarder, pas arbitrer ». Et une méthode qui n'a pas pu
  s'exécuter ne confirme RIEN : le verdict devient NON_VERIFIE et le dit. Même tout confirmé, la
  phrase rendue est « aucune méthode ne l'a contredit », jamais « c'est vrai ».
- **L'échantillonnage est déterministe.** Un tirage aléatoire rendrait deux runs incomparables,
  donc la mesure impossible. Bornes + pas régulier, et la part échantillonnée suit la fragilité
  de l'obtention (2 % pour une lecture directe, 50 % pour une assertion de modèle).
- **Les échecs ne sont pas collectés : ils sont déjà écrits.** `MissionEvent` porte depuis §44 un
  `STEP_FAILED` avec `detail.manque`. Le Failure Learning System est une LECTURE de ce journal,
  regroupée par cause + nature + capacité — pas sur le texte de la demande, parce que deux
  formulations du même défaut resteraient sinon toutes deux sous le seuil, c'est-à-dire
  invisibles indéfiniment.
- **La récurrence est le signal, pas l'échec.** Un échec unique est du bruit (un service qui
  hoquette, un scan raté). Trois fois la même cause est un défaut. Une correction humaine vaut le
  seuil à elle seule : c'est la meilleure preuve qu'il y avait quelque chose à corriger. Une
  panne de fournisseur, elle, n'enseigne RIEN et ne produit aucune leçon.
- **Et rien ne s'applique tout seul (§118.12).** Une leçon est une proposition portant sa preuve,
  son compte, ses exemples et QUI doit l'approuver. Il n'existe pas d'`appliquerLecon` à appeler
  par mégarde. La liste d'actions est FERMÉE et aucune ne touche à un droit : la cause PERMISSION
  ne peut proposer que de POSER LA QUESTION à un humain. Le pire qu'une leçon approuvée puisse
  faire est d'ajouter un test — et l'eval qu'elle propose attend le MANQUE NOMMÉ tant que la
  primitive n'existe pas, car un test rouge pour toujours finit ignoré.

### Défaire ce qui a été fait — mandat 6 §48

« Annule ce qu'Adam a modifié sur ce dossier hier » est une demande raisonnable dont la réponse
honnête est presque toujours PARTIELLE. Le statut revient ; l'e-mail parti chez le partenaire,
non. Un système qui répondrait « c'est annulé » aurait menti sur la moitié de la phrase, et le
mensonge ne se verrait qu'au moment où le partenaire répond à un message censé ne pas exister.

- **L'instruction d'annulation existe DÉJÀ.** `AuditLog` porte `field` / `oldValue` / `newValue`
  pour chacune des cinq cents écritures de l'ERP : défaire, c'est LIRE cette ligne et réécrire
  l'ancienne valeur. Aucune table de versions n'a été créée — elle redirait la même chose une
  seconde fois et divergerait (§17).
- **L'INVARIANT, et c'est le seul qui compte.** On ne défait un changement que si la valeur
  actuelle est ENCORE celle qu'Adam a écrite. Adam met le dossier à AWAITING_ANPP lundi ; Yassine
  le passe à BLOCKED mardi parce que l'échantillon est refusé ; l'annulation naïve remettrait
  IN_PREPARATION et effacerait le travail de Yassine sans que personne ne le voie. Le geste est
  donc refusé en NOMMANT qui a changé quoi et quand. Techniquement, la condition est dans le
  `where` du `updateMany` : c'est PostgreSQL qui l'évalue au moment d'écrire, `count === 0`
  voulant dire « quelqu'un est passé entre l'aperçu et maintenant ». Un `findFirst` suivi d'un
  `update` laisserait une fenêtre, et c'est exactement pendant cette fenêtre qu'un collègue
  enregistre depuis son écran (même principe que §104.8).
- **Quatre réponses, parce que deux mentent.** RÉVERSIBLE (on réécrit) · DÉLÉGUÉE (Live Office
  §104.3 annule une retouche par REJEU, Teach Adam §31 désactive une version — on ne réécrit pas
  un second mécanisme) · PAR COMPENSATION (le geste reste, un geste inverse le corrige : un
  rectificatif, un avoir, une demande de signature révoquée) · IRRÉVERSIBLE (l'e-mail est lu, le
  virement est à la banque, le dossier appartient à l'autorité). Tout ce qui n'est pas réversible
  DOIT porter sa compensation ou son délégataire : un « non » sans suite est une impasse, et un
  test le vérifie pour chacune des dix natures de geste.
- **La signature l'emporte sur le verbe.** Un paiement exécuté EST un `UPDATE` du champ `status` :
  le ranger en CHAMP_MODIFIE le rendrait « réversible », c'est-à-dire qu'Adam proposerait de
  dé-payer un fournisseur. Les signatures précises (virement émis, dépôt ANPP, signature demandée,
  e-mail envoyé) sont donc testées AVANT l'action générique.
- **Une annulation est un CHANGEMENT, jamais une gomme.** Elle passe par `recordFieldChanges`,
  apparaît dans le journal, dans l'historique de l'écran, dans le modèle du monde (§45), et elle
  est elle-même annulable. La ligne d'origine survit — une couche d'annulation qui réécrirait
  l'audit serait pire que pas de couche du tout.
- **Deux temps, et le premier n'écrit rien.** « voir » compose et montre ; « appliquer » n'exécute
  que ce que « voir » a montré (`changements` borne encore davantage). Ce n'est pas une précaution
  d'usage : une annulation porte sur des gestes que la personne a oubliés — c'est pour cela
  qu'elle demande — et la liste est la seule façon qu'elle découvre l'e-mail parti.
- **Aucun droit propre.** Le pont vérifie `VIEW` sur le module de l'entité pour l'aperçu et
  `UPDATE` pour l'écriture, au moment de s'en servir. Un VIEWER ne voit rien d'un dossier
  Regulatory ; la DIRECTION voit une validation et ne peut pas l'annuler ; et un VIEWER PEUT
  défaire un changement de tâche, parce qu'il peut réellement modifier une tâche. L'outil ne
  restreint ni plus ni moins que l'écran. Les champs restaurables sont en outre une LISTE FERMÉE
  avec leur conversion : le nom du champ vient d'une ligne de journal, donc d'une donnée.

### L'objectif durable et sa probabilité expliquée — mandat 6 §47

« Je veux qu'on soit prêts pour l'AO 2027 » n'est pas une mission. Une mission se ferme ; un
objectif se surveille APRÈS que les missions se sont fermées, et c'est précisément là que tout
se perd d'habitude : les cinq missions ont réussi, la case n'est pas cochée, et personne ne le
voit avant l'échéance.

- **Un objectif est une table à lui (`ExecutiveObjective`), et c'est la seule de ce lot.** §17
  interdit un second registre, mais un objectif durable n'est ni une mission, ni une décision,
  ni un engagement : il leur SURVIT et les agrège. Il porte son énoncé MOT POUR MOT (ce que la
  personne a dit, jamais la reformulation seule), ses critères de succès, ses jalons avec leurs
  dépendances, ses risques, ses liens causaux, et les missions lancées pour lui.
- **« 78 % » ne sort JAMAIS seul.** Le nombre a l'air d'un résultat et n'en est pas un : c'est
  une agrégation de faits observés pondérée par des poids déclarés dans le code
  (`objectif/probabilite.ts` : retard 0,30 · blocage 0,20 · risques 0,15 · temps 0,15 · réussite
  sans preuve 0,12 · inconnus 0,08). Il vient donc toujours avec ses facteurs, la PREUVE de
  chacun, le facteur négatif principal nommé — « le retard des dossiers X et Y » — et ses
  `limites`, qui disent en toutes lettres qu'aucun modèle statistique n'a été ajusté. Le dire
  n'est pas de la modestie : c'est ce qui permet de contester un poids au lieu de subir un
  chiffre. La probabilité est bornée à [2 %, 98 %] — un objectif à 100 % est un objectif atteint,
  et un objectif atteint se constate.
- **L'ignorance ne se punit pas, elle se DIT.** Un critère INCONNU sort du dénominateur : le
  compter en échec punirait l'ignorance, le compter en réussite la récompenserait. Il fait
  chuter la CONFIANCE dans l'estimation, et dès qu'un tiers des critères sont inconnus,
  l'estimation se déclare faible — quelle que soit l'arithmétique.
- **Un critère ATTEINT sans preuve pèse autant qu'un vrai retard.** Ce n'est pas de l'avance :
  c'est un risque déguisé en avance. Et rien ne se coche tout seul : aucune mission terminée ne
  passe un critère au vert, parce que le travail fait n'est pas le résultat obtenu.
- **Les dépendances causales sont DÉCLARÉES, avec leur hypothèse.** `objectif/causal.ts` propage
  un choc (« le dossier glisse de deux mois ») en multipliant les confiances le long du chemin,
  signale les flèches sans hypothèse écrite, plafonne celles sans preuve à l'état de SUPPOSITION,
  détecte les cycles, et rend le CHEMIN de chaque impact pour qu'on puisse contester une flèche
  plutôt que la conclusion. Un objectif sans lien déclaré ne se simule pas : il rend un refus,
  jamais un scénario deviné.
- **La conversation n'est pas une porte dérobée.** L'outil `objectif_durable` n'a aucun droit
  propre : le PONT (`platform/in-process/objectif/`) réserve les objectifs au siège exécutif et
  cloisonne PAR REQUÊTE sur `ownerId` — un identifiant deviné ne rend rien, ni en lecture ni en
  écriture.

### Le modèle du monde et la vérité temporelle — mandat 6 §45

L'ERP sait ce qui EST. Il ne savait pas ce qui ÉTAIT. « Qui était responsable au moment de cette
décision ? » recevait le nom du responsable d'aujourd'hui — une réponse fausse, donnée avec
assurance, et impossible à distinguer d'une bonne.

- **Aucune table nouvelle, et c'est le point.** L'histoire de l'entreprise est DÉJÀ écrite ; elle
  n'était simplement pas lue comme une histoire. `AuditLog` note chaque changement de champ
  (« passé de A à B, le 12 mars, par un tel »), `BusinessEvent` chaque fait métier avec son
  `occurredAt` distinct de son inscription, `EntityLink` chaque relation déclarée. Une table
  « WorldFact » aurait dupliqué tout cela, divergé en trois semaines, et à la première divergence
  personne n'aurait su laquelle croire (§17).
- **Fermer les intervalles** (`lib/monde/temps.ts`) est toute l'idée : une suite de changements
  datés EST un historique — la valeur A vaut JUSQU'AU 12 mars, la valeur B À PARTIR DU 12 mars.
  La valeur d'origine, elle, vit dans le `oldValue` de la première ligne : sans elle, la période
  la plus longue de l'histoire disparaîtrait.
- **Deux temps, et les confondre est la faute classique.** Le temps de VALIDITÉ (`depuis` /
  `jusqua`) dit quand le fait était vrai ; le temps de CONSTAT (`constateLe`) dit quand nous
  l'avons su. Une passation effective le 1er juillet mais saisie le 21 sépare les deux — et
  `vrai_et_su` rend les deux réponses côte à côte. Ce n'est pas une subtilité : c'est ce qui
  permet de juger équitablement une décision prise le 5, sur la foi d'un responsable périmé que
  personne ne pouvait encore corriger.
- **Une borne ouverte est INCONNUE, pas infinie.** `jusqua: null` veut dire « encore vrai à notre
  connaissance », `depuis: null` « vrai depuis avant ce que nous savons ». La durée d'un
  intervalle à borne ouverte est `null`, pas zéro, et il faut demander explicitement le temps
  ÉCOULÉ pour en obtenir un.
- **Un champ non journalisé n'a PAS de passé.** Ces faits arrivent marqués `COURANTE` : leur
  valeur d'aujourd'hui est connue, leur passé ne l'est pas, et une question sur mars rend
  INCONNU. Un modèle du monde qui compléterait les trous par l'état actuel serait pire qu'aucun
  modèle — il aurait l'air de savoir. Chaque réponse porte donc sa `couverture` : ce qui a une
  histoire, ce qui n'en a pas, et depuis quand le modèle sait quelque chose.
- **Les contradictions sont détectées, pas résolues.** Deux valeurs qui se recouvrent sur un
  prédicat FONCTIONNEL (un statut, un responsable, un prix) sont signalées avec leur période et
  la constatation la plus récente — en recommandation, jamais en verdict : la résolution
  déterministe est le sujet de §46, et trancher sur un seul critère serait le choix arbitraire
  que le mandat proscrit. Les prédicats non fonctionnels (« rattaché à ») ne sont pas signalés :
  deux rattachements simultanés sont normaux, et les compter ferait du bruit en masse.
- **Le pont applique les droits** (`platform/in-process/monde/`) : chaque type d'entité est
  rattaché à son module, et un dossier hors de la portée de la personne est REFUSÉ en le disant.
  « Pas le droit de regarder » et « rien trouvé » ne sont pas la même phrase.
- **`monde_temporel`** : cinq questions — `qui_etait`, `etat_a`, `changements` (avec l'AVANT et
  l'APRÈS et l'auteur), `recit` (chronologie + contradictions), `vrai_et_su`.
- **Banc** : 14 tests purs (bornes incluse/exclue, fermeture d'intervalles, validité contre
  constat, non-rétro-projection d'un champ non journalisé, contradictions sur les seuls prédicats
  fonctionnels) et 7 tests d'intégration écrits par le VRAI chemin — `recordFieldChanges`, la
  fonction que les cinq cents écritures de l'ERP appellent déjà. Trois cibles
  (`verite_temporelle`, `passe_non_invente`, `vrai_vs_su`).

