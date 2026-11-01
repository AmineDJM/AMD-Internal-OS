# 0040 — Les actions métier réversibles (lot K10c, 31/10/2026)

Demande de la Direction (31/10/2026, verbatim) : « Je veux que toutes les actions soient réversibles. Même celles qui ne
le sont pas : tu dois modifier l'ERP pour qu'elles le soient. Toute action qui a été faite peut être réversible. Ça doit
être dans n'importe quelle action du registre. » Contexte : la voix de l'Assistant IA exécute une action sur un simple
« vas-y » (K9) ; la sécurité vient de la réversibilité. Trois lots parallèles : K10a (argent), K10b (communications,
effets sortants, suppressions), **K10c (le reste — ce document)**. Suit [0029](0029-simulation-annulation.md) (J7 : journal
des effets, annulation honnête) et [0020](0020-capacites.md) (registre, classement).

Migration additive et idempotente `20270217120000_effets_reversibles` : table `EffetSortantDiffere`, colonne
`AssistantIaReglage.fenetreAnnulationSec` (défaut 120).

> Code : `src/lib/effets/reversible.ts` (`actionReversible`), `politiques.ts` (tout ou rien, rectificatif, gestes inverses
> métier), `fenetre.ts` (fenêtre d'annulation), `annulation.ts` (étendue : client d'écriture du geste, rétablir, plan à
> blanc qui connaît les liens posés par le geste) ; gestes inverses : `lib/suppression/annulation-corbeille.ts`,
> `lib/references/annulation-numeros.ts`, `lib/reservation-fiche/annulation.ts` ; diffusion différée :
> `lib/notifications/diffusion-differee.ts` ; registre : `platform/ia/capacites/annulations-declarees.ts` ; écran :
> `lib/actions/gestes-reversibles-actions.ts`, `components/gestes/` ; console : `/admin/ai/acces` (fenêtre).

## 1. La définition tenue

Une action est **réversible** quand la personne qui l'a faite (ou le Super Admin — RBAC inchangé : la garde est celle du
journal J7) peut l'annuler d'un geste — bouton à l'écran, ou l'Assistant IA écrit ou oral — et que l'ERP revient à
l'état d'avant (**retour**), ou applique une **compensation** tracée (ordre de paiement passé à ANNULÉ, rectificatif,
envoi retiré dans sa fenêtre), jamais une écriture effacée en silence. Une lecture (R0) n'a rien à défaire.

## 2. Un seul mécanisme : le journal J7, au clic de l'écran aussi

`actionReversible(id, libellé, corps)` enveloppe le corps de l'action. Au clic, il s'exécute sous `journaliserGeste`
(origine « ecran ») : chaque écriture garde sa ligne avant/après, chaque effet externe son passage ; le résultat porte
`annulable: { gesteId, libelle }`. Sous un geste de l'assistant (carte, travail, mandat) ou une simulation, rien ne
change : l'écriture va au geste qui la porte. Pas de second système : l'annulation est `annulerGeste` (J7).

## 3. Ce que l'annulation J7 apprend pour une action métier (`politiques.ts`)

- **Tout ou rien (les cascades).** Le plan est d'abord composé à blanc ; si un effet ne se défait pas sans laisser
  l'ERP incohérent — l'ordre de paiement né d'un accord a été **payé** depuis, une valeur a été changée par quelqu'un,
  un champ ne se remet qu'en partie — **rien n'est écrit** et le refus rend la liste (`bloquants`), chacun avec sa
  raison. Les effets déjà sortis (poussée, appel externe) ne bloquent pas : ils sont dits tels quels.
- **Rectifier.** Une notification déjà lue ne se reprend pas : un **rectificatif** part au même destinataire
  (« X a annulé « … » : cette notification n'est plus d'actualité »). Non lue, elle est retirée.
- **Les gestes inverses métier**, quand l'effacement ligne à ligne serait faux : un poste Ad & Pro supprimé revient de
  la **corbeille** avec ses branches (mêmes identifiants) ; un numéro de référence consommé n'est **jamais rendu** (la
  série garde un trou — dit « sans objet ») ; la clé d'index de la bibliothèque posée par un dépôt est retirée.
- **Le plan à blanc** connaît les liens que le geste a posés lui-même (« Modele.champ » → lignes) : l'annulation les
  remet avant de juger la ligne parente — sans cela, un sujet créé puis rattaché au poste par le même geste semblait
  « rattaché depuis ».

## 4. Rétablir — une annulation est elle-même annulable

L'annulation s'exécute sous **son propre** journal (`horsGesteParent` + `journaliserGeste`, origine « annulation ») et
écrit par le client du geste : ses écritures (valeurs remises, lignes retirées ou recréées, rectificatifs) sont au
journal. `retablirGeste` annule ce geste-là (mêmes règles : verrou, relecture, rien d'écrasé) et rend le geste d'origine
de nouveau annulable. Une simulation n'annule ni ne rétablit rien (elle rend le plan).

## 5. La fenêtre d'annulation des effets sortants (`fenetre.ts`)

Un effet qui sort de l'ERP attend sa fenêtre (`fenetreAnnulationSec`, **120 s par défaut — décision Direction à
rappeler**, réglable de 0 à 900 s par le Super Admin dans Administration › IA › accès) : `differerEffetSortant` écrit
une ligne `EffetSortantDiffere` par `prisma` — sous le geste, c'est une création au journal. Annulée dans la fenêtre :
la ligne est retirée sous verrou, **rien n'est parti**. Après : la tâche planifiée `effets.sortants` l'a expédiée
(réclamation atomique `EN_ATTENTE → ENVOI`) ; l'annulation applique la **compensation** de l'expéditeur et dit ce qui
ne se défait pas. Rétablir un envoi retiré lui donne une fenêtre **neuve**, jamais un départ sur-le-champ.

