### Le banc d'autonomie générale — mandat 6 §43

Deux à cinq cents missions **jamais vues**, engendrées à partir des entités réelles de la base,
jugées sur l'ÉTAT et non sur la prose, et classées par cause quand elles échouent. C'est la
mesure qui dit si Adam est autonome — et, quand il ne l'est pas, où exactement.

- **Le corpus est ENGENDRÉ, pas recopié** (`lib/evals/autonomie/corpus.ts`, PUR). Trois cents
  phrases écrites à la main vieillissent ensemble, parlent de gens partis, et — surtout —
  appellent des réponses attendues écrites à la main, c'est-à-dire la solution codée en dur que
  le mandat interdit. Ici un GABARIT est rempli avec des entités lues en base au moment du
  tirage : le corpus change quand l'entreprise change, sans qu'on touche au fichier.
- **Seize familles**, dont une qui n'existe nulle part ailleurs : **INFAISABLE**. Un banc qui ne
  contiendrait que des tâches réalisables mesurerait la compétence et laisserait l'honnêteté hors
  du cadre — or « 0 faux succès » est une cible, et un faux succès ne se produit que là où la
  tâche ne pouvait pas être faite. Ces missions sortent du dénominateur de la réussite et entrent
  dans deux autres mesures : le manque a-t-il été NOMMÉ, et le succès a-t-il été feint ?
- **Ce qui est attendu n'est jamais une réponse : c'est une FORME.** « Cette mission exige de
  lire avant d'agir », « celle-ci exige un éventail de 33 étapes — le chiffre EXACT de
  l'effectif », « celle-là est ambiguë : la bonne conduite est de demander », « cette autre est
  infaisable : la bonne conduite est de nommer ce qui manque ». Dix exigences, toutes vérifiables
  sur l'état réel de la mission, aucune truquable en modifiant un fichier d'attendus.
- **Le juge lit le REGISTRE, il ne redevine pas** (`juges.ts`). Effet, primitive et domaine d'une
  capacité viennent de `capabilityMeta` — celui du compilateur. Mesuré au premier run : un juge
  qui cherchait `/^calcul_/` notait « aucun calcul » sur un plan appelant `product_economics`,
  une capacité de CALCUL selon le registre. Deux classements du même objet divergent toujours.
- **« Réussie » exige quatre choses à la fois**, et l'ordre dit la doctrine : l'objectif JUGÉ
  atteint (§118.10 — sans juge, on ne conclut pas), la forme tenue, aucun droit franchi, aucune
  affirmation sans preuve. « Toutes les étapes ont tourné » n'y figure pas.
- **Le faux succès a son propre compteur, sans marge.** Quatre formes : une mission infaisable
  conclue COMPLETED ; une mission conclue sans qu'un juge se soit prononcé ; une mission conclue
  contre l'avis du juge ; une mission conclue avec une cardinalité fausse — un message pour
  trente-trois personnes. Une mission ratée coûte un tour ; une mission qui se DÉCLARE réussie
  coûte la confiance, et personne ne vérifie ce qu'un système affirme avoir fait.
- **Les neuf causes du mandat** (planificateur, primitive absente, découverte, donnée, contexte,
  permission, exécution, rendu, modèle) se DÉDUISENT de l'endroit de l'échec puis de sa signature,
  classée par le registre des manques (§44) — pas par un second vocabulaire d'erreurs. Deux
  distinctions comptent plus que les autres : « la capacité existait et n'a pas été trouvée »
  (DÉCOUVERTE) n'est pas « rien ne sait le faire » (PRIMITIVE ABSENTE), et « la recherche n'a rien
  ramené » (CONTEXTE) n'est pas « la donnée n'existe pas » (DONNÉE). Chaque paire appelle un
  travail opposé.
