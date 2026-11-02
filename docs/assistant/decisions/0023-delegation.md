# 0023 — Les travaux pour tous, suite : délégation, attentes avancées, équipe, robustesse, livrables (lot J8, 30/10/2026)

Suite de [0016](0016-travaux.md) (J2). Architecture validée : <https://claude.ai/artifact/34ig3QRV5X7LtanjyuX7U7>, lot J8 —
critère : « reprise en moins de 90 s après l'événement ; un travail de 3 semaines traverse 10 redéploiements sans
doublon ». Toujours **pas de troisième moteur** : un travail reste une `Mission` `kind = "TRAVAIL"` conduite par `avancer`.

Migration additive et idempotente `20270214100000_travaux_delegation` : table `TravailDemande`, `Mission.reveilDemandeLe`
(+ index `kind, reveilDemandeLe`), `AssistantIaReglage.managerVoitEquipe` (défaut `false`).

## 1. La délégation — `DEMANDER_A(personne, question, pièces attendues, échéance)`

Nouvelle étape de plan **`DEMANDE`** (`plan.ts`) : `{ a, question, pieces, partager, jours|minutes, relance?, escalade?, abandon? }`,
compilée en nœud **`WAIT_INPUT`** du moteur.

| Temps | Où | Ce qui se passe |
|---|---|---|
| Proposition | `service.ts` `resoudreDemandes` | `a` se résout **maintenant** : un compte actif, désigné sans ambiguïté (identifiant, e-mail, nom exact), jamais soi-même ; les pièces à `partager` doivent être des pièces du Drive que la personne voit. Faux : les fautes repartent au modèle. |
| Dépôt | `delegation.ts` `deposerDemande` (gestionnaire `WAIT_INPUT` de `conduite.ts`) | **Une** demande par étape (clé unique `missionId, stepKey`) ; les délais comptent **du dépôt** et deviennent des dates absolues sur la ligne ; les pièces partagées sont accordées **en lecture** (`DriveShare`, jamais par-dessus un droit existant, à l'audit) ; la personne sollicitée est notifiée (lien `/assistant?demande=…`) ; fait `DEMANDE_DEPOSEE`. Rejoué après un redémarrage : ni seconde demande, ni second avis. |
| Réponse | `repondreDemande` (panneau, ou carte `preparer_reponse_demande`) | Un texte et des pièces de **son** Drive (droits relus), accordées en lecture au demandeur ; l'étape se règle (mêmes clés qu'une attente réglée : `reponseDe`, `contenu`, `pieces`) ; la réponse entre au **carnet** ; le travail est signalé au réveil rapide ; fait `DEMANDE_REPONDUE`. |
| Refus | `declinerDemande` | Avec un motif, que le demandeur lit ; le travail reprend sans la réponse. |
| Temps | `jalons.ts` | **Relance** (défaut : à mi-délai) → rappel à la personne sollicitée ; **escalade** (défaut : à l'échéance) → son responsable hiérarchique (organigramme, `getManagerOfUser`) et le demandeur le sait ; **abandon** (défaut : un second délai) → la demande expire, l'étape se règle en **TIMEOUT** : le plan peut prévoir une suite (`si: { issue: "TIMEOUT" }`). |
| Annulation | `annulerTravail` | Les demandes ouvertes sont retirées ; la personne sollicitée le sait. |

**Ce que la personne sollicitée voit** (`DemandeRecue`) : qui demande, la question, les pièces attendues, les pièces
partagées, l'échéance, son statut — **jamais** le titre, le plan, le carnet ni les livrables du travail (test : les clés
de la vue sont fixées). **Pas de discussion entre agents** : son Assistant IA l'aide avec **ses** droits (lecture
`mes_demandes_recues`, carte `preparer_reponse_demande`) ; la réponse est toujours son clic. La question est écrite par le
travail d'un collègue : sa sortie est **encadrée comme contenu non fiable** (`contenu-non-fiable.ts`).

## 2. Les attentes avancées

- **Prédicat de charge utile** sur les **34 types** du catalogue des faits (`events/catalogue.ts`, deux types neufs :
  `DEMANDE_DEPOSEE`, `DEMANDE_REPONDUE`) : un fait du bon type au mauvais prédicat ne règle rien — testé type par type.
- **Jalons d'une ATTENTE** : `relance { jours }` (avis à la personne du travail) et `escalade { jours, a: PRINCIPAL | RESPONSABLE }`
  (au N+1). Comme l'échéance (J2), ils sont posés en dates absolues **à l'approbation**. Chaque jalon part une fois (clé
  au journal du travail ; écriture conditionnelle pour les demandes) — deux exécutants, ou un battement rejoué, n'envoient
  qu'un avis.
- **Minuteries** : inchangées (J2).
- **Réveil rapide** (`reveil.ts`) : tout ce qui règle une attente d'un travail — un fait (`router.ts`), une minuterie
  échue, une réponse à une demande — **signale** le travail (`Mission.reveilDemandeLe`) ; une **boucle courte**
  (`armerReveilsTravaux`, `scheduled.ts`, 10 s, `TRAVAUX_REVEILS_MS`) le conduit aussitôt, sur le worker (`scripts/worker.ts`)
  et sur le web quand il conduit les travaux. Le signal s'efface **à sa valeur** avant la conduite (un second signal
  survit) ; la conduite prend le bail du travail (deux boucles ne conduisent jamais le même travail ensemble).
  **Mesuré** (`attentes.test.ts`, vraie base, boucle à sa période de production, faits à des instants quelconques) :
  médiane **7,5 s**, **p95 10,0 s** (critère : 90 s).

