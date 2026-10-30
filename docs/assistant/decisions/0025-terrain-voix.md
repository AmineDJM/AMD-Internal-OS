# 0025 — Terrain et voix : vocal de délégué → compte rendu prêt, photos de terrain, hors ligne, voix temps réel (lot J13, 30/10/2026)

**Lot J13 du plan Jarvis** (architecture validée « Un noyau, des personas » : *Vocal → compte rendu en 30 s ; réponse
vocale en 1,5 s* ; piège nommé : *confirmer un paiement ou une signature à la voix seule*). Fait suite à
[0011](0011-vocaux-et-lecture-de-toute-piece.md) (vocaux et lecture de pièces), [0015](0015-glisser-deposer.md) et
[0018](0018-vitesse-memoire.md) (outils à la demande).

> Code — module `src/modules/assistant-ia/` : `domaine/terrain/{compte-rendu,resolution,file-hors-ligne,photo,voix,vue}.ts`
> (pur, testé), `infra/terrain/captation.ts`, `infra/operations/terrain.ts`, `infra/voix/temps-reel.ts`,
> `ecrans/terrain/{ecran-terrain.tsx,file-locale.ts}`, `ecrans/voix-temps-reel.tsx`, `actions.ts`
> (`confirmerCarteTerrain`). Socle `src/platform/ia/voix/{session-temps-reel,client-temps-reel}.ts` (zéro import),
> `src/platform/ia/modeles-roles.ts` (`modeleSttTerrain`, `modeleTempsReel`). Page `/medical/terrain`, routes
> `/api/assistant-ia/terrain`, `/api/assistant-ia/voix/{session,outil,journal}`. Action métier ajoutée :
> `field-report-actions:rattacherPhotoTerrain`. `public/sw.js` (écran Terrain hors ligne). Migration additive
> `20270210100000_terrain_voix` (`AssistantIaTerrainCapture`). Banc STT : `scripts/banc-stt-terrain.mjs`,
> `data/bancs/terrain-voix/`. E2E 390 px : `e2e/terrain-voix.spec.ts`.

## 1. Le compte rendu vocal

| Étape | Ce qui se passe | Mesure / garde |
|---|---|---|
| Capture | « Dicter un compte rendu » (grand bouton, 390 px) → `MediaRecorder` (Opus/WebM, MP4 sur iPhone). | La capture entre d'ABORD dans la file locale (§3). |
| Dépôt | `/api/assistant-ia/terrain` avec la **clé d'idempotence** tirée à la capture → Drive de la personne (dossier « Terrain — vocaux et photos ») → `AssistantIaTerrainCapture`. | Même clé renvoyée = même captation, aucun nouvel appel (test). |
| Transcription | `gpt-transcribe`, **langue non forcée**, **indice de vocabulaire** : produits de la gamme du délégué, médecins de SON annuaire, établissements (800 caractères). | Banc §1.1. L'écran dit la langue lue (français / arabe / mêlés). |
| Structuration | Le modèle de l'assistant (rôle standard), consigne `CONSIGNE_STRUCTURATION` : JSON (médecin, établissement, produits, intérêt, objections, demandes, « revoir demain », synthèse en français, points à confirmer). Noms propres en caractères latins. Le texte passe d'abord le **filtre de confidentialité**. | `lireCompteRendu` ne fait pas confiance : natures fermées, quantités entières, listes bornées ; hors forme → la transcription brute devient la synthèse, et la carte le dit. |
| Médecin | `resoudreMedecin` dans l'annuaire **vu par la personne** (`scopeMedicalDoctors`) : mots collés (« Benali » ↔ « BEN ALI »), noms composés, établissement qui départage. | Jamais choisi à la place du délégué : seul et nettement devant (écart 0,12) → résolu ; sinon candidats nommés ou « hors annuaire » — sur la carte. |
| Cartes | `terrain_compte_rendu` (brouillon pré-rempli : synthèse, médecin(s), établissement, spécialité, date), `terrain_demande_materiel` (article du magasin, quantité → `demanderMateriel`), `terrain_tournee_demain` (médecin ajouté à la tournée de demain → `planifierVisites`, sélection COMPLÈTE relue : rien n'est retiré). Ce qui ne fait pas carte devient une **note** dite (« combien de boîtes ? », documentation demandée). | **Rien n'est écrit sans clic** (test : 0 rapport, 0 demande avant confirmation). Exécution par l'ACTION DE L'ÉCRAN. |
| Temps | `msTotal` (dépôt → cartes) affiché « prêt en x s ». | Cible 30 s. Au banc (faux modèle) : < 1 s hors modèles. En réel : ~1 s de transcription (mesuré, §1.1) + UN appel de structuration (non mesuré ici : la clé du modèle de l'assistant n'est pas dans ce conteneur ; J4 mesure 1 s pour un geste court de ce modèle, un JSON de ~300 jetons en demande quelques-unes de plus). `msTotal` le mesure en production. |

Les quatre opérations sont aussi des **outils de l'assistant** (registre `OPERATIONS_IA`, fiches `MOTS_CLES` — jamais
`SOCLE_OUTILS`) : « prépare le compte rendu de ma visite chez le Dr X » marche au texte et à la voix.

