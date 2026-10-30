# 0016 — Les travaux longs : le Mission Runtime pour tous (lot J2, 30/10/2026)

**Décisions de la Direction (29/10/2026)** appliquées ici — proposition <https://claude.ai/artifact/8TCDJTz6Nxow3qUtjb2hRS>
(J2) et <https://claude.ai/artifact/34ig3QRV5X7LtanjyuX7U7> (noyau) :

1. le worker Render est toujours allumé — les travaux longs y tournent ;
3. le worker est une **image Docker** (LibreOffice, ffmpeg, OCR) ;
4. **plafonds de dépense** par personne et par mois, et **par travail (20 $ par défaut)**, réglables dans la console
   `/admin/ai/acces` ; atteint, le travail **dort** (il n'échoue pas) ;
5. écritures pendant un travail long : **un plan approuvé une fois** avec la liste des gestes autorisés, limitée aux
   familles ouvertes dans la console ; les droits sont **relus à chaque étape et à chaque écriture**.

## Le constat (vérifié dans le code)

- L'Assistant IA (`src/lib/agent`, fil `fil/service.ts`) travaille **au plus 4 min et 24 étapes** en arrière-plan ; un
  redémarrage **rejoue tout le tour** (`reprendreLesFils`) ; ses routines sont en lecture seule.
- Le **Mission Runtime** d'Adam (`src/lib/missions/runtime/*`) tient des semaines — `avancer` sans état, étapes typées,
  baux, clés d'idempotence uniques, éventails bornés, attentes réveillées par `recordEvent` et par le temps, reçus —
  mais `Mission.ownerId` = « le PDG », et lancer une mission exige le Super Admin.

## Ce qui a été fait : généraliser, pas un troisième moteur

Un **travail** est une `Mission` de `kind = "TRAVAIL"`, conduite par **le même `avancer`**. Migration additive et
idempotente `20270208100000_travaux` : `Mission.principalId` (n'importe quel collaborateur), `persona`
(`ADAM` | `ASSISTANT_IA`), `plafondUsd`, `carnet`, `gestesAutorises`, `planApprouveLe/Par`, `pointQuotidienLe` ; table
`TravailEcriture` (le reçu d'un geste) ; plafonds `plafondTravailUsd` / `plafondMensuelUsd` dans `AssistantIaReglage`
(défauts 20 $ / 50 $) et `AssistantIaAcces` (par rôle ou personne). **Aucune mission d'Adam n'est réécrite** : leurs
nouvelles colonnes restent nulles, et tous les balayages d'Adam filtrent déjà `kind = "RUNTIME"`.

Retouches **additives** au moteur partagé (défaut inchangé) : `materialiser({ kind, naissance })`, les gestes de
contrôle (`mettreEnPause`, `reprendre`, `annuler`) acceptent `kind`, une attente peut porter un **prédicat sur la charge
utile** (`payload: { statut: "SIGNE" }`, `events/match.ts`), et le réveil temporel peut être borné à des missions (bancs).

| Où | Quoi |
|---|---|
| `src/lib/missions/travaux/plan.ts` | le plan (pur) : `LECTURE`, `ANALYSE` (`pourChaque` sur des lots), `LOTS`, `GESTE`, `ATTENTE` (événement + prédicat + échéance, ou minuterie), `LIVRABLE`, condition `si` ; validation contre le catalogue de la persona ; compilation en étapes du moteur **à l'approbation** (une minuterie part du « oui ») |
| `persona.ts` | le **port** d'une persona — le moteur ne connaît ni Adam ni l'Assistant IA |
| `conduite.ts` | un passage = des vagues d'`avancer` ; avant chaque vague : droits relus, plafonds ; exécutant des capacités (lectures, gestes, lots), étapes de modèle (analyse, livrable) sur le **carnet**, juge, porte d'attention |
| `ecritures.ts` | le reçu d'un geste : réclamé avant, clos après ; FAIT → jamais refait ; réclamé jamais clos → **jamais rejoué**, l'étape échoue et le dit |
| `carnet.ts` | objectif, plan, notes, trouvailles, livrables — relu par chaque étape **à la place de l'historique** ; écriture idempotente par étape, sous verrou de ligne |
| `service.ts` | proposer, **approuver**, lister, lire, pause, reprise, annulation, plafond — la personne est dans chaque `where` |
| `balayage.ts` | la tâche `travaux.balayage` : minuteries échues, travaux qui ont à faire (requête qui ne charge pas ceux qui dorment), réveil des sommeils de plafond, **point quotidien** |
| `regles.ts` | l'état affiché (`BUDGET_HOLD` = une pause à part), « attend « la signature du BC » depuis 2 jours » |
| `src/platform/ia/travaux/outil.ts` | **socle IA** : l'outil `lancer_un_travail`, sa consigne, l'indice « demande longue » — zéro import, le moteur est injecté |
| `src/lib/agent/travaux.ts` | **la persona Assistant IA** : lectures du tour (sous la vue de la personne, familles de la console, sorties censurées), gestes = opérations de l'Assistant IA (`proposer` puis `executerOperationIA`), modèle sous budget au nom de la personne, plafonds de la console |
| `src/lib/actions/assistant-ia-actions.ts` (gestes « travaux »), `components/assistant-beta/travaux-panel.tsx` (+ la coque commune `panneau-lateral.tsx`) | le **panneau « Travaux »** de `/assistant` et la carte « Approuver le plan » |

### Le parcours

1. La personne écrit une demande qui dépasse un tour. La consigne du tour décrit les travaux ; un **indice** s'ajoute
   quand la demande en a la forme (volume, période, « si pas de réponse… ») ; le **modèle choisit** d'appeler
   `lancer_un_travail` avec un plan.
2. Le plan est relu contre ce que la persona sait lire et faire **pour cette personne** ; faux, ses fautes repartent au
   modèle. Juste, le travail naît en `AWAITING_APPROVAL` — rien ne tourne.
3. Panneau « Travaux » : étapes, **gestes autorisés** (libellé et famille), **plafond** → « Approuver le plan ». Les
   gestes sont relus au clic : un geste fermé entre-temps fait refuser l'approbation.
4. Le battement conduit le travail par vagues. Chaque étape écrit son résultat dès qu'elle finit : **c'est le point de
   reprise**. Un redémarrage reprend l'étape qui tournait (orpheline après 10 min), et rien d'autre.
5. Un geste n'est fait que s'il est dans la liste approuvée, que la console l'ouvre encore (relu), et que son reçu
   n'est pas déjà clos.
6. Attentes : un **événement métier** (`recordEvent` réveille sans attendre le battement), avec prédicat et échéance ;
   une **minuterie** ; « si pas de réponse sous 21 jours, relance » = attente `{ evenement, jours: 21 }` + geste
   `si: { issue: "TIMEOUT" }`.
7. Plafond atteint (travail, mois de la personne, jetons du jour) : pause `BUDGET_HOLD`, notification ; « Reprendre »
   est refusé avec le motif tant que le plafond tient ; relevé, le battement suivant le **réveille seul**.
8. Fin : notification (une fois) ; point quotidien pour un travail de plus d'un jour ; livrable au carnet, lu dans le panneau.

### Le worker

`render.yaml` : `amd-worker` en `runtime: docker` (`Dockerfile.worker`, `dockerContext: .`), **`TACHES_DE_FOND=web`
gardé** (la Direction bascule), `plan:` de la base et du web **inchangés** (décision en attente). Sous `les-deux`, le web
s'abstient de conduire les travaux dès que le worker bat. Procédure : `docs/readme/24-deploiement-render.md`.

## Mesures

- `src/lib/missions/travaux/travaux.test.ts` (vraie base, vrai moteur, persona double qui compte ses appels) : **un travail
  de 2 h (horloge factice) traverse 3 redémarrages forcés** — pendant une analyse de lot, juste après un geste (reçu
  clos, étape non écrite), pendant la rédaction du livrable — avec 1 lecture, 1 analyse par lot (2 pour celle morte en
  route), 1 synthèse, **1 seul geste**, 3 reprises d'orphelines au journal, 1 notification de fin ; droits retirés entre
  deux gestes → le second est refusé (`MISSING_PERMISSION`, `GESTE_REFUSE`) ; geste hors plan refusé ; plafond →
  `BUDGET_HOLD`, reprise refusée, relevé → reprise au même point ; attente réveillée par `recordEvent` (un BC
  « transmis » ne règle rien, « signé » oui ; la relance est écartée) ; sans réponse sous 21 jours, la relance part ;
  cloisonnement (un collaborateur ne lit, n'approuve, ne suspend ni n'annule le travail d'un autre) ; compte désactivé →
  pause `DROITS`.
- **Banc live** `scripts/bench/travaux-live.ts` (`gpt-6.1-terra`, base de banc) : l'assistante de direction demande
  « analyse toutes les demandes Ad & Pro de l'année… » → le modèle appelle **lui-même** `lancer_un_travail` (3 étapes),
  approuvé, conduit jusqu'au **rapport chiffré** (6 demandes, 2 195 000 DZD, deux en attente) : 0,12 $ tour compris.
  Plan fixe en **5 étapes** (lecture, deux analyses, minuterie, livrable) : terminé, 0,03 $. Le premier passage a
  révélé un défaut corrigé : une lecture **refusée** par la console (famille fermée) passait pour réussie — elle échoue
  désormais en le disant, et le plan n'offre plus que les lectures ouvertes.

- **Image du worker** (`docker build -f Dockerfile.worker .`, 30/10) : construite (791 Mo compressés), utilisateur `node`,
  LibreOffice 7.4, ffmpeg 5.1, Tesseract `ara`/`eng`/`fra` ; démarrée sans base, elle attend (`TACHES_DE_FOND=web`,
  `worker.en-attente`) et sort en 0 sur SIGTERM (`tini` → `tsx` en direct : `npx` ne relayait pas le signal). Dans le
  conteneur de développement, la construction passe par le miroir `mirror.gcr.io` (limite de Docker Hub) et le CA du
  mandataire en secret de build — le `Dockerfile.worker` livré n'en dépend pas.

## Ce qui reste

- **La persona Adam** : le port est prêt (`persona: "ADAM"`), mais Adam garde son propre chemin de missions tant que
  J15 (« Adam devient une persona du noyau ») n'est pas fait ; un travail `ADAM` n'est conduit par personne aujourd'hui.
- **Coordination J0 phase B** : `src/lib/agent/travaux.ts` importe `proprietaire` et `peutUtiliserAssistantIA` par le pont
  (`platform/in-process/…`), comme `fil/service.ts` aujourd'hui ; le déménagement les repointera vers le socle.
- Les livrables vivent au carnet (Markdown, lu dans le panneau) ; leur dépôt au Drive et leur rendu fidèle relèvent de
  l'Atelier (J3, LibreOffice dans l'image du worker).
- Les sorties de lecture d'un travail sont **censurées** (comme une routine), pas mises en repères : le coffre de repères
  vit le temps d'un tour, pas d'un travail de trois semaines.
