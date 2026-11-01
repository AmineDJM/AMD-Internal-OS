# 0038 — La voix de l'Assistant IA entièrement orale (lot K9, 31/10/2026)

**Demande de la Direction (mot pour mot)** : « je peux marcher et mettre mes écouteurs et parler avec l'assistant IA …
il faut qu'il sache que je ne vois pas mon écran, donc tout se passe à l'oral. Mais il faut qu'il me simplifie tout ça,
sans qu'il soit trop long. » Puis : « Les actions qui renvoient à l'écran, non. Je peux dire un oui, vas-y, fais-le. …
pour l'attente : il devrait dire je te préviens dès que c'est prêt, puis te parler quand c'est prêt. Mais même pendant
qu'il est en train de chercher … il peut affiner : qu'est-ce que tu as derrière la tête… Les champs facultatifs : il
doit avoir la liberté de me poser quelques questions. Tableaux et graphiques dits en une phrase. Une action se conclut
à l'oral … je ne suis pas obligé de dire « je confirme » : « ok fais-le », « vas-y », « go »… Je peux lui couper la
parole, bloquer ou arrêter une mission à l'oral. L'oral peut tout faire. Il n'y a pas de mode écouteur : c'est le mode
oral-vocal qui est comme ça. »

**Elle inverse** la règle « R3/R4 confirmée à l'écran, jamais à la voix » de la décision
[0025](0025-terrain-voix.md) §4 et le dernier tiret du §2 de [0034](0034-valeurs-sensibles.md). Les **droits** ne changent
pas (0012 partie A) ; les valeurs sensibles suivent toujours le mode de la console (0034).

