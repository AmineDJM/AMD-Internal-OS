### Versions TEST → PRODUCTION (drapeaux de nouveautés)

Toute nouveauté arrive **au stade TEST** : invisible de l'entreprise, visible du seul compte en
**mode test**. Le Super Admin la parcourt, puis la **valide en production** d'un clic — ou la
retire. Le retour arrière est immédiat.

- Catalogue : `src/lib/features.ts` — `FEATURES` déclare chaque nouveauté (`key`, `label`,
  `description`). Une clé inconnue de la base est **auto-créée au stade TEST** : rien ne peut
  être livré par accident. En cas d'indisponibilité de la base, le repli est TEST (prudent).
- Modèle : `FeatureFlag { key, stage: TEST | PROD | OFF }` + `User.testMode`.
- Portes : `featureEnabled(key, userId)` (côté serveur, mémoïsé par requête), `isTestUser(userId)`.
- Écran : `/admin/versions` (Super Admin) — trois groupes (**En test** / **En production** /
  **Désactivées**), interrupteur de mode test, bandeau permanent
  (`components/layout/test-mode-banner.tsx`) tant que le mode test est actif.
- **Navigation** : un onglet peut porter `feature` (`NavTab.feature`, `src/lib/labels.ts`) — il
  n'apparaît qu'aux comptes qui voient la nouveauté. Résolu dans `app/(app)/layout.tsx` (menu,
  palette, barre mobile) et par `visibleTabs(user, TABS)` (`src/lib/nav-tabs.ts`) dans les pages.
- Tests : `src/lib/features.test.ts` — TEST invisible du grand public, PROD visible de tous, OFF
  invisible même en mode test, retour arrière.

Nouveautés actuellement au catalogue : `assistant_memory`, `home_today`, `assistant_proactive`,
`mail_smart`.

### Assistant — mémoire personnelle, cloisonnée par construction

