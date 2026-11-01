# 0046 — L'orchestrateur de conversation : parler pendant qu'un travail tourne, à l'oral et à l'écrit (lot O1, 01/11/2026)

> **Construit sur K9** ([0039](0039-voix-orale.md)) — délégation asynchrone (`AssistantIaVoixTravail`, `/voix/travail`,
> annonce par `session.commentary.append`, précision ajoutée ou relance ciblée, `reprisesOrales`) — et sur le fil écrit
> (tours en base joués en arrière-plan, file de messages, décision 0027), la carte orale K4 ([0038](0038-voix-orale.md)) et
> les sous-missions K3 ([0033](0033-sous-missions.md)). Rien de cela n'est refait : O1 décide **quand** parler et **de quoi**.

**Constat de la Direction (mot pour mot)** : « Quand je lui pose une question qui prend du temps, il me dit "ok, je te
préviens quand je finis" et il rebondit sur une question. Sauf que ce n'est pas naturel : des fois, en même temps, l'autre
a fini, donc il me répond directement, il n'entend même pas ma question. Dès qu'il finit de me poser sa question — "tu
préfères un rendu Excel ou PDF ?" — avant même que je réponde, il me répond parce que l'autre a déjà trouvé. Et
inversement : l'autre n'a pas fini, il me pose une question, je réponds, il me dit ok et il ATTEND. Moi je veux qu'on ne
perde pas de temps : tant que l'autre n'a pas fini, on continue à avoir une discussion, et elle doit être vraiment UTILE,
pas des questions au hasard. Et ça, c'est toute une architecture, pas juste un contexte. » Puis : « pas que à l'oral,
c'est aussi le cas pour l'écrit ».

> Code — machine à états PURE, sans import, commune à l'oral et à l'écrit : `src/platform/ia/conversation/orchestrateur.ts`
> (`transition`, `decider`, `vieillir`, `affichageEcrit`). Règles de l'agenda (pures, module) :
> `src/modules/assistant-ia/domaine/conversation/agenda.ts` (`construireAgenda`, `lireReponseAgenda`, `estNouvelleDemande`,
> `voieDuMessage`, `phraseAvancement`). Persistance : `infra/orchestration/agenda.ts` (agenda d'un travail, réponse gardée
> puis transmise, partiels K3, avancement), `infra/orchestration/ecrit.ts` (`deposerEcrit`, `orchestrationDuFil`). Voix :
> `platform/ia/voix/client-temps-reel.ts` (le client GPT-Live passe par l'orchestrateur), `infra/voix/oral.ts` (agenda au
> lancement, réponse à une question, autre demande en parallèle, transmission au résultat). Fil : `infra/fil/service.ts`
> (deuxième voie de jeu). Écran : `ecrans/orchestration-fil.tsx`, `chat-message-list.tsx`, `use-fil.ts`. Migration
> additive `20270219200000_assistant_ia_agenda` (`AssistantIaAgenda`, `AssistantIaTour.parallele`,
> `AssistantIaFil.paralleleLe`).

## 1. Une machine à états explicite — quatre états de dialogue

| État | Lu sur (oral) | Lu sur (écrit) |
|---|---|---|
| **la personne parle** | un fragment `session.input_transcript.delta` depuis moins de 0,9 s ; puis sa parole **en route** (délégation partie, pas encore prise en compte) | son message en cours d'envoi |
| **l'assistant parle** | un fragment `session.output_transcript.delta` depuis moins de 0,9 s | — |
| **une question de l'assistant attend sa réponse** | la réplique de la voix finit par « ? », ou l'orchestrateur vient de faire poser un élément d'agenda, ou le serveur dit que son accusé pose une question (carte orale, « laquelle ? ») | la question de l'agenda affichée dans le fil (`POSEE`) |
| **libre** | rien de tout cela | idem |

Un **résultat** de travail qui arrive hors de « libre » entre dans la **file d'annonces** (une par travail). Il est livré au
**prochain point de rupture naturel**, de préférence COLLÉ à l'accusé de la réponse de la personne :
« Noté, PDF. Et justement, le résultat vient d'arriver : … ». Règles, toutes tenues par `decider` :

1. **La personne d'abord** : l'accusé de ce qu'elle vient de dire passe avant tout (GPT-Live attend le résultat de SA
   délégation), puis **un seul** élément s'y colle — un résultat tenu, sinon un partiel, sinon UNE précision de l'agenda,
   sinon l'étape suivante, sinon l'avancement (une fois) ; sinon « je reste disponible pour autre chose ».
2. **Jamais une annonce qui écrase une question posée** : tant qu'une question attend, rien ne se dit de soi-même. Une
   question sans réponse depuis 20 s n'est plus « en attente » (la personne a pu ne pas entendre) : l'annonce passe, et
   l'agenda se tait jusqu'à ce que la personne reparle (on ne pose pas de question dans le vide).
