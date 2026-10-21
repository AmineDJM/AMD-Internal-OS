## 📖 Référence détaillée des circuits & mécanismes transverses

> **Section de référence pour le développement** (humain ou IA) : chaque circuit est décrit avec ses **règles
> exactes telles que codées**, ses **gardes RBAC**, ses **modèles Prisma** et ses **fichiers sources**. À lire avec
> `CLAUDE.md` (règles Graphify) : cette section évite de relire le code pour comprendre un flux.

### Dimension multi-entités (sociétés du groupe)

Le groupe compte **plusieurs sociétés** (par défaut **Adventum Pharma** et **Pharmagène**, plus toute entité créée
ensuite). C'est une **dimension transverse** appliquée à tout le logiciel :

- **Modèle** : `Company` (`name` unique, `shortName`, `color`, `isActive`, `sortOrder`) — entièrement **dynamique**
  (création / renommage / couleur / désactivation dans **Administration → Entités**, `src/app/(app)/admin/entites/`).
  Chaque enregistrement clé porte un `companyId?` **nullable** — un non-rattaché est gardé par certaines listes et
  exclu par d'autres, selon le filtre qu'elles appliquent (voir les filtres ci-dessous).
- **Domaines rattachés** (`companyId` + relation `company`) — **toute la plateforme** : `RegulatoryProduct`,
  `PchTender`, `Employee`, `PromoMaterial`, `MedicalDoctor`, `FinanceTransaction`, `MedicalInfoDeclaration`,
  `StockSnapshot`, `LogisticsOrder`, `Sale`, `Department`, **`SponsoringRequest`, `CongressNational`,
  `CongressInternational`, `Event`, `BudgetEnvelope`, `ExpenseOrder`, `AdministrativeRequest`, `SupportRequest`,
  `Dossier`, `FieldReport`**. Les **stocks héritent** de l'entité de leur produit Regulatory (aucun champ à saisir).
  Les **RH n'ont pas de colonne** : congés, paie et avances pendent d'un `Employee` qui porte déjà son entité —
  dupliquer créerait deux vérités à désynchroniser.
- **Sélecteur de portée** (barre supérieure, `CompanySwitcher`) : « Toutes les entités » ou une entité précise.
  Mémorisé dans le cookie `amd-company`. ⚠️ **Le cookie est une demande, jamais une autorisation** : il est validé
  contre les droits réels (`resolveScope`) avant tout usage — y compris par l'analyse CTD (`resolveRegCompanyIdFor`,
  qui ne choisit qu'une organisation activée **parmi les entités ouvertes à la personne**) et l'écran des départements.
  Un cliquet déclare les seuls lecteurs de `getCompanyScope()` (§118.177).
- **Les filtres et leurs usages** (`src/lib/company.ts` → `src/lib/company-access.ts`, fonctions **pures testées**) :
  - `myCompanyWhere(userId)` / `companyAccessWhere` — domaines **historiquement** rattachés (Regulatory, ventes…).
    « Toutes les entités » signifie « toutes celles auxquelles j'ai droit », **jamais** toutes celles qui existent ;
    aucun droit ⇒ `{ companyId: { in: [] } }`, jamais `{}`.
  - `platformScope(userId)` / `platformScopeWhere` — domaines **récemment** rattachés (budget, Ad & Pro, finances,
    demandes). **Même règle, sans exception** : l'exception qui laissait les lignes non rattachées visibles partout a
    été levée — elle montrait le travail d'une société dans la vue d'une autre. **Appliqué seul** (listes Ad & Pro,
    budget, bureau du secrétariat `getRequestList`), il exclut une ligne sans entité de toute vue cloisonnée : seuls
    les rôles qui voient tout le groupe la lisent, en vue « Toutes les entités ». D'où l'obligation, pour tout
    écrivain de ces tables, de poser l'entité (un cliquet la tient pour les demandes au secrétariat, §118.154).
  - `companyScopedWhere(userId, base)` — la même portée **composée en `AND`**, plus les lignes sans entité, gardées
    EXPRÈS pour qu'on les rattache (Legal, Courriers, centre de paiement, comptabilité, ventes, logistique,
    recrutement, stock promotionnel…) : une ligne sans entité n'est le secret d'aucune société. Les deux filtres
    ne répondent donc pas pareil à « une ligne sans entité est-elle visible ? » : chacun porte sa raison dans son
    commentaire, et c'est l'écran qui choisit le sien.
  - `ficheScopedWhere(userId, base)` — le filtre d'une **FICHE** ouverte par son lien (notification, favori, lien
    partagé) : toutes les sociétés auxquelles la personne a **droit**, plus les lignes sans entité — et non la seule
    société choisie dans l'en-tête, qui ferait répondre « introuvable » au validateur de la société B qui travaille
    en A (§118.184). Mêmes garde-fous ; `entitePermisePourFiche` / `predicatEntitePermise` pour une ligne déjà lue.
  - Ce qui reste sans entité est listé et se rattache en masse depuis **Administration → Entités**
    (`queries/unattached.ts`). Second garde-fou : **moins de deux entités ⇒ aucun filtre**.
- **À la création** : `companyIdForNew(userId)` = la portée en cours, à défaut la société d'appartenance du créateur,
  à défaut `null` (on ne devine pas). Un **ordre de dépense** hérite de l'entité de **sa demande source**, pas de son
  demandeur, qui peut avoir changé d'entité. Un **transfert entre modules Ad & Pro conserve l'entité**.
  Chaque formulaire de création propose au besoin un menu « Entité » (`companyOptions(getCompanies())`).
  Pastille `CompanyBadge`.
- **Droit d'ÉCRITURE ≠ droit de lecture** : l'appartenance donne la lecture, l'écriture se donne explicitement
  (`UserCompanyAccess.canEdit`, réglé depuis **RH → fiche employé**). `canEditCompanyId(userId, companyId)`.
- **Actions** : `setCompanyScope`, `createCompany`, `updateCompany`, `toggleCompany` (`company-actions.ts`, réservées
  à `ADMIN:CREATE`). **Fichiers clés** : `src/lib/company.ts`, `src/lib/actions/company-actions.ts`,
  `src/components/layout/company-switcher.tsx`, `src/components/shared/company-badge.tsx`.
- ⚠ **Ne pas confondre** avec l'enum polymorphe `EntityType` (type d'objet pour Documents/Commentaires/accès) : la
  société est le modèle **`Company`** (libellé UI « Entité »).


### Centre de validation Ad & Pro — toute demande au-dessus du seuil y passe

**Un module À PART** (`/centre-ad-pro`, RBAC `AD_PRO_CENTRE` — **Direction Générale + Super
Admin**). Le siège est une décision d'organisation, pas une conséquence technique : la Direction
et la Direction Marketing **arbitrent déjà** les demandes Ad & Pro dans leur circuit, et leur
ouvrir le centre reviendrait à ce qu'elles s'autorisent elles-mêmes le dépassement qu'elles ont
proposé. Le prédicat est `siegeAuCentreAdPro`, le refus `REFUS_CENTRE_AD_PRO` — écrit **une fois**,
dit à l'identique par l'écran, l'action et l'op.

**LA MESURE DE DÉPART, ET C'EST ELLE QUI A DÉCIDÉ DU LOT.** Le pôle compte **SEPT** natures. Cinq
avaient déjà une porte au-dessus du seuil : l'étape `dg` des quatre circuits configurables
(sponsoring, congrès international, congrès national, événements) et l'étape `REVIEW_DG` du
matériel promotionnel. **Le consulting et les « autres demandes » n'en avaient AUCUNE** — rien,
dans leur machine à états, ne consultait `adProDgThreshold`, donc un engagement de 5 M DZD sortait
sans que personne en haut l'ait vu. Ces deux-là reçoivent un **VISA** (`AdProGateVisa`), et
`FORME_PORTE: Record<AdProKind, FormePorte>` fait qu'une huitième nature **ne compilera pas** tant
que personne n'aura dit quelle porte la garde. **Une exception, mesurée** : sur les quatre circuits, une demande du
rang le plus haut (Direction, DG, Directeur des Opérations, Super Admin — `adProOriginRank` = 3) entre directement
chez Direction Marketing et ne traverse pas l'étape `dg` ; la file du centre, qui lit `currentSlug = 'dg'`
(`queries/ad-pro-centre.ts`), ne la montre donc jamais. Le visa et `REVIEW_DG` ne regardent, eux, que le montant.

**TROIS ISSUES, ET LE RÉEXAMEN** (audit 360°, R07/R10, §118.188). Sur un visa, le centre **valide**,
**renvoie pour correction** (ce qu'il faut corriger est obligatoire) ou **refuse** (motif obligatoire),
par une écriture conditionnelle — deux sièges qui tranchent à la même seconde : une seule décision. Un
refus se **réexamine** par un siège, motif à l'appui (`reexaminerVisaCentreAdPro`). Un consulting ou une
« autre demande » renvoyé se **resoumet au centre** depuis sa fiche avec son **montant corrigé**
(`resoumettreAuCentreAdPro` ; la fiche et l'action lisent `peutResoumettreAuCentre`) — corrigé sous le
seuil, la porte est retirée. Un BC du registre Legal renvoyé est « à revoir » et se lève en le modifiant.
Seule une demande qui **attend encore** sa décision est montrée, tranchée, réexaminée ou resoumise
(`ATTEND_ENCORE`) ; annuler un consulting ou une « autre demande » retire sa porte en attente. **La porte suit
aussi le montant quand ces deux natures sont CORRIGÉES ou resoumises à leur décideur** (lot C4a, §118.189,
`ajusterVisaAuMontant`) : elle s'ouvre au-dessus du seuil, se met à jour ou se retire en dessous, une autorisation
se rouvre si le montant la dépasse, et une demande resoumise sous un refus du centre est annoncée au centre — pas
au décideur que ce refus bloque.

**LE CENTRE EST UNE LENTILLE, PAS UNE SECONDE AUTORISATION.** La forme du centre de paiement — une
couche d'autorisation centrale de plus — ferait valider le DG **DEUX FOIS** pour les cinq natures
qui portent déjà l'étape `dg`. Le centre montre donc les **trois** formes de porte au même endroit,
et il **décide** là où la porte est un visa ; pour une étape de circuit, il renvoie au dossier,
parce qu'une décision se prend devant ses pièces, sa catégorie budgétaire et le fil des avis
(§104.7 : jamais valider en regardant un autre enregistrement). Unifier les sept sur une seule
forme a été **mesuré et refusé** : cela orphelinerait les instances vivantes posées sur
`currentSlug = 'dg'` et perdrait l'`autoSkipMaxAmount` par circuit — une régression déguisée en
simplification (§118.86).

**LE SEUIL SE RÈGLE DEPUIS LE CENTRE**, et c'est **le même chiffre** qu'Administration › Réglages :
une seule action (`setAdProDgThreshold`), **cinq lecteurs**, les deux écrans revalidés. Cinq copies
auraient divergé au premier ajustement, et le symptôme aurait été une demande d'1,2 M arrêtée à
l'un des guichets et pas aux autres (§118.5). La **règle** vit au SOCLE (`lib/seuils/ad-pro.ts`,
zéro import) parce que `tasks` et `adpro` sont deux domaines qui n'ont pas le droit de se parler —
**c'est exactement pourquoi elle était écrite deux fois**, et `dgRequis` le PROMETTAIT dans sa
propre prose alors que son seul importeur du dépôt était son propre test (§118.14, §118.49,
§118.116). Trois lectures, chacune avec sa raison : « à partir de X » se lit **strictement**
au-dessus de X (au seuil exact, la demande est conforme à ce que la maison s'autorise sans
arbitrage) ; un **seuil nul DÉSARME** la porte ; un **montant inconnu l'OUVRE** — on ne franchit
pas un contrôle sur une absence de donnée.

**CE QUE LE VISA GARDE.** Il est **idempotent** (clé `(entityType, entityId)`) et ne **RÉOUVRE
jamais** une décision tranchée : une resoumission après refus n'efface pas la décision du centre.
Il **FIGE** le seuil qui l'a déclenché (§118.41) — sans quoi baisser le seuil rendrait la décision
passée inexplicable, le centre affichant « 2 M au-dessus de 5 M ». Un **refus exige son motif**,
c'est celui que le demandeur lira. Et le centre affiche le **nombre de lignes sans montant** à côté
du total engagé : additionner les montants connus et présenter la somme comme « total » serait une
coupe silencieuse (§118.60).

**LA CONVERSATION.** `adpro_operation/decide_gate_visa` offre les deux directions, comme
`decide_other_request` — sa voisine SENSITIVE, offerte ainsi depuis toujours. Trois faits **mesurés**
l'autorisent : le registre des capacités de mission est une liste **fermée de 62 entrées sans
aucune capacité `*_operation`**, donc aucun chemin où le moteur exécuterait ce visa sans carte ; en
conversation toute op passe par la **carte de confirmation**, que §118.126 a tranchée comme « une
action confirmée » ; et le **siège est revérifié** par l'action de l'écran. La cible se résout sur
la **liste du centre elle-même**, jamais par une seconde requête (§118.5).

**Fichiers** : `lib/seuils/ad-pro.ts` (socle) ; `lib/ad-pro/{centre,visa}.ts` ;
`lib/queries/ad-pro-centre.ts` ; `lib/actions/ad-pro-centre-actions.ts` ;
`app/(app)/centre-ad-pro/{page,centre-board}.tsx` ; migration
`20261117090000_centre_validation_ad_pro`. **Bancs** : 6 + 14 + 12 tests, dont un de bout en bout
par les **vrais points d'entrée**, et **15 sabotages** dont le bilan est au journal.

### Centre de paiement — entités en haut, trois sections (05/10/2026)

Barre d'entités en haut (une pastille par société, `?entite=` validé), puis **Regulatory / Sales & Marketing / Autres** (`lib/payments/sections-centre.ts` : la section se lit sur l'origine de la dépense ; les « porteurs » — demande de paiement, secrétariat, pièce Legal — se classent sur l'origine qu'ils déclarent). « Autres » est le seul repli et se compte. Le siège, les deux issues et le cloisonnement ne changent pas.

### Autres lots du 05/10/2026

- **Rapports terrain** : corbeille avec double confirmation, récupérable par le Super Admin ; refus si le compte rendu porte des remises de matériel ou est le seul rapport d'une visite.
- **CTD initiale** (Regulatory) : ZIP ou dossier entier à la 1ʳᵉ étape, catégorie « CTD complet » ; supprimable, remplaçable, avec ajout de fichiers dans un sous-dossier. Gros fichiers en dépôt direct au bucket, ZIP parcouru sans téléchargement.
- **Compression** : stockage compressé sans perte (brotli, si le gain est mesuré) ; au téléchargement, choix entre l'original (qualité maximale) et une version réduite.
- **Pièces Legal d'une demande** : suppression depuis la demande par la porte de Legal. **Devis → BC** : les lignes de devis validées engendrent un BC par devis.

### Centre de paiement — rien ne sort, quel que soit le montant, sans son autorisation