L'assistant se souvient de **sa** personne, et d'elle seule. Il connaît son identité, son entité,
son département (fil d'Ariane complet), son **N+1 réel** et une note de mémoire distillée de ses
échanges précédents.

**Le cloisonnement n'est pas une convention, c'est une structure** — `src/lib/assistant-memory.ts`
est la **seule porte d'entrée** vers `AssistantThread`, `AssistantMessage` et `AssistantMemory` ;
aucun autre module n'interroge ces tables :

1. toute fonction exige le `userId` du **demandeur** en premier paramètre ;
2. tout `where` porte ce `userId` — un identifiant de fil deviné ou volé ne donne rien ;
3. `AssistantMessage` porte **lui aussi** le `userId` (redondant avec son fil) : même une erreur
   de jointure ne peut pas exposer le message d'autrui ;
4. le `userId` vient **toujours** de la session serveur, jamais du client ;
5. en **« Vue exacte »** (impersonation), l'assistant est **désactivé** : la mémoire d'une personne
   ne s'ouvre à personne, pas même à un administrateur.

- Distillation : tous les ~12 messages, `maybeDistillMemory` (`lib/actions/assistant-actions.ts`)
  relit les échanges récents de la personne et réécrit sa note durable (appel économique,
  épisodique, silencieux en cas d'échec — la mémoire est un confort, jamais un point de rupture).
- Injection : `personalContext(userId)` est ajouté au prompt système par `runAssistant`
  (`opts.personalContext`), avec un rappel explicite de confidentialité.
- UI : `components/chief/assistant-chat.tsx` — rail « Mes conversations » (ouvrir, supprimer,
  **tout effacer** = droit à l'oubli), tiroir sur mobile.
- Actions scopées : `myAssistantThreads`, `myAssistantThread`, `deleteMyAssistantThread`,
  `forgetMyAssistantMemory`, `refreshMyBrief`.
- Tests : `src/lib/assistant-memory.test.ts` — 8 tests qui **tentent explicitement la fuite**
  (lire / écrire / supprimer le fil d'un autre en connaissant son identifiant exact) et vérifient
  qu'elle échoue. Drapeau : `assistant_memory`.

### Écran « Aujourd'hui » & point du matin

**Aujourd'hui** (`/aujourdhui`, drapeau `home_today`) répond à une seule question : *que dois-je
faire maintenant ?* Aucune nouvelle source de données — on relit `getActionCenter` (déjà filtré par
les droits) et l'agenda du jour, puis on **ordonne** :

- `rankToday(items, now)` (`src/lib/queries/today.ts`, **fonction pure, testée**) — le retard passe
  devant tout et remonte avec sa durée ; à échéance égale une **validation** (qui bloque un
  collègue) passe avant une tâche personnelle ; la priorité départage le reste.
- Chaque ligne porte sa **raison** (`En retard`, `Pour aujourd'hui`, `Quelqu'un attend votre
  validation`…) : jamais un classement muet.
- L'écran montre **une** action en tête, quatre suivantes, le reste replié derrière « Tout voir ».
- La racine `/` mène à `/aujourdhui` quand la nouveauté est active, sinon `/mon-espace`.
- Tests : `src/lib/queries/today.test.ts` (7 tests sur le classement).

**Point du matin** (drapeau `assistant_proactive`) — l'assistant parle en premier : 3 à 5 phrases
sur ce qui presse et par quoi commencer, affichées en tête de `/aujourdhui` et du module Assistant.
`src/lib/daily-brief.ts` ; **un seul appel IA par personne et par jour** (cache `DailyBrief`, clé
`userId + jour d'Alger`), bouton « Actualiser » pour forcer. Journée vide → aucun appel IA (on ne
fabrique pas du bruit pour meubler).

### Courrier « smart » — envoi par API HTTPS, sans SMTP

Les ports SMTP (25/465/587) sont filtrés par la plupart des hébergeurs et des réseaux d'entreprise :
c'est la cause des blocages à répétition. L'envoi passe désormais par une **API HTTPS sur le port
443**, celui du web — s'il passe, le courrier passe.

- `src/lib/mail-smart.ts` — **agnostique du fournisseur** : Resend, Postmark et Brevo parlent tous
  HTTPS + JSON. `buildProviderCall()` (pure, testée) traduit un envoi dans le dialecte de chacun ;
  changer de fournisseur = changer deux variables, jamais une ligne de code métier.
- Journal : `OutboundEmail` — chaque tentative laisse une trace avec le **motif exact** du refus
  (c'est précisément ce qui manquait avec SMTP). `InboundEmail` pour la réception.
- Réception : `POST /api/mail/inbound` — route **publique** (le fournisseur n'a pas de session) mais
  jamais ouverte : signature **HMAC-SHA256 du corps brut** vérifiée avant toute lecture, comparaison
  en temps constant, refus total sans `MAIL_WEBHOOK_SECRET`, idempotence sur `messageId`.
- Écran : `/admin/courrier` (Super Admin) — état de la configuration, **ce qui reste à faire hors
  application**, envoi de test, journal des envois.
- Variables : `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM`, `MAIL_WEBHOOK_SECRET`.
- ⚠️ **Dépendance externe** : il faut un **compte fournisseur** et le **domaine vérifié** chez lui
  (SPF + DKIM + DMARC en DNS). Sans ces enregistrements, les messages partent mais arrivent en
  indésirables. Tant que ce n'est pas fait, `smartMailConfigured()` est faux et l'app **le dit**
  plutôt que d'échouer silencieusement.
- Tests : `src/lib/mail-smart.test.ts` (11 tests) — jamais de port SMTP, en-têtes et corps corrects
  pour les trois fournisseurs, signature juste acceptée / fausse / absente / **corps falsifié après
  signature** refusés, normalisation des trois dialectes entrants.

### Assistant — plein écran, conversations, réponse en flux

L'assistant ne renvoie plus son texte d'un bloc après un long silence : il **s'écrit**.

- **Vrai streaming** (pas un effet de machine à écrire) : `callClaudeStream` (`lib/ai.ts`)
  remonte le texte au fil de sa génération et réassemble les `tool_use` à partir des fragments
  JSON, si bien que la boucle agent n'a rien à changer. `runAssistantStream` (`lib/assistant.ts`)
  émet des événements : `trace` (« je consulte vos validations… ») dès qu'un outil s'exécute,
  puis `delta` mot à mot, puis `done` avec le résultat complet.
- **Route** : `POST /api/assistant/stream` (SSE, runtime Node). Identité issue de la **session**,
  jamais du client ; assistant **désactivé en « Vue exacte »** ; toute action d'écriture reste
  interceptée et soumise à confirmation. En-tête `X-Accel-Buffering: no` — sans elle, un proxy
  remettrait le flux en tampon et le livrerait… d'un bloc.
- **`reset`** : si un tour se révèle être un appel d'outil, le texte déjà affiché n'était qu'un
  préambule → le client l'efface avant la vraie réponse. Rare en pratique, mais l'affichage
  reste juste dans tous les cas.
- **Écran** : plein écran (pas d'en-tête de page), colonne de lecture centrée, rail des
  conversations **regroupées par ancienneté** (aujourd'hui / 7 j / 30 j / plus ancien), curseur
  d'écriture, bouton **arrêter** qui conserve le texte déjà produit.
- Les **pièces jointes** passent par l'action serveur (il faut les résoudre et les extraire
  avant l'appel au modèle) ; tout le reste passe par le flux. La persistance du fil est
  mutualisée entre les deux chemins (`rememberExchange`), pour que la règle de cloisonnement
  n'existe qu'à un seul endroit.

### Moyens généraux — corriger, supprimer, et des totaux qui disent la vérité

Une erreur de saisie se répare **là où on la voit** : chaque dépense porte un crayon et une
corbeille dans la liste. La laisser « pour la trace » ne préserve rien — elle fausse à la fois
le budget et le solde de caisse, qui se lisent tous deux sur ces mêmes lignes. C'est le
**journal d'audit** qui garde la trace, avec le montant d'avant et l'auteur de la correction.

**Écran allégé (09/10)** : en tête **3 chiffres** du mois, une répartition par nature (graphique), puis les dépenses
**rangées par mois** (titres « Octobre 2026 », mois lus en UTC comme les séries des budgets ; une dépense sans
catégorie = « Non classé ») ; un clic ouvre la dépense dans un **panneau** latéral (`expense-panel.tsx`), les filtres
et le menu d'en-tête sont regroupés (`entete-menu.tsx`). Règles pures `lib/general-means/ecran.ts` (+ tests).

**Nature des dépenses rangée par l'IA (10/2026)** : les natures sont des **catégories budgétaires** de l'enveloppe active
qui couvre `GENERAL_MEANS` — créée au besoin (« Moyens généraux », exercice en cours, montant 0) avec **14 catégories par
défaut** reconnues par leur `cle` `MG_…` (`lib/general-means/natures.ts`, `natures-store.ts` → `assurerNaturesMoyensGeneraux`,
appelée à l'affichage). **Saisie** : après une pause de frappe, chaque article non classé à la main part à l'IA
(`proposerNaturesLignes`, n'écrit rien) ; la catégorie proposée remplit la liste, modifiable ; une **nouvelle** catégorie
voyage en `nouvelle:Nom` et n'est créée qu'à l'enregistrement (`finaliserNatures`, `expense-lines.ts`, appelée par
`addDepartmentExpense`, `updateDepartmentExpense`, `spendFromPettyCash` après les contrôles) — un nom proche d'une
catégorie existante (accents, casse, pluriel) y est ramené. Un article encore sans catégorie à l'enregistrement est rangé
côté serveur, sauf si le ticket a la sienne. IA coupée / en panne / > 12 s → **mots-clés** (`devinerParMotsCles`) ; jamais
de blocage. Fonction IA `nature_depense` (bascule de l'assistant, `lib/natures-depenses-ia.ts`). **« Par nature »** montre
un **mois** (◀ ▶ dans l'année), découpé **article par article** (`partsParNature`, `repartitionDuMois`) ; un clic filtre la
liste sur la catégorie et le mois. **Super Admin** : « Ranger avec l'IA » range l'existant « Non classé » par lots
(`classerDepensesNonClassees`, audité).

- **Droit** (`canAmendExpense`) : les mêmes que pour créer — celui qui **tient** le budget, ou
  celui qui **achète** sur son propre département. Obliger à remonter à l'administration pour
  corriger un montant garantit surtout que personne ne corrige, et qu'on vit avec un budget faux.
  Une dépense payée sur la **caisse** ajoute une condition : c'est de l'argent physique, seule la
  personne qui le détient (ou la direction) y touche. Le bouton n'apparaît que dans ce cas
  (`canAmendCash`, calculé avec la **même** règle que le serveur).
- **Modifier rouvre le TICKET**, pas seulement le montant : une dépense sans détail est réouverte
  comme un article unique portant son libellé et sa somme — ce qu'elle est réellement.
- Sur une caisse, le nouveau montant est reconfronté au fond **en mettant de côté la dépense
  corrigée** (`pettyCashBalanceExcluding`) : sans cela, son propre montant compterait deux fois et
  une simple correction de libellé serait refusée « faute d'argent ». Testé.
- **Supprimer** emporte les lignes (cascade) **et les justificatifs** : un scan rattaché à une
  dépense qui n'existe plus n'est consultable nulle part et occupe le stockage indéfiniment. La
  confirmation dit ce qui part et l'effet sur les chiffres — « êtes-vous sûr ? » ne renseigne
  personne.

**Deux totaux étaient faux, et le sont corrigés :**

1. **Le consommé se calculait sur la LISTE AFFICHÉE**, plafonnée à 200 lignes : au 201ᵉ achat de
   l'année, le budget s'allégeait tout seul. Vérifié sur 250 dépenses — la liste tronquée
   totalisait 20 000 DZD là où la base en comptait 63 000. Les totaux viennent désormais d'un
   `groupBy` sur l'année entière ; la liste reste plafonnée (et le dit), le compte affiché est le
   compte **réel**.
2. **L'enveloppe des moyens généraux se voyait soustraire des dépenses d'une AUTRE nature**
   (budget métier, formation), alors qu'elle ne porte que `OPERATING` — ce que la page Budgets,
   elle, comptait déjà nature par nature. Les deux écrans donnaient donc des chiffres différents
   pour le même département. Le consommé est maintenant `OPERATING` seul, et ce qui relève d'une
   autre enveloppe est affiché **à part**, pour que la somme des lignes se réconcilie sans qu'on
   croie à une erreur de calcul.

**Ce qui était déjà juste** (vérifié sur données réelles) : une dépense payée sur la caisse est
bien déduite **du fond ET imputée au budget** — c'est le même enregistrement lu de deux endroits,
donc les deux ne peuvent pas diverger, et une correction comme une suppression se répercutent
d'elles-mêmes sur les deux.

### Moyens généraux — le catalogue d'articles et le ticket à plusieurs articles

On n'achète presque jamais une seule chose. Une dépense réduite à « courses — 12 400 DZD » dit ce
qui est **sorti de la caisse** et rien de ce qui a été **acheté** : ni ce qu'on consomme le plus,
ni à quel prix, ni si le total correspond au ticket qu'on vient de scanner.

- **Un seul catalogue** (`OfficeSupplyArticle`), tenu depuis les **moyens généraux** comme depuis
  le **Bureau du secrétariat** — `canManageCatalog` accepte désormais `GENERAL_MEANS.UPDATE`. En
  tenir deux aurait produit deux vocabulaires, donc des consommations incomparables.
- **Un justificatif, N articles** (`DepartmentExpenseLine`) : article du catalogue *ou* saisie
  libre pour un achat unique, quantité, montant. Le modèle porte les deux — un achat hors
  catalogue reste un achat.
- Le `label` de la ligne est **figé à l'achat** en plus du lien vers le catalogue : un article
  renommé ou désactivé plus tard ne doit pas réécrire un ticket déjà classé.
- **Le total découle des lignes** (`receiptTotal`), il ne se saisit plus à côté : deux nombres
  censés dire la même chose finissent toujours par diverger, et c'est alors le budget qui devient
  faux. Le formulaire affiche le même total que celui que le serveur recalcule — **même module**
  (`lib/general-means/receipt.ts`, pur, 20 tests).
- Choisir un article **pré-remplit** le montant au prix indicatif du catalogue, sans jamais écraser
  une saisie : c'est une aide, le ticket fait foi (l'écart est signalé sous la ligne).
- Vaut pour les **deux portes** — dépense payée sur la **caisse d'avance** et achat imputé
  **directement au budget** : c'est le même enregistrement, la règle est donc écrite une fois
  (`lib/general-means/expense-lines.ts`) et appelée des deux côtés.
- **Compatibilité** : sans lignes envoyées (ancien formulaire, appel programmatique), on retombe
  sur le couple libellé + montant — aucun circuit existant ne casse.
- La liste des dépenses affiche le **détail** sous chaque ligne : « 5× Ramette A4 (3 500 DZD) ·
  Toner (8 900 DZD) ». C'est ce qui manquait pour relire un budget six mois plus tard.

### Regulatory — le cadenas : un dossier invisible pour toute l'équipe

Charger un portefeuille dans l'outil et le publier à l'entreprise sont deux gestes différents.
Un dossier **verrouillé** (`RegulatoryProduct.isLocked`) n'existe que pour le **Super Admin** et
pour **ceux à qui il a ouvert le pipeline** : ni la Direction, ni son responsable, ni une
autorisation nominative ne l'ouvrent d'eux-mêmes.

- **Deux droits, jamais confondus** (`src/lib/regulatory/pipeline-access.ts`, module pur testé) :
  **CONSULTER** les dossiers verrouillés — une confidence, pour ceux qui *montent* le dossier
  avant l'ouverture ; et **TENIR LE CADENAS** — ouvrir un dossier, donc le publier à toute
  l'entreprise, ce qui ne se reprend pas (ce qui a été lu a été lu). Tenir le cadenas implique de
  voir ; l'inverse est faux. Le Super Admin détient toujours les deux : c'est lui qui distribue
  ces accès, et un réglage malheureux ne doit pas pouvoir l'enfermer dehors.
- **Réglé en Administration › Réglages** (`AppSetting.pipeline*Roles` / `pipeline*UserIds`, action
  `setPipelineAccess`) : rôles **et** personnes nommées, par niveau. Listes **vides par défaut** —
  sans réglage, le pipeline reste ce qu'il était : le Super Admin, et lui seul.
- **Résolu une fois par requête** dans `getAccess` (`access.pipelineView` / `pipelineManage`),
  parce que le verrou est consulté par des fonctions **synchrones** (`scopeRegulatory`,
  `regulatoryLockWhere`) qui servent partout et ne peuvent pas lire la base. Les helpers publics
  sont `seesLockedRegulatory(user)` et `holdsRegulatoryLock(user)`.
- L'**entrée de menu « Pipeline »** (garde `pipeline`) et la **page** elle-même se ferment à qui ne
  voit aucun dossier verrouillé : une entrée qui ouvre un écran vide se clique, ne se comprend pas,
  et finit en question à l'administrateur.
- **La règle vit dans la PORTÉE, pas dans l'écran** : `scopeRegulatory` (→ `lockGate`) l'applique
  avant tout le reste. Un dossier caché du tableau mais visible depuis la recherche globale,
  l'assistant IA, le sélecteur de produits des stocks ou les documents ne serait pas caché du tout.
- Les lectures qui **ne passent pas** par cette portée reçoivent le même filtre via
  `regulatoryLockWhere(user)` : sélecteur de produits des **stocks**, rapprochement
  « notre produit » d'un **appel d'offres PCH** (lu par toute l'équipe), liste des dossiers de la
  page d'**autorisations nominatives** en Administration. Le **portail fournisseur** l'exclut aussi,
  en défense en profondeur.
- **Par URL directe** : `canAccessEntity` compose `scopeRegulatory`, donc la fiche d'un dossier
  verrouillé rend un **404** — pas une page vide, pas un message qui confirmerait son existence.
- **Ouvrir le cadenas** : cliquer l'icône sur la ligne (`setRegulatoryLock`), ou **tout
  déverrouiller** d'un geste (`unlockAllRegulatory`) — un portefeuille se publie en une fois, pas
  ligne par ligne. Volontairement **à sens unique** : un « tout verrouiller » symétrique ferait
  disparaître le catalogue entier pour toute l'entreprise d'un clic. Chaque bascule est **auditée**.
- Un bandeau permanent rappelle **combien** de dossiers sont encore verrouillés — sans lui, un
  portefeuille reste fermé des mois par oubli.
- Tests : `rbac.test.ts` couvre les trois cas qui garantissent que la règle ne se contourne pas
  (portée ALL, responsable nommé, Super Admin) ; `pipeline-access.test.ts` (17 tests) couvre les
  deux niveaux d'accès, le rôle secondaire, et le fait que tenir le cadenas implique de voir.
- **Module à part depuis le 08/10** (« sépare Pipeline et Suivi de dossiers dans les accès ») :
  `REGULATORY_PIPELINE` (« Pipeline réglementaire ») se règle dans la console indépendamment de
  `REGULATORY` (« Suivi des dossiers »). **Deux clés** : `seesLockedRegulatory` / `holdsRegulatoryLock`
  exigent la confidence ci-dessus **ET** le module — le fermer à quelqu'un ferme le pipeline partout
  (écran, recherche, sélecteurs, assistant), pas seulement l'entrée de menu. `moduleDuDossierRegulatory`
  (pur) dit quel module gouverne un dossier (verrouillé → pipeline, ouvert → suivi) ; `scopeRegulatory`
  compose deux moitiés, chacune avec SA portée (`porteeDossiers` : tout, ou « ses lignes » — créés,
  portés, partagés, accordés). **Défaut** : chaque rôle reçoit sur le pipeline exactement ses gestes de
  Regulatory (l'assistante en portée « ses lignes », `defaultScope`) ; **porter** un dossier verrouillé
  ouvre le module à sa portée nommée (`getAccess`, `carrierAccess`) sauf blocage de la console.
  Migration `20270115203000_acces_pipeline` ; tests `regulatory/pipeline-module-flow.test.ts`.

### Regulatory — les trois champs du Super Admin

Un dossier a des dizaines de champs, et presque tous se corrigent au fil de l'eau. **Trois** font
exception, parce qu'ils ne décrivent pas le produit — ils décident de ce qu'il **engage** :

| Champ | Ce qu'il décide |
|---|---|
| **Statut de fabrication** (`manufacturingStatus`) | Importation → packaging secondaire → primaire → full process. Ce que la société s'engage à faire **industriellement** : investissements, délais, argumentaire devant l'agence. |
| **Chargé du dossier** (`responsibleId`) | Un engagement pris **au nom de quelqu'un**. |
| **Entité** (`companyId`) | **Qui a le droit de voir** le dossier. La changer, c'est le déplacer d'une société à une autre — donc le montrer à des gens et le cacher à d'autres. |

Ces trois-là appartiennent au **SUPER ADMIN**, et à personne d'autre — ni la Direction, ni le
responsable Regulatory, ni le porteur du dossier. Le reste de la fiche demeure ouvert à qui a le
droit de la modifier : on ne fige pas un dossier, on protège trois décisions. Règles :
`src/lib/regulatory/structural-fields.ts` (module pur, 17 tests).

- **Quatre portes, un seul verrou** — la fiche (`updateRegulatoryProduct`), les deux menus du
  tableau (`setRegulatoryResponsible`, `setRegulatoryClassification` pour l'entité) et la
  **promotion par variation** (`setVariationStatus` à « OBTENUE », qui fait évoluer le statut de
  fabrication). Cette dernière était la **porte dérobée** : sans garde, on changeait le statut
  réservé en déclarant une variation obtenue. Déposer une variation, la mettre en attente ou
  l'annuler restent ouverts — ce sont des faits du dossier, pas la décision industrielle.
- **Un refus n'annule pas l'enregistrement.** On compare UNIQUEMENT les champs réellement
  transmis (« non transmis » ≠ « effacé ») : quelqu'un qui corrige un dosage ne touche à rien de
  structurel et ne voit aucun refus. S'il en a tenté un, le reste de la fiche est **enregistré**
  et la réserve **nomme** les champs refusés — perdre un formulaire de trente champs parce qu'une
  liste déroulante a bougé serait une punition, pas une protection.
- **À l'écran** : les trois champs s'affichent en lecture, avec un cadenas et « Réservé au Super
  Admin ». Ils ne sont pas *cachés* (il faudrait ouvrir un autre écran pour lire la valeur) et pas
  seulement *grisés* (un champ grisé donne envie de cliquer) : on montre la valeur et on dit
  pourquoi elle ne bouge pas. Le serveur revérifie dans tous les cas.
- **LE CHARGÉ DU DOSSIER EST PRÉVENU.** C'est lui qui répondra à l'agence sur le statut de
  fabrication : l'apprendre trois semaines plus tard en rouvrant la fiche par hasard n'est pas
  acceptable. La notification dit l'**avant** et l'**après** (« Statut de fabrication :
  Importation → Full Process »), pas « mis à jour ». Elle part que le changement vienne de la
  fiche ou d'une variation obtenue — même décision, même annonce. Le journal d'audit porte le même
  détail : « modifié » ne dit pas lequel.
- **La création n'est pas visée** : choisir l'entité et le statut de départ fait partie de créer un
  dossier — l'entité est même obligatoire, sans quoi le dossier serait visible du groupe entier.
  C'est la **modification** qui est réservée.

### Regulatory — la personne chargée du dossier (menu déroulant du tableau)

Un dossier réglementaire sans porteur n'avance pas. La question « qui s'en occupe ? » se pose
**en balayant la liste**, pas une fois entré dans une fiche : la colonne **« Chargé du dossier »**
est donc un **menu déroulant modifiable sur place** (`setRegulatoryResponsible`).

- **Droit** : `canAccessEntity(user, "REGULATORY_PRODUCT", id, "UPDATE")` — confier un dossier,
  c'est le modifier. Le tableau n'affiche le menu que si `userCan(user, "REGULATORY", "UPDATE")` ;
  sinon la colonne reste un simple texte. Le serveur **revérifie** dans tous les cas.
- **Assigner donne l'accès — VRAIMENT.** Trois verrous se refermaient l'un après l'autre sur la
  personne à qui l'on confiait un dossier, et chacun suffisait à le rendre invisible :
  1. **le module.** Son rôle n'ouvrait pas Regulatory → `requireModule` la renvoyait à l'accueil et
     `scopeRegulatory` ne lui montrait aucune ligne. On lui confiait un dossier qu'elle ne pouvait
     ni voir ni ouvrir, et la notification menait à une redirection. Désormais **porter un dossier
     ouvre le module** (`getAccess` → `carrierAccess`, `lib/regulatory/assignment.ts`) : `VIEW`,
     `UPDATE`, `UPLOAD`, `EXPORT`, en portée **ASSIGNED** — c'est-à-dire SES dossiers et rien
     d'autre, puisque `scopeRegulatory` continue de décider lesquels. Ni `CREATE`, ni `DELETE`, ni
     `VALIDATE` : ce ne sont pas des gestes de porteur. Un **blocage explicite** du module par
     l'administrateur gagne toujours — un blocage qui se lèverait tout seul serait imprévisible.
  2. **la gamme.** Confier un dossier « Onco » à quelqu'un rattaché à la gamme « Cardio » le lui
     donnait sans le lui montrer. Être **nommé** sur un dossier passe désormais avant le filtre de
     gamme : la gamme dit « votre périmètre habituel », nommer quelqu'un dit « celui-ci aussi,
     délibérément ». Le cloisonnement par **entité**, lui, n'est pas touché : porter un dossier
     d'une autre société se décide en ouvrant cette société.
  3. **le cadenas.** Il ne cède pas, même devant un responsable nommé — mais on ne fait plus
     semblant : la notification dit que le dossier est **verrouillé** et n'apparaîtra qu'à
     l'ouverture du cadenas, et l'écran le dit aussi à celui qui vient de le confier
     (`assignmentNotice` / `assignmentWarning`). Une notification qui annonce un dossier
     introuvable est pire que pas de notification.
  Le nouveau responsable reste **rattaché aux participants** (`assignedUsers`). L'ancien **n'est
  pas retiré** : il a travaillé dessus, et lui couper la vue en cours de route ferait perdre
  l'historique à la seule personne qui le connaît. Le retrait se décide dans le panneau
  « Participants ».
- **Choix vide = décision** : « — Non attribué — » libère le dossier. Le filtre de la colonne
  propose la même entrée, parce que « lesquels n'ont personne ? » est la question la plus utile
  devant une liste. La cellule non attribuée est teintée en avertissement.
- La personne désignée est **notifiée** (`ASSIGNMENT`) et le changement **audité**
  (`field: responsibleId`). Un refus du serveur s'affiche : sinon le menu reviendrait
  silencieusement en arrière.

### Regulatory — import d'un portefeuille produits depuis un classeur

Le portefeuille **« Sélection PF Produits » (69 produits)** est entré dans Regulatory par une
**migration de données idempotente**, pas par une saisie manuelle ni un script à lancer à la main :
elle s'applique au déploiement comme les autres.

- **Source versionnée** : `data/selection-pf-produits.xlsx`. Le SQL est **généré** par
  `scripts/gen-selection-pf-migration.ts` à partir des règles pures de
  `lib/regulatory/sheet-import.ts` — l'import reste ainsi **vérifiable et rejouable** si la
  feuille évolue (régénérer, ne pas éditer le SQL à la main).
- **Le classeur métier n'est pas un formulaire**, et c'est tout le problème : le dosage est tantôt
  dans « Forme galénique & dosage » (« GELULE 0,5MG »), tantôt dans « Conditionnement »
  (« 5 MG/B 30 ») ; les formes sont abrégées à la main (« CPR.PELL. LP », « PDRE+SOLV ») ; une
  association s'écrit « A + B » et une **alternative** « A Ou B ». Chaque règle est explicite et
  **testée** (`sheet-import.test.ts`, 34 tests) :
  - `Spé` → classe thérapeutique · `Priorisation` 1..4 → Critique..Basse (**vide = Moyenne** : une
    case vide n'est pas une priorité basse, c'est un arbitrage qui reste à faire) ;
  - `Off`/`Hop` → canal Ville / Hôpital / les deux ; `Fabrication` → niveau **déclaré** Full
    process (le tableau affiche « déclaré » vs « variation obtenue », cf. section précédente),
    `Importation`/vide → Importation ;
  - « DCI : Marque » se sépare, « A + B » devient une **association** (`molecules`), « A Ou B »
    reste **une seule** DCI — la scinder inventerait deux dossiers là où il y en a un ;
  - les mesures du **contenant** sont écartées du dosage : « B 30 » compte des boîtes, et dans
    « 1 tube 15 G / 45 G » les grammes pèsent le tube. De même le millilitre seul : « 10MG/10ML »
    dose **10 mg**. Mieux vaut **aucun** dosage qu'un chiffre faux.
- **Rien n'est jeté** : quantités marché ville/PCH, prix FOB, taille de marché, concurrents et le
  **libellé d'origine** vont dans les commentaires du dossier — c'est l'arbitrage qui a conduit à
  retenir le produit.
- **Idempotence** : identifiants stables `regpfNNNN`, insertion `WHERE NOT EXISTS`, référence
  calculée **à la suite** de la série `REG-AAAA-NNN` existante (aucune collision). Les
  **17 étapes** de workflow sont créées comme pour tout dossier créé depuis l'application.
- **Entité** : Adventum si elle existe, sinon la première entité active. Sans aucune entité, les
  dossiers restent non rattachés et le bandeau « dossiers sans entité » du tableau le signale —
  on ne devine pas à la place d'un humain.
- Les dossiers arrivent en **Présoumission, sans responsable** : ils se confient depuis la colonne
  « Chargé du dossier » ci-dessus.

### Regulatory — niveau de process (la variation obtenue fait foi)

Colonne **Niveau de process** : Importation → Secondary Packaging → Primary Packaging →
Full Process, la trajectoire d'industrialisation locale d'un médicament importé.

**Règle** : le niveau saisi sur la fiche n'est qu'une **déclaration** ; dès qu'une variation est
**OBTENUE**, c'est SA cible qui fait foi. Le niveau est donc **calculé à la lecture**
(`lib/regulatory/manufacturing-stage.ts` → `effectiveStage`, pure et testée), et non recopié à
l'écriture : une modification ultérieure de la fiche ne peut plus le faire diverger de la
réalité réglementaire.

- La cellule affiche la **provenance** (« déclaré » / « variation obtenue ») — c'est la question
  qu'on se pose vraiment — et signale une variation **en attente** sans jamais la compter comme
  acquise. La colonne se filtre comme les autres.
- Départage : la variation la plus **récente** décide (une décision peut en corriger une autre,
  même vers un niveau moins avancé) ; à date égale, le niveau le plus avancé gagne — on ne fait
  pas reculer une industrialisation actée ; sans date de décision, on retombe sur la création.
- Tests : `manufacturing-stage.test.ts` (11 tests), dont le cas « la fiche a divergé ».

### Force de vente — pilotage, territoires, produits (refonte du 07/10)

**LA DÉCISION** (maquette validée) : l'outil du superviseur et de la Direction, **trois onglets**
(`SALES_PLANNING_TABS`, `lib/labels.ts`) et UN seul « requis ». En-tête commun (`planning/entete.tsx`) : le cycle (mois
`PromoCycle`) et son jour ouvré, les BU de la portée, Exporter. La BU et le mois choisis suivent d'un onglet à l'autre.
**Plus de « ⋯ › Réglages » depuis le 08/10** (`planning/reglages.tsx` supprimé) : le montage est le module **Business
Units** (section suivante). Le 08/10 aussi (2fd508ad), « ⋯ › Business units / Secteurs » plantait : les étapes du
montage vivaient dans un module client lu côté serveur — elles sont désormais dans `business-units/etapes.ts`, module
neutre sans `"use client"`.

| Vue | Route | Ce qu'elle montre |
|---|---|---|
| **Pilotage** | `/planning` (`?kam=` ouvre la fiche d'un délégué) | Quatre tuiles — **cibles H·A·B vues à fréquence** (vs cycle précédent), **contacts réalisés / requis** (attendu à J<n>), **plans de tournée** validés / à valider, **rapports en retard** (fenêtre de 48 h close) ; les délégués **triés par retard sur le requis** ; « À traiter » (plans à valider, cibles H/A non vues, secteurs actifs sans délégué, coachings en retard). La **fiche du délégué** ajoute Ad & Pro, messages, coaching (`chargerFicheDelegue`). Effort × ventes reste, replié. Export : `/api/planning/export` (délégué, BU, secteur, couverture, réalisé, requis, attendu, plan, rapports en retard — portée de la personne). |
| **Territoires** | `/planning/territoires` | Par BU, chaque **secteur** : délégué (ou vacant), établissements, panel **par lettre**, **charge face à la capacité** (les chiffres de la Segmentation), **cibles H ou A hors panel** (classées dans un secteur mais dans aucun panel) → **« Affecter »** au délégué du secteur (`affecterAuDelegue`, `lib/actions/force-de-vente-actions.ts` : pose `MedicalDoctor.delegateId` — la branche « rattachement » de `clausePanelDuKam` —, seulement sur un praticien **non rattaché** et non archivé, 500 au plus ; qui configure la force de vente, `hasGlobalView`, ou le **superviseur de la BU** du délégué ; audité). |
| **Produits** | `/planning/produits` | Matrice délégué × produit (**P1 / P2 / P3**), « Reprendre le mois précédent » ; **sans objectifs de ventes** pour l'instant ; les **prévisions de la Direction** (ETP, couverture, budget par produit) repliées pour qui configure. Modifier : qui configure, ou le superviseur de la BU (jamais le lecteur ni le KAM). |

**LE REQUIS** = Σ, sur le panel, des visites que la **lettre de segmentation** demande (lettre × In/Out × fréquence du
secteur, stratégie de la BU du délégué d'abord — `requisDuPraticien`, `lib/segmentation/lettre-requise.ts`) ; le palier
de potentiel seulement pour un praticien rangé dans aucune stratégie publiée, et l'écran le dit. Plus de « planifié »,
de « capacité » ni de « fréquence cible » concurrents. Calculs **purs** `lib/force-de-vente/calculs.ts` (+ tests) : jour
du cycle en **jours ouvrés** (vendredi et samedi chômés) et attendu au prorata ; **réalisé plafonné au requis de chaque
praticien** (une 5ᵉ visite au même médecin ne comble pas un autre trou ; requis 0 → rien ne compte) ; couverture à
fréquence des cibles H·A·B (une cible à fréquence 0 hors dénominateur) ; tri par retard (puis le plus gros requis,
puis l'alphabet). Lectures : `lib/queries/force-de-vente.ts` (`chargerPilotage`, `chargerTerritoires`,
`chargerFicheDelegue`, `chargerFdvDuPraticien` — le bloc Force de vente de `/praticiens/[id]`). Le même requis nourrit
`sfe-cockpit.ts`, `my-field-day.ts`, `sfe-day.ts`, le plan de tournée (liseré de la **lettre** dans la grille,
`plan-de-tournee/grille.tsx`) et son PDF (`lib/sfe/plan-pdf.ts`, `lib/plan-tournee-pdf.ts`).

**LA PORTÉE** (`resolveRepScope`, `lib/sfe.ts`) : un **lecteur de pilotage** — le module en lecture, **sans** rôle
terrain (`MEDICAL_DELEGATE`, `NATIONAL_SALES`, principal ou secondaire) ni profil de KAM : Direction Marketing… —
reçoit `mode: "all"` **`lectureSeule`** (tous les KAM, rien à toucher ; ni périmètre de coaching ni de chiffre
d'affaires) — `estLecteurDePilotage`. Avant, il tombait en `self` et voyait un pilotage vide. Le **directeur des
opérations** n'est plus un lecteur depuis le 08/10 : `SALES_PLANNING` MANAGE (et `BUSINESS_UNITS` MANAGE), portée tout.

**Anciennes adresses** : `/planning/pilotage` → `/planning` (cycle compris, liens des alertes déjà envoyées),
`/planning/affectations` → `/planning/produits`, `/planning/specialites` → `/annuaires/specialites`,
`/planning/messages` → `/marketing-cockpit?vue=messages`.

### Business Units — le montage de la force de vente, module à part (08/10)

**LA DÉCISION** : « tu crées dans le menu un module "Business Units" et tu y mets BU et secteurs et paramètres ». Module
`BUSINESS_UNITS` (pôle Operations & Sales, `BUSINESS_UNITS_TABS`) ; les pages ont déménagé de `planning/business-units`
et `planning/parametres` vers `app/(app)/business-units/` :

| Onglet | Route | Garde | Contenu |
|---|---|---|---|
| **Business units** | `/business-units` (`?etape=`, `?bu=`) | `requireModule("BUSINESS_UNITS")` + `peutConfigurerBu` (sinon → Paramètres) | `MontageBu` (`montage.tsx`, composant serveur partagé) : une carte par BU, quatre étapes `bu-etapes.tsx` — BU et superviseur, spécialités et produits (venus des dossiers Regulatory), KAM, secteurs |
| **Secteurs** | `/business-units/secteurs` | idem | toutes les BU ouvertes sur l'étape Secteurs ; **nommer un territoire** sur place (`NomTerritoire`, `nom-territoire.tsx` → `renommerSecteur`, `lib/actions/sales-planning-actions.ts` : seul le NOM change, pas la couverture ; un nom unique par BU, insensible à la casse ; droit Business Units « Modifier ») — le même composant sert dans Force de vente › Territoires |
| **Paramètres** | `/business-units/parametres` | module Voir ; écrire = Business Units « Modifier » ; la maille des plans de tournée = Super Admin | capacité terrain, poids des positions, fréquences de repli par palier, maille de planification |

Les gestes du montage se gardent par `BUSINESS_UNITS` ; prévisions et affectations restent à la Force de vente
(`SALES_PLANNING`). **Défaut** (`rbac.ts`) : chaque rôle qui **modifiait** la Force de vente reçoit ses gestes sur
Business Units (un lecteur n'y gagne rien) ; le **directeur des opérations** gère les deux depuis le 08/10. Migration
`20270116100000_module_business_units` : un accès personnalisé qui pouvait modifier la Force de vente est recopié, tout
autre (lecture seule, blocage) devient un **blocage** — personne ne perd le montage, personne ne le gagne. Anciennes
adresses : `/planning/business-units` (`?etape=secteurs` → Secteurs, autres étapes et `?bu=` suivent) et
`/planning/parametres` redirigent.

**WILAYA PIVOT PAR TERRITOIRE KAM (08-09/10)** : sur la ligne du territoire propre d'un KAM (étape Secteurs,
`wilaya-pivot.tsx`, `territoire-kam.tsx`), un **menu des 58 wilayas** fixe `SalesSector.wilayaPivot` ; à défaut, la
wilaya se déduit de la ville pivot (`city`). Règle PURE `lib/segmentation/in-out.ts` (+ `pivot-secteur.test.ts`) :
un praticien est **IN** si sa wilaya (la sienne, sinon celle de son établissement, sinon celle que le nom de
l'établissement nomme) est la wilaya pivot d'un KAM qui le couvre, **OUT** si les KAM qui le couvrent ont une wilaya
pivot et qu'aucune n'est la sienne, **inconnu** sinon (rien n'est deviné : la fréquence générale s'applique). Migration
`20270117110500_wilaya_pivot` (reprise : une `city` qui EST une wilaya devient la wilaya pivot). **Noms de territoires
(09/10)** : un nom occupé seulement par un ancien secteur **désactivé** (« Centre », « Est »…) est libéré — l'ancien
devient « Centre (ancien) » — au lieu d'être refusé comme homonyme (`sales-planning-actions.ts`).

### Marketing cockpit — le tableau de la Direction Marketing (refonte du 07/10)

Module `MARKETING_COCKPIT` (à part de la Force de vente, réglé personne par personne dans la console). **Une page**,
`/marketing-cockpit`, et ses vues par `?vue=` — `ensemble` · `leaders` · `messages` · `marche` · `investissements` —
le produit choisi (`?produit=`, un `PromoProduct` ; sinon `?bu=` ; à défaut la première BU segmentée sur son produit
n° 1) suivant d'une vue à l'autre ; la page rend elle-même sa barre (`MARKETING_COCKPIT_TABS`, l'entrée de menu n'a pas
de `tabs`). **Rien ne s'y saisit, sauf les messages** : tout se lit dans l'annuaire, la segmentation (moteur du Studio,
jamais recalculé à part), les visites terminées, les liens message ↔ visite, Ad & Pro, le matériel promotionnel, les
budgets et les données marché (`lib/marketing-cockpit/donnees.ts` ; calculs purs `calculs.ts`).

- **Vue d'ensemble** : tuiles, l'**entonnoir** de l'annuaire à la prescription (ciblés → segmentés Q1+Q2 → vus à
  fréquence…, chaque marche sous-ensemble de la précédente), « Ce qui bouge » (signaux, chacun avec sa page), « Où va
  l'argent ». Le cycle = le cycle de segmentation ouvert, sinon le mois civil ; le cycle précédent est lu **figé**.
- **Leaders d'opinion** : le panel aux statuts Décideur, Influenceur, Référent — lettre, dernière visite, visites 6
  mois, demandes Ad & Pro et montant attribuable au praticien.
- **Messages** (`messages-manager.tsx`, actions `promo-message-actions.ts`) : les messages que le KAM porte au médecin
  (exigés sur chaque rapport terrain), avec leur efficacité. **Écrire = deux clés** (`peutEcrireMessagesCockpit`,
  `lib/marketing-cockpit/acces.ts`) : la liste de rôles `promoMessageAuthorRoles` (Administration › Réglages — **par
  défaut `PRODUCT_MANAGER`**, la Direction Marketing : défaut de code ET migration `20270115140000_cockpit_marketing_auteurs`,
  qui ne remplit qu'une liste encore vide) ET le geste sur le module (créer / modifier / retirer) ; le Super Admin écrit
  toujours. La matrice donne au `PRODUCT_MANAGER` `MARKETING_COCKPIT` VIEW/CREATE/UPDATE/DELETE/EXPORT. **Retirer un
  message porté l'ARCHIVE** (il quitte le menu des KAM, son historique et ses liens visite restent) ; un message jamais
  porté se supprime.
- **Marché** (`lib/marketing-cockpit/marche.ts`, **serveur seul** — `market/data` lit `fs`) : part de la classe IQVIA
  (ville) et son évolution sur un an, parts mensuelles des réceptions PCH de la molécule, AMM concurrentes de moins
  d'un an. Onglet et tuile visibles **seulement** pour qui a déjà le marché (`peutVoirMarcheCockpit` = porte Business
  Development) — décision de ne pas élargir l'accès au marché, pas d'aguiche.
- **Investissements** : Ad & Pro engagé (direct, part allouée par `CoutRepartitionBu`, matériel au devis retenu), par
  lettre des praticiens nommés, et l'enveloppe — seulement pour qui lit Budgets ou Ad & Pro (`peutVoirArgentCockpit`).
- **Médecins concernés par une demande Ad & Pro (08/10)** : sponsoring, événement, congrès national / international,
  matériel promotionnel, autre demande portent désormais des **praticiens de l'annuaire** (`AdProMedecin`, rôle
  Bénéficiaire · Orateur · Invité · Autre ; carte `components/ad-pro/medecins-concernes.tsx` sur chaque fiche, actions
  `ad-pro-medecins-actions.ts`, règles pures `lib/ad-pro/medecins-concernes.ts`, lecture `queries/ad-pro-medecins.ts`).
  Pour un congrès, invités et prises en charge s'additionnent sans doublon (rien n'est copié). Le cockpit (dépenses par
  praticien), la fiche praticien, Produits 360 et le ROI Ad & Pro lisent ce lien.
- **« Ce qui dépend vraiment du terrain » (09/10, maquette validée)** — en marché d'AO, la part de réceptions PCH ne
  mesure pas l'effort marketing ; calculs purs `lib/marketing-cockpit/terrain.ts` (+ tests), lecture
  `terrain-donnees.ts` : **décideurs engagés** (H vus ≥ 2 fois dans le cycle), **conversions B → A / A → B** depuis le
  cycle figé, **affinité moyenne Q2/Q1** et sa tendance, **nos lots chez les hôpitaux** (numéros de lot normalisés
  croisés avec la distribution des DR — `repartitionParLots`) et les segments des décideurs de chaque établissement.
  **Besoins annuels des services** (`BesoinAnnuelService`, une ligne produit × établissement × service × année ; règle
  pure `lib/besoins-services/regles.ts`) : le KAM saisit à la visite du décideur le besoin annoncé pour l'année qui
  vient (en boîtes, facultatif, 0 = « ne commandera pas ») ; le cockpit le montre (`previsions-services.tsx`) et la
  Direction Marketing, le chef de produit et la Direction le corrigent (`besoins-services-actions.ts`). **La voix du
  terrain** (`components/shared/voix-terrain.tsx`, pur `lib/voix-terrain/pur.ts`, Luna `lib/voix-terrain-luna.ts`) :
  les rapports des derniers jours rangés en cinq familles (objection, approvisionnement, opportunité, concurrence,
  pharmacovigilance), avec une citation **mot pour mot** par famille (un extrait introuvable est refusé) ; sans Luna, repli
  par mots-clés, dit à l'écran ; cache du jour `VoixTerrainCache`. Migration `20270117183000_besoins_services`.

Onglets gardés par `nav-tabs.ts` (règles `marche-cockpit` / `argent-cockpit` : le module PUIS la règle). Anciennes
adresses : `/marketing-cockpit/messages` → `?vue=messages` (produit compris), `/marketing-cockpit/specialites` →
`/annuaires/specialites` (les **Spécialités** sont revenues dans les Annuaires, porte unique, `peutGererSpecialites`).

### Mon Équipe — vue d'ensemble, équipe, calendrier, fiche personne (07/10)

Même porte qu'avant (la hiérarchie revérifiée côté serveur, `getMyTeam`) ; nouvel écran en **trois vues + un panneau**
(`app/(app)/mon-equipe/` : `vue-ensemble.tsx`, `vue-equipe.tsx`, `vue-calendrier.tsx`, `fiche-personne.tsx`). Lecture
unique `lib/queries/my-team-overview.ts`, pour les seules personnes de l'équipe : congés (accordés, et en attente en
clair), missions (assignations aux congrès et événements), formations ; activité 30 j (terrain : visites et couverture
du panel `clausePanelDuKam`, mêmes définitions que le cockpit SFE ; autres : tâches terminées) ; alertes (fin de
contrat, fin de période d'essai, solde de congés, visites sans compte rendu, anniversaire). **N'en sortent jamais** :
salaire, type de congé (§118.184), année de naissance. La file « À décider » garde ses cinq natures et leurs circuits
(congés, achats, formations, marches de recrutement, plans de tournée). Le **Recrutement** n'est plus son sous-menu.
**08/10** : quatrième vue **KPI** (`?vue=kpi`, à qui a le module `KPI` — voir « KPI & bilans » plus bas) ; la colonne
« Personne » du tableau de l'équipe réduite de moitié (`vue-equipe.tsx`).

### Rapports terrain — l'onglet « Rapports » de la Promotion médicale (07/10)

**Plus une entrée de menu** : le KAM fait son rapport **depuis son planning** (Plan de tournée : il touche le
praticien, la feuille de la visite s'ouvre ; « Faire un rapport » au-dessus de la grille ; « Pharmacovigilance » à
côté) ; l'onglet **« Rapports »** (`/medical/rapports`, `MEDICAL_TABS`) n'est que la **liste**. Garde : le module
**`FIELD_REPORTS`** (la console règle toujours qui voit l'onglet). Adresses écrites une fois dans
`lib/chemins/rapports-terrain.ts` (PUR) : liste, fiche d'un compte rendu (`/medical/rapports/[id]`), analyse
(`/medical/rapports/overview`, rôles cochés `fieldReportsOverviewRoles`), signalements (`/medical/rapports/pharmacovigilance`).
Les anciennes (`/field-reports`, `/[id]`, `/overview`, `/pharmacovigilance…`) **redirigent** — des notifications en
base les portent (tests `chemins/rapports-terrain.test.ts`, e2e `rapports-terrain-corbeille.spec.ts`).

**Trois sources, une liste** (`lib/queries/rapports-terrain-liste.ts`, `chargerListeRapports`) : une **visite
rapportée** (`MedicalVisit` COMPLETED — « Visite », ou « Sans visite » si imprévue), un **compte rendu vocal** sans
visite (`FieldReport` à `visitId` nul ; celui qui documente une visite se rattache à sa ligne), un **signalement de
pharmacovigilance** (`PharmacovigilanceCase`). **Qui voit quoi = les règles d'hier** : visites et comptes rendus selon
`viewsAllReports` (Direction, managers, superviseur national : tout ; les autres : les leurs) + `platformScope` ;
signalements selon `clauseCasPvVisibles`, et seulement pour qui signale ou reçoit des cas. L'écran
(`medical/rapports/liste-rapports.tsx`) est un **tableau, au téléphone aussi** (date collée à gauche) ; une ligne ouvre
le rapport dans une feuille latérale, d'où s'ouvre la fiche du compte rendu ou du cas.

**Journée du KAM et plans (09/10)** : **Ma journée** (`medical/ma-journee/emploi-du-temps.tsx`) porte un appel à
l'action « rapport terrain » sur chaque visite à rapporter, et le rapport de visite d'un décideur accueille le **besoin
annuel du service** (voir Marketing cockpit). **Un plan de tournée en brouillon se supprime** (« Supprimer » puis
« Confirmer », `plan-de-tournee/supprimer-plan.tsx` → `supprimerPlanTourneeBrouillon`, `tour-plan-actions.ts`) : seul
un brouillon (un plan soumis, validé ou rejeté garde sa trace de décision), dans le périmètre, et jamais si une de ses
visites est déjà rapportée — le refus le dit et le plan reste ; les visites planifiées partent avec lui (audité).

### Mon espace › Aujourd'hui — la journée du métier (14/10)

Décision de la Direction (maquette « Mon espace par métier ») : l'onglet **Aujourd'hui** remplace l'onglet « Mon espace »
sur la même adresse `/mon-espace` (`WORKSPACE_TABS` ; l'ancien onglet `/aujourdhui`, nouveauté `home_today` au stade
TEST, quitte la barre pour ne pas doubler le nom — sa page reste servie, inchangée). Les autres onglets (Tâches, Mes
missions, Mon dossier RH, Mon bilan) ne changent pas.

- **Source unique** : `getActionCenter` (déjà gardé par les droits, une ligne par objet) + les pièces qu'on me demande —
  lus par `lib/queries/aujourdhui-espace.ts:chargerAujourdhui`. `ActionItem` porte désormais `montant` (ordre de dépense,
  validation chiffrée, poste Ad & Pro, achat, déclaration), `famille` (catégorie de l'ordre, nature de la source d'une
  déclaration) et `statut` (déclarations).
- **Règles PURES** `lib/espace/aujourdhui.ts` (+ `aujourdhui.test.ts`) : `regrouperFile` (lots par nature — paiements,
  déclarations à faire / prêtes / en attente de pièces / finales, validations, congés, achats, demandes, Ad & Pro,
  plans, missions, pièces, tâches…, titre concret « 12 paiements à régler — 2 022 550 DZD, dont 5 en retard »,
  sous-lignes par famille, une ligne « et d'autres… » devient la suite du lot), urgence **retard cumulé > montant >
  ancienneté** ; `phraseJournee` ; `composerTuiles` / `composerRaccourcis` (composition par rôle `METIERS`, union sans
  doublon pour un compte à deux rôles, tuile absente quand aucune donnée ne la porte) ; `calculerSemaine` ;
  `composerEquipe`.
- **Gestes** : chaque lot et chaque ligne MÈNENT à l'écran qui fait le geste (aucun circuit neuf). « Régler les N en
  retard » ouvre `/finances/paiements-a-faire?focus=id1,id2…` (l'écran met en évidence chaque ordre listé) ; les
  congés gardent leur bloc `#conges-a-signer` sur la page. Pas de « Confier à… » : aucun mécanisme de réaffectation
  ponctuelle n'existe pour un paiement ou une déclaration.
- **Ma semaine** (dimanche → jeudi, `semaineOuvree` ; un vendredi/samedi, la semaine qui vient de finir) : gestes datés
  de la personne — `ValidationStep.decidedAt`, `AdminApproval.decidedAt`, marches N+1/RH/DG d'un congé,
  `WorkflowStepEvent` (APPROVE/REJECT/REFUSE/RETURN), `ExpenseOrder.paidDate`, `pharmacistValidatedAt`/`validatedAt`,
  tâches terminées. Pas de série « jours sans retard » : aucun historique ne permet de la calculer honnêtement.
- **Mon équipe** (N+1 seulement) : `getMyTeam` → `getMyTeamOverview` (directs, tâches en retard, présence, alertes) ;
  « Relancer » = `relanceTaskRequest` sur la plus ancienne tâche en retard que JE lui ai demandée, si `peutRelancer`.
- **Rappels** : `MyReminders` + ajout rapide (`createReminder`). **Moi** : note de frais et formation (mêmes feuilles,
  boutons compacts), congé et attestation (lien « Mon dossier RH »). Banc de droits : `queries/aujourdhui-espace-flow.test.ts`.

### Mon espace › Tâches — un seul endroit pour toutes les tâches (07/10)

Cinq listes dispersées dans Mon espace (demandées, mes tâches, où je participe, en lecture, que j'ai demandées,
déléguées) deviennent un **onglet** `/mon-espace/taches` (`WORKSPACE_TABS`), en vues (`?vue=`, toute valeur inconnue →
« À faire ») rangées par la règle pure `rangerTache` (`lib/tasks/onglet-taches.ts`, + tests) :

| Vue | Contenu |
|---|---|
| **À accepter** | ce qu'on me demande : accepter ou refuser, en haut, avant tout |
| **À faire** | demandes acceptées, mes to-do, tâches créées par la plateforme |
| **Demandées** | ce que j'attends des autres, avec « chez qui » et le seul geste utile ; une demande **rendue** y reste « à vérifier » une semaine, un **refus** un mois |
| **Partagées** | je participe ou je lis |
| **Terminées** | faites ou annulées depuis 30 jours (lue à part, paginée) |

Lecture `lib/queries/mes-taches.ts` (cercle `clauseTachesVisibles`, le même que la fiche et la recherche) : chaque ligne
porte ses **droits calculés avec les règles de `request-flow.ts`** que les actions rejouent (un bouton ne propose pas ce
que l'action refuserait), fil et pièces préchargés (le panneau s'ouvre sans attendre). **Compteur de l'onglet** = à
accepter + à faire (`ongletsEspace`). **Réattribuer** (`reattribuerDemandeTache`, `lib/actions/task-actions.ts`) : une
demande **refusée ou restée sans réponse** (`STATUTS_REATTRIBUABLES` = REQUESTED, DECLINED) part chez quelqu'un
d'autre — **seul le demandeur** (`refusReattribution`) ; la nouvelle personne reçoit une DEMANDE (elle accepte ou
refuse, jamais une tâche déposée d'office) et sort des participants/lecteurs ; l'ancienne, si elle n'avait pas répondu,
est prévenue ; écriture conditionnelle (une acceptation pendant le clic l'emporte), trace au fil. La fiche
`/mon-espace/taches/[id]` reste servie.

**Ce qui a quitté Mon espace (07/10)** : l'onglet **Directives** (elles restent dans « Aujourd'hui », le centre
d'actions, la recherche et les notifications ; `/directives` reste servie, `match` de Mon espace ne la couvre plus) et
le bloc **« Mes demandes d'achat »** (les achats passent par le **Bureau du secrétariat**). Les tâches du centre
d'actions ne sont plus reprises dans le bloc des décisions : elles ont leur onglet.

### Produits 360 — un seul catalogue, le produit = son dossier (07/10)

**LA DÉCISION** : « Produit = dossier réglementaire ; je ne veux pas que les produits et les dossiers réglementaires
soient deux catalogues différents. » L'écran ne montre **qu'un** objet, le **produit canonique** (`Product`) ; ses
dossiers (`RegulatoryProduct.productId`) en sont l'enregistrement et portent le **stock** (relevés indexés sur le
dossier : stock du produit = somme des derniers relevés de chaque lieu de ses dossiers) ; `PromoProduct` et `BdProduct`
restent des tables internes rattachées au même `productId` (`lib/queries/produits-360.ts`).

- **Liste** `/produits` (menu « Produits 360 ») — **portefeuille v2 (09/10)** : onglet **Commercialisés** = le tableau
  trié par **note de santé** (ce qui va mal d'abord), filtrable par BU (`portefeuille.tsx`, client, n'importe que des
  modules purs) — santé, mois de couverture, visites du cycle et leur évolution, prescripteurs A, Ad & Pro engagé et
  **UNE alerte** (`alertePrincipale`) ; **« Comparer »** : 2 à 4 produits cochés côte à côte (la sélection est dans
  l'URL, rendue par le serveur). Onglet **En enregistrement** (le pipeline). Chaque colonne n'apparaît qu'à qui a son
  module. Menu ⋯ : « Vérifier le catalogue » (Super Admin) et « Rapprocher un produit BD / BU » (voir plus bas).
- **LA NOTE DE SANTÉ /100 (09/10)** — module PUR `lib/products/sante.ts` (+ tests `sante.test.ts`), poids
  `POIDS_SANTE` **25 / 25 / 20 / 15 / 15** : **Stock** (couverture de la chaîne PCH + hôpitaux : ≥ 3 mois = 100, 0 mois
  = 0 ; −10 par lot qui périme sous 6 mois, au plus −30), **Couverture terrain** (part des cibles H·A·B vues à fréquence
  ce cycle), **Prescripteurs** (25 % de A = 80 points, plafonné, + dynamique ±5 par A net gagné / perdu depuis le
  dernier cycle, 10 neutres), **Réglementaire** (échéance du renouvellement de la DE : dépassée −60, ≤ 90 j −45, ≤ 6
  mois −25 ; −15 par variation en attente, au plus −30), **Qualité** (cas de PV ouverts : décès −60, grave −40, gravité
  inconnue −25, non grave −15). Une composante **sans donnée** (module non visible, aucun relevé…) n'est pas un zéro :
  elle est exclue (« n/d ») et les poids restants sont renormalisés. L'**anneau** (`components/produits/anneau-sante.tsx`)
  ouvre au clic le détail des cinq composantes (note, poids, fait, règle). Lectures multi-produits
  `lib/queries/produits-360-sante.ts` (segmentation, Promotion médicale, Ad & Pro par les médecins concernés, lots PCH)
  — appelées seulement pour les modules que la personne voit.
- **« Luna — l'essentiel ce mois » (09/10)** sur la fiche : part pure `lib/products/essentiel-360.ts` (consigne,
  schéma, relecture stricte : chaque point CITE ses faits et tout nombre écrit doit y figurer, sinon il tombe), appel
  `lib/produit-360-luna.ts` (cache du jour → interrupteur général → bascule `produit_360` → clé → appel borné 15 s →
  `logAiUsage`) ; cache d'un jour dans `VoixTerrainCache` (clé `produit360|` + empreinte des faits : Luna ne lit que
  des faits que la personne voit). Tout échec retombe sur le repli déterministe (les trois faits les plus urgents).
- **Fiche** `/produits/[id]` = **LA page du produit** : identité, frise du cycle de vie (étude → enregistrement →
  commercialisé → fin de vie), cinq chiffres, « À surveiller » (dont AO attribués), onglets **Vue d'ensemble · Ventes &
  marchés · Terrain & marketing · Réglementaire & qualité · Stock · Coûts · Documents**. Échéance DE : validité 5 ans,
  dépôt du renouvellement 180 j avant. Calculs purs `lib/products/fiche-360.ts` (+ tests) ; marché du produit
  `lib/market/produit-marche.ts` (serveur seul : mêmes sources et normalisations que l'Explorateur, marché = molécule +
  dosage + forme, élargi et DIT quand vide ; « à nous » = nos marques ou nos laboratoires, sinon part `null`).
- **Qui voit quoi** : un produit se voit par un dossier **non verrouillé** (`regulatoryLockWhere`) ; chaque colonne et
  onglet suit SON module (`SECTIONS_360`, `lib/vues-360-acces.ts` — ajout du 07/10 : `stock` STOCKS,
  `pharmacovigilance` PHARMACOVIGILANCE, `materiel` PROMO_STOCK, `marketing` MARKETING_COCKPIT) ; le marché suit
  `voitLeMarche` (Market Intelligence OU Explorateur produits).
- **Prix manuels historisés** (`ProductPrice` : `productId`, `kind` ∈ PPA · SHP · TARIF_REFERENCE · PRIX_HOPITAL,
  `amountDzd`, `validFrom`, `note`, `setById` — migration `20270115183000_prix_produit`) : chaque saisie **ajoute** une
  ligne ; la saisie l'emporte sur l'Explorateur à partir de sa date d'effet (`resoudrePrix`) ; une ligne **sans
  montant** rend la main à l'Explorateur. Actions `lib/actions/prix-produit-actions.ts`, garde `peutModifierLesPrix`
  (Produits 360 « Modifier » OU Regulatory « Modifier » — le prix est fixé avec la décision d'enregistrement).
- **UN DOSSIER = UN PRODUIT (08/10, « on a dit : un seul catalogue de produits ! »)** — règle pure
  `lib/products/produit-du-dossier.ts` (+ tests), écriture `ensureProduitDuDossier` (`lib/products/canonique.ts`) :
  chaque dossier **non verrouillé** reçoit SON produit — jamais celui d'un autre dossier, même de même identité (le
  catalogue ne fusionne plus) ; une identité **incomplète** n'est plus un blocage mais une indication sur la fiche
  (« Conditionnement à compléter ») ; une identité complétée ou corrigée met à jour **le même** produit, un champ vidé
  ne le vide pas ; un produit hérité, partagé par plusieurs dossiers, n'est **pas scindé d'office** — seul le dossier
  dont l'identité s'en écarte reçoit le sien. Clé `Product.identityKey` : l'identité si libre, sinon suffixée de l'id
  du dossier ; identité incomplète → clé `dossier:<id>`. **Quand** : à la création et à chaque modification du dossier
  (`regulatory-actions.ts`), à l'ouverture du cadenas (`setRegulatoryLock`, `unlockAllRegulatory` — un dossier
  verrouillé entre au catalogue à ce moment), **une fois par processus au démarrage** (`assurerProduitsDesDossiersAuDemarrage`,
  `lib/scheduled.ts`), et à la demande : **« Vérifier le catalogue »** (Super Admin seul, `verifierProduitsDesDossiers`,
  `lib/actions/produit-canonique-actions.ts`, bilan : dossiers, créés, mis à jour, à compléter, produits partagés listés)
  ou `npx tsx scripts/produits-rattachement-bilan.ts` (même passage, idempotent). Un dossier d'avant sans produit
  porte sur sa fiche **« Créer sa fiche produit »** (`regulatory/[id]/creer-produit.tsx` → `rattacherDossierCanonique`,
  droit de modifier le dossier ; refusé sur un dossier verrouillé).
- **L'écran « Rattachement au catalogue » est retiré** : `/regulatory/catalogue` → `/produits`,
  `/regulatory/catalogue/[id]` → `/produits/[id]?onglet=reglementaire` (adresses gardées pour les liens d'avant). Seul
  reste le **rapprochement d'un produit BD / BU** créé sans dossier : `/produits/rapprocher` (Produits 360 Voir +
  **Regulatory « Modifier »**, sinon renvoi à `/produits` ; `reconcile-table.tsx`, `getCatalogReconciliation`) — la
  machine propose le dossier qui ressemble et dit pourquoi, une personne tranche ; rattaché, le produit BD / BU reçoit
  le produit du dossier et peut être rapporté en visite.
- **Ventes & marchés** lit les données **Ventes PCH** (réceptions PCH, distribution DR, part de marché fournisseurs,
  chaîne contrat).

### Operations & Sales — cockpit, Ventes PCH, chaîne (08/10)

**LE PÔLE** : « sépare Marketing et Sales » puis « Stocks et Logistique rejoignent Operations & Sales » — `NAV_POLES`
(`lib/navigation.ts`) n'a plus `SALES_MARKETING` ni `SUPPLY_CHAIN` ; le pôle `OPERATIONS_SALES` range Cockpit
Opérations, Promotion médicale, Force de vente, Business Units, Marchés PCH, Ventes PCH, Stocks, Logistique (toujours
retirée, `modules-retired.ts`), Budget Operations & Sales (Retours & réclamations, retiré le 09/10). **Consommation** n'a plus d'entrée
(écrans, données et module `CONSUMPTION` intacts : affinité de segmentation, Produits 360).

**COCKPIT OPÉRATIONS** (`/operations`, `COCKPIT_OPERATIONS`, lecture seule — Voir = l'ouvrir ; défaut : directeur des
opérations, Direction, DG). Lecture `lib/queries/cockpit-operations.ts` (`chargerCockpitOperations`), calculs purs
`lib/cockpit-operations/calculs.ts` (+ tests) : tuiles **livré à la PCH** (nos réceptions PCH sur la période, valeur au
coût d'achat, évolution — un produit sans fournisseur « à nous » réglé est illisible, pas zéro), **exécution des
marchés**, **demande non servie**, **ruptures à 60 jours** (couverture de la chaîne), couverture terrain ; table « Par
BU » (`?bu=`) ; « À traiter » (avenants, BC en retard, fichiers PCH manquants, hôpitaux en rupture, stock PCH périmé,
logistique, risques Brain du périmètre — `filtreDuPerimetre`). **Rien n'est ressaisi** : ventes PCH, chaîne des contrats,
stocks de la chaîne, force de vente, Brain. `AccesCockpit` : un signal dont la personne ne voit pas l'écran n'est pas lu.
**Enrichi le 09/10 (maquette validée, « le terrain »)** — calculs purs `lib/cockpit-operations/terrain.ts` (+ tests),
lecture `lib/queries/cockpit-operations-terrain.ts` : **l'équipe aujourd'hui** (`statutDuJour` : congé approuvé >
mission qui couvre le jour > terrain avec la ville la plus fréquente des praticiens à voir > « rien de prévu »), les
**visites du jour** (prévues / réalisées), le **score KPI de l'équipe**, les **ruptures signalées** dans les rapports
des KAM (`signaleUneRupture`, croisées avec le stock PCH central) et les **plans de tournée à valider** versés dans
« À traiter », les **stocks relevés dans les hôpitaux** par les délégués, et « Cette semaine » (événements des 7
jours). Une donnée absente rend `null`, jamais zéro.

**VENTES PCH** (`/sales`, `PCH_VENTES`, `VENTES_PCH_TABS` — remplace l'ancienne saisie `SALES`, retirée, dont
l'historique se lit en lecture seule dans `/sales/historique`). **Deux natures de fichiers** (`lib/ventes-pch/lecture.ts`,
pur, reconnues par leur en-tête) : les **ventes mensuelles d'une direction régionale** aux hôpitaux (`VENTEDR*.xls` —
ANNEXE … QTÉ_COMMANDÉE, QTÉ_LIVRÉE, COUT_ACHAT, PRIX_VENTE, DATEFACT ; livrée 0 pour une commande = **demande non
servie**, livrée négative = **retour**) et les **réceptions de la PCH centrale** (annuelles ou mensuelles — CODE_FOUR,
NOM_FOUR, CODE_PRO, QTE, TYPE_RECEP…). Le CODE_PRO des réceptions est le POSTE des ventes. **Import**
(`/sales/importer`, Téléverser ; `lib/ventes-pch/service.ts`) : aperçu sans écriture → application ; même fichier
(empreinte) = rien ; un fichier plus récent **remplace** sa tranche DR × mois (ou réceptions × mois), l'annuel ses
douze mois (`planRemplacement`, `calculs.ts`) ; l'original est gardé (`/api/ventes-pch/fichier/[id]`). **Période
choisie par fichier (09/10)** : à l'import, chaque fichier reçoit son **mois et son année** (ou « annuel » : chaque
ligne garde son mois, ramené à l'année choisie — `ChoixPeriode`, `moisSelonChoix`) ; sans choix, la période se lit sur
les dates du fichier. Colonnes `PchVenteImport.periodeAnnee` / `periodeMois` / `periodeChoisie` (migration
`20270117120500_ventes_pch_periode`, les imports d'avant reprennent leurs mois enregistrés). **Tout connecté**
(`correspondance.ts`) : client → établissement de l'annuaire (mémoire `PchEtablissementMemoire`, sinon nom normalisé
désignant UN établissement), **poste PCH → produit** (mémoire `PchPoste`, sinon la présentation — molécule, dose,
forme, UC — doit désigner UN de nos produits ; une molécule qui n'est pas à nous reste donnée de marché), fournisseurs
« à nous » proposés puis corrigés par produit (`PchFournisseurProduit`), directions régionales nommées
(`PchDirectionRegionale`) ; chaque rattachement (Modifier, audité, `lib/actions/ventes-pch-actions.ts`) s'applique aux
lignes déjà importées et se mémorise. **Onglets** : Synthèse (BU → produit : reçu PCH, distribué, non servi, part de
marché, évolution), **Contrats** (attribué → BC → livré ; un BC **d'avenant** — `PchOrder.estAvenant`, case du BC dans
Marchés PCH — compte à part), Territoires (DR, wilaya, établissement, série 12 mois), Non servi (produit × DR), Importer,
Historique. API de lecture `requetes.ts` (`venteParProduitEtMois`, `demandeNonServie`,
`consommationHospitaliereMensuelle`, `receptionsPch`, `partDeMarche`…) — lue par le cockpit, les stocks de la chaîne et
Produits 360. Défauts : opérations, Direction, DG gèrent ; National Sales, Head of Sales, Manager Promotion médicale,
Direction Marketing lisent. Migration `20270116160000_ventes_pch`.

**STOCKS DE LA CHAÎNE** (`/stocks/chaine`) et **STOCK PCH CENTRAL** (`/stocks/pch-central`) — onglets du module Stocks
(`ongletsStocks`, `lib/chemins/stocks.ts`), ouverts à la chaîne d'approvisionnement (`voitLaChaine`,
`lib/queries/stock-pch.ts` : Super Admin, vue globale ou PCH Voir ; sinon renvoi à `/stocks`). La chaîne : par BU et
par produit, notre stock, le dernier relevé PCH central, la somme du dernier relevé de chaque hôpital, l'âge des relevés
(orange au-delà de `JOURS_FRAICHEUR` = 30 j) et la **couverture** = stock ÷ consommation mensuelle (moyenne des 3
derniers mois complets distribués aux hôpitaux, Ventes PCH) — rouge sous 2 mois, orange sous 3. Le stock PCH central
est **saisi à la main** (« reçus par mail ») : `enregistrerStockPch` (`lib/actions/stock-pch-actions.ts`, garde
`saisitLeStockPch` = voit la chaîne + Stocks Créer/Modifier) — date du mail (jamais future), central ou une **annexe /
DR** (lieu `StockAnnex` de type ANNEX, jamais un nom libre), nos produits seulement (relus côté serveur), « Coller le
tableau » (règles pures partagées `lib/stocks/pch-central.ts`), mail ou PDF joint (entityType `STOCK_PCH_RELEVE`) ; les
quantités s'écrivent par `ecrireEtatDuJour` — un état par produit, lieu et jour, ressaisir corrige. **Sources du stock
(10/10)** : PCH central + **DR** (`StockSnapshot.drCode`, scope ANNEX) et relevés des hôpitaux (KAM) — Adventum n'a **pas
de stock propre**. Le relevé peut se lire d'un **fichier Excel / CSV** (`lireReleveStockPch`, `lib/stocks/pch-releve-fichier.ts` :
lecture seule, vérification à l'écran puis `enregistrerStockPch`).

**RETOURS & RÉCLAMATIONS — RETIRÉ (09/10)** : le module `RETOURS_RECLAMATIONS`, l'écran `/retours-reclamations`, ses
actions, ses règles (`lib/reclamations/`), ses chemins, son entrée de menu et son lien dans la journée du KAM n'existent
plus. **Les données sont gardées** : le modèle `Reclamation` et la migration `20270116143000_retours_reclamations`
restent en base (rien n'est supprimé, un retour éventuel retrouverait l'historique). Les anciennes notifications
(« réclamation déclarée… ») ne mènent plus à un 404 : `/retours-reclamations` est réécrit vers `/mon-espace`
(`lib/notifications/lien-actuel.ts`, voir « Notifications »).

**DROITS DU DIRECTEUR DES OPÉRATIONS** (« → oui ») : Force de vente et Business Units en **gestion** (portée tout),
Marketing cockpit en lecture, et **Adventum Brain borné à son périmètre** (`ADVENTUM_BRAIN` VIEW/UPDATE ;
`lib/adventum/perimetre.ts`, pur + tests : catégories PCH, FIELD, MEDICAL, QUALITY, SALES, STOCKS, LOGISTICS,
ou un module des opérations — un module qui nomme un autre domaine, Ad & Pro, marketing, réglementaire,
RH, finances, budget…, l'emporte). Hors Super Admin, `/adventum-brain` n'offre que « Ce matin » (sans briefing) et
« Risques », filtrés par `lireRisques(…, filtreDuPerimetre(false))` ; ni question libre, ni historique, ni seuils.

### KPI & bilans — des KPI sans code (08/10)

Module `KPI` (« KPI & bilans »), **porte accordée à tous les rôles** (Voir, Créer, Modifier, Valider, Exporter) ; le
**périmètre suit l'organigramme, jamais le rôle** (`lib/kpi/droits.ts`, pur) : on voit SON bilan et celui de SON arbre
(`subtreeOf`, le même que Mon équipe) ; noter un KPI évalué, valider une déclaration, signer une revue = Valider, sur
quelqu'un de son arbre, **jamais sur soi** ; créer un KPI pour son équipe = Créer + avoir une équipe ; déclarer = pour
soi seulement ; le **catalogue et les modèles par rôle** = Super Admin (`/admin/kpi`, « KPI & modèles »).

- **Couche 1 — briques** (`lib/kpi/briques.ts`, pur ; calcul serveur `briques-calcul.ts`) : des mesures écrites une
  fois dans le code sur des données que la plateforme tient déjà (visites, messages portés, contacts requis /
  réalisés, cibles vues à fréquence, rapports dans le délai, plans de tournée validés à temps, note de coaching, tâches
  à temps, réclamations déclarées, validations et leur délai, **demandes traitées** et leur délai — support
  `resolvedAt`, RH `handledAt`, administratives `completedAt` —, **livré / non servi PCH** par secteur ou BU, cible Luna…).
  Aucune brique n'estime : donnée absente → `null` et sa
  raison. **Ajouter une brique est le seul cas où l'on code.**
- **Couche 2 — définitions** (`KpiDefinition`, versionnée par famille — modifier crée une version) : une brique ou le
  rapport de deux, filtres, cible, sens (plus haut / plus bas = mieux), nature **CALCULÉ · RATIO · ÉVALUÉ · DÉCLARÉ ·
  IMPORTÉ** ; affectée à un rôle, à l'équipe d'un manager ou à une personne, avec un **poids** (`KpiAssignment`).
  Création depuis l'écran (`components/kpi/kpi-createur.tsx`) : une phrase → définitions proposées par **Luna**,
  contraintes aux briques → **aperçu sur les 3 derniers mois réels** de l'équipe → « Ajouter » ; ce que les briques ne
  savent pas mesurer → **« Proposer une nouvelle mesure »** (un retour Feedback de module KPI au Super Admin).
- **Note et score** (`lib/kpi/score.ts`, pur) : note sur 100 **plafonnée à 120** (valeur ÷ cible, ou cible ÷ valeur
  pour un délai ; ÉVALUÉ = niveau ÷ niveau max) ; sans cible, un KPI s'affiche mais ne compte pas ; **score global**
  pondéré, un KPI sans donnée sort du calcul et son poids se répartit (l'écran le dit).
- **Luna** (`lib/kpi-luna.ts`, portes : interrupteur IA → bascule → clé → appel borné 25 s → relecture stricte →
  journal ; consignes pures `kpi/luna-pur.ts`) propose des définitions, un commentaire, et le **niveau** d'un KPI évalué
  sur preuve ancrée — **jamais le chiffre d'un KPI** ; sans preuve, pas de proposition : le manager note.
- **Écrans** : **Mon équipe › KPI** (`?vue=kpi`, `vue-kpi.tsx`, `chargerTableauKpi`) — une colonne par KPI, score,
  propositions à noter, déclarations à valider, revue (fréquence mensuelle / trimestrielle / semestrielle par manager,
  `KpiReviewSetting`) ; **Mon espace › Mon bilan** (`/mon-espace/bilan`, `components/kpi/bilan-kpi.tsx`) — ses KPI en
  continu, sa revue signée (`KpiReview` fige ses lignes), « Déclarer » avec la pièce (`/api/kpi/piece/[id]`).
- **Cache** (`lib/kpi/service.ts`) : valeur rangée dans `KpiValue`, recalculée au-delà de 15 min tant que la période
  vit ; battement quotidien `rafraichirKpiSiDu` (`lib/scheduled.ts`). Actions `lib/actions/kpi-actions.ts`. Migration
  `20270117090000_kpi` (seed : le modèle de rôle **KAM**, 6 KPI, poids 30/20/15/20/5/10).

### Missions Ad & Pro reliées au profil (08/10)

« L'ordre de mission doit être validé par le N+1 avant d'arriver chez les RH » ; « ils ne sont pas obligés de demander
transport, hôtellerie etc. : ça ne doit même pas s'afficher tant qu'ils n'ont pas cliqué ». Remplace l'ancien suivi
par marqueur sur l'assignation (`/missions`, `mission-item.tsx` supprimé ; `/missions` → `/mon-espace/missions`).

- **Inviter** (`assignMission`, carte **« Équipe Adventum »** `components/missions/equipe-adventum.tsx` sur congrès
  internationaux / nationaux, événements, sponsoring) : une assignation (accompagnant, délégué de référence) est une
  **INVITATION** (`MissionAssignment.response` = INVITEE) ; une seule ligne par personne et par demande (réinviter
  rouvre celle d'une personne qui avait décliné ou été retirée) ; on ne s'invite pas soi-même. Relancer, remplacer,
  retirer (archive souple) dans « ⋯ ». Règles pures `lib/missions-equipe/etat.ts` (+ tests), orchestration
  `missions-equipe/serveur.ts`.
- **Répondre** (`repondreMission`) : seule la personne invitée, une fois ; **décliner exige un motif**. Les
  assignations d'avant la migration valent CONFIRMEE.
- **Mes missions** (`/mon-espace/missions`, onglet de Mon espace ; `components/missions/mes-missions.tsx`) : en tête
  les ordres à valider comme N+1 et les invitations ; puis une carte par mission confirmée où **seul l'ordre de mission
  paraît d'office**. Dates et ville reprises de la demande, modifiables (`modifierMission`) — le sponsoring en reçoit
  ainsi pour paraître aux calendriers.
- **Ordre de mission** (`requestMissionOrder`) : mission confirmée et dossier RH lié exigés ; une demande RH
  `MISSION_ORDER` pré-remplie (`omPrefill` : objet, destination, dates) précédée de la **marche du N+1**
  (`managerGate` PENDING → `deciderOrdreMissionN1` : le N+1 enregistré ou toute personne au-dessus dans la chaîne
  actuelle ; refus motivé, la personne est prévenue) ; sans N+1, elle part **directement aux RH** (`HR_REQUESTS`
  Modifier, notifiés). Retirable tant que les RH ne l'ont pas produite.
- **Étapes facultatives** (`ajouterEtapeMission`) : **transport / hébergement** (demande « Déplacement / Hôtel /
  Billet » au Bureau du secrétariat, reliée et pré-remplie), **matériel** (demande de stock promotionnel reliée,
  `PromoStockRequest.missionAssignmentId`), **note de frais** (la demande RH `EXPENSE_REPORT`, à partir du jour du
  retour).
- **Frais de l'équipe** (`integrerFraisEquipe`, à la clôture, droit de modifier la demande) : l'organisateur reporte
  **à la main** le montant exact du transport ou de l'hébergement d'un membre → depuis le 14/10, une **ligne de dépense
  du budget Operations & Sales** (`BudgetExpenseLine`, catégorie choisie sur la ligne, à défaut l'imputation du membre,
  à défaut « Frais de déplacement terrain » de l'enveloppe de l'année ouverte d'office) ; son id va dans
  `transportPosteId` / `hebergementPosteId`. Avant : un poste Ad & Pro (Déplacement / Hôtellerie) — ceux-là restent où
  ils sont et s'affichent « intégré à Ad & Pro (avant le changement) ». Rien d'automatique. Migration
  `20270116170000_missions_profil`.

#### Demande de participation, négociation, mission et clôture (11/10)

« Inviter à participer » envoie une **demande de participation** ; la personne répond par une **fiche native**. Règles
PURES `lib/missions-equipe/participation.ts` (+ tests) ; page unique `/mon-espace/missions/[id]` (`lienMission`,
`components/missions/mission-equipe.tsx`), destination de toutes les notifications. Migration
`20270120090000_mission_equipe_participation`.

- **Fiche** (`proposerParticipation`) : présence du / au (reprise de l'événement), rôle (lecture seule), transport
  (avion, train, bus, véhicule de service, véhicule personnel ; départ / arrivée ; aller / retour ; « Adventum réserve » ou
  « je réserve, note de frais » ; précisions), hébergement (Adventum réserve / je m'en occupe — hôtel, nuits, estimation
  en USD à l'international / pas besoin), commentaire. Décliner (motif) reste possible ; « Je confirme » sans fiche est refusé.
- **Versions** (`MissionParticipationVersion` : numéro, auteur, côté PERSONNE / ADVENTUM, nature, contenu JSON, motif,
  sort EN_ATTENTE / ACCEPTEE / REFUSEE / REMPLACEE). La balle passe de côté à chaque version ; un refus (motif exigé) la
  rend à l'auteur ; « Modifier et contre-proposer » remplace la version en attente. L'écran surligne ce qui a changé
  (`comparerFiches`) ; l'état se lit « état — chez qui ». Côté Adventum tranchent l'**organisateur** (demandeur de
  l'opération ou celui qui a invité), la **Direction Marketing** et le **Super Admin** (`estArbitre`). Une réinvitation
  repart d'une fiche vierge (versions postérieures à l'invitation). Le fil `addMissionComment` reste ouvert jusqu'à la
  clôture et prévient l'autre partie.
- **Accord** (`deciderParticipation`) : `accordVersionId`, mission CONFIRMEE, dates et ville reprises du voyage convenu.
  L'accord se rediscute tant que l'ordre de mission n'est ni en cours ni émis. **« Demander l'ordre de mission »** part
  pré-rempli (dates, destination, transport, hébergement dans `omPrefill` ; transport repris par le formulaire RH) — circuit
  inchangé : N+1 puis RH, numérotation `NNN/DG/AAAA`.
- **OM émis** (`synchroniserOrdreEmis`) : la mission s'ouvre (notification), et ce qu'Adventum réserve part **une fois**
  dans le sujet « Billets » de l'**assistante de direction** (un sujet par demande pour toute l'équipe,
  `envoyerReservationEquipe`). L'assistante, l'organisateur, la Direction Marketing et le Super Admin déposent par membre
  le **billet émis** (`enregistrerBilletMission` : e-billet, PNR `billetReference`, n° et heures aller / retour
  `billetTrajets`) et la **confirmation d'hôtel** (`enregistrerHotelMission` : voucher, `hotelNom`, `hotelConfirmation`).
- **Imputation → budget Operations & Sales** (14/10 — « ici le budget à imputer, ce n'est pas Ad & Pro, c'est
  Operations & Sales ») : les frais de l'équipe INTERNE (transport, hébergement, OM, frais de mission) vont à l'enveloppe
  Operations & Sales de l'année de la mission (`enveloppeDuPolePour`, ouverte d'office si absente), jamais à une ligne
  Ad & Pro (qui porte les invités externes). Catégorie par défaut posée dès l'invitation (`assurerImputationEquipe`,
  `budgetChoisiParId` nul = « par défaut ») ; la Direction Marketing, la Direction des opérations ou le Super Admin la
  change (`choisirBudgetMission` refuse une catégorie hors Operations & Sales et la masse salariale ; valeur vide = retour
  au défaut). Options : `imputationsProposees` (`missions-equipe/imputation-serveur.ts`), règles pures
  `missions-equipe/imputation.ts`. Une ancienne imputation Ad & Pro reste affichée telle quelle (« ancienne imputation
  Ad & Pro »), jamais réécrite. **Ce que le budget compte** : la ligne de clôture (consommé, ligne budgétaire) et la
  **note de frais de mission** (`fraisMissionConsumption`, lue dans `getBudgetOverview` / `getEnvelopesGrandTotal`,
  catégories d'enveloppe `OPERATIONS` seulement) — engagée en route (N+1, RH), consommée une fois validée par les RH,
  ligne « Mission » non modifiable dans Dépenses. Ad & Pro n'en compte rien.
- **Après la mission** : dépenses en lignes (`MissionExpenseLine` : date, nature taxi / repas / hôtel / billet / autre,
  détail, montant, devise, équivalent DZD, justificatif) — à l'international **en USD sauf le billet**, au taux figé
  `usdDzdRate` de la demande (240 par défaut, helpers de `care-fiches.ts`) ; **rapport** (déroulé, médecins rencontrés,
  retombées, suites). **Clôturer** (`cloturerMission` : OM émis, jour du retour atteint, rapport, chaque justificatif) crée
  UNE demande RH `EXPENSE_REPORT` (total DZD, lignes et liens des justificatifs, imputation) qui monte au **N+1**
  (`deciderOrdreMissionN1` la traite aussi ; `MARCHE_N1_MISSIONS` alimente Tâches, centre d'actions, Mon équipe) puis aux
  RH ; le rapport part à l'organisateur. Un refus du N+1 rouvre la mission. Accès (`entity-access`) : la personne, les
  organisateurs, Direction Marketing, Super Admin, assistante de direction, le N+1 et les RH des demandes liées.

### Force de vente — gamme et produits attribués

`PromoProduct.channel` (RETAIL · HOSPITAL · BOTH) et `PromotionAssignment` (KAM × produit ×
cycle, priorité P1/P2/P3) existaient déjà. Ce lot en fait un **périmètre** au lieu d'une simple
matrice de planification.

| Règle | Où | Pourquoi |
|---|---|---|
| Le personnel prime sur l'équipe | `mergePortfolio()` (pure, testée) | Un superviseur porte quelques produits en direct tout en pilotant les autres. À priorité différente, **la meilleure gagne** — on ne rétrograde jamais un produit en fusionnant. |
| Un produit `BOTH` couvre **les deux** gammes | `portfolioGammes()` (pure, testée) | Quelqu'un qui ne porte que des produits mixtes fait bien de la ville ET de l'hôpital ; ne pas déplier reviendrait à dire qu'il ne fait ni l'un ni l'autre. |
| Report du dernier cycle saisi, **signalé** | `getMyPortfolio()` → `fromPreviousCycle` | Sans report, un délégué est à vide le 1er du mois. Sans le signaler, il croit son portefeuille reconduit alors que la Direction ne l'a pas arrêté. |
| Direction et Super Admin voient tout | `selectableProducts(userId, seesAll)` | Ils arbitrent pour l'ensemble : restreindre leur choix n'aurait aucun sens. |
| Un produit retiré du catalogue disparaît | `toProducts()` | Un produit inactif ne se promeut plus — le laisser dans un portefeuille inviterait à travailler dessus. |

**Le paramétrage reste hors Ressources humaines**, à dessein : porter tel ou tel produit relève
du business et change au fil des cycles ; ce n'est pas une donnée de contrat.

Fichiers : `lib/sales-portfolio.ts` (pur + `sales-portfolio.test.ts`, 15 tests),
`lib/queries/portfolio.ts`, `components/planning/my-portfolio-card.tsx` (serveur, dans
`/mon-espace`). Paramétrage : depuis le 07/10, Force de vente › **Produits** (`/planning/produits` : matrice délégué
× produit P1/P2/P3 par cycle, « Reprendre le mois précédent » ; `/planning/affectations` y redirige) ; la gamme par
produit se règle au montage de la BU (module **Business Units**, `/business-units`, depuis le 08/10).

### Force de vente — les référents Direction Marketing d'une gamme

**LA DÉCISION.** « Chaque BU aura son ou ses référents de la direction marketing depuis la
configuration des BU, mais le directeur du département marketing recevra **également** l'accès et
la notif et pourra modifier, valider. » Le menu « Référent Direction Marketing (facultatif) » des
nouvelles demandes a disparu au lot précédent ; la désignation vit désormais **là où se configure
la gamme** (`/business-units` — module **Business Units** depuis le 08/10, ex-« ⋯ › Réglages » de la Force de vente ; montage de la BU **par étapes** depuis le 07/10 :
BU et superviseur → spécialités & produits → KAM → secteurs, `bu-etapes.tsx`), et plus dans chaque formulaire.

**CE QUE LA DÉSIGNATION FAIT — ET CE QU'ELLE NE FAIT PAS.** Elle **CIBLE** la notification : une
demande Ad & Pro de la gamme Oncologie prévient **nommément** ses référents au lieu d'arroser tout
le rôle. Elle n'**ACCORDE** rien — le pouvoir de trancher reste gouverné par le rôle de l'étape
(`WorkflowStep.actorRoles`), inchangé. Une désignation posée depuis un écran de configuration
**commerciale** qui ouvrirait un pouvoir d'**arbitrage** serait une porte de permission à côté de
la porte gardée : l'écran ne propose donc que des personnes qui **portent déjà** le rôle, et
l'action refuse les autres en nommant le remède (**Administration › Comptes**).

| Règle | Où | Pourquoi |
|---|---|---|
| Le rôle reste prévenu, les référents s'y **ajoutent** | `aPrevenirPourLaGamme()` (pure) | C'est ainsi que « le directeur du département recevra **également** » est tenu sans avoir à deviner qui est le directeur. Une gamme **sans** référent retombe exactement sur le comportement d'avant — la table se déploie vide sans priver personne. |
| Seule l'étape qui **nomme** le rôle concerne la gamme | `laGammeEstConcernee()` (pure) | Mesuré de bout en bout : la route d'un National Sales traverse la porte du DG **puis** la Direction des opérations, donc la première version dérangeait le référent **deux fois** avant l'étape qui le concerne. La règle s'arme sur le `notifyRoles` de l'étape, lu dans la définition — une étape marketing ajoutée demain prévient les référents **sans que personne y pense**. |
| **UN** référent inscrit la demande à son nom ; **PLUSIEURS** n'en inscrivent aucun | `referentUnique()` (pure) | `productManagerId` a sept lecteurs et n'avait plus **aucun** écrivain. Collapser sur le premier choisirait l'arbitre d'un budget par l'**ordre d'insertion en base**. |
| La gamme qu'on **écrit** est celle dont on prend le référent | `createSponsoring`, `createCongressRequest`, `submitEventForApproval` | Défaut mesuré : la soumission d'un événement lisait la gamme dans le **formulaire**, que son seul écran n'envoie pas — **aucun** événement ne recevait jamais son référent. Et le sponsoring écrivait la gamme **déduite** du demandeur tout en cherchant le référent sur le formulaire : l'arbitre de la gamme A sur une demande déposée sous la gamme B. |
| Le rôle est **relu** à chaque affichage | `/planning/business-units` + `referentAInscrire()` | Une désignation n'est pas une permission qui survit à son motif : muté, le référent reste **prévenu** (c'est une notification, pas un pouvoir) et cesse d'être **inscriptible**. L'écran le DIT par ligne — « ne porte plus le rôle ». |
| Le rôle qui tranche est **`PRODUCT_MANAGER` seul** | `porteLeRoleQuiTranche()` (socle) | L'étape décisive ne nomme que celui-là — mesuré dans `workflow/defaults.ts`, et un cas du banc tient cette prémisse. `MEDICAL_PROMOTION_MANAGER` configure les référents mais ne peut pas en être un : l'inscrire ferait une attente sans pouvoir. Le geste, si la Direction élargit l'étape, est d'ajouter le rôle à ses `actorRoles` **et** ici. |
| Le montage d'une BU compte **six** étapes | `sfe-setup.ts` (`REFERENTS`) | Une BU avec un référent qui **ne porte pas** le rôle ne franchit pas l'étape : elle a l'air montée, et la personne désignée est prévenue sans rien pouvoir trancher. |

**Où.** `lib/personnes/referents-gamme.ts` (**socle**, pur — quatre couches en ont besoin sans
avoir le droit de se parler : l'écran, les trois actions de création, le moteur de circuit et les
ops d'Adam ; écrit d'abord sous `lib/ad-pro/`, il y créait un **cycle** `adpro ↔ tasks`),
`lib/ad-pro/referent-de-la-gamme.ts` (la lecture en base), `workflow/engine.ts`
(`prevenirEtapeAtteinte` — **un seul** point de notification pour les trois endroits où une étape
est atteinte), `actions/sales-planning-actions.ts` (`addBuMarketingReferent` /
`removeBuMarketingReferent`, idempotentes), `planning/business-units/bu-manager.tsx` (section 5).
**En conversation** : `add_marketing_referent` / `remove_marketing_referent`, dont la carte DIT que
le geste cible la notification et n'accorde aucun droit.

### Prise en charge — personnes, besoins et devis

Les participants étaient un **tableau JSON** (`beneficiaries`) : impossible d'y porter un avis,
une décision individuelle, ou la liste de ce qu'il faut fournir et acheter pour chacun. Trois
tables les remplacent — `CareBeneficiary`, `CareCell`, `CareQuote` — pour le **national** et
l'**international**.

**Le routage que décrit le métier existait déjà** : `adProOriginRank` saute toute étape située au
niveau ou en dessous du rang du demandeur (délégué → National Sales → Direction Marketing →
Direction). Ce lot ajoute ce qui manquait vraiment : **l'examen personne par personne**.

| Règle | Où | Pourquoi |
|---|---|---|
| Identité : annuaire **ou** profil libre | `beneficiaryName()` (pure, testée) | On ne crée pas une fiche médecin permanente pour un intervenant vu une seule fois. Ne rend jamais de nom vide — une ligne sans nom serait introuvable. |
| **Décision par personne** | `decideCareBeneficiary` | « Chaque personne sera traitée différemment » : on en accorde une et on en écarte une autre sans refuser toute la demande. |
| Une **pièce d'identité créée d'office** à l'accord | `defaultCells()` | Le point de départ du dossier. Volontairement seule : pré-remplir dix cases qu'il faudra effacer coûte plus cher que d'ajouter les deux qui servent. Passeport à l'international, pièce d'identité au national — un passeport pour Alger n'a pas de sens. |
| Les besoins appartiennent à la **ligne**, pas à une colonne | `CareCell.beneficiaryId` | L'une a besoin d'un visa et pas l'autre. Le « + » ajoute un besoin **à cette personne-là**. |
| « Sans objet » ≠ suppression | `CareCellStatus.WAIVED` | Garde la trace qu'on a bien regardé le visa et qu'il n'en fallait pas. Une case supprimée laisserait croire qu'on n'y a jamais pensé. |
| Un devis couvre **ce qu'il couvre** | `CareQuoteCell` (n-n) | Une agence chiffre le groupe entier ; on ne lui demande pas de découper en dix lignes. Accepté ou refusé **d'un bloc** — accepter la moitié d'un devis n'a pas de sens commercial. |
| **Jamais deux devis sur la même case** | `quoteConflicts()` (pure, testée) | C'est le garde-fou central : payer deux fois le même hôtel ne se verrait qu'à la facture. Refuser d'abord l'autre devis. |
| Finances refusées tant qu'il manque quelque chose | `financeReadiness()` (pure, testée) | Trois blocages nommés : aucune personne accordée, un devis encore en attente, une personne accordée au dossier incomplet. Chacun dit **qui** et **quoi**. |

**Gardes en base**, parce qu'un code correct ne suffit pas : `CareBeneficiary_one_parent` et
`CareQuote_one_parent` (exactement un parent — une personne sans parent serait invisible partout
tout en existant), `CareCell_service_kind` (une case SERVICE porte une nature, une case DOCUMENT
n'en porte pas). Les quatre sont vérifiées à l'application de la migration.

Fichiers : `lib/care.ts` (`beneficiaryName`, `careProgress`, `quoteConflicts`, `financeReadiness`
+ `care.test.ts`, 24 tests), `lib/actions/care-actions.ts`, `lib/queries/care.ts`,
`components/care/care-panel.tsx`. Migration `20260806160000_care_beneficiaries` — reprend le JSON
existant en lignes **sans l'effacer** : en cas de doute sur la reprise, la source reste lisible.

#### Fiches voyageur (Direction, 10/2026)

La création ne porte plus que l'**événement** (ville et pays séparés ; au national, pays = Algérie
s'il n'est pas dit), l'origine (« Initiative du médecin » → médecin(s) d'origine dans
`initiativeDoctorIds`, **pas** une prise en charge ; lus par « Médecins concernés » en
`ORIGINE_DEMANDE`) et le **mode** (`careMode` : `INDIVIDUAL` | `GROUP`, corrigeable par la liste
blanche `EDITABLE_FIELDS`). On atterrit sur `#professionnels` ; chaque professionnel ajouté
(annuaire, nouveau profil, profil libre) **naît avec sa billetterie et son hôtellerie**.

| Règle | Où | Pourquoi |
|---|---|---|
| Un poste = une `CareCell` SERVICE ; le 1er billet / le 1er hôtel est le **principal** | `billetPrincipal`, `hotelPrincipal` | Un « + » par catégorie (billetterie, hôtellerie, transport, déjeuner, dîner, accès, autre) — autant de fois qu'il le faut. |
| « Sans billet / sans hôtel » | case principale `WAIVED` | La trace qu'on a regardé. |
| Billet et hôtel lus par les règles du **sponsoring** | `lirePosteSaisi` → `lireVoyageur` / `lireHebergement`, `manquesPourReserver` | Une seule règle de trajet, d'étapes et de dates. Passeport exigé à l'international ; pièce d'identité facultative au national. |
| **Dollar** à l'international sauf la billetterie | `deviseDuPoste`, `versDzd`, `usdDzdRate` (240, `TAUX_USD_DZD_DEFAUT`, figé à la création) | `amount` + `currency` gardent la saisie ; `amountDzd` nourrit totaux, enveloppe, ordre de dépense. Un devis mêlant billets et autres postes se refuse (`deviseDuDevis`). |
| Estimé = devis qui comptent + montants saisis + postes de groupe | `estimations` (pure, testée) | Un devis accepté ou **retenu** compte en entier, partagé entre les cases qu'il couvre ; indépendant du mode. |
| Mode **de groupe** | `casesDeLaCategorie`, `CareGroupPoste` (`montantPosteGroupe`) | Un devis par catégorie couvre tout le monde ; « repas 100 par personne » × personnes vivantes, exclusions une à une. |
| Dépassement de l'enveloppe | `depassementEnveloppe` | Dit, jamais bloquant. |
| Retenir puis BC, réservation | `retenirDevisPriseEnCharge`, `demanderBCPriseEnCharge`, `demanderReservationPriseEnCharge` | Même circuit que le sponsoring : un **sujet** pour l'assistante de direction (`careReservationDossierId`), fiches prêtes nommées, manques dits ; l'acceptation par la Direction émet l'ordre de dépense (DZD). |
| Billet émis / confirmation d'hôtel | `enregistrerBilletEmis`, page `…/[id]/billets` | E-billet ou voucher (`issuedDocumentId`), `bookingRef`, détail par trajet `legDetails` [{numero, heureDepart, heureArrivee, reference}] aligné sur `etapesDuBillet` ; autres postes : `timeStart` + `address`. Assistante de direction, demandeur, Direction Marketing, Super Admin (`peutTeleverserBillet`). Lu par le livret de séjour. |
| **Livret de séjour** (PDF A5, charte Adventum) | `lib/livret/modele.ts` (pur, testé), `rendu-pdf.ts` (pdfkit), `serveur.ts` ; `POST /api/prises-en-charge/livret` ; `BoutonLivret` | **Individuel** (fiche voyageur, « Livret ») : couverture, lettre sur papier à en-tête, voyage, hébergement + repas + accès, planning jour par jour trié, contacts, à emporter. **Général** (« Livret général » sur la demande et sur `…/billets`) : délégation et vols, chambres + repas du groupe, programme commun, équipe Adventum (missions confirmées, dates convenues, billet), dos. Absent → « à confirmer » ; aucun montant, devis ni passeport (`versPoste` ne recopie que ce qu'il imprime). Rangé en `Document` SUPPORTING_DOC, `stepKey` `livret:general` / `livret:<personne>`, même nom → nouvelle version ; la page de mission d'un membre lie le dernier livret général. Générer : `peutTeleverserBillet`. |
| Pièces lisibles par qui réserve et qui accompagne | `peutLirePieceDePriseEnCharge` (`ad-pro/passeport-acces.ts`) + `care-pieces-acces.ts` (pur) | `/api/documents/[id]` : passeports → membres du sujet de réservation ; billets émis, vouchers, livrets → sujet ou `peutTeleverserBillet` ; livret général → aussi l'équipe (mission non déclinée). Le reste reste derrière la porte de la demande. |
| Support promotionnel d'un poste | ⋯ d'un « autre poste » → `linkCareCellPromoMaterial` (options `carePromoOptions`) | Le circuit du matériel garde sa vérité ; le poste en montre la référence et l'état. |

Fichiers : `lib/care-fiches.ts` (+ `care-fiches.test.ts`), `components/care/{care-panel,fiche-voyageur,billets-emis-panel,page-billets-emis}.tsx`.
Migration `20270119090000_fiches_voyageur_prise_en_charge` (idempotente ; taux 240 posé sur les
internationales existantes, rien d'autre de deviné).

### Ad & Pro — postes, validation par poste et chaîne jusqu'au paiement

`SponsoringRequest` ne portait qu'un montant (`amountRequested` → `amountProposed` →
`amountGranted`) ; `CongressNational`, un `finalAmount` et deux booléens (`hasBooth`,
`hasSymposium`) qui annonçaient un stand ou un symposium sans jamais les chiffrer. Ces opérations
couvrent pourtant plusieurs choses, payées à plusieurs personnes. `AdProItem` décrit ces
**postes** — pour les **quatre** opérations du pôle : sponsoring, prises en charge **nationales**
et **internationales**, **événements**.

**Un sponsoring NAÎT avec son poste (27/09/2026).** « Sponsoring direct (association) » ou « Sponsoring
indirect (prise en charge) » selon la nature choisie à la création, chiffré au montant suggéré par le
délégué ; la tenue pré-validée, ses postes ne sont PAS « tardifs » (les ajouter EST l'étape) ; la validation
finale exige chaque poste décidé et chaque poste accordé rangé dans un budget, puis écrit leur somme comme
montant accordé et fige les postes. Détail : [Sponsoring — la tenue d'abord](#sponsoring--la-tenue-dabord-largent-à-la-fin-27092026).

**Une table pour les quatre modules**, avec **quatre clés étrangères nullables** plutôt qu'un
couple (type, id) : une colonne polymorphe ne peut pas porter de contrainte, donc supprimer un
congrès laisserait ses postes orphelins. Ici la cascade est garantie par la base, et une
contrainte `AdProItem_one_parent` impose qu'exactement un parent soit renseigné.

**Treize natures de poste, et quatre nommées par la Direction** (`ITEM_KIND_LABELS`,
`lib/ad-pro-items.ts`) : **sponsoring association**, **prise en charge de la billetterie**,
**prise en charge de l'hôtellerie**, **prise en charge des dîners**, aux côtés du stand, du
symposium, du matériel promotionnel, de la location de salle, du traiteur, du consulting, de la
prestation, du déplacement et d'« autre ». Deux distinctions sont **portées par le code, pas par
l'usage** : `ACCOMMODATION` (l'hôtellerie) quitte `TRAVEL`, dont le libellé disait
« Déplacement / hébergement » alors que la nature ne sait pas se scinder — une prose qui promet un
partage que le code n'a pas ; et `DINNER` (les dîners d'un congrès, facturés au restaurant) n'est
pas `CATERING` (le traiteur d'un stand), parce que ce sont deux fournisseurs et donc deux bons de
commande. Une nature ajoutée entre dans l'ordre d'affichage **et** dans les valeurs d'énumération
que la fiche d'action d'Adam déclare, sans qu'on touche à rien : la dérivation les lit à la source.

**Chaque poste se valide INDÉPENDAMMENT** (doctrine révisée — auparavant un poste n'était qu'une
ventilation sans circuit propre). Consulting, traiteur, location de salle ne se décident pas
ensemble : « la Direction » au sens de l'écran — la vue globale, ou le droit « Valider » du module (par défaut la
Direction, le Directeur Général et la Direction Marketing) — **accorde**, **refuse**, ou **demande à revoir le budget** — autant de
fois qu'il le faut. Chaque tour est conservé (`AdProItemDecision`) : un poste accordé au 3ᵉ tour
garde la trace des deux refus qui l'ont précédé.

**La chaîne complète, du besoin au paiement** — c'est ce qui relie les modules entre eux :

```
Ajout du poste (nature, montant estimé, INCLUS dans le budget accordé ou RALLONGE)
   → (option) demande de DEVIS ouverte au Bureau du secrétariat (AdministrativeRequest type QUOTE)
        → les devis déposés sur la demande font partie du dossier du poste
   → SOUMISSION à « la Direction » (vue globale ou « Valider » du module)  →  accordé / refusé / budget à revoir
   → choix du BUDGET (catégorie d'enveloppe)
   → demande d'ÉMISSION DU BON DE COMMANDE  →  visa du centre Ad & Pro (au-dessus du seuil des BC ; en dessous,
     directement)  →  émission par les FINANCES
        → l'ordre de dépense naît avec sa catégorie budgétaire déjà renseignée
```

**Le poste porte ses PROPRES pièces jointes, et son accès vient de SON OPÉRATION.**
`canAccessEntity` rattachait tous les postes au module `SPONSORING`, écrit à la main — une
devinette, et elle était FAUSSE : mesuré, `MEDICAL_DELEGATE` et `MEDICAL_PROMOTION_MANAGER` sont
les **deux seuls rôles** qui portent `EVENTS` et `CONGRESS_NATIONAL` **sans** `SPONSORING`, donc
les auteurs typiques d'un événement ne pouvaient ni joindre une pièce ni commenter le poste de
LEUR propre demande. Un poste n'a pas de droits à lui : il DÉLÈGUE à son opération
(`parentDuPoste`, pur, exhaustif sur les cinq clés étrangères), et rend `null` sur tout ce qui ne
se lit pas à coup sûr — zéro parent, plusieurs parents, ou le parent **dormant** `trainingId`,
qui n'a aucun lecteur dans le dépôt.

**Devis, bon de commande et facture ne sont PAS le même geste — mesuré avant d'être codé.** Le
devis et la facture sont des pièces qu'on fait **établir** ou qu'on **réclame** : une demande au
bureau du secrétariat, avec sa référence, sa file, ses pièces jointes et son cycle — tout cela
existe déjà. Le bon de commande, lui, **engage de l'argent** : il porte le visa du centre Ad & Pro
(au-dessus du seuil des BC) puis l'émission d'un ordre de dépense par les Finances (`orderStage`), et en faire une quatrième
demande de secrétariat aurait créé une SECONDE vérité sur « le BC de ce poste » (§118.5). Un
seul écrivain pour les deux natures de secrétariat (`demanderPieceSecretariat`), l'enchaînement
dans un module pur (`lib/ad-pro/pieces-secretariat.ts`) : **le devis n'est pas un préalable**
(« on peut également demander un devis, pas que un BC » dit qu'on peut en demander un EN PLUS),
la **facture vient après le bon de commande** — la réclamer avant fabriquerait à la main
l'anomalie `facture_sans_bc` que le contrôle financier lève ailleurs —, et une demande déjà
ouverte de la MÊME nature ferme la sienne, la nature voisine restant ouverte.

**Le message du demandeur et la note de la Direction sont deux paroles.** « Quand on demande
l'émission d'un BC, on écrit un message avec les différents contenus, les références » : ce
message vivait dans `orderNote`, que le visa **écrasait** — et la colonne avait, mesuré, **trois
écrivains et aucun lecteur**, donc rien ne signalait la perte (§118.45). `orderDecisionNote`
porte désormais le visa ou le refus, et les deux sont AFFICHÉES sur la carte du poste.
**L'assistante de direction est prévenue de la demande d'émission** — c'est elle qui établit la
pièce ; elle n'était prévenue de rien. On ajoute un destinataire, on ne retire aucune garde : le
visa du centre Ad & Pro reste ce qui engage.

**Le rattachement se fait par le lien CANONIQUE** (`linkedEntityType` / `linkedEntityId`), celui
que `/demandes/[id]` lit déjà pour savoir qu'une dépense vient d'Ad & Pro et ne doit **pas** être
imputée une seconde fois au budget d'un département. Les demandes de devis de poste ne le
posaient pas — double comptage possible, sans la moindre erreur visible — et la liste de cet
écran, écrite à la main, oubliait `CONSULTING_CONTRACT`, `AD_PRO_OTHER` et `AD_PRO_ITEM` : elle
se dérive maintenant du registre canonique (§118.73). **Le même geste existe en conversation**
(`adpro_operation/request_item_quote`, les deux natures).

| Règle | Où | Pourquoi |
|---|---|---|
| Un poste **inclus** ventile l'enveloppe ; un poste **supplémentaire** est une rallonge | `breakdown()` (pure, testée) | Une rallonge assumée n'est pas un dépassement subi : les mêler ferait prendre une décision pour l'autre. La question est posée **à l'ajout**. |
| Un poste **refusé** ne pèse plus sur rien | `breakdown()` | Garder son montant ferait porter à l'opération le poids d'une dépense que la Direction a précisément écartée. |
| **Un ordre de dépense par poste** | `emitItemExpenseOrder` | Le stand se paie à l'organisateur, le matériel à l'agence : trois bénéficiaires, trois pièces. Un ordre global obligerait les Finances à répartir à la main. |
| Le BC s'émet **après** le visa du centre Ad & Pro (ou directement sous le seuil des BC) | `orderStage` + `canRequestPurchaseOrder` (pure, testée) | Deux responsabilités distinctes : le centre engage, les Finances paient. |
| Ajout après décision **autorisé et tracé** | `addedAfterDecision` | Cas réel : on découvre qu'il faut un stand. On ne bloque pas — mais l'écran affiche le dépassement. |
| Le matériel promo **n'est pas recopié** | `promoMaterialId` | Il a un circuit non négociable (visa publicitaire, conformité, agence, BAT). Le poste y renvoie. |
| Ce qui est **annoncé** doit être **chiffré** | `plannedGaps()` (pure, testée) | Un congrès déclare `hasBooth`/`hasSymposium` : l'écart se voit avant la facture. |

**Garde-fous financiers** (purs et testés) : `canSubmitItem` (on ne soumet pas un poste sans
chiffre), `canRequestPurchaseOrder` (accordé + chiffré + budget choisi, une seule fois — un refus
rouvre le droit), `canEmitOrder` (jamais un poste non accordé, jamais deux fois). Un montant déjà
couvert par un ordre ne peut plus changer, un poste payé ne peut plus être retiré.

Les différences réelles entre modules — où lit-on l'enveloppe, quel statut vaut « accordé »,
quelle permission, quel chemin revalider — sont rassemblées dans la table `PARENTS` des actions :
**un seul endroit** à compléter pour un module de plus. Le chargement des postes (libellés du
matériel, de l'ordre, du budget, de la demande de devis — résolus **en lot**) est mutualisé dans
`queries/ad-pro-items.ts` : les quatre écrans lisent la même vérité.

Fichiers : `lib/ad-pro-items.ts` (`breakdown`, `canEmitOrder`, `plannedGaps` +
`ad-pro-items.test.ts`, 19 tests), `lib/actions/ad-pro-item-actions.ts`,
`components/ad-pro/items-panel.tsx` (branché sur `/sponsoring/[id]` et, par un emplacement
optionnel de `CongressDetailView`, sur `/congress-national/[id]` — l'international ne change pas).
Migrations `20260806120000_sponsoring_items` puis `20260806140000_ad_pro_items`.

### Mobile — superposition, défilement et hauteurs

Trois défauts indépendants, un même symptôme (« les modules se superposent »).

1. **Échelle de superposition** — la barre d'onglets était à `z-60`, au-dessus des feuilles et
   tiroirs (`z-50`). L'échelle est désormais écrite dans `globals.css` : en-tête 30, barre
   d'onglets **40**, modales **50**, tiroir « Tout » 60, courrier 90, palette 100, pop-up 200.
   Toute nouvelle couche modale se place à 50 et ne descend jamais en dessous.
2. **Verrou de défilement** — `lib/use-scroll-lock.ts`. Le code figeait `document.body` ; or la
   coque est `h-screen overflow-hidden` et le conteneur défilant est le `<main>` (`id="app-scroll"`).
   Le verrou était donc **sans effet**. Il est maintenant **compté** (une feuille ouverte depuis un
   tiroir ne rend pas le défilement au tiroir en se refermant) et branché sur les six couches
   modales. Pas de `position: fixed` sur le body : cette astuce fait sauter la page en haut à la
   fermeture.
3. **Hauteurs mesurées** — `components/layout/chrome-metrics.tsx` publie `--app-chrome-top`
   (bandeaux + en-tête) et `--app-chrome-bottom` (barre d'onglets) par `ResizeObserver`. Les
   utilitaires `.app-viewport` / `.app-viewport-flush` s'en servent. Mesurées et non écrites, pour
   deux raisons qu'une constante ne couvre pas : les bandeaux **passent à la ligne** sur un écran
   étroit, et la barre d'onglets est `display: none` sur ordinateur — mesurée, elle vaut alors 0,
   sans règle média supplémentaire à maintenir. Écrans concernés : assistant, messagerie, éditeur
   Office.

### Analyseur CTD — réserves ANPP, corpus et coût

Trois manques structurels de l'analyseur : il ne se souvenait pas de ce que l'agence nous avait
déjà reproché, il ne savait pas sur quels textes il s'appuyait, et personne ne voyait ce qu'il
coûtait. Voici comment chacun est traité — et surtout **où sont les limites**.

#### 1. Bibliothèque des réserves ANPP — la mémoire du service

Écran `/regulatory/enregistrement/reserves` (permission `regulatory.reserve.manage`).

| Étape | Fichier | Règle exacte |
|---|---|---|
| Import d'une lettre | `reserves/library-ingest.ts` → `ingestReserveDocument` | Texte natif → OCR → **vision** (pages rastérisées). Dédoublonnage sur `sha256` : réimporter la même lettre ne coûte rien. |
| Extraction des points | `reserves/library-extract.ts` | Schéma JSON **strict**. Une réserve **sans verbatim est jetée** — sans la citation exacte, on ne pourrait rien opposer. En vision, la consigne dit explicitement que **l'image fait foi**, pas l'OCR. |
| Recherche de précédents | `reserves/library.ts` → `findSimilarReserves` | `GREATEST(ts_rank français, similarité trigrammes)`, seuil 0,02. Filtres DCI / fournisseur / section CTD. |
| Réponse qui a marché | `bestHistoricalResponse` | Renvoie l'acceptée **et** les réitérées : savoir ce qui a échoué vaut autant que savoir ce qui a réussi. |
| Score de risque | `reserveRisk` | Explicable : `reasons[]` dit *pourquoi*. Ce n'est **pas** une prédiction de la décision de l'ANPP, et l'écran l'écrit. |

**La frontière entre apprendre et décider.** `proposeRules` repère un reproche revenu ≥ 3 fois et
propose une règle au statut `PROPOSED`. Elle est **inerte** : seule `validateDerivedRule` (humain
autorisé, audité) la fait passer à `VALIDATED`, et `activeDerivedRules` ne renvoie que celles-là.
`ruleConfidence` **sature à 0,9** — une observation, si répétée soit-elle, ne devient jamais une
règle de droit.

#### 2. Constats défendables

Champs ajoutés à `RegulatoryFinding` : `ruleRef`, `confidence`, `page`, `excerpt`,
`conflictingValues[]`, `recommendation`, `similarReserveIds[]`, `reserveRisk`.

- `findings/enrich.ts` → `enrichVersionFindings` est appelé **après** la persistance des constats
  (jobs `RULES` et `AI_REVIEW`), **hors transaction** et sans jamais lever : un échec
  d'enrichissement laisse l'analyse complète, il ne la perd pas.
- `findingQuality` (pure, testée) note un constat sur 6 éléments et dit `defensible` uniquement si
  on peut **montrer la pièce** (règle + document + page + extrait). L'écran affiche ce qui manque :
  découvrir qu'un constat n'était pas étayé doit se faire ici, pas en séance.
- ⚠️ Un précédent ANPP est attaché **comme précédent**. Il n'aggrave jamais automatiquement la
  sévérité et ne crée aucun blocage.

#### 3. Corpus réglementaire et veille ANPP

Écran `/regulatory/enregistrement/corpus` (`regulatory.corpus.view` / `.manage`).

- `corpus/catalog.ts` — 43 sources, chacune marquée `ingestible` (faux = sous licence) et `binding`
  (faux = projet non opposable). `FIRST_WAVE` = les 10 qui suffisent à analyser un dossier algérien.
- `corpus/fetch-source.ts` — PDF direct, DOCX, ou page HTML dont on **suit le lien « Télécharger »**
  (sinon on indexerait un menu de site au lieu d'une ligne directrice). Rejette un contenu < 500
  caractères. Fonctions pures testées : `findPdfLink`, `extOf`, `htmlToText`.
- `corpus/ingest-catalog.ts` — l'**empreinte décide** : contenu identique ⇒ rien n'est créé. Sinon
  une nouvelle version **au statut `DRAFT`**, pointant vers celle qu'elle remplace. Rien ne devient
  opposable sans activation humaine.
- `corpus/watch-schedule.ts` → `runAnppWatchIfDue` — relevé **quotidien** des pages de publication
  ANPP, branché sur `runScheduledJobs`. Idempotent sans nouvelle table (le dernier passage se lit
  dans le journal d'audit `CORPUS_WATCHED`). En cas de changement, **notification** aux détenteurs
  de `regulatory.corpus.manage`. La veille **signale**, elle n'ingère rien : décider qu'un texte
  fait foi reste un acte humain. Désactivable par `REG_ANPP_WATCH=0`.
- ⚠️ **Licences** : la Ph. Eur. de l'EDQM et les ouvrages sous droits sont *référencés*, jamais
  téléchargés ni stockés. La vérification est faite **deux fois** (catalogue + ingestion) : c'est
  une limite juridique, pas une préférence.

#### 4. Coût — voir, réutiliser, plafonner

`cost/ledger.ts`, restitué dans la carte « Coût de l'analyse IA » de l'écran dossier.

1. **Voir** : chaque appel est tracé au **dossier**, à l'**étape** et au **fichier**. Un total
   global ne se corrige pas ; une étape ou un fichier, si.
2. **Ne pas repayer** : `cacheKeyOf` = SHA-256 de (étape + modèle + consigne + contenu + schéma +
   empreinte des images). Un fichier inchangé entre la V1 et la V2 d'un dossier est **relu, pas
   racheté**.
3. **S'arrêter** : `budgetState` refuse l'appel **avant** de dépenser quand le plafond du dossier
   (ou `CTD_BUDGET_USD_DEFAULT`) est atteint — et l'écran le dit, plutôt que de laisser filer la
   facture en silence.

**Analyse différée (moitié prix)** — `cost/batch-runner.ts`. Le fournisseur facture deux fois moins
cher ce qu'on accepte d'attendre (≤ 24 h). Sans intérêt pour une analyse qu'on regarde tout de
suite ; décisif pour une **réanalyse complète**. Le choix reste explicite à l'écran, avec le prix
et le délai. Trois garde-fous : le budget est vérifié **avant** dépôt (estimation, refus motivé) ;
`processedAt` garantit qu'un lot n'est traité **qu'une fois** ; les constats restent des **PROJETS**
non bloquants — différer une analyse ne lui donne pas plus d'autorité. Le prompt, la consigne et la
validation sont **les mêmes fonctions** que la voie immédiate (`buildPrompt`, `SYSTEM_PROMPT`,
`parseReviewOutput`) : sans cela, « moitié prix » finirait par vouloir dire « moins bien ».

#### 5. Couverture INTÉGRALE, documents géants, examen visuel

Quatre plafonds silencieux ont été supprimés — silencieux au sens propre : ils écartaient du
contenu **sans que rien ne distingue « analysé » de « analysé à 8 % »**. Un dossier réglementaire
à moitié lu qui a l'air complet est pire qu'un dossier non analysé : on s'y fie.

| Ancien plafond | Aujourd'hui | Ce qui le rendait nécessaire |
|---|---|---|
| `REG_AI_MAX_CHUNKS` = 120 parts (~1 200 pages) | **0 = intégral** | Rien : c'était un garde-fou de coût aveugle. Le coût est désormais tenu par le **plafond budgétaire du dossier**, qui refuse l'appel avant la dépense et le dit. |
| `REG_OCR_MAX_PAGES` = 25 pages | **0 = illimité** | La rastérisation gardait **toutes** les pages en mémoire. Elle est maintenant **en flux** (`rasterizePdfStream`) : une page vit à la fois. |
| Vision = 60 pages | **0 = tout le document** | Même cause, même correction. |
| `REG_MAX_PROCESS_MB` = 1 Go (bridé à 4) | **8 Go par défaut, réglable à 200** | Idem — ne reste que la taille du fichier lui-même, que mupdf ouvre d'un bloc. |

- **`rasterizePdfStream`** est la pièce maîtresse : chaque page est rendue, remise à l'appelant,
  puis **relâchée**. La mémoire ne dépend plus du nombre de pages mais de la plus grande d'entre
  elles. `onPage` est attendu avant de rendre la suivante — sans ce `await`, la file d'attente
  reconstituerait exactement le tas qu'on vient de supprimer.
- **Toute troncature restante se DIT** : plafond budgétaire atteint, lot refusé, page corrompue —
  chacun apparaît en clair dans le journal (« ⚠ ANALYSE INCOMPLÈTE … le reste n'a PAS été lu »).
- ⚠️ **Limite réelle restante** : un fichier UNIQUE doit tenir en mémoire pour être ouvert. Un
  *dossier* de plusieurs dizaines de Go passe sans difficulté (les fichiers sont traités un par
  un) ; un *fichier* de 10 Go dépend de la RAM de l'instance. C'est la machine qui décide, plus un
  réglage — et quand elle ne suffit pas, le message dit la taille, le seuil et quoi faire.

**Job `VISION` — ce que le texte ne dira jamais.** Le module de lecture des figures existait mais
n'était **appelé par personne** (référencé uniquement par son propre test). Il est branché, et
porte désormais **deux** questions posées à la même image dans le même appel — rastériser et
transmettre les pages est le vrai coût, y ajouter une seconde question est quasi gratuit :

1. **les figures** — courbes de stabilité, chromatogrammes, profils de dissolution, schémas de
   procédé. Les `concerns` deviennent des constats sourcés (page + valeurs lues) ;
2. **la FORME de la pièce** — `CAPTURE_ECRAN`, `PHOTO_ECRAN`, `PHOTO_DOCUMENT`, `SCAN_ILLISIBLE`,
   `PAGE_TRONQUEE`, `PAGE_DE_TRAVERS`, `FILIGRANE_BROUILLON`, `SIGNATURE_ABSENTE`, `TAMPON_ABSENT`,
   `MENTION_ILLISIBLE`. **Aucun de ces défauts n'existe dans le texte** : l'OCR d'une capture
   d'écran rend un texte parfaitement propre. Capture d'écran, photo d'écran et filigrane
   « brouillon » sont `CRITICAL` — ils ne se corrigent pas par une explication, il faut la pièce
   authentique. Un défaut **sans constat visuel est écarté** (« c'est une capture d'écran » sans
   dire à quoi on le voit ferait recaler une pièce valable sur une intuition).

#### 6. Coût réel — l'écart qui a été corrigé

⚠️ La revue de fond/forme passait par `askClaudeCheap`, qui **n'écrit rien** dans
`RegulatoryAiCall`. Deux conséquences invisibles depuis l'écran : la carte « Coût de l'analyse IA »
montrait tout **sauf** l'analyse, et le plafond par dossier — qui s'appuie sur cette même table —
**ne plafonnait rien**. On pouvait croire un budget tenu alors qu'il était dépassé d'un ordre de
grandeur.

`agents/review-ai.ts` → `lunaReviewFn` route désormais chaque part par `trackedLuna` : **cache**
(une part inchangée d'une version à l'autre est relue, pas rachetée), **plafond** (refus AVANT la
dépense, et l'analyse s'arrête au lieu de creuser un trou silencieux) et **traçabilité** au fichier
près. Repli sur Claude si la clé OpenAI manque — un filet, pas un choix de qualité.

**Analyse IMMÉDIATE par défaut.** Le différé (Batch) coûte deux fois moins cher mais fait attendre
les constats jusqu'à 24 h — et pendant ce temps l'écran montre un dossier « en revue » amputé de sa
partie la plus exigeante. Découvrir après coup qu'on a lu une analyse incomplète coûte bien plus
cher que l'écart de prix : **on paie plein tarif et on voit tout de suite**. Le différé reste
disponible **sur demande** (bouton « Réanalyser à moitié prix » de l'écran dossier) et redevient le
défaut avec `REG_AI_BATCH=1`, pour une réanalyse massive lancée le soir. Quand il est utilisé, la
voie Batch couvre la version **entière** : le fournisseur borne un lot à 400 requêtes — contrainte
de transport, pas raison de lire un dossier à moitié — on dépose donc **autant de lots que
nécessaire**, chacun suivi séparément, chacun avec **sa propre** table de correspondance (deux lots
partageant la même créeraient les constats en double).

Ordres de grandeur, part ≈ 10 pages ≈ 7 000 jetons d'entrée :

| Dossier | Parts | **Immédiat (défaut)** | Batch (sur demande) |
|---|---|---|---|
| 1 200 pages | 120 | **~0,35 $** | ~0,17 $ |
| 15 000 pages | 1 500 | **~4,30 $** | ~2,15 $ |

#### 7. Référentiels cités

La consigne d'analyse confronte le document à trois corpus, et demande de **citer** celui qui
fonde chaque constat (`ruleRef`) : **Algérie** (exigences ANPP, module 1 algérien, langue,
légalisation, CPP, GMP, notice FR/AR — **prioritaire en cas de divergence**), **ICH** (M4/M4Q/M4S/M4E,
Q1A(R2), Q2(R2), Q3A/B/C/D, Q6A, Q8/Q9/Q10, Q11, M9, E6) et **UE** (2001/83/CE annexe I, lignes
directrices EMA, Ph. Eur. — citée, jamais recopiée). La **zone climatique II** est explicitement
demandée : des données de stabilité produites en zone I ne suffisent pas à justifier la durée de
conservation revendiquée.

#### 8. Modèle et environnement

`lib/openai-luna.ts` — `gpt-5.6-luna` (multimodal texte + image, sorties JSON strictes, Batch ×0,5).
Variables : `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CTD_MODEL_CHEAP`, `CTD_BUDGET_USD_DEFAULT`,
`REG_ANPP_WATCH`, `REG_AI_BATCH`, `REG_AI_MAX_CHUNKS`, `REG_OCR_MAX_PAGES`, `REG_MAX_PROCESS_MB`,
`REG_VISION`.

⚠️ **Le corpus réglementaire ne peut pas être téléchargé depuis un environnement de développement**
(le proxy refuse `anpp.dz`, `database.ich.org`, `who.int`, `ema.europa.eu`). L'ingestion doit être
lancée **depuis l'application déployée**, bouton « Ingérer la 1ʳᵉ vague » de
`/regulatory/enregistrement/corpus`.

#### 9. Pages exactes, escalade, sémantique, livrables (« god mode »)

**Pages exactes + clic-vers-la-preuve.** Le texte extrait n'est plus un ruban anonyme : une
**carte des pages** (`RegulatoryExtraction.pageMap` = position du début de chaque page) est
construite au moment de l'extraction (native mupdf par page **et** OCR) et jamais retaillée —
retailler décalerait toutes les positions. Chaque part d'analyse porte ses offsets réels →
intervalle de pages **exact** ; et pour chaque constat, la citation (`evidence`) est **recherchée
dans le texte** (`anchorEvidence`, insensible aux espaces/casse) : la page retrouvée **PRIME**
l'estimation du modèle, et une preuve introuvable rend `null` — jamais une page inventée. À
l'écran, la page est un **lien** qui ouvre le PDF au bon endroit (`?inline=1#page=N`). Constats
redessinés : groupés par gravité avec compteurs, liseré de couleur, badge DÉFENDABLE, citation en
exergue.

**Escalade éco → qualité** (`agents/escalate.ts`). Une section sortie en CRITIQUE du balayage
économique déclenche **automatiquement** les agents spécialistes dont le périmètre la couvre —
c'est le geste d'un vrai évaluateur : insister là où ça fait mal. Garde-fous : CRITIQUE seulement,
un agent ne repasse jamais, **4 agents max** par version (au-delà c'est une réanalyse déguisée —
décision humaine), `REG_AGENT_AUTO=0` pour couper. Ne lève jamais. Et quand une analyse différée
se termine **sans demandeur identifiable**, les rôles superviseurs (réglage
`regulatorySupervisorRoles` + SUPER_ADMIN) sont notifiés — un résultat que personne ne lit n'existe
pas. L'écran garde les deux voies explicites — « Résultats maintenant (plein tarif) » (job
`payload {mode:"immediate"}`, qui l'emporte toujours) et « Réanalyser à moitié prix (sous 24 h) » —
la voie immédiate étant désormais **celle par défaut**.

**Recherche sémantique hybride** (`corpus/semantic.ts`). Le corpus est largement en anglais, les
requêtes en français : « durée de conservation » ne matchera jamais « shelf life » en plein-texte.
Embeddings 512 dim (`lunaEmbed`, `text-embedding-3-small`) sur sections ACTIVES du corpus +
réserves ANPP, stockés en JSONB (pas de pgvector : cosinus en mémoire sur quelques milliers de
vecteurs = millisecondes), cache de processus estampillé par (nombre, dernière activation),
rattrapage borné (96/passage) par le planificateur. `searchCorpus` fusionne lexical ∪ sémantique
(`mergeHybrid` : normalisation par voie + bonus de convergence 0,15). **Jamais bloquant** : sans
clé ni vecteurs, le lexical continue seul.

**Livrables** : rapport de constats **.docx** (gravité, preuves, pages, recommandations — bouton
sur la carte Constats) et **lettre de réponse aux réserves** .docx par cycle (verbatim ANPP mot à
mot + réponse approuvée/brouillon/`[À COMPLÉTER]` — jamais d'invention), tous deux stockés
chiffrés + audités (`docgen/reports.ts`). **Verdict GO / NO-GO** en tête
de dossier : bloqueur ou critique ouvert → NO-GO ; majeur ouvert ou complétude < 100 % → GO sous
conditions ; sinon GO — avec les **réserves les plus probables** (précédents `reserveRisk` quand
ils existent, sinon la gravité, marquée `*` — jamais un pourcentage inventé présenté comme
mesuré). **Notice en arabe** (`rules/notice-arabic.ts`) : obligation algérienne (décret n° 92-286)
— un document 1.3.x (hors RCP 1.3.1) au texte natif presque sans caractères arabes → constat
MAJEUR ; l'OCR n'est **jamais** jugé (le latin massacre l'arabe, on n'accuse pas sur une lecture
ratée). **Constat → tâche** : un clic crée une tâche personnelle (« Mon espace ») portant détail,
preuve, page et lien — anti-doublon inclus.

#### 10. Entraînement de l'IA — l'école de l'analyseur (Super Admin)

Écran `/regulatory/enregistrement/entrainement`, onglet « Entraînement IA » (SUPER ADMIN
uniquement, transverse aux entités). L'analyseur apprend par **quatre canaux**, tous visibles sur
le tableau d'expertise : le **corpus** (les règles), les **réserves ANPP** historiques (les
reproches), les **règles dérivées** validées, et les **études de cas** — le canal qu'apporte ce
module : un produit PASSÉ, son dossier, son **issue réelle** (accepté / accepté avec réserves /
rejeté) et la **leçon retenue** en une phrase.

- **Déposer suffit** (mêmes gestes que le corpus) : chaque pièce est extraite, repérée par
  section CTD (déterministe, zéro coût IA), dédupliquée par empreinte **par étude de cas**.
- **Injection dans TOUTES les analyses** (immédiate ET différée) : `experienceForSection`
  sélectionne ≤ 3 précédents par section — correspondance de section d'abord, puis les issues
  **instructives** (réserves/rejet) devant, dédupliqués par empreinte — injectés dans le prompt
  comme bloc « EXPÉRIENCE INTERNE » avec l'issue et la leçon.
- ⚠️ **La frontière qui rend l'apprentissage sûr** : un précédent CALIBRE la sévérité et
  ANTICIPE les réserves probables ; il ne fonde **jamais** un `ruleRef` (consigne explicite,
  testée) — seuls les textes du corpus font règle. Pas de « fine-tuning » du modèle : la
  connaissance vit en base, citée mot à mot, retirable à tout instant — fiable et auditable.
- Vecteurs sémantiques rattrapés par le planificateur (`embedBacklog`), couverture affichée.