> Code — module `src/modules/assistant-ia/` : règles pures `domaine/terrain/oral.ts` (accord / refus FR + darja, commandes
> orales, chiffres à l'oral, résumés d'une carte et des blocs, champ suivant, valeur dite, empreinte, `CONSIGNE_ORALE`),
> consignes de la voix `domaine/terrain/voix.ts` (`CONSIGNES_ECRITURE_VOIX` inversées, `CONSIGNES_ATTENTE_VOIX`) ;
> serveur `infra/voix/oral.ts` (sessions, travail asynchrone, précision, reprise, cartes à l'oral, garde-fous, commandes) ;
> porte unique de confirmation `infra/confirmation-carte.ts` (`confirmerIntentionDe`, appelée par le bouton
> `confirmerIntentionAssistantIA` ET par le « vas-y ») ; `infra/voix/temps-reel.ts` (session enregistrée, reprises,
> `deleguerALaVoix` qui rend aussitôt) ; `infra/fil/service.ts` (tour vocal → `CONSIGNE_ORALE`). Navigateur :
> `platform/ia/voix/client-temps-reel.ts` (suivi du travail, injection du résultat, accusé du résumé, barge-in, « stop »,
> « plus court », reprises), `ecrans/voix-temps-reel.tsx`. Routes `/api/assistant-ia/voix/{session,delegation,travail,carte,journal}`.
> Migration additive `20270217130000_assistant_ia_voix_orale` (`AssistantIaVoixSession`, `AssistantIaVoixTravail`,
> `AssistantIaVoixCarte`). Bancs : `domaine/terrain/oral.test.ts` (règles), `infra/voix/oral.test.ts` (vraie base,
> scénarios oraux scriptés), `platform/ia/voix/voix.test.ts` (flux d'événements rejoué), `infra/voix/temps-reel.test.ts`.

## 1. Une seule voix — pas de « mode écouteur »

La conversation vocale EST orale : GPT-Live sait que la personne ne voit pas son écran (consignes), l'écran n'est jamais
requis. Il reste à jour (la transcription s'écrit dans la conversation, une carte confirmée à l'oral passe « exécutée »
— l'état vit sur l'intention, que la conversation relit) mais il ne sert plus qu'à garder la trace.

## 2. Des réponses rédigées pour l'oreille

Un tour délégué par la voix (préfixe `[Conversation vocale]` ou `[Conversation vocale — précision]`) reçoit
`CONSIGNE_ORALE` : la réponse d'abord en une ou deux phrases, une idée par phrase, chiffres arrondis comme on les dit,
aucune liste ni Markdown, puis une ouverture (« je te détaille ? ») ; jamais « affiché à l'écran ». L'assistant
**rédige** pour l'oral — on ne tronque plus un texte écrit. Ce que le texte ne dit pas, le **serveur** le résume :
`resumeOralBlocs` dit en une phrase chaque tableau (« un tableau de 48 lignes »), graphique (« le plus haut : Oran,
environ 1,2 million »), analyse K1 (son premier résultat), visuel K2 (prêt / en préparation), puis « le détail est dans
la conversation ». `nombreOral` arrondit (« environ 46 mille », « 1,2 million »). En mode « masquées », une valeur
sensible devient « gardée dans la conversation écrite » (plus « affichée à l'écran »).

## 3. L'attente vivante et asynchrone

| Moment | Ce qui se passe |
|---|---|
| Délégation | `/voix/delegation` dépose la demande dans le fil et rend **aussitôt** un travail (`AssistantIaVoixTravail`). La voix reçoit : « dis que tu regardes et que tu préviens dès que c'est prêt, puis pose UNE question pour affiner ». L'accusé automatique de GPT-Live est retardé de 800 ms (`acknowledgement_delay_ms`) pour laisser parler notre phrase. |
| Pendant | La voix engage la personne (période, but, périmètre). Ce qu'elle répond est délégué et part comme **précision** du travail en cours (`enCours`). |
| Précision | **Choix : ajout si le message attend, relance ciblée s'il est en cours.** Pas encore pris par le fil → la précision s'**ajoute au message** lui-même (un seul tour, rien de perdu). Déjà en cours → un message de précision est joué juste après dans le même fil : il voit la réponse en cours dans son historique et la consigne lui dit d'en repartir sans refaire les recherches ; l'ancien travail est marqué `remplacePar` et son résultat dépassé **n'est pas dit**. *Pourquoi pas l'injection dans la boucle d'outils en cours* : le moteur d'agent (Mastra) n'offre pas d'entrée entre deux étapes ; l'arrêter perdrait ce qui a été trouvé. La documentation GPT-Live recommande d'ailleurs, quand la demande change, de « mettre à jour la tâche active et d'ignorer les résultats de la demande dépassée ». |
| Résultat | Le navigateur suit le travail (`/voix/travail`, toutes les 1,5 s) ; prêt, il l'injecte par `session.commentary.append` sous l'identifiant de la **dernière** délégation du travail — la voix le dit d'elle-même, même deux minutes plus tard. Le suivi tient la conversation pour « consultée » : pas de notification en double pendant que la voix parle. |
| Session finie avant | Plus personne ne suit : la notification habituelle du fil part (cloche + téléphone). À la **prochaine ouverture**, `reprisesOrales` rend ce qui n'a pas été dit (24 h, trois au plus), injecté à `session.started` (`delegation_id: null`), puis marqué annoncé. |

Plus de « la réponse arrivera à l'écran ». La forme de l'API est celle de la documentation GPT-Live (guides
« live conversations » et « live delegation », référence des événements) : `session.commentary.append` (contexte que la
voix paraphrase, `delegation_id` nul pour toute la session), `session.thinking.append` (contexte silencieux),
`session.instructions.append` (consigne de session, qui peut interrompre la parole en cours),
`session.commentary.appended` (accusé, `client_event_id`) ; `session.delegation.created` ne porte pas le texte de la
demande — il se reconstruit des fragments de transcription d'entrée, comme avant.

## 4. Une action se conclut à l'oral

1. **Résumé en une phrase par le serveur** (`resumeOralCarte`) : titre, objet, montant, bénéficiaire — puis, pour une
   carte critique, « Je relis : 450 000 » (le `confirmText`).
2. **Les champs manquants un par un** (formulaire J11, `champSuivant`) : « Il manque l'échéance. » La valeur dite remplit
   le champ (`valeurDite` : nombre, date dite — « demain », « le 12 novembre » —, choix, oui/non) ; une **référence se
   résout par nom** sous les droits de la personne (`chercherReferenceDeCarte`) ; plusieurs candidats → « Il y en a
   plusieurs : A, B, C. Demande lequel. » ; la carte est réécrite par `corrigerCarteCapacite` (mêmes portes que l'écran).
3. **Quelques facultatifs** : la voix a la liberté d'en proposer au plus deux, utiles (date, choix, référence — jamais un
   identifiant technique), sans insister.
4. **La confirmation orale naturelle** : « ok fais-le », « vas-y », « go », « oui c'est bon », « pas de souci », « ih
   dirha », « wakha », « yallah », « ايه ديرها »… (`estAffirmatif`). « Oui mais… », « attends », une question, une
   négation, une phrase longue : **pas un accord** (la carte attend). « Non », « laisse tomber », « lala », « ماشي » :
   carte abandonnée (`CANCELLED`).
5. **Après** : « c'est fait » + « dis-moi annule si tu changes d'avis ».

**Les garde-fous sont au serveur, pas dans le modèle** (`confirmerAOral`) — la voix n'a toujours aucun outil : tout
énoncé lié à une carte est délégué, et c'est le serveur qui juge :

| Garde | Refus si |
|---|---|
| Propriété | la carte n'est pas à la personne, ou pas à **cette** session vocale (`AssistantIaVoixSession` à la personne, ouverte, < 2 h) |
| Ordre | le résumé n'a pas été **dit** : le navigateur le signale à l'accusé `session.commentary.appended` du fournisseur (`/voix/carte`), sous l'empreinte du résumé |
| Énoncé | la transcription d'entrée de la personne (ce qu'elle a dit depuis la délégation précédente) n'est pas jugée affirmative par la règle |
| Complétude | un champ obligatoire manque encore |
| Inchangée | l'empreinte de l'intention (charge, titre, valeur à ressaisir, état) diffère de celle du résumé — la carte est relue, rien n'est fait |

Puis la **même porte que le bouton** : `confirmerIntentionDe` (réclamation atomique, idempotence, journal des effets J7,
repères rejugés). La **ressaisie R3/R4** devient, à l'oral, la **relecture** de la valeur par la voix avant le « vas-y » :
le serveur fournit lui-même la valeur stockée, parce qu'elle a été dite dans le résumé accusé. La Direction ne veut pas de
mot imposé : aucun.

## 5. Tout par la voix

| Dit | Effet |
|---|---|
| « annule », « annule ce que tu viens de faire » | la dernière action de l'assistant (< 30 min) est défaite par le journal des effets J7 (`annulerGeste`), compte rendu honnête dit |
| « mets la mission en pause », « bloque la mission du congrès » | `pauserTravail` (K3) — la mission désignée par son nom, seule sans avoir à la nommer, sinon « laquelle ? » |
| « reprends la mission » | `reprendreMonTravail` |
| « arrête la mission / la sous-mission » | `annulerMissionEtSousMissions` |
| « stop », « tais-toi », « baraka » | le navigateur **coupe le son** et envoie `session.instructions.append` (interruption) ; le résultat de la délégation part en contexte silencieux |
| « plus court », « en bref », « ikhtasar » | consigne de session : une phrase par réponse |
| parler pendant que la voix parle | **barge-in côté navigateur** : au premier fragment de transcription d'entrée pendant la parole, l'élément audio est **coupé** (`muted`) — sans attendre le fournisseur — et rouvert à la réponse suivante |

## 6. Vérifié — et ce qui ne l'est pas

- **Tests** (0 réseau) : règles pures (accord / refus FR et darja, commandes, chiffres, résumés de carte / tableau /
  graphique / analyse / visuel, champ suivant, valeurs dites, dates, empreinte) ; garde-fous contre la vraie base
  (session étrangère, résumé non dit, énoncé non affirmatif, intention modifiée → rien n'est exécuté ; « ok fais-le » →
  tâche créée avec le responsable résolu par nom ; « annule » → tâche retirée ; refus → carte abandonnée) ; délégation
  asynchrone (précision ajoutée au message en attente, relance ciblée qui voit le résultat en cours, résultat dépassé
  remplacé, consigne orale reçue par le modèle, reprise à l'ouverture suivante une seule fois) ; flux d'événements rejoué
  (injection du résultat sous la dernière délégation, accusé du résumé, barge-in, « stop », « plus court », reprises).
- **Limite** : le crédit OpenAI est épuisé (`insufficient_quota`) — aucun passage réel de GPT-Live dans ce lot. Les
  scénarios oraux sont **scriptés** (transcriptions simulées). Deux points à vérifier au premier passage réel : que
  GPT-Live **dit bien** de lui-même un `session.commentary.append` arrivé longtemps après la délégation (la documentation
  dit « paraphrase », sans garantie de prise de parole), et la qualité de la transcription des accords en darja.
- **Non fait** : la reconnaissance d'une référence ambiguë « la deuxième » (la voix redemande par nom) ; la précision
  injectée DANS une boucle d'outils en cours (voir §3).

## 7. Décisions à confirmer par la Direction

1. **Cartes critiques (R4 : paiement, signature) à l'oral** : appliqué tel que demandé — la relecture du montant ou du nom
   par la voix tient lieu de ressaisie. Proposé : garder ; à fermer d'un réglage (critique = écran) si la Direction le
   préfère.
2. **« Annule »** vise la dernière action de l'assistant de moins de 30 minutes, sans redemander. Proposé : garder.
3. **Une demande nouvelle pendant un travail en cours** est traitée comme une précision (la consigne laisse l'assistant
   la traiter si c'en est une autre) ; une seule réponse est dite, la plus récente. Proposé : garder.