**La confirmation du terrain** (`confirmerCarteTerrain`) a la porte du TERRAIN (module Rapports terrain), pas celle de
l'Assistant IA : un délégué dicte sans avoir la conversation. Elle n'exécute QUE des opérations `terrain_*` que CE compte
a préparées, sous la garde commune des cartes (réclamation atomique, idempotence, arrêt d'urgence).

### 1.1 Le moteur de transcription — mesuré

Banc `scripts/banc-stt-terrain.mjs` (30/10/2026), quatre vocaux synthétisés avec consigne d'accent algérien
(`gpt-4o-mini-tts`) : français simple, **darija mêlée de français**, arabe, français rapide. Score : WER (forme pliée) et
**entités entendues** (médecin, produit, établissement — un compte rendu se juge sur ses noms propres).

| Moteur | WER moyen | Entités /12 | Médiane |
|---|---|---|---|
| whisper-1 | 0,313 | 9 | 2,0 s |
| whisper-1 + indice | 0,266 | 10 | 2,4 s |
| gpt-4o-mini-transcribe | 0,290 | 8 | 1,1 s |
| gpt-4o-mini-transcribe + indice | 0,248 | 9 | 2,6 s |
| gpt-4o-transcribe | 0,276 | 8 | 1,2 s |
| gpt-4o-transcribe + indice | 0,250 | 11 | 1,4 s |
| gpt-transcribe | 0,249 | 10 | 0,9 s |
| **gpt-transcribe + indice** | **0,229** | **11** | **1,0 s** |

Retenu : **`gpt-transcribe` + indice**, langue détectée (`TERRAIN_STT_MODEL` le change sans code). Observé : sur la darija,
le moteur écrit les mots français EN LETTRES ARABES (« أنتريسي », « ديزيشانطيو ») — d'où la consigne de structuration
qui rend les noms en caractères latins, et la résolution du médecin APRÈS la structuration. **Limite** : ce sont des voix
synthétisées ; le banc se rejoue sur de vrais vocaux de délégués en les déposant dans `data/bancs/terrain-voix/` avec leur
vérité (à faire au premier mois d'usage). Les transcriptions réelles de ce banc sont rejouées par les tests
(`infra/terrain/captation.test.ts`).

## 2. Les photos de terrain

« Photo » (appareil arrière), avec ce qu'elle montre : présentoir, ordonnance (anonymisée), facture, carte de visite.
Vision (même porte `genererTexte`, rôle vision, même budget) sous `CONSIGNE_PHOTO` → **faits proposés** (affichés « à
vérifier », jamais écrits). Une **ordonnance ne livre jamais le patient** : la consigne l'interdit et `nettoyerFaits` retire
en plus toute ligne qui en a la forme (test). Le filtre de confidentialité passe sur ce que la vision a lu (un RIB sur une
facture). Un nom de fichier qui annonce une pièce du coffre est refusé (règle de 0011). La photo se rattache au compte
rendu le plus récent (deux jours) par la carte `terrain_piece_visite` → action `rattacherPhotoTerrain` (porte du rapport,
brouillon seulement, seconde référence sur le fichier : supprimer la pièce ne supprime pas la photo du Drive).

## 3. Hors ligne (PWA) — aucune perte

- **File locale** IndexedDB (`ecrans/terrain/file-locale.ts`), état + contenu écrits ensemble. Règle pure
  `file-hors-ligne.ts` : un élément ne sort de la file que sur l'**accusé** du serveur ; un envoi coupé (onglet fermé)
  repart au redémarrage avec la MÊME clé ; une erreur réseau / 5xx = réessai (5 s → 5 min) ; un refus 4xx = gardé
  « refusé », avec la phrase, à relancer ou jeter par la personne ; un envoi à la fois.
- **Envoi automatique** au retour du réseau (`online`), à l'ouverture, toutes les 15 s.
- **État visible** en haut de l'écran : « 2 en attente d'envoi — partira au retour du réseau », « Tout est envoyé. »
- **Écran ouvrable sans réseau** : `public/sw.js` sert `/medical/terrain` (réseau d'abord, copie de secours) et les
  fichiers statiques qu'il charge — et rien d'autre.
- Tests : 50 éléments sur un réseau intermittent qui perd des réponses → 50 accusés, 0 perdu (`terrain.test.ts`) ; côté
  serveur la clé absorbe le doublon (`captation.test.ts`) ; E2E 390 px : hors ligne → 2 en file, rien envoyé ; réseau
  revenu → file vide, IndexedDB vide, captations affichées.

## 4. La voix temps réel de l'Assistant IA

Bouton « Conversation vocale » à côté du micro de `/assistant`. Le socle `platform/ia/voix/` porte la session (secret
éphémère : la clé ne quitte pas le serveur) et un client WebRTC mince ; **Adam n'est pas touché** (son transport reste le
sien).

| Exigence | Comment |
|---|---|
| MÊMES outils, droits, repères | Session = socle des outils de la personne (`outilsV1` sous ses droits, configuration du rôle) + `trouver_outil` + `utiliser_outil` (qui rend le schéma : en voix, l'outil trouvé s'appelle par lui). Chaque appel revient au serveur (`executerOutilVocal`) : outils reconstruits, console d'accès RELUE, `allowed` revérifié. Consigne compilée par le même `compileContext` (familles, gestes fermés). |
| Valeurs sensibles jamais lues à voix haute | La voix ne reçoit que des repères, et `pourLaVoix` remplace même le repère par « valeur confidentielle affichée à l'écran ». L'écran les révèle (`Revelateur`) à qui a le droit — journal compris —, « [confidentiel] » sinon. |
| R3/R4 confirmée à l'écran, jamais à la voix | Aucun outil de confirmation n'est offert ; tout nom qui confirme / exécute / signe / paie est refusé par la route (même via `utiliser_outil`, test) ; une écriture rend une CARTE affichée dans le panneau, exécutée par son bouton (ressaisie pour une carte critique). La consigne interdit de tenir un « oui » oral pour une confirmation. |
| Consommation | Plafond du jour vérifié à l'ouverture ; à la fin, les jetons rendus par le fournisseur sont inscrits au nom de la personne (`openai-realtime`, `ModelCallLog`/`AiUsageLog`). |
| Latence p50 ≤ 1,5 s | Mesurée par le client à chaque tour : fin de parole (`speech_stopped`) → premier son (`output_audio_buffer.started`), hors tours d'outil ; la médiane s'affiche dans le panneau et part au journal (`[assistant-ia] voix temps réel {p50}`). VAD sémantique, empressement « auto ». |

**Limite dite** : la latence vocale RÉELLE n'a pas pu être mesurée depuis le conteneur de développement — l'API Realtime
y est joignable en HTTPS (secret éphémère créé, échange SDP accepté) mais le média WebRTC (UDP) ne passe pas, et le
proxy ne relaie pas l'upgrade WebSocket. Le calcul est tenu au banc sur un flux rejoué ; **la première mesure réelle se
lit dans les journaux de production** (ligne `voix temps réel`, p50) — à relever à la première semaine, et à comparer à la
cible avant d'ouvrir la voix à tous.

## 5. Décisions à confirmer par la Direction

1. **Voix des délégués sans l'Assistant IA** : le terrain (dicter, photographier, confirmer ses cartes) s'ouvre avec le
   module Rapports terrain ; la conversation vocale, elle, exige l'Assistant IA. Proposé : garder cette séparation.
2. **Tournée de demain** : un plan déjà VALIDÉ ne se modifie pas en direct — la carte le dit et renvoie à la révision.
3. **Ordonnances** : même anonymisées, elles partent à la vision du fournisseur. Proposé : autorisé (aucune donnée
   patient recopiée, filtre en sortie) ; à fermer d'un réglage si la Direction préfère.
4. **Rétention** des vocaux et photos du dossier « Terrain » du Drive : celle du Drive (quotas). À fixer avec la décision
   générale sur les durées de conservation.

## 6. Variables d'environnement (toutes facultatives)

`TERRAIN_STT_MODEL` (défaut `gpt-transcribe`), `ASSISTANT_IA_REALTIME_MODEL` (défaut `gpt-realtime-2.1`),
`ASSISTANT_IA_REALTIME_VOICE` (défaut `marin`).
