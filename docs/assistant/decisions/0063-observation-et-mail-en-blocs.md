# 0063 — L'OBSERVATION comme primitive, missions factuelles, mail en blocs (lot I1, 03/11/2026)

Application des étapes **1, 2, 3 et 5** du rapport AU1 (`docs/assistant/audit-2026-11-03/au1-verite.md` §5, branche
`jarvis/au1-verite`), dans le cadre de la décision de la Direction du 03/11/2026 :

> « Je veux que tu implémentes cette architecture cible. […] laisser une totale liberté, créativité […] mais que ça soit
> pro et bien. Mais des fois, je peux demander des choses qui ne sont pas forcément très pro et qu'il les fasse. »
> « Il fait ce que moi je lui dis, pas selon ce qu'il trouve dans le code. […] Tout est une histoire d'architecture, pas de
> prompting. »

L'étape 4 (contrôle final affirmations ⟷ observations) n'est **pas** dans ce lot : elle viendra en I5, sur ce contrat.

## 1. Le contrat Observation (`src/modules/assistant-ia/domaine/observation/contrat.ts`)

Un geste du tour rend UNE observation, **construite par le serveur depuis l'état réel** :

```ts
Observation { nature, objet: { type, id, lien }, etat, projection, empreinte, observeLe }
// nature : "carte" | "mail" | "fichier" | "mission" | "effet" | "lecture"
// etat   : PROPOSEE, A_COMPLETER, CONFIRMEE, EXECUTEE, ECHEC, ANNULEE, EXPIREE, RETIREE, BROUILLON, PROGRAMME, PARTI,
//          ECRIT, INTROUVABLE, LU, ou l'état du moteur (missions)
// projection : attributs typés et bornés, du TEXTE — jamais de HTML (`texteObservable` retire toute balise)
```

- **Cinq projecteurs**, par nature d'objet et non par outil (`domaine/observation/projecteurs.ts`) : `projeterCarte`
  (et ses `mails`), `projeterFichier`, `projeterMission`, `projeterEffet`, `projeterLecture` (+ `lectureDeSortie`,
  `lectureDeBloc` pour ce qui a été montré). `natureDuRendu(html, texte)` lit le HTML **réel** : tableaux de données,
  bandeau, couleurs d'accent → « texte brut », « HTML sobre », « HTML à la charte — bandeau #087084, 1 tableau »,
  « HTML mixte (charte en partie) ».
- **Stable** : P1 branche sa vue de mission sur `observationDeMission` (`infra/missions/pilotage.ts`) ; I3 branche les
  observations de `produire` / `fichier` sur `natureDuRendu` et `projeterFichier`. Ajouter un attribut est permis ; en
  retirer un se décide (I5 les compare au message).

## 2. Le journal du tour et l'enveloppe des outils (étapes 1 et 2)

- `infra/observation/journal.ts` — `JournalDuTour` remplace les tableaux parallèles de `fil/tour.ts` (cartes, sorties,
  mémoires, notes, visuels, analyses, sous-missions **et** `pilotagesEchoues`, supprimé). Il est alimenté à UN endroit :
  `envelopper(outil)`, appliqué à tous les outils du tour.
- **La sortie d'outil d'une carte est sa projection** (étape 2) : `{ statut: "EN_ATTENTE_DE_CONFIRMATION", observation }`,
  passée par la garde du coffret (repères, ou valeurs en clair permises). Les consignes « Résume en une phrase ; ne dis
  jamais que c'est fait » (opérations, capacités, écritures d'Adam, missions, annulation, mails) sont **retirées** : le
  modèle décrit ce qu'il voit. Un outil appelé dans un autre (`envoyer_mail` → `envoyer_gmail`) n'est observé qu'une fois.
- Un producteur déclare ses observations sous `_observations` (missions) — l'enveloppe les reprend et les retire de ce
  que lit le modèle. Un fichier cité (`/api/drive/<id>/raw`) et une lecture tabulaire sont observés sans déclaration.
- Un échec se lit au **statut** de la sortie (REFUS, AMBIGU, ECHEC, BLOQUE, INCOMPLET, RIEN) : la garde de vérité actuelle
  (en attendant I5) ne le compte pas comme preuve.

## 3. L'historique observé (étape 1)

- `AssistantIaTour.observations` (JSON, migration `20270237000000_i1_observations`, additive et idempotente) garde les
  observations du tour.