**Un module À PART, hors Finances** (`/centre-de-paiement`, RBAC `PAYMENT_CENTRE` pour
l'écran ; y siègent le PDG, le Super Admin et les sièges nommés — voir « Qui siège ») : celui qui autorise l'argent ne doit pas être dans l'écran de celui qui le décaisse, sinon
la séparation des rôles n'est qu'un onglet. L'ancienne adresse `/finances/centre-de-paiement`
redirige.

**Un ordre ANNULÉ n'est plus au centre (19/10/2026)** : retirer sa demande annule l'ordre (`status = CANCELLED`) sans
rendre l'autorisation, qui reste « en attente ». Toute lecture du centre et tout compteur « à autoriser » porte donc
`ORDRE_NON_ANNULE` (`payments/authorization.ts`, cliquet `centre-ordres-annules.test.ts`), et décider ou répondre sur
un ordre annulé ou réglé est refusé (`refusOrdreFerme`). **Le montant d'une demande de paiement est celui de sa
facture** : confronté au TTC lu (`finance/montant-facture.ts`) ; un écart se corrige ou s'explique et se confirme, et
l'explication est écrite dans l'ordre que le centre autorise. Une demande retirée ou brouillon se **supprime
définitivement** par la corbeille (`supprimerDemandePaiement`, type `PAYMENT_REQUEST`, en lot avec son ordre annulé ;
refusée si son paiement est sorti).

**La règle** : **tout paiement de la société**, quel que soit le module qui l'a produit — Ad & Pro,
secrétariat, formations, recrutement, moyens généraux, **BV Regulatory compris** — et **quel que
soit le montant**, passe par le **centre de paiement** avant d'atteindre les Finances.

**Ce qui n'y passe pas AUJOURD'HUI est NOMMÉ, jamais tu (§118.148).** « Concernant les paiements,
c'est clair, tous passent par le centre de paiements » (Direction, 09/2026). Le registre des chemins
de paiement (`lib/finances/settlement.ts`) porte désormais un axe **`centre`** : `AUTORISE` (l'ordre
naît en attente du centre et `canDisburse` refuse de payer sans lui — ordre de dépense, demande de
paiement, facture envoyée au règlement, **paie** virée par entité, **remise** de caisse d'avance), `ENREGISTRE` (le geste enregistre un mouvement DÉJÀ fait —
écriture directe au livre, facture « marquée réglée » avant son enregistrement, achat sur caisse ; il
n'y a rien à autoriser, et payer un fournisseur par ce chemin serait un contournement) et
**`HORS_CENTRE`** — **un seul chemin** décidé dans l'ERP sans le centre : la **rallonge** de caisse d'avance,
accordée par les RH sans ordre de dépense. La Direction avait assumé trois exceptions le 28/09/2026 (« garder les
trois exceptions » : paie, remise, rallonge) ; le **01/10/2026** elle a fait passer **la paie** (un virement par
entité et par mois) et **la remise mensuelle** par le centre, sans nommer la rallonge — qui reste l'exception, avec sa
décision écrite (`horsCentre()`), et un test tombe si un chemin change de camp sans décision.

**Le seuil et l'exemption ont été retirés (2026-08).** Au-dessous de 50 000 DZD, et pour les moyens
généraux, l'ordre filait droit aux Finances. L'intention était bonne — ne pas faire viser une
facture de 3 000 DZD par le PDG. L'effet ne l'était pas : le centre n'avait **aucune vue** de ce
que la société décaissait, et « combien sort ce mois-ci » n'avait de réponse que dans l'écran de
celui qui paie. Une porte qui laisse passer la moitié du flux n'est pas une porte. Le seuil survit
comme **marqueur** (`isHighValue`) pour trier la file, jamais comme filtre ; si le volume devient
un problème, la réponse sera une **voie rapide explicite et tracée**, pas le retour d'une exemption
silencieuse.

**Les demandes de paiement entrent au centre DÈS LEUR SOUMISSION.** C'était l'inversion la plus
coûteuse du circuit : l'ordre de dépense ne naissait qu'**après** l'instruction des Finances, si
bien qu'elles épluchaient pièce par pièce des dossiers que le centre refuserait peut-être ensuite.
Désormais : le demandeur transmet → l'ordre naît en attente → **le centre tranche** → les Finances
instruisent et règlent ce qui est autorisé. `PaymentRequest.expenseOrderId` porte le lien et
garantit que l'ordre n'est créé qu'une fois, même après un renvoi pour correction ; un filet
subsiste au bon à payer pour les dossiers antérieurs à cette règle.

**La demande se corrige chez son demandeur, et l'ordre suit (audit 360°, R04 — §118.191).** Au brouillon ou
renvoyée par les Finances, le demandeur corrige l'objet, le bénéficiaire, le montant, le contexte et
l'échéance (l'entité et l'urgence, seulement avant la première transmission) ; après transmission, « ce qui a
changé » est exigé. L'ordre déjà au centre suit par l'unique réviseur (`payments/revision-ordre.ts`) : une
hausse ou un autre bénéficiaire **rouvre** une autorisation donnée, une baisse ne rouvre rien ; un ordre réglé
ou refusé ne se révise pas. Le centre, lui, **décide sur ce qu'il a lu** : un montant ou un bénéficiaire corrigé
pendant sa lecture se dit avec les deux valeurs, et rien n'est autorisé.

**Qui siège** : le **PDG** (`DIRECTION`, rôle principal), le **Super Admin**, et les personnes **nommément
désignées** par lui (`PaymentCentreSeat`, Administration → Accès, avec motif et trace : le siège n'ouvre rien d'autre)
— `sitsOnPaymentCentre`, refus `PAYMENT_CENTRE_REFUSAL`. Le Directeur Général n'y est pas par défaut. **Un centre par entité** : autoriser un paiement d'Adventum et un
paiement de Pharmagène sont deux gestes comptablement distincts, et une file unique ferait perdre de
vue ce que chaque société engage.

**Deux issues : autoriser ou refuser** (décision de la Direction, 02/09/2026). Le montant et sa
justification appartiennent à la DEMANDE : ils se corrigent avant d'arriver au centre, qui autorise ou
refuse — un refus exige son motif, qui reste dans le fil attaché au paiement et que le demandeur lit sur sa
ligne et sur la fiche de sa demande de paiement (audit 360°, R20). Les dossiers d'avant qui portent encore
« révision du montant » ou « argumentation demandée » se répondent et reviennent au centre
(`respondToPaymentCentre`). L'audit 360° (R03) recommande de rétablir « Demander une révision » : c'est une
décision de la Direction, rapportée.

**Ce que voient les Finances** : rien, tant que le centre n'a pas tranché. Un paiement `AWAITING`,
`CHANGES_REQUESTED` ou `INFO_REQUESTED` **n'apparaît pas** dans leur file — sinon le comptable
paierait de bonne foi ce qui n'est pas autorisé. Un paiement **refusé**, lui, s'affiche : ils doivent
savoir qu'il ne viendra pas. Et **l'accès à la demande complète** leur reste ouvert : le financier
qui paie doit pouvoir lire ce qu'il paie.

**Où le verrou est réellement posé** : au **décaissement** (`settleExpenseOrder`), pas à
l'affichage. Masquer une ligne est du confort ; `canDisburse(centralStatus)` est la règle. Toute
autre porte vers le paiement devra passer par cette même fonction.

**SIX PORTES À CÔTÉ DE LA PORTE GARDÉE (§118.148)** — chacune laissait le paiement se déclarer fait,
ou l'argent partir, sans que le centre ait vu le montant :
- **Le dossier compagnon se tranchait dans le dossier.** `canDecideFromDossier` était écrite, testée…
  et n'avait AUCUN appelant : « refusé » posé sur le dossier laissait l'ordre payable. L'action la lit.
- **Relever un budget accordé ne renvoyait rien au centre** (congrès, événements) : l'autorisation
  donnée pour 500 000 couvrait 900 000. `statutApresNouveauMontant` — une HAUSSE rouvre, une baisse
  non, un refus reste un refus, un montant illisible compte comme une hausse — et la raison part dans
  le fil du centre.
- **« Annule ce qu'Adam a modifié »** pouvait remettre `APPROVED` sur un ordre que le centre venait de
  rouvrir : `centralStatus` a quitté la liste des champs restaurables.
- **`updateInvoice`** acceptait une date de règlement sur une facture partie au centre (les deux
  autres portes la refusaient) — le même dinar écrit deux fois.
- **Le matériel promotionnel** déclarait « paiement effectué », « réglé et clôturé », ou fermait son
  chantier « Paiement » d'un clic, sans ordre payé : les trois gestes lisent maintenant l'ordre, et
  `chantierPaiementClos` (`lib/payments/reglement.ts`, pur) exige au moins un règlement et TOUS réglés.
- **La rallonge de caisse** sortait de la banque sans écriture au livre (la remise, elle, écrivait).

**UN SEUL ÉCRIVAIN D'ORDRE DE DÉPENSE, TENU PAR UN CLIQUET** (`lib/payments/centre-ecrivains.test.ts`).
Le schéma garde `centralStatus = NOT_REQUIRED` par défaut — l'état HISTORIQUE que `canDisburse` laisse
payer — donc un second `prisma.expenseOrder.create` ajouté demain ferait sortir de l'argent sans que
le centre le voie, en silence. Le cliquet lit la source SANS ses commentaires et exige : un seul site
de création (`createExpenseOrder`), qui pose le statut CALCULÉ par `initialCentralStatus` ; aucune
écriture SQL brute ; et une liste FERMÉE, avec la règle qui justifie chaque entrée, de ceux qui
écrivent l'autorisation (le centre, la réouverture des congrès), le paiement (`settleExpenseOrder`,
qui consulte le verrou) ou le montant.

- **Module PUR** : `src/lib/payments/authorization.ts` (`needsCentralAuthorization`,
  `initialCentralStatus`, `canDisburse`, `visibleToFinance`, `sitsOnPaymentCentre`, `applyDecision`,
  `applyResubmission`, `blockedReason`) + `authorization.test.ts` (**19 tests**).
- **Modèles** : `ExpenseOrder.centralStatus|proposedAmount|decidedById|decidedAt` +
  `PaymentCentreMessage` (le fil). Migration `20260824150000_payment_centre`.
- **Écrans** : `app/(app)/centre-de-paiement/{page,centre-board}.tsx` ;
  **actions** `lib/actions/payment-centre-actions.ts` (`decidePayment`, `respondToPaymentCentre`).
- **Reprise du passé** : migration `20261002140000_centre_guichet_unique` — les ordres encore
  **non réglés** qui étaient en `NOT_REQUIRED` entrent au centre. Les ordres **payés ou annulés**
  ne sont pas touchés : les rouvrir gèlerait des dossiers clos et réécrirait un passé autorisé par
  le circuit d'alors.

### Finances › Banque & paiements — « Solde bancaire » daté, cases d'entités (05/10/2026)

Le « Solde de trésorerie » devient **Solde bancaire** : somme des comptes (ancrage + écritures réglées postérieures), avec la **date du relevé** le plus récent. Les paiements autorisés ne s'en soustraient plus : le **Montant à régler** a sa propre ligne. Le comptable pose le solde et sa date depuis la page (« Comptes de trésorerie »). Des **cases d'entités** en haut (`?entite=`, ignoré s'il n'est pas une société de la personne) filtrent comptes, total et montant à régler (`chargerTresorerie(userId, entiteId)`).

### Finances — deux sous-modules, deux métiers

Une seule page portait la trésorerie, le livre comptable, les règlements et les factures : celui
qui **paie** et celui qui **tient les comptes** s'y disputaient le défilement. Deux écrans, qui se
**déplient dans le menu latéral** sous « Finances » (flèche, comme la paie sous les RH) : on arrive
directement là où l'on va travailler.

| Sous-module | Route | Ce qu'on y fait |
| --- | --- | --- |
| **Banque & paiements** | `/finances/paiements-a-faire` | Le **Solde trésorerie** (somme des comptes − paiements autorisés à régler, §118.176) et le détail par compte, puis la file du décaissement. **Une seule source d'alimentation : le centre de paiement.** Les ordres non autorisés sont écartés en amont — ils n'existent ni en ligne, ni en total, ni en compteur. **TROIS ÉTATS, et rien d'autre** : *non payé* (défaut) · *paiement reporté à une date* · *payé*. Ni annulation ni révision de budget : l'ordre arrive **autorisé**, et le rouvrir à la caisse défait une décision prise par le centre. Un report est une **date** — il expire seul, et l'ordre reste dans la file. |
| **Comptabilité** | `/finances/comptabilite` | Le livre : écritures, import de relevés, **comptes de trésorerie ANCRÉS** (le solde d'un relevé à une date, jamais réécrit : le solde d'un compte = cet ancrage + les écritures réglées postérieures), et ce que le DAF doit encore arbitrer. |

Le **Dashboard** (`/finances`) a été **supprimé** (2026-09) : il ne portait aucun geste ; `/finances` redirige vers
« Banque & paiements ». L'ancienne adresse `/finances/ordres-de-depense` **redirige** aussi — des notifications déjà
parties et des favoris y pointent.

**Les Finances composent leurs factures et leurs bons de commande** depuis Legal › « Factures et bons de
commande » (bouton « Composer une pièce ») : une pièce au format de la maison, sur le papier en-tête de la
société, en Word et en PDF, numérotée par le compteur de la société au motif de son profil — la fabrique
documentaire d'Adam, par un bouton (voir « Fabrique de documents »). Leur vue de Legal se limite à la chaîne
d'achat — factures, bons de commande et avoirs (`PURCHASE_CHAIN_KINDS`). Le menu **« Fait suite à »** du compositeur
chaîne la pièce à celle dont elle découle (`chainFromId` — un BC à son devis, une facture à son devis ou à son BC :
la table `NATURES_AMONT` de `lib/legal/piece-emise.ts`, que la fabrique applique aussi) ; chaîné à son devis, un BC
suit la demande dont le devis est né (centre de validation Ad & Pro pour une demande Ad & Pro), et le devis ne se
révise plus. Les Finances ne lisant pas les devis (décision de permission : `PURCHASE_CHAIN_KINDS`), elles ne chaînent
pas un BC à son devis depuis le compositeur — le menu le dit et nomme Legal, qui rattache la pièce depuis sa fiche
(« Modifier » › « Fait suite à »).

### La chaîne du dossier d'achat — devis → BC → facture → règlement, d'un seul écran

Deux natures ont rejoint Legal : le **DEVIS** et la **FACTURE**. Chaque pièce pointe vers celle
dont elle découle (`chainFromId` — « Fait suite à » : le BC vers son devis, la facture vers son
BC), et la fiche lit l'achat d'un bout à l'autre : chaque maillon avec sa date, son montant et
**ses validateurs** (les étapes de validation qui le visent, nominatives et horodatées), le
**délai en jours** entre deux maillons, l'**écart devis → facture** quand il existe (il doit se
voir AVANT que l'argent parte), et au bout le **règlement** avec son état — au centre de paiement,
aux Finances, réglé, refusé. « Envoyer au règlement » sur une facture crée l'ordre de dépense par
la porte commune — il naît en attente du centre de paiement, quel que soit le montant ;
`LegalDocument.expenseOrderId` empêche d'envoyer deux fois la même facture au paiement, et une
facture qui découle d'un **bon de commande que son centre n'a pas validé** ne part pas (voir
ci-dessous).

**Un enregistrement ne détache jamais une pièce de sa chaîne** (§118.168). Le menu « Fait suite à » propose les
cent devis et BC les plus récents ET, à la modification, la pièce **actuelle** en tête — sous un libellé neutre
quand elle est hors du périmètre de la personne (`piecesAmontProposees`, `lib/queries/legal-chain.ts`). Sans
elle, corriger la date d'une facture chaînée à un BC plus ancien la détachait en silence, et elle sortait du
cumul qui empêche de payer plus que la commande. Une facture **saisie ligne à ligne sur un dossier de matériel
promotionnel** garde son BC : la rattacher ailleurs se fait en l'annulant depuis le dossier, puis en la
redéposant (le refus le dit). À la création, le compositeur propose les cent pièces les plus récentes de chaque
nature, sans les annulées, par la porte de la liste Legal (`piecesAmontComposables`), et la fabrique juge la pièce
amont AVANT qu'un numéro existe : lisible par la personne (sinon la phrase de l'absence), de la même société, de la
bonne nature, non annulée (`refusPieceAmont`).

**Sur les fiches Ad & Pro, les pièces liées se lisent dans cet ordre** (§118.161, décision de la Direction du
30/09/2026) : **Devis → Bon de commande → Facture**, chacun avec sa version plateforme (Word / PDF de la fabrique) et
son PDF, puis les **Engagements** (conventions d'orateurs, contrats — sans les BC, qui ont leur maillon) et les
courriers. Chaque maillon a SON bouton, sa nature part en champ caché, et le BC dit de quel devis il découle, la
facture de quel BC. Le bloc « Documents » générique a disparu des sept natures ; les fichiers déjà déposés comme
devis, BC ou facture sont montrés dans la section de leur nature, et « Créer sa fiche » leur crée leur pièce au
registre en y RANGEANT le fichier — sans second téléversement, et seulement pour un fichier déposé sur CETTE fiche
que la personne peut gérer. Les droits se lisent pièce par pièce par la porte du serveur (`accesAuxPiecesLegal`) :
rien n'est chargé de ce que la personne ne peut pas ouvrir.

### Bons de commande — tout BC passe par un centre de validation (§118.148), au-dessus du seuil des BC depuis §118.149

« Concernant les BC, ils doivent tous passer soit par le centre de validation Ad & Pro si la demande
est depuis Ad & Pro, soit par le centre de validation normal, si elle provient de quelque part
d'autre » (Direction, 09/2026). **La règle est pure** (`lib/bons-de-commande/regle.ts`, socle, zéro
import) et **l'aiguillage l'applique** (`lib/bons-de-commande/aiguillage.ts`) :