3. Un accusé qui **pose lui-même** une question (« tu confirmes ? ») : rien ne s'y colle.
4. **Jamais deux annonces collées** : une seule prise de parole de l'orchestrateur à la fois ; la suivante attend que la
   voix ait parlé puis se soit tue (ou 6 s, si rien n'est entendu).
5. **Jamais « ok, j'attends »** : après chaque réponse, on enchaîne. La tournure est repérée (`ATTENTE_BLOQUANTE`) et
   mesurée dans les bancs.

## 2. Une réponse qui change le travail est appliquée AVANT l'annonce

Si la réponse de la personne change le résultat (format, période, détail, destinataire), le résultat tenu devient
**caduc** — il n'est pas dit (oral) ; il est marqué « version d'avant ta précision » (écrit) — et le travail est ajusté :

- son message n'a pas encore commencé : la précision **s'ajoute** au message (un seul tour) ;
- il a fini : **relance ciblée** (le message de précision voit la réponse dans son historique, « pars de ce que tu as
  déjà trouvé, ne refais pas les recherches ») ; à l'oral l'ancien travail est `remplacePar` ;
- il tourne encore : la réponse est **gardée** et toutes les réponses données entre-temps partent **en une seule
  relance** à sa fin (`transmettreSiPret`, prise atomique) — pas une relance par réponse (coût).

Le résultat finalement dit tient compte de ce que la personne a répondu (banc : « en PDF sur le trimestre »).

## 3. Pendant l'attente, une discussion UTILE — l'agenda

L'agenda est **construit par le serveur, sans modèle**, à partir de la demande (`construireAgenda`), gardé en base
(`AssistantIaAgenda`, unique par travail et par clé : chaque question n'est posée qu'une fois) :

| Nature | Quand | Exemple |
|---|---|---|
| (a) **précision** qui change le résultat — au plus deux | un livrable sans format dit ; des données datées sans période ; une analyse sans niveau de détail | « Tu préfères un rendu Excel ou PDF ? », « Sur quelle période : ce mois-ci, le trimestre ou l'année ? » |
| (b) **résultat partiel** | une sous-mission (K3) du travail est finie — dite une fois (`DIT`) | « la sous-mission « Concurrents » est finie : … » |
| (c) **étape suivante** à décider | un livrable sans destinataire dit | « Quand ce sera prêt, je l'envoie à quelqu'un, ou c'est pour toi ? » (rien ne part sans confirmation) |
| (d) **une autre demande** | dite pendant le travail, c'est une demande (verbe d'action, question) et pas un complément (« plutôt sur 2025 ») — `estNouvelleDemande` | traitée **en parallèle** (multi-travaux), chacun avec sa file d'annonces |

Ce que la demande dit déjà n'est jamais redemandé ; une demande sans livrable (« combien de clients à Oran ? ») n'a pas
d'agenda. Un travail fini efface ses précisions restantes (jamais une question dont la réponse ne servira pas). **Agenda
vide** : la voix ne meuble pas — elle dit **une fois** où ça en est (étapes réelles faites, sous-missions, durée estimée =
médiane des 30 derniers tours outillés de la personne ; jamais un pourcentage inventé), puis reste disponible.

Le consigne K9 « pose UNE question courte pour affiner (la période, le but, le périmètre) » — source des questions « au
hasard » — est **retirée** : la voix ne pose plus de question d'elle-même au lancement.

## 4. Le tour de parole à l'oral — ce que GPT-Live offre vraiment

Vérifié dans la documentation officielle (guide « live conversations », référence `live` — primary websocket) :

- GPT-Live est **full duplex** ; il n'expose **ni** détection de parole (`input_audio_buffer.speech_started/stopped`,
  VAD serveur — ce sont des événements de l'API Realtime, pas de GPT-Live), **ni** fin de réponse (`response.done`) :
  « transcript deltas have no item ID or event that marks a completed conversational turn », et la sortie audio n'a
  « no output-audio-done event ». Les accusés (`session.commentary.appended`…) décrivent la livraison du contexte, pas la
  parole.
- Restent : les fragments `session.input_transcript.delta` / `session.output_transcript.delta` (horodatés `start_ms` /
  `end_ms` sur la ligne de temps de la session), `session.delegation.created` (la personne a fini sa demande), et trois
  injections : `session.commentary.append` (à dire, paraphrasé), `session.thinking.append` (silencieux),
  `session.instructions.append` (consigne, peut interrompre). La documentation recommande de « garder l'état des tâches
  dans l'application pour que les résultats tardifs n'écrasent pas un travail plus récent ».

