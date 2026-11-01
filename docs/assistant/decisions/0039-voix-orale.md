# 0039 — La voix de l'Assistant IA entièrement orale (lot K9, 31/10/2026)

> **Construit sur K4** ([0038](0038-voix-orale.md)) : la carte orale de K4 — manquants →
> facultatifs → récit → « tu confirmes ? », oui jugé par le serveur sur la transcription, garde du bouton
> (`infra/voix/carte-orale.ts`, `infra/confirmation.ts:confirmerCarte`) — est reprise TELLE QUELLE, avec deux écarts
> demandés par la Direction (§4). K9 ajoute l'attente vivante asynchrone, la rédaction pour l'oreille et « tout par la voix ».

**Demande de la Direction (mot pour mot)** : « je peux marcher et mettre mes écouteurs et parler avec l'assistant IA …
il faut qu'il sache que je ne vois pas mon écran, donc tout se passe à l'oral. Mais il faut qu'il me simplifie tout ça,
sans qu'il soit trop long. » Puis : « Les actions qui renvoient à l'écran, non. Je peux dire un oui, vas-y, fais-le. …
pour l'attente : il devrait dire je te préviens dès que c'est prêt, puis te parler quand c'est prêt. Mais même pendant
qu'il est en train de chercher … il peut affiner : qu'est-ce que tu as derrière la tête… Les champs facultatifs : il
doit avoir la liberté de me poser quelques questions. Tableaux et graphiques dits en une phrase. Une action se conclut
à l'oral … je ne suis pas obligé de dire « je confirme » : « ok fais-le », « vas-y », « go »… Je peux lui couper la
parole, bloquer ou arrêter une mission à l'oral. L'oral peut tout faire. Il n'y a pas de mode écouteur : c'est le mode
oral-vocal qui est comme ça. »

Elle prolonge K4, qui a déjà inversé la règle « R3/R4 confirmée à l'écran, jamais à la voix » de la décision
[0025](0025-terrain-voix.md) §4. Les **droits** ne changent pas (0012 partie A) ; les valeurs sensibles suivent toujours
le mode de la console (0034).