- **Deux profondeurs, et deux chiffres différents.** `plan` planifie et COMPILE sans exécuter : un
  appel de modèle par mission, donc deux cents missions en une passe, et un score de
  PLANIFICATION. `complet` conduit la mission jusqu'à un état stable, accord donné comme le
  dirigeant le donnerait : c'est le seul niveau qui produise un GENERAL AUTONOMY SCORE. Les
  confondre serait se flatter — un plan qui compile n'est pas une mission accomplie.
- **N contre N+1, et le refus de comparer l'incomparable.** Le score se compare au précédent run
  de MÊME graine, MÊME profondeur, MÊME taille de corpus ; sinon la fonction refuse et dit
  pourquoi. Sans cette garde, une amélioration pourrait n'être qu'un tirage plus facile. Les
  régressions sont NOMMÉES une par une, jamais noyées dans le score global.
- **Ce que le score ne contient pas, volontairement** : le coût et la latence. Ils sont mesurés
  et rapportés à côté. Les faire entrer dans la note permettrait de compenser une régression de
  qualité par une économie — exactement l'inverse de la hiérarchie du mandat.
- **Banc** : 28 tests purs (reproductibilité du corpus, couverture des seize familles, absence de
  répétition, les neuf causes toutes atteignables, les quatre formes de faux succès, la somme des
  poids, le refus de comparer deux corpus différents) ; `npm run autonomy:bench` et
  `npm run autonomy:bench:complet` ; cinq cibles (`autonomie_reussite`, `autonomie_faux_succes`,
  `autonomie_droits`, `autonomie_gaps_classes`, `corpus_reproductible`).

### Le registre des capacités et ce qui manque — mandat 6 §44

« Je ne peux pas » est la phrase la plus coûteuse du produit : elle ne dit ni pourquoi, ni ce qui
manque, ni ce qu'il faudrait pour que ce soit possible. Ce lot la remplace par deux choses qui se
vérifient — une **fiche** par capacité, composée du réel, et un **manque nommé** à chaque échec,
qui alimente tout seul la feuille de route technique.

- **La règle qui tient tout le lot : MESURÉ, ou rien.** Une capacité jamais exécutée n'a pas une
  fiabilité de 100 % — elle a une fiabilité INCONNUE. `fiabilite.taux` vaut `null` tant que
  l'échantillon est vide, et le tri ne remonte pas les capacités jamais essayées au sommet. Même
  principe pour la latence (la classe annoncée est une intention, le p50 une observation) et pour
  la DÉPENSE : le code classe la nature du coût — rien, un quota, une facture — et ne remplit un
  montant que lorsqu'il a été mesuré. Inventer « 0,003 $ » ferait un tableau de bord crédible et
  faux.
