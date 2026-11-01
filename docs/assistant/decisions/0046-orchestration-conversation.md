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

**Retour de la Direction sur la première version (01/11, mot pour mot)** : « Ça dépend. Des fois il me pose une question,
c'est une précision : là il doit vraiment la considérer comme une précision. Des fois je dis des choses qui n'ont rien à
voir : là oui, un travail en parallèle — mais ça dépend, c'est à LUI d'orchestrer tout ça. Au plus 2 précisions : bah ça
dépend en réalité. La conversation doit être fluide et utile jusqu'à ce qu'il réponde. Si le travail finit pendant qu'il
me pose une question, il attend que je réponde, et après il me donne la réponse. Et les précisions : si c'est un
changement MAJEUR, il doit les injecter dans le raisonnement de la requête ; si ce sont de petits changements, il doit
juste les considérer comme une précision, pas comme une réinjection. » — d'où §2 (classer), §3 (impact), §4 (agenda sans
plafond) ci-dessous ; la règle « résultat pendant une question → après la réponse » est confirmée.

> Code — machine à états PURE, sans import, commune à l'oral et à l'écrit : `src/platform/ia/conversation/orchestrateur.ts`
> (`transition`, `decider`, `vieillir`, `affichageEcrit`). Règles pures (module) : agenda
> `src/modules/assistant-ia/domaine/conversation/agenda.ts` (`construireAgenda`, `lireReponseAgenda`, `phraseAvancement`,
> `REGLAGES_ORCHESTRATION`) ; classement `domaine/conversation/classement.ts` (`classerSansModele`, `CONSIGNE_CLASSEMENT`,
> `lireClassement`, `classerParRepli`, `voieDuClassement`). Persistance : `infra/orchestration/agenda.ts` (agenda d'un
> travail, précisions gardées avec leur impact puis appliquées — `appliquerPrecisions` —, partiels K3, avancement),
> `infra/orchestration/classement.ts` (le classifieur rapide), `infra/orchestration/ecrit.ts` (`deposerEcrit`,
> `orchestrationDuFil`, mise en forme écrite). Voix :
> `platform/ia/voix/client-temps-reel.ts` (le client GPT-Live passe par l'orchestrateur), `infra/voix/oral.ts` (agenda au
> lancement, réponse à une question, autre demande en parallèle, transmission au résultat). Fil : `infra/fil/service.ts`
> (deuxième voie de jeu). Écran : `ecrans/orchestration-fil.tsx`, `chat-message-list.tsx`, `use-fil.ts`. Migration
> additives `20270219200000_assistant_ia_agenda` (`AssistantIaAgenda`, `AssistantIaTour.parallele`,
> `AssistantIaFil.paralleleLe`) et `20270219200100_assistant_ia_agenda_impact` (`impact`, `forme`, `appliqueLe`, `rang`).

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

## 2. Classer chaque énoncé dit pendant un travail — c'est à l'assistant d'orchestrer