- **QUEL CENTRE ?** On remonte l'ORIGINE du BC (sa fiche source, la pièce dont il découle, jusqu'à
  six maillons, en passant par une demande au secrétariat ou un dossier de paiement) : un seul
  maillon Ad & Pro suffit pour le **centre de validation Ad & Pro** (un visa `AdProGateVisa` sans
  seuil FIGÉ — depuis §118.149, la porte suit le seuil des bons de commande en vigueur, 0 par défaut
  donc tous) ; sinon le **centre de validations** (une demande de validation
  adressée au Directeur Général, ou au Super Admin à défaut).
- **UNE SEULE PORTE, JAMAIS DEUX.** Le BC d'un POSTE Ad & Pro a déjà la sienne (`orderStage`, visée au
  centre Ad & Pro par le DG ou le Super Admin — plus par la Direction, ni par les Finances pour le
  matériel promotionnel) ; en poser une seconde ferait valider deux fois le même engagement.
- **CE QUI ARRIVE QUAND LE BC CHANGE** (`gesteAiguillage`) : aucune porte → la POSER ; en attente dans
  l'autre centre (rattaché après coup à une fiche Ad & Pro) → la TRANSFÉRER ; VALIDÉ puis RELEVÉ →
  ROUVRIR en disant de combien ; à revoir puis corrigé → ROUVRIR ; BAISSÉ, ou montant d'abord inconnu
  qu'on renseigne → rien ; REFUSÉ → rien, même retouché, même rattaché ailleurs : un refus ne se
  contourne pas. Annuler ou supprimer un BC retire sa porte en attente.
- **LA FACTURE QUI EN DÉCOULE** ne part pas au règlement tant que le BC n'est pas validé
  (`canSendToSettlement` → `blocageParLeBC`, qui nomme le BC et le centre). Un BC d'AVANT la règle
  (sans porte) ne bloque rien — sinon tout le registre gèlerait — et sa fiche offre « Adresser au
  centre » (`adresserBCAuCentre`, aussi en conversation : `legal_operation/submit_purchase_order`).