Donc : le client lit les tours de parole sur les **fragments** (un silence de 0,9 s clôt une parole), sur la
**délégation** (fin de la demande), et la question sur la **ponctuation** de la réplique de sortie. L'injection se fait au
battement (300 ms) quand `decider` dit « libre », ou collée à l'accusé d'une délégation — jamais dès l'arrivée du résultat.
L'API Realtime (`components/chief/realtime-voice/`, le transport d'Adam) n'est pas touchée.

## 5. À l'écrit — la même machine

- **La conversation reste utilisable** : une autre demande déposée pendant un travail **long** (≥ 8 s) part dans la
  **voie parallèle** du fil (`AssistantIaTour.parallele`, prise `paralleleLe`) — elle n'attend pas derrière lui ; sa
  réponse ne voit que les échanges aboutis. Sinon, la file habituelle est respectée (le deuxième message attend le
  premier et voit sa réponse). Une précision (« plutôt sur 2025 ») reste dans la file habituelle.
- **La question de l'agenda dans le fil** : un travail en cours depuis 4 s ouvre son agenda ; la première question
  s'affiche sous la conversation avec ses choix (un toucher) — ou une réponse écrite. Une à la fois.
- **Le résultat tenu** : arrivé pendant que la question attend, il s'affiche « Résultat prêt — affiché après ta réponse
  à la question ci-dessous » (avec « voir maintenant ») ; après la réponse, il s'affiche, marqué « version d'avant ta
  précision » si la réponse le change, la version ajustée suit. La précision transmise se montre en une ligne discrète.
- **L'avancement** : « Où ça en est : 2 étapes faites (dernière : ventes lues), d'habitude, encore environ 1 minute. »
  sous la réponse qui s'écrit (au-delà de 8 s). La carte K3 reste la source de l'avancement des missions.

## 6. Vérifié — et ce qui ne l'est pas

- **Machine pure** (`orchestrateur.test.ts`, 11 scénarios) : résultat pendant la question / pendant la parole de la
  personne / pendant celle de la voix / juste après la réponse ; réponse qui change le format (résultat caduc, travail
  ajusté) ; agenda vide (avancement une fois, puis silence) ; question qui expire ; accusé qui pose une question ; deux
  travaux ; partiel ; doublon de résultat. **Agenda** (`agenda.test.ts`, 9).
- **Bout en bout contre la vraie base** (`infra/orchestration/orchestration.test.ts`) : le client GPT-Live réel branché
  sur le serveur réel, transport simulé d'après la documentation, faux modèle tenu par une porte — « Excel ou PDF ? »,
  résultat arrivé pendant la question → tenu, « En PDF » → noté + question suivante, résultat dépassé jamais dit,
  résultat final « en PDF sur le trimestre » ; deux travaux en parallèle, dits chacun à son tour ; à l'écrit : question
  dans le fil, autre demande en voie parallèle répondue pendant que le travail long tourne, résultat tenu, « PDF » →
  version d'avant + version ajustée. **Mesure : 0 annonce qui coupe une question en attente, 0 « j'attends » bloquant.**
- **Playwright** (`e2e/orchestration-conversation.spec.ts`, serveur réel, mode app, bureau + iPhone 13) : oral (agenda,
  résultat tenu pendant la question, accusé d'abord) et écrit (question avec choix, résultat tenu, choix touché).
- **Limites** : GPT-Live lui-même n'a pas été entendu (le média WebRTC ne passe pas le conteneur). À vérifier au premier
  passage réel : que la voix POSE bien la question quand on la lui donne en `session.commentary.append` (la documentation
  dit « paraphrase ») ; que 0,9 s de silence entre fragments est le bon seuil (réglable : `REGLAGES.silenceMs`). La
  détection d'une question repose sur le « ? » final de la transcription de sortie. La lecture « autre demande ou
  précision » est une règle de mots, pas un modèle : une phrase ambiguë part en précision (comportement K9).

## 7. Décisions à confirmer par la Direction

1. **Une autre demande pendant un travail** part désormais **en parallèle** (K9, [0039](0039-voix-orale.md) §7.3, la
   traitait comme une précision). Une phrase courte ou qui commence comme un complément reste une précision.
   Proposé : garder.
2. **Seuils** : agenda ouvert à l'écrit après 4 s de travail ; voie parallèle après 8 s ; question « expirée » après 20 s
   sans réponse à l'oral. Proposé : garder, ajuster au premier mois d'usage.
3. **Au plus deux précisions et une étape suivante** par travail (pas d'interrogatoire). Proposé : garder.
4. **Réponses gardées pendant que le travail tourne, transmises en une relance à sa fin** (au lieu d'une relance par
   réponse) : un tour de modèle de plus par travail ajusté, pas plus. Proposé : garder.
