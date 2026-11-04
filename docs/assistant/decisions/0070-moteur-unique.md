# 0070 — Un seul moteur : toutes les entrées passent par `jouerTour` (lot I6)

**Date** : 2026-11-04 · **Statut** : appliquée · **Touche** : entrées de l'ancien Adam (`app/api/assistant/*`,
`lib/actions/assistant-actions.ts`, `lib/actions/adventum-actions.ts`, `app/(app)/adam/bureau`, `app/(app)/layout.tsx`),
mémoire de l'ancien moteur (`lib/assistant-memory.ts`, `lib/memoire-echange.ts`), module `assistant-ia` (`infra/entrees.ts`,
`domaine/cle-cache.ts`, routines, travaux). Prolonge 0055, 0056, 0063–0068 ; exécute l'étape 4 du plan AU3.

## Ce que la Direction a demandé (04/11)

> « Je veux vraiment que ce soit la même architecture, le même truc. C'est juste les accès qui changent… Le super admin a
> accès à WhatsApp, à Gmail… les autres ont moins d'accès. » — « Tout est une histoire d'architecture, pas de prompting. »
> — Pour ce lot : « ne supprime pas du code évidemment ! juste masque au pire ou en comment. »

## Le constat de départ (AU3 §1.1)

Le Super Admin avait deux Adam. Cinq entrées faisaient encore tourner l'ancienne boucle (`lib/assistant/boucle/*`,
`runAssistant` / `runAssistantStream`) : le Bureau d'Adam (`/api/assistant/stream` et l'action `assistantChat`), l'appel vocal
global (`CallProvider` → `/api/assistant/voice/tool`), la dictée (`/api/assistant/transcribe`), « Demander » d'Adventum Brain
(`askBrain`) et la relance (`assistantNudge`). Ni S1, ni K10, ni la garde de vérité, ni la mémoire du moteur IA.

## La décision

**Une boucle, un catalogue, des accès.** Toute entrée joue son tour par `jouerTour` — donc par le catalogue unique
(`outilsV1`) filtré par le `ProfilDAcces` (0064), la même sélection, les mêmes invariants et la même fin de tour (où le
contrôle final du lot I5 se pose : les entrées en héritent sans rien réécrire).

| Entrée | Avant | Maintenant |
|---|---|---|
| Conversation écrite `/assistant`, app `/ia` | `jouerTour` | inchangé |
| Voix et message vocal d'Adventum IA | `jouerTour` (délégation → fil) | inchangé |
| « Demander » d'Adventum Brain (`askBrain`) | `runAssistant` | **rebranché** : `jouerTourDEntree(user, "brain")` ; extraits et risques voyagent dans le message ; cartes = intentions confirmées par `confirmerIntentionAssistantIA` (écran `demander.tsx`) |
| Relance (nudge) | `assistantNudge` → `runAssistant` | **rebranchée** : `relanceMoteurUnique` (`modules/assistant-ia/actions.ts`) → `relanceDuMoteur` → `jouerTourDEntree(user, "relance")` ; mêmes règles de coût (signature des non-lus, interrupteur « nudge ») ; `assistantNudge` masqué sans le drapeau |
| Bureau d'Adam — page `/adam/bureau` | chat de l'ancien moteur | **historique gelé, en lecture** ; `?q=` / `?call=` → `/assistant` (le tour du moteur unique) |
| Bureau d'Adam — flux (`/api/assistant/stream`) et chat (`assistantChat`) | `runAssistantStream` / `runAssistant` | **masqués** : ils rendent « un seul moteur » et l'adresse de la conversation (0 appel de modèle) |
| Appel vocal global (`CallProvider`) | `voice/session` + `voice/tool` → `runAssistant` | **masqué** (`enabled` exige le drapeau) ; la voix passe par la conversation vocale d'Adventum IA (`jouerTour`) |
| Routes de l'ancienne voix (`voice/session`, `tool`, `turn`, `log`) | ancien moteur | **masquées** : 410 « un seul moteur », renvoi vers `/assistant` |
| Dictée (`/api/assistant/transcribe`) | Whisper → chat de l'ancien moteur | **masquée** (410) ; le message vocal d'Adventum IA la remplace |
| Routines, missions (travaux) | `outilsV1({ seulementLectures })` (0067) | inchangé ; même clé de cache |

