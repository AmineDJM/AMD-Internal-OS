## 🔄 Workflows critiques

> Depuis le **moteur de workflow no-code**, le circuit Ad & Pro ci-dessous est la **configuration PAR DÉFAUT**
> (seed automatique) : le Super Admin peut le remodeler étape par étape dans Administration → Circuits de
> validation. Détails d'implémentation : [référence détaillée](#-référence-détaillée-des-circuits--mécanismes-transverses).

### Ad & Pro & Événements — circuit de prise en charge

Le **même** circuit sert le **Sponsoring**, les **Congrès internationaux/nationaux** et les **Événements** :

**Le parcours dépend de QUI demande — trois branches décidées par la Direction** (22/09/2026 ; le sponsoring d'un KAM
précisé le 28/09/2026) **et deux garde-fous d'auto-arbitrage** — on ne tranche jamais sa propre demande
(`workflow/parcours.ts`) :

```
Demande d'un KAM (délégué médical)
   → NATIONAL SALES : approuve / refuse                                     ← son superviseur
   → [porte du DG : au-delà du seuil réglé — franchie seule en dessous]
   → (SPONSORING seulement) DIRECTION DES OPÉRATIONS : accord               ← décision du 28/09/2026
   → DIRECTION MARKETING : montant accordé + (sous-)catégorie budgétaire     ← elle TRANCHE
   → [Information médicale : déclaration du pharmacien (PRIM)]               ← uniquement si applicable
   → Ordre de dépense (un par poste quand l'opération en a) → centre de paiement → comptable

Demande du NATIONAL SALES lui-même
   → [porte du DG]
   → DIRECTION DES OPÉRATIONS : accord sur l'opération (SANS chiffrer)       ← le filtre au-dessus de lui
   → DIRECTION MARKETING : montant + catégorie                               ← elle TRANCHE

Demande de TOUT AUTRE demandeur
   → [porte du DG]
   → DIRECTION MARKETING : montant + catégorie                               ← DIRECT, elle TRANCHE

Demande de la DIRECTION MARKETING elle-même (ou du Manager Promotion médicale)
   → [porte du DG]
   → DIRECTION DES OPÉRATIONS : elle TRANCHE                                 ← on n'arbitre pas sa propre demande

Demande de la DIRECTION, du DG, du DIRECTEUR DES OPÉRATIONS ou du SUPER ADMIN
   → DIRECTION MARKETING : montant + catégorie                               ← DIRECT, sans porte du DG

   → (option, à tous les parcours) tierce personne impliquée via son espace + dossier auto (sans budget)
   → à chaque étape : approuver, refuser (avant l'étape qui tranche, un refus n'est qu'un avis défavorable),
     ou RENVOYER au demandeur pour correction — motif exigé ; resoumise, la demande revient à cette étape
```

> ⚠️ **La porte du DG est ORTHOGONALE aux branches** : franchie automatiquement (et tracée) sous le seuil réglé,
> elle vaut au-dessus pour tout demandeur — une rallonge d'un million ne se décide pas plus bas parce qu'elle vient
> d'en haut — **sauf le rang le plus haut** (Direction, DG, Directeur des Opérations, Super Admin, vue globale et
> rôle secondaire compris : `adProOriginRank` = 3), dont la demande va directement chez Direction Marketing : le DG
> est à ce rang, il n'y a personne au-dessus. Ce saut ne vaut que pour les quatre circuits configurables ; le visa
> du consulting et des « autres demandes » et l'étape `REVIEW_DG` du matériel promotionnel ne regardent que le montant.

> ⚠️ **Le BUDGET appartient à Direction Marketing** (ex-« Chef de produit »), plus à la Direction : montant
> accordé ET choix de la sous-catégorie budgétaire. La Direction des opérations valide **avant** elle — la demande
> du National Sales et le sponsoring d'un KAM —, sans chiffrer, et ne **tranche** que la demande de la Direction
> Marketing elle-même (et du Manager Promotion médicale), qu'on ne fait pas s'arbitrer : elle y fixe alors le montant
> et la sous-catégorie, que l'étape qui conclut une route coupée HÉRITE des étapes non atteintes (`argentEffectif`,
> `lib/workflow/pouvoirs-argent.ts` — seulement si elle n'a aucune configuration d'argent à elle) ; le moteur et
> l'écran lisent la même réponse (`lectureDeLApprobation`). Le sponsoring n'hérite rien : sa route conclut sur une
> tenue pré-validée, l'argent se fixant à la clôture.

> ⚠️ **Étape préliminaire réservée au National Sales**, et elle ne concerne QUE les demandes de KAM : lui seul
> a un superviseur national au-dessus de sa demande. Il ne DÉSIGNE plus personne — Direction Marketing est
> portée par un rôle, pas par une personne nommée.

> ⚠️ **Plus de « Référent Direction Marketing » à nommer sur une nouvelle demande** (22/09/2026 : « ça va
> DIRECT chez le directeur/directrice du département marketing »). Le menu ne conditionnait déjà plus rien et
> demandait au demandeur de désigner quelqu'un dans une direction qu'il ne connaît pas. Le CHAMP
> `productManagerId` survit, et il est de nouveau ÉCRIT : à la création d'un sponsoring ou d'une prise en
> charge, et à la soumission d'un événement, il reçoit le **référent de la gamme** quand la Business Unit de la
> demande en a **exactement un**, actif et porteur du rôle Direction Marketing (`referentAInscrire`, Force de vente ›
> Business Units, §118.144) — plusieurs n'en désignent aucun. La désignation **cible** sans rien accorder : l'étape
> qui tranche reste ouverte à tout porteur du rôle, qui reste prévenu.

> ⚠️ **Confidentialité : un AVIS, pas une DÉCISION.** Seule une étape que le Super Admin a marquée
> **confidentielle** est caviardée pour le demandeur — **aucune ne l'est dans la graine** (`defaults.ts`) — et jamais
> l'étape qui TRANCHE : sa décision EST la décision, le budget accordé et son commentaire sont visibles — un accord
> illisible n'est pas un accord (`queries/workflow.ts`).