- **Douze rubriques par capacité** (`lib/registre/fiche.ts`, PUR) : nom, résumé, domaine,
  primitive, effet, entrées EXACTES (tirées du schéma de l'outil, pas recopiées), contrat de
  sortie, rejouabilité, groupabilité, politique de confirmation, latence annoncée ET mesurée,
  dépense, fiabilité mesurée avec son échantillon, risque avec ses raisons, LIMITES, événements
  laissés, dépendances, et `autorisee` pour CETTE personne.
- **La rubrique qui compte est « limites ».** Elle dit ce qu'on ne garantit pas : « aucun contrat
  de sortie : *elle a répondu* ne se distingue pas de *elle a réussi* », « non groupable : une
  collection de trois cents exige trois cents étapes », « jamais exécutée en mission : sa
  fiabilité est INCONNUE — ce n'est pas *bonne* ». Un registre qui ne dirait que ses forces
  laisserait croire que l'inconnu est petit.
- **Les mesures viennent de `MissionStep`** (`platform/in-process/registre/`), la seule table où
  une capacité laisse une trace complète — tentée, réussie, rejouée, chronométrée. Pas de compteur
  maison à côté (§17 : le jour où deux chiffres divergent, personne ne sait lequel croire). La
  limite est DITE : la conversation n'écrit pas d'étape, donc une capacité que seule la
  conversation utilise reste « jamais mesurée ».
- **Onze natures de manque** (`lib/registre/manques.ts`, PUR), et elles ne se confondent pas :
  source inaccessible, permission, capacité absente, moteur de calcul, format de fichier, rendu,
  API externe, donnée manquante, entrée humaine, modèle, indéterminé. Une PERMISSION refusée est
  une décision de sécurité qui a fonctionné, pas une dette ; une CAPACITÉ ABSENTE est du code à
  écrire. Les ranger ensemble sous « erreur » est exactement ce qui fait qu'une feuille de route
  ne sort jamais des incidents. Un échec non reconnu rend INDETERMINE et se compte à part : un
  manque mal rangé pollue la feuille de route plus sûrement qu'un manque non rangé, qui se voit.
- **Le manque est nommé AU MOMENT de l'échec**, dans le détail de l'événement `STEP_FAILED` que le
  moteur écrit déjà (`missions/runtime/engine.ts`). Pas de table « CapabilityGap » : la feuille de
  route est une LECTURE de ces événements, groupée par `nature × capacité` et classée par
  fréquence pondérée (une capacité absente pèse trois fois une panne de service, parce qu'elle ne
  se répare que par du code).
- **Détecter le manque AVANT de tenter** (`detecterManque`) : trois réponses, et elles appellent
  trois suites opposées — une capacité répond ; une capacité existe mais le droit ou le plafond de
  la mission l'écarte (PERMISSION, pas une dette) ; rien ne correspond (CAPACITE_ABSENTE, du code
  à écrire). Le seuil de pertinence est à 3, c'est-à-dire un marquage sur le NOM ou plusieurs mots
  croisés : mesuré sur le catalogue réel, « faire signer électroniquement ce contrat » trouvait
  une capacité parce qu'elle contient le mot « contrat » dans son résumé — un faux positif ici est
  le pire des résultats, puisqu'il empêche de nommer le manque.
- **Et le seuil de 3 avait un angle mort, mesuré sur un défi réel.** Deux mots sur deux dans un
  résumé font 2 points — donc « chemin critique », la demande ENTIÈRE, était sous le seuil, tandis
  que `chercher` classait `calcul_ordonnancement` PREMIÈRE. Deux réponses du même outil à la même
  phrase, opposées ; Adam a dit à la personne que le moteur n'existait pas. La règle ajoutée
  n'abaisse aucun seuil : elle admet aussi une capacité qui COUVRE au moins 75 % de la demande sur
  au moins deux mots. Les points mesurent la FORCE d'un rapprochement (nom 3, domaine 2, résumé 1) ;
  la couverture mesure la PART de la demande traitée, et les deux ne se remplacent pas. Mesuré sur
  quatorze besoins de vérité connue : 1 faux absent et 3 faux présents avant, **0 et 3** après —
  un seuil simplement abaissé à 2 aurait fait 0 et 5.
- **Les écartées sont TRIÉES, et ce n'est pas cosmétique.** Elles sortaient dans l'ordre du
  catalogue : à « exécute une requête SQL » demandé par une déléguée, `sql_query` — la seule
  exclusion qui répondait — arrivait en position 20 sur 38, et l'outil n'en affiche que dix. Toute
  la distinction droit/absence était calculée juste et jetée avant d'atteindre le modèle. Le tri
  corrige aussi le manque lui-même : `detecterManque` le construit à partir de la PREMIÈRE
  bloquante, donc il nomme désormais `sql_query` au lieu d'une capacité de paie tirée au hasard.
- **`registre_capacites`** : cinq questions — `chercher` (avec les ÉCARTÉES et leur raison),
  `fiche`, `manque`, `feuille_de_route`, `sommaire`. Interrogeable pendant une mission, jamais figé
  dans le prompt : un registre récité coûte des jetons à chaque tour, vieillit en silence, et ne
  peut pas porter ce qui change — la fiabilité mesurée, le dernier échec.
