# 0011 — Vocaux « comme WhatsApp » et lecture de toute pièce jointe (28/10/2026)

**Demande (Direction, 28/10/2026)** : « pouvoir faire des vocaux avec l'assistant IA comme WhatsApp, et qu'il lise en entrée
tout type de document, même images et vidéos ».

> Code : `src/lib/agent/lecture/` (`regles.ts` pur, `pieces.ts` — lecture, vision, transcription —, `voix.ts` — vocaux, synthèse,
> stockage), `generer.ts` (la vision passe par cette porte), `consommation.ts` (`appelVoix`), `src/lib/agent/fil/service.ts` · `tour.ts`,
> `src/app/api/assistant-ia/vocal/route.ts`, `src/components/assistant-beta/enregistreur-vocal.tsx` · `bulle-vocale.tsx` ·
> `pieces-jointes.tsx`. Migration `20270206100000_assistant_ia_vocal_lecture` (colonnes `vocal`, `lecture`, `audio` du tour ;
> `reponseVocale` du fil). Bancs : `lecture/lecture.test.ts`, `lecture/voix.test.ts`, `filtre-confidentialite.test.ts`.

## 1. Les messages vocaux

| Geste | Ce qui se passe |
|---|---|
| **Maintenir** le micro | enregistrement (Opus/WebM, ou MP4 sur iPhone), minuterie, onde du niveau en direct ; **relâcher** envoie. |
| **Glisser à gauche** | annule : rien n'est envoyé ni stocké. **Glisser vers le haut** verrouille (mains libres). |
| **Appui bref** | démarre verrouillé ; « Envoyer » ou la corbeille l'arrêtent. 5 minutes au plus (arrêt et envoi d'office). |
| Envoi | `/api/assistant-ia/vocal` : le fichier va dans le **Drive personnel** (dossier « Assistant IA — vocaux », sans partage, quotas du Drive) ; le vocal est **déposé comme un message du fil** (colonne `vocal` : identifiant, durée, état), avec les pièces prêtes. |
| Lecture | le fil **transcrit** le vocal quand il le joue (moteur du Drive `media/stt.ts`, langue détectée) ; la transcription est **gardée** (un essai suivant ne repaie pas) et **affichée sous le lecteur** ; le modèle reçoit la transcription, marquée « message vocal » (un nom propre peut y être écorché). Intranscriptible → la réponse le **dit**, rien ne part au modèle. |
| Lecteur | dans la bulle : lecture/pause, onde, durée. L'audio est chargé **au premier appui** depuis `/api/drive/<id>/raw` (droits revérifiés) puis joué depuis la mémoire de l'onglet : la route du Drive ne sert pas les plages d'octets, que Safari exige. |

**Réponse vocale** (option de la personne, gardée sur le fil — elle suit d'un appareil à l'autre) : la réponse **texte reste
affichée** ; elle est mise en parole (`texteParlable` : sans Markdown ni adresses, **1 500 caractères au plus, la coupe dite** sous
le lecteur), synthétisée par OpenAI (`gpt-4o-mini-tts`, voix `alloy` — mesuré le 28/10 : MP3 24 kHz, ~3 s), déposée dans le même
dossier du Drive. Jamais de base64 dans la conversation : le fil ne garde que l'identifiant.

La **conversation temps réel** (`voice-mode.tsx`, `realtime-voice.ts`, écran d'Adam) n'est pas touchée.

## 2. Lire tout document joint

`piecesDuMessage` nommait les pièces sans les lire. Désormais `lirePieces` (`lecture/pieces.ts`) les **lit** avant le tour :

| Genre | Lecture |
|---|---|
| Word, Excel, CSV, texte, JSON… | texte du fichier, sur ce serveur (`extractText`). |
| PowerPoint | texte des diapositives et des notes (`parsePptx`). |
| PDF à texte | texte natif. |
| **PDF scanné** | OCR **local** d'abord (contrôle), puis **vision** du modèle sur **6 pages au plus** (rastérisées par mupdf) ; repli sur l'OCR local si la vision échoue — et c'est dit. |
| **Image** (png, jpeg, webp, gif) | OCR **local** d'abord (contrôle), puis **vision** (`gpt-6.1-terra`, même modèle et même chemin Mastra que la conversation — mesuré : texte d'une facture recopié fidèlement). |
| Audio | transcription. |
| **Vidéo** | piste audio transcrite + **4 images clés** réparties sur la durée, regardées par la vision — si le serveur a `ffmpeg` ; sinon la limite est **dite** (« seule la piste audio est lue »). |