> **LE PARCOURS EST UN TAMIS, plus une troncature.** Le circuit n'existe qu'en un exemplaire par catégorie ;
> ce qui change est l'ENTRÉE (`workflow/origin.ts`, selon le rang du créateur), la BORNE de sortie
> (`WorkflowInstance.finalSlug`) et le TAMIS (`WorkflowInstance.skippedSlugs`) — les deux derniers **figés à
> la naissance de l'instance**, pour qu'un changement de règle ou de poste ne réécrive pas une chaîne en cours.
>
> Deux champs et non un, parce qu'ils répondent à deux questions : la borne dit OÙ la chaîne s'arrête, le tamis
> ce qu'elle NE TRAVERSE PAS. Le tamis ne se déduit pas de la borne — un KAM et un demandeur ordinaire
> tranchent tous DEUX chez Direction Marketing (donc aucune borne) et ne traversent pourtant pas les mêmes
> étapes. Et aucun ordre d'étapes ne rend les trois tranches contiguës à la fois : un KAM traverse
> `preliminary` sans `final`, un National Sales `final` sans `preliminary`.
>
> La table des branches vit à un seul endroit : `src/lib/workflow/parcours.ts` (module pur), lu par la
> création, le moteur et la vue caviardée — trois lectures séparées finiraient par ne plus se correspondre.
> Une étape hors route n'est PAS « franchie automatiquement » : elle n'est pas SUR la route, donc rien n'est
> tracé à son nom. Et une émission financière portée par une étape sautée est **héritée par l'étape qui
> conclut** (lecture unique : « y a-t-il une suite ? ») — sans quoi la demande sortirait approuvée, budget
> accordé écrit en base, et Finance ne recevrait RIEN.
> Le **Sponsoring** ajoute l'**appel** : après la décision — sous la règle de la tenue, un REFUS (une tenue
> pré-validée ne se conteste pas : ses postes se discutent un à un) —, le demandeur peut faire appel, motif exigé →
> le circuit se rouvre sur l'étape qui a tranché, qui est prévenue (`reopenInstance`) ; la Direction et le Super Admin
> sont informés de tout appel. Pour les congrès/événements pris en charge, on saisit la **liste
> des personnes prises en charge** (avec pièces d'identité) et un **ordre de mission**. Les personnes **de la société**
> (accompagnant, délégué de référence) sont, depuis le 08/10, **invitées** depuis la carte « Équipe Adventum » : elles
> confirment ou déclinent dans **Mon espace › Mes missions**, où leur ordre de mission passe par le **N+1** puis les RH
> (→ [missions](#missions-ad--pro-reliées-au-profil-0810)).

#### Sponsoring — la tenue d'abord, l'argent à la fin (27/09/2026)

La Direction : « quand quelqu'un crée une demande, on ne lui demande pas un budget suggéré ou quoi : on lui demande
un **sponsoring demandé par le médecin** et un **sponsoring suggéré par le délégué**. Ce sponsoring s'ajoute
automatiquement dans un **poste** — on précise s'il est **direct** (versé à l'association) ou **indirect** (prise en
charge de prestations / de médecins). Une fois validée par le National Sales et la Direction des opérations, la
Direction Marketing **pré-valide ou refuse la tenue** de l'événement. Pré-validée, on passe aux **postes** (stand,
prises en charge…) : devis à l'assistante de direction, BC, factures. Une fois l'événement complété, la Direction
Marketing **valide tout, met chaque poste dans un budget, valide et clôture**. »

```
Création : demandé par le médecin + suggéré par le délégué + NATURE (direct / indirect)
   → le POSTE naît avec la demande : « Sponsoring direct (association) » ou « Sponsoring indirect
     (prise en charge) », chiffré au montant SUGGÉRÉ, la demande du médecin écrite dans le poste
   → le circuit de son demandeur — un KAM : National Sales PUIS Direction des opérations (28/09/2026) —
     et porte du DG au-delà du seuil
   → DIRECTION MARKETING : pré-valide ou refuse la TENUE — aucun montant accordé, aucun ordre global
        → statut « Tenue pré-validée — postes en cours » ; la déclaration PRIM part (estimation des postes)
   → POSTES : ajout (stand, billetterie, hôtellerie…), devis au secrétariat, décision poste par poste,
     BC → centre de validation Ad&Pro → émission → facture → paiement (centre de paiement)
   → VALIDATION FINALE ET CLÔTURE (Direction Marketing) : tout poste décidé, chaque poste accordé rangé
     dans un budget et chiffré → la SOMME des postes accordés devient le montant accordé → « Clôturée »
   → (si besoin) ROUVRIR, motif obligatoire → la demande repasse « pré-validée », ses postes se rouvrent
```

> ⚠️ **Qui clôture : celui qui a pré-validé la tenue — jamais le demandeur.** Par défaut la Direction Marketing ;
> sur une demande que la Direction Marketing a elle-même déposée, sa route s'arrête chez la Direction des
> opérations (§118.142) : c'est donc la Direction qui pré-valide ET qui clôture. Le Super Admin, toujours.
> Tout refusé est clôturable à **0 DZD** (la tenue a eu lieu, rien n'a été financé) ; aucun poste, non.

> ⚠️ **Clôturée, la demande est ARRÊTÉE, pas l'exécution.** Postes, montants, décisions et budgets sont figés
> (chaque refus nomme « Rouvrir la demande ») ; mais un BC déjà accordé s'émet encore, une facture se dépose, un
> paiement se règle — et le règlement d'un POSTE ne fait jamais passer la demande à « payée » (seul un accord
> global de l'ancien circuit se solde par son ordre). Une tenue pré-validée ne se TRANSFÈRE plus vers un autre
> module : ses postes resteraient accrochés à une demande close.

> ⚠️ **Ce qui ne change pas.** La règle ne vaut que pour le SPONSORING : congrès et événements gardent la décision
> à montant. Et l'issue se lit sur la CONFIGURATION de l'étape qui conclut (`workflow/issue-sponsoring.ts`) : une
> étape qui fixe un montant (`requireAmount` ou le pouvoir « Fixer un montant ») accorde de l'argent comme avant —
> un circuit qu'un Super Admin a remodelé garde son comportement, et la migration ne touche que l'étape encore à
> sa graine d'origine. Les demandes déjà APPROUVÉES restent approuvées, à leur montant.


#### Les postes d'une demande — un geste à la fois (2026-10)

« Ici c'est trop complexe : plus simple, plus séparé, plus lisible, moins de boutons » (Direction, 01/10). Chaque
carte de poste dit **ce qu'il est**, **ce qu'il coûte** (estimé, accordé, payé à, budget), **où il en est** (la
frise chiffré → Direction → budget → bon de commande → paiement) et **un seul geste** — celui de la personne qui
regarde — ou ce qu'on attend et de qui (`ad-pro/poste-etapes.ts`, pur). Les gestes secondaires (modifier, affecter
un montant, changer le budget, émettre sans BC, historique, retirer) vivent dans le menu « ⋯ », et les pièces et
demandes au secrétariat dans un dépliant « Pièces et demandes ».

- **Sponsoring indirect, réparti par nature.** « 1 000 000 DZD = 400 000 d'imprimerie + 600 000 d'hôtellerie » :
  « Répartir par nature » fait de chaque nature un poste (imprimerie, hôtellerie, billetterie, transport, traiteur,
  dîner, salle, stand, symposium, prestation…) qui se valide, se commande et se paie à part. La première nature
  garde l'identifiant du poste d'origine (ses pièces, ses demandes, son historique) ; les natures sœurs sont
  regroupées à l'écran (« Sponsoring indirect · total · n natures »). Un indirect non réparti **ne se soumet pas et
  ne s'accorde pas** ; il se refuse ou se renvoie en révision. Ajouter un sponsoring indirect le crée déjà réparti.
- **Médecin absent de l'annuaire.** Sous le choix des médecins, la case « Médecin non présent dans l'annuaire »
  ouvre une saisie libre (un nom par ligne) : les noms écrits **s'ajoutent** aux médecins cochés. Rien n'est créé
  dans l'annuaire.
- **Billetterie : les voyageurs.** Sur un poste « Prise en charge de la billetterie » : nom (suggéré parmi les
  médecins de la demande), trajet, dates d'aller et de retour, précisions, passeport (pièce du poste). Un nom
  suffit ; ce qui manque pour réserver est nommé sur la ligne. « Demander la réservation » ouvre un **sujet** pour
  l'assistante de direction (responsable si elle est seule, toutes participantes sinon), visible en bas de la fiche
  de la demande ; une seconde demande et tout changement de voyageur s'écrivent dans le même sujet. Un poste refusé
  ne se réserve pas.
- **Supprimer une demande Ad & Pro** (bouton « Supprimer la demande » sur la fiche, les sept natures) : le Super
  Admin, le directeur des opérations, la directrice marketing (lue sur l'organigramme). Jamais l'auteur ; un
  contrat de consulting passé aux RH, seul le Super Admin. La demande doit être visible de la personne. La fenêtre
  montre ce qui part avec ; tout est réversible depuis la corbeille.
- **Déposer un devis** (« Devis » dans les pièces liées) : seuls le **titre** et le **PDF** sont obligatoires — le
  fournisseur est facultatif. Un engagement, un bon de commande ou une facture exigent toujours leur partie.
- **On agit sur un poste d'une demande qu'on VOIT.** Chaque geste sur un poste (modifier, soumettre, décider,
  répartir, voyageurs, réservation, matériel du stock…) lit la porte de la fiche de sa demande (`canAccessEntity`,
  VIEW) en plus du droit du module : un délégué n'agit pas sur les postes du congrès d'un collègue (portée « ses
  lignes »), même avec un identifiant ; hors de sa portée, le poste est « introuvable ». Sponsoring et événements
  n'ont pas de portée de ligne : rien ne change pour eux.
- **Deux dépôts à la même seconde** reçoivent deux références : la création d'un sponsoring, d'un sujet et d'une
  demande de pièce recalcule sa référence sous collision (`createWithRetry`), comme le consulting, « autre demande »
  et le matériel promotionnel le faisaient déjà.

`src/components/ad-pro/items-panel.tsx` · `voyageurs-bloc.tsx` · `supprimer-demande.tsx` ·
`src/lib/ad-pro/{poste-etapes,repartition,repartition-ecriture,voyageurs,suppression}.ts` ·
`src/lib/queries/ad-pro-suppression.ts` · actions `repartirPoste`, `ajouterVoyageur`, `modifierVoyageur`,
`retirerVoyageur`, `demanderReservation`, `supprimerDemandeAdPro` · migration `20261217090000_ad_pro_postes_simples`.

#### Sept natures, une seule porte

**Sept natures, une seule porte.** Sponsoring, prise en charge internationale, prise en charge
nationale, événement, matériel promotionnel, **consulting** et **autre** : pour celui qui demande,
autant de façons de poser la même question. « Nouvelle demande » (`/ad-pro`) demande donc *ce qu'on
veut faire*, dans ses mots, et **le formulaire de la nature choisie s'ouvre sur place** — on ne
quitte plus Ad & Pro. Les CHAMPS restent ceux de la nature, et ce sont les **mêmes objets** que sur
son écran d'origine (`RecordForm`, `CongressRequestForm`, `CreateEventForm`), jamais des copies qui
divergeraient au premier champ ajouté. `lib/ad-pro/create-fields.ts` définit une seule fois les
champs lus par les deux portes d'entrée. On ne propose que les natures que la personne peut
réellement **CRÉER** : un formulaire refusé à l'enregistrement fait arriver le refus après la
saisie, au pire moment.

**Ce qu'une demande de sponsoring EXIGE (09/2026), et où l'exigence est tenue.** Demande du médecin
en **pièce jointe scannée (PDF ou Word)** — avec la mention « + Document original obligatoirement au
bureau du secrétariat » —, **médecin(s)**, **produit(s)**, **wilaya**, **spécialité (menu
déroulant)**, **type**, **budget demandé par l'intéressé**, **budget suggéré par le délégué**,
**importance stratégique**. L'écran les marque `required` ; **la garde est l'action serveur**
(`createSponsoring`), qui refuse en NOMMANT tout ce qui manque en une fois — un champ de formulaire
se forge, et l'écran n'est pas la seule porte (le chemin générique d'Adam poste la même action).
`type` et `strategicImportance` n'ont plus de valeur pré-remplie : une demande envoyée sans y
toucher sortait avec une nature et une priorité que personne n'avait décidées, et c'est sur elles
que l'arbitrage se fait. La liste des spécialités vient de `MedicalSpecialty` fusionné aux libellés
hérités des fiches médecins (`lib/ad-pro/pickers.ts`) — jamais d'une liste écrite à la main.

**Médecin(s) et produit(s) sur les SIX natures hors matériel promotionnel (09/2026).** Décision de
la Direction : « on doit pouvoir sélectionner un ou plusieurs médecins et un ou plusieurs produits
concernés ». Mesuré nature par nature avant d'écrire : le sponsoring et l'événement les avaient ;
les deux prises en charge avaient les médecins (par **identifiants** d'annuaire, que la fiche résout
en lignes de praticiens) et **aucun produit**, alors que la colonne existait des deux côtés sans
aucun lecteur ; le consulting et « autre demande » n'avaient **ni l'un ni l'autre**. Quatre natures
sur six. La décision vit désormais dans un `Record<AdProKind, …>` exhaustif
(`REFERENTIELS_PAR_NATURE`, `lib/ad-pro/create-fields.ts`) : une huitième nature **ne compile pas**
tant que personne n'a dit son cas, et le chargeur commun (`getAdProCreateData`) interroge cette
décision au lieu d'une liste de natures écrite à la main — c'est ainsi que l'événement s'était
retrouvé, sur SON écran, avec trois menus retombés en saisie libre en silence, alors qu'ils
fonctionnaient depuis le panneau d'Ad & Pro. Trois états et non un booléen : **OBLIGATOIRE**
(sponsoring, événement — la demande n'a pas de sens sans eux), **FACULTATIF** (les deux prises en
charge, le consulting, « autre » — « on doit POUVOIR sélectionner » n'est pas « on doit
sélectionner », et exiger un praticien sur un accompagnement réglementaire serait un refus à tort),
et une **exemption qui porte sa raison** pour le matériel promotionnel. Les deux prises en charge
GARDENT leur mécanisme par identifiants pour les médecins : le remplacer par un libellé joint serait
perdre une référence pour gagner une uniformité de nom.

**La gamme, et le champ requis dont le choix était JETÉ.** Le consulting et « autre demande »
posaient depuis toujours un menu « Business Unit » **obligatoire**, et ni le modèle ni l'action ne
l'avaient : le choix imposé au demandeur disparaissait, ce qui est pire qu'un champ absent — il fait
croire que la dépense est rattachée. Le formulaire des deux prises en charge, lui, ne l'envoyait
même pas alors que l'action le lisait déjà. Les quatre natures portent maintenant
`businessUnitId`, écrit par leur action, et la fiche d'une prise en charge **affiche** les produits
(une colonne que rien ne montre est du code mort). Le formulaire des prises en charge n'a plus
**deux** champs de spécialité — un menu de filtre sans nom et un texte libre nommé, qui obligeait à
choisir puis à retaper —, et sa liste vient de la fonction canonique.

**Un seul NOM de champ pour les six natures.** Le repli en saisie libre du produit s'appelait
`products` sur l'événement (le nom de SA colonne) et `product` sur le sponsoring (le nom de LA
SIENNE) : les deux marchaient, chaque action lisant la clé de son propre formulaire, et la sixième
aurait fini par lire celle de la cinquième. `CHAMPS_MEDECINS` / `CHAMPS_PRODUITS`
(`lib/ad-pro/pickers.ts`) portent les noms ; la LECTURE, elle, reste dans chaque action avec ses
clés littérales — un lecteur partagé inter-fichiers a été écrit puis retiré, parce que la dérivation
des contrats d'action ne lit pas les clés d'un délégué importé et que trois actions ont perdu leurs
quatre champs déclarés (mesuré sur l'artefact régénéré). C'est un cliquet
(`lib/ad-pro/referentiels.test.ts`) qui exige que les six emploient exactement ces noms.

**La Business Unit se DÉDUIT de l'auteur, et c'est aussi une garde** (`lib/ad-pro/business-unit-auto.ts`) :
un KAM par sa fiche force de vente, un superviseur national par la gamme qu'il supervise. La valeur
déduite **s'impose côté serveur** — le champ était un menu libre, un KAM de l'oncologie pouvait
poster la cardiologie et faire peser sa dépense sur le budget Ad&Pro d'une autre équipe. Un
superviseur de DEUX gammes n'en désigne aucune : la saisie redevient manuelle, et l'écran le dit.

**Un ÉVÉNEMENT exige la même chose qu'un sponsoring (22/09/2026), et le budget ferme une SECONDE
plainte.** Mesuré avant de corriger : seul le NOM portait `required`. La ville, la spécialité et les
produits étaient en saisie libre, il n'existait aucun champ pour les médecins, et le budget était
facultatif. Le formulaire lit désormais les **mêmes référentiels purs** que le sponsoring
(`ad-pro/pickers.ts`, `geo/algeria.ts`) : wilaya en menu déroulant, spécialité depuis
`MedicalSpecialty` + libellés hérités, **plusieurs médecins** de l'annuaire, **plusieurs produits**
au traitement réglementaire terminé, gamme déduite, et **budget obligatoire (> 0)**.

> ⚠️ **Le budget facultatif était la cause de « le DG n'a pas à valider en dessous du seuil ».** La
> chaîne, bout à bout : budget non saisi ⇒ `estimatedBudget` nul ⇒ le moteur lit un montant de ZÉRO ⇒
> `settleAutoSkips` refuse de franchir une porte de contrôle sur un montant inconnu ⇒ la porte du DG reste
> ouverte sur un événement de 80 000 DZD. Cette garde est JUSTE — on ne franchit pas une porte de contrôle
> sur un trou — donc le remède n'est pas de l'assouplir, c'est de rendre le budget obligatoire. **Les deux
> plaintes n'en faisaient qu'une.**

La garde est l'action serveur (`createEvent` **et** `updateEvent` lisent la même liste — exiger à la
création et laisser vider à la modification n'exige rien du tout), qui refuse en NOMMANT tout ce qui
manque en une fois. Le NOM garde sa garde propre, parce que `actions/contrat.ts` déduit
« obligatoire » d'un `if (!v)` lu dans le corps et ne sait pas lire une liste rendue par une
fonction : tout basculer l'aurait fait sortir `obligatoire: false` de l'artefact, et la carte de
confirmation d'Adam ne l'aurait plus demandé alors que l'action l'exige. Le STATUT, lui, ne se
saisit plus pendant qu'un circuit de prise en charge gouverne l'événement.

**Les CATÉGORIES de pièces jointes d'une demande Ad & Pro sont COMMERCIALES**
(`lib/ad-pro/doc-categories.ts`). Sur la fiche d'un événement, le menu de classement proposait
« CTD complet », « Module 1 », « Certificat GMP », « CPP » — la nomenclature d'un dossier
d'enregistrement de médicament, sur l'écran où l'on dépose une facture de traiteur. Cause : le
téléverseur n'y recevait AUCUNE liste, et son repli est la table `DOCUMENT_CATEGORY` entière, dont
la première entrée est `CTD_FULL`. Recensé : **six fiches du pôle, trois ne passaient rien**
(événement, consulting, « autre demande »), et le sponsoring portait une copie LOCALE identique mot
pour mot à celle des congrès. La liste est désormais unique — demande, convention, programme,
**devis**, **bon de commande**, **facture**, justificatif, photos, présentation, rapport
post-événement — et le **matériel promotionnel** garde la sienne (chaîne d'ACHAT : visa
publicitaire, bordereau, bon de livraison) : les fondre ferait proposer un visa publicitaire sur un
congrès. Un **cliquet** exige que tout `DocumentUpload` dont l'`entityType` est une entité du pôle
porte sa liste, et il s'arme sur le registre CANONIQUE des natures — une septième nature ajoutée
demain ne peut pas se retrouver sans liste, en silence.

**Les PIÈCES d'une fiche Ad & Pro vivent avec ce qu'elles justifient.** Le bloc « Documents »
générique a disparu des quatre fiches (sponsoring, prises en charge, événements) : on y déposait à
la main ce qui aurait dû être une pièce du circuit, si bien que la même facture existait comme
fichier posé là ET comme engagement dans Legal. « Engagements, factures et courriers liés »
(`components/shared/linked-records.tsx`) le remplace — chaque pièce liée montre SES documents,
ouvrables, renommables et supprimables en un clic — et la pièce de la demande elle-même garde un
emplacement **NOMMÉ** (« Demande(s) du médecin… »), parce que c'est le document que tout le circuit
lit. Les documents d'une pièce liée sont chargés **sous les droits de SON module** (Legal,
Courriers), jamais sous ceux de la fiche : `lib/ad-pro/pieces-liees.ts` calcule ces droits UNE fois
pour les quatre écrans. Un document Legal **existant** se rattache sans être recréé
(`lib/actions/ad-pro-rattacher-legal.ts`), sous DEUX droits — lire la pièce, modifier la fiche — et
un document déjà rattaché ailleurs n'est jamais déplacé en silence. **Le même geste existe en
conversation** (`legal_operation/link_record` et `unlink_record`) : la fiche se donne par sa
référence ou son intitulé, la désignation passe par le résolveur unique (`lib/cibles/resoudre.ts`,
donc la portée de l'écran) sur les six natures rattachables, et un nom porté par DEUX fiches — de
la même nature ou de deux natures différentes — ne rattache RIEN et fait préciser. Le matériel
promotionnel n'a pas d'entrée au registre d'entités : le refus nomme l'écran qui sait, au lieu de
deviner une clause de portée.

**Une DISCUSSION au bas de chaque demande du pôle — et il n'a fallu créer aucun mécanisme.**
Le modèle `Comment` (entité + identifiant + auteur + `editedAt`) est le fil canonique de l'ERP et
`components/shared/comment-thread.tsx` sait déjà l'écrire, le modifier et le supprimer. Recensé
avant de coder : **une** des sept natures le montait (le matériel promotionnel), les **six** autres
n'avaient aucun endroit où écrire « le devis est arrivé, on peut demander le BC » — donc cela
partait en messagerie, hors de la demande, et la référence se perdait. §118.71 à un contre six.
`components/ad-pro/discussion-card.tsx` monte le fil sur les sept, et le matériel promotionnel
**perd son montage local** : deux façons d'afficher le même fil auraient divergé sur la modération.
L'écrivain est **UNE** action (`lib/actions/ad-pro-discussion-actions.ts`) bornée aux sept entités
du registre canonique — un `entityType` libre en ferait une porte d'écriture sur toute entité de
l'ERP — et la garde est `canAccessEntity(…, "VIEW")`, par **enregistrement**, jamais par module :
mesuré, l'assistante de direction n'a pas le module `PROMO_MATERIAL` et voit pourtant le dossier
qui la concerne, donc le contrôle par module lui fermait un fil qu'elle a le droit de lire
(`addPromoComment` portait ce défaut et lit désormais la même garde). Modérer est
`canModerateEntity`, c'est-à-dire le droit de **modifier la fiche** : écrire un troisième prédicat
aurait fait une seconde vérité. **Le même geste existe en conversation**
(`legal_operation/comment_ad_pro`), par le résolveur unique et donc sous la portée de l'écran.

**Consulting** (`/consulting`, module `CONSULTING`) — un contrat n'est pas une demande qu'on
approuve puis qu'on oublie : c'est une relation qui court dans le temps. Le modèle porte les deux
parties (l'entité qui signe, le prestataire), la période, la rémunération **avec son rythme**
— 200 000 DZD par mois et 200 000 DZD pour la mission entière n'engagent pas la même somme —, les
tâches attendues (à part, parce que « ce qui reste à livrer » est une question qu'on pose au
contrat et qu'un paragraphe ne sait pas y répondre) et les pièces signées. Cycle de vie dans un
module pur (`lib/ad-pro/consulting.ts`, 24 tests) : brouillon → en validation → actif → **expiré**
ou **annulé** ; en validation, le validateur peut aussi le **renvoyer pour correction** (retour en brouillon chez
son porteur, qui corrige et resoumet — audit 360°, lot C4a). Les deux fins ne se confondent pas — la première a
produit ses effets jusqu'au bout, la seconde a été rompue — et une fin est **définitive** : rouvrir effacerait la
date à laquelle la relation s'est terminée. Refuser ou annuler exige un motif. Un terme dépassé se **signale**
(compteur et badge) sans rien basculer tout seul ; un contrat actif se **prolonge** (nouvelle fin plus tardive,
motif exigé, par qui peut valider — `prolongerConsultingContract`).

**Le pôle d'un contrat — Ad & Pro ou Ressources humaines (§118.150).** Un consultant engagé comme un
membre de l'équipe relève des RH, pas de la promotion. Le contrat porte donc un **pôle**
(`ConsultingContract.pole`, `AD_PRO` par défaut) qui décide **qui le voit et qui le gère** : le module
`CONSULTING` côté Ad & Pro, le module `RH` côté ressources humaines — à la fiche, aux actions, à la
garde par enregistrement, au registre (API et Adam), aux deux listes (`/consulting` et
`/rh/consultants`), à l'imputation d'un paiement et à l'aiguillage des bons de commande (Ad & Pro →
centre Ad & Pro ; RH → centre de validations). **Transférer** est un geste de la fiche (« Transférer
vers Ressources humaines », et le geste inverse), réservé à qui **modifie les DEUX modules** — par
défaut Super Admin, Direction et Directeur Général. Rien n'est perdu : référence, tâches, pièces,
validation et historique suivent ; la gamme, les praticiens et les produits restent sur la ligne
(lus seulement côté Ad & Pro). Ce qui **bouge** : une validation **en attente** au centre Ad & Pro
est retirée (une décision déjà prise reste, c'est de l'histoire), un contrat qui **entre** dans
Ad & Pro en attente de validation passe par le centre, un validateur désigné sans droit de valider
dans la nouvelle maison perd sa désignation (la Direction est prévenue), et les bons de commande
**en attente** qui en descendent changent de centre. Côté RH, un contrat de consultant se crée
aussi directement depuis RH › Consultants.

**Autre** (`/ad-pro/autres`, module `AD_PRO_OTHER`) — la case qui manquait. Sans elle, une dépense
de promotion inhabituelle se déclarait « en sponsoring » faute de mieux, et l'on perdait deux
choses : la lisibilité du sponsoring, qui se remplissait d'objets qui n'en étaient pas, et la trace
de la dépense, rangée sous une étiquette fausse. Circuit volontairement court — un demandeur, une
description **obligatoire** (c'est elle qui portera tout), une décision, un motif ; un refus se **resoumet** en
disant ce qui a changé (`resoumettreAdProOtherRequest`), et la demande se corrige par la porte commune du pôle.

### Impliquer une tierce personne (sans accès au module)

Sur un **sponsoring**, un **congrès** ou un **événement**, un acteur du circuit peut **impliquer une tierce
personne** (ex. l'assistante de direction) **même si elle n'a aucun accès au module** :

```
« Impliquer une tierce personne » (choix de la personne + message)
   → la personne reçoit une DEMANDE DE VALIDATION dans son espace
   → un DOSSIER DE SUIVI est créé automatiquement, indiquant DE QUEL événement il s'agit
        (SANS budget ni détail confidentiel) ; la demande pointe vers ce dossier (accessible),
        jamais vers la fiche de l'événement.
```

### Demander une pièce à quelqu'un (`/pieces`)

La pièce qui manque n'est presque jamais chez celui qui en a besoin : la facture est chez le
commercial, le devis chez l'assistante, l'attestation chez le comptable. On la réclamait par
message, et l'on perdait la trace de ce qu'on attendait, de qui, depuis quand — le dossier
bloquait sans que personne sache pourquoi.

Depuis un **poste de dépense** (et, par construction, depuis n'importe quel objet de l'ERP) :
on choisit la personne, on dit **ce qu'on demande en clair** (« la facture définitive de l'agence »,
pas « pièce n° 3 »), on fixe une échéance. Elle est prévenue, dépose une ou plusieurs pièces,
signale le dépôt ; on accepte, ou l'on **refuse en disant ce qui manque** — la demande repart alors
sur le même fil plutôt que d'obliger à tout recommencer (c'est le cas le plus fréquent).

- **L'accès vient du FIL, pas du module** : celui à qui l'on réclame une facture dépose sans avoir
  accès au pôle Ad & Pro. `canAccessEntity` tranche sur `DOCUMENT_REQUEST` avant tout contrôle de
  module — on ouvre la seule chose qui le concerne, et rien d'autre.
- **On n'accepte jamais sa propre pièce** : la demande existe précisément pour qu'un tiers confirme
  avoir reçu ce qu'il attendait.
- **Signaler un dépôt vide est refusé** : cela enverrait le demandeur chercher un fichier
  inexistant, et le fil repartirait pour un tour inutile.
- Le mécanisme est **générique** (`entityType`/`entityId`) — une seconde implémentation « spéciale
  poste de dépense » finirait par diverger sur la relance, l'accès ou le refus.

Règles dans `lib/doc-request.ts` (module pur, 20 tests) ; écrans `/pieces` (onglet de « Mon
espace » : ce que je dois déposer d'un côté, ce que j'attends de l'autre — l'un appelle une action,
l'autre une relance) et `/pieces/[id]`.

Depuis le même poste : **« Demander une validation »** — un ou deux validateurs choisis nommément,
et chacun peut à son tour en redemander une à quelqu'un d'autre. La transmission aux **Finances**
reste le circuit existant : demande de bon de commande → visa du centre Ad & Pro au-dessus du seuil des BC (en
dessous, directement) → émission par les Finances.

### Bureau du secrétariat — flux par demande

```
Demande (employé) — une demande par besoin, + participants (facultatif)
   → directement aux assistantes de direction (notifiées) — ni « Responsable » ni « Personne concernée »
   → 30 min : le demandeur peut encore MODIFIER (tous les champs saisis) ou SUPPRIMER sa demande
   → l'assistante « Commencer le traitement »  → le demandeur lit « En cours — chez l'assistante de direction »
   → « Fin du traitement » (achat : facture finale + imputation)  → « Traitée »
   (le demandeur est notifié aux deux pas ; « Annuler la demande… » et « Supprimer » restent)
```

**Refonte du bureau (maquette validée, 10/2026).** Tableau : tuiles-filtres (à traiter, en cours, en validation, en
paiement, en retard, terminées 30 j), raccourcis (notes de frais, courses, corbeille), colonnes « chez qui » et UN montant
(`montantDeLaDemande` — payé › imputé › facturé › engagé › validé › devis retenu › estimé, `secretariat/bureau.ts`). Fiche :
le geste suivant en tête (`gesteSuivant`) + « ⋯ », frise calculée (`friseDeLaDemande`), UNE liste « Pièces » Devis → BC →
Facture → Justificatifs (`grouperLesPieces`), une carte Montant, UNE carte Validations, Discussion vs Historique (`separerLeFil`).
**Devis natifs → BC (« comme dans Ad & Pro »)** : l'assistante dépose et retranscrit le devis (registre Legal `QUOTE`, lignes
sous `custom.devisNatif`) ; le **demandeur** (ou le Super Admin) retient ses lignes et génère UN BC par fournisseur (fabrique,
sous délégation de la demande) ou dépose un BC ; centre de validations → signature → « Signé et validé », l'assistante prévenue
(`secretariat/devis-natif*.ts`, `secretariat-devis-actions.ts`, `devis-bc-flow.test.ts`). « Terminer » attend un BC en route.

**Deux gestes, rien d'autre (Direction, 10/2026 — `secretariat/traitement.ts`).** Retirés : la demande multiple
(`createRequestBatch`), le type « Mission chauffeur » et la création de courses (`createMission`), les statuts posés à la
main (en attente d'un tiers / d'un document, bloquer, reprendre — `updateRequestStatus` refuse tout et nomme les deux
gestes), la validation Finances / interne demandée depuis la fiche. L'existant se relit : un statut retiré se lit
« En cours » (`statutAffiche`) et se termine par « Fin du traitement » ; une demande « Mission chauffeur » se lit ; un lot
garde ses voisines sur la fiche. Les **participants** (`fields.participantIds`) lisent la demande (`scopeAdminRequests`).
Les demandes nées d'un autre module (devis d'un poste Ad & Pro, demande de BC, devis promo, achat N+1) suivent le même
traitement ; l'approbation N+1 d'un achat reste en amont (« Attente validation »).

Les cellules d'un ancien lot restent pilotées **indépendamment**. La
**suppression** par l'assistante est **traçable** (corbeille + motif + audit, restauration possible) ; une
demande restaurée revient dans l'état où on l'a supprimée — seule la suppression discrète du demandeur revient
« nouvelle ».

**Pas de menu de statut libre (audit 360°, R12 — §118.191 ; depuis 10/2026, plus aucun statut à la main).** Chaque
issue a sa porte : « Commencer le traitement », « Fin du traitement » (seule à vérifier la facture d'un achat et son
imputation, et qui archive la demande dans le Drive), « Annuler la demande… » (motif ; la validation,
l'approbation et le paiement en attente partent avec elle ; non offerte pour la demande de BC d'un poste, qui se
retire depuis le poste), « Rouvrir… » une demande terminée (motif ; une annulée ne se rouvre pas). La règle
vit dans `secretariat/statut-manuel.ts`, lue par l'action et par l'écran.

**Trancher une approbation (lot E5 — audit des managers, M14 et M15).** Une approbation (`AdminApproval`) a trois
issues : valider, refuser, demander une modification. Elle porte **qui l'a tranchée** (`decidedById` — le validateur
nommé, son intérimaire, l'assistante ou la Direction ; une décision d'avant, ou d'un compte supprimé, se lit « auteur
inconnu ») et **sa parole** (`decisionNote`, à part de `comment`, qui reste celle du demandeur) — migration
`20270103090500_approbation_decideur_motif`. Refuser ou demander une modification **exige un motif** (l'état
d'abord) ; personne ne valide **sa propre** demande, sauf le sommet — la liste (`getApprovals`) ne la propose pas et
la fiche n'offre pas de boutons. La décision s'écrit **une seule fois**, sous condition : approbation encore en
attente ET demande vivante ; une demande annulée pendant la décision voit l'ordre émis **annulé**, et la phrase le
dit. Redemander la validation à quelqu'un d'autre retire l'approbation précédente encore en attente et prévient son
validateur. Le demandeur lit l'issue par son nom — « À modifier », avec le motif, le geste qui reste (retirer, puis
redéposer corrigée) et le nom de qui a tranché quand ce n'est pas le validateur nommé (`phraseDeDecision`) ; la fiche
affiche le décideur et son motif, et le journal des achats les garde. La **fin d'un achat** exige sa facture là où
l'écran la range (`ficheAFacture`, `lib/finance/facture-ordre.ts`) : un fichier « Facture » de la demande, ou une
facture du registre avec son PDF, rattachée à la demande ou qui SUIT un devis ou un BC non annulé de la MÊME fiche ;
une facture annulée, ou sans son fichier, ne compte pas. Règle pure `secretariat/decision-approbation.ts`, lue par
l'action et par les écrans.

### Information médicale — deux circuits, et la nature du dossier décide (PRIM)

Étape **intercalée** entre la décision de l'étape qui tranche (Direction Marketing par défaut ; pour un sponsoring, la
pré-validation de la tenue, avec l'estimation de ses postes) et l'ordre de dépense — uniquement si un pharmacien
responsable est configuré ; sinon l'ordre naît directement, en attente du centre de paiement. **Le bon de versement
ne concerne que le matériel promotionnel** — c'est ce qui sépare les deux circuits, et aucun geste ne permet
de faire changer un dossier de chemin (`lib/medical-info/circuits.ts`) :

```
CIRCUIT ÉVÉNEMENT — prise en charge nationale / internationale, événement, sponsoring
   → MedicalInfoDeclaration (DIM-AAAA-NNN) notifiée au pharmacien
   → il SOUMET sa lecture : « à déclarer au ministère » ou « sans déclaration » (motif EXIGÉ)
   → le DIRECTEUR DES OPÉRATIONS tranche (tous les comptes actifs saisis, le premier qui tranche décide ;
     aucun actif → le Super Admin, et la confirmation du pharmacien le dit)
   → accordée : il réclame les pièces s'il en manque, dépose auprès du ministère de l'Industrie
     pharmaceutique, enregistre la référence
   → il VALIDE  →  le DIRECTEUR DES OPÉRATIONS valide (ou refuse, motif exigé : le dossier revient au pharmacien)
     →  l'ordre de dépense naît — un seul, même à deux clics (écriture conditionnelle) —, en attente du centre de paiement
     (aucun ordre global quand des postes portent la dépense : chacun émet le sien)

CIRCUIT MATÉRIEL PROMOTIONNEL
   → il réclame les pièces s'il en manque
   → il SÉPARE le dossier en matériels — un bon de versement PAR matériel
   → UNE validation couvre le dépôt du lot (le Directeur des Opérations, comme ci-dessus)
   → accordée : il demande le paiement de CHAQUE quittance séparément
     (centre de paiement → Finances → REMISE de la quittance à son bureau)
   → toutes remises : le dépôt aux autorités s'ouvre, puis il VALIDE  →  validation finale du Directeur des Opérations
```

**Ce que le PRIM fait valider, le DIRECTEUR DES OPÉRATIONS le tranche (Direction, 10/2026).** « Quand le pharmacien
responsable d'information médicale demande une validation, elle doit automatiquement aller chez le directeur des
opérations. C'est lui qui valide, ou pas. » Les trois demandes — la lecture « à déclarer ? », le dépôt des bons, la
validation finale — vont au rôle `OPERATIONS_DIRECTOR` (la PERSONNE, principal ou secondaire), plus au N+1 / référent
Direction Marketing / centre, ni à la Direction des opérations (`DIRECTION`, le SERVICE). Règle pure
`lib/medical-info/decideur.ts` ; les deux premières sont des demandes de validation `PARALLEL` de nature
`INFO_MED_DIRECTEUR_OPS`, que le moteur commun clôt au premier accord (`validations/decision.ts:unSeulSuffit`, les autres
étapes passent « sans objet ») ; la troisième garde la machine du module (`validateDeclarationByDirection` /
`refuseDeclarationByDirection`, motif exigé, relu à l'écran via le journal). Le Super Admin reste souverain. Le
directeur lit le module en portée ALL (`MEDICAL_INFO: READ`) : registre, fiche et pièces. Les demandes déjà en cours sous
l'ancienne chaîne finissent leur circuit.

**L'argent, tenu (audit 10/2026).** L'ordre GLOBAL de la validation finale ne naît que pour un dossier d'événement venu
d'Ad & Pro, sans postes qui portent la dépense et sans ordre déjà émis (`circuits.ts:ordreGlobalALaValidation`) —
jamais sur la saisie libre d'un dossier ouvert par le PRIM, ni pour un MIP / visa / circuit matériel. Un bon ne porte
qu'UNE demande de paiement vivante (prise conditionnelle) ; un paiement annulé ou refusé le libère (redemander,
retirer, ou « sans versement »). L'exemption de facture d'une demande rattachée à une déclaration se prouve à la
création (`bonDeVersementRattache`). Sans pharmacien actif, la déclaration naît non assignée, avec l'ordre déjà parti.

**Ce qu'on fait valider est la LECTURE, pas la question.** Une demande de validation répond oui ou non :
poser « faut-il déclarer ? » aurait fait dire « refusé » pour signifier « non, ne déclarez pas », et un
dossier parfaitement conforme aurait été marqué comme rejeté.

**Une validation pour le lot, un paiement par bon.** Faire signer cinq fois la même décision n'ajoute
aucune sécurité : cela ajoute quatre relances. À l'inverse, grouper les paiements obligerait à attendre le
dernier matériel pour déposer le premier. Un refus du centre rouvre CE bon, et lui seul.

**Le PRIM ouvre aussi ses propres dossiers**, entre **deux** natures — déclaration MIP ou demande de visa
publicitaire (`OPENABLE_DECLARATION_KINDS`) — sans attendre qu'un événement les lui envoie ; la nature choisie décide
du circuit. Le bon de versement ne s'ouvre pas : c'est une étape du circuit du matériel.

**L'écran (07/10) — où en est le dossier, chez qui, depuis quand.** Une seule lecture, `lib/medical-info/parcours.ts`
(PUR, testé), sert la liste ET la fiche : étapes **Événement** = Reçu → À déclarer ? → Pièces → Dépôt ministère →
Pharmacien → Directeur des Opérations ; **Matériel** = Reçu → Pièces → Bons de versement → Dépôt ministère → Pharmacien → Directeur des Opérations.
L'étape courante est la première ni faite ni « sans objet » (les pièces sont facultatives : sans demande, l'étape est
sans objet). La **liste** (`information-medicale/dossiers-table.tsx`) : quatre tuiles (chaque dossier ouvert compté une
fois, dans le groupe où il attend), une ligne « état — chez qui », le délai, et le **produit** déduit de la source
(`lib/medical-info/produits.ts` : premier produit nommé + nombre d'autres, lien Produits 360 s'il se résout sans
ambiguïté) ; le plus ancien en attente d'abord, les validés en bas. La **fiche** : la **frise** (`[id]/frise.tsx`,
défilement latéral au téléphone) puis **la seule action** à faire maintenant. **Relancer une pièce attendue**
(`relancerPieceInfoMed`) : notification à la personne sollicitée, tracée, au plus une toutes les 4 h (la règle des
tâches).

