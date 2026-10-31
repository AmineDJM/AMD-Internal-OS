# 0029 — Simulation, journal des effets, annulation honnête (lot J7, 30/10/2026)

Architecture validée : <https://claude.ai/artifact/34ig3QRV5X7LtanjyuX7U7>, lot J7 — critère : « ≥ 80 % des écritures
internes simulables ; aucun effet externe en simulation ; annulation juste sur 50 cas ». Suit [0020](0020-capacites.md)
(registre des capacités : risque, `simulable`, annulation) et [0023](0023-delegation.md) (contexte de geste hors requête).

Migration additive et idempotente `20270215150000_journal_des_effets` : tables `AssistantGesteJournal` et `AssistantEffet`,
colonne `AssistantIaReglage.retentionEffetsJours` (défaut 180).

> Code : `src/lib/effets/` (`magasin.ts`, `geste.ts`, `capture.ts`, `client.ts`, `simulation.ts`, `diff.ts`, `valeurs.ts`,
> `modeles.ts`, `reseau.ts`, `journal.ts`, `annulation.ts`), façade `src/lib/contexte-geste.ts`, porte du socle IA
> `src/platform/ia/hors-requete.ts` ; `src/lib/prisma.ts` (le client du geste) ; ports dans `mail.ts`, `mail-smart.ts`,
> `mail/graph/provider.ts`, `push.ts`, `site-web/transport.ts`, `storage/object-storage.ts` ; module :
> `infra/capacites.ts`, `domaine/simulation.ts`, `infra/operations/index.ts` (`executerOperationJournalisee`), `infra/travaux.ts`,
> `infra/proactivite/mandats.ts`, `actions.ts`, `actions-gestes.ts`, `ecrans/action-confirmation-card.tsx`,
> `ecrans/gestes-assistant.tsx`, page `/assistant/gestes` ; console `/admin/ai/acces` (durée de garde).

## 1. Le contexte de geste, étendu

`lib/effets/magasin.ts` porte, dans un `AsyncLocalStorage` sans dépendance (le client Prisma, la garde de sortie et le
stockage le lisent) : le **mode** (`REEL` / `SIMULATION`), le **principal** (la personne au nom de qui le geste
s'exécute), l'**origine** (carte, travail, mandat), le **travail** et l'**étape**, la **clé d'idempotence**, et pendant le
geste ce qu'il a écrit (`capture`) et le client qui le porte. `lib/effets/geste.ts` garde le mécanisme J8
(`executerHorsRequete`, la personne rendue à `requireUser`, le « work store » de Next) ; un geste imbriqué hérite du
parent — **une simulation ne devient jamais réelle** par un geste imbriqué. `session.ts` lit `utilisateurDuGeste` dans
`geste.ts` (sans tirer la simulation ni le journal).

## 2. La simulation transactionnelle

`lib/prisma.ts` exporte `prismaBrut` (le client de base) et `prisma`, un **relais** : hors geste, le client de base tel
quel ; pendant un geste, le client posé par le geste. Toute l'application écrit par `prisma` : l'action de l'écran — celle
que le bouton appelle, `requireUser` / `userCan` compris — se simule **sans une ligne changée**. Dans une transaction
interactive, `$transaction` n'existe pas : le relais la rend « en place » (une fonction reçoit la transaction du geste, un
tableau s'exécute dans l'ordre).

`simulerGeste` (`simulation.ts`) ouvre une transaction sur le client qui capture, pose le mode `SIMULATION`, exécute,
attend le **calme** (une promesse « au mieux » non attendue — le miroir d'une pièce au Drive — finit d'écrire), relit
l'état final des lignes touchées, puis **annule** (un signal que seule la simulation attrape). Une écriture tardive trouve
une transaction close et échoue : le contexte ne retombe jamais sur la vraie base.