- `infra/observation/historique.ts` — `historiqueObserve` : chaque réponse passée repart au modèle avec un bloc
  « [Observé par le serveur — état actuel, relu en base : …] », **re-projeté** à chaque tour (`reprojeter.ts` : une
  requête par nature, sous la portée de la personne — `userId`, `principalId`, droits du Drive ; les effets sortants du
  Gmail d'Adam relus avec leur statut). Borné à 1 400 caractères par réponse (le texte du mail cède le premier), dans
  les messages (le préfixe en cache ne bouge pas). Un tour d'avant I1 est observé par son intention et ses blocs.
- Une erreur signalée trouve l'état réel **sans détecter la contestation** : il est toujours là, à jour.
- Sécurité : jamais de HTML brut ; l'historique passe par `filtrerSaisie` (repères, valeurs révélées masquées) comme le
  texte des réponses.

## 4. Missions factuelles (étape 3)

- `diagnostiquerMission` lit l'âge (`majLe`) : « prête, aucune étape démarrée — dernière activité il y a 40 s » (code
  `PRETE`), ou « aucune étape démarrée depuis 2 h ; le balayage est passé il y a 30 s sans la démarrer » (code
  `IMMOBILE`, affiché en alerte au tableau des missions). La prévision « part au prochain battement (moins d'une minute) »
  est **supprimée**. Test de constat AU1 C2 inversé.
- `mes_missions` rend `lien: /missions/<id>` et `derniere_activite` par mission ; plus de consigne « tels quels ».

## 5. Le mail en blocs (étape 5)

- `domaine/mails/composer.ts` remplace `gabarit.ts` (supprimé) : **un seul** `composerMail`. Le mail est un document de
  blocs (`paragraphe`, `titre`, `liste`, `tableau`, `bandeau`, `signature`, `pied`, `separateur`, `html`).
  - `style` du document : `sobre` (**défaut**, professionnel, sans couleur ni bandeau), `charte` (l'ancien gabarit,
    devenu un style), `texte` (aucun HTML). Un bloc peut porter son style (`charte`, `sobre`, `simple`) : la charte
    s'applique à tout, à rien ou à une partie (« moitié charte, moitié simple »). Le bloc `html` laisse toute liberté.
  - L'ancien contenu structuré (salutation, paragraphes, tableau…) se lit encore comme des blocs (entrée normalisée côté
    serveur).
- **Assainissement = invariant** : `composerMail` exige un `assainir` ; `infra/mails/redaction.ts rendreLeMail` passe
  TOUT le corps par `sanitizeMailHtml(html, { styles: true })` — liste blanche de balises, d'attributs de tableau, de
  propriétés CSS en ligne ; `url(`, `expression(`, `javascript:`, `@import`, `behavior`, `-moz-binding`, échappements et
  entités HTML refusés ; pas de `position`. Le corps d'un mail **reçu** ne garde toujours aucun style.
- Les deux chemins de rendu (`rendreMailHtml` sans condition dans `envoi-gmail.ts` et `boites.ts`) sont **retirés** : les
  deux appellent `rendreLeMail`. La consigne « jamais du HTML : le gabarit le met en page » est **retirée**.
- **L'expéditeur est observé, jamais changé implicitement** : la carte porte `mails[]` (`expediteur`, `a`, `objet`,
  `texte`, `html`) ; les capacités d'envoi (`microsoft-mail__*`, `mail__sendMailAction`, `smart-mail__sendMail`) restent
  dans le tour pour `envoyer_mail` mais **hors du catalogue offert au modèle** (constat AU1 S1.3 : il passait par la
  boîte SMTP pour obtenir du texte). Une boîte texte seul (SMTP, ERP) le dit sur la carte (« mise en forme non
  conservée »).

## 6. Interrupteurs de repli (`infra/observation/interrupteurs.ts`)

| Variable | Effet |
|---|---|
| `ADAM_OBSERVATION=0` | étapes 1 et 2 coupées : sorties d'outil d'avant, historique en texte seul |
| `ADAM_OBSERVATION_HISTORIQUE=0` | étape 1 seule coupée |
| `ADAM_MAIL_BLOCS=0` | étape 5 : tout mail rendu à la charte, comme avant (le style choisi est ignoré) |

L'étape 3 se reverse par une ligne (`diagnostiquerMission`).

## 7. Mesure

Banc `scripts/bench/au1-verite/rejouer.ts` (repris de `jarvis/au1-verite`) : l'historique y est construit par
`historiqueObserve`, comme le fil. Résultats dans le rapport de lot.