### Ordres de dépense — le centre autorise, le comptable règle

Le centre de paiement **autorise** → **ordre de dépense** → le **comptable règle**. La « révision demandée
par le comptable » a été retirée aux Finances : plus rien ne produit `REVISION_REQUESTED`, que seuls des ordres
anciens portent encore (`test-center/state-machines/registry.ts`) — un désaccord sur le montant se dit AVANT,
au centre de paiement, qui autorise ou refuse avec son motif. Un ordre non réglé dont la source est retirée,
refusée ou annulée est annulé avec elle (`payments/annulation.ts`). Au règlement, la dépense est **attribuée
automatiquement** à la **catégorie budgétaire du module** d'origine et une **FinanceTransaction** (sortie) met
à jour la trésorerie.

### Centre de validation (agrégation + configurable)

Le module **Demandes de validations** agrège **toutes les validations en attente** (Bureau du secrétariat, Ad & Pro,
Finances, information médicale…) — visible des **validateurs**, pas du demandeur. Le Super Admin définit des
**règles** : module, type d'objet, montant min/max, département, rôle, priorité → **1 ou 2 validateurs**, en
**séquentiel ou parallèle**. Une demande administrative peut être **escaladée** à la Direction.

**Accès & décision du validateur** (`src/app/(app)/validations/page.tsx`, `src/lib/queries/validations.ts`) :
tout validateur assigné voit la demande **complète et ses pièces** (aperçu sur place), même le 2ᵉ d'un circuit
séquentiel **avant son tour** (badge « En attente de votre tour »). La Direction/Super Admin **supervise** toutes
les demandes en cours (`getSupervisedValidations`). Deux niveaux de décision :
- **Globale** — `decideValidation` (`ValidationDecision`) : **Valider** / **Renvoyer pour correction** / **Refuser** —
  le **motif est obligatoire** pour renvoyer et pour refuser (audit 360°, R08 et R17). Fait **avancer le circuit**
  (séquentiel → validateur suivant ; parallèle → validée quand toutes les étapes le sont), sous le **verrou de la
  demande** et sur ses étapes **relues** : deux accords simultanés d'un circuit parallèle ne la laissent plus en
  attente pour toujours, et un double clic ne décide plus deux fois (§118.188).