**Pourquoi le Bureau est masqué plutôt que rebranché dans ses fichiers.** `assistant-actions.ts` et `app/api/assistant/*` sont
du périmètre d'Adam, et la frontière 0013 tient « Adam → Assistant IA = 0 » (`platform/ia/frontieres.test.ts`) — un cliquet
qu'on ne relève pas. Un fichier d'Adam ne peut donc pas appeler `jouerTour` ; il dit où est le moteur unique. Le Bureau et
l'appel mènent à la conversation d'Adventum IA, qui EST le tour du moteur unique. Brain (`lib/actions/adventum-actions.ts`)
est hors du périmètre d'Adam : il appelle le moteur par la porte du module. La relance a déménagé dans le module ; les non-lus
qu'elle lisait par Adam (`getUnreadDigest`, intact) sont relus dans le module (`entrees.ts nonLusDe`) — le socle IA ne lit pas
la base (cliquet `platform/boundary.test.ts`), et le module n'importe pas Adam.

`infra/entrees.ts` n'ajoute **aucune consigne** propre à une entrée : le contexte de l'entrée voyage dans le message (partie
variable), pour que le préfixe stable — donc le cache — soit commun à toutes.

**Ce qui n'existait que dans l'ancien moteur et qui sert** est déjà disponible dans le moteur unique **par l'accès** :
les outils du Super Admin et son Gmail (porte 0055, canal `gmailAdam` du profil 0064), sa mémoire (`AssistantMemoryItem`,
commune ; `episodic_recall` gardé, 0064). WhatsApp : le profil porte la ligne `canaux.whatsapp` (Super Admin) ; l'ancien moteur
n'avait **aucun** outil d'envoi WhatsApp (vérifié : aucun outil `*whatsapp*` dans `lib/assistant`), donc rien à rapatrier — la
réception de pièces par WhatsApp (0036) est déjà un outil du moteur unique.

## Masqué, pas supprimé — et comment le réactiver

`ADAM_ANCIEN_MOTEUR=1` (`src/lib/assistant/ancien-moteur.ts`, seule la valeur exacte « 1 ») remet **tout** tel quel :
l'ancienne boucle dans chaque entrée (branches gardées intactes derrière `ancienneBoucle()`), les routes de voix et de dictée,
l'appel global, le chat du Bureau, l'écriture d'`AssistantThread`. Aucune ligne de l'ancien moteur n'est supprimée ; les
imports remplacés sont gardés en commentaire avec la décision. Les outils déjà masqués par I3/I4 (`exporter_donnees`,
`modifier_document`, `convertir_document`) restent masqués.

**`AssistantThread` gelé en lecture** : sans le drapeau, `createThread` / `ensurePrimaryThread` (création) refusent,
`appendExchange` n'écrit rien, `rememberExchange` rend le fil tel quel. La lecture reste ouverte (historique du Bureau,
rappel épisodique) ; l'effacement à la main de la personne aussi (droit à l'oubli : geler n'est pas confisquer).

## Une seule clé de cache par personne

`domaine/cle-cache.ts cleCacheDeLaPersonne(userId)` = `assistant-ia:<id>` : le tour (donc toutes les entrées rebranchées et la
voix), les routines (`routines/passage.ts`) et les missions (`travaux.ts raisonner` → `genererTexte({ cleCache })`). Aucune autre
clé écrite à la main dans le module (vérifié par le test). Le Mission Runtime de l'ancien Adam (`platform/in-process/missions`,
clé `mission:<but>`) n'est joint que par les anciens écrans : hors de ce lot.

## Preuves