- **Ce que le recensement a trouvé du premier coup** : `mission_status` était déclaré DEUX fois —
  la mission de sollicitation (`adam-tools.ts`, clé `missionId`) et le Mission Runtime
  (`business-capabilities.ts`, clé `mission`). Le modèle recevait deux outils de même nom avec des
  schémas incompatibles, l'aiguillage n'en atteignait qu'un, et une réponse pouvait revenir sur
  TOUTES les missions au lieu de celle demandée. Le premier a été renommé `mission_participants`,
  et `capability-surface.test.ts` interdit désormais le doublon. C'est exactement ce qu'un registre
  interrogeable doit faire remonter : le défaut a été trouvé par un test, pas par un incident.
- **Banc** : 20 tests purs (les onze natures, la feuille de route, les fiches, l'interrogation, le
  tri honnête de l'inconnu), 8 tests d'intégration depuis le VRAI point d'entrée — une mission
  lancée par `lancerMission`, une étape qui échoue vraiment, le manque relu dans le journal, la
  fiabilité mesurée sur l'étape réelle, un VIEWER qui voit ce qu'il n'a pas le droit d'appeler.
  Quatre cibles (`manque_nomme`, `fiabilite_mesuree`, `droit_vs_absence`, `registre_sans_doublon`)
  et deux défis live (`defi-manque-nomme`, `defi-registre-honnete`).

### Information Fabric (`src/lib/fabric/`) — façade L2

L'information vient à Adam ; Adam ne court plus après. Six briques DÉTERMINISTES (zéro appel
de modèle), consommées par les mêmes points d'entrée qu'avant — audit, décisions et mesures
complètes : `docs/INFORMATION_FABRIC.md`.