## 3. Plusieurs travaux par personne, et la vue d'un responsable

- **Priorité** d'un travail (`HAUTE` / `NORMALE` / `BASSE`, plan ou panneau, `reglerPrioriteTravail`) → `Mission.priority`.
- **Équité** (`travauxAFaireAvancer`) : les candidats du battement se servent **à tour de rôle par personne** (fenêtre
  `ROW_NUMBER() OVER (PARTITION BY principalId …)`), par priorité au sein des travaux d'une même personne — dix travaux de
  l'une n'affament pas l'unique travail de l'autre.
- **Un responsable voit les travaux de son équipe SI la console l'autorise** : nouvelle option dans `/admin/ai/acces`
  (« Travaux de l'équipe », **défaut : non**, `enregistrerVisibiliteEquipe`, changement à l'audit). L'équipe est la ligne
  hiérarchique réelle (`isManagerOfUser`, la même que les circuits de validation). Il voit le **résumé et les étapes**,
  en lecture seule — ni carnet, ni journal, ni livrables, ni demandes. **L'audit enregistre qui voit quoi** : chaque
  consultation (liste, détail) est une ligne `AuditLog` (`Assistant IA — travaux`).

## 4. La robustesse — mesurée sur de vrais processus

`robustesse.test.ts` lance chaque passage comme un **processus Node** (`scripts/bench/travail-processus.ts`) et l'**abat
par `SIGKILL`** à une sonde — pas de `finally`, pas de bail rendu :

- **Un travail de 3 semaines** (horloge factice, 21,1 jours) — lecture, lots, analyse par lot, synthèse, attente d'une
  signature avec relance et escalade au responsable, geste, demande à un collègue, minuterie de 17 jours, second geste,
  livrable Word — traverse **10 redéploiements forcés** : pendant la lecture, pendant l'analyse d'un lot, pendant la
  synthèse, au repos entre deux étapes (×2), juste après chaque geste (reçu clos, étape pas encore écrite), pendant le
  dépôt de la demande, pendant la rédaction du livrable, pendant son dépôt au Drive. Résultat : **2 gestes pour 2 étapes
  de geste, 1 livrable déposé, 1 demande, 1 avis à la personne sollicitée, 1 relance, 1 escalade** ; seules les étapes
  tuées **en cours** ont recommencé (une fois chacune) ; aucune étape terminée n'a été refaite.
- **Deux preneurs, web + worker** (deux processus simultanés sur le même travail) : chaque étape exécutée **une fois**
  (le bail tranche ; l'un bute sur le bail de l'autre). Même chose pour deux conduites simultanées dans un même processus
  (la réservation des étapes en base).
- Le dépôt d'un livrable est un geste sous reçu : un reçu réclamé jamais clos (processus tué pendant le dépôt) fait
  **retrouver** le document (nom déterministe) au lieu d'en créer un second.

## 5. Les livrables — de vrais documents au Drive

Étape `LIVRABLE` : `format` `docx` (défaut) | `pdf` | `xlsx` | `md` (carnet seulement). Le modèle rédige en Markdown ;
`assistant-ia/infra/travaux-livrables.ts` le met en forme avec la **fabrique** (`composerDocx` : titres, paragraphes,
gras, puces, tableaux ; `construireClasseurVerifie` : une feuille par tableau, nombres en nombres) et le **dépose au
Drive personnel** de la personne, dossier « Travaux », par le port du Live Office — **inscrit à la Bibliothèque**. Le PDF
passe par les **conversions de l'Atelier** (J3) depuis le Word déposé : LibreOffice du worker, ou la voie disponible ici,
dite. Le carnet garde le Markdown et le lien du document ; le panneau montre « Ouvrir » vers le Drive.

## L'interface

Panneau « Travaux » de `/assistant` : trois onglets — **Mes travaux** (priorité, demandes envoyées et leur état, livrable
au Drive), **Demandes reçues** (répondre avec des pièces du Drive, décliner, « Préparer avec l'assistant »), **Mon
équipe** (si la console l'autorise ; l'écran dit que la consultation est à l'audit). Notification d'une demande →
`/assistant?demande=…` ouvre le panneau sur elle ; le bouton « Mes travaux » compte plans à approuver et demandes reçues.

## Ce qui reste

- La persona **Adam** reste hors des travaux (J15) — une demande d'Adam à un collaborateur passe toujours par ses
  missions de coordination.
- Les jalons d'une ATTENTE comptent de l'approbation (comme son échéance, J2) ; ceux d'une DEMANDE, du dépôt. Une
  attente placée tard dans un plan long gagne à porter des délais en conséquence (la consigne de l'outil le dit).
- La vue « équipe » ne descend pas dans les livrables : un responsable qui en a besoin les demande… par une demande.
