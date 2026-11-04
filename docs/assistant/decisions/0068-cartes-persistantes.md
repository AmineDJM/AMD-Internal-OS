# 0068 — Les cartes à valider ne disparaissent plus (lot C1)

**Date** : 2026-11-04 · **Statut** : appliquée · **Touche** : socle des intentions (`platform/ia/intentions/`), fil de
l'Assistant IA (`modules/assistant-ia/infra/fil/`), carte et fil côté écran (`ecrans/`), voix (`infra/voix/carte-orale.ts`).

## Ce que la Direction a vécu (04/11)

> « Quand il y a une action à faire et qu'il me donne une carte pour que je valide, et que je ne la valide pas encore et
> que je sors de la conversation ou de l'app et que je reviens, la carte disparaît. En tout cas, le bouton pour appuyer,
> etc., disparaît. Du coup, je suis obligé de redemander une nouvelle carte. » — « Tout est une histoire d'architecture,
> pas de prompting. »

## Reproduit d'abord (vrai navigateur, build de production, base locale, vrai modèle)

Une tâche proposée par Adam, non validée, puis chaque chemin de retour (`scratchpad` de la session, état en base relevé à
chaque étape) :

| Chemin | Écran | `AssistantActionIntent` |
|---|---|---|
| recharger · arrière-plan (`visibilitychange`) · quitter et revenir · fermer/rouvrir l'onglet · `/ia` · iPhone | carte + boutons | `PROPOSED` |
| revenir, écrire un message sans rapport (« combien de jours en février 2028 ? ») | carte + boutons | `PROPOSED` |
| **revenir, en reparler** (« Ok pour la tâche de relance… Nivolex, je la valide tout à l'heure ») | boutons encore peints (refusés au clic) ; au rechargement « Action ignorée », **plus de bouton** | **`CANCELLED`**, `PROPOSED>CANCELLED_SUPERSEDED` |
| **deux tâches demandées dans le même message** | **une seule carte** | deux `PROPOSED` |

Et Adam, au tour qui avait retiré la carte, répondait « la carte reste en attente de votre confirmation » : le retrait se
jouait AVANT le modèle, sans qu'on le lui dise.

Le banc navigateur en a trouvé deux autres :
- **Ignorer** ne changeait que l'écran : la carte revenait à signer au rechargement.
- **`/assistant?c=X`** (lien de notification, retour dans une conversation) lisait d'abord la conversation *courante*
  puis X ; la première réponse, arrivée après, ramenait l'écran sur **une autre conversation**.

## Causes

1. **Retrait silencieux sur un message** — `retirerCaduquesAvantLeTour` retirait toute carte `PROPOSED` (< 2 h, de
   **toutes** les conversations de la personne) dont le message reprenait le sujet (deux mots communs), sauf question.
   Un accord, une précision sans rapport avec une correction, un message dans une autre conversation : retirés.
2. **Une seule carte gardée par tour** — le tour gardait `propositions[0]` sur `AssistantIaTour.intent` ; les suivantes
   n'existaient qu'à l'écran du tour vivant.
3. **L'état à l'écran n'avait pas une seule source** — « Ignorer » local ; une carte expirée, échouée ou retirée
   s'affichait sans boutons et sans raison (« Action ignorée » pour tout).
4. **La voix** (`ouvrirCarteOrale`) retirait la carte orale précédente dès qu'une nouvelle carte arrivait, **quel que
   soit son objet**.
5. **Une lecture en retard** (`use-fil.ts`) pouvait remplacer la conversation ouverte.

## Ce qui change (architecture, pas prompt)

**(a) Une seule source : la table des intentions.** `AssistantActionIntent` gagne `filId`, `tourId`, `carte` (migration
additive `20270239000000_c1_cartes_persistantes`). En fin de tour, `rattacherCartes` rattache **chaque** carte du tour à sa
conversation et à sa réponse, avec ce qu'elle affiche. `lireFil` relit `cartesDuFil` : toutes les cartes de la
conversation, par réponse, dans leur état canonique — plusieurs par tour, quel que soit le chemin (texte, voix déléguée,
app). Un tour d'avant C1 garde sa carte unique, relue à la même source. La carte suit l'état relu (`useEffect`), et
« Ignorer » passe par le serveur (`ignorerIntentionAssistantIA` → `CANCELLED`).

**(b) Aucune carte ne meurt en silence.** Un retrait n'a lieu que sur un signal explicite et il est **dit** :
- *annuler* (« annule », « laisse tomber ») → `CANCELLED_BY_USER_MESSAGE` + l'extrait ;
- *corriger l'objet* : le message doit reprendre le sujet **et** corriger (`estCorrection` : contredire en tête,
  « finalement », « plutôt », « au lieu de », « change », « décale »…). Un accord ou un renvoi ne retire plus rien. Le
  doute profite à la conservation. → `CANCELLED_SUPERSEDED` + l'extrait ; Adam reçoit la note « carte retirée : propose
  la carte corrigée » ;
- *remplacer* par une nouvelle carte du même objet → `CANCELLED_SUPERSEDED` + `par` / `parTitre`.
Retraits par message limités à **la conversation** où il est dit. La voix ne retire la carte orale précédente que pour le
même objet. L'écran affiche le motif à la place des boutons (`motifDeLaCarte`, `platform/ia/intentions/etat-carte.ts`) :
« Carte retirée : remplacée par « … » », « … vous l'avez corrigée (« … ») », « Carte ignorée », « Carte expirée ».

**(c) Une carte vaut jusqu'à son expiration** (`expirationCartesHeures`, 24 h par défaut) : la fenêtre de comparaison
passe de 2 h au délai d'expiration ; une carte expirée est écrite `EXPIRED` à la lecture et **dit** « expirée » ; une
carte `FAILED` dit l'erreur et garde ses boutons (le serveur autorise la reprise).

**(d) Adam voit les cartes en attente** de la conversation à chaque tour (`sectionCartesEnAttente`, lue après les
retraits) : il renvoie à la carte au lieu d'en reproposer une identique.

**Écran** : `use-fil.ts` n'applique une lecture que si sa conversation est encore celle qui est ouverte.

## Tests

- `e2e/cartes-persistantes.spec.ts` — bureau (`/assistant`) et iPhone 13 (`/ia`) : trois cartes d'un même tour, sortie,
  retour, rechargement, arrière-plan, accord puis message sans rapport (rien retiré), « Ignorer » durable, correction dite,
  carte expirée dite, onglet fermé/rouvert. **Échoue sur le code d'avant** (carte manquante), passe après.
- `src/platform/ia/intentions/cartes-persistantes.test.ts` — base réelle : accord / message sans rapport ⇒ rien retiré ;
  correction ⇒ retrait dans SA conversation seulement, motif dit ; remplacement nommé ; expiration dite.

## Hors périmètre

L'atelier et l'écran terrain gardent leur carte locale (elles ne vivent pas dans une conversation). Le chemin historique
d'Adam (`lib/assistant/boucle`) bénéficie de la règle de correction et du motif, sans rattachement à un fil.