- **Test d'architecture** `src/platform/moteur-unique.test.ts` (18, côté Adam) et `src/modules/assistant-ia/i6-moteur-unique.test.ts`
  (7, côté moteur ; ce module n'importe pas Adam) : aucun import statique de `runAssistant` /
  `runAssistantStream` hors de `src/lib/assistant/` (porte et tests exceptés), aucun import statique ni dynamique de
  `lib/assistant/boucle/*` ; tout appelant restant passe par `ancienneBoucle()` ; le drapeau (défaut fermé, « 1 » seul) ; chaque
  entrée passe par lui ; les cinq routes masquées appelées pour de vrai → 410 avant toute session ; fils gelés en base (et
  réécrits sous le drapeau) ; une entrée rebranchée joue le **même** tour que l'écrit (même consigne système) ; un employé, par
  une entrée rebranchée, ne reçoit aucun outil d'Adam ; la Vue exacte reste fermée pour chaque entrée ; une seule clé de cache.
- Les tests de l'ancien moteur (`assistant-memory`, `memory-tools`, `reprise-conversation`, `voice-realtime`,
  `in-process/missions/memory`) se jouent **sous son drapeau** (posé et rendu par fichier) : ils prouvent qu'il revient intact.
- **Rejeu réel** (`npm run banc:i6`, `scripts/bench/i6-entrees/jouer.ts`) et **banc S1** : voir « Mesures » ci-dessous.

## Mesures (vrai modèle, gpt-6.1-terra, base `amd_bench` locale, `ADAM_SORTIE_INTERDITE=1`)

**Rejeu des entrées** (`npm run banc:i6` ; fichiers `docs/assistant/preuves/i6/rejeu-*.json`). Chaque entrée par son vrai point
d'entrée, sous la session du Super Admin du semis. Jetons et cache relus dans `ModelCallLog` (les deux moteurs y écrivent) ;
coût au tarif du banc (2 $ / 12 $ / 0,20 $ le million).

| | Tours | Appels | Entrée par appel | En cache | Coût par tour | Durée moyenne |
|---|---:|---:|---:|---:|---:|---:|
| **Avant** — ancien moteur (Bureau flux, Bureau chat, Brain, relance) | 4 | 13 | 12 083 | 62,7 % | 0,0358 $ | 5,9 s |
| **Après** — moteur unique (écrit, Brain, relance, voix ; 2 passages) | 8 | 31 | **7 875** (−35 %) | **66,1 %** | **0,0274 $** (−23 %) | 9,7 s |
| Après, 2ᵉ passage (cache chaud d'une entrée à l'autre) | 4 | 17 | 7 911 | **72,0 %** | 0,0263 $ | 10,2 s |

- **Brain** : 0 % de cache avant (aucune clé, sa propre consigne) → 79 % après (la clé et le préfixe de la personne). **Relance** :
  14 168 → 8 839 jetons par appel, cache inchangé (34–35 % : elle porte les non-lus dans le message, partie variable).
- AU3 mesurait 8,3–8,6 k jetons par appel, 48 % en cache, dans la conversation : **7,9 k et 66–72 %** désormais.
- **Ce qui est moins bien, dit** : un tour du moteur unique est plus long (9,7 s contre 5,9 s) et fait plus d'appels (3,9 contre
  3,3) — ses gardes et ses outils (Brain lit le catalogue avant de répondre : 4–6 appels contre 2). Le coût baisse quand même,
  parce que l'entrée par appel baisse et que le cache monte.
- Le Bureau (flux, chat) après : 0 appel — il rend « un seul moteur » et l'adresse de `/assistant` (vérifié au rejeu).
- Réponses : identiques sur le fond (missions en attente du worker, paie de novembre absente, aucun contrat Pharmagène,
  aucun produit infectieux, rappel proposé en carte pour la relance), désormais avec l'adresse (« Amine ») et les liens du moteur.

**Banc S1 — frontière Super Admin / employé** (`AUDIT_SEULEMENT=ML-ADAM,ADAM-SA npm run audit:assistant`, rapport
`docs/assistant/preuves/i6/s1-frontiere-sa-RAPPORT.md`) : **19 attaques, 19 bloquées, 0 lue en base, 0 passée** (ML-ADAM-01 à 06,
ADAM-SA-01 à 13 — écrit, voix, Vue exacte). Le rapport complet de référence (`preuves/audit/`) n'est pas remplacé par ce passage
partiel.

**Dépense totale du lot au vrai modèle : 1,62 $** (rejeu 0,53 + 0,22 $, attaques 0,87 $) sur un plafond de 2,5 $.
