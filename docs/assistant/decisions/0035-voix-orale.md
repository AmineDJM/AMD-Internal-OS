# 0035 — À l'oral, la voix dit tout, et une carte devient une conversation qui se confirme à l'oral (lot K4, 31/10/2026)

**Décision de la Direction (31/10/2026, résumée par le pilote du lot)** : « En appel vocal avec l'assistant (GPT Live 1),
l'expérience doit être ORALE, pas écrite. Si je demande un salaire, il me DIT le salaire, pas "c'est affiché à l'écran" :
si j'utilise la voix, c'est que je ne vois pas l'écran. Pour une action, par exemple créer une demande de sponsoring, il me
RÉSUME la demande de façon fluide, pas comme un robot. Il me propose les cases non obligatoires […] Puis : "Tu
confirmes ?". Je peux confirmer à l'oral. L'expérience doit être totalement différente entre l'oral et l'écrit. »

Elle **remplace** la règle 2 de la décision [0025](0025-terrain-voix.md) (« une écriture ne se confirme jamais à la voix »)
et complète la décision [0034](0034-valeurs-sensibles.md) (valeurs sensibles en clair).

> Code : règles pures `src/modules/assistant-ia/domaine/terrain/voix-orale.ts` (`etapeOrale`, `recitDeCarte`, `texteOral`,
> `estOuiExplicite`, `estNonExplicite`, `estRienAAjouter`, `nombresDits`, `elementCleDit`) ; état et confirmation orale
> `infra/voix/carte-orale.ts` ; délégation `infra/voix/temps-reel.ts` (`deleguerALaVoix(user, demande, conversation, parole)`) ;
> garde commune au bouton et à l'oral `infra/confirmation.ts` (`confirmerCarte`, appelée par `confirmerIntentionAssistantIA`) ;
> correction dite `infra/capacites.ts` (`outilCorrigerCarte` → `corrigerCarteCapacite`, `facultatifsDeCapacite`),
> `infra/operations/index.ts` (`facultatifsDOperation`) ; consignes `domaine/terrain/voix.ts` (`consignesVoix`) ; client
> `platform/ia/voix/client-temps-reel.ts` (`parole`), route `app/api/assistant-ia/voix/delegation`, écran
> `ecrans/voix-temps-reel.tsx`. Banc : `infra/voix/voix-orale.test.ts`.

## 1. Les valeurs sensibles à l'oral
En mode « en clair » (réglage de la décision 0034, défaut), la voix **prononce** le salaire ou le montant que la personne a
le droit de voir — jamais « affiché à l'écran ». En mode « masquées », le comportement de 0012/0025 reste.

## 2. Une carte devient une conversation
Quand la délégation rend une carte (capacité R1–R4 avec son formulaire J11, ou opération de l'assistant comme
`preparer_sponsoring`), elle devient une **carte orale** (journal de l'intention : `VOIX`/`CARTE`, ses champs). La voix ne
reçoit jamais les champs bruts : une **matière** (récit sans identifiant technique) et une **manière** (« dis-le avec tes
mots, une ou deux phrases, pas une liste »), une étape à la fois :

1. **Manquants** — un obligatoire vide : une question (une carte préparée n'en a normalement aucun ; l'outil `preparer_*`
   demande déjà le premier manquant, une question à la fois, avant toute carte) ;
2. **Facultatifs** — les cases non obligatoires encore vides (le contrat de la capacité ; les arguments vides de
   l'opération), proposées en une question légère ; « non, c'est tout » passe au récit sans appel de modèle ;
3. **Question** — la demande récitée, puis « Tu confirmes ? » (pour une carte renforcée : « confirme en prononçant … »).

Une **précision ou correction dite** part à l'assistant, qui la porte à la carte par `corriger_carte` — **la même porte que
la correction écrite** (`corrigerCarteCapacite` : champs du contrat, schéma zod du registre, noms résolus sous la portée de
la personne, familles de la console ; ressaisie recalculée). Une carte d'opération se repropose en entier par son outil
`preparer_*` : la nouvelle carte remplace l'ancienne (retirée comme caduque) et hérite des facultatifs déjà proposés. Toute
correction après la question l'annule : il faut récapituler de nouveau. Pendant la conversation orale, la carte n'est pas
retirée comme « caduque » (IA-10) : la personne en parle parce qu'elle la complète.

## 3. La confirmation orale — jugée par le serveur
La voix (GPT-Live) n'a **aucun outil** : la confirmation ne passe pas par un outil qu'elle appellerait, mais par la
délégation, jugée côté serveur **avant tout appel de modèle**. Elle n'est entendue que si :

- la carte est la dernière carte orale de **cette** personne, encore à signer, de moins de 30 minutes ;
- la question de confirmation a été **posée après la dernière correction** (journal de l'intention) ;
- les **mots de la personne** — sa transcription (`session.input_transcript`), envoyée par le client comme `parole`, jamais
  la reformulation du modèle vocal — disent un **« oui » explicite et sans réserve** (« oui mais change la date » n'en est
  pas un) ; une délégation sans parole neuve (demande répétée) ne confirme rien ;
- pour une carte **renforcée** (R3/R4, `CRITICAL`), la personne **prononce l'élément clé** (le montant, en chiffres ou en
  lettres ; le verbe), comparé comme la ressaisie écrite.

Puis **la même garde que le bouton** : `confirmerCarte` → `executerIntention` (ressaisie vérifiée par le serveur,
réclamation atomique, idempotence) → exécuteur de l'Assistant IA (arrêt d'urgence, porte, famille de la console relus ;
journal des effets). Au journal : l'audit « Carte … confirmée à l'oral · transcription : … », et l'événement
`VOIX`/`CONFIRMEE` (ou `ECHEC`) avec la transcription sur l'intention. Un « non » net (« non, annule ») laisse la carte à
l'écran, confirmable au bouton, et la voix n'en reparle plus. **La carte reste confirmable au bouton** (idempotent : un
second geste rend le même reçu).

**Limite assumée** : la transcription peut arriver après la délégation (le client attend 1,5 s au plus) ; si elle manque,
le serveur n'entend pas de « oui » et la voix redemande — jamais l'inverse.

## 4. Le ton
Les consignes de la voix : la personne ne regarde pas l'écran ; ton naturel et chaleureux, phrases courtes et variées, une
idée à la fois ; jamais une liste de champs ; jamais « affiché à l'écran » pour éviter de répondre ; toute réponse de la
personne se délègue telle quelle ; jamais « c'est fait » avant que le serveur l'ait dit.

## 5. Preuves
- `infra/voix/voix-orale.test.ts` (8 cas, vraie base, faux modèle) : règles des mots (oui / non / rien à ajouter, nombres
  dits en lettres, élément clé), texte de chaque étape ; parcours entier jusqu'à l'exécution et l'audit avec transcription ;
  sans « oui », « oui » répété ou « oui » avant la question : rien ; carte renforcée sans l'élément clé (ou avec un autre
  montant) : refusée, avec : exécutée ; « non » : rien, carte au bouton ; correction dite hors contrat refusée, valide
  réécrite (`CORRECTED`) ; le bouton après l'oral : idempotent.
- **Passage réel : à refaire après recharge du compte OpenAI** (crédit épuisé constaté le 31/10/2026 à 19 h 15 UTC,
  `insufficient_quota`).