Pendant un travail (une question de l'agenda posée, ou un travail suivi), chaque énoncé est **classé** en trois natures :

| Nature | Ce qui se passe |
|---|---|
| **précision** du travail en cours (réponse à la question posée, ou précision libre) | gardée avec son **impact** (§3), puis appliquée |
| **autre demande**, indépendante | un **travail en parallèle** (oral : toujours ; écrit : voie parallèle si le travail est long) |
| **conversation** (« merci », « c'est long ? ») | on répond naturellement, **rien n'est lancé** (la voix a l'avancement réel sous la main) |

**Déterministe quand c'est évident** (`classerSansModele`, aucun appel) : un choix proposé par la question posée, un
format dit pour la question du format, « peu importe », une consigne de forme (« plus court », « en Excel »,
« envoie-le à Amel »), une politesse. **Sinon un classifieur bon marché** (`classerEnonce`) : rôle `rapide`, entrée
courte (la demande en cours, la question posée, l'énoncé — bornés), sortie **JSON strict** (`nature`, `impact`, `forme`,
`consigne`), 8 s au plus, imputé à la personne et journalisé (K8, `auNomDe` : coût mesuré comme tout appel). Une phrase
ambiguë **va au classifieur** — plus de « précision par défaut ». Seulement s'il ne répond pas (panne, IA coupée, sortie
illisible), un **repli** de mots décide, dit comme tel (`source: "repli"`, journal `warn`).

## 3. L'impact d'une précision : MAJEURE réinjectée, MINEURE appliquée au rendu

| Impact | Exemples | Ce qui se passe |
|---|---|---|
| **MAJEUR** — change le périmètre, la période, les données, le raisonnement | période, ventilation, comparaison, points de vigilance, « seulement les grossistes » | **réinjecté dans le raisonnement** : ajouté au message s'il attend encore ; s'il tourne, gardé et parti **en UNE relance ciblée à sa fin** (toutes les majeures données entre-temps, plus les mineures en attente) ; s'il a fini, relance tout de suite. Le résultat tenu devient **caduc** (non dit à l'oral ; « version d'avant ta précision » à l'écrit). |
| **MINEUR** — change seulement la forme | format de fichier, ton, longueur, présentation, langue, destinataire | **aucune relance, aucune réinjection**. Message en attente : ajouté (gratuit). Sinon, appliqué **au rendu** : TEXTE (ton, longueur, présentation) → la voix dit le résultat ainsi (consigne portée sur l'annonce, zéro appel) ; l'écrit le remet en forme par le modèle rapide, sans outil ni valeur révélée, sous l'original. FICHIER / ENVOI → un tour de **mise en forme** d'après le résultat prêt (« reprends ta réponse telle quelle, ne refais aucune recherche »), dans la voie parallèle — un fichier, ou une carte d'envoi à confirmer. Le résultat tenu **n'est pas caduc** : il est dit juste après la réponse, mis en forme comme demandé. |

L'impact d'une question de l'agenda est fixé par l'agenda (format, détail, destinataire : mineur ; période, ventilation,
comparaison, vigilance : majeur) ; celui d'une précision libre par le classement. Les relances s'enchaînent sur la racine
du travail (`precisionTourId`) : le travail courant est la dernière relance ; appliquer est idempotent (prise atomique).
Le résultat finalement dit tient compte des deux (banc : « en PDF sur le trimestre », ou « plus court » sans relance).

## 3 bis. Pendant l'attente, une discussion UTILE et fluide — l'agenda sans plafond

L'agenda est **construit par le serveur, sans modèle**, à partir de la demande (`construireAgenda`), gardé en base
(`AssistantIaAgenda`, unique par travail et par clé, rangé) — **sans plafond fixe** : tout ce qui a une vraie valeur pour
CE genre de demande, **une chose à la fois**, tant que le travail tourne (après chaque réponse, l'élément suivant).

| Nature | Quand | Exemple |
|---|---|---|
| (a) **précision** qui change le résultat | un livrable sans format dit ; des données datées sans période ; une analyse sans niveau de détail | « Tu préfères un rendu Excel ou PDF ? », « Sur quelle période ? » |
| (a') **approfondissement** probable | données datées sans ventilation / sans comparaison ; une analyse sans points de vigilance | « Je le détaille par produit, par wilaya, ou le total suffit ? », « … la comparaison avec l'an dernier ? », « Je signale aussi les points de vigilance ? » |
| (b) **résultat partiel** | une sous-mission (K3) du travail est finie — dite une fois (`DIT`) | « la sous-mission « Concurrents » est finie : … » |
| (c) **étape suivante** à décider | un livrable sans destinataire dit | « Quand ce sera prêt, je l'envoie à quelqu'un, ou c'est pour toi ? » (rien ne part sans confirmation) |

Ce que la demande dit déjà n'est jamais redemandé ; une demande sans livrable (« combien de clients à Oran ? ») n'a pas
d'agenda ; un travail fini efface ses précisions restantes (jamais une question dont la réponse ne servira pas).
**Rien d'utile** : la voix ne meuble pas — elle dit **une fois** où ça en est (étapes réelles, sous-missions, durée
estimée = médiane des 30 derniers tours outillés ; jamais un pourcentage inventé), puis reste disponible.

La consigne K9 « pose UNE question courte pour affiner (la période, le but, le périmètre) » — source des questions « au
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

- **Chaque message est classé** (§2) : une précision n'est pas un nouveau tour — elle est gardée (le message reste
  visible, tel qu'écrit) et appliquée selon son impact (§3) ; une autre demande ou une conversation pendant un travail
  **long** part dans la **voie parallèle** du fil (`AssistantIaTour.parallele`, prise `paralleleLe`) — elle n'attend
  pas ; sa réponse ne voit que les échanges aboutis. Sinon, la file habituelle (le deuxième message attend le premier).
- **Les éléments de l'agenda dans le fil** : un travail en cours depuis le seuil ouvre son agenda ; l'élément s'affiche
  sous la conversation avec ses choix (un toucher) — ou une réponse écrite ; puis le suivant. Une précision transmise ou
  une mise en forme demandée se montre en une ligne discrète.
- **Le résultat tenu** : arrivé pendant que la question attend, il s'affiche « Résultat prêt — affiché après ta réponse
  à la question ci-dessous » (avec « voir maintenant ») ; après la réponse, il s'affiche, marqué « version d'avant ta
  précision » si la réponse le change, la version ajustée suit. La précision transmise se montre en une ligne discrète.
- **L'avancement** : « Où ça en est : 2 étapes faites (dernière : ventes lues), d'habitude, encore environ 1 minute. »
  sous la réponse qui s'écrit (au-delà de 8 s). La carte K3 reste la source de l'avancement des missions.

## 6. Vérifié — et ce qui ne l'est pas

- **Machine pure** (`orchestrateur.test.ts`, 13 scénarios) : résultat pendant la question / pendant la parole de la
  personne / pendant celle de la voix / juste après la réponse ; réponse majeure (résultat caduc, travail ajusté) ;
  réponse MINEURE (résultat tenu non caduc, dit mis en forme) ; agenda vide ; question qui expire ; accusé-question ; deux
  travaux ; partiel ; doublon ; travail né d'une mise en forme. **Agenda et classement** (`agenda.test.ts`, 11).
- **Bout en bout contre la vraie base** (`infra/orchestration/orchestration.test.ts`, 5) : client GPT-Live réel branché sur
  le serveur réel, transport simulé d'après la documentation, faux modèle tenu par une porte (il sert aussi le
  classifieur et la mise en forme). Oral : un long travail où la conversation enchaîne **cinq** éléments utiles,
  « En PDF » (mineure, gardée), « le trimestre » (majeure, réinjectée en UNE relance à la fin, avec la mineure), le
  résultat tenu pendant la question, l'ancien jamais dit, le final « en PDF sur le trimestre » ; « fais-le plus court »
  sans relance (dit mis en forme, aucun tour de plus), « c'est long là, non ? » tranché par le classifieur (conversation,
  rien lancé, appel journalisé) ; une autre demande reconnue par le classifieur, en parallèle, chaque résultat à son
  tour. Écrit : agenda renouvelé dans le fil, autre demande en voie parallèle, mineure + majeure en une relance
  (« version d'avant »), « plus court » sur un résultat tenu → remis en forme par le modèle rapide, sans relance.
  **Mesure : 0 annonce qui coupe une question en attente, 0 « j'attends » bloquant.**
- **Bancs K9 mis à jour** (`infra/voix/oral.test.ts`) : la précision majeure dite pendant le travail est gardée puis
  réinjectée à sa fin (une relance qui la porte et voit le résultat en historique).
- **Playwright** (`e2e/orchestration-conversation.spec.ts`, serveur réel, mode app, bureau + iPhone 13).
- **Limites** : GPT-Live lui-même n'a pas été entendu (le média WebRTC ne passe pas le conteneur) ; le classifieur n'a
  tourné qu'au faux modèle (aucun passage réel facturé) — sa justesse sur des phrases réelles est à mesurer au premier
  mois (journal `[assistant-ia] classement`, source et nature). La détection d'une question repose sur le « ? » final
  de la transcription de sortie. La mise en forme ÉCRITE d'un texte passe le résultat sans valeur révélée (repères ou
  « [confidentiel] » conservés) : en mode « en clair », la version reformulée peut montrer moins que l'originale.

## 7. Réglages et décisions

- **Tranché par la Direction (01/11)** : l'assistant orchestre (classement, §2) ; pas de plafond de précisions (§3 bis) ;
  majeure réinjectée / mineure appliquée au rendu (§3) ; un résultat arrivé pendant une question attend la réponse, puis
  est donné juste après (§1).
- **Seuils = réglages, pas plafonds** (`REGLAGES_ORCHESTRATION`, relus de l'environnement par le serveur) : agenda écrit
  après `ASSISTANT_O1_AGENDA_ECRIT_MS` (4 s), voie parallèle après `ASSISTANT_O1_TRAVAIL_LONG_MS` (8 s), question orale
  expirée après 20 s (`ASSISTANT_O1_QUESTION_EXPIRE_MS` ; côté navigateur, `REGLAGES.questionExpireMs`).
- **À confirmer** : les mineures de FICHIER produisent un tour de mise en forme (un appel de l'assistant, sans
  recherche) ; celles de TEXTE, un appel du modèle rapide à l'écrit, zéro à l'oral. Proposé : garder.
