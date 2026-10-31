# 0033 — Sous-missions en arrière-plan, tableau de bord en temps réel, dépôt d'office (lot K3, 31/10/2026)

**Lot K3 de l'Assistant IA / app Adventum IA.** Demande de la Direction : « Quand une tâche est longue, il la fait en
arrière-plan et peut continuer de discuter avec moi dans la conversation. On peut lancer autant de sous-missions qu'il faut
et avoir un tableau de bord pour voir ces sous-missions et leurs étapes en temps réel. Au-delà de 6 pièces, proposer d'office
le dépôt de dossier, qui lit tout en arrière-plan. L'UX est super importante. Utilise l'architecture d'Adam. »

S'appuie sur le moteur des travaux (J2, [0016](0016-travaux.md) ; J8, [0023](0023-delegation.md)) — lui-même le Mission
Runtime d'Adam (`src/lib/missions/runtime` : graphe d'étapes durable, éventail, ordonnanceur borné) — et sur le dépôt de
dossier de J11 ([0030](0030-formulaires-dossiers.md)).

> Code : moteur `src/lib/missions/travaux/` — `service.ts` (`proposerTravail(…, { parentId })`, `demarrerDOffice`,
> `enfantsVivants`, réveil rapide à l'approbation), `tableau.ts` (`tableauDesTravaux`, `signatureTableau`), `regles.ts`
> (`planSansGeste`), `persona.ts` (`surFin`), `conduite.ts`, `balayage.ts` + `reveil.ts` (conduite EN PARALLÈLE,
> `TRAVAUX_EN_PARALLELE`) ; socle `src/platform/ia/travaux/outil.ts` (champs `remplace`, `parent`, statut `DEMARRE`) ;
> module `src/modules/assistant-ia/` — `infra/sous-missions.ts`, `domaine/sous-missions.ts`, `infra/travaux.ts`,
> `infra/fil/{tour,service}.ts` (`travaux` du tour, `deposerSynthese`), `actions-travaux.ts`, `actions-consommation.ts`
> (`enregistrerTravauxDOffice`), écrans `ecrans/missions/` (`use-missions.ts`, `tableau-missions.tsx`,
> `carte-sous-missions.tsx`, `reglage-d-office.tsx`), `ecrans/app/{adventum-ia-app,tiroir,reglages}.tsx`,
> `ecrans/assistant-workspace.tsx`, `ecrans/{depot-dossier.tsx,use-pieces.ts}` ; route SSE
> `src/app/api/assistant-ia/missions/flux/route.ts` ; console `/admin/ai/acces`. Migration additive
> `20270216120000_sous_missions`. Tâche de fond `assistant.sous-missions`. Bancs : `infra/sous-missions.test.ts`,
> `infra/travaux-un-plan-par-tour.test.ts`, `domaine/lecture/depot-dossier.test.ts`, `scripts/bench/k3-missions-ux.ts`.

## 1. Plusieurs sous-missions par tour — reformuler ≠ lancer une autre

La règle « un tour, un plan » (banc réel du 31/10, cinq doublons quand le modèle reformulait) REMPLAÇAIT tout second plan du
tour. Elle empêchait aussi de lancer deux travaux indépendants d'un seul message. Désormais l'outil `lancer_un_travail` dit
explicitement ce qu'il fait :

| Appel dans le même tour | Effet |
|---|---|
| `remplace` = l'identifiant d'un plan proposé dans CE tour | le plan est remplacé (l'ancien est annulé) — la reformulation |
| même titre (aux accents, à la casse et à la ponctuation près) qu'un plan de ce tour, sans `remplace` | remplacé aussi : le garde-fou contre les doublons tient sans compter sur la discipline du modèle |
| autre titre, sans `remplace` | **une sous-mission de plus**, gardée |
| `parent` = l'identifiant d'un travail de la personne | la sous-mission est rangée sous ce travail (`Mission.parentMissionId`, la relation `SubMissions` d'Adam) ; un parent d'une autre personne est refusé |

Le plan d'un tour PRÉCÉDENT n'est jamais touché. Les sous-missions d'une personne tournent **en parallèle** : le battement
et la boucle des réveils conduisent plusieurs travaux à la fois (`enParallele` de l'ordonnanceur d'Adam, borne
`TRAVAUX_EN_PARALLELE`, 4 par défaut, 12 au plus) ; chaque conduite garde le bail de SON travail (deux exécutants ne
conduisent jamais le même travail), et à l'intérieur d'un travail la concurrence reste celle du moteur (`maxConcurrency` 3).

## 2. En arrière-plan, sans bloquer — et le résultat revient dans la conversation

- La conversation n'attend pas : un travail tourne sur le worker, le fil reste libre (un second message est répondu pendant
  que les sous-missions tournent — mesuré au banc).
- **La carte qui se met à jour** : les identifiants lancés pendant un tour sont gardés sur ce tour (`AssistantIaTour.travaux`)
  ; sous la réponse, la carte « 3 sous-missions » montre chacune — état, étape en cours, avancement, coût — en temps réel
  (le flux du §3), avec « Approuver et lancer » / « Tout approuver » pour celles qui attendent.
- **La synthèse à la fin** : quand la DERNIÈRE sous-mission d'un tour est finie (terminée, en partie, bloquée, en échec ou
  annulée), une réponse de l'assistant s'écrit dans la conversation : un en-tête (n/m terminées, coût total), un « en bref »
  de 3 à 6 phrases par le modèle **rapide** quand au moins deux ont abouti (sur les livrables, passés au filtre de
  confidentialité ; un échec n'empêche pas la réponse), puis chaque sous-mission (extrait du livrable, lien vers le document
  du Drive, durée). Unique par tour (`AssistantIaTour.syntheseDe`, index unique : la fin de chaque sous-mission, une
  annulation et le rattrapage peuvent tous la demander, une seule s'écrit). Déclenchée par la persona (`surFin`, appelé par la
  conduite à la fin d'un travail) ; rattrapage par la tâche `assistant.sous-missions` ; annuler depuis le tableau la déclenche
  aussi. La personne est **notifiée** (cloche + téléphone, lien vers la conversation) ; l'écran ouvert relit le fil dès qu'il
  voit une mission finir.
- Toutes annulées par la personne : pas de synthèse (elle sait).

### Approbation : démarrer d'office les plans SANS GESTE

Un plan dont toutes les étapes sont LECTURE, LOTS, ANALYSE ou LIVRABLE (le livrable est déposé dans le Drive de la personne
elle-même), et qui n'autorise aucun geste, peut démarrer sans clic : l'approbation est donnée au nom de la personne, dite au
journal (« Démarré d'office », `TRAVAIL_DOFFICE`), et l'outil répond `DEMARRE`. Dans la conversation, ce démarrage a lieu **à la
fin du tour** (`demarrerLesSousMissions`, après l'écriture de la réponse) : le premier banc réel a montré le modèle rappeler
l'outil sur plusieurs étapes d'un même tour — un plan démarré aussitôt puis remplacé avait déjà coûté ; en attente le temps du
tour, il est annulé avant d'avoir rien dépensé. Un GESTE, une DEMANDE à un collègue ou une
ATTENTE dans le plan : toujours approuvé à la main.

**Le réglage** (décision proposée, à confirmer par la Direction) : **OUI pour le Super Admin, NON pour les autres** — la
préférence de la personne prime (Réglages de l'app, pied du tableau « Missions » : table `AssistantIaPreference`), sinon la
console (`/admin/ai/acces`, carte « Sous-missions », par rôle ; colonne `AssistantIaAcces.travauxDOffice`), sinon ce défaut.

## 3. Le tableau de bord EN TEMPS RÉEL

- **Le flux** : `GET /api/assistant-ia/missions/flux` (Server-Sent Events, `runtime = nodejs`). À l'ouverture, le tableau
  complet ; puis chaque seconde la SIGNATURE (une agrégation SQL — nombre de missions visibles, dernières écritures d'une
  mission ou d'une étape —, aucune ligne rapatriée) : elle change → le tableau est relu et poussé. Un commentaire toutes les
  15 s (un mandataire ne coupe pas un flux muet), en-têtes `no-transform` et `X-Accel-Buffering: no`. Après 4 min 30 le
  serveur ferme proprement et le navigateur se reconnecte (`retry: 1500`) : aucune connexion n'est tenue au-delà de ce que
  Render tolère. Cloisonné (personne de la session ; « Vue exacte » refusée).
- **L'écran** (`ecrans/missions/use-missions.ts`) : UNE connexion par onglet, partagée par l'indicateur, les cartes et le
  tableau ; trois erreurs de suite sans un message (mandataire qui bloque le flux) → **sondage court** (3 s) par l'action
  `lireMonTableauDeMissions` et nouvel essai du flux toutes les 30 s ; onglet caché → flux fermé, rouvert au retour. Plus le
  sondage de 15 s.
- **Le contenu** (inspiré des écrans de missions d'Adam : `mission-runtime-panel`, `mission-journal`) : chaque mission —
  état, avancement (les lots d'un éventail comptent à leur part), coût / plafond, durée (en continu), « d'office » ; ouverte :
  ses étapes (en file, en cours, faite, en attente, échec, écartée — durée de chacune, lots n/m), ses livrables (ouverts dans
  l'aperçu), son journal ; actions : approuver, pause, reprendre, annuler (avec ses sous-missions, confirmation en deux
  temps), revenir à la conversation. Onglets En cours / À approuver / Terminées (3 jours) ; les missions lancées par un même
  message se regroupent sous leur conversation.
- **L'UX** : celle de l'app (jetons `--aia-*`, charte Adventum, clair et sombre), mobile d'abord : plein écran sur
  téléphone, tiroir de 460 px à droite sur ordinateur ; cibles ≥ 44 px sur téléphone. Indicateur discret dans l'en-tête de
  la conversation (« 3 missions en cours », point qui respire ; « 3 en cours » sur téléphone). Mêmes composants dans l'app
  Adventum IA (`/ia` — l'onglet « Missions » du tiroir est lui aussi en temps réel) et dans l'Assistant IA de l'ERP
  (`/assistant`). Une notification `?travail=` ouvre le tableau sur la mission.

## 4. Le dépôt d'office au-delà de 6 pièces

`PIECES_LUES_MAX` (6) devient le seuil du mode dépôt, pour des fichiers ISOLÉS comme pour un DOSSIER (`modeDuDepot`) — en
comptant les puces déjà là, qui rejoignent le dépôt. Une seule puce : **« 14 fichiers : tout lire en arrière-plan »** (ou
« Dossier « X » — 14 fichiers : … »). À l'envoi, le lot s'ouvre (fichiers isolés rangés sous un dossier daté du Drive), le
gestionnaire d'envois les dépose, la Bibliothèque les lit TOUS, et l'assistant les interroge ensuite (`lire_dossier_depose`).
La borne `PIECES_PAR_ENVOI_MAX` (10) ne refuse plus de fichiers isolés : ils passent par le dépôt. Une pièce du Drive jointe
au-delà de 6 n'est plus « nommée non lue » sans proposition : la phrase propose le dépôt.

## 5. Ce qui ne change pas

Les droits de l'assistant restent ceux de la personne (chaque lecture et chaque geste relus à chaque étape) ; un geste n'est
jamais fait sans l'approbation du plan qui le porte ; le filtre de confidentialité s'applique à la synthèse comme au reste ;
les plafonds de dépense (travail, mois, jour) endorment un travail sans le tuer.

## 6. Décisions à confirmer par la Direction

1. Le défaut du démarrage d'office : OUI pour le Super Admin, NON pour les autres (réglable par rôle et par personne).
2. La borne de parallélisme `TRAVAUX_EN_PARALLELE` = 4 par processus (worker).
3. Le « en bref » de la synthèse par le modèle rapide (quelques centièmes de dollar) — on peut le couper pour ne garder que
   la synthèse composée sans modèle.