- **Renvoyée pour correction** → statut **« À corriger »** : le demandeur corrige (texte, montant, pièces), dit ce
  qu'il a corrigé et **resoumet la même demande** (`resoumettreValidation`, version + 1) ; elle reprend **à l'étape
  qui l'a renvoyée**, l'accord d'avant restant acquis — sauf si le montant **monte**, et alors toutes les étapes
  déjà validées repartent (`validations/decision.ts`). Motif du renvoi et correction s'écrivent au fil de la
  demande. Une demande née d'un autre circuit (pièce du secrétariat, BC, information médicale) se corrige **depuis
  son objet d'origine**. Abandonner une demande renvoyée la clôt (**Annulée**) sans effacer l'historique.
- **Qui lit une demande et ses pièces** : le demandeur, les validateurs et leur intérimaire ; seul le demandeur en
  ajoute (`lecteurDeLaDemandeDeValidation`, lue par la fiche ET par `canAccessEntity` — les pièces s'ouvraient
  auparavant à tout porteur du module).
- **Par élément** — `reviewValidationItem` / `clearValidationItem` (`ValidationItemDecision`, `itemKey` = `"MESSAGE"`
  ou id de pièce ; `ItemReview` + `ValidationAttachments`) : le validateur approuve / demande une révision / refuse
  **le message ET chaque pièce jointe séparément**, commentaire **optionnel**. Ce retour détaillé remonte au
  demandeur dans « Mes demandes » (libellés lisibles des pièces).