> Code — module `src/modules/assistant-ia/` : règles pures `domaine/terrain/oral.ts` (commandes orales, chiffres à l'oral,
> blocs dits en une phrase, mission désignée par son nom, `CONSIGNE_ORALE`) ; `domaine/terrain/voix-orale.ts` (K4, étendu :
> accord et refus en darja, lettres arabes gardées ; la voix RELIT l'élément clé) ; consignes `domaine/terrain/voix.ts`
> (`CONSIGNES_ATTENTE_VOIX`) ; serveur `infra/voix/oral.ts` (sessions vocales, travail asynchrone, précision, reprise,
> aiguillage d'un énoncé : commande → carte orale K4 → précision → nouveau travail) ; `infra/voix/carte-orale.ts` (K4 :
> plus d'élément clé à prononcer) ; `infra/voix/temps-reel.ts` (session enregistrée, reprises, `deleguerALaVoix` qui rend
> aussitôt) ; `infra/fil/service.ts` (tour vocal → `CONSIGNE_ORALE`) ; `infra/travaux.ts` (porte des missions : pause,
> reprise). Navigateur : `platform/ia/voix/client-temps-reel.ts` (suivi du travail, injection du résultat, « oui » tardif,
> barge-in, « stop », « plus court », reprises), `ecrans/voix-temps-reel.tsx`. Routes
> `/api/assistant-ia/voix/{session,delegation,travail,journal}`. Migration additive `20270217130000_assistant_ia_voix_orale`
> (`AssistantIaVoixSession`, `AssistantIaVoixTravail`). Bancs : `domaine/terrain/oral.test.ts`, `infra/voix/oral.test.ts`
> (vraie base, scénarios oraux scriptés), `infra/voix/voix-orale.test.ts` (K4, suivi asynchrone), `platform/ia/voix/voix.test.ts`
> (flux d'événements rejoué), `e2e/voix-orale.spec.ts` (serveur réel, mode app, bureau + iPhone 13).

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
`session.instructions.append` (consigne de session, qui peut interrompre la parole en cours) ;
`session.delegation.created` ne porte pas le texte de la
demande — il se reconstruit des fragments de transcription d'entrée, comme avant.

## 4. Une action se conclut à l'oral — la carte orale de K4, et deux écarts

Le déroulé est celui de K4 : la carte arrive **avec le résultat du travail** (K9 la branche sur le suivi asynchrone), la
voix la résume avec ses mots, pose UNE question pour un champ obligatoire manquant, propose les facultatifs en une
question légère, récapitule et demande « Tu confirmes ? ». Une correction dite passe par `corriger_carte` (porte du
formulaire J11). Le oui est jugé par le **serveur** sur la transcription de la personne, puis la **garde du bouton**
(`confirmerCarte` : réclamation atomique, idempotence, journal des effets J7) ; la confirmation orale va à l'audit avec la
transcription. Garde-fous serveur conservés : la carte est la dernière carte orale de **cette personne**, encore à signer,
de moins de 30 minutes ; la question a été posée **après** la dernière correction ; la parole est la sienne (`parole`, ses
mots neufs, jamais la reformulation du modèle vocal). K9 ajoute : le travail et ses gestes ne valent que dans **sa session
vocale** ouverte (`AssistantIaVoixSession`, < 2 h).

| Écart (Direction) | K4 | K9 |
|---|---|---|
| **Pas de mot imposé** (R3/R4) | la personne devait PRONONCER l'élément clé (« oui, je confirme 150 000 ») | la **voix relit** l'élément clé dans le récit (« je relis : 150 000 ») ; ensuite tout oui sans réserve suffit — « ok fais-le », « vas-y », « go », « oui c'est bon », « pas de souci », « ih dirha », « wakha », « yallah », « ايه ديرها ». Le serveur fournit lui-même la ressaisie stockée. |
| **Le « oui » tardif** | une transcription arrivée > 1,5 s après la délégation n'était pas entendue (la parole partait vide) | le navigateur attend le **premier fragment** jusqu'à 4 s quand rien de neuf n'a été entendu ; et si la question est posée et que la parole est vide, le serveur fait **redemander** (« je n'ai pas entendu ») au lieu de relancer l'ancienne demande. |

« Oui mais… », « attends », une question, une négation : **pas un accord** (« attends » fait attendre la carte). « Non »,
« laisse tomber », « lala », « ماشي » : rien n'est envoyé. Après exécution : « c'est fait » + « dis-moi annule si tu changes
d'avis ». L'écran reste à jour (l'état vit sur l'intention, que la conversation relit ; le panneau vocal passe la carte
« exécutée ») mais n'est jamais requis.

## 5. Tout par la voix

| Dit | Effet |
|---|---|
| « annule », « annule ce que tu viens de faire » | la **dernière chose faite** (< 30 min, K10b — [0040](0040-reversibilite-communications.md)) : un **envoi encore dans sa fenêtre** → `annulerEffetSortant`, rien ne part ; sinon le dernier geste de l'assistant → `annulerGeste`, effet par effet. La voix le dit **honnêtement** (`phraseAnnulation`) : « annulé en partie », un courriel déjà parti → « un rectificatif part à sa place », ce qui ne se défait pas → dit, avec ce qu'on peut faire à la place. « Annule la tâche X » nomme une fiche : c'est une demande, pas cette commande. |
| « rétablis », « finalement refais-le » | la dernière annulation (< 30 min) s'annule (`retablirGeste`) ; ce qui a bougé depuis est dit, jamais écrasé |
| « mets la mission en pause », « bloque la mission du congrès » | `pauserTravail` (K3) — la mission désignée par son nom, seule sans avoir à la nommer, sinon « laquelle ? » |
| « reprends la mission » | `reprendreMonTravail` |
| « arrête la mission / la sous-mission » | `annulerMissionEtSousMissions` |
| « stop », « tais-toi », « baraka » | le navigateur **coupe le son** et envoie `session.instructions.append` (interruption) ; le résultat de la délégation part en contexte silencieux |
| « plus court », « en bref », « ikhtasar » | consigne de session : une phrase par réponse |
| une pièce arrive par WhatsApp ou mail (K6, [0036](0036-canaux-entrants.md)) | **annoncée d'elle-même** pendant l'appel : la veille du navigateur (5 s, `/voix/travail?annonces=1`) lit les réceptions `RECUE` de la personne depuis l'ouverture, une seule fois par session (`annonceJusquA`) ; la voix dit d'où elle vient, son nom, ce que l'assistant en a dit — et la carte de rangement devient la carte orale (« je l'ajoute à SP-… ? » → « vas-y ») |
| parler pendant que la voix parle | **barge-in côté navigateur** : au premier fragment de transcription d'entrée pendant la parole, l'élément audio est **coupé** (`muted`) — sans attendre le fournisseur — et rouvert à la réponse suivante |