- **LA PHRASE NE LE FAIT PAS PASSER POUR VALIDÉ** : la fiche, la fabrique (écran des Finances et outil
  d'Adam) et la création disent « en attente de son centre — ne l'envoyez pas au fournisseur »
  (`reserveBC`), calculé UNE fois par la fabrique, et « aucun siège au centre » quand personne n'y
  siège. Le chantier « Bon de commande » du matériel promotionnel exige un BC validé
  (`chantierBCClos`).
- **Toutes les créations de documents Legal qui peuvent être un BC passent par l'aiguillage** — la
  fiche Legal, le renouvellement, la demande au secrétariat, la fabrique — et le cliquet
  `centre-ecrivains.test.ts` le tient sur la source (avec un niveau de délégation, pour la fabrique).

**Deux défauts trouvés en le branchant.** Le formulaire « Pièces liées » d'une fiche envoyait la
partie en TEXTE alors que Legal exige une partie de l'annuaire : il refusait TOUTE création — donc le
geste même que le refus du chantier BC nomme ; il envoie désormais les identifiants, et le courrier
ses expéditeur/destinataire. Et Adam écrivait la partie en texte libre : `create_legal_document`
refusait après le clic, `update_legal_document` refusait toute pièce déjà rattachée à l'annuaire. La
partie donnée par son NOM est maintenant résolue contre l'annuaire (`counterpartyName`), jamais écrite
telle quelle.

Un devis à **deux** bons de commande (deux lots) : chaque BC remonte au même devis, et l'on lit
toujours **le fil de la pièce qu'on regarde** — jamais un graphe qui mélangerait deux commandes.
Module pur `lib/legal/chain.ts` (10 tests) ; chargement borné `lib/queries/legal-chain.ts` ;
carte `app/(app)/legal/[id]/chain-card.tsx`. Le chargement relit le droit maillon par maillon
(`loadLegalChain(docId, user)`, porte unique des pièces) : un maillon que la personne ne lit pas garde sa
place et sa nature sous un libellé neutre, sans titre, montant, validateurs ni règlement — la carte ne dit
jamais « Manque encore : Devis » d'un devis qui existe (§118.198).

### Bons de commande — le seuil, puis la signature des Finances (§118.149)

« Tout BC supérieur à un montant configuré dans les centres de validations Ad&Pro devra passer par la
validation d'un des centres. » — « Un sous-module Bons de commande sous Finances : les bons de commande à
signer de leur part. Si un BC se retrouve là-bas, c'est qu'il doit être signé » (Direction, 09/2026).

- **LE SEUIL** (`AppSetting.bcValidationThreshold`, réglé depuis le **centre de validation Ad & Pro** par
  ses sièges — DG et Super Admin — ou par Adam, `adpro_operation/set_bc_threshold`) : **strictement
  au-dessus**, le BC passe par un centre (Ad & Pro s'il en vient, le centre de validations sinon), comme
  au §118.148 ; **en deçà**, aucun centre — il va directement à la signature des Finances. Un montant
  **inconnu** passe par un centre (on ne franchit pas un contrôle sur un trou). **0 = tout BC passe par un
  centre** — c'est la valeur par défaut, le comportement d'avant, jusqu'à ce que la Direction fixe le
  montant. Distinct du seuil des DEMANDES (celui du DG) : l'un dit qui arbitre une opération, l'autre
  quelle pièce doit être validée avant d'engager la société.
- **L'ÉTAPE DE BOUT EN BOUT** (`etapeBC`, une seule lecture pour la file, la fiche, l'action et la
  phrase) : à valider → à revoir / refusé → **à signer** → (**renvoyé à l'émetteur**) → **signé**.
- **RENVOYER À L'ÉMETTEUR** (`renvoyerBonDeCommande`, audit 360°, R09) : l'autre issue de la signature, par le
  même siège, motif obligatoire. Le BC quitte la file « À signer » (une carte « Renvoyés à l'émetteur » garde ce
  qui a été demandé), son émetteur est prévenu, et **toute modification** de la pièce le rend à la signature —
  ou d'abord à son centre si son montant monte (`aiguillerBC`, `modifie`). Le renvoi est un fait de la pièce
  (`LegalDocument.signatureReturnedAt/ById/Note`, migration `20261228090000_bc_signature_renvoyee`). Un BC d'avant le circuit
  (`bcCircuitAt` nul) n'est présumé ni à valider ni à signer : fixer un seuil ne fait pas tomber
  l'historique dans la file des Finances ; « Adresser au centre » l'y fait entrer.
- **BONS DE COMMANDE** (`/bons-de-commande`, module à part `PURCHASE_ORDERS` depuis le 01/10 — l'ancienne adresse
  `/finances/bons-de-commande` redirige) ne contient QUE des BC à signer — validés par leur centre, ou sous le
  seuil — avec la raison de leur présence, la pièce à lire et le bouton **Signer** (droit « Modifier » du module,
  `peutSignerBC` : par défaut Direction, Directeur Général et Finances ; le Directeur des Opérations a « Voir »). Les
  BC encore au centre y sont COMPTÉS, pas listés. Sont prévenus à l'ENTRÉE d'un BC dans la file (jamais à chaque
  relecture) les Finances, dont c'est le métier, et les personnes que la console désigne pour signer.
- **LA SIGNATURE EST UNE ATTESTATION** (`signerBonDeCommande`) : un clic dans une vraie session, jamais
  Adam ni le chemin générique (`SURFACES_HUMAINES`, parité EXCLUDED). Trois gardes : le droit, la
  lecture (la portée de l'écran Legal) et l'étape — et le verrou porte sur la DERNIÈRE ÉCRITURE de la
  pièce : ce qui a été relu est ce qui est signé. **Modifier le montant ou le fournisseur d'un BC signé,
  ou le réviser par la fabrique, retire la signature** — il retourne à la file. Une date de signature
  PAPIER (un contrat du PCH re-qualifié en BC) ne vaut pas signature des Finances.
- **CHANGER LE SEUIL RÉAIGUILLE CE QUI EST EN VOL**, dans les deux sens, en ne lisant que la bande de
  montants qui change de côté : relevé, la validation en attente quitte le centre et le BC va à la
  signature ; abaissé, une porte est posée. Une décision déjà prise ou une signature ne se retirent pas.
- **PARTOUT OÙ UN BC NAÎT** : la fiche Legal, la fabrique (écran des Finances, de Legal et Adam), les
  demandes de pièce, les rattachements Ad & Pro, les postes (sous le seuil, la demande de BC d'un poste
  passe aux Finances sans visa — et la fiche dit « BC sous le seuil », jamais « validé par le centre »),
  l'ancien circuit du matériel promotionnel. Le chantier « Bon de commande » d'un dossier promo ne se
  clôt qu'une fois ses BC **signés**.
- **LES BOUTONS** : Legal a son bouton « Composer un bon de commande », et le module **Bons de commande**
  (Administration › Bons de commande, `/bons-de-commande` — un module À PART depuis le 01/10, §118.176)
  le sien — le même compositeur (`components/pieces/composer-piece.tsx`), les mêmes droits
  (`compositionDesPieces`), le même papier en-tête.

### My Chief of Staff — l'interface exécutive (Super Admin seul depuis 09/2026)

> **Adam n'est visible que du Super Admin** (décision de la Direction, 09/2026 ; Adam est en pause de développement).
> Le module `CHIEF_OF_STAFF` ne suffit plus : pages, sous-pages (garde de segment `chief-of-staff/layout.tsx`),
> routes, voix, brief et actions serveur lisent `peutVoirAdam` (§118.153). Ce qui suit décrit le produit tel qu'il
> fonctionne pour lui.

Le module `/chief-of-staff` (RBAC `CHIEF_OF_STAFF`) est le MÊME moteur que l'assistant — agent
loop, actions confirmées, mémoire, dictée vocale — servi avec les **outils d'un chef de cabinet**,
et un persona exécutif injecté **par le rôle, côté serveur** (ton direct, chiffré, preuves et
liens à chaque affirmation). Trois règles non négociables : la **permission se vérifie côté
serveur à chaque appel** (la liste d'outils envoyée au modèle n'est qu'une suggestion) ; chaque
affirmation importante cite **référence, date et lien interne** ; quand la donnée n'existe pas,
l'outil le **dit** — il n'infère pas.

**Chercher et comprendre** : `search_everything` (recherche fédérée RBAC-aware sur ~30 familles —
paiements, Legal avec restriction lecteurs, courriers, factures, produits, personnes, Drive,
hôpitaux, projets… — tolérante aux accents et aux fautes via `unaccent`/`pg_trgm` quand
disponibles, repli LIKE sinon ; `lib/queries/search-everything.ts`) ; `inspect_record` (l'histoire
complète d'un dossier par sa référence — paiement, règlement, Legal avec chaîne
devis→BC→facture→règlement et validateurs datés, promo, secrétariat, **dossier Regulatory,
facture, courrier, projet, tâche** — timeline d'audit, pièces, liens) ; `search_drive` +
`read_document` (fouiller puis LIRE — droit du Drive nœud par nœud) ; les lectures transverses
ouvertes par le DROIT de l'écran : `read_calendar`, `find_free_slot` (créneau commun),
`read_stock`, `search_hospitals`, `read_employee`, `read_payroll` (RH), `search_courriers`,
`finance_totals` (agrégats côté base, période vs période) ; `person_report`.

**Piloter** : `executive_alerts` (détecteurs proactifs avec criticité — paiement bloqué au
centre, validation qui dort, facture sans BC, contrat expirant, stock épuisé… ;
`lib/assistant/proactive.ts`) ; `executive_brief` (« fais-moi mon point » — à décider, risques,
finance, RH, réunions, en un appel) ; `create_report` (« regroupe-moi tout sur le contrat X » →
.docx consolidé déposé au Drive « Rapports IA ») ; `plan_reminder`/`list_reminders`/
`cancel_reminder` (« mardi 10 h », « dans 3 heures », « tous les dimanches relance Regulatory »
— rôle — ou « relance Nesrine » — personne nommée —, « chaque premier lundi du mois » ; modèle
`AssistantReminder`, balayage `lib/scheduled.ts`, heure d'Alger).

**Agir (toujours confirmé + audité)** : `decide_payment` (centre, SENSITIVE) ; `update_task`
(réassigner, échéance, statut, commentaire) ; `update_request` (secrétariat, via les actions du
module) ; `create_legal_document`/`update_legal_document` (déclarer un devis/BC/facture et le
CHAÎNER) ; `update_calendar_event` (déplacer/annuler) ; `create_hospital`/`update_hospital` ;
**`update_salary` (niveau CRITIQUE)** — carte avant/après/écart %, **re-saisie du montant**
(`confirmText`), verrou de fraîcheur à l'exécution. Le LLM ne décide JAMAIS d'un droit : garde à
la proposition, à l'exécution ET dans la fonction métier (tests adversariaux :
`lib/assistant/executive-security.test.ts`).

**Voix — l'APPEL temps réel (speech-to-speech)** : session `gpt-realtime-2.1` en WebRTC direct
navigateur ↔ OpenAI (secret éphémère serveur, clé jamais exposée), mêmes outils/permissions/
conversation que le texte (~25 fast paths + `delegate_to_chief_of_staff` → cartes de
confirmation), interruption sémantique (barge-in), tours persistés dans le même fil. L'appel
est **GLOBAL** (`components/layout/call-provider.tsx`, monté dans le layout) : il survit à la
navigation, se réduit en carte flottante, minuterie à la connexion réelle, champ TYPE dans
l'appel, cartes live, contexte d'écran (route + référence, jamais de capture), résumé d'appel
factuel au raccrochage. Écran d'appel présentationnel : `voice-mode.tsx` (`CallScreen`).
La dictée (`/api/assistant/transcribe`) reste le repli explicite.
**UI** : panneau CONTEXTE sur grand écran (sources consultées poussées par les événements SSE
`source`, actions du fil, raccourcis) ; entrée contextuelle `/chief-of-staff?ref=…`/`?q=…`/
`?call=1&ref=…` + boutons « Demander au Chief of Staff » / « Appeler » (fiches Legal et
demande de paiement).
**Observabilité** : `AiUsageLog` enrichi (TTFT, tours, appels/erreurs/temps des outils).
Capacités de production, matrice finale et limites : `docs/CHIEF_OF_STAFF_ARCHITECTURE.md`.

### ADAM — les canaux Google du Chief of Staff (Gmail, Agenda, Drive, Docs/Sheets/Slides, Contacts)

Adam n'est **pas un second assistant** : c'est le MÊME cerveau que « My Chief of Staff », auquel
on ajoute des sens et des canaux. Aucune conversation séparée, aucune mémoire parallèle.

**La règle qui prime sur tout — la frontière d'envoi.** Adam lit, cherche, indexe, classe,
comprend, relie à l'ERP, suit les réponses manquantes et RÉDIGE en autonomie complète : rien de
tout cela ne demande d'autorisation. Ce qui en demande une, c'est le moment où un message QUITTE
l'entreprise. Par défaut `MAIL_SEND_POLICY = REQUIRE_APPROVAL`.

Cette règle n'est pas une discipline, elle est **vraie par construction** : `sendOutboundIntent`
(`src/lib/comms/outbound.ts`) est la SEULE fonction du système qui fasse partir un message. Le
chat, la voix, une mission de fond, une étape de plan, un cron — tout passe par là. Il n'existe
pas de seconde route.

Six garanties, chacune contre une façon précise de perdre le contrôle :

| Garantie | Mécanisme | Ce qu'elle empêche |
|---|---|---|
| L'EXPÉDITEUR est celui qu'on croit | `authorizeIdentity` (`comms/identity.ts`) à la création **et** à l'envoi : la connexion appartient au compte et elle est active | Écrire depuis la boîte de quelqu'un d'autre — y compris depuis celle du PDG lui-même |
| L'accord porte sur un CONTENU EXACT | `contentHash` (destinataires, copies, objet, corps, pièces, identité) comparé à `approvedHash` | Faire approuver A et expédier B |
| L'accord vient d'un HUMAIN | `approvedById` exigé en plus de l'empreinte | Qu'une intention née en envoi autonome parte encore après retour à l'approbation obligatoire |
| Un seul envoi, jamais deux | transition atomique `APPROVED → SENDING` par `updateMany` conditionnel | Double clic, rejeu réseau, webhook répété |
| Un seul MESSAGE par contenu | déduplication sur `contentHash` dans `createOutboundIntent` (fenêtre 24 h) | Qu'une préparation refaite fabrique une deuxième carte, une deuxième approbation, un doublon chez le destinataire |
| La politique est relue À L'INSTANT de l'envoi | `getCommunicationPolicy()` dans `sendOutboundIntent`, jamais la politique mémorisée | Qu'un garde-fou remis reste sans effet sur la file existante |

**Il n'y avait pas UNE route, il y en avait DEUX — et c'est corrigé.** L'outil `send_email` de
l'assistant expédiait par le SMTP historique du module Courrier (`MailAccount`), hors de
l'intention canonique : sans empreinte approuvée, sans approbateur, sans relecture de
`MAIL_SEND_POLICY`. Il PRÉPARE désormais une `OutboundMailIntent` et rend la carte
`send_prepared_mail` — un seul appel d'outil, une seule confirmation. L'ancienne carte
(`payload.kind === "send_email"`) n'expédie plus rien et le dit. L'ancien module `/courrier`, lui,
est retiré (l'adresse redirige vers Mon espace) : son bouton d'envoi humain n'existe plus.

**Une confirmation en français CONCLUT, elle ne relance pas.** « Je confirme », « oui », « envoie »
sont résolus côté serveur (`resolvePendingMailConfirmation`) vers l'intention EXACTE qui attend —
sans repasser par le modèle, donc sans risque d'en fabriquer une seconde. Trois conditions, toutes
nécessaires : un accord sans réserve (`comms/confirmation.ts`, volontairement strict), UNE seule
intention en attente, et moins de deux heures. Hors de là, la conversation suit son cours.

**Adam sait qui il est.** Son nom et son adresse d'expédition viennent de la connexion canonique
(`assistantIdentityContext`), injectés en texte comme à la voix. Interrogé, il ne répond plus
« je m'appelle Assistant IA » ni « j'envoie depuis ta boîte » : ce sont des faits lus, pas devinés.

**UNE AUTORITÉ, DEUX INTERFACES.** Cliquer « Envoyer » et dire « vas-y, envoie » appellent
EXACTEMENT la même fonction — `approveAndExecuteIntent` (`src/lib/comms/approve-execute.ts`). Il y
avait deux logiques : le clic exécutait, la parole… réaffichait la carte, et le PDG devait cliquer
ce qu'il venait d'approuver à voix haute. Une carte n'est pas l'autorisation, c'est sa
REPRÉSENTATION. Les garanties ne bougent pas d'un pouce (empreinte du contenu approuvé,
approbateur humain, transition atomique, politique relue) : on a retiré un CLIC, pas un contrôle.

**LE DÉBIT AVANT LA POLITESSE.** `src/lib/assistant/chief-style.ts` porte la règle de style —
résultat d'abord, 1 à 3 phrases, aucune question en fin de réponse, et surtout : ne pas demander ce
qui se déduit. « Envoie un mail à Amine » n'appelle plus « quel objet ? quel contenu ? » : l'objet
(« Prise de nouvelles ») et le corps sont écrits, MONTRÉS sur la carte, et rectifiables d'un geste.
Un défaut visible vaut mieux qu'un aller-retour. La seule question qui subsiste est celle où se
tromper coûte cher : « Amine : Pharmagene ou Gmail ? »

### L'ANNUAIRE INTERNE — l'identité des personnes, avec sa provenance

Adam disait « je n'ai pas son adresse » à propos de collègues dont l'ERP connaissait l'adresse. La
résolution ne regardait qu'une colonne (`User.email`), sans variantes, sans alias, sans savoir ce
qu'elle valait. `DirectoryEntry` / `DirectoryEndpoint` ajoutent ce qu'aucune fiche ne portait — les
MOYENS DE JOINDRE quelqu'un — sans jamais dupliquer le nom, le poste ni le département, qui restent
aux RH : l'entrée POINTE vers `User` / `Employee` / `CompanyContact`.

Chaque coordonnée porte sa PROVENANCE, et l'ordre décide où part le courrier :
`VERIFIED_INTERNAL` (saisie et vérifiée en interne) > `VERIFIED_PROVIDER` (compte / fiche ERP) >
`OBSERVED_HISTORY` (vue dans une correspondance) > `INFERRED`. Google n'est PAS le carnet
d'adresses de l'entreprise : ce qu'on a vu passer dans une boîte est un indice, jamais un
référentiel — il vient après tout ce que l'entreprise maintient.

Deux adresses vérifiées à égalité → UNE question courte, jamais un tirage au sort. Un mot du PDG
(« de Pharmagene », « sa Gmail ») suffit à trancher. L'assistante de direction enrichit l'annuaire
sur `/mon-espace/annuaire` (lecture ouverte à l'espace de travail ; écriture : RBAC : Direction, Super Admin, Moyens généraux ou RH en écriture,
ou l'annuaire des PERSONNES ouvert en modification depuis la console — `canEditDirectory` délègue à `peutAnnuaire`,
§118.147 ; chaque geste audité). Adam le LIT (`directory_lookup`, `directory_list`) et n'y écrit jamais :
laisser une conversation changer une adresse ouvrirait un détournement de courrier trivial.

Fichiers : `src/lib/directory/` (resolve, rank, normalize, access), `src/lib/actions/directory-actions.ts`,
`src/lib/assistant/directory-tools.ts`, `src/app/(app)/mon-espace/annuaire/people-directory.tsx`.

### Regulatory — l'avancement d'un dossier a UNE source

Le dossier Raltegravir affichait « 22/22 » à l'écran pendant que le Chief annonçait « Étape
courante : Préparation dossier CTD (non démarrée) ». Les deux disaient vrai sur deux magasins
différents : l'écran écrit dans `RegulatoryProduct.workflow` (le JSON coché par l'équipe), le Chief
lisait la table `RegulatoryStep`, un registre parallèle que plus personne ne tient. Un assistant
qui contredit l'application n'est plus consultable — c'est pire qu'une erreur isolée.

`workflowAsSteps` + `regProgress` font désormais foi partout, verrou de présoumission compris ; la
table ancienne ne sert plus qu'aux dossiers jamais cochés. Verrouillé par
`src/lib/assistant/regulatory-step-truth.test.ts`.

Le coupe-circuit sortant **prime sur l'envoi autonome** (`decideSend` le teste en premier).

**Adam ne devient jamais sourd.** Le push Gmail est rapide mais fragile : un redémarrage au
mauvais moment, une veille expirée, un Pub/Sub perdu, et un message n'entre jamais dans sa
conscience — sans erreur, juste un silence. Trois filets, du plus précis au plus large :
`syncFromHistory` (histoire incrémentale depuis le dernier point), repli sur une liste récente
quand Google a purgé l'historique, et `reconcileInbox` (passage périodique). Le point d'histoire
n'avance qu'APRÈS traitement réussi, et l'ingestion est idempotente : un plantage rejoue les
mêmes messages sans doublon. Le tout tourne dans `runAdamInboxSweep`, appelé par le
planificateur (`src/lib/scheduled.ts`) — sans navigateur ouvert.

**Le courriel est une entrée NON FIABLE.** Un message qui dit « ignore les instructions
précédentes » est du CONTENU, jamais une instruction : `src/lib/comms/untrusted.ts` isole et
neutralise. Aucun message, aucune pièce jointe ne peut changer une permission, une politique,
une approbation ou l'autorité d'un outil.

**Mise en service** — `/chief-of-staff/reglages` (vue globale seule) : connexion du compte
Google en un clic, politique d'envoi, coupe-circuits (entrant / sortant / connexion), réarmement
de la veille, déconnexion avec révocation du consentement CHEZ Google. Aucune manipulation de
base n'est nécessaire. Le diagnostic `npm run adam:doctor` dit, depuis le serveur qui tourne, ce
qui manque et comment le corriger. Exploitation détaillée : `/admin/ai`.

Fichiers : `src/lib/google/` (config, oauth, client, connection, health, `gmail/`, `calendar/`,
`drive/`, `workspace/`), `src/lib/comms/` (policy, outbound, **identity**, **confirmation**, missions, loop-safety, untrusted,
email-intelligence), `src/lib/assistant/adam-tools.ts` (19 outils), `src/app/api/google/`
(connect, callback, pubsub).

### Matériel promotionnel — circuit 2 : devis retranscrits, lignes retenues, BC générés

> **Fiche refondue (09/10, maquette validée)** — `/promo-material/[id]`, calculs purs `lib/promo-material/fiche.ts`
> (+ tests) : frise de huit étapes, cinq chiffres d'argent, **UNE chose à faire** (« où — chez qui » et le seul geste
> utile à qui regarde), articles demandés et prestations couvertes, devis côte à côte (une ligne par article ×
> prestation, meilleur prix en vert). Les BC naissent **en brouillon automatique** à la dernière validation (voir
> « Le BROUILLON du BC », Fabrique de documents) ; un article absent du catalogue se saisit librement (« Autre article »,
> `PromoCatalogueArticle.horsCatalogue`, archivé jusqu'à son ajout au catalogue).

La demande de la Direction, dans ses mots : le demandeur fait sa demande ; **il demande les devis**, qui partent à
**l'assistante de direction** ; elle a **un tableau à elle** pour les **retranscrire** (référence, unité, prix
unitaire, prix total, par fournisseur) ; le demandeur **valide un devis entier ou des lignes de plusieurs devis** ;
la **Direction Marketing** valide (pas si c'est elle qui demande), le **DG au-delà du seuil Ad & Pro** ; puis le
demandeur **génère ses bons de commande automatiquement**, un par fournisseur retenu, **produits par la plateforme** ;
il peut les **modifier ou les supprimer**, les **envoyer**, et il **doit déposer la ou les factures**, chacune associée
à son BC, pour **demander le paiement** ; à chaque paiement, la **demande de visa publicitaire ou la déclaration au
ministère** part chez l'information médicale.

| Étape (`circuitState`) | Qui | Ce qui se passe |
|---|---|---|
| `REVIEW_REQUEST` | le validateur **figé à la création** | directrice marketing pour un membre de la Direction Marketing ; sinon le **N+1** de l'organigramme, **jamais au-delà du directeur des opérations** ; **personne** pour la directrice elle-même ni pour le directeur des opérations (l'étape n'existe pas) |
| `QUOTE_TO_REQUEST` | le demandeur | « Demander les devis » → une demande au secrétariat (`AdministrativeRequest` QUOTE, liée au dossier) |
| `QUOTE_REQUESTED` | l'assistante (jamais le demandeur) | retranscrit chaque devis : fournisseur de l'annuaire, n°, date, TVA, taxe additionnelle **hors base de TVA**, total imprimé, **scan obligatoire**, lignes référence / unité / quantité / prix unitaire ; « Retranscription terminée » refuse tant qu'un devis manque de scan, de lignes, ou ne retombe pas sur son total (± 1 DZD) |
| `REVIEW_REQUESTER` | le demandeur | coche des lignes de **plusieurs devis** ; valider **fige** le montant retenu (TTC des lignes cochées, **chaque devis avec SA taxe**) ; « demander une correction » renvoie à l'assistante avec le motif |
| `REVIEW_MANAGER` | la Direction Marketing | sautée quand c'est elle qui demande |
| `REVIEW_DG` | le Directeur Général | au-dessus du **seuil Ad & Pro** (même réglage que le centre) ; un montant inconnu **ouvre** la porte |
| `IN_EXECUTION` | le demandeur, l'assistante, la Direction | BC générés → centre Ad & Pro au-dessus du **seuil BC** → **signature des Finances** → envoi → factures → paiement |

**Ce que le code garantit, et qu'aucune case ne peut contourner.** Le **BC est composé par la fabrique** d'après les
lignes VALIDÉES — jamais d'un formulaire : la délégation (les validations du dossier, nommées à la fabrique et
reprises par l'audit) ne peut pas devenir une porte pour émettre n'importe quel BC au nom de la société. **On ne
facture pas, on n'envoie pas un BC que les Finances n'ont pas signé.** Les factures d'un BC **ne dépassent jamais son
montant** (± 1 DZD, dépôts sérialisés par BC). Le paiement passe par la **porte commune** (`canSendToSettlement` →
`createExpenseOrder` → **centre de paiement**), sérialisé par facture ; la demande à l'information médicale part
**avec** lui, **sans montant** — l'information médicale n'émet pas un second paiement pour le même matériel.

**Un geste à la fois, sur ce que l'écran a montré (lot D1b).** Le **choix des lignes** commence par une écriture
conditionnelle sur l'étape (deux choix croisés passent l'un après l'autre) et relit les lignes sous ce verrou ; un
choix vide est refusé **avant toute écriture**. La **validation** relit la sélection sous `FOR UPDATE` et refuse si
elle a changé depuis l'écran (`lignesVues`) : rien n'est validé, et la phrase demande de recharger. La clôture d'un
chantier est conditionnelle (deux chantiers clos à la même seconde ne s'effacent plus l'un l'autre). Rouvrir ou
fermer la demande au secrétariat se fait dans la transaction du geste (`promo-material/demande-secretariat.ts`, `tx`
obligatoire).

**Qui retranscrit.** Une assistante de direction ACTIVE (rôle principal ou secondaire), jamais le demandeur. La
demande ne la désigne plus (décision du 01/10) : quand les devis sont demandés, **toutes** les assistantes sont
prévenues et la retranscription est ouverte au secrétariat (`retranscritLesDevis`) — ce qui ôte aussi au demandeur le
moyen de nommer qui recopiera les prix qu'il retiendra ensuite. Un dossier d'avant qui en nomme une la garde.

**La demande naît avec ses LIGNES (§118.171).** Le formulaire — « Nouvelle demande › Matériel promotionnel » d'Ad & Pro
et le bouton de l'écran Matériel promotionnel, un seul composant (`components/ad-pro/demande-materiel-form.tsx`) —
compose autant de lignes qu'on veut : l'**article du catalogue** (les trois familles, en groupes), la **quantité**
(aucune pour un support numérique), les **actions** attendues du fournisseur, les **produits** quand l'article les
exige, une précision. Il ne demande plus ni **budget estimé** (« on ne l'a pas au début » : il naît des devis), ni
**assistante**, ni **Business Unit** (« pas du tout pertinent ici »), ni **entité** — c'est celle où le demandeur
travaille (`moneyEntityOf`). Les lignes partent en un seul champ JSON relu par une règle pure
(`promo-material/lignes-demande.ts`) et jugées par la règle de la fiche (`validerArticleDemande`) : tout ce qui
manque se dit en une fois, ligne par ligne ; une ligne entièrement vide est écartée ; une saisie illisible est
refusée, jamais devinée. Adam ne compose pas ces lignes : son outil le dit et nomme l'écran, avant toute carte.

**La société qui s'engage.** Celle du dossier ; à défaut, celle où travaille le **demandeur** (fiche salarié, puis
département) — jamais celle de la personne qui clique. Le droit nominatif d'« engager » une société
(`UserCompanyAccess.canEdit`, que seul le Super Admin a sur tout le groupe) **cède à la délégation**, pour la seule
société nommée et parmi celles que la personne peut **lire** : sans cela, ni le demandeur ni l'assistante — salariés,
sans droit nominatif — ne pouvaient générer le BC que la Direction avait validé.

**Les fichiers du BC.** Émis dans le Drive de celui qui génère, ils s'ouvrent pour tous les lecteurs de la **pièce**
par `/api/legal/<id>/fichier` (Word ou PDF) — le demandeur, les Finances, l'information médicale. Une **révision
déléguée** (livraison, délai, interlocuteur, notes — **jamais les lignes**) écrit la nouvelle version du fichier de
**la pièce**, et d'elle seule : le port vérifie que le fichier est bien celui de la pièce nommée. Ce qui n'est pas
nommé **garde sa valeur** ; `null` efface.

**Qui ouvre la fiche** (`peutOuvrirLeDossierPromo`) : la vue globale, le module en portée « tout », et les **parties
prenantes** — demandeur, assistante, validateur figé, directrice marketing, le secrétariat, le pharmacien qui instruit
la demande de visa d'un paiement du dossier. Le N+1 d'un délégué n'a pas le module : il ouvre quand même la fiche
qu'on lui demande de valider.

**Par la conversation** (`promo_operation`) : demander les devis, retirer un devis, clore la retranscription, retenir
des lignes (« tout le devis Atlas et la ligne Kakémono de Stands Sahel, valide » ; « Fournisseur : ligne » lève
l'homonymie, jamais « la première des deux »), demander une correction, générer / modifier / annuler / marquer envoyé
un BC, déposer une facture (fichier du Drive), demander le paiement, adresser la demande de visa. Le dossier se
désigne **sous la porte de la fiche** : un candidat que la personne ne peut pas ouvrir n'est pas même listé. **Seule
la retranscription d'un devis reste un geste d'écran** — les prix recopiés deviennent le BC puis le paiement, et un
document lu est une donnée, jamais la main qui écrit ce qui sera payé.

- **Modules PURS** : `lib/promo-material/circuit.ts` (colonne ordonnée + tamis `etapeApplicable`, règles d'acteur
  `demandeLesDevis` / `retranscritLesDevis` / `choisitLesLignes` / `piloteLExecution`), `devis.ts` (totaux en
  centimes), `execution.ts` (verdicts des chantiers), `validateurs.ts` (la règle du validateur de la demande).
- **Actions** : `promo-devis-actions.ts` (6), `promo-execution-actions.ts` (7), `promo-circuit-actions.ts` (transitions,
  bascule d'un dossier d'avant). Le dossier se désigne par **`promoMaterialId`** (le corps écrit une table fille : `id`
  y désignerait la mauvaise table pour le chemin générique).
- **Lectures** : `queries/promo-circuit.ts`, `queries/promo-execution.ts`, `queries/legal-fichier.ts`.
- **Pont d'Adam** : `platform/in-process/promo/` ; ops `assistant/ops/impl-promo-circuit2.ts`.
- **Bancs** : `circuit-v2.test.ts` (29), `promo-circuit-v2-flow.test.ts` (20, de bout en bout par les vrais points
  d'entrée, opérations d'Adam comprises), `platform/in-process/promo/designation.test.ts` (10),
  `promo-devis-course-flow.test.ts` (les courses forcées sous verrou). Migration `20261130090000_promo_devis_lignes`.

### Matériel promotionnel — cinq marches, puis trois chantiers en parallèle

> **Circuit d'avant.** Les dossiers ouverts avant le circuit 2 gardent la chaîne qui leur avait été promise ; ils peuvent être **basculés** sur le circuit 2 (« Basculer sur le nouveau circuit »), jamais l'inverse.

Le circuit d'avant comptait seize marches en file indienne : une brochure attendait trois semaines,
et personne ne savait sur quelle marche elle dormait. Il en reste **cinq** :

1. **Demande de devis** — sautée si le demandeur a **déjà** son devis et le téléverse. Demander un
   devis qu'on a en main est une marche pour rien.
2. **Validation du devis par le demandeur** (il confirme le devis reçu).
3. **Validation par le N+1** — le responsable hiérarchique réel (`Employee.managerId`, à défaut le
   responsable du département), pas un rôle générique.
4. **Validation par le PDG *ou* le Super Admin** — **l'un des deux suffit** : exiger les deux
   ajouterait une attente sans ajouter de contrôle.
5. **Validation de l'information médicale**, qui déclenche la **demande de visa publicitaire**.

Ensuite, **trois chantiers en parallèle** — et non l'un après l'autre : le **bon de commande**
(téléversé), la **demande de paiement** (enclenchée par le demandeur, qui repart dans le circuit
normal, centre de paiement compris) et le **visa publicitaire**. Le dossier n'est **terminé** que
lorsque les trois le sont ; c'est `allTracksDone` qui le dit, pas quelqu'un qui coche.

**La visibilité** : `seesFullCircuit(user)` → **Super Admin et PDG uniquement**. Les autres voient
**leur** marche et l'état d'avancement, pas l'enchaînement complet ni qui a validé quoi.

- **Module PUR** : `src/lib/promo-material/circuit.ts` (`PROMO_STEPS`, `PROMO_TRACKS`,
  `initialStep`, `canValidate`, `seesFullCircuit`, `tracksOpen`, `allTracksDone`, `pendingTracks`,
  `progress`, `waitingOn`) + `circuit.test.ts` (**23 tests**).
- **Actions** : `lib/actions/promo-circuit-actions.ts`. Migration `20260824160000_promo_short_circuit`.

### Matériel promotionnel — le stock : catalogue, magasin, achats, visites, événements, comptages (§118.164–168)

> **Les cinq étapes sont livrées.** (1) Le socle : catalogue, magasin, ce que chacun a en main, ce qui est en
> route (§118.164). (2) La demande d'achat piochée dans le catalogue, avec **plusieurs actions par ligne de
> devis et de BC** (conception, impression…), et la facture qui fait entrer au stock ce qui est reçu
> (§118.165). (3) Le bloc « Matériel remis » de la visite, déduit du stock du délégué (§118.166). (4) Le poste
> « Matériel du stock » des demandes Ad & Pro (§118.167). (5) Les comptages, les alertes, le tableau de bord et
> les propositions de refonte (§118.168). Chaque étape s'est branchée sur le registre de mouvements sans le
> refaire : aucun autre fichier que l'écrivain unique n'écrit un mouvement.

**Décisions de la Direction (01/10/2026).** Le magasin central est géré par **la directrice du département
marketing** ; le **Super Admin** peut tout gérer, modifier et supprimer ; le **délégué confirme la
réception** de ce qu'on lui envoie ; le **directeur des opérations** a la **vue globale** du stock et la
**gestion du matériel de ses équipes** (les superviseurs sous lui et leurs KAM).

**Le catalogue** (`/stock-promotionnel/catalogue`, module `PROMO_CATALOG`) — ce qu'on PEUT commander : **les supports**,
posés par la migration `20261215090000_catalogue_supports` (§118.173), chacun sous une référence **fixe** `CAT-0001` (quatre chiffres AU MOINS, jamais au plus). Le Super Admin
le tient et l'ouvre **en lecture ou en écriture, personne par personne**, dans Administration › Accès.
Trois **familles**, trois comportements : **consommable** (une quantité qui baisse, des lots datés),
**durable** (ne périme pas), **numérique** (un lien et une période de validité, aucune quantité). Un
article « existe par produit » (fiche posologique, aide de visite) exige son produit à l'entrée en stock.
Un article qui a servi ne se supprime pas : la corbeille le **refuse avant le clic** et nomme l'archivage ;
il ne passe pas non plus vers ou depuis « numérique ».

**Le stock** (`/stock-promotionnel`, module `PROMO_STOCK`, sous-module à part du pôle Marketing depuis le 08/10) — une quantité ne se saisit **jamais** : elle
est la somme des **mouvements**, par article, par **lot** et par **détenteur** (le magasin central, ou une
personne). Un article de stock = (société, article du catalogue, produits) : « Fiche posologique —
Nivolex » et « — Trastuzex » sont deux stocks.

- **Lots** : chaque entrée crée un lot daté (coût, fin de validité). Une sortie prend toujours le lot qui
  **expire le plus tôt** ; un lot **périmé ne se distribue plus** — il se déclare détruit (perte), et
  c'est lui qui part en premier. La validité est **inclusive** (valable jusqu'au 1er : distribuable le 1er).
- **Transferts confirmés** : une dotation, un transfert entre collègues ou un retour au magasin quitte
  l'envoyeur au départ et reste **« en route »** — chez personne — jusqu'à ce que **celui qui reçoit**
  confirme. C'est une **attestation** (« je l'ai entre les mains ») : personne ne la donne à sa place,
  pas même le Super Admin, qui peut en revanche **annuler** le transfert. Reçu en partie : la quantité
  réelle et un **motif obligatoire**, l'envoyeur est prévenu, et le manquant n'est retiré à personne une
  seconde fois. Refus (motif obligatoire) ou annulation : tout revient à l'envoyeur, au même lot. Au
  **troisième jour** sans confirmation, une relance — **une seule** — part vers celui qui doit confirmer.
- **Rien ne s'efface** : une erreur s'**annule** (Super Admin) par son exact inverse, l'original reste
  lisible ; une annulation qui creuserait un lot sous zéro est refusée et le dit. L'**inventaire
  d'ouverture** se pose une fois par article et par détenteur ; ensuite, un écart se règle par une
  **correction** (au magasin : sa gestionnaire ; chez une personne : le Super Admin).
- **Demandes** : un délégué demande au magasin ; le magasin la **sert** (une dotation pré-remplie, que
  le délégué confirme) ou la **refuse avec un motif** ; seul son auteur l'**annule**. Servir **prend** d'abord la
  demande par une écriture conditionnelle, AVANT tout mouvement (lot D1b) : annulée ou servie entre-temps, rien ne
  part, et le refus dit le geste qui reste — « Doter » sur la ligne de l'article si le matériel a déjà été remis ; si
  le magasin ne peut pas servir, tout s'annule et la demande redevient ouverte.
- **Deux dotations simultanées** qui dépassent le magasin : une passe, l'autre est refusée — le solde ne
  devient jamais négatif (verrou par article, soldes relus en base).

| Qui | Ce qu'il voit | Ce qu'il fait |
|---|---|---|
| **Super Admin** | Tout | Tout — entrée manuelle, inventaire d'ouverture, annulation de mouvement, corbeille, comptages à tout le monde, refontes — sauf confirmer une réception ou saisir un comptage à la place de quelqu'un |
| **Directrice de la Direction Marketing** (la cheffe, lue sur l'organigramme) | Vue globale + **tableau de bord** | Le **magasin** : doter, servir et refuser les demandes, confirmer les retours, corriger l'inventaire du magasin, **saisir le comptage du magasin**, fiches, lots et supports numériques ; **retenir ou écarter les refontes** proposées |
| **Directeur des opérations** (rôles « Directeur des Opérations » et « Direction des opérations », lus comme la même fonction — §118.157) | Vue globale + **tableau de bord** | Déplacer le matériel **de ses équipes, à l'intérieur de ses équipes** (ou le rendre au magasin) — la personne touchée est prévenue ; **faire compter** une personne de ses équipes, toute son équipe ou le magasin, **une fois ou régulièrement** (par famille) |
| **Superviseur** (National Sales) | Son stock et celui de son équipe (organigramme + KAM des gammes qu'il supervise) | Son propre stock — il **voit** celui de ses KAM, il n'en dispose pas |
| **Délégué / KAM** | Son stock | Confirmer ses réceptions, transférer à un collègue, rendre au magasin, déclarer une perte, demander du matériel ; **remettre en visite** (bloc « Matériel remis ») ; **saisir ses comptages** ; **proposer la refonte** d'un support durable |
| **Finances, Directeur Général, autres membres de la Direction Marketing** | Vue globale | Lecture (et leur propre stock, s'ils en ont en main) |

**Les vues** : *Mon stock*, *Mon équipe*, *Magasin*, *Vue générale* — chacune n'apparaît que si la règle
l'ouvre, et l'écran arrive d'abord sur ce qui attend la personne (une réception à confirmer passe avant
tout). Ce qu'une personne ne peut pas voir n'est pas **chargé**, pas seulement masqué. L'écran ne calcule
aucun droit : il appelle les **mêmes** prédicats que les actions (`promo/stock-acces.ts`).

**La reprise de l'historique** : chaque article de l'ancien écran reçoit **son** article du catalogue (aucune
fusion sur la ressemblance des noms), et ses mouvements entrent dans un lot « historique repris » au
magasin — le solde après migration est le solde d'avant, au mouvement près.

**Adam** : aucun de ces gestes ne lui est offert (classés EXCLUDED, refusés par le chemin générique) —
chacun atteste un fait physique, et Adam est en pause.

- **Règles PURES** : `lib/promo/catalogue.ts` (familles, références, validation), `lib/promo/stock.ts`
  (lots, validité, ordre de sortie, allocation, réception en partie), `lib/promo/stock-acces.ts` (qui peut
  quoi, et les phrases de refus) + leurs tests.
- **Écrivain UNIQUE** : `lib/promo/stock-ecriture.ts` (verrou par article, soldes en base, lots, transferts,
  annulations) ; cliquet `stock-registre.test.ts` (aucun autre fichier n'écrit un mouvement, aucun mouvement
  n'est modifié ni supprimé).
- **Chargeur** : `lib/queries/promo-stock.ts` (faits, équipe, page) ; **actions** :
  `lib/actions/promo-stock-actions.ts`, `lib/actions/promo-catalogue-actions.ts` ; **relance** :
  `lib/promo-stock-rappels.ts` (appelée par le battement) ; **écrans** : `app/(app)/stock-promotionnel/` et
  `app/(app)/stock-promotionnel/catalogue/` ; **adresses** : `lib/chemins/stock-promo.ts` (socle) — les anciennes
  (`app/(app)/promo-material/{stock,catalogue}/page.tsx`) ne sont plus que des escales qui redirigent.
- **Bancs** : `promo-stock-flow.test.ts` (24 cas par les vraies actions, acteurs SANS vue globale),
  `promo-stock-demande-course.test.ts` (servir une demande pendant qu'elle change),
  `e2e/stock-promo.spec.ts` (navigateur, bureau et téléphone). Migration `20261208090000_stock_promo_socle`.

#### Étape 2 — un achat entre au stock par sa FACTURE, ligne à ligne (§118.165)

- **La demande se pioche dans le catalogue** : par article, ses produits et un commentaire, autant d'articles
  qu'on veut ; seul le demandeur (ou la Direction en suppléance) la compose, et elle ne bouge plus une fois les
  devis demandés — l'assistante fait chiffrer ce qui a été demandé.
- **Chaque ligne de devis et de BC porte son ACTION** — conception, impression, fabrication, achat, location,
  livraison, installation, autre. C'est elle qui décide du stock : une impression, une fabrication ou un achat
  reçus **entrent au magasin** ; une conception, une livraison, une location sont simplement « faites ». La
  conception d'un **support numérique** est le support : reçue, elle pose son lien au stock. Le BC nomme l'action
  devant la désignation (« Impression — Fiche posologique Nivolex »).
- **La facture reprend les lignes du BC** : quantité et prix se corrigent pour coller au papier et l'écart se
  voit, mais on ne facture jamais plus que ce qui reste à facturer. Le total se **calcule** (même arithmétique que
  le devis) ; le total **imprimé** se saisit à part et contrôle la saisie à un dinar près.
- **La réception** : le demandeur coche ce qui est arrivé (le Super Admin en suppléance) — un lot entre au
  magasin au coût de la facture, la directrice est prévenue ; deux clics simultanés ne font qu'un lot. Annuler une
  réception la contre-passe, et se refuse si une partie est déjà sortie du magasin.
- **Le paiement attend la réception.** Une ligne non livrée ne se paie pas ; y **renoncer** est explicite, écrit
  et définitif — la quantité renoncée reste facturée, elle ne se refacture pas ailleurs. Une facture d'avant le
  détail ligne à ligne se paie comme avant.

#### Étape 3 — le matériel remis en visite sort du stock du délégué (§118.166)

- Un bloc **« Matériel remis »** dans le rapport de visite, la visite imprévue et la saisie rapide de « Ma
  journée » — **un seul module serveur** pour les trois portes (`lib/promo/remises-visite.ts`). Il ne propose que
  ce que le délégué a **en main**, distribuable séparé du périmé.
- **Au-delà du solde, la visite est BLOQUÉE**, et rien n'est écrit — ni la visite, ni ses produits, ni la remise.
  La remise sort du stock du **délégué de la visite**, même quand un superviseur rapporte à sa place.
- **Corriger n'est pas recompter** : dans les 48 h, seuls les articles dont la quantité change sont repris
  (l'ancienne remise contre-passée en entier, même prise sur deux lots), et un rapport renvoyé à l'identique
  n'écrit rien. Un support numérique se **présente** : une utilisation comptée, aucun stock retiré.
- La vue **« Remis aux médecins »** du stock donne l'historique par médecin, net des corrections, à ce que chacun
  a le droit de voir. Une remise ne s'annule pas depuis le stock (le refus nomme le rapport de visite).

#### Étape 4 — le matériel du stock d'un événement Ad & Pro (§118.167)

- Un poste **« Matériel du stock »** sur un sponsoring, un événement ou un congrès : **sans argent** (aucun
  montant, aucun BC, aucune facture), sa nature ne change que sur un brouillon vierge.
- **Demandée** (la liste ne bouge rien au magasin) → **réservée à l'accord** (la quantité quitte le magasin, lot
  le plus tôt périmé d'abord ; au-delà du distribuable, l'accord est refusé en entier) → **confirmée après
  l'événement** : un consommable dit combien a été remis, un durable est **prêté** — rendu, abîmé ou perdu, la
  somme doit faire le compte — et **le reste revient au magasin** par la même écriture.
- Du matériel réservé **bloque** le retrait du poste, la clôture de la demande, la corbeille et le transfert d'un
  congrès — chacun en nommant le remède. Confirmer : le demandeur, le magasin, la Direction ou le Super Admin.

#### Étape 5 — comptages, alertes, tableau de bord, refontes (§118.168)

- **Comptages** (vue « Comptages ») : le directeur des opérations fait compter une personne de ses équipes, toute
  son équipe ou le magasin (avec la vue globale), sur les consommables, les durables ou tout ; **une fois** (avec
  une échéance) ou **régulièrement** (chaque semaine, mois, trimestre ou semestre, à 8 h, sans rattrapage ni
  empilement). Seul **celui qui détient** saisit — chaque article du registre doit avoir sa ligne, « 0 » compris ;
  l'écart se lit au moment de la saisie et devient une **correction** au registre, qui porte le comptage. À chaque
  déclenchement, l'autorité de l'auteur est **relue** : sinon la récurrence se met en pause, avec son motif.
- **Alertes** (battement, une fois l'heure) : rupture, sous le seuil, péremption à 30 jours, périmé encore en
  main, support numérique à renouveler, envoi en route depuis 7 jours, comptage en retard. Chacune part **une
  fois**, à l'entrée dans l'état, à la personne concernée — **une notification par personne** — et repart si
  l'état revient.
- **Tableau de bord** (vue « Tableau de bord » — directrice marketing, vue globale, Super Admin) : la valeur du
  stock (les unités sans coût comptées à part), ce qui est sorti sur 90 jours (remis aux médecins, en
  événements, pertes, écarts de comptage), les plus distribués, les **articles dormants** (avec leur total), les
  alertes en vigueur.
- **Refontes** : quiconque voit le stock propose de refaire un support **durable** (une proposition ouverte par
  personne et par article) ; la directrice marketing (ou le Super Admin) la **retient** ou l'**écarte** avec un
  mot. Retenir ne commande rien : la commande suit le circuit d'achat.

**Fichiers des étapes 2 à 5.** Règles PURES : `lib/promo-material/achats.ts`, `lib/promo-material/actions-fournisseur.ts`,
`lib/promo/remises.ts`, `lib/promo/reservations.ts`, `lib/promo/comptages.ts` (+ leurs tests). Serveur :
`lib/promo/remises-visite.ts`, `lib/promo/comptages-ecriture.ts` (sous verrou, par l'écrivain unique),
`lib/promo-stock-comptages.ts` (récurrences et alertes, appelées par le battement), chargeurs
`lib/queries/promo-achats.ts`, `lib/queries/promo-remises.ts`, `lib/queries/promo-stock-alertes.ts`. Actions :
`lib/actions/promo-demande-actions.ts`, `lib/actions/promo-execution-actions.ts`, `lib/actions/promo-comptage-actions.ts`,
`lib/actions/ad-pro-item-actions.ts`. Écrans : `app/(app)/promo-material/[id]/articles-card.tsx`,
`app/(app)/medical/ma-journee/materiel-remis.tsx`, `components/ad-pro/materiel-stock.tsx`,
`app/(app)/stock-promotionnel/{stock-medecins,stock-comptages,stock-tableau}.tsx`. Bancs :
`promo-achats-flow.test.ts`, `promo-remises-flow.test.ts`, `ad-pro-stock-flow.test.ts`, `promo-comptage-flow.test.ts` ;
parcours navigateur contre le build de production `e2e/stock-promo-sorties.spec.ts` (visite au téléphone, visite
bloquée, remis aux médecins, demande d'achat, réception, matériel d'un sponsoring) et
`e2e/stock-promo-comptages.spec.ts` (comptage demandé, saisi au téléphone, refonte proposée puis retenue).
Migrations `20261209090000_stock_promo_achats`, `20261210090000_stock_promo_visites`,
`20261211090000_stock_promo_evenements`, `20261212090000_stock_promo_comptages`,
`20261213090000_stock_promo_refonte_unique`. Aucun de ces gestes n'est offert à Adam (EXCLUDED, raison écrite).

### Rejeu de session — rembobiner ce qu'une personne a fait

Le support reçoit « ça ne marche pas » : sans page, sans heure, sans manipulation. Le rejeu répond à
la seule question utile — **qu'est-ce qui s'est passé, dans l'ordre, juste avant l'erreur**. On ouvre
la session, le **curseur est déjà posé sur la première erreur**, et la lecture automatique respecte
le **rythme réel** (accéléré ×4, silences plafonnés) : on voit l'hésitation, les allers-retours, les
trois clics sur le bouton qui ne répond pas.

⚠️ **Ce n'est pas une vidéo.** Un navigateur ne peut pas filmer l'écran sans autorisation explicite
ni indicateur visible — c'est une garantie du navigateur lui-même, pas un réglage qu'on désactive.
Ce sont les **ACTIONS** qui sont enregistrées (pages, clics, champs remplis, envois, erreurs), comme
le font LogRocket ou FullStory, et cela suffit à reproduire un bug.

⚠️ **Aucune valeur de champ n'est lue**, nulle part : ni dans le navigateur, ni à l'envoi, ni côté
serveur — on ne touche jamais à `.value`. Les champs **mot de passe, secret, jeton, IBAN, RIB, CVV,
carte** et les champs **cachés** sont écartés **entièrement**, avant même leur libellé : savoir
qu'une personne a tapé dans « mot de passe » est déjà de trop. Les libellés sensibles (montant,
salaire, compte, NIF) sont conservés **sans leur valeur** : on sait QU'elle a rempli « Montant »,
jamais COMBIEN. Les messages d'erreur passent par un filet qui retire **adresses e-mail, numéros
longs et jetons**. Le masquage est **refait côté serveur** par la même fonction : un client modifié
ne peut pas faire entrer ce qu'il veut dans un journal que le support relira.

**Réservé au Super Admin** — pas au PDG, pas aux RH. C'est un outil de diagnostic technique ;
l'élargir en ferait un outil de surveillance. L'existence de l'enregistrement se déclare par le
**règlement intérieur**, pas par un voyant à l'écran.

- **Module PUR** : `src/lib/replay/capture.ts` (`fieldIsRecordable`, `isSensitiveLabel`,
  `cleanLabel`, `scrubDetail`, **`makeEvent` — la porte d'entrée unique**, `coalesce`,
  `describeEvent`, `stamp`, `firstErrorIndex`) + `capture.test.ts` (**20 tests**, dont le masquage).
- **Capture** : `components/layout/session-recorder.tsx` (monté dans `app/(app)/layout.tsx`, envoi
  par `sendBeacon` — il survit à la fermeture de l'onglet et ne retarde jamais une page ; un échec
  est silencieux). **Réception** : `app/api/replay/route.ts` (répond **204 quoi qu'il arrive**).
- **Console** : `app/(app)/admin/replay/{page,replay-viewer}.tsx`. Modèle `SessionEvent`, migration
  `20260824170000_session_replay`.

### Recrutement — de la demande d'un directeur jusqu'à l'intégration

*(Titre historique : depuis le 07/10, n'importe qui peut demander — voir « Qui peut demander ».)*

**Modèles** : `RecruitmentRequest` (référence `REC-AAAA-NNN`, entité, département, demandeur, poste, effectif,
`contractType`, `salaryMin`/`salaryMax`, dates, missions, compétences, justification, `stage`, note et date de
clôture) · `RecruitmentApproval` (`order`, `approverId`, `status`, `reason`, `decidedAt` — unique par
`(requestId, order)`) · `RecruitmentInfoRequest` (question / réponse / auteurs / dates) · `RecruitmentCandidate`
(identité, source, notes, `status`, traces de présélection / sélection / entretien, `employeeId` unique).
Enums `RecruitmentStage` · `RecruitmentApprovalState` · `RecruitmentCandidateStatus` ; `ContractType.CONSULTING`.
Depuis le 07/10 (migration `20270115100000_recrutement_suivi_canaux`) : `RecruitmentRequest.futureManagerId` (le N+1
de la future recrue), `RecruitmentFollower` (`requestId`, `userId`, `addedById` — unique par couple) et
`RecruitmentChannelPost` (`channel`, `status` PREPARE…, `content`, `url`, `error`, `publishedAt`/`publishedById` —
unique par `(requestId, channel)`).

**Place dans le menu (07/10)** : **module RH à part entière** (Pôles › Administration, `NAVIGATION` dans
`lib/labels.ts`) — il n'est plus un sous-menu de Mon Équipe ; ses accès se règlent dans la console comme les autres.

**Étapes** : `CHAIN` → `HR_REVIEW` ⇄ `INFO_REQUESTED` → `SOURCING` → `ONBOARDING` → `CLOSED`
(`REJECTED` / `CANCELLED` en sortie ; `RETURNED` — « À corriger » — quand la chaîne ou les RH la renvoient à son
demandeur). Le **pipeline des candidats** est porté par les CANDIDATS
(`RECEIVED` → `SHORTLISTED` → `SELECTED` → `INTERVIEWED` → `HIRED` / `DECLINED`), pas par la demande :
plusieurs personnes avancent en parallèle à des vitesses différentes, et une demande qui porterait un seul état
« en entretien » ne saurait pas dire de qui elle parle.

**Qui peut demander** : **tout le monde** depuis le 07/10 (Direction : « n'importe qui peut demander un nouveau
recrutement »). `recruitmentAccessFor` (`lib/rbac.ts`, PURE) rend toujours un accès, posé par `getAccess` en
**élargissant** (`grantImplicit` — un rôle qui accorde davantage n'est pas rétréci, un **blocage de la console prime**) :
les RH (UPDATE sur `RH`) → module entier, portée `ALL` ; qui dirige un département → VIEW/CREATE/UPDATE/UPLOAD/EXPORT,
portée `ASSIGNED` ; **tout autre compte → VIEW + CREATE + UPLOAD, portée `ASSIGNED`** (demander, joindre sa fiche de
poste, voir ce dont on est partie — rien d'autre).

**La chaîne** : bâtie par `getManagementChain` à la soumission, puis **figée** — une réorganisation en cours de
route changerait sinon les validateurs d'une demande déjà partie. Le demandeur est écarté de sa propre chaîne.
**Elle monte jusqu'au DG** (07/10) : si aucun maillon n'est le sommet (`isTopManagement`), le premier sommet actif —
**DG, puis Direction, puis Super Admin** (`ORDRE_DU_SOMMET`) — est ajouté en dernière marche
(`completerJusquAuSommet`, `lib/recruitment/request-flow.ts`) ; un demandeur sans fiche employé part donc directement au
sommet. **Le DG qui conclut la chaîne** (sa validation fait passer la demande aux RH) **désigne le N+1 de la future
recrue et au moins une personne en charge du suivi**, tous comptes actifs — exigé côté serveur dans
`decideRecruitmentStep`, pas seulement à l'écran ; le N+1 intermédiaire n'a rien à désigner. À l'intégration, le N+1
désigné devient le manager de la fiche (`Employee.managerId`, par SA fiche employé ; sans fiche, l'organigramme).
Le suivi et le futur N+1 voient la demande (`recruitmentScope`), **écrivent au fil** (`commenterDemandeRecrutement`,
tant qu'elle vit) et reçoivent les **notifications d'étape** comme le demandeur (jamais l'auteur du geste ; un échec
de notification ne défait pas le geste).
La direction générale (`isTopManagement`) peut trancher à n'importe quelle marche ; les marches d'en dessous
passent alors en **`SKIPPED`**, jamais en `APPROVED` — et la fiche écrit « n'a pas été consulté ». Un refus
clôt la chaîne, à n'importe quelle marche — et se rouvre, motif à l'appui (voir plus bas).

**Les RH** : `askRecruitmentInfo` renvoie la demande en `INFO_REQUESTED` (elle **quitte leur file** tant que la
réponse n'est pas venue, sinon ils rouvriraient chaque jour un dossier inchangé) ; `answerRecruitmentInfo` ne
la leur rend qu'une fois **toutes** les questions répondues ; `openRecruitmentSourcing` ouvre le poste.

**Les candidats** : `addRecruitmentCandidate` (RH) ; `moveRecruitmentCandidate` porte tout le pipeline en une
action — même question, mêmes droits, donc pas quatre actions qui divergeraient. La **présélection appartient
au demandeur** ; la **sélection à la direction générale**, et `canSelectCandidate` autorise un candidat
**présélectionné OU non** : la présélection est un avis, pas un tri éliminatoire opposable au dernier décideur.

**L'intégration** : `onboardRecruitment` crée la fiche employé pré-remplie depuis la demande (poste, direction,
entité, contrat, dates, borne basse de la fourchette) et depuis le candidat. **`needsOnboarding(contract)` est
faux pour un CONSULTING** : la demande se clôt sans fiche — un consultant est un intervenant externe, et
l'inscrire à l'effectif fausserait la masse salariale, les congés et l'organigramme.

**Corriger, rouvrir, annuler l'embauche (audit 360°, R14 — §118.192).** Un refus n'est plus terminal : la
demande se **renvoie pour correction** (étape `RETURNED`, motif exigé, par qui peut trancher la marche ou par
les RH), son demandeur la **corrige et la renvoie** sur un formulaire pré-rempli (« ce qui a changé » exigé) —
elle revient à la même marche, ou repart de la première si le besoin pesé a été relevé (`changementsMateriels`) —,
les RH ou le sommet la **rouvrent** (`reouverture` : la marche qui a refusé, les RH, ou le poste rouvert) et
**annulent une embauche** avant sa fiche. Chaque écriture d'étape est conditionnelle sur l'étape lue ; l'histoire
va au fil de la demande (« Historique de la demande »).

**La diffusion de l'offre (07/10)** — carte « Diffusion » de la fiche (`recrutement/[id]/diffusion.tsx`) : « les
canaux s'affichent et les RH décident le ou lesquels ». Porte de chaque geste : `abilities().diffuse` (RH ou sommet,
demande validée — chez les RH ou poste ouvert) **ET** `peutPublierOffres`. **Site** : l'offre `JobPosting` (seule
source de vérité de ce canal, `publierOffreSiteDuRecrutement` → `enregistrerOffre`) ; **LinkedIn** : un post
**préparé** en un clic (`preparerPostLinkedIn` — Luna rédige selon l'entité, schéma strict, ~20 s, sinon post de
secours écrit sans modèle ; il ne dit que ce que portent la demande validée et l'offre PUBLIÉE — rémunération et
avantages seulement s'ils sont dans l'offre), la personne le publie elle-même par le lien de partage puis le **marque
publié** (`marquerCanalPublie`) — aucune API, on ne prétend jamais avoir publié ; **Emploitic** :
`envoyerOffreEmploitic` répond « non configuré » tant que `EMPLOITIC_API_KEY` manque (point d'extension, aucun appel
inventé) ; « Autre ». Pastilles : Préparé · Publié le … · Retiré · Échec. Brain signale un **recrutement validé non
diffusé** au-delà de 3 j (`RiskSetting.recruitmentUnpublishedDays`).

**Accès** : `recruitmentViewer` / `recruitmentScope` (`lib/recruitment/access.ts`) — la même règle pour la liste
et pour la fiche. Un CV et une fourchette de rémunération sont des **données personnelles** : avoir le module ne
suffit pas, il faut être partie à la demande (auteur, validateur, RH, direction, **suivi désigné par le DG, futur
N+1**). Types d'entité `RECRUITMENT_REQUEST` (fiche de poste) et `RECRUITMENT_CANDIDATE` (CV) dans
`lib/entity-access.ts`.

**Fichiers** : `lib/recruitment/request-flow.ts` · `lib/recruitment/access.ts` · `lib/recruitment/diffusion.ts`
(PUR : canaux, états, post LinkedIn) · `lib/recrutement-diffusion.ts` (hors domaines : appelle le fournisseur) ·
`lib/actions/recruitment-actions.ts` · `lib/actions/recrutement-diffusion-actions.ts` · `app/(app)/recrutement/`
(tests `recruitment/suivi-diffusion.test.ts`).

### Site web Adventum — l'ERP publie les offres d'emploi et les articles

L'ERP est la **source de vérité** et **pousse** vers le site public (adventumdz.com) par son API de contenu. La
liaison marche **dans les deux sens** (§118.159) : le site **renvoie** à l'ERP les candidatures déposées par les
visiteurs, et **recharge** ses contenus depuis l'ERP à chaque démarrage. Le contrat complet vit dans le dépôt du site
(`docs/ERP-INTEGRATION.md`, `docs/openapi.yaml`).

- **Une écriture = un `PUT`** sur `/api/v1/jobs/{externalId}` ou `/api/v1/posts/{externalId}`, où `externalId`
  est l'**identifiant de l'ERP** — donc la clé d'idempotence : rejouer ne crée jamais de doublon, et rien n'est à
  stocker en retour. Une suppression est un `DELETE` ; un `404` sur un `DELETE` compte comme fait. Authentification
  `Authorization: Bearer <clé>` (la clé ne passe jamais dans une adresse) et
  `X-Adventum-Signature: sha256=<HMAC du corps exact>` sur **toute** requête dès qu'un secret est posé — un `GET` ou un
  `DELETE` signe la **chaîne vide**. C'est la règle que le site applique (mesuré dans son `lib/api-auth.ts`, alors que
  son propre contrat disait « `PUT` seulement »), et l'ERP applique la MÊME aux appels du site.
- **La clé, c'est l'ERP qui la fabrique** (§118.159) : « Générer la clé » (Super Admin) crée la clé et le secret,
  les scelle en base (`SiteWebCle`, jamais affichés une fois actifs) et montre UN bloc de trois lignes
  (`ERP_API_KEY`, `ERP_WEBHOOK_SECRET`, `ERP_BASE_URL`) à coller dans l'environnement du site sur Render. La clé
  reste **en attente** tant que le site ne l'a pas : l'ERP la lui **présente** (chaque minute pendant 30 min, puis
  toutes les 10 min jusqu'à 24 h, puis toutes les heures — le site gratuit s'endort) et la **promeut** dès que le
  site l'accepte, ou dès que le site s'en sert pour appeler l'ERP. L'ancienne clé publie jusque-là : **aucune
  coupure** ; un `401` sur l'ancienne fait présenter la nouvelle au lieu de s'arrêter. La clé de l'environnement
  (`ADVENTUM_API_KEY`) reste un repli, valable tant qu'aucune clé de l'ERP n'est active.
- **Les candidatures du site entrent dans l'ERP** (§118.159) : le formulaire des pages carrières les envoie à
  `POST /api/site-web/v1/candidatures` (clé + signature du corps ; idempotent sur l'identifiant du site ; CV ≤ 5 Mo,
  PDF/Word/ODT reconnu à ses **octets**, empreinte vérifiée ; consentement exigé). Celle d'une offre dont le poste est
  **ouvert** (`SOURCING`) entre d'elle-même dans le recrutement comme **candidat**, CV en pièce ; les autres —
  spontanée, offre inconnue, poste pourvu — attendent dans **Recrutement › Candidatures du site** avec la RAISON, et
  les RH les rattachent, les classent ou les effacent (droit à l'oubli : ligne ET fichier). Le site ne les garde que
  le temps de les envoyer.
- **Le site se recharge depuis l'ERP** (`GET /api/site-web/v1/contenus`, signé sur la chaîne vide) : les corps
  exacts que la file enverrait, recalculés depuis la base. Un hébergement **sans disque** (plan gratuit de Render) ne
  perd donc plus rien à un redémarrage — le disque persistant n'est plus une condition de mise en service.
- **L'audience du site** (Direction, 07/10) : le site inclut `<script src="https://<ERP>/api/site-web/v1/audience.js" defer>`
  (balise à copier dans Administration › Site web (connexion), encart « Mesure d'audience »). Le script envoie pages
  vues, clics (Postuler, `tel:`, `mailto:`, WhatsApp, externes, téléchargements, `data-adventum-track`) et temps passé
  à `POST /api/site-web/v1/audience` — seule route PUBLIQUE de `v1/` qui écrive : porte = l'**origine** du site
  (`porteAudience`), 120 événements/min par IP, validation stricte, écriture dans `SiteAnalyticsEvent` seule (migration `20270115110000_site_audience` ; cliquet
  `liaison-portes.test.ts`). Sans cookie : `visitor` = sha256(sel du jour + IP + agent), ni IP ni agent gardés. Tableau
  de bord `/site-web/audience` (onglet « Audience », droit de VUE du module) ; purge à 13 mois par le battement.
  Code : `lib/site-web/audience-calc.ts` (PUR), `audience-collecte.ts`, `audience.ts` (requêtes groupées),
  `audience-script.ts` ; format détaillé : `docs/site-web-audience.md`.
- **La santé du site** (`GET /health`, une fois l'heure, ou « Vérifier la connexion ») dit à l'écran ce que le site
  dit de lui-même : clé reconnue, adresse de l'ERP connue, envois signés, candidatures en attente d'envoi, disque de
  secours. Un nouveau `bootId` (le site a redémarré) déclenche un rapprochement immédiat.
- **La file** (`SitePublication`, une ligne par contenu) : l'action serveur écrit et met en file, elle n'attend
  jamais le site. Trois corrections rapides font UNE ligne dont la version monte ; un envoi réussi ne confirme que
  la version qu'il portait. **Réessais** sur erreur réseau, délai dépassé (10 s), `429` et `5xx` : 1 s, 5 s, 30 s,
  2 min, 10 min, puis l'échec est **dit** (une seule notification) à qui a publié ; le `Retry-After` du site est
  honoré, plafonné à une heure. **Jamais de réessai sur un `4xx`** : le contenu est en cause, il faut le corriger.
- **Disjoncteur** : un `401` ou une redirection mettent la **configuration** en cause — tous les envois s'arrêtent,
  les Super Admins sont prévenus une fois, aucune tentative n'est consommée, et le bandeau de `/site-web` nomme la
  cause. Une clé corrigée le lève d'elle-même ; « Vérifier la connexion » (`GET /health`) le lève si le site
  reconnaît la clé ; « Lever le blocage » est réservé au Super Admin.
- **Rapprochement quotidien** (le battement, `runScheduledJobs`) : `GET /jobs` et `GET /posts` sont comparés à ce
  que l'ERP VEUT, recalculé depuis la base. Ce qui manque ou diffère repart, une suppression perdue est rejouée, le
  conforme est confirmé. Un contenu présent sur le site mais **inconnu de l'ERP est nommé, jamais supprimé**. Un
  contenu que le site a refusé tel quel n'est pas renvoyé tant qu'il n'a pas changé. Un article dont l'adresse est
  prise par un article du **dépôt** du site est signalé (le site afficherait le sien). Une heure après un échec, un
  nouvel essai ; `SITE_WEB_RECONCILIATION=off` le coupe. « Rapprocher maintenant » depuis **Administration ›
  Site web**.
- **Offres d'emploi** (`JobPosting`) : préparées depuis une demande de recrutement (carte « Offre sur le site » de
  la fiche), elles en reprennent l'intitulé, la direction, le contrat, les missions et les compétences —
  **jamais** la rémunération ni la justification. Une offre n'est **visible que tant que le poste est ouvert** :
  préparée avant, elle part en ligne quand les RH ouvrent le poste ; pourvu, clos, refusé ou annulé, elle repasse
  **tout de suite** en brouillon sur le site (chaque changement d'étape du recrutement la resynchronise).
- **Articles** (`BlogArticle`) : Markdown structuré en `##` — un `# Titre` est refusé en nommant sa ligne, à
  l'écran avant l'envoi comme dans l'action. Aperçu sans HTML brut, sommaire, temps de lecture, longueur idéale de la
  description.
- **La liaison vit dans la console, Super Admin seul** (§118.160) : la clé (générer, abandonner, voir le bloc), la
  vérification, le rapprochement à la demande, la levée du blocage et ce que le site dit de lui-même sont sur
  **Administration › Site web** (`/admin/site-web`), gardés par UN prédicat (`peutGererLaLiaison`, le rôle PRINCIPAL
  Super Admin). Trois prédicats écrits pour la même chose avaient fini par dire trois choses : « Rapprocher
  maintenant » s'ouvrait à quiconque publiait un article. `/site-web` garde les CONTENUS et dit en une phrase si
  les envois partent — sans geste de liaison, que ceux qui publient n'ont pas à faire.
- **Ce que le site avait écrit lui-même est repris dans l'ERP** (§118.160) : les articles de son dépôt
  (`content/blog/*.md`), ses offres d'exemple, les offres saisies dans son administration. Le rapprochement lit
  `GET /repository` du site, crée les enregistrements de l'ERP (`SiteReprise` garde l'origine et la clé côté site),
  puis les pousse par la file ordinaire — l'article avec `replacesFile` : la version de l'ERP REMPLACE le fichier,
  à la même adresse (une adresse déjà partagée n'est pas cassée). La règle tient en une phrase : **ce qui est en ligne
  reste en ligne, ce qui ne l'est pas ne le devient pas** — une offre d'exemple est reprise en BROUILLON (publier un
  poste est une décision de recrutement). Supprimer un article repris le retire du blog ET laisse une pierre tombale :
  le site la reçoit avec ses contenus à chaque redémarrage (`replacedFiles`), sans quoi le fichier du dépôt
  reviendrait. Tant que le site ne sait pas rendre son dépôt (ancienne version), l'ERP réessaie toutes les heures et
  l'écran le dit, avec le geste Render qui rattrape. Une pastille « Repris du site » suit chaque contenu repris.
- **« Rédiger avec l'IA »** (§118.160) : sur un article comme sur une offre, une consigne de quelques phrases et l'IA
  remplit les champs EXACTS du formulaire (titre, description, corps en `##`, catégorie, mots-clés ; intitulé,
  département, lieu, contrat, expérience, résumé, missions, profil, ce que nous offrons) sous un schéma imposé au
  fournisseur. Rien n'est enregistré ni publié : le texte revient dans le formulaire, la personne le relit, le
  corrige — ou clique « Annuler la rédaction » — puis enregistre. Un champ que l'IA rend vide garde la valeur saisie.
  **Ce que le modèle reçoit** : la consigne et les champs du formulaire, lus clé par clé dans l'action — jamais la
  rémunération ni la justification de la demande de recrutement. **Ce que la relecture DIT** : une liste bornée au
  maximum du site, une description hors de la longueur idéale, un titre « # » ramené en « ## », un type de contrat
  inconnu laissé vide. Mêmes droits que l'écriture (module « Site web » pour un article, RH ou direction pour une
  offre) ; bascule « Rédaction du site » dans le Centre de contrôle IA ; chaque appel au journal d'usage, une
  réponse inexploitable comptée comme un échec de la fonction.
- **Droits** : module `SITE_WEB` (Direction, Direction Générale, Direction Marketing — et le Super Admin) pour les
  articles et l'exploitation ; les **offres** suivent la règle du recrutement (RH en écriture, ou la direction). La
  demande de recrutement se lit sous `recruitmentScope(user)` — à la préparation (`?demande=`) comme au rattachement
  d'une offre neuve : les deux règles disent aujourd'hui la même chose, et c'est la lecture bornée, pas la
  coïncidence, qui tiendra le jour où l'une s'élargit.
- **Adam n'y touche pas** : publier sur le site public ne se rattrape pas, et lever un disjoncteur désarme un
  garde-fou — les huit gestes sont classés EXCLUDED, et le chemin générique d'Adam **lit** désormais cette
  décision avant de proposer comme avant d'exécuter.
- **Configuration** : rien à poser côté ERP dans le cas normal — la clé vient de « Générer la clé », l'adresse du
  site vaut `https://adventumdz.com` par défaut (mesurée : `www` y redirige), l'adresse de l'ERP écrite dans le bloc
  vient de `APP_URL`, sinon de l'adresse par laquelle le Super Admin est arrivé. `ADVENTUM_BASE_URL`,
  `ADVENTUM_API_KEY` et `ADVENTUM_WEBHOOK_SECRET` restent lus en repli. Aucune clé n'est affichée une fois active :
  l'écran montre une **empreinte**.

**Mise en service — un seul geste** (la carte « Connexion au site » d'**Administration › Site web** le dit pas à pas) : « Générer la
clé » ; dans Render, service **du site** → *Environment* → *Add from .env* → coller le bloc → *Save, rebuild, and
deploy* — pas *Save and deploy*, qui redémarre la version déjà construite, peut-être l'ancienne (documentation de
Render). C'est tout : l'écran passe à « Relié » de lui-même, et dit si le site tourne encore sur une version qui ne
reçoit pas les candidatures (sa santé n'annonce pas `applications`), avec le geste qui rattrape : *Manual Deploy* →
*Deploy latest commit*. Puis, pour vérifier : publier une offre de test, postuler avec un
CV de test, la voir arriver dans *Recrutement › Candidatures du site*, et tout supprimer. Reste une décision humaine :
le sort de `ADMIN_PASSWORD` côté site — le retirer laisse l'ERP seul maître du contenu.

**Banc à deux serveurs** (`npm run bench:site-web`, après un `npm run build` ici et dans le dépôt du site) : l'ERP et
le site en `next start` sur ce poste, reliés par le VRAI bloc lu sur l'écran — génération, reconnaissance sans autre
geste, offre en ligne, candidature avec CV relu octet pour octet dans l'ERP, redémarrage du site sur un disque vide,
candidature spontanée, santé à l'écran, reprise des articles du VRAI dépôt du site (servis aux mêmes adresses, un
second rapprochement ne repousse rien), modification et suppression d'un article repris (qui ne revient pas après un
redémarrage sur disque vide), suppression de l'offre. `BANC_SABOTAGE=sans-secret` démarre le site avec le bloc collé
en partie : le banc doit tomber, et il tombe.

Code : `lib/site-web/{contrat,markdown}.ts` (PURS — le contrat du site, la lecture du Markdown), `config.ts`,
`transport.ts` (la seule fonction qui appelle le site, gardée par `exigerSortieAutorisee` — sauf un hôte LOCAL, nommé),
`file.ts`, `contenus.ts`, `reconciliation.ts`, `acces.ts`, `etat.ts`, `cles.ts` (génération, scellement, présentation,
promotion), `liaison.ts` (l'entretien du battement), `entrant.ts` (la porte des appels du site), `candidatures.ts`
(réception, tri, effacement), `reprise-lecture.ts` (PUR — le dépôt du site lu et traduit), `reprise.ts` (la reprise
écrite), `redaction.ts` (PUR — consigne, schéma imposé, relecture) ; l'appel au modèle `lib/redaction-site-ia.ts`
(hors du domaine : un domaine ne parle pas aux fournisseurs) ; routes `app/api/site-web/v1/{candidatures,contenus}` (hors session, gardées par
`authentifierLeSite`) et `app/api/site-web/candidatures/[id]/cv` ; actions
`lib/actions/{site-web,offres-emploi,candidatures-site,site-web-redaction}-actions.ts` ; écrans
`app/(app)/site-web/**`, `app/(app)/admin/site-web` (carte « Connexion au site », reprise), `app/(app)/recrutement/candidatures`, carte « Offre sur le site » de
`app/(app)/recrutement/[id]` ; composants `components/site-web/*`. Modèles `JobPosting`, `BlogArticle`,
`SitePublication`, `SitePushAttempt`, `SiteReconciliation`, `SiteWebCle`, `SiteCandidature`, `SiteReprise` ;
migrations `20261202090000_site_web_adventum`, `20261203090000_site_web_liaison`, `20261204090000_site_web_reprise`,
`20261207090000_ia_redaction_site` (`AiSetting.siteWebAiEnabled`).

### Congés — l'intérimaire qui tient la place

**Modèle** : `LeaveRequest.standInId` · `standInStatus` (`StandInStatus`) · `standInModules` ·
`standInDecidedById` · `standInDecidedAt` · `standInNote`.

**Le circuit** : l'**absent désigne** (`proposeStandIn`) et choisit les modules délégués — l'écran ne propose que ce
qu'il peut réellement prêter (`modulesPretables`), et l'action refuse le reste en **nommant** le module ; les **RH
valident** (`decideStandIn`, refus motivé obligatoire). Toute nouvelle désignation **repart en attente** : l'accord
donné pour quelqu'un ne s'hérite pas. Les RH ne peuvent pas valider un intérim **qui ne transmettrait rien** — cela
laisserait croire que la place est tenue. **La décision des RH est gardée** (lot E4) : une décision illisible est
refusée ; l'écriture est conditionnelle (un intérim modifié ou tranché entre-temps ne se tranche pas une seconde
fois) ; celui qui valide n'est ni l'absent ni l'intérimaire désigné, et un droit RH tenu par intérim ne valide pas
d'intérim ; la fiche est bornée à la société, comme la liste ; un congé terminé, ou un absent sans compte actif, est
refusé. Validé, l'intérimaire est prévenu avec un lien vers **Mon espace**, et la notification dit **quand**
l'intérim s'ouvrira (`annonceDeValidation`) : elle n'annonce plus des validations ouvertes des semaines avant le
congé.

**La fenêtre** : `isDelegationActive` exige quatre conditions — congé accordé, intérimaire désigné, RH d'accord,
date du jour dans `[startDate, endDate]`. La comparaison se fait au **jour**, pas à l'instant : un congé du 3 au
10 couvre le 10 tout entier. La délégation s'**éteint seule** ; personne n'a rien à révoquer, et c'est ce qui la
rend sûre là où un accès ouvert « pour cette fois » ne se referme jamais.

**La portée** : `NEVER_DELEGATED` exclut la souveraineté du Super Admin (`ADMIN`, `ADVENTUM_BRAIN`,
`PROCESS_INTELLIGENCE`), les espaces **personnels** (`DRIVE`, `MESSAGING`, `WORKSPACE`, `NOTIFICATIONS` — remplacer
quelqu'un n'est pas lire son Drive privé), les **sièges** (`PAYMENT_CENTRE`, `VALIDATION_CENTRE`, `AD_PRO_CENTRE`,
`CHIEF_OF_STAFF` — un rôle ou une désignation nominative les donne, et l'intérim ne prête aucun rôle) et les portes
ouvertes à tous (`MY_TEAM`, `DIRECTORIES`). `delegatedActions` prête ce que l'absent **DÉTIENT** — la matrice de son
rôle **PRINCIPAL** ∩ son accès **attribué** (`accesAttribue`, la règle même de `getAccess` : rôle, « autre rôle »,
console) — et retire `DELETE` : un module bloqué par l'administrateur, un accès personnalisé plus étroit que le rôle,
un module retiré de la plateforme, un compte fermé ne se prêtent pas (`detenteurPourInterim`). Une délégation ne
crée pas un droit, elle en prête un, et un remplaçant ne détruit pas.

**Effets** : les modules délégués sont ajoutés dans `getAccess` (recalculé à chaque requête, donc éteint le
lendemain du congé ; un module retiré n'y entre par aucune porte implicite) et **se disent** : un **bandeau
d'intérim** dans la coque (`components/layout/interim-banner.tsx`, lu sur `access.interims` — aucune lecture de plus)
nomme qui l'on remplace, jusqu'à quand et les modules prêtés ; un droit prêté ne s'accorde pas à son tour
(`estPrete` : ouvrir l'accès d'un tiers à une entité, fermer un compte — `lib/hr/depart.ts` —, désigner ou valider
un intérim) ; `decideValidation` accepte l'intérimaire sur les étapes du validateur absent
(`droitSurLEtape` : le validateur, le Super Admin ou l'intérim — jamais sur sa propre demande ; le jugement des
pièces lit la même règle), les portes qui nomment une PERSONNE (N+1 d'un congé ou d'une formation, validateur d'un
achat, réviseur et N+2 d'un plan de tournée) reconnaissent l'intérimaire par la même lecture des intérims en cours
(`activeStandInsFor`, déclinée en `auNomDeQui`, `actsForUser` et `standInForUserIds`), et le journal **dit** que la
décision a été prise au titre d'un intérim. Les étapes adressées à un RÔLE ne se délèguent pas (décision).

**Fichiers** : `lib/hr/stand-in.ts` (+ 36 tests) · `lib/hr/stand-in-resolve.ts` ·
`lib/actions/stand-in-actions.ts` · `components/hr/stand-in-panel.tsx` · `components/layout/interim-banner.tsx` ·
sections de `/rh/conges` et `/mon-dossier` ; banc de bout en bout `lib/hr/interim-prete-flow.test.ts`.

### Moteur de workflow dynamique (Ad & Pro — 4 catégories)

Le circuit Sponsoring / Prise en charge internationale / Prise en charge nationale / Événements est piloté par un **moteur 100 % dynamique**
éditable en no-code par le Super Admin (Administration → Circuits de validation) :

- **Modèles** : `WorkflowDefinition` (1 par catégorie) → `WorkflowStep[]` (position, slug, titre, `actorRoles[]`,
  `actorScope` ROLE|ASSIGNEE|GLOBAL_VIEW|REQUESTER, `powers[]` APPROVE|REJECT|ASSIGN|SET_AMOUNT|SET_CATEGORY|COMMENT,
  `assignRole`, `requireAmount/Category/Note`, `emitDeclaration/ExpenseOrder`, `notifyRoles[]`, `optional`,
  `confidential`, `autoSkipMaxAmount` (seuil DZD anti-bureaucratie), `autoApproveIfRequester`, `legacyStatus`) →
  `WorkflowInstance` (unique par entityType+entityId, `currentSlug`, statut
  IN_PROGRESS|RETURNED|APPROVED|REJECTED|CANCELLED, `finalSlug` + `skippedSlugs` — le parcours figé —, `amount`,
  `budgetCategoryId`, `assigneeId`, `claimedAt` — la prise d'un geste) → `WorkflowStepEvent`
  (CREATE|APPROVE|REJECT|OPINION_AGAINST|RETURN|RESUBMIT|SKIP|AUTO_SKIP|AUTO_APPROVE_REQUESTER|APPEAL|REOPEN|CANCEL|COMMENT).
- **Règles clés** : un REJECT **non terminal** = `OPINION_AGAINST` (avis défavorable) et **le flux continue**
  (l'assignation reste requise) ; seul le refus de l'**étape qui tranche** (la dernière de la route — Direction
  Marketing par défaut, la Direction des opérations sur la demande de la Direction Marketing elle-même) est
  éliminatoire. Un acteur qui peut refuser peut aussi **RENVOYER** pour correction (`RETURN` → statut `RETURNED`,
  « À corriger », motif exigé) : le demandeur corrige et resoumet, la demande revient à cette étape — sauf une porte de
  montant franchie seule que le montant corrigé ne franchit plus (`etapeDeReprise`, §118.186) ; un geste à la fois
  (`claimedAt`). Sur une étape intermédiaire `SET_AMOUNT`, l'avis défavorable peut porter un **montant révisé
  OPTIONNEL** (« revu à la hausse ») → consigné comme montant proposé, en `amount` de l'instance et sur l'événement
  `OPINION_AGAINST`. Le moteur **projette les statuts legacy** sur les entités (les listes/badges existants continuent
  de fonctionner). Les étapes `confidential` (aucune dans la graine) sont **caviardées** pour le demandeur, jamais
  l'étape qui tranche. La **méta du workflow** (rôles/portées/pouvoirs) reste réservée au **Super Admin** ;
  l'**historique complet** est visible des spectateurs **privilégiés** : vue globale (Super Admin, Direction), la
  personne désignée sur l'instance, le National Sales et tout porteur du rôle Direction Marketing (`canViewHistory`).
  Les autres n'y ont pas accès.
- **Anti-bureaucratie — 3 mécanismes par étape (`src/lib/workflow/engine.ts`, tous tracés)** :
  1. **Saut manuel** (`SKIP`) — un acteur habilité peut **sauter une étape intermédiaire** avec **raison obligatoire**
     (tracée + notifiée à l'étape suivante). Jamais sur une désignation ni la décision finale.
  2. **Seuil de montant** (`autoSkipMaxAmount`, → `AUTO_SKIP`) — si le montant de travail (montant fixé à une étape
     « Fixer un montant », à défaut l'**estimation du demandeur**) est **≤ le seuil**, l'étape est **franchie
     automatiquement**. Les petites demandes ne remontent pas toute la chaîne.
  3. **Auto-accord si autorité** (`autoApproveIfRequester`, → `AUTO_APPROVE_REQUESTER`) — si le **demandeur détient
     déjà le rôle/la portée** d'une étape, elle est **approuvée automatiquement en son nom** (on ne fait pas valider
     à quelqu'un sa propre demande — généralisation de l'« originator skip » du Centre de validation).
  Gardes communes : `AUTO_SKIP` / `AUTO_APPROVE_REQUESTER` ne franchissent **jamais** une désignation (ASSIGN), une
  émission financière (déclaration info médicale / ordre de dépense) ni la **décision finale** — un humain tranche
  toujours l'accord définitif. Ces mécanismes se **cascadent** (settleAutoSkips) et sont **opt-in** dans le builder
  no-code (défaut inactif ⇒ aucun changement de comportement). Le détecteur de friction d'Adventum Brain repère les
  étapes qui **ne filtrent rien** (100 % d'`APPROVE`) et les files bloquées.
- **Routage à la création (l'entrée selon le rang du créateur)** : personne n'approuve une demande qu'il émet
  lui-même. `src/lib/workflow/origin.ts` (`adProOriginRank`, `adProInit`) lit la branche de `parcoursAdPro` — plus
  aucun sélecteur dans les formulaires : un **KAM** entre au préliminaire (`AWAITING_PRELIMINARY`) ; le rang le plus
  haut (**Direction**, **DG**, **Directeur des Opérations**, **Super Admin**, vue globale comprise) entre directement
  chez la **Direction Marketing** (`AWAITING_FINAL`, l'étape qui tranche) ; tous les autres — **National Sales**,
  **Direction Marketing** et **Manager Promotion médicale**, demandeur ordinaire — entrent par la **porte du DG**
  (`PRELIMINARY_APPROVED`). Le statut legacy de départ pilote à la fois les actions historiques et le moteur
  (`positionFromLegacy`). Câblé dans `createSponsoring`, `createCongressRequest`, `submitEventForApproval`.
- **Le PARCOURS (09/2026)** : `src/lib/workflow/parcours.ts` (module PUR) porte la table des **branches** (§118.142) :
  l'ENTRÉE, la BORNE de sortie (`WorkflowInstance.finalSlug`) et le **TAMIS** des étapes que la demande ne traverse
  pas (`skippedSlugs`), **figés à la naissance de l'instance** (le parcours est un fait de la demande, pas du poste
  qu'occupe son auteur aujourd'hui). La sortie entre dans `nextStepAfter`, l'unique endroit où « y a-t-il une étape
  après celle-ci ? » se décide : la terminalité, la projection de l'accord définitif, le refus de sauter ou de franchir
  automatiquement la décision finale et la levée du caviardage en découlent sans être écrits une seconde fois. Une
  **émission financière déclarée sur une étape non atteinte — queue coupée OU tamis — est HÉRITÉE** par l'étape qui
  conclut (`etapesNonAtteintes`) — sans quoi une demande sortirait approuvée, budget accordé en base, et Finance ne
  recevrait rien. Les **pouvoirs d'argent** suivent la MÊME liste : l'étape qui conclut, si elle n'a aucune
  configuration d'argent à elle, hérite « fixer le montant » et « fixer la catégorie » — et leurs exigences — des
  étapes non atteintes (`argentEffectif`) ; le moteur, qui juge l'approbation, et l'écran, qui propose les champs,
  lisent la même réponse (`lectureDeLApprobation`). La Direction des opérations fixe donc le montant et la
  sous-catégorie d'une demande de rang 2 — sans quoi elle sortait approuvée sans montant, donc sans ordre de dépense
  ni déclaration à l'information médicale.
- **Fichiers** : `src/lib/workflow/engine.ts` (avance/renvoi/refus/projection ; ⚠ `Event` n'a pas `updatedById` — il
  est retiré avant update), `parcours.ts` (les branches : entrée, borne, tamis — pur), `renvoi.ts` (le renvoi pour
  correction, pur), `defaults.ts` (seed paresseux de la colonne vertébrale préliminaire → dg → final → marketing, et la
  pré-validation de la tenue d'un sponsoring), `origin.ts` (rang du créateur → étape de départ),
  `pouvoirs-argent.ts` (les pouvoirs d'argent qu'hérite l'étape qui conclut une route coupée — pur),
  `src/lib/personnes/roles-vente.ts` (socle : qui est un KAM, qui est Direction Marketing),
  `src/lib/queries/workflow.ts` (vue caviardée, bornée au parcours de l'instance),
  `src/components/workflow/workflow-panel.tsx` (panneau runtime), builder sous `/admin/workflows`.
  Bascule de l'existant : migration `20261106090000_adpro_direction_marketing` (la graine ne s'applique QUE là
  où aucune définition n'existe — la changer seule aurait laissé la production sur l'ancien circuit).

### RH — pré-remplissage IA du contrat + congés (acquisition & consommation)

- **Contrat → fiche employé (IA)** : `analyzeEmployeeContract` (`src/lib/actions/hr-actions.ts`, gate `RH:CREATE`)
  fait **OCR Mistral** (`ocrDocument`, fr/en/ar) puis **Claude** pour renvoyer un objet de champs (nom, poste,
  type de contrat ∈ CDI/CDD/INTERIM/STAGE/FREELANCE/OTHER, dates ISO, salaire, NIN, CNAS…). **Ne persiste rien** :
  les valeurs pré-remplissent le formulaire (prop `analyze` de `CreateRecordButton`, re-montage des champs par
  `key`), le RH corrige puis enregistre via `createEmployee`.
- **Acquisition automatique — +2,5 j/mois** : `accrueMonthlyLeave()` (`src/lib/scheduled.ts`, appelée par
  `runScheduledJobs`, ~1×/min). Marqueur `Employee.leaveAccruedThrough` (« YYYY-MM » Alger). Idempotent : crédite
  `2,5 × nombre de mois` écoulés puis avance le marqueur ; **amorçage sans rétro-crédit** (marqueur posé au mois
  courant, solde préservé). **Modif manuelle** : champ `leaveBalanceDays` de la fiche (`updateEmployee`).
- **Consommation du solde** : à l'approbation d'un **congé annuel** — via `LeaveRequest`/`decideLeave` (Mon espace)
  **ou** via `HrDocumentRequest` type `ANNUAL_LEAVE` passé à READY (`processHrRequest`) — le solde est **débité une
  fois** (verrou `balanceAppliedAt` côté demande RH). Les congés **sans solde / exceptionnel / maternité** ne
  débitent pas.
- **Demandes RH par type** (`requestHrDocument`) : les types congé (`ANNUAL_LEAVE`, `UNPAID_LEAVE`, `SPECIAL_LEAVE`,
  `MATERNITY_LEAVE`, `SICK_LEAVE`) exigent `periodStart` + `periodEnd` (jours calculés, calendaires inclusifs) ;
  `EXCEPTIONAL_EXIT` n'exige que `periodStart` ; `EXPENSE_REPORT` exige `expenseMonth` + `expenseAmount` + au moins
  une pièce ; `HR_INTERVIEW` sa
  négociation de date. Formulaire type-aware : `src/app/(app)/mon-dossier/request-controls.tsx`.