**Les portes, dans l'ordre — rien ne part tant qu'une porte de notre côté peut refuser** : droits (`resoudrePiece`) → **coffre**
(nature locale classée par l'enrichissement — `NATURES_LOCALES` —, pièce `CONFIDENTIAL`, ou nom qui annonce un passeport / une CNI /
un permis / un bulletin de paie / un RIB) → taille (40 Mo) → lecture et **classement locaux** (`natureSensible`, `classerPiece`) :
une pièce d'identité ou une fiche de paie reconnue ici est refusée **avant** qu'une image ne parte à la vision ; une image que le
contrôle local n'a pas pu lire **n'est pas envoyée** → vision / transcription (comptées) → **filtre de confidentialité** (IBAN, RIB,
NIN, salaires) → **borne** (24 000 caractères par pièce, 60 000 par message, 12 images par message, 6 pièces lues par message).
Second verrou : la consigne de la vision lui fait répondre `NATURE_SENSIBLE` sans rien recopier devant une pièce du coffre.

Le contenu part **encadré comme contenu non fiable** (`encadrerNonFiable`) avec la consigne de **redire chaque limite**. Chaque
pièce garde sa lecture (`lecture` du tour : lue, partielle, refusée, illisible, nommée seulement) et l'écran **la dit sous la pièce**
— jamais une coupe silencieuse. Dans l'historique, une pièce n'est reprise que par son nom et l'état de sa lecture ; `lire_document`
la relit au besoin (résumé complet par parties).

**Correctif du filtre** (trouvé par le banc) : un IBAN imprimé par groupes de quatre (« DZ58 0021 0001… ») passait en clair, et
l'en-tête « iban » d'un tableau avalait le nom de la ligne suivante. `filtre-confidentialite.ts` reconnaît la forme groupée et ne
franchit plus une fin de ligne.

## 3. Consommation et interrupteur

La vision passe par la porte existante `genererTexte` (rôle `vision`) ; transcription et synthèse, qui ne sont pas des agents
Mastra, par `appelVoix` (`consommation.ts`) — mêmes gardes : **interrupteur général** (coupé → rien ne
part), **plafond du jour** de la personne (atteint → rien ne part, Super Admin prévenu), puis **journal** (`ModelCallLog` +
`AiUsageLog`, feature `assistant_ia`, rôle `transcription` · `vision` · `synthese`). La vision compte les jetons réels du modèle
(tarif `ASSISTANT_IA_PRICE_*`). La voix compte des **équivalents** quand le moteur ne rend pas de jetons (`whisper-1` facture des
secondes) : 10 jetons par seconde d'audio, 1 par 4 caractères de texte — fournisseur `openai-audio`, tarif
`ASSISTANT_IA_AUDIO_PRICE_IN` / `_OUT` (absent → coût « inconnu »).

## Variables d'environnement (toutes facultatives)

`ASSISTANT_IA_TTS_MODEL` (défaut `gpt-4o-mini-tts`), `ASSISTANT_IA_TTS_VOICE` (défaut `alloy`), `ASSISTANT_IA_AUDIO_PRICE_IN` /
`_OUT`. La transcription garde `STT_MODEL` (défaut `whisper-1`).

## Décisions à confirmer par la Direction

1. **Nom de fichier = refus** : un fichier nommé « passeport… », « RIB… », « bulletin de paie… » est refusé sans être ouvert,
   même si c'est autre chose (option prudente ; renommer suffit à le faire lire).
2. **Image que l'OCR local ne lit pas = non envoyée** à la vision (option prudente). Si Tesseract manque en production, aucune
   image ne sera lue : à vérifier au premier déploiement.
3. **Images clés de vidéo** : `ffmpeg` n'est pas garanti sur Render — sans lui, seule la piste audio est lue (dit à l'écran).
   L'ajouter à l'image de déploiement ouvrirait la vidéo complète.
4. **Pièces `CONFIDENTIAL`** refusées en lecture directe (règle de l'enrichissement) — alors que l'outil `lire_document` les
   lit encore avec masque. À aligner dans un sens ou dans l'autre.