## 6. Vérifié — et ce qui ne l'est pas

- **Tests** (0 réseau) : règles pures (accord / refus FR et darja, relecture de l'élément clé, commandes, chiffres,
  tableau / graphique / analyse / visuel en une phrase) ; garde-fous contre la vraie base (autre personne, session
  inconnue, rien de neuf entendu, « oui mais attends » → rien n'est exécuté ; « ok fais-le » → tâche créée ; carte
  renforcée relue puis « vas-y » → exécutée ; « annule » → tâche retirée ; « non, laisse tomber » → rien) ; scénarios K4
  rejoués sur le suivi asynchrone ; délégation
  asynchrone (précision ajoutée au message en attente, relance ciblée qui voit le résultat en cours, résultat dépassé
  remplacé, consigne orale reçue par le modèle, reprise à l'ouverture suivante une seule fois) ; flux d'événements rejoué
  (injection du résultat sous la dernière délégation, « oui » transcrit après 1,5 s, barge-in, « stop », « plus court », reprises).
- **Passage réel (01/11, crédit revenu)** : un tour vocal (« Explique-moi en bref ce qu'est une AMM pour un médicament en
  Algérie ») avec le vrai modèle de l'assistant, sur la vraie base locale : la délégation a rendu la main à la voix en
  **25 ms** (« je regarde, je te préviens »), le résultat est arrivé **75 s** plus tard (recherche web comprise) — c'est
  exactement le cas que l'ancienne attente de 70 s renvoyait « à l'écran » — et il était **rédigé pour l'oreille** : la
  réponse d'abord, trois phrases, puis « Tu veux que je t'explique la procédure ? ». ≈ 68 000 jetons d'entrée, 3 200 de
  sortie. Ce passage a trouvé un défaut, corrigé et testé : « en bref » dans une DEMANDE était pris pour la commande
  « plus court » (une commande est désormais un énoncé court qui n'est que la commande).
- **Limite** : le média WebRTC ne passe pas le conteneur — GPT-Live lui-même n'a pas été entendu ici. Les scénarios oraux
  sont scriptés (transcriptions simulées). À vérifier au premier passage réel en production : que GPT-Live **dit bien**
  de lui-même un `session.commentary.append` arrivé longtemps après la délégation (la documentation dit « paraphrase »,
  sans garantie de prise de parole), et la qualité de la transcription des accords en darja.
- **Non fait** : la précision injectée DANS une boucle d'outils en cours (voir §3).

## 7. Décisions à confirmer par la Direction

1. **Cartes critiques (R4 : paiement, signature) à l'oral** : appliqué tel que demandé — la relecture du montant ou du nom
   par la voix tient lieu de ressaisie (K4 exigeait que la personne le prononce). Proposé : garder ; à fermer d'un réglage (critique = écran) si la Direction le
   préfère.
2. **« Annule »** vise la dernière action de l'assistant de moins de 30 minutes, sans redemander. Proposé : garder.
3. **Une demande nouvelle pendant un travail en cours** est traitée comme une précision (la consigne laisse l'assistant
   la traiter si c'en est une autre) ; une seule réponse est dite, la plus récente. Proposé : garder.