### Force de vente — la boucle terrain

**LE TROU QUE CE CHANTIER FERME.** Le pilotage SFE était complet d'un bout — la Direction prévoit
par produit, on affecte KAM × produit × rang de détail, le cockpit compare planifié et réalisé.
Mais l'écran de **saisie du terrain avait été retiré**, et un cockpit sans réalisé pilote à
l'aveugle : le « réalisé » venait de visites que plus rien ne permettait d'enregistrer simplement.
La saisie ne se décrète pas — elle s'obtient en rendant l'écran **utile avant d'être obligatoire**.

> **Refonte du 07/10 (maquette validée) — UN SEUL « REQUIS », LA LETTRE PARTOUT.** Le requis d'un praticien est la
> **lettre de segmentation × In/Out × fréquence du secteur** (stratégie de la BU du KAM d'abord ; le palier de potentiel
> × `frequencyByTier` seulement pour un praticien hors de toute stratégie publiée — `lib/segmentation/lettre-requise.ts`,
> `lettres-service.ts`). Ma journée (tournée proposée : le plus en retard, puis la plus forte lettre, puis le plus
> anciennement vu — `sfe-day.ts`), la cible du mois (Σ du requis du panel — les visites prévues des affectations ne
> priment plus), le plan de tournée (liseré de la lettre dans la grille et le PDF), le cockpit et l'instantané mensuel
> lisent ce requis. Le pilotage vit à **`/planning`** (onglets Pilotage · Territoires · Produits ; calculs purs
> `lib/force-de-vente/calculs.ts` — jour du cycle en jours ouvrés, réalisé **plafonné au requis** de chaque praticien,
> couverture à fréquence des cibles H·A·B, tri par retard ; lectures `lib/queries/force-de-vente.ts`). Détails :
> [Force de vente — pilotage, territoires, produits](#force-de-vente--pilotage-territoires-produits-refonte-du-0710).

- **« Ma journée » (`/medical/ma-journee`)** — l'écran unique du KAM, pensé pour un téléphone.
  La **tournée proposée** vient de `lib/sfe-day.ts` (PUR, testé) : priorité au **retard sur la
  fréquence cible** (pas au potentiel seul — sinon on renvoie toujours chez les mêmes), puis au
  potentiel, puis au plus anciennement vu ; un palier à fréquence nulle n'est **jamais** proposé,
  la liste est **bornée** (8), et **chaque ligne porte sa raison chiffrée** (« 3 attendues, 1 faite
  — vu il y a 12 j »). La **saisie** (`logVisit`) est en 3 gestes : praticien (pré-rempli), produits
  **de sa mallette** dans l'ordre P1/P2/P3 (**seuls les P1 pré-cochés** — un chiffre faux vaut moins
  qu'un chiffre absent), un mot libre (le micro du clavier y dicte nativement). La visite est
  **TERMINÉE par construction**, créditée à **celui qui saisit**, refusée hors de son panel et
  jamais future ; les produits sont des **liens** (`MedicalVisitProduct`), pas du texte.
- **La supervision vient au superviseur** (`lib/sfe-alerts.ts`, PUR + `lib/sfe-sweep.ts` branché
  sur l'ordonnanceur existant) : **silence** (aucune saisie depuis 5 j — « on ne sait pas », jamais
  « il ne fait rien »), **retard à mi-mois** (< 40 % au 15, pendant qu'on peut rattraper),
  **couverture** (< 50 % après le 25 — le volume peut être bon alors que le panel est mort), et
  **KAM non armé** (sans panel ni affectation : elle vise **celui qui configure**, pas l'homme, et
  **coupe** les autres). Une alerte par **type et par mois** (`lastAlertKey`), jamais une par nuit.
  Au 1er du mois : **revue** par superviseur, le chiffre **dans la notification**.
- **La boucle performance** — `lib/sfe-performance.ts` (PUR) met **effort × ventes** côte à côte
  sur le mois, **sans affirmer aucune causalité** (une vente hospitalière tombe des mois après la
  visite ; un marché public ne doit rien au détaillage). Ce qu'on vient y lire, ce sont les deux
  **anomalies** qu'aucun chiffre ne montre seul : un produit **détaillé sans vente**, un produit
  **vendu sans visite**. Et l'**instantané mensuel** par KAM (`SalesRepMonthlyKpi`) fige ce qui
  était vrai ce mois-là, **équipe comprise** : un panel modifié en juin ne doit pas réécrire la
  couverture de mars — c'est ce chiffre qu'on relit en entretien annuel.
- **UN SEUL CALCUL** : `queries/sfe-cockpit.ts` sert l'écran de pilotage, le balayage d'alertes et
  l'archivage. Trois copies d'une même formule finissent par donner trois taux, et le superviseur
  ne sait plus lequel croire.
- **Adam** : `medical_operation` op **`log_visit`** — « j'ai vu le professeur Benali, je lui ai
  présenté l'Atorvastatine » depuis la voiture ; la résolution se fait **dans son propre panel**
  (une visite se saisit par celui qui l'a faite), les produits sont résolus **au catalogue** et un
  nom inconnu est **dit**, jamais enregistré en texte libre.

### Promotion médicale — la fiche de coaching (tournée en double)

**D'OÙ ELLE VIENT.** Le classeur de la Direction (« Fiche_Coaching.xlsx ») : *FICHE DE COACHING –
TOURNÉE EN DOUBLE* — l'en-tête (collaborateur, manager, date de la tournée, secteur / région / CDR),
l'échelle à **quatre niveaux** (MB Maîtrise Basique = 1, MP Maîtrise Partielle = 2, MA Maîtrise
Acquise = 3, PM Parfaite Maîtrise = 4), les **cinq axes** (A. Préparation de la visite, B. Conduite
de la visite, C. Écoute Active & Temps de Parole (70/30), D. Gestion des Objections, E. Conclusion
& Engagement) avec **un critère par niveau**, le **total des points** et le **Bilan & Plan
d'Action** (points forts, points à améliorer). Il est reproduit à l'identique ; la seule retouche
est la faute de frappe « Points à Améliorer : : ». Son exemple (MA, MA, MA, MP, MP) fait **13 / 20**,
la valeur de sa cellule D16 — c'est l'ancre du banc.

- **Où** : Promotion médicale › onglet **Coaching** (`/medical/coaching`), juste après « Plan de
  tournée » — donc aussi dans le menu latéral, qui lit la même liste d'onglets.
- **Qui administre** : le **Directeur des Opérations**, la **Direction des opérations** (les deux
  libellés que le métier emploie pour la même fonction) et le Super Admin —
  `lib/coaching/acces.ts:ROLES_ADMINISTRATEURS`, une ligne à retoucher pour réserver la grille au
  seul Directeur des Opérations. Administrer, c'est modifier la **grille** (`/medical/coaching/grille`),
  voir **toutes** les fiches, brouillons compris, les **corriger même finalisées**, les retirer, et
  coacher toute la force de vente. Le Directeur des Opérations n'a que la LECTURE du module : ses
  droits de coaching viennent de la règle du coaching, pas du CRUD du module.
- **La grille est versionnée** (`CoachingGrid`) : chaque publication crée une version, avec son
  motif et son auteur ; une fiche garde SA version, donc un « 3 » finalisé se relit avec les critères
  sous lesquels il a été donné. Un axe garde sa **clé** d'une version à l'autre (le reformuler ne
  casse pas la synthèse) ; un axe **ajouté** reçoit une clé qui n'a jamais servi — réutiliser celle
  d'un axe retiré lui ferait hériter d'un historique qui n'est pas le sien.
- **Qui remplit** : le périmètre de la force de vente (`resolveRepScope`, la même réponse que le
  plan de tournée) — un **superviseur de BU** coache les KAM de sa BU ; la configuration de la force
  de vente et l'administration coachent toute la force de vente terrain ; un KAM ne remplit pas de
  fiche ; **personne ne se coache soi-même** ; un compte hors force de vente n'est pas coachable.
- **Brouillon → finalisée** : le brouillon est le travail en cours de son auteur. « **Finaliser et
  partager** » exige chaque axe noté (le refus **nomme** les axes manquants) et **prévient le
  collaborateur**. Finalisée, la fiche ne se modifie plus que par l'administration — le collaborateur
  est prévenu de la correction, et elle reste complète. Retirer : l'auteur son brouillon, une fiche
  finalisée par l'administration seule. Une tournée future, une note hors barème, un axe inconnu
  sont refusés, et nommés.
- **Qui lit** : un brouillon — son auteur, son manager, l'administration ; une fiche finalisée — le
  collaborateur, son superviseur, la configuration de la force de vente, l'administration ; **jamais
  un collègue**. Une fiche illisible rend la même page qu'une fiche inexistante. La liste passe par
  `clauseFichesVisibles`, la fiche seule par `peutLireFiche` : un banc exige qu'elles disent
  EXACTEMENT la même chose, en pur et sur la vraie base.
- **Téléchargeable** : le **classeur de la fiche** au format du modèle (mêmes blocs, même échelle,
  chaque axe renvoie au niveau retenu par `=Cn` et le total est une **formule** — recalculée par le
  moteur de formules du dépôt dans le banc) ; le **classeur de suivi** (une ligne par fiche, les axes
  en colonnes, et la synthèse) ; la **version imprimable / PDF** (`/impression/coaching/[id]`, sans
  la coque de l'application). Le téléchargement suit la porte de l'écran : 404 pour un collègue.
- **Synthèse** : par collaborateur (dernière fiche, moyenne, tendance) et par axe (niveau moyen),
  sur les fiches finalisées seulement.
- **Adam** : remplir, corriger, finaliser ou retirer une fiche d'évaluation sont des **attestations**
  signées par une personne, et la grille est une décision du directeur des opérations — les cinq
  actions restent des gestes d'écran (parité : EXCLUDED, raison écrite).

Code : `lib/coaching/{grille,acces,dates,synthese}.ts` (PURS), `serveur.ts` (grille en vigueur,
lecteur, périmètre), `fiches.ts` (liste et fiche visibles), `classeur.ts` (Excel) ;
`lib/actions/coaching-actions.ts` ; `components/coaching/*` (un seul rendu de la grille pour la
saisie, la consultation et l'impression) ; écrans `app/(app)/medical/coaching/**`,
`app/impression/coaching/[id]`, routes `app/api/medical/coaching/**`. Modèles `CoachingGrid`,
`CoachingSheet` ; migration `20261201090000_fiche_coaching`.

### PCH — Marchés publics (Market 360°)

Un marché est un **dossier transversal de bout en bout** : AO → soumission versionnée →
attribution par lot → contrat & avenants → bons de commande à lignes → livraisons → factures →
paiements → clôture. Voir **`docs/MARKET_360_ARCHITECTURE.md`** (modèle, mermaid, ownership) et
**`docs/MARKET_360_AUDIT.md`** (matrice de preuves).

- **Cycle de vie DÉRIVÉ** (`lib/pch/market-math.ts`, pur, testé) : les faits décident
  (dépôt verrouillé, lots gagnés, contrat actif, BC), seuls annulé/suspendu/perdu/clôturé sont
  DÉCIDÉS. Liste `/pch` filtrée par niveau (liens), fiche `/pch/[id]` avec barre de progression,
  manques et KPI (soumis / attribué / contrat initial vs **courant** / commandé / livré /
  facturé / encaissé) — un seul module calcule (§24).
- **Soumission versionnée** (`PchSubmission`) : V1→Vn, checklist signée/horodatée, **dépôt =
  transaction** (verrou `lockedAt` + `submittedAt` sur le marché + photo `submissionSnapshot`
  de chaque ligne). La version déposée refuse toute retouche **côté serveur**.
- **Résultats par LOT** : gagné / perdu / infructueux / annulé, **attribution partielle**
  (`awardedQuantityUnits` ≤ soumis, refus sinon), prix d'attribution.
- **Contrat = UN objet Legal, deux vues** (`LegalDocument.tenderId`) : `createContractFromAward`
  (2 portes : PCH UPDATE + LEGAL CREATE) crée la pièce ET ses `PchContractLine` depuis les lots
  gagnés. **Avenants** = kind `AMENDMENT` + `amendsId` + `amountDelta` ± + `effectiveAt` — le
  montant initial n'est **jamais** écrasé, la valeur courante se **calcule**
  (`valeurContractuelleCourante`). Fiche Legal : carte « Contexte marché ».
- **BC à lignes** (`PchOrderLine` → ligne contractuelle) : contrôle du **restant contractuel**
  par produit (deltas des avenants effectifs compris) — dépassement = refus **chiffré**, passage
  outre = geste explicite `force`, **tracé dans l'audit avec son excès**.
- **Livraisons** (`PchDelivery`/`Line`) : BL, dates, réserves, **lot pharma + péremption** ;
  mouvement de **stock OUT** créé UNIQUEMENT sur demande (case) ET produit résolu sans ambiguïté
  (exactement 1 `RegulatoryProduct`). Supprimer une livraison **conserve** ses mouvements.
- **Factures** : lecture des documents légaux de nature `INVOICE` (`sourceType=PCH_ORDER`) — rien de fabriqué. La
  création se fait depuis le **bon déplié** (bouton « Facture », droit FINANCES CREATE) : c'est le
  `createInvoice` canonique avec le rattachement en champs cachés ; Adam : `create_invoice` +
  champ « order ».
- **Vues croisées** : fiche produit Regulatory → carte « Marchés PCH » (`loadProductMarkets`) ;
  « Relier à… » sur toute fiche (registre unique `EntityLink` — voir « Le fil de l'affaire »
  ci-dessous : un pli de recouvrement porte plusieurs factures et BC, et la fiche marché montre
  les courriers de CHAQUE bon et de CHAQUE facture) + création **pré-associée** depuis le
  marché ; recherche globale (marchés, BC, Legal avec garde lecteurs, courriers).
- **La référence d'un marché se CORRIGE** (écran « Modifier » et Adam `update_tender.newReference`) :
  elle est saisie à la main le jour de la publication, une coquille se paie pendant des années.
  Elle reste **unique** — le refus NOMME le marché qui la porte déjà — et les libellés
  photographiés par ses liens d'affaire sont rafraîchis (`refreshLinkLabels`).
- **Rappels d'échéance de dépôt** : balayage quotidien (`lib/pch/deadline-sweep.ts`), zones
  J-7 / J-2 / dépassement, prévient responsable + équipe à l'ENTRÉE de zone seulement, se tait
  dès le dépôt.
- **Adam** : `business.story` sert la MÊME frise que l'écran (`storyMarche`, sur les FK) ;
  13 ops `pch_operation` + 2 ops `mail_operation` natives — mêmes portes, même audit. Parité
  100 %, frontière abaissée 430 → 428.
- **Écritures** : `lib/actions/pch-market-actions.ts` (16 actions gardées, transactionnelles,
  auditées) ; lecture 360° : `lib/queries/market-360.ts` (`loadMarket360`).
- **Preuves** : 22 tests purs + **9 tests d'intégration** depuis les vraies portes (scénario
  §87 complet). Limites dites dans l'audit (E2E navigateur non montés, 1 règlement/facture).

**Documents du marché** : l'appel d'offres (cahier des charges, PV…) et pièces liées se
téléversent à la création OU depuis la fiche — entité polymorphe `PCH_TENDER` (Document/Drive,
versionné, mêmes contrôles d'accès PCH).

**Chaîne d'automatisation d'une ligne-produit** (`src/lib/actions/pch-tender-line-actions.ts`,
`src/lib/market/pch-lookup.ts`, RBAC `PCH`/`UPDATE`) :
1. **Lecture** — `analyzeTenderDocument` (PDF/image : **le texte du fichier d'abord**, l'OCR `ocrDocument` seulement
   quand il manque — ou forcé, « Océriser même si le PDF porte du texte » ; 40 pages au plus par le moteur local) ou
   `analyzeTenderText` (texte collé) → le modèle rend les lignes (désignation, DCI, dosage, forme, quantité en
   unités, `unitsPerBox`). Nombre de boîtes = ⌈unités / `unitsPerBox`⌉. **Chaque lecture est tracée**
   (`PchTenderExtraction`, migration `20270103094500_pch_lecture_ao`) : sa méthode, ses pages, et sa **coupe à
   24 000 caractères**, DITE et chiffrée (« seuls les N premiers caractères sur M ont été analysés… ») ; le fichier
   lu est gardé dans les documents du marché quand la personne a le droit d'y téléverser. Une **relecture ne
   remplace QUE** les lignes nées d'une lecture que personne n'a touchées (`extractionId`, `empreinteExtraction`,
   `modifieeLe`) — une ligne saisie à la main, modifiée, chiffrée, soumise, au statut tranché, annotée ou rattachée
   reste, et la phrase dit combien ; une lecture « complémentaire » (annexe, lot ajouté) ne remplace rien. Règles
   PURES `lib/pch/extraction.ts`, lecture et écriture `lib/pch/lecture-ao.ts` ; les cinq dernières lectures se
   lisent sous le panneau, pour qui peut en relancer une (`lecturesDuMarche`).
2. **Enrichir** (`enrichTenderLine`) — **verrou prix** depuis les **réceptions PCH 2025** (`pchReceptionPrice`,
   vérifie DCI + dosage + forme → `refPriceDzd` + `refPriceSource`) ; **nomenclature** (`nomenclatureMatch`) ;
   **notre produit** (`matchOurProduct` sur `RegulatoryProduct` → `ourProductId`, `registeredOurs`, `haveProduct`) ;
   **concurrents** + **estimation marché** (`getRecommendations`).
3. **Suivi commercial** : `PchLineStatus` PENDING → QUOTED → SUBMITTED → **WON** → LOST (+ `awardedUnitPriceDzd`).
4. **Ventes réelles** — une ligne **WON** génère des **bons de commande** = **fractions** (`createOrderFromLine`,
   `PchOrder.lineId`) ; **taux de réalisation** = Σ quantités des bons / quantité attribuée.
5. **Logistique** — chaque bon de commande porte `expectedArrival` / `arrivedDate` (`setOrderArrival`).

### Portail Fournisseur (externe sécurisé)

Comptes externes **totalement séparés** (`Supplier` / `SupplierUser`, **auth distincte** cookie HMAC scopé
`/portail`). Un fournisseur ne voit **QUE** ses produits `portalVisible` et **seulement les champs externes**.

### Vue exacte (impersonation)

Le Super Admin visualise l'OS **exactement comme** un utilisateur. Cookie honoré **uniquement** si la session
réelle est Super Admin. Bandeau permanent + « Quitter », démarrage/arrêt journalisés. **Une vue, pas une
usurpation** (§118.184) : une requête qui ÉCRIT — une action serveur, ou une route d'API qui le déclare par
`getCurrentUserPourEcrire` — ignore la vue et part **au nom du Super Admin réel**, avec ses droits (`lib/session.ts`).
Exception voulue : la **création d'une demande** Ad & Pro (`requireUserAuNomDeLaVue`) se fait au nom de la personne.

**Étanchéité (Direction, 06/10 — « pas de chevauchement possible »)** :
- **Qui est à l'écran** : règle unique `vueHonoree` (`lib/vue-exacte-ui.ts`). Tout ce qui s'AFFICHE voit la vue — page,
  coque, **rendu qui suit une action** (Next 14.2 le rend dans le stockage `isAction` : détecté par `rendreEnCours`,
  sonde `React.cache`), et les actions qui ne font que **charger un panneau**, déclarées par `enLecture(requireUser)`
  (`lib/vue-lecture.ts`). Le corps d'une écriture garde `user.visualise` (Adam refuse alors ses gestes « à soi »).
- **Coque** : bandeau « Vous voyez l'interface de X — Quitter », rien du profil de l'administrateur ; menu du compte =
  celui de X, « Quitter la vue » remplace « Se déconnecter ».
- **Onglets** : témoin non httpOnly `amd_vue` posé/effacé avec le cookie (`poserVueExacte`/`effacerVueExacte`) ;
  `GardeIdentite` recharge l'onglet entier s'il a changé (autre onglet, expiration 4 h, retour arrière). Entrer/sortir =
  `window.location.assign` (jamais de navigation douce). Connexion/déconnexion ferment la vue ; l'entité choisie
  (`amd-company`) est remise à zéro à l'entrée et à la sortie.
- **Navigateur** : brouillons de messages, presse-papiers du Drive, épingles Bureautique rangés par personne
  (`cleParPersonne`, `useCleParPersonne`). Gardes : `lib/vue-exacte-etanche.test.ts`, `e2e/vue-exacte.spec.ts`.

---