Dans ce périmètre, un seul effet sortant de masse : **`notification-actions:sendBroadcast`**. Parti, sa compensation
retire les notifications non lues et envoie un rectificatif à qui l'a lue ; l'écran dit : « la notification poussée
déjà affichée sur les appareils de N personne(s) n'est pas effacée chez eux ». Les réservations n'envoient **aucun
courriel** à l'agence (vérifié : notifications internes seulement). Les notifications poussées des autres actions
partent encore au clic (le port push est le chantier de K10b) : l'annulation les dit « parties », avec le rectificatif.

> **Interface minimale, à réconcilier avec K10b** : `differerEffetSortant`, `expedierEffetsEchus`, `issueEffetDiffere`,
> `nouvelleFenetre`, expéditeurs déclarés dans `EXPEDITEURS` (import tardif, jamais par effet de bord).

## 6. Le registre — `annulation` ne vaut plus « aucune »

`ANNULATIONS_DECLAREES` (pur, dans le socle) donne l'annulation codée des actions rendues réversibles ; `ficheDeLAction`
la lit avant la lecture lexicale (« régler » y valait paiement). Le cliquet `reversibles-metiers.test.ts` tient trois
faits ensemble pour chaque entrée : déclarée et non « aucune » au cliché, enveloppée par `actionReversible("<id>"`,
exécutée puis annulée par un banc (`reversibles-*.test.ts`). La liste des actions écrivantes encore « aucune » du
périmètre est **vide** (43 → 0).

## 7. L'écran et l'Assistant IA

- Après une action réversible passée par `useAction` / `useFormAction` (ou un écran branché sur `signalerAnnulable`),
  un **bandeau** « <action> — fait. Annuler… » s'affiche deux minutes : le plan d'abord, puis le compte rendu effet par
  effet, puis « Rétablir ». Chargé au premier geste annulable (rien dans le JS de la coque avant).
- Sur les fiches juridiques et les dossiers de matériel promo : « Mes gestes sur cette fiche » (`GestesAnnulables`).
  Tous les gestes de la personne restent listés dans « Ce que l'assistant a fait » (`/assistant/gestes`).
- `gestes-reversibles-actions` (`listerMesGestesAnnulables`, `apercevoirAnnulationDeMonGeste`, `annulerMonGeste`,
  `retablirMonGeste`) est une action du contrat : l'assistant peut **proposer** l'annulation (carte, ou « vas-y » à la
  voix) — c'est la personne qui décide ; en simulation, l'annulation rend son plan.

## 8. Compensations choisies, et pourquoi

| Action | Annulation |
|---|---|
| Réglages (veille, veilleur, réponse vocale, conversation privée, travaux d'office, priorité, console, double écriture, délai d'étape) | retour — la valeur d'avant ; un délai retiré est recréé à l'identique |
| `decideValidation`, `finalDecision`, `decideAdvance` | l'étape est rouverte (décision effacée), l'ordre et la déclaration nés de l'accord retirés ; refus si l'ordre est payé |
| `requestAdvance`, `createLegalDocument`, `demanderPaiementPoste`, `demanderPaiementFacturePromo`, `initiatePayment`, `settle`, `requestBV`, `sendLegalInvoiceToSettlement` | les lignes créées sont retirées (ou passées à ANNULÉ si on y a touché) ; refus si l'ordre est payé |
| `cancelAdvance`, `cancelLegalDocument`, `annulerFacturePromo`, `cancelPromoMaterial`, `annulerOrdrePoste` | retour — chaque statut annulé reprend sa valeur |
| `deleteAdProItem` | retour depuis la corbeille, avec ses branches |
| `relancerPaiement`, `relancerFiche` | la relance est retirée du fil ; notifications non lues retirées, rectificatif sinon ; la poussée est dite partie |
| `sendBroadcast` | fenêtre d'annulation, puis compensation dite |
| Fiches de voyage | l'état d'avant de la fiche ; pièces et devis retirés ; numéro de pièce jamais rendu (dit) |
| `testerEditeurOffice` | un diagnostic en lecture : il n'écrit rien — rien à défaire (journalisé pour le dire) |

## 9. Limites connues

- Un **ordre payé** n'est pas « dé-payé » ici : l'annulation de l'action qui l'a fait naître est refusée, avec la liste
  (le « paiement à récupérer » est le chantier de K10a).
- Une notification poussée ne se reprend pas ; un numéro de référence consommé ne se rend pas — dit, jamais caché.
- Les actions appelées par un formulaire qui ne passe ni par `useAction` ni par `signalerAnnulable` n'affichent pas le
  bandeau : leur geste s'annule depuis la fiche (juridique, promo) ou depuis « Ce que l'assistant a fait ».
- La fenêtre d'annulation est une table neuve tant que K10b n'a pas livré la sienne : le parent réconcilie.