| Fichier | Rôle |
|---|---|
| `index.ts` | Le baril — un franchissement de frontière par fichier consommateur, pas un par brique |
| `registry.ts` | Le registre des SOURCES : 11 familles typées (contenu, entités, modes, autorité, **preuve négative possible ou non**) + sondes de fraîcheur mesurées (« synchronisé jusqu'à HH:MM »). Appelant réel : l'outil `source_map` |
| `text-search.ts` | La recherche de CONTENU indexée : FTS `'simple'` sur expression (index GIN de `20260828300000`), classement `ts_rank` à VIVIER BORNÉ (300), préfixes, conjonction puis disjonction, repli LIKE (servi par trigramme) DIT dans le résultat |
| `mentions.ts` | Les liens document ↔ entité CANONIQUE, extraits à l'INGESTION (dictionnaire déterministe : produits DCI+marque, personnes nom complet, laboratoires) → table `EntityMention`. « Tout ce qui est relié à X » = une lecture d'index, et les ALIAS se franchissent (Keytruda ↔ pembrolizumab) |
| `hot-state.ts` | Les états chauds PRÉCALCULÉS (`AssistantHotState`) : écriture au travers + TTL + invalidation par fait métier (4ᵉ conséquence de `recordEvent`) + coût MESURÉ persisté. `subjectId` est une clé de DROITS — jamais servi à un autre |
| `bulk.ts` | Le loteur de lectures : N demandes logiques d'un même tour → K requêtes physiques (`findMany` découpé), mesure {logiques, physiques} par opération — affichée dans la couverture de `find_documents` |
| `provenance.ts` | **La provenance au niveau du fait (F8)** : chaque fait servi dans un tour porte sa SOURCE (ERP, document, e-mail, fil, page PDF, cellule, pièce, réunion, personne, externe, calcul), sa **date propre**, l'instant de lecture, la confiance et son fondement (structuré / texte extrait / OCR / modèle), la fraîcheur (table vivante ou copie indexée), l'autorité et la preuve négative **du registre**, et l'outil — donc les droits — qui l'a lu. Extraction déterministe des sorties d'outils (liens internes seulement ; une adresse externe est citée, jamais suivie) + faits **déclarés** par les outils (`_provenance`, revalidés champ par champ). Un fait CALCULÉ (`faitCalcule`) porte ses entrées, la transformation, la formule, la date, et hérite de la **pire** confiance de ses entrées. `repondreProvenance` compose « D'où tu tiens ça ? » — par le code, jamais par un modèle |
| `provenance-store.ts` | Table `AssistantProvenance` (migration `20261022090000`) : une ligne par tour (même vide : « je n'ai rien lu » est une réponse), cloisonnée par personne, relue en une requête indexée (six tours au plus) — **P95 mesuré 5 ms** en local ; rétention 30 jours |
| `entites-score.ts` | **La résolution d'entités — le scoreur pur (F9)** : une mention → des candidats notés par épreuve décroissante (identique, sans générique ni forme juridique, ordre des mots, acronyme, sous-ensemble de jetons, faute de frappe bornée), puis TRANCHÉS : CERTAIN (haut et nettement devant, ou seul candidat qui DÉSIGNE), PROBABLE (dit comme tel), AMBIGU (la **question** qui distingue les candidats — jamais un choix à la place de la personne), INCONNU. Une ressemblance de frappe ne concurrence pas une désignation ; un identifiant n'a pas de concurrent |
| `entites.ts` | **La brique qui LIT** : dix natures (personnes, sociétés, fournisseurs, produits, molécules, marques, hôpitaux, institutions, partenaires, médecins), trois passes bornées par nature — identifiant exact (e-mail, domaine, référence), nom (contenu), **trigramme** `pg_trgm` + `unaccent` pour les fautes —, alias marque ↔ DCI par la brique produits, molécules triées (« A + B » = « B + A »). **Aucune écriture** (test statique) : deux lignes qui se ressemblent sont une question ou un constat du moteur de qualité, jamais une fusion silencieuse. Banc réaliste : **60/60 mentions résolues, P95 12 ms** |
| `scripts/fabric-bench.ts` | `npm run fabric:bench` — six voies dans le même run, sélectivité contrôlée, corpus étiqueté et nettoyé, ce qui n'est pas mesuré est dit |

Consommateurs côté Adam : `assistant/hot-alerts.ts` (signaux exécutifs chauds, réchauffés au
battement pour les dirigeants actifs), `assistant/source-map.ts`, `document-discovery.ts`
(FTS + alias + hydratation en lot). Côté ERP : `events/ledger.ts` (invalidation),
`scheduled.ts` (balayage des mentions + réchauffage).

#### « De qui, de quoi parle-t-on ? » — la résolution d'entités (F9, mandat 4 §24)

- **Le code résout avant que le modèle ne devine.** Les mentions d'une question (`queryPlan.entites`)
  passent par `resoudreMentions` dans les deux boucles de conversation ; le bloc « ENTITÉS RÉSOLUES
  PAR LE CODE » arrive avec le plan : ce qui est CERTAIN (avec l'identifiant), ce qui est PROBABLE
  (à dire, à vérifier avant d'écrire), ce qui est AMBIGU (« deux Nadir : Nadir Benali — RH, Nadir
  Cherif — Ventes. Laquelle ? » — **ne pas choisir à sa place**). `resolvePerson` (l'assignation
  d'une tâche) tranche par la brique : fautes, ordre des mots, homonymes → un compte, ou la liste.
- **Jamais de fusion silencieuse.** La brique n'a aucun chemin d'écriture ; les doublons
  probables remontent au moteur de qualité (§23) et attendent une personne.
- **Mesuré.** `fabric/entites-score.test.ts` (identifiants, déshabillage, épreuves, verdicts,
  dédoublonnage) ; `fabric/entites.test.ts` plante des entités réalistes (accents, traits
  d'union, formes juridiques, acronymes, alias, homonymes, distracteurs proches) et soumet **60
  mentions** telles qu'on les tape : **60/60 résolues (100 %)**, P50 3 ms, **P95 12 ms** (objectif
  ≥ 95 % et < 300 ms) ; l'ambiguïté rend une question qui distingue.

#### « D'où tu tiens ça ? » — la provenance se lit, elle ne se raisonne pas (F8, mandat 4 §22)

- **Chaque tour consigne ses faits.** Les deux boucles de conversation gardent chaque lecture avec
  son outil (`lectures`), et le résultat du tour porte `provenance` (`faitsDuTour`, ≤ 40 faits) ;
  les trois entrées — route de flux, action serveur, outil vocal — le consignent par
  `consignerProvenance`, **quel que soit le drapeau mémoire**. Le pont est
  `platform/in-process/fabric/provenance.ts` (aucun import direct Adam → fabric : le plafond de
  frontière ne bouge pas).
- **La question est une forme déterministe.** « D'où tu tiens ça ? », « ta source ? », « comment tu
  sais ça ? », « tu es sûr de ce chiffre ? » sont reconnues par le routeur vocal (`PROVENANCE`),
  classées `FAST_DETERMINISTIC` dès la phrase brute, et les deux boucles répondent AVANT tout
  appel de modèle : `repondreDouTuTiensCa` relit le registre (fil, puis personne) et compose la
  réponse. Sans ancre, seul le **dernier** tour compte — même vide — parce que citer un tour plus
  ancien à la place du dernier serait mentir sur la source de la dernière réponse ; un nombre
  (« les 142 800 ») ou un nom cité remonte sur les six derniers tours jusqu'au fait qui le porte.
  Zéro appel de modèle, zéro consignation pour ce tour. « D'où vient ce retard ? » reste une
  question causale (modèle).
- **Le panneau « Sources consultées » dit d'où ET de quand** : l'événement `source` porte un
  `detail` (« Regulatory · donnée du 12/08/2026 · temps réel »), calculé par la même extraction.
- **Un agrégat déclare sa lignée.** `finance_totals` pose `_provenance` : total = somme côté base
  de N écritures réglées, formule, entrées (références), date — et l'écart entre deux périodes
  cite ses deux totaux. `stripDisplayPayload` retire `_provenance` de ce que le modèle lit.
- **`source_map` était mort.** Classé GENERAL (jamais servi), il rejoint le domaine `SOURCES`
  (« où pourrait vivre X ? », « tes données datent de quand ? », « c'est fiable ? »).
- **Mesuré.** `fabric/provenance.test.ts` (16 tests : natures, locators, externe cité non suivi,
  confiance OCR, `_provenance` revalidée, calcul et pire confiance, dates sans année devinée,
  ancres, réponses), `provenance-store.test.ts` (consignation, dernier tour vide, ancres,
  cloisonnement, **P95 5 ms sur 40 lectures**), routeur vocal + routeur (formes positives et
  négatives), `e2e/provenance.spec.ts` (la question dans le bureau d'Adam : deux faits cités,
  source, date, lignée, `ModelCallLog` inchangé, une seule ligne consignée), suite live
  (« d'où tu tiens ça ? » après une vraie question : zéro appel, < 4 s), défi `defi-provenance`.


### L'Assistant IA (`/assistant`) — `src/lib/agent/` (moteur Mastra sur MiMo, distinct d'Adam)

| Fichier | Rôle |
|---|---|
| `contexte.ts` | Le contexte compilé (qui parle, ses droits, sa mémoire, ses consignes de rôle) et les RÈGLES du prompt (agir, documents, routines, web, mémoire). |
| `outils-v1.ts` · `lectures.ts` | Les outils offerts à la personne : lectures V1, `mes_*`, documents, `mes_routines`, `web_research`, écritures V1, opérations ; chaque sortie passe `censurerSortie`. |
| `operations/index.ts` · `types.ts` | Le registre `OPERATIONS_IA` : `proposer` (carte ou `manque`) / `executer` (action de l'écran) ; `executerOperationIA` revérifie le droit. |
| `operations/adpro-*.ts` · `bon-de-commande.ts` · `quotidien.ts` · `budget.ts` | Ad & Pro de bout en bout, BC + « Créer la demande de validation », relance / dépôt / rendez-vous / réponse, contrôle de budget sans chiffre pour qui n'a pas « Budgets ». |
| `operations/demandes-visibles.ts` · `pieces.ts` · `annuaire-medical.ts` | Ce que la personne voit : demandes (portées), pièces (Drive, droits revérifiés), médecins. |
| `operations/documents-lus.ts` · `devis-lu.ts` · `bc-depuis-devis.ts` · `mrz.ts` · `voyageur-passeport.ts` · `traduction.ts` · `formulaire-pdf.ts` · `document-modele.ts` | Les documents ; portes avant le modèle (identité et paie refusées, RIB/IBAN/NIN masqués). |
| `routines/calendrier.ts` · `passage.ts` · `service.ts` · `operations/routines.ts` | Les routines : calendrier en heure d'Alger, passage en lecture seule (vérifier puis comparer), prise atomique, traces et notifications. |
| `memoire.ts` · `memoire-ui.ts` · `filtre-confidentialite.ts` · `generer.ts` · `recherche-web.ts` | Mémoire personnelle, filtre (et masque réversible), appel de rédaction sans outil, recherche web à question censurée. |
| `src/lib/actions/assistant-ia-actions.ts` | Les gestes de la personne sur SA mémoire et SES routines (identité de la session, jamais d'un paramètre). |
| `repondre.ts` · `generer.ts` | Les DEUX SEULES portes vers le modèle (cliquets `interrupteur.test.ts`, `consommation.test.ts`) : interrupteur général, puis budget ouvert / compté par étape / fermé. |
| `consommation.ts` · `consommation-regles.ts` · `consommation-stats.ts` | Lot V3-D : journal de chaque appel (`ModelCallLog`, feature `assistant_ia`) et de chaque tour (`AiUsageLog`), plafonds (par tour, par personne et par jour, heure d'Alger), avis au Super Admin ; règles PURES partagées avec l'écran ; agrégats de l'écran. |
| `contenu-non-fiable.ts` | Les sorties d'outils qui ramènent un contenu TIERS (document, message reçu, page web) sont encadrées et désamorcées avant le modèle ; la règle est dans `REGLES`. |
| `src/app/(app)/admin/ai/consommation/` · `src/lib/actions/assistant-ia-consommation-actions.ts` | Écran Super Admin « Consommation IA » (par personne, par jour, par modèle) et réglage des plafonds / décisions (`AssistantIaReglage`). |

### Refonte des données — enrichissement des fiches (lot V2-A)

| Fichier | Rôle |
|---|---|
| `src/lib/enrichissement/signalement.ts` | Interrupteur, `PIECE_DEPOSEE` + mise en file, appelés par les goulots |
| `src/lib/enrichissement/file.ts` | Pur : clés, identifiants dérivés, reprise après échec, source / confidentialité d'un dépôt |
| `src/lib/enrichissement/traitement.ts` | `traiterLaFile` / `traiterTache` : pièce, lecture locale, classement, extraction, sujets, décisions |
| `src/lib/enrichissement/extraction.ts` | Pur : l'extracteur de chaque nature |
| `src/lib/enrichissement/sujets.ts` · `fiches.ts` | À qui se rapportent les faits (pur) · lectures des fiches, Personne d'un porteur |
| `src/lib/enrichissement/confirmation.ts` · `a-confirmer.ts` | Confirmer / rejeter / trancher (transaction) · qui tranche, colonnes de fiche (pur) |
| `src/lib/enrichissement/porte-coffre.ts` · `src/modules/coffre/infra/depot-referentiel.ts` | Écriture seule au coffre · dépôt du coffre sur les tables R6 réelles |
| `src/lib/enrichissement/lectures.ts` | État de la file, file « À confirmer » |
| `src/modules/referentiels/infra/reprises/` | Contrat commun des reprises + `rattrapage-pieces.ts` |
| `src/lib/actions/enrichissement-actions.ts` · `src/modules/referentiels/actions-reprises.ts` | Gestes (Super Admin, responsable du fait) |
| `src/app/(app)/admin/refonte-donnees/` · `src/app/(app)/a-confirmer/` | Écrans |
### Référentiel des Personnes (R1) — `src/modules/referentiels/infra/personnes/` (refonte, lot V2-B)

Module `referentiels` (`src/modules/referentiels/`, lot V3-G) : on l'importe par `@/modules/referentiels/api` (serveur) ou `/partage` (pur) — voir `docs/architecture/MODULES.md`.

| Fichier | Rôle |
|---|---|
| `sources.ts` | Les neuf tables où vit une personne : rôle, identité lue (aucune colonne sensible), racine (lien ERP sûr), identifiant déterministe. Pur. |
| `rattachement.ts` | LE geste « relier une ligne à sa Personne », partagé par la reprise et la double écriture ; à blanc pour l'aperçu. |
| `reprise.ts`, `reprise-doublons.ts`, `../reprises/` | Les reprises (contrat commun `Reprise`, registre `reprises/index.ts`, journal = audit « Refonte des données »). |
| `fiches-doublons.ts`, `../../domaine/personnes/paires.ts` | Les fiches comparées par le moteur `domaine/doublons.ts` (aussi pour `scripts/refonte/inventaire-doublons.ts`) et leur réduction en paires de Personnes. |
| `fusion.ts` | Fusionner / écarter / défaire — gestes du Super Admin (`../../actions-personnes.ts`, clé `personnes-actions`). |
| `double-ecriture.ts` | `relierALaPersonne` dans la transaction des écrivains, derrière `AppSetting.refontePersonnesDoubleEcriture`. |
| `fiche.ts`, `visibilite.ts` | La fiche 360° `/personnes/[id]` : chaque ligne derrière la porte de son écran d'origine. |
| `app/(app)/admin/refonte-donnees/` | L'écran unique des reprises (Super Admin). |
| `app/(app)/personnes/` | La fiche 360° et `doublons/` (trancher). |
#### Refonte des données — coffre (V2-E)

| Fichier | Rôle |
|---|---|
| `src/modules/coffre/{partage,api,api-lecture}.ts` | Les trois portes : pure (navigateur), écriture (ne déchiffre jamais — celle des actions), lecture (déchiffre — écrans RH/Legal/admin). Guide : `docs/architecture/MODULES.md`. |
| `src/modules/coffre/domaine/champs.ts` | Catalogue PUR des colonnes sensibles copiées, classement, masque, « écrire sans lire ». |
| `src/modules/coffre/infra/copies.ts` · `ecriture.ts` | Chemin d'écriture (copie chiffrée, remplacement daté) et double écriture derrière l'interrupteur. |
| `src/modules/coffre/infra/acces.ts` · `lecture.ts` · `dechiffrement.ts` | Contrôle d'accès + journal (sans déchiffrer), lecture des écrans (déchiffre), le seul module qui déchiffre. |
| `src/modules/coffre/infra/couverture.ts` · `journal.ts` | Couverture colonne par colonne ; journal des accès filtrable. |
| `src/modules/referentiels/domaine/reprises/types.ts` · `infra/reprises/{index,coffre}.ts` | Contrat commun des reprises ; reprise « coffre ». |
| `src/modules/referentiels/actions-reprises.ts` · `src/modules/coffre/actions.ts` (clés `refonte-reprise-actions`, `coffre-actions`) | Aperçu / lot (Super Admin, audités) ; interrupteurs. |
| `src/app/(app)/admin/refonte-donnees/` · `admin/acces-donnees-sensibles/` | Écrans Super Admin. |