**La capture** (`capture.ts`, extension Prisma `$allOperations`) : pour chaque écriture, le modèle, l'identifiant, la
ligne **avant** (lue juste avant : dans la transaction en simulation ; sur le client de base, valeur engagée, en réel), la
ligne **après** (un `select` restreint est élargi aux scalaires puis rendu à la forme demandée — l'action reçoit
exactement ce qu'elle aurait reçu), les champs touchés. Les enfants nés d'une **création imbriquée** sont relus et notés ;
un `createMany` reçoit ses identifiants (tirés comme `cuid()`, ou fournis) et chaque ligne est nommée ; un `$executeRaw`
ou un `$queryRaw` qui écrit (`UPDATE … RETURNING`) est noté « SQL » avec sa table. Les **modèles de trace** (audit,
événements, intentions, journaux d'IA) ne sont ni montrés ni journalisés. Le schéma est lu dans le DMMF (`modeles.ts`) :
clé, scalaires, types, enfants, cascades, valeur d'annulation d'un statut — aucune table déclarée à la main.

**Les ports** (« aucun effet ne sort ») : chaque primitive de sortie appelle `noterEffetExterne` AVANT la garde de sortie —
en simulation l'effet est noté « neutralisé » et la primitive rend un succès simulé ; en réel il est noté (il part).
Courriel SMTP (`sendMail`), Microsoft Graph (`send` : pas même le brouillon), courriel par API (`sendSmartEmail`),
notification poussée (`sendPushToUser`), site Adventum (`envoyerAuSite`), stockage objet (dépôt, dépôt en parties,
suppression). Sous eux, **le port réseau** (`reseau.ts`) : en simulation, tout `fetch` qui écrit (autre que GET/HEAD) vers
un hôte non local — webhook, fournisseur — est neutralisé (réponse 202) ; en réel il est noté (sauf le fournisseur de
modèles). Le stockage en base et les files (`TacheDeFond`, `OutboundMailIntent`) sont dans la transaction.

**Le diff** (`diff.ts`, pur — la carte le lit) : « tâche « Stand du congrès » créé(e), notification à Karim, 1 pièce
déposée, courriel à … — non envoyé (simulation) », les champs « avant → après », et une **empreinte** (cyrb53) qui
neutralise ce qui change d'un passage à l'autre sans changer le geste : l'identifiant d'une ligne créée (« nouveau:Task#1 »,
y compris dans un lien), une date posée pendant le geste (« maintenant »), `createdAt` / `updatedAt`. L'empreinte porte
l'**avant et l'après** de chaque champ : si la valeur de départ a changé, la carte ne dit plus la vérité.

## 3. Les cartes

Une capacité R1–R4 **simulable** (`simulable: "oui"`) est simulée à la préparation de sa carte (`infra/capacites.ts`,
entrée complète — fiche relue pour `updateEmployee`) ; la carte montre le **diff réel** à côté des champs proposés et des
avertissements (provenance tierce J14 comprise). Une capacité non prouvée simulable porte « Non simulable : <raison> » ;
une simulation qui n'aboutit pas le dit (et son avertissement). La vue (`domaine/simulation.ts`, `VueSimulation`) est
gardée sur l'intention (`payload.simulation`) ; le fil la relit à l'affichage (une carte remontrée montre son nouveau diff).

**À la confirmation** (`executerCapacite`) : la simulation est **rejouée** et son empreinte comparée (`ecartAvecLaCarte`).
Différente — ou une simulation qui n'aboutit plus — et **rien ne s'exécute** : la carte est remontrée avec le diff de ce
qui s'exécuterait maintenant (« Maintenant : … (priority : MEDIUM → HIGH) ») ; une nouvelle confirmation compare à ce
nouveau diff. Égale : l'action s'exécute **sous le journal des effets**, avec l'empreinte montrée ; si le réel diffère quand
même (le monde a changé entre la vérification et l'écriture), l'écart est noté au journal et dit à la personne.

## 4. Le journal des effets

`journaliserGeste` (`journal.ts`) : le geste s'exécute en mode `REEL` sur le client qui capture ; à la fin (succès ou
échec, après le calme), le geste et ses effets entrent au journal sur le client de base. Une écriture qui arrive encore
après (au-delà du calme) est ajoutée à la suite (`capture.tardive`). Un geste imbriqué dans un geste journalisé n'ouvre
pas de seconde entrée. Branché sur : **les cartes confirmées** (opérations et capacités, `actions.ts`, terrain compris),
**les étapes de travaux** (`infra/travaux.ts`, `ecrire` reçoit travail, étape et clé du moteur), **les gestes sous mandat**
(`infra/proactivite/mandats.ts`). Rétention : `AssistantIaReglage.retentionEffetsJours` (console `/admin/ai/acces`, 7 à
1 095 jours, à l'audit) ; purge par la tâche planifiée `assistant.effets` (`lib/scheduled.ts`).

## 5. L'annulation honnête

`annulerGeste` (`annulation.ts`), du plus récent au plus ancien, une issue **par effet**, avec sa raison :

| Effet | Issue |
|---|---|
| champ modifié, encore à la valeur écrite | **annulé** — remis (invariant de `annulation/plan.ts`, `composer`) |
| champ modifié depuis par quelqu'un | **impossible** — « vaut maintenant X (le geste y avait mis Y) », rien d'écrasé |
| ligne créée, intacte, rien de rattaché | **annulé** — retirée (une notification : « avant d'avoir été lue ») |
| ligne créée, modifiée ou rattachée depuis, statut intact avec valeur d'annulation | **compensé** — passée à `CANCELLED` (la trace reste) |
| ligne créée, statut changé ou sans statut d'annulation | **impossible** — et ce qu'on peut faire à la place |
| notification lue | **impossible** — « Karim l'a déjà lue » |
| ligne supprimée, sans cascade | **annulé** — recréée à l'identique, **même identifiant** |
| ligne supprimée avec des enfants en cascade | **impossible** — « N éléments supprimés en cascade ne sont pas au journal » |
| statut qui vaut paiement, dépôt, signature (`reversibilite.ts`) | **impossible** — la table de réversibilité tranche |
| courriel, poussée, site, appel réseau | **impossible** — avec la compensation (`reversibilite.ts` : rectificatif…) |
| octets d'une pièce, compteur SQL des octets, SQL sur une table qui suit en cascade une ligne retirée | **sans objet** — la purge des orphelins / la cascade s'en charge |
| écriture en lot sans identifiants, SQL brut ailleurs | **impossible** |

**La course est fermée à l'écriture** : chaque écriture verrouille la ligne (`SELECT … FOR UPDATE`), la relit et n'écrit
que si elle vaut encore ce que le geste y avait laissé. Un geste ne s'annule qu'une fois (réclamation atomique) ; seule la
personne au nom de qui l'assistant a agi — ou le Super Admin — l'annule ; l'annulation va à l'audit et le geste garde son
compte rendu. Un **lot** (`annulerGestesAssistant`) rend son détail **geste par geste**, jamais un « annulé » global.

**L'écran « Ce que l'assistant a fait »** (`/assistant/gestes`, bouton « historique » de l'assistant) : les gestes de la
personne (le Super Admin : de tous), ce qu'ils ont écrit, l'écart éventuel avec la carte ; « Annuler… » montre D'ABORD
le plan (`planDAnnulation`, rien n'est écrit), puis le compte rendu ; sélection multiple pour un lot. Ses actions
(`assistant-ia-gestes-actions`) sont hors assistant (EXCLUDED d'Adam, surface hors assistant) : un assistant n'annule
pas ses propres gestes.

## 6. Le classement — `simulable` à J7

`classement.ts` `simulableDe` : lecture → oui ; la boîte IMAP (`mail-actions`, `mail-folder-actions`) → **non** (hors base
et hors ports) ; une écriture sans modèle lu → **inconnu** (non prouvée) ; sinon **oui** — notification, fichier (stockage
par un port) et effet externe R3 (par un port) compris. La raison est sur la fiche (`raisonSimulable`) et sur la carte.

## 7. Mesures

| Critère | Mesure | Cible |
|---|---|---|
| Capacités R1–R2 simulables (cliché du classement, `registre.test.ts`) | **728 / 787 = 92,5 %** | ≥ 80 % |
| Effets externes sortis en simulation (`effets/ports.test.ts`, un test par port, garde armée et `fetch` espionné) | **0** (7 ports) | 0 |
| Annulation juste sur des cas réels (`effets/annulation.test.ts` : création 15, modification 23, suppression 6, notification 3, pièce 1, gardes 2) | **50 / 50** | 50 |
| Annulations qui écrasent une valeur changée depuis par un autre | **0** (propriété éprouvée sur 14 cas, comptée) | 0 |
| Carte : diff réel, écart refusé, exécution journalisée sans écart (`infra/capacites-simulation.test.ts`) | vert | — |

**Essai réel** (un tour, `gpt-6.1-terra`, base locale `amd_bench`, `scripts/bench/simulation-essai.ts`) : « Crée une tâche pour
Karim … : préparer le stand du congrès, échéance le 6 novembre 2026. » → carte `Créer tâche` (attribué à, échéance, titre)
avec le diff simulé « tâche « Préparer le stand du congrès » créé(e), notification à Karim « Demande de tâche » » ; 0 tâche
avant confirmation ; confirmation (simulation rejouée, même empreinte) → « Créer tâche : fait. », geste journalisé ;
« Annuler » → « Fait : 2 annulé(s) sur 2 effet(s) », 0 tâche restante. 2 appels, 10 246 jetons d'entrée, 7,2 s,
**0,013 $** (plafond 0,50 $).

Règle d'architecture ajoutée : tout module qui appelle la garde de sortie appelle **aussi** le port de simulation, et
avant elle (`effets/ports.test.ts`).

## 8. Limites connues

- Un `fetch` en lecture (GET) part en simulation : il ne change rien chez personne, mais il sort. Un appel au modèle
  pendant une simulation est neutralisé (la simulation peut alors échouer, et le dire).
- En réel, une ligne écrite DANS la transaction interactive d'une action puis relue par la capture sur le client de base
  peut avoir un « après » en retard : l'annulation la trouve alors « modifiée depuis » et refuse (sens sûr).
- L'annulation écrit directement (verrou, relecture, écriture), pas par l'action de l'écran : elle ne défait que les
  effets directs du geste de la personne elle-même, sous sa propre identité, et elle va à l'audit.
- Les opérations propres à l'Assistant IA (relance, rendez-vous, BC…) sont journalisées et annulables, mais leur carte
  n'est pas simulée (elle montre ce qui est proposé) ; leur simulation est le prochain pas.
